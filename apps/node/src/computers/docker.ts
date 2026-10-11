import { spawn } from "node:child_process";
import fs from "node:fs";
import { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerSpec, RunOutput, VmConfig } from "@warren/core";
import { ActionError, exec, has, must, type Driver } from "./driver.ts";
import { X11Driver } from "./x11.ts";

/** Bump when docker/computer changes, so devices rebuild the image. */
export const IMAGE = "warren-computer:1";
const IMAGE_DIR = fileURLToPath(new URL("../../../../docker/computer", import.meta.url));
const DISPLAY = ":1";

/** docker, or podman where that's what's installed. */
export async function containerEngine(prefer?: string): Promise<string | null> {
  for (const bin of [prefer, "docker", "podman"].filter(Boolean) as string[]) {
    if (!(await has(bin))) continue;
    const r = await exec(bin, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 }).catch(() => null);
    if (r?.code === 0) return bin;
  }
  return null;
}

/** Arguments that create a VM's container. Exported for tests. */
export function runArgs(spec: ComputerSpec, o: { name: string; volume: string; files: string; image: string }): string[] {
  const cfg = spec.config as VmConfig;
  const resolution = /^\d{3,5}x\d{3,5}$/.test(cfg.resolution ?? "") ? cfg.resolution! : "1280x800";
  const hostname =
    spec.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "warren";
  const args = ["run", "-d", "--name", o.name, "--hostname", hostname, "--label", `warren.computer=${spec.id}`, "--shm-size", "1g", "--restart", "unless-stopped"];
  // no published ports: VNC listens inside the container and the device reaches it with exec
  args.push("-e", `RESOLUTION=${resolution}`, "-v", `${o.volume}:/home/warren`, "-v", `${o.files}:/home/warren/files`);
  if (cfg.cpus && cfg.cpus > 0) args.push("--cpus", String(Math.min(cfg.cpus, 64)));
  if (cfg.memoryGb && cfg.memoryGb > 0) args.push("--memory", `${Math.min(cfg.memoryGb, 256)}g`);
  args.push(o.image);
  return args;
}

/**
 * A Linux desktop in a container: a virtual computer this device runs for its agents. Its
 * home folder lives in a volume, so sign-ins and browser profiles survive restarts, and
 * `files/` is shared with the device (the agents' working folder).
 */
export class DockerVm implements Driver {
  readonly label = "Linux VM";
  private desktop: X11Driver;
  private starting: Promise<void> | null = null;
  readonly name: string;
  readonly volume: string;
  /** shared with the agents that use this computer: their working folder */
  readonly filesDir: string;

  constructor(
    private spec: ComputerSpec,
    nodeDir: string,
    private engine: string,
    private onStatus: (text: string) => void = () => {},
  ) {
    const safe = spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.name = `warren-${safe}`;
    this.volume = `warren-${safe}-home`;
    this.filesDir = path.join(nodeDir, "computers", safe, "files");
    const inVm = (argv: string[], opts: { input?: string; timeoutMs?: number } = {}) => this.ready().then(() => exec(this.engine, ["exec", "-i", "-u", "warren", "-e", `DISPLAY=${DISPLAY}`, this.name, ...argv], opts));
    this.desktop = new X11Driver(this.label, inVm, (command, timeoutSec) => this.shell(command, timeoutSec));
  }

  private image() {
    return (this.spec.config as VmConfig).image || IMAGE;
  }

  private async running(): Promise<boolean | null> {
    const r = await exec(this.engine, ["inspect", "-f", "{{.State.Running}}", this.name], { timeoutMs: 15_000 });
    if (r.code !== 0) return null; // no such container
    return r.stdout.toString().trim() === "true";
  }

  /** Make sure the VM exists and is running, building the image the first time. */
  ready(): Promise<void> {
    this.starting ??= this.boot().finally(() => (this.starting = null));
    return this.starting;
  }

