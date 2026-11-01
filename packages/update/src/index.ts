import { envVar } from "@wisp/core";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Updating a Wisp install in place. Hubs and devices both run from a git checkout of the
 * Wisp repo, so an update is: fast-forward to what's on GitHub, install dependencies if they
 * changed, rebuild the web app if this checkout serves one, then write a marker file. Every
 * Wisp process running from the checkout watches that marker and restarts itself (through
 * bin/keeper.mjs), so the CLI, the hub's Update button and a device's Update button all end the
 * same way.
 */

/** Exit code a Wisp process uses to ask bin/keeper.mjs to start it again. Keep in sync there. */
export const RESTART_CODE = 75;

/** The Wisp checkout this code runs from. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Written at the end of every update; running hubs and devices restart when it changes. */
const MARKER = ".wisp-updated";

export interface Version {
  /** short commit hash, or null when this isn't a git checkout */
  commit: string | null;
  /** when that commit was made (ISO) */
  date: string | null;
}

export interface UpdateCheck extends Version {
  /** how many commits GitHub has that this checkout doesn't; null when that can't be known */
  behind: number | null;
  /** "abc1234 What changed", newest first */
  changes: string[];
  canUpdate: boolean;
  /** one sentence for people: up to date, what's available, or why updating isn't possible */
  reason: string;
  checkedAt: string;
}

export interface UpdateResult {
  from: string;
  to: string;
  changes: string[];
  /** dependencies were reinstalled */
  installed: boolean;
  /** the web app was rebuilt */
  built: boolean;
}

/** Runs a command and resolves with its output. Swappable in tests. */
export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;

export const run: Runner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which only starts through a shell
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32" && cmd === "npm", windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${(stderr || stdout || err.message).toString().trim().split("\n").slice(-5).join("\n")}`));
      else resolve(stdout.toString().trim());
    });
  });

const git = (root: string, args: string[], runner: Runner, timeoutMs = 30_000) => runner("git", args, { cwd: root, timeoutMs });

function isCheckout(root: string) {
  return fs.existsSync(path.join(root, ".git"));
}

/** The copy inside the desktop app (see apps/desktop/scripts/bundle-wisp.mjs), which updates with the app. */
function isBundled(root: string) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name === "wisp-runtime";
  } catch {
    return false;
  }
}

export async function version(root = REPO_ROOT, runner: Runner = run): Promise<Version> {
  if (!isCheckout(root)) return { commit: null, date: null };
  try {
    const [commit, date] = (await git(root, ["log", "-1", "--format=%h%n%cI"], runner)).split("\n");
    return { commit, date };
  } catch {
    return { commit: null, date: null };
  }
}

/** Ask GitHub (or wherever the checkout was cloned from) what's new. `fetch: false` skips the network. */
export async function checkForUpdate(root = REPO_ROOT, opts: { fetch?: boolean; runner?: Runner } = {}): Promise<UpdateCheck> {
  const runner = opts.runner ?? run;
  const v = await version(root, runner);
  const result = (fields: Partial<UpdateCheck> & { reason: string }): UpdateCheck => ({ ...v, behind: null, changes: [], canUpdate: false, checkedAt: new Date().toISOString(), ...fields });
  if (!isCheckout(root)) {
    return result({
      reason: isBundled(root)
        ? "This copy came with the Wisp app, which updates itself. To check now, choose Check for Updates in the app's menu on that computer."
        : fs.existsSync("/.dockerenv")
        ? "This hub runs in Docker. To update it, run `git pull && docker compose up -d --build` in the folder you cloned Wisp into."
        : "This copy of Wisp isn't a git checkout, so it can't update itself. Clone it with git to get updates.",
    });
  }
  try {
    await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], runner);
  } catch {
    return result({ reason: "This branch doesn't track a branch on GitHub, so there's nothing to update from." });
  }
  if (opts.fetch !== false) {
    try {
      await git(root, ["fetch", "--quiet"], runner, 120_000);
    } catch (e) {
      return result({ reason: `Couldn't reach GitHub: ${(e as Error).message.split("\n").pop()}` });
    }
  }
  const behind = Number(await git(root, ["rev-list", "--count", "HEAD..@{u}"], runner));
  const ahead = Number(await git(root, ["rev-list", "--count", "@{u}..HEAD"], runner));
  const changes = behind ? (await git(root, ["log", "--format=%h %s", "-n", "50", "HEAD..@{u}"], runner)).split("\n").filter(Boolean) : [];
  if (!behind) return result({ behind, reason: "Up to date." });
  const edited = (await git(root, ["diff", "--name-only", "HEAD"], runner)).split("\n").filter(Boolean);
  if (edited.length) return result({ behind, changes, reason: `Files here were changed by hand (${edited.slice(0, 3).join(", ")}${edited.length > 3 ? ", …" : ""}). Commit or undo them, then update.` });
  if (ahead) return result({ behind, changes, reason: "This copy has commits that aren't on GitHub, so it can't update by itself. Merge them by hand." });
  return result({ behind, changes, canUpdate: true, reason: `${behind} update${behind === 1 ? "" : "s"} available.` });
}

