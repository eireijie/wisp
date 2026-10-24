import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function fixture(pending = false, saved: Record<string, any> = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let ready: () => void = () => {};
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/desktop-test", getVersion: () => "0.0.1", requestSingleInstanceLock: () => true,
    setAboutPanelOptions: vi.fn(), isReady: () => false, whenReady: () => ({ then: (fn: () => void) => { ready = fn; } }),
  });
  const loadFile = vi.fn();
  const writeFileSync = vi.fn();
  const windows: Window[] = [];
  const executeJavaScript = vi.fn(async (): Promise<string | null> => "session-token");
  const showNotification = vi.fn();
  const showMessageBox = vi.fn();
  const updater = { menu: () => [], start: vi.fn(), stop: vi.fn(), installOnQuit: vi.fn(() => false) };
  const buddy = { menu: () => ({ label: "Desk buddy" }), connect: vi.fn(), ready: vi.fn(), destroy: vi.fn() };
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "https://hub/" },
      getURL: () => this.webContents.mainFrame.url, executeJavaScript, setWindowOpenHandler: vi.fn(),
    });
    loadFile = loadFile;
    loadURL = vi.fn();
    isMinimized = () => false;
    show = vi.fn(); focus = vi.fn(); hide = vi.fn();
    constructor() { super(); windows.push(this); }
  }
  const cfg: Record<string, any> = { hub: "https://old", token: "old-token", name: "device" };
  const engine = {
    Child: class {
      state = "starting";
      log = "/desktop-test/device.log";
      running = vi.fn(() => true);
      stop = vi.fn();
      start = vi.fn();
    },
    readNodeConfig: () => ({ ...cfg }),
    writeNodeConfig: (patch: object) => Object.assign(cfg, patch),
    hubUp: vi.fn().mockResolvedValue(true),
    lanAddresses: () => [],
    serviceRunning: vi.fn().mockResolvedValue(true),
    restartService: vi.fn().mockResolvedValue(false),
    runtime: () => ({ node: "node", warrenDir: "/runtime" }),
    deviceConnected: vi.fn().mockResolvedValue(false),
    deviceLogConnected: vi.fn(() => false),
  };
  const server = { id: 42, name: "pending", ip: "203.0.113.7", type: "cx23", location: "fsn1" };
  const cloud = { deleteServer: vi.fn().mockResolvedValue(undefined) };
  const config = { ...(pending ? { cloudPending: { server, key: "secret-key" } } : {}), ...saved };
  const filename = fileURLToPath(new URL("../src/main.cjs", import.meta.url));
  const require = createRequire(filename);
  const module = { exports: {} as any };
  const fetch = vi.fn(async (_url, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return { ok: true, json: async () => ({ token: "new-token", node: { id: "n" } }) };
  });
  const code = readFileSync(filename, "utf8") + `\nmodule.exports = { startDevice, readDeviceStatus, deviceLine, trayMenu, appMenu, showPendingCloud, device,
    init() { win = new BrowserWindow(); hubOrigin = 'https://hub'; config.device = true; },
    service() { deviceBy = 'service'; }, config };`;
  runInNewContext(code, {
    module, __dirname: path.dirname(filename), URL, AbortSignal, fetch,
    process: { ...process, platform: "linux" }, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    require: (name: string) => {
      if (name === "electron") return { app, BrowserWindow: Window,
        ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), on: vi.fn() },
        dialog: { showMessageBox }, Menu: { buildFromTemplate: (items: unknown[]) => items, setApplicationMenu: vi.fn() },
        nativeImage: { createFromPath: () => ({ resize: vi.fn() }) }, Tray: class { on = vi.fn(); },
        Notification: class { static isSupported = () => true; show = showNotification; },
      };
      if (name === "node:fs") return { readFileSync: () => JSON.stringify(config), mkdirSync: vi.fn(), writeFileSync, existsSync: () => false };
      if (name === "./engine.cjs") return engine;
      if (name === "./cloud.cjs") return cloud;
      if (name === "./buddy.cjs") return () => buddy;
      if (name === "./updater.cjs") return { createUpdater: () => updater };
      return require(name);
    },
  });
  return { main: module.exports, app, updater, cloud, buddy, engine, handlers, fetch, loadFile, showNotification, showMessageBox, ready: () => ready(), server, windows, executeJavaScript,
    savedConfig: () => JSON.parse(writeFileSync.mock.calls.at(-1)![1]),
    setupEvent: () => {
      const window = windows.at(-1)!;
      window.webContents.mainFrame.url = new URL("../src/setup.html", import.meta.url).href;
      return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    },
  };
}