  private async boot() {
    const state = await this.running();
    if (state === true) return;
    if (state === false) {
      this.onStatus("Starting the VM…");
      await must(this.engine, ["start", this.name], { timeoutMs: 60_000 });
    } else {
      const image = this.image();
      if ((await exec(this.engine, ["image", "inspect", image], { timeoutMs: 15_000 })).code !== 0) {
        if (image !== IMAGE) {
          this.onStatus(`Pulling ${image}…`);
          await must(this.engine, ["pull", image], { timeoutMs: 30 * 60_000 });
        } else {
          if (!fs.existsSync(path.join(IMAGE_DIR, "Dockerfile"))) throw new ActionError(`can't find the VM image recipe at ${IMAGE_DIR}`);
          this.onStatus("Building the VM image (first time only, a few minutes)…");
          await must(this.engine, ["build", "-t", IMAGE, IMAGE_DIR], { timeoutMs: 60 * 60_000 });
        }
      }
      fs.mkdirSync(this.filesDir, { recursive: true });
      this.onStatus("Creating the VM…");
      await must(this.engine, runArgs(this.spec, { name: this.name, volume: this.volume, files: this.filesDir, image }), { timeoutMs: 120_000 });
    }
    // wait for the desktop to come up
    for (let i = 0; i < 60; i++) {
      const r = await exec(this.engine, ["exec", "-u", "warren", "-e", `DISPLAY=${DISPLAY}`, this.name, "xdotool", "getdisplaygeometry"], { timeoutMs: 10_000 });
      if (r.code === 0) return;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new ActionError("the VM started but its desktop didn't come up within a minute");
  }

  private async shell(command: string, timeoutSec: number): Promise<RunOutput> {
    await this.ready();
    const r = await exec(this.engine, ["exec", "-i", "-u", "warren", "-w", "/home/warren", "-e", `DISPLAY=${DISPLAY}`, this.name, "bash", "-lc", command], { timeoutMs: timeoutSec * 1000 });
    const output = (r.stdout.toString() + (r.stderr ? `\n${r.stderr}` : "")).trim();
    return { exitCode: r.code, output: output.length > 50_000 ? output.slice(0, 25_000) + "\n…\n" + output.slice(-25_000) : output };
  }

  screenSize = () => this.desktop.screenSize();
  screenshot = (box?: { width: number; height: number }) => this.desktop.screenshot(box);
  move = (x: number, y: number) => this.desktop.move(x, y);
  click = (x: number, y: number, b: "left" | "right" | "middle", n: number) => this.desktop.click(x, y, b, n);
  mouse = (x: number, y: number, b: "left" | "right" | "middle", down: boolean) => this.desktop.mouse(x, y, b, down);
  drag = (x: number, y: number, tx: number, ty: number) => this.desktop.drag(x, y, tx, ty);
  scroll = (x: number, y: number, d: "up" | "down" | "left" | "right", n: number) => this.desktop.scroll(x, y, d, n);
  type = (text: string) => this.desktop.type(text);
  key = (c: Parameters<X11Driver["key"]>[0]) => this.desktop.key(c);
  open = (target: string) => this.desktop.open(target);
  run = (command: string, timeoutSec: number) => this.shell(command, timeoutSec);

  async start() {
    await this.ready();
  }

  async stop() {
    if (await this.running()) await must(this.engine, ["stop", "-t", "10", this.name], { timeoutMs: 60_000 });
  }

  async destroy() {
    await exec(this.engine, ["rm", "-f", this.name], { timeoutMs: 60_000 });
    await exec(this.engine, ["volume", "rm", "-f", this.volume], { timeoutMs: 60_000 });
  }

  async status() {
    const state = await this.running();
    if (this.starting) return { status: "starting" as const, detail: "Starting…" };
    if (state === true) return { status: "ready" as const, detail: "Running" };
    return { status: "stopped" as const, detail: state === null ? "Not created yet; it starts when it's first used" : "Stopped; it starts when it's next used" };
  }

  /** The VM's VNC server, through socat inside it. */
  async vnc(): Promise<Duplex> {
    await this.ready();
    const child = spawn(this.engine, ["exec", "-i", this.name, "socat", "STDIO", "TCP:127.0.0.1:5900"], { stdio: ["pipe", "pipe", "ignore"] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.on("close", () => child.kill());
    child.on("close", () => stream.destroy());
    return stream;
  }
}
