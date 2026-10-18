import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { ComputerAction, ComputerSpec, DeviceCapabilities, DeviceConfig } from "@warren/core";
import { ActionError, exec, has, perform, type Driver } from "./driver.ts";
import { DockerVm, ENGINE_LABEL, detectEngine, ensureImage, imageExists, recipeTag, LOCAL_IMAGE, type Engine } from "./docker.ts";
import { MacDesktop } from "./macos.ts";
import { WindowsDesktop } from "./windows.ts";
import { X11Driver } from "./x11.ts";
import { localClipboard, localFiles } from "./transfer.ts";

export { DockerVm, detectEngine } from "./docker.ts";
export { perform, jpegSize, type Driver } from "./driver.ts";

/** A box for live view: sharper than what agents get, still light enough to stream. */
const LIVE_BOX = { width: 1600, height: 1000 };

export interface HostOptions {
  /** the node's state folder (VM shared folders live under it) */
  dir: string;
  /** "container" (Apple), "docker" or "podman"; default: whichever is installed and running */
  vmEngine?: string;
  /** let shell commands from Warren run on this device's own screen computer */
  allowDeviceShell?: boolean;
  log?: (m: string) => void;
  /** a VM here is starting (saying what it's doing), came up, or couldn't, whatever started it */
  onVmStatus?: (computerId: string, status: "starting" | "ready" | "error", text: string) => void;
}

export interface Tunnel {
  write(data: Uint8Array): void;
  close(): void;
}

/**
 * Runs the computers this device offers: its own screen, and the VMs it hosts. Drivers are
 * created on first use and kept, so a VM's state (and a screen's cached size) carries over.
 */
export class ComputerHost {
  private drivers = new Map<string, Driver>();
  private engine: Promise<{ engine: Engine | null; detail: string }> | null = null;
  private watches = new Map<string, { stop: () => void }>();
  /** getting the VM image ready ahead of the first VM, so it starts in seconds */
  private preparing: Promise<void> | null = null;
  private imageState: { state: "ready" | "preparing" | "missing" | "failed"; detail: string } | null = null;

  constructor(private opts: HostOptions) {}

  private detect() {
    this.engine ??= detectEngine(this.opts.vmEngine).then((r) => {
      // look again next time if nothing was ready (someone may be installing one right now)
      if (!r.engine) this.engine = null;
      return r;
    });
    return this.engine;
  }

  private async vmEngine(): Promise<Engine | null> {
    return (await this.detect()).engine;
  }

  /** What this device can offer. Cheap enough to run at every connect. */
  async capabilities(): Promise<DeviceCapabilities> {
    const { engine, detail } = await this.detect();
    let vm: DeviceCapabilities["vm"] = { ok: false, detail };
    if (engine) {
      if (!this.imageState || this.imageState.state === "missing") this.imageState = (await imageExists(engine, `${LOCAL_IMAGE}:${recipeTag()}`)) ? { state: "ready", detail: "" } : { state: "missing", detail: "" };
      const image = this.imageState;
      vm = {
        ok: true,
        engine: ENGINE_LABEL[engine.kind],
        image: image.state,
        detail: image.state === "ready" ? `${ENGINE_LABEL[engine.kind]} is running and the VM image is ready` : image.state === "preparing" ? image.detail || "Getting the VM image ready…" : image.state === "failed" ? `Couldn't get the VM image ready: ${image.detail}` : `${ENGINE_LABEL[engine.kind]} is running; the first VM gets its image (a few minutes)`,
      };
    }
    return { platform: process.platform, arch: process.arch, screen: await screenSupport(), vm };
  }

  /**
   * Get the VM image onto this device now, so the first VM doesn't wait for it. `onChange` hears
   * each step (to tell the hub). Does nothing without an engine or once the image is here.
   */
  prepareImage(onChange: () => void = () => {}): Promise<void> {
    this.preparing ??= (async () => {
      const engine = await this.vmEngine();
      if (!engine) return;
      if (await imageExists(engine, `${LOCAL_IMAGE}:${recipeTag()}`)) {
        this.imageState = { state: "ready", detail: "" };
        return;
      }
      this.imageState = { state: "preparing", detail: "" };
      onChange();
      try {
        await ensureImage(engine, (text) => {
          this.imageState = { state: "preparing", detail: text };
          onChange();
        });
        this.imageState = { state: "ready", detail: "" };
      } catch (err) {
        this.imageState = { state: "failed", detail: (err as Error).message.slice(0, 300) };
      }
      onChange();
    })().finally(() => (this.preparing = null));
    return this.preparing;
  }

