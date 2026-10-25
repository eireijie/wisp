import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { httpOrigin, reachableAddresses, isTailscaleAddress } from "./reachable-addresses.ts";
import path from "node:path";

/**
 * How people and devices reach this hub from elsewhere: its home-network addresses, and
 * Tailscale, which Warren pushes as one of the first steps of setup. Tailscale gives the hub a
 * private https://<computer>.<tailnet>.ts.net address that works from anywhere for devices on the
 * same tailnet (Serve), and optionally a public one for people without Tailscale (Funnel).
 *
 * Everything goes through the `tailscale` command on the hub's computer; a hub in Docker or on a
 * machine without Tailscale just reports it as missing.
 */

export type TailscaleState = "missing" | "needs-login" | "stopped" | "starting" | "running" | "error";

export interface TailscaleStatus {
  state: TailscaleState;
  /** e.g. yugs-mac.tail1234.ts.net (no trailing dot) */
  dnsName: string | null;
  ip: string | null;
  tailnet: string | null;
  /** the tailnet allows HTTPS certificates (needed for Serve) and Funnel */
  canHttps: boolean;
  canFunnel: boolean;
  /** https://<dnsName> is proxied to this hub, privately (serve) or publicly too (funnel) */
  serving: boolean;
  funnel: boolean;
  /** the sign-in page, while one is pending */
  authUrl: string | null;
  /** why the last command failed, in plain words */
  error: string | null;
}

export type Run = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const realRun: Run = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) });
    });
  });

/** Where the tailscale command usually is, PATH first. */
export function tailscaleCandidates(platform = process.platform, envPath = process.env.PATH ?? "", only = process.env.WARREN_TAILSCALE): string[] {
  // WARREN_TAILSCALE points at one particular tailscale command (and nothing else is used)
  if (only) return [only];
  const exe = platform === "win32" ? "tailscale.exe" : "tailscale";
  const onPath = envPath
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((d) => path.join(d, exe));
  const known =
    platform === "darwin"
      ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
      : platform === "win32"
        ? ["C:\\Program Files\\Tailscale\\tailscale.exe"]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
  return [...new Set([...onPath, ...known])];
}

/** JSON from a command that may print a warning line first (e.g. "client version != server version"). */
export function parseJson(out: string): unknown {
  const at = out.indexOf("{");
  if (at < 0) throw new Error("no JSON in output");
  return JSON.parse(out.slice(at));
}

/** Turn `tailscale status --json` and `tailscale serve status --json` into what Warren shows. */
export function readStatus(status: unknown, serve: unknown, port: number): Omit<TailscaleStatus, "error"> {
  const s = (status ?? {}) as {
    BackendState?: string;
    AuthURL?: string;
    MagicDNSSuffix?: string;
    CurrentTailnet?: { Name?: string } | null;
    Self?: { DNSName?: string; TailscaleIPs?: string[]; CapMap?: Record<string, unknown> | null; Capabilities?: string[] | null } | null;
  };
  const backend = s.BackendState ?? "";
  const state: TailscaleState =
    backend === "Running" ? "running" : backend === "Stopped" ? "stopped" : backend === "Starting" ? "starting" : backend === "NeedsLogin" || backend === "NeedsMachineAuth" || backend === "NoState" ? "needs-login" : "error";
  const self = s.Self ?? {};
  const caps = new Set([...Object.keys(self.CapMap ?? {}), ...(self.Capabilities ?? [])]);
  const dnsName = self.DNSName ? self.DNSName.replace(/\.$/, "") : null;
  // serve config: Web["<host>:443"].Handlers["/"].Proxy = "http://127.0.0.1:<port>", AllowFunnel["<host>:443"] = true
  const cfg = (serve ?? {}) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
  const key = dnsName ? `${dnsName}:443` : null;
  const proxy = key ? cfg.Web?.[key]?.Handlers?.["/"]?.Proxy : undefined;
  const serving = !!proxy && new RegExp(`(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}/?$`).test(proxy);
  return {
    state,
    dnsName: state === "needs-login" ? null : dnsName,
    ip: self.TailscaleIPs?.find((ip) => ip.includes(".")) ?? null,
    tailnet: s.CurrentTailnet?.Name ?? null,
    canHttps: caps.has("https"),
    canFunnel: caps.has("funnel"),
    serving,
    funnel: serving && !!(key && cfg.AllowFunnel?.[key]),
    authUrl: s.AuthURL || null,
  };
}

