import { envVar } from "@wisp/core";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How people and devices reach this hub from elsewhere: its home-network addresses, and
 * Tailscale, which Wisp pushes as one of the first steps of setup. Tailscale gives the hub a
 * private https://<computer>.<tailnet>.ts.net address that works from anywhere for devices on the
 * same tailnet (Serve), and optionally a public one for people without Tailscale (Funnel).
 *
 * Everything goes through the `tailscale` command on the hub's computer; a hub in Docker or on a
 * machine without Tailscale just reports it as missing.
 */

export type TailscaleState = "missing" | "needs-login" | "stopped" | "starting" | "running" | "error";

export interface TailscaleStatus {
  state: TailscaleState;
  /** e.g. alexs-mac.example-tailnet.ts.net (no trailing dot) */
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
export function tailscaleCandidates(platform = process.platform, envPath = process.env.PATH ?? "", only = envVar("TAILSCALE")): string[] {
  // WISP_TAILSCALE points at one particular tailscale command (and nothing else is used)
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

/** Turn `tailscale status --json` and `tailscale serve status --json` into what Wisp shows. */
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
    return platform === "linux" ? "Wisp isn't allowed to change Tailscale on this computer. Run this once in a terminal, then try again: sudo tailscale set --operator=$USER" : "Wisp isn't allowed to change Tailscale on this computer. Open the Tailscale app and try again.";
  if (/HTTPS.*(not enabled|disabled)|enable HTTPS/i.test(t)) return "HTTPS certificates are off for your tailnet. Turn on HTTPS in the Tailscale admin console (DNS → HTTPS Certificates), then try again: https://login.tailscale.com/admin/dns";
  if (/funnel.*(not enabled|not allowed|disabled|attribute)/i.test(t)) return "Funnel isn't allowed on your tailnet yet. Allow it in the Tailscale admin console, then try again: https://login.tailscale.com/admin/acls";
  if (/doesn't appear to be running|failed to connect|not running/i.test(t)) return "Tailscale is installed but not running. Open the Tailscale app (or start the tailscaled service), then try again.";
  return t.split("\n").filter(Boolean).slice(-2).join(" ") || "Tailscale didn't answer.";
}

export class Reach {
  private bin: string | null = null;
  private cache: { at: number; value: TailscaleStatus } | null = null;
  private lastError: string | null = null;

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
  ) {}

  private find(): string | null {
    // looked for again until it's found, so installing Tailscale while Wisp runs is noticed
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
    return t.state === "running" && t.serving && t.dnsName ? `https://${t.dnsName}` : null;
  }

  /**
   * Do one thing with Tailscale: sign in (returns the page to open), connect, or turn the https
   * address on or off, privately (serve) or for everyone (funnel).
   */
  async act(action: "login" | "up" | "serve" | "unserve" | "funnel" | "unfunnel"): Promise<TailscaleStatus> {
    const bin = this.find();
    if (!bin) throw new Error("Tailscale isn't installed on the computer running Wisp.");
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
      // turning off what's already off is fine
      if (r.code !== 0 && !/off/.test(args.join(" "))) {
        this.lastError = explainTailscaleError(r.stderr || r.stdout);
        break;
      }
    }
    return this.tailscale(true);
  }
}

/** This computer's home-network addresses for the hub (not loopback, not Tailscale). */
export function lanAddresses(port: number, interfaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    // virtual networks for VMs and containers aren't the Wi-Fi other devices are on
    if (/^(bridge|vmnet|docker|veth|br-|virbr|vEthernet|utun|lo)/i.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) continue;
      out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}
