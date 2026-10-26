// Startup migrations run before Electron opens its profile or the engine reads device settings.
// All filesystem locations and commands can be replaced for tests; importing this module does nothing.
const nativeFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

function createMigration({ fs = nativeFs, home = os.homedir(), appData, platform = process.platform,
  runner = promisify(execFile), log = console.log,
  systemUnitDirs = ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"] } = {}) {
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch (err) { if (err.code === "ENOENT") return false; throw err; } };
  const actions = [];
  const record = (line) => { actions.push(line); log(`[wisp] ${line}`); };

  function verify(from, to) {
    const a = fs.lstatSync(from), b = fs.lstatSync(to);
    if (a.isSymbolicLink()) return b.isSymbolicLink() && fs.readlinkSync(from) === fs.readlinkSync(to);
    if (a.isDirectory()) {
      if (!b.isDirectory()) return false;
      const left = fs.readdirSync(from).sort(), right = fs.readdirSync(to).sort();
      return JSON.stringify(left) === JSON.stringify(right) && left.every((name) => verify(path.join(from, name), path.join(to, name)));
    }
    return a.isFile() && b.isFile() && a.size === b.size && fs.readFileSync(from).equals(fs.readFileSync(to));
  }

  function move(from, to, alias = false) {
    if (exists(to) || !exists(from) || fs.lstatSync(from).isSymbolicLink()) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); }
    catch (err) {
      if (err.code !== "EXDEV") throw err;
      const staging = `${to}.migrating-${randomUUID()}`;
      try {
        fs.cpSync(from, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        if (!verify(from, staging)) throw new Error(`Migration verification failed: ${from}`);
        if (exists(to)) throw new Error(`Migration destination now exists: ${to}`);
        fs.renameSync(staging, to);
        fs.rmSync(from, { recursive: true });
      } catch (copyError) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw copyError;
      }
    }
    if (alias) fs.symlinkSync(to, from, platform === "win32" ? "junction" : "dir");
    record(`Moved ${from} to ${to}${alias ? " (old path kept as a symlink)" : ""}`);
    return true;
  }

  function rewriteConfigs(dir) {
    if (!exists(dir)) return;
    // Settings live at the root. Never rewrite JSON documents in agents' workspaces or the vault.
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) continue;
      let original, config;
      try { original = fs.readFileSync(file, "utf8"); config = JSON.parse(original); }
      catch (err) { if (err instanceof SyntaxError) continue; throw err; }
      const rewrite = (value) => {
        if (typeof value === "string") return path.isAbsolute(value) || path.win32.isAbsolute(value) ? value.replace(/([/\\])\.warren(?=[/\\]|$)/g, "$1.wisp") : value;
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
        return value;
      };
      const next = rewrite(config);
      if (name === "desktop.json" && next && typeof next === "object" && !Array.isArray(next) && "warrenDir" in next) {
        next.wispDir ??= next.warrenDir;
        delete next.warrenDir;
      }
      const text = JSON.stringify(next, null, 2);
      if (JSON.stringify(config, null, 2) !== text) {
        const temporary = `${file}.migrating`;
        fs.writeFileSync(temporary, text, { mode: fs.statSync(file).mode & 0o777 });
        fs.renameSync(temporary, file);
      }
    }
  }

  function prepare() {
    const userData = appData && path.join(appData, "Wisp");
    if (userData) {
      move(path.join(appData, "Warren"), userData);
      rewriteConfigs(userData);
    }
    const nodeDir = path.join(home, ".wisp");
    move(path.join(home, ".warren"), nodeDir, true);
    // Also retry config rewrites after an interrupted prior migration.
    rewriteConfigs(nodeDir);
    return { userData, actions: [...actions] };
  }

  async function hasLegacyServices() {
    if (platform === "darwin") return ["hub", "node"].some((kind) => exists(path.join(home, "Library", "LaunchAgents", `ai.warren.${kind}.plist`)));
    if (platform === "linux") return [path.join(home, ".config/systemd/user"), ...systemUnitDirs]
      .some((dir) => ["warren", "warren-node"].some((name) => exists(path.join(dir, `${name}.service`))));
    if (platform === "win32") {
      const result = await runner("powershell.exe", ["-NoProfile", "-Command", "$tasks = @(Get-ScheduledTask -TaskName 'Warren hub','Warren node' -ErrorAction SilentlyContinue); $tasks.TaskName; exit 0"], { timeout: 10_000, windowsHide: true });
      return /Warren (hub|node)/.test(typeof result === "string" ? result : result.stdout || "");
    }
    return false;
  }

  async function migrateServices(runtime) {
    if (!(await hasLegacyServices())) return [];
    runtime = typeof runtime === "function" ? runtime() : runtime;
    if (!runtime || runtime.problem) throw new Error(runtime?.problem || "Wisp's CLI is missing; service migration cannot run.");
    // The node CLI owns stop/remove/install and preserves the old service's settings.
    const result = await runner(runtime.node, [path.join(runtime.wispDir, "bin", "wisp.mjs"), "migrate", "--json"], {
      cwd: runtime.wispDir, env: { ...process.env, ...runtime.env, HOME: home, ...(platform === "win32" ? { USERPROFILE: home } : {}) },
      timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const stdout = typeof result === "string" ? result : result.stdout || "";
    const resultJson = stdout.trim() ? JSON.parse(stdout) : [];
    record("Migrated legacy services with wisp migrate --json");
    return resultJson;
  }
  return { prepare, hasLegacyServices, migrateServices };
}
module.exports = { createMigration };