  async driver(spec: ComputerSpec): Promise<Driver> {
    const known = this.drivers.get(spec.id);
    if (known) return known;
    let d: Driver;
    if (spec.kind === "vm") {
      const engine = await this.engineFor(spec);
      if (!engine) throw new Error("this device can't run VMs yet: run `warren setup`, then restart `warren node`");
      d = new DockerVm(spec, this.opts.dir, engine, (status, text) => this.opts.onVmStatus?.(spec.id, status, text));
    } else {
      d = desktopDriver(this.opts.allowDeviceShell);
      const vncPort = (spec.config as DeviceConfig).vncPort;
      if (vncPort) d.vnc = () => connect(vncPort);
    }
    this.drivers.set(spec.id, d);
    return d;
  }

  /**
   * The engine a VM lives in: the one it was made with (so a device with both Docker and Apple's
   * container keeps each VM where it is), else the one this device uses now, remembered from then on.
   */
  private async engineFor(spec: ComputerSpec): Promise<Engine | null> {
    const file = path.join(this.opts.dir, "computers", spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-"), "engine.json");
    let saved: Engine | null = null;
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8")) as Engine;
    } catch {}
    if (saved?.bin) {
      if ((await detectEngine(saved.bin)).engine?.bin === saved.bin) return saved;
      throw new ActionError(`${spec.name} lives in ${ENGINE_LABEL[saved.kind] ?? saved.bin}, which isn't running on this device right now. Start it, then try again.`);
    }
    const engine = await this.vmEngine();
    if (engine) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(engine));
    }
    return engine;
  }

  /** The VM behind a spec, when this device runs it in a container. */
  async vm(spec: ComputerSpec): Promise<DockerVm | null> {
    if (spec.kind !== "vm") return null;
    const d = await this.driver(spec);
    return d instanceof DockerVm ? d : null;
  }

  /** The shared folder of a VM this device hosts (the agents' working folder), creating it if needed. */
  vmFiles(spec: ComputerSpec): string | null {
    if (spec.kind !== "vm") return null;
    const d = this.drivers.get(spec.id);
    if (d instanceof DockerVm) return d.filesDir;
    return new DockerVm(spec, this.opts.dir, { bin: "docker", kind: "docker" }).filesDir;
  }

  async act(spec: ComputerSpec, action: ComputerAction): Promise<unknown> {
    const d = await this.driver(spec);
    const result = await perform(d, action);
    if (action.action === "destroy") {
      this.unwatch(spec.id);
      this.drivers.delete(spec.id);
    }
    return result;
  }

  /** Stream the screen at `fps` until stopped; unchanged frames are skipped (with a keepalive every 5s). */
  watch(spec: ComputerSpec, fps: number, onFrame: (f: { image: string; width: number; height: number }) => void, onError: (msg: string) => void) {
    this.unwatch(spec.id);
    let stopped = false;
    let lastHash = "";
    let lastSent = 0;
    const loop = async () => {
      while (!stopped) {
        const started = Date.now();
        try {
          const d = await this.driver(spec);
          const shot = await d.screenshot(LIVE_BOX);
          const hash = crypto.createHash("sha1").update(shot.jpeg).digest("hex");
          if (hash !== lastHash || Date.now() - lastSent > 5000) {
            lastHash = hash;
            lastSent = Date.now();
            onFrame({ image: shot.jpeg.toString("base64"), width: shot.width, height: shot.height });
          }
        } catch (err) {
          onError((err as Error).message);
          await new Promise((r) => setTimeout(r, 3000));
        }
        await new Promise((r) => setTimeout(r, Math.max(50, 1000 / fps - (Date.now() - started))));
      }
    };
    void loop();
    this.watches.set(spec.id, { stop: () => (stopped = true) });
  }

  unwatch(computerId: string) {
    this.watches.get(computerId)?.stop();
    this.watches.delete(computerId);
  }

  /** Connect to the computer's VNC server and relay bytes both ways. */
  async tunnel(spec: ComputerSpec, onData: (b: Buffer) => void, onClose: (err?: string) => void): Promise<Tunnel> {
    const d = await this.driver(spec);
    if (!d.vnc) throw new Error("this computer has no VNC server; live view uses screenshots");
    const stream = await d.vnc();
    let done = false;
    const finish = (err?: string) => {
      if (done) return;
      done = true;
      onClose(err);
    };
    stream.on("data", onData);
    stream.on("close", () => finish());
    stream.on("error", (e) => finish(e.message));
    return { write: (b) => stream.write(b), close: () => stream.destroy() };
  }

  stopAll() {
    for (const id of [...this.watches.keys()]) this.unwatch(id);
  }
}

