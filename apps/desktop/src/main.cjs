// Warren desktop: the workspace in its own window, plus what only an app on this computer can do:
// run a hub here, connect this computer as a device for agents (one click, no token to copy), and
// keep both going from the menu bar after the window closes.
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const engine = require("./engine.cjs");
const cloud = require("./cloud.cjs");
const screenCode = require("./screen-code.cjs");
const { onOrigin, isPage, mainFrameUrl } = require("./trust.cjs");

const PORT = Number(process.env.PORT || 4747);
const LOCAL_HUB = `http://localhost:${PORT}`;
const CONFIG = path.join(app.getPath("userData"), "desktop.json");
const ICON = path.join(__dirname, "..", "build", "icon.png");
const SETUP_PAGE = path.join(__dirname, "setup.html");

/** @type {{ autoUpdate?: boolean, mode?: "local" | "remote", hubUrl?: string, cloud?: { provider: "hetzner", id: number, name: string, ip: string, location: string, type: string }, cloudPending?: { server: { id: number, name: string, ip: string, location: string, type: string }, key: string }, warrenDir?: string, device?: boolean, bounds?: Electron.Rectangle, buddyEnabled?: boolean, buddyAgents?: Record<string, string | null>, buddyPosition?: { x: number, y: number } }} */
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch {}
const save = () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
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
let deviceWaiting = false; // added as soon as someone signs in
const buddy = require("./buddy.cjs")({
  config, save, mainWindow: () => win, refresh,
  open: (route) => {
    if (!hubOrigin) return;
    showWindow();
    if (onOrigin(win.webContents.getURL(), hubOrigin)) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`);
    else win.loadURL(`${hubOrigin}/${route}`);
  },
});

const logDir = app.getPath("logs");
const updater = require("./updater.cjs").createUpdater({
  app,
  shell,
  notify: (title, body) => notify(title, body),
  refresh: () => refresh(),
  log: (line) => fs.appendFile(path.join(logDir, "updates.log"), `${new Date().toISOString()} ${line}\n`, () => {}),
  enabled: () => config.autoUpdate !== false,
});
const hub = new engine.Child("hub", logDir, () => refresh());
const device = new engine.Child("device", logDir, () => {
  if (device.state === "rejected") deviceRejected();
  refresh();
});

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
    if (onOrigin(url, hubOrigin)) return { action: "allow" };
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isPage(url, SETUP_PAGE) || onOrigin(url, hubOrigin)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3 || !onOrigin(url, hubOrigin)) return; // -3: aborted by a navigation
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
  win.loadFile(SETUP_PAGE, { query: { state: JSON.stringify(state) } });
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
    if (found.problem) return showSetup({ step: "create", problem: found.problem });
    showSetup({ step: "starting" });
    hub.start(found.node, found.warrenDir, ["hub", "start"], { ...found.env, PORT: String(PORT) });
    hubBy = "app";
    if (!(await waitFor(LOCAL_HUB, 90_000))) {
      hub.stop();
      return showSetup({ step: "create", problem: "The server didn't start.", log: hub.tail() });
    }
  }
  openHub(LOCAL_HUB);
  startDeviceIfWanted();
}

/** How to run Warren here: the app's own copy, or from source a Warren folder and Node 22+. */
function needs() {
  const found = engine.runtime(config.warrenDir);
  if (!found.problem && !found.bundled && config.warrenDir !== found.warrenDir) {
    config.warrenDir = found.warrenDir; // so a copy of the app elsewhere (or a moved one) finds it again
    save();
  }
  return found;
}

// ---------------------------------------------------------------- this computer as a device

/** The session token the web app keeps, so the app can add this device for the person signed in. */
async function sessionToken() {
  if (!win || !onOrigin(win.webContents.getURL(), hubOrigin)) return null;
  try {
    return await win.webContents.executeJavaScript('localStorage.getItem("warren.token")', true);
  } catch {
    return null;
  }
}

/**
 * Make this computer a device of the Warren in the window, if the person chose that. A device
 * already set up for this hub just starts; otherwise it's added for whoever signs in, as soon as
 * they do (a hub's first account is made in the window, after the app has opened it).
 */
async function startDeviceIfWanted() {
  if (!config.device || !hubOrigin) return;
  const cfg = engine.readNodeConfig();
  if (cfg.hub && cfg.token && sameOrigin(cfg.hub, hubOrigin)) return startDevice({ quiet: true });
  waitForSignIn();
}

let signInTimer = null;
function waitForSignIn() {
  clearInterval(signInTimer);
  const origin = hubOrigin;
  deviceError = "";
  deviceWaiting = true;
  refresh();
  signInTimer = setInterval(async () => {
    if (!config.device || hubOrigin !== origin || device.running() || deviceBy) return stopWaiting();
    if (!(await sessionToken())) return;
    stopWaiting();
    startDevice({ confirmed: true });
  }, 1500);
}
function stopWaiting() {
  clearInterval(signInTimer);
  signInTimer = null;
  deviceWaiting = false;
  refresh();
}

async function startDevice({ quiet = false, confirmed = false, claim = null } = {}) {
  deviceError = "";
  if (!hubOrigin) return;
  const service = await engine.serviceRunning("node");
  // a device card in Warren that never connected: this computer becomes that device
  if (claim?.token) {
    if (device.running()) await stopAndWait();
    engine.writeNodeConfig({ hub: hubOrigin, token: claim.token, name: claim.name || deviceName() });
    deviceBy = "";
  }
  let cfg = engine.readNodeConfig();
  const sameHub = cfg.hub && cfg.token && sameOrigin(cfg.hub, hubOrigin);
  if (service && sameHub && !claim) {
    deviceBy = "service";
    config.device = true;
    save();
    return refresh();
  }
  const found = needs();
  if (!service && found.problem) return fail(found.problem);

  if (cfg.hub && cfg.token && !sameHub && !confirmed) {
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
  if (service) {
    // `warren service install node` runs the device here: point it at this hub instead
    await engine.restartService("node");
    deviceBy = "service";
    refresh();
    if (!quiet) notify(`${deviceName()} is a device now`, "Agents can run here. Choose what it does for them in Warren → Devices.");
    return;
  }
  deviceBy = "app";
  device.start(found.node, found.warrenDir, ["node", "start"], { ...found.env, WARREN_EXIT_IF_REJECTED: "1" });
  if (!quiet) notify(`${deviceName()} is a device now`, "Agents can run here. Choose what it does for them in Warren → Devices.");

  function fail(msg) {
    deviceError = msg;
    refresh();
    if (!quiet) dialog.showMessageBox(win, { type: "warning", message: "Couldn't connect this computer", detail: msg });
  }
}

/**
 * The hub turned this computer's device token down (it was removed there, or the token is from an
 * old setup): forget it and add this computer again for whoever is signed in, instead of staying dead.
 */
function deviceRejected() {
  device.state = "stopped";
  deviceBy = "";
  engine.writeNodeConfig({ token: undefined });
  if (config.device && hubOrigin) waitForSignIn();
}

function stopDevice() {
  stopWaiting();
  config.device = false;
  save();
  device.stop();
  deviceBy = "";
  refresh();
}

async function stopAndWait() {
  device.stop();
  for (let i = 0; i < 50 && device.running(); i++) await new Promise((r) => setTimeout(r, 200));
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
  // like `warren node screen on`: turning the screen on asks for a code when there isn't one
  if (key === "shareScreen" && on && !engine.readNodeConfig().screenCode) showCodeWindow(false);
}

/** @type {BrowserWindow | null} */
let codeWin = null;
let codeSaved = false;

/** Pick (or change) the code that opens this screen from Warren, in a small window of its own. */
function showCodeWindow(change) {
  if (codeWin) return codeWin.focus();
  codeSaved = false;
  codeWin = new BrowserWindow({
    width: 420,
    height: 410,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: change ? "Change Screen Code" : "Screen Code",
    icon: ICON,
    show: false,
    backgroundColor: "#f7f7f7",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  codeWin.setMenuBarVisibility(false);
  codeWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  codeWin.webContents.on("will-navigate", (e) => e.preventDefault());
  codeWin.once("ready-to-show", () => codeWin?.show());
  codeWin.on("closed", () => {
    codeWin = null;
    if (!codeSaved && !change && !engine.readNodeConfig().screenCode)
      notify("No code for this screen", "Your Warren sign-in alone opens it. Pick one from the menu: Pick a Screen Code…");
  });
  codeWin.loadFile(path.join(__dirname, "screen-code.html"), { query: { state: JSON.stringify({ change }) } });
}

// only the code window can save a code; the code itself is hashed here and goes nowhere else
ipcMain.handle("screen-code:save", (e, input) => {
  if (!codeWin || e.sender !== codeWin.webContents) return null;
  const r = screenCode.pick(input);
  if (r.error) return { error: r.error };
  engine.writeNodeConfig({ screenCode: r.screenCode });
  codeSaved = true;
  notify("Screen code saved", `You'll enter this ${r.screenCode.kind === "pin" ? "PIN" : "password"} in Warren to watch this screen or lend it to an agent.`);
  codeWin.close();
  refresh();
  return { ok: true };
});

// ---------------------------------------------------------------- menus

function hubLine() {
  if (!config.mode) return "Not set up yet";
  if (config.mode === "remote") return `Joined ${hostOf(config.hubUrl)}`;
  if (hub.state === "error") return "Server stopped unexpectedly";
  if (hub.state === "starting" && !hubOrigin) return "Server starting…";
  if (hubBy === "service") return "Server running here (as a service)";
  return hubOrigin ? "Server running on this computer" : "Server not running";
}

function deviceLine() {
  if (deviceBy === "service") return "This computer: connected (as a service)";
  if (device.state === "starting" && device.running()) return "This computer: connected";
  if (device.state === "error") return "This computer: stopped unexpectedly";
  if (deviceError) return `This computer: ${deviceError}`;
  if (deviceWaiting) return "This computer: becomes a device when you sign in";
  return "This computer: not a device";
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u || "";
  }
};

