// Runs Warren's own processes for the desktop app: a hub on this computer, and this computer as a
// device. Both are the same `warren` CLI a terminal would run. A built app carries its own copy of
// Warren (scripts/bundle-warren.mjs) and runs it with the app itself as Node, so it needs nothing
// else installed; run from source, it uses this repo and the person's own Node.js 22+.
const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isWin = process.platform === "win32";
const NODE_DIR = process.env.WARREN_NODE_DIR || path.join(os.homedir(), ".warren");
const NODE_CONFIG = path.join(NODE_DIR, "node.json");

/**
 * Apps opened from the Dock or Finder get a bare PATH, so ask the person's login shell for theirs:
 * the device needs it to find `node`, `claude`, `codex` and the VM engine, just as in a terminal.
 */
let shellPath = null;
function loginPath() {
  if (shellPath !== null) return shellPath;
  shellPath = process.env.PATH || "";
  if (isWin) return shellPath;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", 'printf "__WARREN_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/__WARREN_PATH__(.*)$/m);
    if (m && m[1]) shellPath = m[1];
  } catch {}
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".volta/bin")];
  const parts = shellPath.split(path.delimiter);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  shellPath = parts.join(path.delimiter);
  return shellPath;
}

function env(extra = {}) {
  return { ...process.env, PATH: loginPath(), ELECTRON_RUN_AS_NODE: undefined, ...extra };
}

/** The `node` that runs Warren: 22 or newer, as Warren needs. */
function findNode() {
  for (const dir of loginPath().split(path.delimiter)) {
    const bin = path.join(dir, isWin ? "node.exe" : "node");
    if (!fs.existsSync(bin)) continue;
    try {
      const v = execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 5000 }).trim();
      if (Number(v.replace(/^v/, "").split(".")[0]) >= 22) return { bin, version: v };
    } catch {}
  }
  return null;
}

const isWarren = (dir) => !!dir && fs.existsSync(path.join(dir, "bin", "warren.mjs")) && fs.existsSync(path.join(dir, "apps", "hub"));

