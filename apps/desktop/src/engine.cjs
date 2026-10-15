// Runs Warren's own processes for the desktop app: a hub on this computer, and this computer as a
// device. Both are the same `warren` CLI a terminal would run, started from a Warren folder (a clone
// made by install.sh, or the repo this app was built from) with the Node.js the person already has.
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

/** Whether `warren service install` already keeps this running (then the app leaves it alone). */
function serviceRunning(kind) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("launchctl", ["print", `gui/${process.getuid()}/ai.warren.${kind}`], { timeout: 4000 }, (err, out) => resolve(!err && /state = running/.test(out)));
  });
}

async function hubUp(url) {
  try {
    const res = await fetch(new URL("/api/setup", url), { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A Warren process this app started; it stops when the app quits. */
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

module.exports = { Child, findNode, findWarren, isWarren, hubUp, serviceRunning, readNodeConfig, writeNodeConfig, NODE_CONFIG };