/**
 * Bring the checkout up to date. Throws with a readable reason when it can't. If installing
 * dependencies or building fails, the code goes back to where it was, so the running processes
 * and the next restart keep working.
 */
export async function runUpdate(root = REPO_ROOT, opts: { runner?: Runner; log?: (line: string) => void } = {}): Promise<UpdateResult> {
  const runner = opts.runner ?? run;
  const log = opts.log ?? (() => {});
  log("Checking for updates…");
  const check = await checkForUpdate(root, { runner });
  const from = (await version(root, runner)).commit ?? "";
  if (check.behind === 0) return { from, to: from, changes: [], installed: false, built: false };
  if (!check.canUpdate) throw new Error(check.reason);
  log(`Getting ${check.behind} update${check.behind === 1 ? "" : "s"}…`);
  const fromFull = await git(root, ["rev-parse", "HEAD"], runner);
  await git(root, ["merge", "--ff-only", "@{u}"], runner);
  const changed = (await git(root, ["diff", "--name-only", fromFull, "HEAD"], runner)).split("\n").filter(Boolean);
  const installed = changed.some((f) => f === "package-lock.json" || f.endsWith("package.json"));
  const serves = fs.existsSync(path.join(root, "apps/web/dist"));
  const built = serves && (installed || changed.some((f) => f.startsWith("apps/web/") || f.startsWith("packages/core/")));
  try {
    if (installed) {
      log("Installing dependencies…");
      await runner("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, timeoutMs: 20 * 60_000 });
    }
    if (built) {
      log("Building the web app…");
      await runner("npm", ["run", "build"], { cwd: root, timeoutMs: 10 * 60_000 });
    }
  } catch (e) {
    await git(root, ["reset", "--keep", fromFull], runner).catch(() => {});
    throw new Error(`${(e as Error).message}\nWisp went back to ${from}, so nothing changed.`);
  }
  const to = (await version(root, runner)).commit ?? "";
  fs.writeFileSync(path.join(root, MARKER), `${to}\n`);
  log(`Updated to ${to}.`);
  return { from, to, changes: check.changes, installed, built };
}

/**
 * Call `onUpdated` once when this checkout is updated (by any process). Polls, so it works the
 * same on every platform and doesn't keep the process alive.
 */
export function watchForUpdates(onUpdated: () => void, root = REPO_ROOT, intervalMs = 5000): () => void {
  const files = [MARKER, ".warren-updated"].map((name) => path.join(root, name));
  const since = files.map((file) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  let fired = false;
  const listeners = files.map((file, index) => (cur: fs.Stats) => {
    if (fired || cur.mtimeMs <= since[index]) return;
    fired = true;
    stop();
    onUpdated();
  });
  const stop = () => files.forEach((file, index) => fs.unwatchFile(file, listeners[index]));
  files.forEach((file, index) => fs.watchFile(file, { interval: intervalMs, persistent: false }, listeners[index]));
  return stop;
}

/**
 * Whether a keeper (bin/keeper.mjs) started this process and will start it again. If so, exit
 * when the keeper goes away, so a killed keeper never leaves a second copy running.
 */
export function underKeeper(): boolean {
  if (envVar("KEEPER") !== "1" || !process.connected) return false;
  if (!process.listenerCount("disconnect")) process.on("disconnect", () => process.exit(0));
  return true;
}
