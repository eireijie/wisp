import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerSpec, PageElement, RunOutput, VmConfig } from "@warren/core";
import { ActionError, exec, has, must, type Driver } from "./driver.ts";
import { X11Driver } from "./x11.ts";

const IMAGE_DIR = fileURLToPath(new URL("../../../../docker/computer", import.meta.url));
const DISPLAY = ":1";
/** The VM's home folder and the folder it shares with the device. */
export const VM_HOME = "/home/warren";
export const VM_FILES = "/home/warren/files";

/** Which file says a harness is signed in, inside a VM. */
const SIGNED_IN: Record<string, string> = {
  "claude-code": "test -s ~/.claude/.credentials.json || test -s ~/.claude/.credentials",
  codex: "test -s ~/.codex/auth.json",
};

/**
 * Runs in the VM's Node: asks each page of the visible Chrome (over its debugging port) what
 * element is under a screen point. The page part maps screen to page coordinates from the window's
 * position and its frame, then names the element the way a person would point at it.
 */
const INSPECT_SCRIPT = String.raw`
const [X, Y] = process.argv.slice(1).map(Number);
const inPage = (X, Y) => {
  if (document.visibilityState !== "visible") return null;
  const side = (outerWidth - innerWidth) / 2;
  const top = outerHeight - innerHeight - side;
  const x = X - screenX - side, y = Y - screenY - top;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const t = hit.closest("a,button,input,select,textarea,label,summary,[role],[contenteditable]") || hit;
  const tag = t.tagName.toLowerCase();
  const type = (t.getAttribute("type") || "").toLowerCase();
  const role = t.getAttribute("role") || { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button", label: "label" }[tag] || (tag === "input" ? (["checkbox", "radio"].includes(type) ? type : ["submit", "button"].includes(type) ? "button" : "textbox") : tag);
  const by = t.getAttribute("aria-labelledby");
  const name = (t.getAttribute("aria-label") || (by && document.getElementById(by)?.innerText) || (t.labels && t.labels[0]?.innerText) || t.innerText || t.value || t.getAttribute("placeholder") || t.getAttribute("title") || t.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 100);
  const attr = (n) => t.getAttribute(n);
  const selector = t.id ? "#" + CSS.escape(t.id) : attr("name") ? tag + '[name="' + attr("name") + '"]' : attr("data-testid") ? '[data-testid="' + attr("data-testid") + '"]' : undefined;
  return { url: location.href, title: document.title, role, name, selector };
};
const ask = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const done = (v) => { try { ws.close(); } catch {} resolve(v); };
  setTimeout(() => done(null), 3000);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "(" + inPage + ")(" + X + "," + Y + ")", returnByValue: true } }));
  ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.id === 1) done(r.result?.result?.value ?? null); };
  ws.onerror = () => done(null);
});
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json(), () => []);
for (const p of pages.filter((p) => p.type === "page" && p.webSocketDebuggerUrl)) {
  const found = await ask(p.webSocketDebuggerUrl);
  if (found) { console.log(JSON.stringify(found)); process.exit(0); }
}
console.log("null");
`;

/** How a person signs a harness in, in a terminal on the VM's screen. */
export const SIGN_IN_COMMAND: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex login",
};

/**
 * What runs the VMs: Docker (Docker Desktop, OrbStack, Colima, Docker Engine), Podman, or Apple's
 * `container` on a Mac (each container in its own small VM). Their command lines differ a little.
 */
export type EngineKind = "docker" | "podman" | "apple";

export interface Engine {
  bin: string;
  kind: EngineKind;
}

export const ENGINE_LABEL: Record<EngineKind, string> = { docker: "Docker", podman: "Podman", apple: "Apple's container" };

function kindOf(bin: string): EngineKind {
  const base = path.basename(bin);
  return base === "container" ? "apple" : base.includes("podman") ? "podman" : "docker";
}

/**
 * The VM engine on this device: the one in node.json if set, else Apple's container on a Mac,
 * then Docker, then Podman. `detail` says what's missing when none is ready.
 */
