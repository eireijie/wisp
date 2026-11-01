// Wisp desktop: the workspace in its own window, plus what only an app on this computer can do:
// run a hub here, connect this computer as a device for agents (one click, no token to copy), and
// keep both going from the menu bar after the window closes.
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const migration = require("./migration.cjs").createMigration({ appData: app.getPath("appData") });
app.setName("Wisp");
const migrated = migration.prepare();
fs.mkdirSync(migrated.userData, { recursive: true });
app.setPath("userData", migrated.userData);
const engine = require("./engine.cjs");
const { GITHUB_URL } = require("./repo.cjs");
const { isPairingLink, registerProtocols } = require("./protocol.cjs");
const cloud = require("./cloud.cjs");
const screenCode = require("./screen-code.cjs");
const { reachableAddresses } = require("./addresses.cjs");
const { Discovery, JoinClient } = require("./join.cjs");
const { onOrigin, isPage, mainFrameUrl, isRemoteDesktopLink, isObsidianLink } = require("./trust.cjs");

// links that hand off to another app on this computer: remote desktop apps, and Obsidian for the vault
const isExternalAppLink = (url) => isRemoteDesktopLink(url) || isObsidianLink(url);

const PORT = Number(process.env.PORT || 4747);
const LOCAL_HUB = `http://localhost:${PORT}`;
const CONFIG = path.join(app.getPath("userData"), "desktop.json");
const ICON = path.join(__dirname, "..", "build", "icon.png");
const SETUP_PAGE = path.join(__dirname, "setup.html");
const joinClient = new JoinClient({ fetchImpl: (...args) => fetch(...args), name: () => deviceName(), platform: process.platform });
const discovery = new Discovery(() => {
  // Built apps carry production dependencies in Resources/wisp, outside app.asar.
  const bundled = engine.runtime(config.wispDir);
  return bundled.bundled
    ? require("node:module").createRequire(path.join(bundled.wispDir, "package.json"))("bonjour-service")
    : require("bonjour-service");
});
let joining = null;
let openOnboarding = false;

/** @type {{ autoUpdate?: boolean, mode?: "local" | "remote", hubUrl?: string, cloud?: { provider: "hetzner", id: number, name: string, ip: string, location: string, type: string }, cloudPending?: { server: { id: number, name: string, ip: string, location: string, type: string }, key: string, dismissed?: boolean }, wispDir?: string, device?: boolean, bounds?: Electron.Rectangle, buddyEnabled?: boolean, buddyOverFullscreen?: boolean, buddyAgents?: Record<string, string | null>, buddyPosition?: { x: number, y: number } }} */
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
let pendingCloudOpen = false;
let resumeOnShow = false;
let hubOrigin = null; // the hub the window shows, once it's reachable
let hubBy = ""; // "app" | "service" | "already running" | "remote"
let deviceBy = ""; // "app" | "service"
let deviceError = "";
let deviceOnline = false;
let deviceSignedOut = false;
let deviceStatusTimer = null;
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
  deviceOnline = false;
  if (device.state === "rejected") deviceRejected();
  refresh();
});

if (!app.requestSingleInstanceLock()) app.quit();
let startupComplete = false;
let pendingPairing = process.argv?.some(isPairingLink) || false;
function openPairing(input) {
  if (!isPairingLink(input)) return false;
  pendingPairing = true;
  if (startupComplete) showPairing();
  return true;
}
function showPairing() {
  pendingPairing = false;
  showWindow();
  // Pairing is completed on a phone; bring the desktop's pairing instructions into view.
  if (hubOrigin) openHub(hubOrigin, "#/settings/mobile");
}
app.on("second-instance", (_event, argv = []) => {
  if (!argv.some(openPairing) && startupComplete) showWindow();
});
app.on("open-url", (event, url) => { event.preventDefault(); openPairing(url); });
registerProtocols(app);

app.setAboutPanelOptions?.({ applicationName: "Wisp", copyright: "Apache-2.0", website: GITHUB_URL });

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
    title: "Wisp",
    icon: ICON,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: true, backgroundThrottling: false }, // so notifications keep coming while the window is hidden
  });
  win.once("ready-to-show", () => win?.show());
  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    config.bounds = win.getNormalBounds();
    save();
  };
  win.on("resize", remember);
  win.on("move", remember);
  // closing the window keeps Wisp (and its hub and device) running from the menu bar
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (pendingCloudOpen) {
      keepPendingCloud();
      resumeOnShow = true;
    }
    win?.hide();
    if (process.platform === "darwin") app.dock?.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (onOrigin(url, hubOrigin)) return { action: "allow" };
    // a device page's Open for RustDesk, AnyDesk and the like opens that app on this computer
    if (/^https?:|^mailto:/.test(url) || isExternalAppLink(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isPage(url, SETUP_PAGE) || onOrigin(url, hubOrigin)) return;
    e.preventDefault();
    if (/^https?:/.test(url) || isExternalAppLink(url)) shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3 || !onOrigin(url, hubOrigin)) return; // -3: aborted by a navigation
    showSetup({ step: "unreachable", hubUrl: hubOrigin, error: desc });
  });
}

