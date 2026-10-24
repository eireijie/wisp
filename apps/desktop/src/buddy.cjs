// Native shell for the web app's real Ghost. The renderer uses the existing hub stream.
const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

module.exports = function deskBuddy({ config, save, mainWindow, open, refresh }) {
  let win = null;
  let origin = null;
  let agents = [];
  let leadId = null;
  let expanded = false;
  let drag = null;
  let retry = null;
  let pointerTimer = null;
  const choice = () => config.buddyAgents?.[origin] ?? null;
  const agentId = () => agents.find((a) => a.id === choice())?.id ?? agents.find((a) => a.id === leadId)?.id ?? agents[0]?.id ?? null;
  const overFullscreen = () => process.platform === "darwin" && config.buddyOverFullscreen === true;
  const settings = () => ({ agentId: agentId() });
  const trusted = (e, window) => {
    if (!window || e.sender !== window.webContents || e.senderFrame !== e.sender.mainFrame) return false;
    try { return new URL(e.senderFrame.url).origin === origin; } catch { return false; }
  };
  const clamp = (bounds) => {
    const area = screen.getDisplayMatching(bounds).workArea;
    return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) };
  };
  const remember = () => {
    if (!win) return;
    const b = win.getBounds();
    // Store the resting 140 × 160 footprint, independent of a visible bubble.
    config.buddyPosition = { x: b.x + b.width - 140, y: b.y + b.height - 160 };
    save();
  };
  const destroy = () => {
    clearTimeout(retry);
    clearInterval(pointerTimer);
    pointerTimer = null;
    retry = null;
    drag = null;
    if (win) { win.destroy(); win = null; }
    expanded = false;
  };
  const sync = () => {
    if (config.buddyEnabled === false || !origin || !agents.length) return destroy();
    if (win) { win.webContents.send("buddy:settings", settings()); return; }
    const area = screen.getPrimaryDisplay().workArea;
    const p = config.buddyPosition;
    const bounds = clamp({ x: Number.isFinite(p?.x) ? p.x : area.x + area.width - 160, y: Number.isFinite(p?.y) ? p.y : area.y + area.height - 180, width: 140, height: 160 });
    win = new BrowserWindow({
      ...(overFullscreen() ? { type: "panel" } : {}),
      ...bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      hasShadow: false, show: false, backgroundColor: "#00000000", title: "Warren desk buddy",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, overFullscreen() ? "screen-saver" : "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: overFullscreen(), skipTransformProcessType: !overFullscreen() });
    win.setIgnoreMouseEvents(true, { forward: true });
    // Linux has no forwarded mousemove while ignoring clicks. Sample only the cursor,
    // sending hit tests when it moves within this tiny window; no renderer idle loop.
    if (process.platform === "linux") {
      let last = "";
      pointerTimer = setInterval(() => {
        if (!win || drag) return;
        const p = screen.getCursorScreenPoint();
        const b = win.getBounds();
        const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
        const key = inside ? `${p.x - b.x}:${p.y - b.y}` : "outside";
        if (key === last) return;
        last = key;
        win.webContents.send("buddy:pointer", inside ? { x: p.x - b.x, y: p.y - b.y } : null);
      }, 125);
    }
    win.setMenu(null);
    win.once("ready-to-show", () => win?.showInactive());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("did-fail-load", (_e, code, _description, _url, mainFrame) => {
      if (code === -3 || !mainFrame) return;
      clearTimeout(retry);
      retry = setTimeout(() => win?.loadURL(`${origin}/#/buddy`).catch(() => {}), 10_000);
    });
    win.loadURL(`${origin}/#/buddy`).catch(() => {});
  };
  ipcMain.on("buddy:agents", (e, list, lead) => {
    if (!trusted(e, mainWindow()) || !Array.isArray(list)) return;
    agents = list.filter((a) => a && typeof a.id === "string" && typeof a.name === "string").slice(0, 500).map(({ id, name }) => ({ id, name: name.slice(0, 120) }));
    leadId = typeof lead === "string" ? lead : null;
    sync();
    refresh();
  });
  ipcMain.handle("buddy:settings", (e) => trusted(e, win) ? settings() : { agentId: null });
  ipcMain.on("buddy:ignore", (e, ignore) => {
    if (trusted(e, win) && typeof ignore === "boolean" && !drag) win.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.on("buddy:expand", (e, value) => {
    if (!trusted(e, win) || typeof value !== "boolean" || value === expanded) return;
    const b = win.getBounds();
    const width = value ? 280 : 140;
    const height = value ? 260 : 160;
    expanded = value;
    win.setBounds(clamp({ x: b.x + b.width - width, y: b.y + b.height - height, width, height }));
  });
  ipcMain.on("buddy:drag", (e, phase) => {
    if (!trusted(e, win)) return;
    if (phase === "start") {
      drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
      win.setIgnoreMouseEvents(false);
    } else if (phase === "move" && drag) {
      const p = screen.getCursorScreenPoint();
      win.setBounds(clamp({ ...drag.bounds, x: drag.bounds.x + p.x - drag.cursor.x, y: drag.bounds.y + p.y - drag.cursor.y }));
    } else if (phase === "end" && drag) { drag = null; remember(); }
  });
  ipcMain.on("buddy:open", (e, route) => {
    if (!trusted(e, win) || typeof route !== "string" || !/^#\/(?:c\/[^?#\s]+|agents(?:\/[^?#\s]+)?|tasks)$/.test(route)) return;
    open(route);
  });
  const reposition = () => { if (win) { win.setBounds(clamp(win.getBounds())); remember(); } };
  // Displays may disappear while a laptop sleeps or is undocked.
  const ready = () => {
    screen.on("display-removed", reposition);
    screen.on("display-metrics-changed", reposition);
  };
  const choose = (id, enabled = true) => {
    config.buddyEnabled = enabled;
    config.buddyAgents = { ...config.buddyAgents, [origin]: id };
    save(); sync(); refresh();
  };
  return {
    ready,
    connect(url) { if (origin !== url) { destroy(); agents = []; leadId = null; origin = url; } },
    destroy,
    menu: () => ({ label: "Desk buddy", submenu: [
      { label: "Off", type: "radio", checked: config.buddyEnabled === false, click: () => choose(choice(), false) },
      { label: "Lead / first agent", type: "radio", checked: config.buddyEnabled !== false && !choice(), click: () => choose(null) },
      ...agents.map((a) => ({ label: a.name, type: "radio", checked: config.buddyEnabled !== false && choice() === a.id, click: () => choose(a.id) })),
      ...(process.platform === "darwin" ? [
        { type: "separator" },
        { label: "Show over fullscreen apps", type: "checkbox", checked: overFullscreen(), click: (i) => {
          config.buddyOverFullscreen = i.checked;
          remember(); destroy(); save(); sync(); refresh();
        } },
      ] : []),
    ] }),
  };
};
