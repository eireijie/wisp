import crypto from "node:crypto";
import net from "node:net";
import type { Duplex } from "node:stream";
import os from "node:os";
import type { ComputerAction, ComputerSpec, DeviceCapabilities, DeviceConfig } from "@warren/core";
import { exec, has, perform, type Driver } from "./driver.ts";
import { DockerVm, containerEngine } from "./docker.ts";
import { MacDesktop } from "./macos.ts";
import { WindowsDesktop } from "./windows.ts";
import { X11Driver } from "./x11.ts";

export { DockerVm } from "./docker.ts";
export { perform, jpegSize, type Driver } from "./driver.ts";

/** A box for live view: sharper than what agents get, still light enough to stream. */
const LIVE_BOX = { width: 1600, height: 1000 };

export interface HostOptions {
  /** the node's state folder (VM shared folders live under it) */
  dir: string;
  /** "docker" or "podman"; default: whichever is installed */
  vmEngine?: string;
  /** let shell commands from Warren run on this device's own screen computer */
  allowDeviceShell?: boolean;
  log?: (m: string) => void;
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
  private engine: Promise<string | null> | null = null;
  private watches = new Map<string, { stop: () => void }>();

  constructor(private opts: HostOptions) {}

  private vmEngine() {
    this.engine ??= containerEngine(this.opts.vmEngine);
    return this.engine;
  }

  /** What this device can offer. Cheap enough to run at every connect. */
  async capabilities(): Promise<DeviceCapabilities> {
    const engine = await this.vmEngine();
    return {
      platform: process.platform,
      arch: process.arch,
      screen: await screenSupport(),
      vm: engine ? { ok: true, detail: `${engine} is running` } : { ok: false, detail: "Install Docker (Docker Desktop, OrbStack, Colima or Docker Engine) or Podman to run VMs on this device." },
    };
  }

  async driver(spec: ComputerSpec, onStatus?: (text: string) => void): Promise<Driver> {
    const known = this.drivers.get(spec.id);
    if (known) return known;
    let d: Driver;
    if (spec.kind === "vm") {
      const engine = await this.vmEngine();
      if (!engine) throw new Error("this device can't run VMs: install Docker or Podman, then restart `warren node`");
      d = new DockerVm(spec, this.opts.dir, engine, onStatus);
    } else {
      d = desktopDriver(this.opts.allowDeviceShell);
      const vncPort = (spec.config as DeviceConfig).vncPort;
      if (vncPort) d.vnc = () => connect(vncPort);
    }
    this.drivers.set(spec.id, d);
    return d;
  }

  /** The shared folder of a VM this device hosts (the agents' working folder), creating it if needed. */
  vmFiles(spec: ComputerSpec): string | null {
    if (spec.kind !== "vm") return null;
    const d = this.drivers.get(spec.id);
    if (d instanceof DockerVm) return d.filesDir;
    return new DockerVm(spec, this.opts.dir, "docker").filesDir;
  }

  async act(spec: ComputerSpec, action: ComputerAction, onStatus?: (text: string) => void): Promise<unknown> {
    const d = await this.driver(spec, onStatus);
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
  if (allowShell) {
    d.run = async (command, timeoutSec) => {
      const shell = process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-Command", command]] : [process.env.SHELL || "/bin/sh", ["-lc", command]];
      const r = await exec(shell[0] as string, shell[1] as string[], { timeoutMs: timeoutSec * 1000, cwd: os.homedir() });
      return { exitCode: r.code, output: (r.stdout.toString() + (r.stderr ? `\n${r.stderr}` : "")).trim().slice(-50_000) };
    };
  }
  return d;
}

/** Can agents use this device's own screen, and if not, why. */
async function screenSupport(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === "darwin") {
    const trusted = await exec("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'], { timeoutMs: 10_000 }).catch(() => null);
    const ok = trusted?.stdout.toString().trim() === "true";
    return ok
      ? { ok: true, detail: "macOS desktop (needs Screen Recording permission too)" }
      : { ok: true, detail: "macOS desktop. Give the app that runs `warren node` Accessibility and Screen Recording permission in System Settings → Privacy & Security." };
  }
  if (process.platform === "win32") return { ok: true, detail: "Windows desktop" };
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { ok: false, detail: "No display here (a server without a desktop). Use a VM on this device instead." };
  if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return { ok: false, detail: "Wayland isn't supported yet; log in with an X11 session, or use a VM." };
  const missing = [];
  if (!(await has("xdotool"))) missing.push("xdotool");
  if (!(await has("import"))) missing.push("imagemagick");
  return missing.length ? { ok: false, detail: `Install ${missing.join(" and ")} to let agents use this screen.` } : { ok: true, detail: "Linux desktop (X11)" };
}