/** A failed tailscale command in plain words, with the fix when it's a known one. */
export function explainTailscaleError(stderr: string, platform = process.platform): string {
  const t = stderr.trim();
  if (/access denied|permission denied|must be root|operator/i.test(t))
    return platform === "linux" ? "Warren isn't allowed to change Tailscale on this computer. Run this once in a terminal, then try again: sudo tailscale set --operator=$USER" : "Warren isn't allowed to change Tailscale on this computer. Open the Tailscale app and try again.";
  if (/HTTPS.*(not enabled|disabled)|enable HTTPS/i.test(t)) return "HTTPS certificates are off for your tailnet. Turn on HTTPS in the Tailscale admin console (DNS → HTTPS Certificates), then try again: https://login.tailscale.com/admin/dns";
  if (/funnel.*(not enabled|not allowed|disabled|attribute)/i.test(t)) return "Funnel isn't allowed on your tailnet yet. Allow it in the Tailscale admin console, then try again: https://login.tailscale.com/admin/acls";
  if (/doesn't appear to be running|failed to connect|not running/i.test(t)) return "Tailscale is installed but not running. Open the Tailscale app (or start the tailscaled service), then try again.";
  return t.split("\n").filter(Boolean).slice(-2).join(" ") || "Tailscale didn't answer.";
}

export class Reach {
  private bin: string | null = null;
  private cache: { at: number; value: TailscaleStatus } | null = null;
  private lastError: string | null = null;
  readonly cloudflare: Cloudflare;

  constructor(
    private port: number,
    private run: Run = realRun,
    private exists: (p: string) => boolean = (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    cloudflareOptions: CloudflareOptions = {},
  ) { this.cloudflare = new Cloudflare(port, exists, cloudflareOptions); }

  private find(): string | null {
    // looked for again until it's found, so installing Tailscale while Warren runs is noticed
    if (!this.bin) this.bin = tailscaleCandidates().find((p) => this.exists(p)) ?? null;
    return this.bin;
  }

  /** Tailscale on this computer, read fresh at most every few seconds. */
  async tailscale(fresh = false): Promise<TailscaleStatus> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 4000) return this.cache.value;
    const bin = this.find();
    const empty: TailscaleStatus = { state: "missing", dnsName: null, ip: null, tailnet: null, canHttps: false, canFunnel: false, serving: false, funnel: false, authUrl: null, error: null };
    if (!bin) return empty;
    const st = await this.run(bin, ["status", "--json"], 5000);
    let status: unknown = null;
    try {
      status = parseJson(st.stdout);
    } catch {
      const value = { ...empty, state: "error" as const, error: explainTailscaleError(st.stderr || st.stdout) };
      this.cache = { at: Date.now(), value };
      return value;
    }
    const sv = await this.run(bin, ["serve", "status", "--json"], 5000);
    let serve: unknown = null;
    try {
      serve = parseJson(sv.stdout);
    } catch {}
    const value = { ...readStatus(status, serve, this.port), error: this.lastError };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** The address to give out, best first: Tailscale's https address when it's serving this hub. */
  async publicUrl(): Promise<string | null> {
    const t = await this.tailscale();
    return t.state === "running" && t.serving && t.dnsName ? `https://${t.dnsName}` : this.cloudflare.status().url;
  }

  /**
   * Do one thing with Tailscale: sign in (returns the page to open), connect, or turn the https
   * address on or off, privately (serve) or for everyone (funnel).
   */
  async act(action: "login" | "up" | "serve" | "unserve" | "funnel" | "unfunnel"): Promise<TailscaleStatus> {
    const bin = this.find();
    if (!bin) throw new Error("Tailscale isn't installed on the computer running Warren.");
    this.lastError = null;
    const target = `http://127.0.0.1:${this.port}`;
    const steps: string[][] =
      action === "login"
        ? // starts the sign-in; the page shows up in status as AuthURL (waiting only a moment for it)
          [["login", "--timeout=8s"]]
        : action === "up"
          ? [["up", "--timeout=15s"]]
          : action === "serve"
            ? [["serve", "--bg", "--yes", target]]
            : action === "unserve"
              ? [["funnel", "--https=443", "off"], ["serve", "--https=443", "off"]]
              : action === "funnel"
                ? [["funnel", "--bg", "--yes", target]]
                : [["funnel", "--https=443", "off"], ["serve", "--bg", "--yes", target]];
    for (const args of steps) {
      const r = await this.run(bin, args, action === "login" ? 12_000 : 20_000);
      // a sign-in that's waiting for the browser "fails" with a timeout but has printed its link
      const link = (r.stdout + r.stderr).match(/https:\/\/login\.tailscale\.com\/a\/[\w-]+/)?.[0];
      if (action === "login" && link) {
        const t = await this.tailscale(true);
        return { ...t, authUrl: t.authUrl ?? link };
      }
      // turning off what's already off "fails" too, so those steps are judged by the status below
      if (r.code !== 0 && !/off/.test(args.join(" "))) {
        this.lastError = explainTailscaleError(r.stderr || r.stdout);
        break;
      }
    }
    const after = await this.tailscale(true);
    // never report public access as off without seeing it off
    const stillOpen = action === "unserve" ? after.serving || after.funnel : action === "unfunnel" ? after.funnel : false;
    if (stillOpen) {
      this.lastError = action === "unserve"
        ? "Wisp couldn't turn off its Tailscale address. Run: tailscale funnel --https=443 off && tailscale serve --https=443 off"
        : "Wisp couldn't turn off public access. Run: tailscale funnel --https=443 off";
      return { ...after, error: this.lastError };
    }
    return after;
  }
}

/** This computer's home-network addresses for the hub (not loopback, not Tailscale). */
export function lanAddresses(port: number, interfaces = os.networkInterfaces()): string[] {
  return reachableAddresses(null, port, interfaces).filter((url) => !isTailscaleAddress(new URL(url).hostname));
}

export interface CloudflareStatus {
  state: "missing" | "stopped" | "starting" | "running" | "error";
  url: string | null;
  error: string | null;
}
/** Ask a child to exit, then force it; true once it has exited. */
function endChild(child: ChildProcess | null, waitMs = 5000): Promise<boolean> {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.kill();
    // cloudflared drains connections for up to 30 seconds on SIGTERM; don't wait that long
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      timer = setTimeout(() => resolve(false), waitMs);
      timer.unref?.();
    }, waitMs);
    timer.unref?.();
  });
}