/** Where other computers join a server running here: copy it from the menu to send to them. */
function serverAddressItems() {
  if (config.mode !== "local" || !hubOrigin) return [];
  const addrs = engine.lanAddresses(PORT);
  if (!addrs.length) return [];
  return [
    {
      label: "Copy Server Address",
      submenu: addrs.map((a) => ({ label: a.replace(/^http:\/\//, ""), click: () => (clipboard.writeText(a), notify("Server address copied", `Others join with ${a} in their Warren app.`)) })),
    },
  ];
}

function trayMenu() {
  const n = engine.readNodeConfig();
  const isDevice = deviceBy === "service" || device.running();
  return Menu.buildFromTemplate([
    { label: hubLine(), enabled: false },
    { label: deviceLine(), enabled: false },
    { type: "separator" },
    { label: "Open Warren", click: () => showWindow() },
    ...serverAddressItems(),
    buddy.menu(),
    { type: "separator" },
    isDevice || deviceWaiting
      ? { label: deviceWaiting ? "Don't Make This Computer a Device" : "Disconnect This Computer", enabled: deviceBy !== "service", click: () => stopDevice() }
      : { label: "Connect This Computer for Agents…", enabled: !!hubOrigin, click: () => startDevice() },
    { label: "Let Me Use This Screen from Warren", type: "checkbox", visible: isDevice, checked: !!n.shareScreen && !n.noScreen, click: (i) => setDeviceFlag("shareScreen", i.checked) },
    { label: n.screenCode ? "Change Screen Code…" : "Pick a Screen Code…", visible: isDevice && !!n.shareScreen && !n.noScreen, click: () => showCodeWindow(!!n.screenCode) },
    { label: "Pause Agents on This Computer", type: "checkbox", visible: isDevice, checked: !!n.paused, click: (i) => setDeviceFlag("paused", i.checked) },
    { type: "separator" },
    { label: "Create or Join Another Server…", click: () => showSetup() },
    ...updater.menu(),
    { label: "Update Automatically", type: "checkbox", checked: config.autoUpdate !== false, click: (i) => ((config.autoUpdate = i.checked), save()) },
    { label: "Show Logs", click: () => shell.openPath(logDir) },
    { type: "separator" },
    { label: "Quit Warren", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ]);
}

function appMenu() {
  const go = (route) => () => {
    if (!hubOrigin) return;
    showWindow();
    if (onOrigin(win.webContents.getURL(), hubOrigin)) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${route}`)}`);
    else win.loadURL(`${hubOrigin}/#/${route}`);
  };
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac
      ? [{ label: "Warren", submenu: [{ role: "about" }, { label: "Check for Updates…", click: () => updater.check() }, { type: "separator" }, { label: "Settings…", accelerator: "Cmd+,", click: go("settings") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : []),
    { label: "File", submenu: [{ label: "Create or Join Another Server…", click: () => showSetup() }, { type: "separator" }, mac ? { role: "close" } : { role: "quit" }] },
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
    { role: "help", submenu: [{ label: "Warren on GitHub", click: () => shell.openExternal("https://github.com/eireijie/warren") }, ...(mac ? [] : [{ label: "Check for Updates…", click: () => updater.check() }]), { label: "Show Logs", click: () => shell.openPath(logDir) }] },
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

/** Setup calls only from the app's own setup page in the main window, never from a hub's pages. */
const fromSetup = (e) => isPage(mainFrameUrl(e, win) ?? "", SETUP_PAGE);
/** Device calls only from the hub the window opened, in its main frame. */
const fromHub = (e) => onOrigin(mainFrameUrl(e, win) ?? "", hubOrigin);
const setup = (name, fn) => ipcMain.handle(name, (e, ...args) => (fromSetup(e) ? fn(...args) : null));

setup("setup:check", () => {
  const found = engine.runtime(config.warrenDir);
  return { problem: found.problem ?? null, platform: process.platform, hubUrl: config.hubUrl ?? "", mode: config.mode ?? null, device: config.device ?? true, deviceName: deviceName() };
});

/** Create: run a server on this computer, then open it (the window makes the first account). */
setup("setup:create", async ({ device: asDevice = true } = {}) => {
  const found = needs();
  if (found.problem) return { ok: false, error: found.problem };
  switchTo({ mode: "local", hubUrl: undefined, cloud: undefined, device: !!asDevice });
  connect();
  return { ok: true };
});

/** Test a server address without joining it. */
setup("setup:test", (url) => engine.testHub(url));

/** Join: test the address once more, then open it; this computer becomes a device when you sign in. */
setup("setup:join", async (url, { device: asDevice = true } = {}) => {
  const test = await engine.testHub(url);
  if (!test.ok) return test;
  switchTo({ mode: "remote", hubUrl: test.url, cloud: sameOrigin(test.url, config.hubUrl ?? "") ? config.cloud : undefined, device: !!asDevice });
  connect();
  return test;
});

/**
 * Create one in your cloud account: a server in the person's own Hetzner project, which Hetzner
 * bills them for. The API token comes from the setup page with each call and is never kept here:
 * not in memory after the call, not in desktop.json. Only where the server is gets saved.
 */
setup("setup:cloud-plans", async (token) => {
  try {
    return { ok: true, ...(await cloud.plans(String(token || "").trim())) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * A server that was created but didn't finish setting up keeps its setup key here (`cloudPending`),
 * even across restarts: only that key can make its first account, so "Keep waiting" (`resume`, the
 * server's id) picks it up again instead of leaving it unusable.
 */
setup("setup:cloud-create", async (token, { type, location, account, device: asDevice = true, resume = null } = {}) => {
  const pending = resume != null && config.cloudPending?.server?.id === resume ? config.cloudPending : undefined;
  try {
    const r = await cloud.createWarren(
      { token: String(token || "").trim(), type, location, account },
      { onStep: (step) => win?.webContents.send("setup:cloud-step", step), resume: pending },
    );
    const { id, name, ip } = r.server;
    config.cloudPending = undefined;
    switchTo({ mode: "remote", hubUrl: r.url, device: !!asDevice, cloud: { provider: "hetzner", id, name, ip, location, type } });
    signInOnOpen(r.url, r.session);
    connect();
    return { ok: true, url: r.url };
  } catch (err) {
    if (err.server && err.key) {
      config.cloudPending = { server: { id: err.server.id, name: err.server.name, ip: err.server.ip, location: err.server.location, type: err.server.type }, key: err.key };
      save();
    }
    return { ok: false, error: err.message, server: err.server ? { id: err.server.id, name: err.server.name, ip: err.server.ip } : null };
  }
});

setup("setup:cloud-delete", async (token, id) => {
  try {
    await cloud.deleteServer(String(token || "").trim(), id);
    if (config.cloudPending?.server?.id === id) {
      config.cloudPending = undefined;
      save();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** The account was made by the app, so hand its session to the web app when the hub first opens. */
function signInOnOpen(url, session) {
  if (!win) createWindow();
  const origin = new URL(url).origin;
  win.webContents.once("did-finish-load", () => {
    if (!onOrigin(win.webContents.getURL(), origin)) return;
    win.webContents.executeJavaScript(`localStorage.setItem("warren.token", ${JSON.stringify(session)}); location.hash = "#/welcome/intro"; location.reload();`);
  });
}

/** Leave the current server for another: stop what this app runs for it first. */
function switchTo(next) {
  stopWaiting();
  if (config.mode === "local" && next.mode !== "local") hub.stop();
  if (deviceBy === "app") device.stop();
  deviceBy = "";
  deviceError = "";
  hubOrigin = null;
  Object.assign(config, next);
  save();
}

setup("setup:retry", () => connect());

ipcMain.on("badge", (_e, n) => {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  app.setBadgeCount?.(count);
  if (process.platform === "darwin") app.dock?.setBadge(count ? String(count) : "");
});
ipcMain.handle("desktop:info", () => ({ version: app.getVersion(), platform: process.platform, device: deviceBy === "service" || device.running() }));
ipcMain.handle("desktop:connect-device", (e, claim) => (fromHub(e) ? startDevice({ confirmed: !!claim, claim: claim && typeof claim.token === "string" ? { token: claim.token, name: String(claim.name || "") } : null }) : null));

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON));
  Menu.setApplicationMenu(appMenu());
  makeTray();
  buddy.ready();
  createWindow();
  connect();
  updater.start();
});

app.on("activate", () => showWindow());
app.on("window-all-closed", () => {}); // stays in the menu bar
app.on("before-quit", () => {
  quitting = true;
  updater.stop();
  updater.installOnQuit();
  buddy.destroy();
  hub.stop();
  device.stop();
});