/** The Warren folder a `warren service install` points at (its LaunchAgent runs <dir>/bin/…). */
function serviceWarren() {
  if (process.platform !== "darwin") return [];
  return ["hub", "node"].map((kind) => {
    try {
      const plist = fs.readFileSync(path.join(os.homedir(), "Library/LaunchAgents", `ai.warren.${kind}.plist`), "utf8");
      const m = plist.match(/<string>([^<]+)\/bin\/warren(?:-hub)?\.mjs<\/string>/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  });
}

/** Where Warren is: the saved folder, $WARREN_DIR, install.sh's ~/warren, a service's folder, or the repo this app runs from. */
function findWarren(saved) {
  const candidates = [saved, process.env.WARREN_DIR, path.join(os.homedir(), "warren"), ...serviceWarren(), path.resolve(__dirname, "../../..")];
  return candidates.find(isWarren) || null;
}

function readNodeConfig() {
  try {
    return JSON.parse(fs.readFileSync(NODE_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function writeNodeConfig(patch) {
  const next = { ...readNodeConfig(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  fs.mkdirSync(NODE_DIR, { recursive: true });
  fs.writeFileSync(NODE_CONFIG, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** The copy of Warren inside a built app ($WARREN_RUNTIME points a source run at a staged one). */
function bundledWarren() {
  const dir = process.env.WARREN_RUNTIME || (process.resourcesPath ? path.join(process.resourcesPath, "warren") : null);
  return isWarren(dir) ? dir : null;
}

/**
 * How to run Warren here: the app's own copy with the app as Node (its data in ~/.warren/data), or
 * from source, a Warren folder and the person's Node.js. `problem` says what's missing.
 */
function runtime(saved) {
  const bundled = bundledWarren();
  if (bundled)
    return { node: process.execPath, version: process.versions.node, warrenDir: bundled, bundled: true, env: { ELECTRON_RUN_AS_NODE: "1", WARREN_DATA_DIR: process.env.WARREN_DATA_DIR || path.join(NODE_DIR, "data") } };
  const node = findNode();
  const warrenDir = findWarren(saved);
  if (!node) return { problem: "Warren needs Node.js 22 or newer. Install it from nodejs.org, then try again." };
  if (!warrenDir) return { problem: "This copy of Warren is missing its server. Download Warren again, or run it from a Warren folder." };
  return { node: node.bin, version: node.version, warrenDir, bundled: false, env: {} };
}

/** Whether `warren service install` already keeps this running (then the app leaves it alone). */
function serviceRunning(kind) {
  // a service reads ~/.warren; with another WARREN_NODE_DIR, it isn't this app's device
  if (process.platform !== "darwin" || process.env.WARREN_NODE_DIR) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("launchctl", ["print", `gui/${process.getuid()}/ai.warren.${kind}`], { timeout: 4000 }, (err, out) => resolve(!err && /state = running/.test(out)));
  });
}

/** Restart a `warren service`, so it picks up a node.json that now points at another hub. */
function restartService(kind) {
  return new Promise((resolve) => execFile("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/ai.warren.${kind}`], { timeout: 8000 }, (err) => resolve(!err)));
}

async function hubUp(url) {
  try {
    const res = await fetch(new URL("/api/setup", url), { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** What a person typed as a server address, as the addresses to try in order. */
function candidates(input) {
  const text = String(input || "").trim().replace(/\/+$/, "");
  if (!text) return [];
  if (/^https?:\/\//i.test(text)) {
    try {
      return [new URL(text).origin];
    } catch {
      return [];
    }
  }
  let u;
  try {
    u = new URL(`http://${text}`);
  } catch {
    return [];
  }
  if (!u.hostname) return [];
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)|\.local$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || !u.hostname.includes(".");
  const https = `https://${u.host}`;
  const http = `http://${u.host}`;
  const list = local ? [http, https] : [https, http];
  if (!u.port) list.push(`http://${u.hostname}:4747`); // Warren's own port, when it isn't behind a proxy
  return [...new Set(list)];
}

/** Why a fetch failed, in words. */
function reason(err, origin) {
  const code = err?.cause?.code || err?.code || err?.name;
  const host = new URL(origin).host;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Couldn't find ${new URL(origin).hostname}. Check the spelling, or that this computer is on the same network (or Tailscale).`;
  if (code === "ECONNREFUSED") return `Nothing is answering at ${host}. Is the server running?`;
  if (code === "TimeoutError" || code === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT") return `${host} didn't answer in time.`;
  if (/CERT|SSL|TLS/i.test(String(code)) || /certificate/i.test(String(err?.cause?.message))) return `${host}'s HTTPS certificate isn't valid.`;
  return `Couldn't reach ${host} (${err?.cause?.message || err?.message || code}).`;
}

/**
 * Check a server address before joining it: can this computer reach it, and is it a Warren hub.
 * Resolves with the address that worked (`url`), whether nobody has set it up yet, and the checks
 * to show, or `ok: false` with why not.
 */
async function testHub(input, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const list = candidates(input);
  if (!list.length) return { ok: false, error: "That isn't a server address. Try something like warren.example.com or 192.168.1.20:4747.", checks: [] };
  let first = null;
  for (const origin of list) {
    let res;
    try {
      res = await fetchImpl(new URL("/api/setup", origin), { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    } catch (err) {
      first ??= { ok: false, error: reason(err, origin), checks: [{ label: "Reach the server", ok: false }] };
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.needsSetup !== "boolean") {
      // something answered, so this is the address, but it isn't Warren
      return { ok: false, url: origin, error: `${new URL(origin).host} answered, but it isn't a Warren server${res.ok ? "" : ` (${res.status})`}.`, checks: [{ label: "Reach the server", ok: true }, { label: "It's a Warren server", ok: false }] };
    }
    return {
      ok: true,
      url: origin,
      needsSetup: body.needsSetup,
      checks: [
        { label: `Reach ${new URL(origin).host}`, ok: true },
        { label: "It's a Warren server", ok: true },
        { label: body.needsSetup ? "Nobody has set it up yet: you'll create the first account" : "Ready for you to sign in", ok: true },
      ],
    };
  }
  return first;
}

/** This computer's addresses other computers can join its server at (LAN and Tailscale). */
function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
  return out;
}

/** A Warren process this app started; it stops when the app quits. */
/** what `warren node start` exits with when the hub turns its token down ($WARREN_EXIT_IF_REJECTED) */
const REJECTED_CODE = 78;

class Child {
  constructor(name, logDir, onChange) {
    this.name = name;
    this.log = path.join(logDir, `${name}.log`);
    this.onChange = onChange;
    this.proc = null;
    this.state = "stopped";
    this.detail = "";
    this.wanted = false;
    this.restarts = 0;
  }

  start(node, warrenDir, args, extraEnv = {}) {
    if (this.proc) return;
    this.wanted = true;
    this.spec = { node, warrenDir, args, extraEnv };
    fs.mkdirSync(path.dirname(this.log), { recursive: true });
    const out = fs.openSync(this.log, "a");
    fs.writeSync(out, `\n--- ${new Date().toISOString()} starting ${args.join(" ")}\n`);
    const proc = spawn(node, [path.join(warrenDir, "bin", "warren.mjs"), ...args], { cwd: warrenDir, env: env(extraEnv), stdio: ["ignore", out, out], windowsHide: true });
    fs.closeSync(out);
    this.proc = proc;
    this.set("starting", "");
    const startedAt = Date.now();
    proc.on("exit", (code, signal) => {
      this.proc = null;
      if (!this.wanted) return this.set("stopped", "");
      if (code === REJECTED_CODE) {
        // the hub turned the device's token down: restarting can't help
        this.wanted = false;
        return this.set("rejected", "");
      }
      // crashed: try again a few times, then say so
      if (Date.now() - startedAt > 60_000) this.restarts = 0;
      if (this.restarts < 3) {
        this.restarts++;
        this.set("starting", `restarting (exited ${signal || code})`);
        setTimeout(() => this.wanted && this.start(node, warrenDir, args, extraEnv), 1500 * this.restarts);
      } else this.set("error", `stopped unexpectedly (${signal || `exit ${code}`}); see ${this.log}`);
    });
  }

  running() {
    return !!this.proc;
  }

  set(state, detail) {
    this.state = state;
    this.detail = detail;
    this.onChange();
  }

  stop() {
    this.wanted = false;
    this.restarts = 0;
    if (!this.proc) return;
    const p = this.proc;
    p.kill(isWin ? undefined : "SIGTERM");
    setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 8000).unref();
  }

  /** Last lines of its log, to show when something goes wrong. */
  tail(lines = 30) {
    try {
      return fs.readFileSync(this.log, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }
}

module.exports = { Child, findNode, findWarren, isWarren, runtime, hubUp, testHub, restartService, candidates, lanAddresses, serviceRunning, readNodeConfig, writeNodeConfig, NODE_CONFIG };