/** Stop a cloudflared an earlier run of this hub started, if it's still running (and really cloudflared). */
function endLeftover(pidFile: string) {
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { return; }
  fs.rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || process.platform === "win32") return;
  try {
    const name = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/cloudflared$/.test(name)) process.kill(pid, "SIGKILL");
  } catch { /* not running */ }
}

export interface CloudflareOptions {
  spawn?: typeof spawn;
  /** how long to wait for cloudflared to exit before forcing it, and again after (tests shorten it) */
  stopWaitMs?: number;
}

export function cloudflaredCandidates(platform = process.platform, envPath = process.env.PATH ?? "", only = process.env.WARREN_CLOUDFLARED): string[] {
  if (only) return [only];
  const exe = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return [...new Set([...envPath.split(platform === "win32" ? ";" : ":").filter(Boolean).map((d) => path.join(d, exe)),
    ...(platform === "darwin" ? ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"] : platform === "win32" ? ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"] : ["/usr/bin/cloudflared", "/usr/local/bin/cloudflared"])])];
}

/** A remotely configured tunnel; its ingress must point at this computer's Wisp. */
export class Cloudflare {
  private child: ChildProcess | null = null;
  private configFile: string | null = null;
  private value: CloudflareStatus = { state: "stopped", url: null, error: null };
  private configuredUrl: string | null = null;
  private pidFile: string | null = null;
  constructor(private port: number, private exists: (p: string) => boolean, private options: CloudflareOptions = {}) {}

