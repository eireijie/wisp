import fs from "node:fs";
import path from "node:path";
import { deviceAdapters } from "@warren/adapters";
import { Reach } from "../../hub/src/reach.ts";
import { commandExists, type NodeConfig } from "./daemon.ts";
import { detectEngine } from "./computers/index.ts";
import { serviceStatus } from "./service.ts";
import { joinTarget } from "./join.ts";

export interface DoctorCheck { label: string; ok: boolean; detail?: string; fix?: string }
export interface DoctorConfig extends Partial<NodeConfig> { nodeId?: string }
export interface DoctorDependencies {
  fetch: typeof fetch;
  running: () => boolean;
  connected: () => boolean;
  harnesses: (config: DoctorConfig) => string[];
  engine: (config: DoctorConfig) => Promise<boolean>;
  away: () => Promise<{ on: boolean; found: boolean }>;
}

export function readDoctorConfig(dir: string): DoctorConfig {
  const file = path.join(dir, "node.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

/** Latest service connection evidence, without reading an unbounded log into memory. */
export function connectionLogged(dir: string): boolean {
  const file = path.join(dir, "node.log");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const events = buffer.toString("utf8").split("\n").filter((line) => /connected to .+ as|disconnected|unauthorized|rejected/i.test(line));
    return /connected to .+ as/.test(events.at(-1) ?? "");
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Independent probes keep a missing app or an unreachable Wisp from hiding the remaining fixes. */
export async function checkDoctor(dir: string, saved: DoctorConfig, overrides: Partial<DoctorDependencies> = {}): Promise<DoctorCheck[]> {
  const localUrl = `http://localhost:${process.env.PORT ?? "4747"}`;
  const deps: DoctorDependencies = {
    fetch,
    running: () => serviceStatus("node", dir).running,
    connected: () => connectionLogged(dir),
    harnesses: (cfg) => Object.values(deviceAdapters(cfg.harnesses)).filter((a) => commandExists(a.binary)).map((a) => a.label),
    engine: async (cfg) => !!(await detectEngine(cfg.vmEngine)).engine,
    away: async () => {
      const status = await new Reach(Number(process.env.PORT ?? 4747)).tailscale();
      return { on: status.state === "running" && status.serving, found: status.state !== "missing" };
    },
    ...overrides,
  };
  let url = localUrl;
  try { url = saved.hub ? joinTarget(saved.hub).url : localUrl; } catch {}
  const get = async (route: string, authenticated = false): Promise<unknown> => {
    try {
      const response = await deps.fetch(`${url}${route}`, {
        headers: authenticated && saved.token ? { authorization: `Bearer ${saved.token}` } : {},
        signal: AbortSignal.timeout(4000), redirect: "error",
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const [health, agents, reach, harnesses, engine] = await Promise.all([
    get("/healthz"), saved.token ? get("/api/node/agents", true) : null,
    saved.token ? get("/api/reach", true) : null,
    Promise.resolve().then(() => deps.harnesses(saved)).catch(() => []),
    Promise.resolve().then(() => deps.engine(saved)).catch(() => false),
  ]);
  let running = false;
  let logged = false;
  try { running = deps.running(); logged = deps.connected(); } catch {}
  // Device credentials can validate themselves here, but cannot read /api/nodes or owner settings.
  const connected = Array.isArray(agents) && running && logged && !saved.paused;
  const remote = url !== localUrl && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  const healthy = (health as { ok?: boolean } | null)?.ok === true;
  let away = { on: false, found: false };
  let awayDetail = "";
  const r = reach as { publicUrl?: string; tailscale?: { serving?: boolean } } | null;
  if (r) away = { on: !!r.publicUrl || !!r.tailscale?.serving, found: !!r.tailscale };
  else if (remote) {
    const host = new URL(url).hostname;
    const tailscale = /(^|\.)ts\.net$/.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
    away = { on: healthy && (url.startsWith("https://") || tailscale), found: tailscale };
    if (away.on) awayDetail = tailscale ? "Using Tailscale" : "Using HTTPS";
  }
  else try { away = await deps.away(); } catch {}
  return [
    { label: "Wisp is running", ok: healthy, fix: saved.hub && remote ? "Open Wisp on the computer it lives on and check your connection." : "Run: wisp service install hub" },
    { label: "This computer is connected", ok: connected, fix: saved.paused ? "Run: wisp node resume" : saved.token ? running ? "Check your connection, then run: wisp service install node" : "Run: wisp service install node" : saved.local ? `Finish getting ready at ${localUrl}` : "Run: wisp join" },
    { label: "Found agent apps", ok: harnesses.length > 0, detail: harnesses.join(", "), fix: "Open Wisp and choose an agent app to install." },
    { label: "VM engine is ready", ok: engine, fix: "Run: wisp setup" },
    { label: "Away from home", ok: away.on, detail: away.on ? awayDetail || "On" : away.found ? "Tailscale found" : "Off", fix: "Open Wisp → Settings → Devices → Away from home." },
  ];
}

export async function doctor(dir: string, say: (line: string) => void = console.log): Promise<boolean> {
  say("Wisp");
  let saved: DoctorConfig;
  try { saved = readDoctorConfig(dir); }
  catch {
    say("✗ Couldn't read this computer's settings");
    say(`  Fix: Check ${path.join(dir, "node.json")} and run wisp doctor again.`);
    return false;
  }
  const checks = await checkDoctor(dir, saved);
  for (const check of checks) {
    say(`${check.ok ? "✓" : "✗"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
    if (!check.ok) say(`  Fix: ${check.fix}`);
  }
  return checks.every((check) => check.ok);
}