export async function detectEngine(prefer?: string): Promise<{ engine: Engine | null; detail: string }> {
  const order = [prefer, process.platform === "darwin" ? "container" : null, "docker", "podman"].filter((b, i, all): b is string => !!b && all.indexOf(b) === i);
  const stopped: string[] = [];
  for (const bin of order) {
    if (!(await has(bin))) continue;
    const kind = kindOf(bin);
    if (kind === "apple") {
      const r = await exec(bin, ["system", "status"], { timeoutMs: 15_000 }).catch(() => null);
      if (r?.code === 0 && /running/i.test(r.stdout.toString())) return { engine: { bin, kind }, detail: `${ENGINE_LABEL[kind]} is running` };
      stopped.push("Apple's container is installed but not running: run `container system start`");
      continue;
    }
    const r = await exec(bin, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 }).catch(() => null);
    if (r?.code === 0) return { engine: { bin, kind }, detail: `${ENGINE_LABEL[kind]} is running` };
    stopped.push(kind === "podman" ? "Podman is installed but not running: run `podman machine start`" : "Docker is installed but not running: start Docker Desktop, OrbStack or Colima");
  }
  if (stopped.length) return { engine: null, detail: `${stopped[0]}.` };
  const how =
    process.platform === "darwin"
      ? "Run `warren setup` to install Apple's container (free, from Apple), or install OrbStack or Docker Desktop"
      : process.platform === "win32"
        ? "Install Docker Desktop (it uses WSL 2)"
        : "Run `warren setup`, or install Docker Engine or Podman";
  return { engine: null, detail: `This device can't run VMs yet. ${how}.` };
}

/**
 * The VM image for this copy of Warren: named after a hash of its recipe (docker/computer), so a
 * changed recipe means a new image, and a published image is only used when it's built from the
 * same recipe.
 */
export function recipeTag(dir = IMAGE_DIR): string {
  // every file under the recipe, in path order (the same as `find … | LC_ALL=C sort` in CI)
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest("hex").slice(0, 12);
}

export const LOCAL_IMAGE = "warren-computer";