describe("desktop update shutdown", () => {
  it("defers shutdown cleanup while the updater waits for the installer", () => {
    const f = fixture();
    const event = { preventDefault: vi.fn() };
    f.updater.installOnQuit.mockReturnValueOnce(true);
    f.app.emit("before-quit", event);
    expect(f.updater.installOnQuit).toHaveBeenCalledWith(event);
    expect(f.updater.stop).not.toHaveBeenCalled();
    expect(f.buddy.destroy).not.toHaveBeenCalled();
    f.app.emit("before-quit", event);
    expect(f.updater.stop).toHaveBeenCalledOnce();
    expect(f.buddy.destroy).toHaveBeenCalledOnce();
  });
});

describe("desktop device status", () => {
  it("reports a failed service restart and allows a subsequent retry", async () => {
    const f = fixture();
    f.main.init();
    await f.main.startDevice({ confirmed: true });
    expect(f.engine.restartService).toHaveBeenCalledTimes(1);
    expect(f.showNotification).not.toHaveBeenCalled();
    expect(f.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: "The device service couldn't restart. Try connecting again." }));
    expect(f.main.deviceLine()).toMatch(/couldn't restart/);
    expect((await f.handlers.get("desktop:info")!()).device).toBe(false);
    f.engine.restartService.mockResolvedValue(true);
    await f.main.startDevice({ confirmed: true });
    expect(f.engine.restartService).toHaveBeenCalledTimes(2);
    expect(f.showNotification).toHaveBeenCalledTimes(1);
  });

  it("keeps running processes and services disconnected until the hub confirms them", async () => {
    const f = fixture();
    f.main.init();
    await f.main.startDevice({ confirmed: true, quiet: true });
    f.main.service();
    expect((await f.handlers.get("desktop:info")!()).device).toBe(false);
    f.engine.deviceConnected.mockResolvedValue(true);
    // Clear the restart failure by successfully starting the service.
    f.engine.restartService.mockResolvedValue(true);
    await f.main.startDevice({ confirmed: true, quiet: true });
    expect((await f.handlers.get("desktop:info")!()).device).toBe(true);
    expect(f.main.deviceLine()).toContain("connected (as a service)");
    f.engine.deviceConnected.mockResolvedValue(false);
    expect((await f.handlers.get("desktop:info")!()).device).toBe(false);
  });

  it("shows a retryable registration timeout without reporting success", async () => {
    const f = fixture();
    f.main.init();
    f.fetch.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    await f.main.startDevice({ confirmed: true });
    expect(f.main.deviceLine()).toMatch(/timed out.*Try connecting again/);
    expect(f.showNotification).not.toHaveBeenCalled();
  });

  it.each(["app", "service"])("reports a connected %s device after sign-out only with local evidence", async (by) => {
    const f = fixture();
    f.main.init();
    f.engine.restartService.mockResolvedValue(true);
    if (by === "app") f.engine.serviceRunning.mockResolvedValue(false);
    await f.main.startDevice({ confirmed: true });
    f.executeJavaScript.mockResolvedValue(null);
    f.engine.deviceLogConnected.mockReturnValue(true);
    expect(await f.main.readDeviceStatus()).toBe(true);
    expect(f.main.deviceLine()).toBe("This computer: connected, sign in to manage");
    expect(f.engine.deviceConnected).not.toHaveBeenCalled();
    expect(f.engine.deviceLogConnected).toHaveBeenCalledWith("https://hub", by === "service" ? undefined : "/desktop-test/device.log");
    f.engine.deviceLogConnected.mockReturnValue(false);
    expect(await f.main.readDeviceStatus()).toBe(false);
    expect(f.main.deviceLine()).toBe("This computer: connecting…");
    f.executeJavaScript.mockResolvedValue("session-token");
    f.engine.deviceConnected.mockResolvedValue(true);
    expect(await f.main.readDeviceStatus()).toBe(true);
    expect(f.main.deviceLine()).toBe(by === "service" ? "This computer: connected (as a service)" : "This computer: connected");
    f.executeJavaScript.mockResolvedValue(null);
    f.engine.deviceLogConnected.mockReturnValue(true);
    f.engine.serviceRunning.mockResolvedValue(false);
    f.main.device.running.mockReturnValue(false);
    expect(await f.main.readDeviceStatus()).toBe(false);
  });

  it("keeps the Inbox shortcut pointed at its existing route", () => {
    const f = fixture();
    const item = f.main.appMenu().find((i: any) => i.label === "Go").submenu[0];
    expect(item).toMatchObject({ label: "Inbox", accelerator: "CmdOrCtrl+1" });
    f.main.init();
    item.click();
    expect(f.executeJavaScript).toHaveBeenCalledWith('location.hash = "#/dashboard"');
  });

  it("restores the pending cloud card at startup without exposing the saved key", () => {
    const f = fixture(true);
    f.ready();
    expect(f.loadFile).toHaveBeenCalledWith(expect.anything(), { query: { state: JSON.stringify({ step: "cloud", server: f.server }) } });
    expect(JSON.stringify(f.loadFile.mock.calls)).not.toContain("secret-key");
  });
});


