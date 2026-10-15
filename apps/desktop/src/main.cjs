// Warren desktop: the workspace in its own window, plus what only an app on this computer can do:
// run a hub here, connect this computer as a device for agents (one click, no token to copy), and
// keep both going from the menu bar after the window closes.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const engine = require("./engine.cjs");

const PORT = Number(process.env.PORT || 4747);
const LOCAL_HUB = `http://localhost:${PORT}`;
const CONFIG = path.join(app.getPath("userData"), "desktop.json");
const ICON = path.join(__dirname, "..", "build", "icon.png");

/** @type {{ mode?: "local" | "remote", hubUrl?: string, warrenDir?: string, device?: boolean, bounds?: Electron.Rectangle, buddyEnabled?: boolean, buddyAgents?: Record<string, string | null>, buddyPosition?: { x: number, y: number } }} */
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch {}
const save = () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
};

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let hubOrigin = null; // the hub the window shows, once it's reachable
let hubBy = ""; // "app" | "service" | "already running" | "remote"
let deviceBy = ""; // "app" | "service"
let deviceError = "";
const buddy = require("./buddy.cjs")({
  config, save, mainWindow: () => win, refresh,
  open: (route) => {
    if (!hubOrigin) return;
    showWindow();
    if (win.webContents.getURL().startsWith(hubOrigin + "/")) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`);
    else win.loadURL(`${hubOrigin}/${route}`);
  },
});

const logDir = app.getPath("logs");
const hub = new engine.Child("hub", logDir, () => refresh());
const device = new engine.Child("device", logDir, () => refresh());

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

app.setAboutPanelOptions?.({ applicationName: "Warren", copyright: "Apache-2.0", website: "https://github.com/eireijie/warren" });

// ---------------------------------------------------------------- window

function createWindow() {
  const b = config.bounds;
  win = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 820,
    x: b?.x,
    y: b?.y,
    minWidth: 880, // narrower and the web app switches to its phone layout (767px)
    minHeight: 520,
    title: "Warren",
    icon: ICON,
    show: false,
    backgroundColor: "#f7f7f7",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.once("ready-to-show", () => win?.show());
  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    config.bounds = win.getNormalBounds();
    save();
  };
  win.on("resize", remember);
  win.on("move", remember);
  // closing the window keeps Warren (and its hub and device) running from the menu bar
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (process.platform === "darwin") app.dock?.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (hubOrigin && url.startsWith(hubOrigin)) return { action: "allow" };
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || (hubOrigin && url.startsWith(hubOrigin))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3 || !hubOrigin || !url.startsWith(hubOrigin)) return; // -3: aborted by a navigation
    showSetup({ step: "unreachable", hubUrl: hubOrigin, error: desc });
  });
}

function showWindow() {
  if (!win) createWindow();
  if (process.platform === "darwin") app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showSetup(state = {}) {
  if (!win) createWindow();
  win.loadFile(path.join(__dirname, "setup.html"), { query: { state: JSON.stringify(state) } });
  showWindow();
}

function openHub(url, route = "") {
  hubOrigin = new URL(url).origin;
  buddy.connect(hubOrigin);
  if (!win) createWindow();
  win.loadURL(hubOrigin + "/" + route);
  refresh();
}

// ---------------------------------------------------------------- hub

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await engine.hubUp(url)) return true;
    if (hub.state === "error") return false;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/** Find or start the hub for the saved choice, then show it. */
async function connect() {
  if (config.mode === "remote" && config.hubUrl) {
    hubBy = "remote";
    if (!(await engine.hubUp(config.hubUrl))) return showSetup({ step: "unreachable", hubUrl: config.hubUrl });
    openHub(config.hubUrl);
    return startDeviceIfWanted();
  }
  if (config.mode !== "local") return showSetup();

  if (await engine.hubUp(LOCAL_HUB)) hubBy = (await engine.serviceRunning("hub")) ? "service" : hub.running() ? "app" : "already running";
  else {
    const found = needs();
    if (found.problem) return showSetup({ step: "choose", problem: found.problem });
    showSetup({ step: "starting" });
    hub.start(found.node.bin, found.warrenDir, ["hub", "start"], { PORT: String(PORT) });
    hubBy = "app";
    if (!(await waitFor(LOCAL_HUB, 90_000))) {
      hub.stop();
      return showSetup({ step: "choose", problem: "The hub didn't start.", log: hub.tail() });
    }
  }
  openHub(LOCAL_HUB);
  startDeviceIfWanted();
}

/** What running Warren here needs: Node 22+ and a Warren folder. */
function needs() {
  const node = engine.findNode();
  const warrenDir = engine.findWarren(config.warrenDir);
  if (!node) return { problem: "Warren needs Node.js 22 or newer. Install it from nodejs.org, then try again." };
  if (!warrenDir) return { problem: "Warren isn't installed on this computer yet. Run the installer below, or choose the folder you cloned it into." };
  if (config.warrenDir !== warrenDir) {
    config.warrenDir = warrenDir; // so a copy of the app elsewhere (or a moved one) finds it again
    save();
  }
  return { node, warrenDir };
}

// ---------------------------------------------------------------- this computer as a device

/** The session token the web app keeps, so the app can add this device for the person signed in. */
async function sessionToken() {
  if (!win || !hubOrigin || !win.webContents.getURL().startsWith(hubOrigin)) return null;
  try {
    return await win.webContents.executeJavaScript('localStorage.getItem("warren.token")', true);
  } catch {
    return null;
  }
}

async function startDeviceIfWanted() {
  if (config.device) await startDevice({ quiet: true });
}

async function startDevice({ quiet = false } = {}) {
  deviceError = "";
  if (!hubOrigin) return;
  if (await engine.serviceRunning("node")) {
    deviceBy = "service";
    config.device = true;
    save();
    return refresh();
  }
  const found = needs();
  if (found.problem) return fail(found.problem);

  let cfg = engine.readNodeConfig();
  const sameHub = cfg.hub && cfg.token && sameOrigin(cfg.hub, hubOrigin);
  if (cfg.hub && cfg.token && !sameHub) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Connect to this Warren", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "This computer is a device of another Warren",
      detail: `It's set up for ${cfg.hub}. Connecting it to ${hubOrigin} instead disconnects it from there.`,
    });
    if (response !== 0) return;
  }
  if (!sameHub) {
    const token = await sessionToken();
    if (!token) return fail("Sign in to Warren first, then connect this computer.");
    try {
      const res = await fetch(new URL("/api/nodes", hubOrigin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: deviceName() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return fail(body.error || `The hub said ${res.status}`);
      cfg = engine.writeNodeConfig({ hub: hubOrigin, token: body.token, name: deviceName() });
    } catch (err) {
      return fail(`Couldn't reach the hub: ${err.message}`);
    }
  }
  config.device = true;
  save();
  deviceBy = "app";
  device.start(found.node.bin, found.warrenDir, ["node", "start"]);
  if (!quiet) notify("This computer is connected", "Agents can now run here. Choose what it does for them in Warren → Devices.");

  function fail(msg) {
    deviceError = msg;
    refresh();
    if (!quiet) dialog.showMessageBox(win, { type: "warning", message: "Couldn't connect this computer", detail: msg });
  }
}

function stopDevice() {
  config.device = false;
  save();
  device.stop();
  deviceBy = "";
  refresh();
}

/** "Yug's MacBook Air" on a Mac; elsewhere the host name without its network domain. */
function deviceName() {
  if (process.platform === "darwin") {
    try {
      const name = require("node:child_process").execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 3000 }).trim();
      if (name) return name;
    } catch {}
  }
  return (os.hostname() || "This computer").split(".")[0];
}
const sameOrigin = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const host = (h) => (h === "127.0.0.1" ? "localhost" : h);
    return x.protocol === y.protocol && host(x.hostname) === host(y.hostname) && x.port === y.port;
  } catch {
    return false;
  }
};