function showWindow() {
  if (!win) createWindow();
  if (resumeOnShow) { resumeOnShow = false; connect(); }
  if (process.platform === "darwin") app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showSetup(state = {}) {
  discovery.cancel();
  joinClient.cancel();
  resumeOnShow = false;
  pendingCloudOpen = false;
  if (!win) createWindow();
  win.loadFile(SETUP_PAGE, { query: { state: JSON.stringify(state) } });
  showWindow();
}

function showPendingCloud() {
  if (!config.cloudPending) return;
  showSetup({ step: "cloud", server: config.cloudPending.server });
  pendingCloudOpen = true;
}

function keepPendingCloud() {
  if (config.cloudPending) {
    config.cloudPending.dismissed = true;
    save();
  }
  pendingCloudOpen = false;
  refresh();
}

function openHub(url, route = "") {
  pendingCloudOpen = false;
  hubOrigin = new URL(url).origin;
  buddy.connect(hubOrigin);
  if (!win) createWindow();
  win.loadURL(hubOrigin + "/" + route);
  if (pendingPairing && startupComplete) showPairing();
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

/** Find this computer's server, or start it. Says what went wrong, if anything. */
async function startLocalHub(onStarting = () => {}) {
  if (await engine.hubUp(LOCAL_HUB)) {
    hubBy = (await engine.serviceRunning("hub")) ? "service" : hub.running() ? "app" : "already running";
    return {};
  }
  const found = needs();
  if (found.problem) return { problem: found.problem };
  onStarting();
  hub.start(found.node, found.wispDir, ["hub", "start"], { ...found.env, PORT: String(PORT) });
  hubBy = "app";
  if (await waitFor(LOCAL_HUB, 90_000)) return {};
  hub.stop();
  return { problem: "The server didn't start.", log: hub.tail() };
}

/** Find or start the hub for the saved choice, then show it. */
async function connect(restartDevice = false) {
  if (config.mode === "remote" && config.hubUrl) {
    hubBy = "remote";
    if (!(await engine.hubUp(config.hubUrl))) return showSetup({ step: "unreachable", hubUrl: config.hubUrl });
    openHub(config.hubUrl);
    return restartDevice ? startDevice({ confirmed: true }) : startDeviceIfWanted();
  }
  if (config.mode !== "local") return showSetup();

  const started = await startLocalHub(() => showSetup({ step: "starting" }));
  if (started.problem) return showSetup({ step: "create", ...started });
  // a new Wisp here: its setup link, so making the first account doesn't ask for the code
  const setupCode = engine.localSetupCode(config.wispDir);
  openHub(LOCAL_HUB, setupCode ? `#/setup/${setupCode}` : openOnboarding ? "#/welcome/intro" : "");
  openOnboarding = false;
  startDeviceIfWanted();
}

/** How to run Wisp here: the app's own copy, or from source a Wisp folder and Node 22+. */
function needs() {
  const found = engine.runtime(config.wispDir);
  if (!found.problem && !found.bundled && config.wispDir !== found.wispDir) {
    config.wispDir = found.wispDir; // so a copy of the app elsewhere (or a moved one) finds it again
    save();
  }
  return found;
}

// ---------------------------------------------------------------- this computer as a device

/** The session token the web app keeps, so the app can add this device for the person signed in. */
async function sessionToken() {
  if (!win || !onOrigin(win.webContents.getURL(), hubOrigin)) return null;
  try {
    return await win.webContents.executeJavaScript('localStorage.getItem("wisp.token")', true);
  } catch {
    return null;
  }
}

/**
 * Make this computer a device of the Wisp in the window, if the person chose that. A device
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
  // a device card in Wisp that never connected: this computer becomes that device
  if (claim?.token) {
    if (device.running()) await stopAndWait();
    engine.writeNodeConfig({ hub: hubOrigin, token: claim.token, nodeId: undefined, name: claim.name || deviceName() });
    deviceBy = "";
  }
  let cfg = engine.readNodeConfig();
  const sameHub = cfg.hub && cfg.token && sameOrigin(cfg.hub, hubOrigin);
  if (service && sameHub && !claim && quiet) {
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
      buttons: ["Connect to this Wisp", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "This computer is a device of another Wisp",
      detail: `It's set up for ${cfg.hub}. Connecting it to ${hubOrigin} instead disconnects it from there.`,
    });
    if (response !== 0) return;
  }
  if (!sameHub) {
    const token = await sessionToken();
    if (!token) return fail("Sign in to Wisp first, then connect this computer.");
    try {
      const res = await fetch(new URL("/api/nodes", hubOrigin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: deviceName() }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch((err) => { if (err.name === "TimeoutError" || err.name === "AbortError") throw err; return {}; });
      if (!res.ok) return fail(body.error || `The hub said ${res.status}`);
      cfg = engine.writeNodeConfig({ hub: hubOrigin, token: body.token, nodeId: body.node?.id, name: deviceName() });
    } catch (err) {
      return fail(err.name === "TimeoutError" || err.name === "AbortError" ? "The hub request timed out. Try connecting again." : `Couldn't reach the hub: ${err.message}`);
    }
  }
  config.device = true;
  save();
  if (service) {
    // `wisp service install node` runs the device here: point it at this hub instead
    if (!(await engine.restartService("node"))) {
      deviceBy = "";
      deviceOnline = false;
      return fail("The device service couldn't restart. Try connecting again.");
    }
    deviceBy = "service";
    refresh();
    if (!quiet) notify(`${deviceName()} is a device now`, "Agents can run here. Choose what it does for them in Wisp → Devices.");
    return;
  }
  deviceBy = "app";
  device.start(found.node, found.wispDir, ["node", "start"], { ...found.env, WISP_EXIT_IF_REJECTED: "1" });
  if (!quiet) notify(`${deviceName()} is a device now`, "Agents can run here. Choose what it does for them in Wisp → Devices.");

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

async function readDeviceStatus() {
  const origin = hubOrigin;
  const cfg = engine.readNodeConfig();
  const active = () => config.device && !deviceError && (deviceBy === "service" || device.running());
  const session = await sessionToken();
  const online = !!(active() && cfg.token && origin && sameOrigin(cfg.hub, origin) && (session
    ? await engine.deviceConnected(origin, cfg, session)
    : (deviceBy !== "service" || await engine.serviceRunning("node")) && engine.deviceLogConnected(origin, deviceBy === "service" ? undefined : device.log)));
  // A server switch or disconnect during the request invalidates its result.
  if (hubOrigin !== origin || engine.readNodeConfig().token !== cfg.token) return false;
  deviceOnline = !!(active() && online);
  deviceSignedOut = !session;
  refresh();
  return deviceOnline;
}

function stopDevice() {
  deviceOnline = false;
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

/** "Alex's MacBook Air" on a Mac; elsewhere the host name without its network domain. */
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
  // like `wisp node screen on`: turning the screen on asks for a code when there isn't one
  if (key === "shareScreen" && on && !engine.readNodeConfig().screenCode) showCodeWindow(false);
}

/** @type {BrowserWindow | null} */
let codeWin = null;
let codeSaved = false;

/** Pick (or change) the code that opens this screen from Wisp, in a small window of its own. */
function showCodeWindow(change) {
  if (codeWin) return codeWin.focus();
  codeSaved = false;
  codeWin = new BrowserWindow({
    width: 420,
    height: 540,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: change ? "Change Screen Code" : "Screen Code",
    icon: ICON,
    show: false,
    backgroundColor: nativeTheme?.shouldUseDarkColors ? "#18181b" : "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  codeWin.setMenuBarVisibility(false);
  codeWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  codeWin.webContents.on("will-navigate", (e) => e.preventDefault());
  codeWin.once("ready-to-show", () => codeWin?.show());
  codeWin.on("closed", () => {
    codeWin = null;
    if (!codeSaved && !change && !engine.readNodeConfig().screenCode)
      notify("No code for this screen", "Your Wisp sign-in alone opens it. Pick one from the menu: Pick a Screen Code…");
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
  notify("Screen code saved", `You'll enter this ${r.screenCode.kind === "pin" ? "PIN" : "password"} in Wisp to watch this screen.`);
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
  if (deviceError) return `This computer: ${deviceError}`;
  if (deviceOnline && deviceSignedOut) return "This computer: connected, sign in to manage";
  if (deviceOnline && deviceBy === "service") return "This computer: connected (as a service)";
  if (deviceOnline) return "This computer: connected";
  if (deviceBy === "service" || device.running()) return "This computer: connecting…";
  if (device.state === "error") return "This computer: stopped unexpectedly";
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
  const addrs = reachableAddresses(PORT);
  if (!addrs.length) return [];
  return [
    {
      label: "Copy Wisp Address",
      submenu: addrs.map((a) => ({ label: a.replace(/^http:\/\//, ""), click: () => (clipboard.writeText(a), notify("Wisp address copied", "Share this address with your other computers.")) })),
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
    { label: "Open Wisp", click: () => showWindow() },
    ...serverAddressItems(),
    buddy.menu(),
    { type: "separator" },
    isDevice || deviceWaiting
      ? { label: deviceWaiting ? "Don't Make This Computer a Device" : "Disconnect This Computer for Agents…", enabled: deviceBy !== "service", click: () => stopDevice() }
      : { label: "Connect This Computer for Agents…", enabled: !!hubOrigin, click: () => startDevice() },
    { label: "Let Me Use This Screen from Wisp", type: "checkbox", visible: isDevice, checked: !!n.shareScreen && !n.noScreen, click: (i) => setDeviceFlag("shareScreen", i.checked) },
    { label: n.screenCode ? "Change Screen Code…" : "Pick a Screen Code…", visible: isDevice && !!n.shareScreen && !n.noScreen, click: () => showCodeWindow(!!n.screenCode) },
    { label: "Pause Agents on This Computer", type: "checkbox", visible: isDevice, checked: !!n.paused, click: (i) => setDeviceFlag("paused", i.checked) },
    { type: "separator" },
    ...(config.cloudPending ? [{ label: "Unfinished Cloud Server…", click: () => showPendingCloud() }] : []),
    { label: "Create or Join Another Server…", click: () => showSetup() },
    ...updater.menu(),
    { label: "Update Automatically", type: "checkbox", checked: config.autoUpdate !== false, click: (i) => ((config.autoUpdate = i.checked), save()) },
    { label: "Show Logs", click: () => shell.openPath(logDir) },
    { type: "separator" },
    { label: "Quit Wisp", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
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
      ? [{ label: "Wisp", submenu: [{ role: "about" }, { label: "Check for Updates…", click: () => updater.check() }, { type: "separator" }, { label: "Settings…", accelerator: "Cmd+,", click: go("settings") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
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
        { label: "Inbox", accelerator: "CmdOrCtrl+1", click: go("dashboard") },
        { label: "Chats", accelerator: "CmdOrCtrl+2", click: go("chats") },
        { label: "Agents", accelerator: "CmdOrCtrl+3", click: go("agents") },
        { label: "Computers", accelerator: "CmdOrCtrl+4", click: go("computers") },
        { type: "separator" },
        { label: "Memory", accelerator: "CmdOrCtrl+5", click: go("vault") },
        { label: "Devices", accelerator: "CmdOrCtrl+6", click: go("nodes") },
        { type: "separator" },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => win?.webContents.navigationHistory.goForward() },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Wisp on GitHub", click: () => shell.openExternal(GITHUB_URL) }, ...(mac ? [] : [{ label: "Check for Updates…", click: () => updater.check() }]), { label: "Show Logs", click: () => shell.openPath(logDir) }] },
  ]);
}

function refresh() {
  if (!app.isReady()) return;
  tray?.setContextMenu(trayMenu());
  tray?.setToolTip(`Wisp: ${hubLine()}`);
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
  const found = engine.runtime(config.wispDir);
  return { problem: found.problem ?? null, platform: process.platform, hubUrl: config.hubUrl ?? "", mode: config.mode ?? null, device: config.device ?? true, deviceName: deviceName() };
});

/** Create: run a server on this computer; the setup page says when, then opens it (setup:open). */
setup("setup:create", async ({ device: asDevice = true } = {}) => {
  const found = needs();
  if (found.problem) return { ok: false, error: found.problem };
  switchTo({ mode: "local", hubUrl: undefined, cloud: undefined, device: !!asDevice });
  openOnboarding = true;
  const started = await startLocalHub();
  return started.problem ? { ok: false, error: started.problem, log: started.log } : { ok: true };
});

/** Open the server that's now running (the window makes the first account). */
setup("setup:open", () => connect());

setup("setup:discover", () => discovery.browse());
setup("setup:cancel-join", () => { discovery.cancel(); joinClient.cancel(); return { ok: true }; });
setup("setup:request-join", async (input) => {
  discovery.cancel();
  try { return await joinClient.request(input); }
  catch (err) { return { ok: false, error: err.message }; }
});
setup("setup:poll-join", () => {
  // Approval contains a one-use credential; finish saving it even if a renderer reloads.
  if (joining) return joining;
  joining = (async () => {
    try {
      const result = await joinClient.poll();
      if (result.status !== "approved") return { ok: true, status: result.status };
      switchTo({ mode: "remote", hubUrl: result.hubUrl, cloud: sameOrigin(result.hubUrl, config.hubUrl ?? "") ? config.cloud : undefined, device: true });
      // hubId lets this computer find its Wisp again if the address changes; undefined clears one from an earlier Wisp
      engine.writeNodeConfig({ hub: result.hubUrl, token: result.nodeToken, nodeId: result.nodeId, name: deviceName(), hubId: typeof result.hubId === "string" ? result.hubId : undefined });
      joinClient.cancel();
      await connect(true);
      return { ok: true, status: "approved" };
    } catch (err) { return { ok: false, error: "Couldn't check approval; trying again…" }; }
    finally { joining = null; }
  })();
  return joining;
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
    const r = await cloud.createWisp(
      { token: String(token || "").trim(), type, location, account },
      { onStep: (step) => win?.webContents.send("setup:cloud-step", step), resume: pending },
    );
    const { id, name, ip } = r.server;
    config.cloudPending = undefined;
    switchTo({ mode: "remote", hubUrl: r.url, device: !!asDevice, cloud: { provider: "hetzner", id, name, ip, location: r.server.location, type: r.server.type } });
    signInOnOpen(r.url, r.session);
    connect();
    return { ok: true, url: r.url };
  } catch (err) {
    if (err.server && err.key) {
      config.cloudPending = { server: { id: err.server.id, name: err.server.name, ip: err.server.ip, location: err.server.location, type: err.server.type }, key: err.key };
      pendingCloudOpen = true;
      save();
      refresh();
    }
    return { ok: false, error: err.message, server: err.server ? { id: err.server.id, name: err.server.name, ip: err.server.ip } : null };
  }
});

setup("setup:cloud-keep", () => {
  keepPendingCloud();
  return connect();
});

setup("setup:cloud-delete", async (token, id) => {
  try {
    await cloud.deleteServer(String(token || "").trim(), id);
    if (config.cloudPending?.server?.id === id) {
      config.cloudPending = undefined;
      pendingCloudOpen = false;
      save();
      refresh();
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
    win.webContents.executeJavaScript(`localStorage.setItem("wisp.token", ${JSON.stringify(session)}); location.hash = "#/welcome/intro"; location.reload();`);
  });
}

/** Leave the current server for another: stop what this app runs for it first. */
function switchTo(next) {
  deviceOnline = false;
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

ipcMain.on("desktop:focus", (e) => {
  if (fromHub(e)) showWindow();
});
ipcMain.on("badge", (_e, n) => {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  app.setBadgeCount?.(count);
  if (process.platform === "darwin") app.dock?.setBadge(count ? String(count) : "");
});
ipcMain.handle("desktop:info", async () => ({ version: app.getVersion(), platform: process.platform, device: await readDeviceStatus() }));
ipcMain.handle("updates:status", (e) => (fromHub(e) ? updater.status() : null));
ipcMain.handle("updates:check", (e) => (fromHub(e) ? updater.checkQuietly() : null));
ipcMain.handle("updates:restart", (e) => (fromHub(e) ? updater.restart() : null));
ipcMain.handle("desktop:connect-device", (e, claim) => (fromHub(e) ? startDevice({ confirmed: !!claim, claim: claim && typeof claim.token === "string" ? { token: claim.token, name: String(claim.name || "") } : null }) : null));

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  // Do not start or connect while old services are still using the migrated data.
  await migration.migrateServices(() => engine.runtime(config.wispDir));
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON));
  Menu.setApplicationMenu(appMenu());
  makeTray();
  buddy.ready();
  createWindow();
  startupComplete = true;
  if (config.cloudPending && !config.cloudPending.dismissed) showPendingCloud();
  else connect();
  updater.start();
  deviceStatusTimer = setInterval(() => void readDeviceStatus(), 15_000);
}).catch((err) => {
  dialog.showErrorBox("Couldn’t migrate Wisp", err.message);
  app.quit();
});

app.on("activate", () => { if (startupComplete) showWindow(); });
app.on("window-all-closed", () => {}); // stays in the menu bar
app.on("before-quit", (event) => {
  if (updater.installOnQuit(event)) return;
  quitting = true;
  discovery.cancel();
  joinClient.cancel();
  clearInterval(deviceStatusTimer);
  updater.stop();
  buddy.destroy();
  hub.stop();
  device.stop();
});