describe("pending cloud server dismissal", () => {
  const remote = { mode: "remote", hubUrl: "https://hub", device: false };

  it("keeps the server and setup key after Keep it, returns to the saved hub, and restores access in the tray", async () => {
    const f = fixture(true, remote);
    f.ready();
    await f.handlers.get("setup:cloud-keep")!(f.setupEvent());
    expect(f.main.config.cloudPending).toMatchObject({ dismissed: true, key: "secret-key", server: f.server });
    expect(f.windows[0].loadURL).toHaveBeenCalledWith("https://hub/");
    const relaunched = fixture(false, f.savedConfig());
    relaunched.ready();
    await vi.waitFor(() => expect(relaunched.windows[0].loadURL).toHaveBeenCalledWith("https://hub/"));
    expect(relaunched.loadFile).not.toHaveBeenCalled();
    const entry = relaunched.main.trayMenu().find((i: any) => i.label === "Unfinished Cloud Server…");
    entry.click();
    expect(relaunched.loadFile).toHaveBeenCalledWith(expect.anything(), { query: { state: JSON.stringify({ step: "cloud", server: f.server }) } });
    expect(JSON.stringify(relaunched.loadFile.mock.calls)).not.toContain("secret-key");
  });

  it("persists window dismissal and opens the saved hub on reactivation", async () => {
    const f = fixture(true, remote);
    f.ready();
    f.windows[0].emit("close", { preventDefault: vi.fn() });
    expect(f.savedConfig().cloudPending).toMatchObject({ dismissed: true, key: "secret-key" });
    expect(f.windows[0].hide).toHaveBeenCalled();
    f.app.emit("activate");
    await vi.waitFor(() => expect(f.windows[0].loadURL).toHaveBeenCalledWith("https://hub/"));
  });

  it("still lets the person delete a kept server from the reopened card", async () => {
    const f = fixture(true, remote);
    f.ready();
    await f.handlers.get("setup:cloud-keep")!(f.setupEvent());
    f.main.showPendingCloud();
    expect(await f.handlers.get("setup:cloud-delete")!(f.setupEvent(), "token", 42)).toEqual({ ok: true });
    expect(f.cloud.deleteServer).toHaveBeenCalledWith("token", 42);
    expect(f.main.config.cloudPending).toBeUndefined();
    expect(f.main.trayMenu().some((i: any) => i.label === "Unfinished Cloud Server…")).toBe(false);
  });

  it("does not let a hub page dismiss the pending server", async () => {
    const f = fixture(true, remote);
    f.main.init();
    const window = f.windows[0];
    expect(await f.handlers.get("setup:cloud-keep")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).toBeNull();
    expect(f.main.config.cloudPending.dismissed).toBeUndefined();
  });

  it("only shows the pending server entry while the record exists", () => {
    const f = fixture();
    expect(f.main.trayMenu().some((i: any) => i.label === "Unfinished Cloud Server…")).toBe(false);
  });
});