  configure(dataDir: string) {
    this.configFile = path.join(dataDir, "cloudflare.json");
    this.pidFile = path.join(dataDir, "cloudflared.pid");
    // a tunnel left running by a Wisp that crashed would stay open even after it's turned off
    endLeftover(this.pidFile);
    try {
      const config = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
      if (typeof config.token === "string") this.start(config.token, config.url, false);
    } catch { /* no saved tunnel, or unavailable on this computer */ }
  }
  private find() { return cloudflaredCandidates().find((p) => this.exists(p)); }
  status(): CloudflareStatus {
    if (!this.child && this.value.state === "stopped" && !this.find()) return { state: "missing", url: null, error: null };
    return { ...this.value };
  }
  start(token: string, url?: string | null, persist = true): CloudflareStatus {
    if (!/^[a-zA-Z0-9_+/=-]{20,16384}$/.test(token)) throw new Error("Paste the code from Cloudflare again.");
    const bin = this.find();
    if (!bin) throw new Error("Install cloudflared on this computer, then try again.");
    const origin = httpOrigin(url);
    if (url && (!origin || !origin.startsWith("https://") || new URL(url).pathname !== "/" || new URL(url).search || new URL(url).hash)) throw new Error("Use your Cloudflare HTTPS address.");
    // Save before switching processes, so a failed write leaves the current tunnel running.
    if (persist && this.configFile) {
      const temporary = `${this.configFile}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ token, url: origin }), { mode: 0o600 });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, this.configFile);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    void this.close();
    this.configuredUrl = origin;
    this.value = { state: "starting", url: null, error: null };
    // Environment keeps the credential out of command lines and process listings.
    const child = (this.options.spawn ?? spawn)(bin, ["tunnel", "--no-autoupdate", "--logformat", "json", "run"], { env: { ...process.env, TUNNEL_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    if (this.pidFile && child.pid) fs.writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    const read = () => {
      let buffer = "";
      return (chunk: Buffer) => {
        if (this.child !== child) return;
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          this.readLine(line);
        }
        if (buffer.length > 128_000) buffer = "";
      };
    };
    child.stdout?.on("data", read());
    child.stderr?.on("data", read());
    child.on("error", () => {
      if (this.child !== child) return;
      this.child = null;
      this.value = { state: "error", url: null, error: "Cloudflare could not start; check that cloudflared is installed." };
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      this.value = { state: "error", url: null, error: "Cloudflare stopped; check its setup and try again." };
    });
    return this.status();
  }
  private readLine(line: string) {
    try {
      const event = JSON.parse(line);
      if (event.config) {
        const config = typeof event.config === "string" ? JSON.parse(event.config) : event.config;
        const ingress = config.ingress as { hostname?: string; service?: string }[] | undefined;
        const route = ingress?.find((r) => r.hostname && r.service && new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${this.port}/?$`).test(r.service));
        this.configuredUrl = route?.hostname && !route.hostname.includes("*") ? httpOrigin(`https://${route.hostname}`) : null;
      }
      if (/Registered tunnel connection/i.test(event.message ?? "")) this.value.state = "running";
      if (this.value.state === "running") this.value.url = this.configuredUrl;
    } catch { /* only structured connection and ingress messages affect state */ }
  }
  /** Turn the tunnel off and wait until cloudflared has really exited. */
  async stop() {
    if (this.configFile) fs.rmSync(this.configFile, { force: true });
    if (!(await this.close())) this.value = { state: "error", url: null, error: "Cloudflare didn't stop. Restart this computer to close the tunnel." };
    return this.status();
  }
  /** Shutdown keeps the saved setting, so the tunnel returns with Wisp. Resolves false if cloudflared won't exit. */
  close(): Promise<boolean> {
    const child = this.child;
    this.child = null;
    this.value = { state: "stopped", url: null, error: null };
    this.configuredUrl = null;
    return endChild(child, this.options.stopWaitMs).then((ended) => {
      if (ended && this.pidFile && !this.child) fs.rmSync(this.pidFile, { force: true });
      return ended;
    });
  }
}