/** Where this copy of Warren's VM images are published: ghcr.io/<owner>/warren-computer for a GitHub checkout. */
export function publishedImage(repoDir = path.resolve(IMAGE_DIR, "../..")): string | null {
  try {
    const head = fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");
    const url = head.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? "";
    const owner = url.match(/github\.com[:/]([A-Za-z0-9-]+)\//)?.[1];
    return owner ? `ghcr.io/${owner.toLowerCase()}/warren-computer` : null;
  } catch {
    return null;
  }
}

const relays = new Map<string, Promise<number>>();

/**
 * A relay from the address VMs reach this device at to a port on its loopback: a hub listening only
 * on localhost here is then still reachable from inside the VMs (and only from their network).
 */
function relay(bindHost: string, port: number): Promise<number> {
  const key = `${bindHost}->${port}`;
  let p = relays.get(key);
  if (!p) {
    p = new Promise<number>((resolve, reject) => {
      const server = net.createServer((client) => {
        const upstream = net.connect(port, "127.0.0.1");
        client.pipe(upstream).pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
      });
      server.once("error", reject);
      server.listen(0, bindHost, () => resolve((server.address() as net.AddressInfo).port));
      server.unref();
    });
    p.catch(() => relays.delete(key));
    relays.set(key, p);
  }
  return p;
}

/** Arguments that create a VM's container. Exported for tests. */
export function runArgs(spec: ComputerSpec, o: { name: string; volume: string; files: string; image: string; kind?: EngineKind }): string[] {
  const cfg = spec.config as VmConfig;
  const kind = o.kind ?? "docker";
  const resolution = /^\d{3,5}x\d{3,5}$/.test(cfg.resolution ?? "") ? cfg.resolution! : "1280x800";
  const hostname =
    spec.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "warren";
  const args = ["run", "-d", "--name", o.name, "--label", `warren.computer=${spec.id}`, "--shm-size", "1g"];
  // Apple's container has no hostname or restart policy; Warren starts a stopped VM when it's next used
  if (kind !== "apple") args.push("--hostname", hostname, "--restart", "unless-stopped");
  // the hub, when it runs on this same device (Docker Engine on Linux needs to be told the name)
  if (kind === "docker") args.push("--add-host", "host.docker.internal:host-gateway");
  // no published ports: VNC listens inside the container and the device reaches it with exec
  args.push("-e", `RESOLUTION=${resolution}`, "-v", `${o.volume}:/home/warren`, "-v", `${o.files}:/home/warren/files`);
  if (cfg.cpus && cfg.cpus > 0) args.push("--cpus", String(Math.min(Math.ceil(cfg.cpus), 64)));
  if (cfg.memoryGb && cfg.memoryGb > 0) args.push("--memory", `${Math.min(cfg.memoryGb, 256)}g`);
  args.push(o.image);
  return args;
}

/**
 * Make sure the VM image is on this device: the published one built from the same recipe if
 * there is one, otherwise built here from docker/computer (a few minutes, once).
 */
export async function ensureImage(engine: Engine, onStatus: (text: string) => void = () => {}): Promise<string> {
  const tag = recipeTag();
  const local = `${LOCAL_IMAGE}:${tag}`;
  if (await imageExists(engine, local)) return local;
  const published = publishedImage();
  if (published) {
    onStatus("Downloading the VM image (first time only)…");
    const remote = `${published}:${tag}`;
    const pulled = await exec(engine.bin, engine.kind === "apple" ? ["image", "pull", remote] : ["pull", remote], { timeoutMs: 30 * 60_000 });
    if (pulled.code === 0 && (await exec(engine.bin, engine.kind === "apple" ? ["image", "tag", remote, local] : ["tag", remote, local], { timeoutMs: 60_000 })).code === 0) return local;
  }
  if (!fs.existsSync(path.join(IMAGE_DIR, "Dockerfile"))) throw new ActionError(`can't find the VM image recipe at ${IMAGE_DIR}`);
  onStatus("Building the VM image (first time only, a few minutes)…");
  await must(engine.bin, ["build", "-t", local, IMAGE_DIR], { timeoutMs: 60 * 60_000 });
  return local;
}

export async function imageExists(engine: Engine, image: string): Promise<boolean> {
  const r = await exec(engine.bin, ["image", "inspect", image], { timeoutMs: 15_000 }).catch(() => null);
  return r?.code === 0;
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
    readonly engine: Engine,
    private onStatus: (text: string) => void = () => {},
  ) {
    const safe = spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.name = `warren-${safe}`;
    this.volume = `warren-${safe}-home`;
    this.filesDir = path.join(nodeDir, "computers", safe, "files");
    const inVm = (argv: string[], opts: { input?: string; timeoutMs?: number } = {}) => this.ready().then(() => exec(this.engine.bin, ["exec", "-i", "-u", "warren", "-e", `DISPLAY=${DISPLAY}`, this.name, ...argv], opts));
    this.desktop = new X11Driver(this.label, inVm, (command, timeoutSec) => this.shell(command, timeoutSec));
  }

  private get bin() {
    return this.engine.bin;
  }

  /** true, false (stopped), or null when there's no such container. */
  private async running(): Promise<boolean | null> {
    if (this.engine.kind === "apple") {
      const info = await this.appleInfo();
      if (!info) return null;
      // { status: { state: "running", networks: [...] } } (older versions: status: "running")
      return (typeof info.status === "string" ? info.status : info.status?.state) === "running";
    }
    const r = await exec(this.bin, ["inspect", "-f", "{{.State.Running}}", this.name], { timeoutMs: 15_000 });
    if (r.code !== 0) return null; // no such container
    return r.stdout.toString().trim() === "true";
  }

  private async appleInfo(): Promise<{ status?: string | { state?: string; networks?: { ipv4Gateway?: string }[] } } | null> {
    const r = await exec(this.bin, ["inspect", this.name], { timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout.toString()) as object[])[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Make sure the VM exists and is running, getting the image the first time. */
  ready(): Promise<void> {
    this.starting ??= this.boot().finally(() => (this.starting = null));
    return this.starting;
  }

  private async boot() {
    const state = await this.running();
    if (state === true) return;
    if (state === false) {
      this.onStatus("Starting the VM…");
      await must(this.bin, ["start", this.name], { timeoutMs: 120_000 });
    } else {
      const custom = (this.spec.config as VmConfig).image;
      let image: string;
      if (custom) {
        image = custom;
        if (!(await imageExists(this.engine, image))) {
          this.onStatus(`Pulling ${image}…`);
          await must(this.bin, this.engine.kind === "apple" ? ["image", "pull", image] : ["pull", image], { timeoutMs: 30 * 60_000 });
        }
      } else image = await ensureImage(this.engine, this.onStatus);
      fs.mkdirSync(this.filesDir, { recursive: true });
      if (this.engine.kind === "apple" && (await exec(this.bin, ["volume", "inspect", this.volume], { timeoutMs: 15_000 })).code !== 0) {
        await must(this.bin, ["volume", "create", this.volume], { timeoutMs: 60_000 });
      }
      this.onStatus("Creating the VM…");
      await must(this.bin, runArgs(this.spec, { name: this.name, volume: this.volume, files: this.filesDir, image, kind: this.engine.kind }), { timeoutMs: 300_000 });
    }
    // wait for the desktop to come up
    for (let i = 0; i < 90; i++) {
      const r = await exec(this.bin, ["exec", "-u", "warren", "-e", `DISPLAY=${DISPLAY}`, this.name, "xdotool", "getdisplaygeometry"], { timeoutMs: 10_000 });
      if (r.code === 0) return;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new ActionError("the VM started but its desktop didn't come up within a minute and a half");
  }

  private async shell(command: string, timeoutSec: number): Promise<RunOutput> {
    await this.ready();
    const r = await exec(this.bin, ["exec", "-i", "-u", "warren", "-w", "/home/warren", "-e", `DISPLAY=${DISPLAY}`, this.name, "bash", "-lc", command], { timeoutMs: timeoutSec * 1000 });
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
    if (await this.running()) await must(this.bin, this.engine.kind === "apple" ? ["stop", "--time", "10", this.name] : ["stop", "-t", "10", this.name], { timeoutMs: 60_000 });
  }

  async destroy() {
    if (this.engine.kind === "apple") {
      await exec(this.bin, ["delete", "--force", this.name], { timeoutMs: 60_000 });
      await exec(this.bin, ["volume", "delete", this.volume], { timeoutMs: 60_000 });
      return;
    }
    await exec(this.bin, ["rm", "-f", this.name], { timeoutMs: 60_000 });
    await exec(this.bin, ["volume", "rm", "-f", this.volume], { timeoutMs: 60_000 });
  }

  async status() {
    const state = await this.running();
    if (this.starting) return { status: "starting" as const, detail: "Starting…" };
    if (state === true) return { status: "ready" as const, detail: "Running" };
    return { status: "stopped" as const, detail: state === null ? "Not created yet; it starts when it's first used" : "Stopped; it starts when it's next used" };
  }

  // --- running harnesses inside the VM ---------------------------------------------------------

  /** A path in the shared folder, as the VM sees it. */
  vmPath(hostPath: string): string {
    const rel = path.relative(this.filesDir, hostPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ActionError(`${hostPath} isn't in the folder this VM shares`);
    return rel ? path.posix.join(VM_FILES, ...rel.split(path.sep)) : VM_FILES;
  }

  /**
   * How a harness starts inside this VM, as the warren user, in its own process group so a
   * cancelled run can be stopped there (stopping `exec` alone leaves the process running).
   */
  launcher(runId: string) {
    const pidFile = `/tmp/warren-run-${runId.replace(/[^\w-]/g, "")}.pid`;
    return (l: { command: string; args: string[]; cwd: string; env: Record<string, string> }) => ({
      command: this.bin,
      args: [
        "exec",
        "-i",
        "-u",
        "warren",
        "-w",
        this.vmPath(l.cwd),
        "-e",
        `DISPLAY=${DISPLAY}`,
        "-e",
        `HOME=${VM_HOME}`,
        ...Object.entries(l.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        this.name,
        "setsid",
        "--wait",
        "sh",
        "-c",
        `echo $$ > ${pidFile}; exec "$@"`,
        "sh",
        l.command,
        ...l.args,
      ],
      // the engine runs here; it only needs a folder that exists
      cwd: this.filesDir,
      env: {},
    });
  }

  /** Stop what a run started inside the VM. */
  async stopRun(runId: string) {
    const pidFile = `/tmp/warren-run-${runId.replace(/[^\w-]/g, "")}.pid`;
    await exec(this.bin, ["exec", this.name, "sh", "-c", `p=$(cat ${pidFile} 2>/dev/null) && { kill -TERM -$p 2>/dev/null || kill -TERM $p; }; rm -f ${pidFile}`], { timeoutMs: 15_000 }).catch(() => undefined);
  }

  /** Put a file in the VM (as warren), e.g. Warren's tools for harnesses that run in here. */
  async writeFile(vmPath: string, content: string | Buffer, mode = "644") {
    await this.ready();
    await must(this.bin, ["exec", "-i", "-u", "warren", this.name, "sh", "-c", `mkdir -p "$(dirname '${vmPath}')" && cat > '${vmPath}' && chmod ${mode} '${vmPath}'`], { input: content, timeoutMs: 60_000 });
  }

  /** Is this harness signed in inside the VM? null when it isn't one that comes with the VM. */
  async signedIn(harness: string): Promise<boolean | null> {
    const test = SIGNED_IN[harness];
    if (!test) return null;
    await this.ready();
    return (await exec(this.bin, ["exec", "-u", "warren", "-e", `HOME=${VM_HOME}`, this.name, "sh", "-c", test], { timeoutMs: 15_000 })).code === 0;
  }

  /** The web page element under a screen point, in the Chrome people see. */
  async inspectAt(x: number, y: number): Promise<PageElement | null> {
    await this.ready();
    const r = await exec(this.bin, ["exec", "-u", "warren", this.name, "node", "--input-type=module", "-e", INSPECT_SCRIPT, String(Math.round(x)), String(Math.round(y))], { timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "null");
    } catch {
      return null;
    }
  }

  /** Open a terminal on the VM's screen that signs the harness in; a person finishes it there. */
  async openSignIn(harness: string) {
    const cmd = SIGN_IN_COMMAND[harness];
    if (!cmd) throw new ActionError(`${harness} doesn't come with the VM`);
    await this.ready();
    await must(
      this.bin,
      ["exec", "-d", "-u", "warren", "-e", `DISPLAY=${DISPLAY}`, "-e", `HOME=${VM_HOME}`, "-w", VM_FILES, this.name, "xfce4-terminal", "--maximize", "--title", "Sign in", "--command", `bash -lc '${cmd}; exec bash'`],
      { timeoutMs: 30_000 },
    );
  }

  /**
   * The hub's address as the VM reaches it: the same, unless the hub runs on this device under
   * localhost, which inside the VM means the VM itself.
   */
  async hubUrl(hub: string): Promise<string> {
    const u = new URL(hub);
    if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname)) return hub.replace(/\/+$/, "");
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    // where the VM reaches this device: its network's gateway, with a relay to the hub on loopback
    let gateway: string | undefined;
    if (this.engine.kind === "apple") {
      const info = await this.appleInfo();
      gateway = (typeof info?.status === "object" ? info.status.networks?.[0]?.ipv4Gateway : undefined) ?? "192.168.64.1";
    } else if (this.engine.kind === "docker" && process.platform === "linux") {
      const r = await exec(this.bin, ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"], { timeoutMs: 15_000 });
      gateway = r.code === 0 ? r.stdout.toString().trim() || undefined : undefined;
    }
    if (gateway) {
      u.hostname = gateway;
      u.port = String(await relay(gateway, port));
    } else u.hostname = this.engine.kind === "podman" ? "host.containers.internal" : "host.docker.internal"; // these reach the host's loopback
    return u.toString().replace(/\/+$/, "");
  }

  /** The VM's VNC server, through socat inside it. */
  async vnc(): Promise<Duplex> {
    await this.ready();
    const child = spawn(this.bin, ["exec", "-i", this.name, "socat", "STDIO", "TCP:127.0.0.1:5900"], { stdio: ["pipe", "pipe", "ignore"] });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    stream.on("close", () => child.kill());
    child.on("close", () => stream.destroy());
    return stream;
  }
}
