import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function fixture(config: Record<string, any> = {}, platform = "darwin") {
  const ipc = new EventEmitter() as EventEmitter & { handle: ReturnType<typeof vi.fn> };
  ipc.handle = vi.fn();
  const windows: Window[] = [];
  let cursor = { x: 100, y: 100 };
  class Window extends EventEmitter {
    bounds: any;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "http://hub/#/buddy" }, send: vi.fn(), setWindowOpenHandler: vi.fn() });
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setMenu = vi.fn();
    showInactive = vi.fn();
    destroy = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    constructor(public options: any) { super(); this.bounds = options; windows.push(this); }
    getBounds() { const { x, y, width, height } = this.bounds; return { x, y, width, height }; }
    setBounds(b: any) { this.bounds = b; }
  }
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getCursorScreenPoint: () => cursor,
  });
  const filename = fileURLToPath(new URL("../src/buddy.cjs", import.meta.url));
  const require = createRequire(import.meta.url);
  const module = { exports: null as any };
  runInNewContext(readFileSync(filename, "utf8"), { module, URL, process: { ...process, platform }, __dirname: filename.slice(0, filename.lastIndexOf("/")), setTimeout, clearTimeout, setInterval, clearInterval, require: (name: string) => name === "electron" ? { BrowserWindow: Window, ipcMain: ipc, screen } : require(name) });
  const main = new Window({});
  main.webContents.mainFrame.url = "http://hub/";
  const open = vi.fn();
  const save = vi.fn();
  const buddy = module.exports({ config, save, mainWindow: () => main, open, refresh: vi.fn() });
  buddy.connect("http://hub");
  const send = (window: Window, name: string, ...args: unknown[]) => ipc.emit(`buddy:${name}`, { sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  send(main, "agents", [{ id: "first", name: "First" }, { id: "lead", name: "Lead" }], "lead");
  const win = windows.at(-1)!;
  return { buddy, main, win, windows, send, open, config, ipc, save, screen, move: (x: number, y: number) => { cursor = { x, y }; } };
}

describe("native desk buddy", () => {
  it("creates a transparent floating window and restores an off-screen position safely", () => {
    const f = fixture({ buddyPosition: { x: 9000, y: 9000 } });
    expect(f.win.options).toMatchObject({ frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true, width: 140, height: 160 });
    expect(f.win.getBounds()).toEqual({ x: 1060, y: 640, width: 140, height: 160 });
    expect(f.win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(f.win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    expect(f.win.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(f.win.options.type).toBeUndefined();
    f.buddy.destroy();
  });

  it("expands around the same ghost, saves drag position, and persists agent/off choices", () => {
    const f = fixture();
    const initial = f.win.getBounds();
    f.send(f.win, "expand", true);
    const big = f.win.getBounds();
    expect(big.x + big.width).toBe(initial.x + initial.width);
    expect(big.y + big.height).toBe(initial.y + initial.height);
    f.send(f.win, "drag", "start");
    f.move(80, 70);
    f.send(f.win, "drag", "move");
    f.send(f.win, "drag", "end");
    expect(f.config.buddyPosition).toEqual({ x: initial.x - 20, y: initial.y - 30 });
    f.buddy.menu().submenu[2].click();
    expect(f.config.buddyAgents).toEqual({ "http://hub": "first" });
    f.buddy.menu().submenu[0].click();
    expect(f.config.buddyEnabled).toBe(false);
    expect(f.win.destroy).toHaveBeenCalled();
  });

  it("persists fullscreen visibility and recreates the macOS window with the chosen level and type", () => {
    const f = fixture();
    const toggle = () => f.buddy.menu().submenu.find((i: any) => i.label === "Show over fullscreen apps");
    expect(toggle()).toMatchObject({ type: "checkbox", checked: false });
    toggle().click({ checked: true });
    const panel = f.windows.at(-1)!;
    expect(f.config.buddyOverFullscreen).toBe(true);
    expect(f.save).toHaveBeenCalled();
    expect(f.win.destroy).toHaveBeenCalled();
    expect(panel.options.type).toBe("panel");
    expect(panel.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(panel.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: false });
    expect(toggle().checked).toBe(true);
    toggle().click({ checked: false });
    const normal = f.windows.at(-1)!;
    expect(f.config.buddyOverFullscreen).toBe(false);
    expect(panel.destroy).toHaveBeenCalled();
    expect(normal.options.type).toBeUndefined();
    expect(normal.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(normal.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    f.buddy.destroy();
  });

  it("restores the fullscreen preference on macOS and ignores it on other platforms", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const f = fixture({ buddyOverFullscreen: true }, platform);
      expect(f.win.options.type).toBe(platform === "darwin" ? "panel" : undefined);
      expect(f.buddy.menu().submenu.some((i: any) => i.label === "Show over fullscreen apps")).toBe(platform === "darwin");
      f.buddy.destroy();
    }
  });

  it("keeps an explicitly disabled buddy off when changing the fullscreen preference", () => {
    const f = fixture({ buddyEnabled: false });
    const toggle = f.buddy.menu().submenu.find((i: any) => i.label === "Show over fullscreen apps");
    toggle.click({ checked: true });
    expect(f.windows).toHaveLength(1);
    expect(f.config.buddyEnabled).toBe(false);
    f.buddy.destroy();
  });

  it("only accepts buddy controls from its own main frame and validates navigation", () => {
    const f = fixture();
    f.send(f.main, "open", "#/tasks");
    f.send(f.win, "open", "https://evil.example/");
    f.ipc.emit("buddy:open", { sender: f.win.webContents, senderFrame: { url: "http://hub/" } }, "#/tasks");
    expect(f.open).not.toHaveBeenCalled();
    f.send(f.win, "open", "#/c/chat/t/thread");
    expect(f.open).toHaveBeenCalledWith("#/c/chat/t/thread");
    f.buddy.connect("http://another-hub");
    f.send(f.win, "open", "#/tasks");
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.win.destroy).toHaveBeenCalled();
  });
});