/** Screen sharing and pausing live in node.json, which a running device picks up on its own. */
function setDeviceFlag(key, on) {
  engine.writeNodeConfig(key === "shareScreen" ? { shareScreen: on, noScreen: on ? undefined : engine.readNodeConfig().noScreen } : { [key]: on });
  refresh();
}

// ---------------------------------------------------------------- menus

function hubLine() {
  if (!config.mode) return "Not set up yet";
  if (config.mode === "remote") return `Connected to ${hostOf(config.hubUrl)}`;
  if (hub.state === "error") return "Hub stopped unexpectedly";
  if (hub.state === "starting") return "Hub starting…";
  if (hubBy === "service") return "Hub running here (as a service)";
  return hubOrigin ? "Hub running on this computer" : "Hub not running";
}

function deviceLine() {
  if (deviceBy === "service") return "This computer: connected (as a service)";
  if (device.state === "starting" && device.running()) return "This computer: connected";
  if (device.state === "error") return "This computer: stopped unexpectedly";
  if (deviceError) return `This computer: ${deviceError}`;
  return "This computer: not a device";
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u || "";
  }
};

function trayMenu() {
  const n = engine.readNodeConfig();
  const isDevice = deviceBy === "service" || device.running();
  return Menu.buildFromTemplate([
    { label: hubLine(), enabled: false },
    { label: deviceLine(), enabled: false },
    { type: "separator" },
    { label: "Open Warren", click: () => showWindow() },
    buddy.menu(),
    { type: "separator" },
    isDevice
      ? { label: "Disconnect This Computer", enabled: deviceBy !== "service", click: () => stopDevice() }
      : { label: "Connect This Computer for Agents…", enabled: !!hubOrigin, click: () => startDevice() },
    { label: "Let Me Use This Screen from Warren", type: "checkbox", visible: isDevice, checked: !!n.shareScreen && !n.noScreen, click: (i) => setDeviceFlag("shareScreen", i.checked) },
    { label: "Pause Agents on This Computer", type: "checkbox", visible: isDevice, checked: !!n.paused, click: (i) => setDeviceFlag("paused", i.checked) },
    { type: "separator" },
    { label: "Switch Warren…", click: () => showSetup({ step: "choose" }) },
    { label: "Show Logs", click: () => shell.openPath(logDir) },
    { type: "separator" },
    { label: "Quit Warren", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ]);
}

function appMenu() {
  const go = (route) => () => {
    if (!hubOrigin) return;
    showWindow();
    if (win.webContents.getURL().startsWith(hubOrigin)) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${route}`)}`);
    else win.loadURL(`${hubOrigin}/#/${route}`);
  };
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac
      ? [{ label: "Warren", submenu: [{ role: "about" }, { type: "separator" }, { label: "Settings…", accelerator: "Cmd+,", click: go("settings") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : []),
    { label: "File", submenu: [{ label: "Switch Warren…", click: () => showSetup({ step: "choose" }) }, { type: "separator" }, mac ? { role: "close" } : { role: "quit" }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    {
      label: "Go",
      submenu: [
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: go("dashboard") },
        { label: "Computers", accelerator: "CmdOrCtrl+2", click: go("computers") },
        { label: "Memory", accelerator: "CmdOrCtrl+3", click: go("vault") },
        { label: "Devices", accelerator: "CmdOrCtrl+4", click: go("nodes") },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => win?.webContents.navigationHistory.goForward() },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Warren on GitHub", click: () => shell.openExternal("https://github.com/eireijie/warren") }, { label: "Show Logs", click: () => shell.openPath(logDir) }] },
  ]);
}

function refresh() {
  if (!app.isReady()) return;
  tray?.setContextMenu(trayMenu());
  tray?.setToolTip(`Warren: ${hubLine()}`);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

function makeTray() {
  const file = path.join(__dirname, "..", "build", process.platform === "darwin" ? "trayTemplate.png" : "icon.png");
  let img = nativeImage.createFromPath(file);
  if (process.platform !== "darwin") img = img.resize({ width: 18, height: 18 });
  else img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on("click", () => (process.platform === "darwin" ? tray.popUpContextMenu() : showWindow()));
  refresh();
}

// ---------------------------------------------------------------- setup page and the web app

/** Setup calls only from the app's own setup page, never from a hub's pages. */
const fromSetup = (e) => (e.senderFrame?.url ?? "").startsWith("file:");
const setup = (name, fn) => ipcMain.handle(name, (e, ...args) => (fromSetup(e) ? fn(...args) : null));

setup("setup:check", () => {
  const node = engine.findNode();
  const warrenDir = engine.findWarren(config.warrenDir);
  return { node: node?.version ?? null, warrenDir, platform: process.platform, hubUrl: config.hubUrl ?? "", mode: config.mode ?? null };
});

setup("setup:choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Where is Warren?", properties: ["openDirectory"], message: "Choose the folder you cloned Warren into" });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  if (!engine.isWarren(r.filePaths[0])) return { ok: false, error: "That folder doesn't look like Warren (no bin/warren.mjs)." };
  config.warrenDir = r.filePaths[0];
  save();
  return { ok: true, warrenDir: config.warrenDir };
});

setup("setup:local", async () => {
  config.mode = "local";
  save();
  connect();
});

setup("setup:remote", async (url) => {
  let u;
  try {
    u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
  } catch {
    return { ok: false, error: "That isn't a web address." };
  }
  if (!(await engine.hubUp(u.origin))) return { ok: false, error: `No Warren answered at ${u.origin}.` };
  config.mode = "remote";
  config.hubUrl = u.origin;
  save();
  connect();
  return { ok: true };
});

setup("setup:retry", () => connect());
setup("setup:install", () => shell.openExternal("https://github.com/eireijie/warren#install"));

ipcMain.on("badge", (_e, n) => {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  app.setBadgeCount?.(count);
  if (process.platform === "darwin") app.dock?.setBadge(count ? String(count) : "");
});
ipcMain.handle("desktop:info", () => ({ version: app.getVersion(), platform: process.platform, device: deviceBy === "service" || device.running() }));
ipcMain.handle("desktop:connect-device", () => startDevice());

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON));
  Menu.setApplicationMenu(appMenu());
  makeTray();
  buddy.ready();
  createWindow();
  connect();
});

app.on("activate", () => showWindow());
app.on("window-all-closed", () => {}); // stays in the menu bar
app.on("before-quit", () => {
  quitting = true;
  buddy.destroy();
  hub.stop();
  device.stop();
});