function connect(port: number): Promise<Duplex> {
  const sock = net.connect(port, "127.0.0.1");
  return new Promise((resolve, reject) => {
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

/** The driver for this device's own screen. */
function desktopDriver(allowShell?: boolean): Driver {
  let d: Driver;
  if (process.platform === "darwin") d = new MacDesktop();
  else if (process.platform === "win32") d = new WindowsDesktop();
  else {
    const env = { DISPLAY: process.env.DISPLAY ?? ":0" };
    d = new X11Driver("this computer", (argv, opts) => exec(argv[0], argv.slice(1), { ...opts, env }));
  }
  // its owner moves files and clipboard text between here and the device they're on
  d.clipboard = localClipboard();
  d.files = localFiles();
  if (allowShell) {
    d.run = async (command, timeoutSec) => {
      const shell = process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-Command", command]] : [process.env.SHELL || "/bin/sh", ["-lc", command]];
      const r = await exec(shell[0] as string, shell[1] as string[], { timeoutMs: timeoutSec * 1000, cwd: os.homedir() });
      return { exitCode: r.code, output: (r.stdout.toString() + (r.stderr ? `\n${r.stderr}` : "")).trim().slice(-50_000) };
    };
  }
  return d;
}

/**
 * macOS grants screen and input access to the app that started `warren node`: the terminal when
 * it runs in one, or the Node binary itself when launchd starts it. Node's real path changes when
 * Node is upgraded, and the permission has to be given again then.
 */
function macPermissionTarget(): string {
  if (process.versions.electron) return "Warren (the desktop app runs this device)";
  const node = fs.realpathSync(process.execPath);
  const term = process.env.TERM_PROGRAM;
  const app = term === "Apple_Terminal" ? "Terminal" : term === "iTerm.app" ? "iTerm" : term === "vscode" ? "your editor (VS Code, Cursor…)" : term ?? "your terminal app";
  return `${app} if you run \`warren node\` there, or to ${node} (add it with + and ⌘⇧G) if it runs in the background as a LaunchAgent`;
}

/** Can agents use this device's own screen, and if not, why. */
async function screenSupport(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === "darwin") {
    const trusted = await exec("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'], { timeoutMs: 10_000 }).catch(() => null);
    const ok = trusted?.stdout.toString().trim() === "true";
    return ok
      ? { ok: true, detail: "macOS desktop (needs Screen Recording permission too)" }
      : { ok: true, detail: `macOS desktop. In System Settings → Privacy & Security, give Accessibility and Screen Recording permission to ${macPermissionTarget()}.` };
  }
  if (process.platform === "win32") return { ok: true, detail: "Windows desktop" };
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { ok: false, detail: "No display here (a server without a desktop). Use a VM on this device instead." };
  if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return { ok: false, detail: "Wayland isn't supported yet; log in with an X11 session, or use a VM." };
  const missing = [];
  if (!(await has("xdotool"))) missing.push("xdotool");
  if (!(await has("import"))) missing.push("imagemagick");
  return missing.length ? { ok: false, detail: `Install ${missing.join(" and ")} to let agents use this screen.` } : { ok: true, detail: "Linux desktop (X11)" };
}
