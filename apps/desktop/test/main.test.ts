import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function fixture(pending = false) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let ready: () => void = () => {};
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/desktop-test", getVersion: () => "0.0.1", requestSingleInstanceLock: () => true,
    setAboutPanelOptions: vi.fn(), isReady: () => false, whenReady: () => ({ then: (fn: () => void) => { ready = fn; } }),
  });
  const loadFile = vi.fn();
  const showNotification = vi.fn();
  const showMessageBox = vi.fn();
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => "https://hub/", executeJavaScript: async () => "session-token", setWindowOpenHandler: vi.fn(),
    });
    loadFile = loadFile;
    loadURL = vi.fn();
    isMinimized = () => false;
    show = vi.fn(); focus = vi.fn();
  }
  const cfg: Record<string, any> = { hub: "https://old", token: "old-token", name: "device" };
  const engine = {
    Child: class {
      state = "starting";
      running = () => true;
      stop = vi.fn();
    },
    readNodeConfig: () => ({ ...cfg }),
    writeNodeConfig: (patch: object) => Object.assign(cfg, patch),
    serviceRunning: async () => true,
    restartService: vi.fn().mockResolvedValue(false),
    runtime: () => ({ node: "node", warrenDir: "/runtime" }),
    deviceConnected: vi.fn().mockResolvedValue(false),
  };
  const server = { id: 42, name: "pending", ip: "203.0.113.7", type: "cx23", location: "fsn1" };
  const config = pending ? { cloudPending: { server, key: "secret-key" } } : {};
  const filename = fileURLToPath(new URL("../src/main.cjs", import.meta.url));
  const require = createRequire(filename);
  const module = { exports: {} as any };
  const fetch = vi.fn(async (_url, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return { ok: true, json: async () => ({ token: "new-token", node: { id: "n" } }) };
  });
  const code = readFileSync(filename, "utf8") + `\nmodule.exports = { startDevice, readDeviceStatus, deviceLine,
    init() { win = new BrowserWindow(); hubOrigin = 'https://hub'; config.device = true; },
    service() { deviceBy = 'service'; }, config };`;
  runInNewContext(code, {
    module, __dirname: path.dirname(filename), URL, AbortSignal, fetch,
    process: { ...process, platform: "linux" }, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
    require: (name: string) => {
      if (name === "electron") return { app, BrowserWindow: Window,
        ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), on: vi.fn() },
        dialog: { showMessageBox }, Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
        nativeImage: { createFromPath: () => ({ resize: vi.fn() }) }, Tray: class { on = vi.fn(); },
        Notification: class { static isSupported = () => true; show = showNotification; },
      };
      if (name === "node:fs") return { readFileSync: () => JSON.stringify(config), mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false };
      if (name === "./engine.cjs") return engine;
      if (name === "./buddy.cjs") return () => ({ ready: vi.fn() });
      if (name === "./updater.cjs") return { createUpdater: () => ({ start: vi.fn() }) };
      return require(name);
    },
  });
  return { main: module.exports, engine, handlers, fetch, loadFile, showNotification, showMessageBox, ready: () => ready(), server };
}

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

  it("restores the pending cloud card at startup without exposing the saved key", () => {
    const f = fixture(true);
    f.ready();
    expect(f.loadFile).toHaveBeenCalledWith(expect.anything(), { query: { state: JSON.stringify({ step: "cloud", server: f.server }) } });
    expect(JSON.stringify(f.loadFile.mock.calls)).not.toContain("secret-key");
  });
});
