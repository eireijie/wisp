import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { branchHome } from "./git.ts";

/**
 * The review side of the Code mod, read from the repo on this device: what a branch changed
 * (with what's not committed yet in the agent's own checkout), its files, and its checks.
 */

const exec = promisify(execFile);
const PATCH_MAX = 400 * 1024;
const FILE_MAX = 256 * 1024;

async function git(cwd: string, args: string[], max = 16 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: max });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]}: ${(err.stderr || err.message).trim()}`);
  }
}

export interface ChangedFile {
  path: string;
  add: number;
  del: number;
  /** A added, D deleted, M modified, R renamed */
  status: string;
}

export interface BranchDiff {
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
  /** commits on the branch that the base doesn't have */
  ahead: number;
  /** changes in the agent's checkout it hasn't committed yet */
  uncommitted: boolean;
}

/** What `branch` changed since it left `base`, including the agent's uncommitted work. */
export async function branchDiff(dir: string, w: { repo: string; branch: string; base: string }): Promise<BranchDiff> {
  const home = await branchHome(dir, w);
  const base = await git(home.root, ["merge-base", home.base, home.branch]).then((s) => s.trim());
  const ahead = Number((await git(home.root, ["rev-list", "--count", `${base}..${home.branch}`])).trim()) || 0;
  // in the agent's own checkout: committed and not yet committed, against where the branch began
  const cwd = home.checkout ?? home.root;
  const range = home.checkout ? [base] : [base, home.branch];
  const uncommitted = home.checkout ? (await git(home.checkout, ["status", "--porcelain", "--untracked-files=no"])).trim().length > 0 : false;
  const numstat = await git(cwd, ["diff", "--numstat", "-M", ...range]);
  const names = await git(cwd, ["diff", "--name-status", "-M", ...range]);
  const status = new Map<string, string>();
  for (const line of names.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    status.set(parts.at(-1)!, parts[0][0]);
  }
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split("\t");
      const p = rest.join("\t").replace(/^.*\{(.*) => (.*)\}(.*)$/, (_m, _from, to, tail) => to + tail).replace(/^.* => /, "");
      return { path: p, add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d), status: status.get(p) ?? "M" };
    });
  let patch = await git(cwd, ["diff", "-M", "--no-color", ...range], 64 * 1024 * 1024);
  const truncated = patch.length > PATCH_MAX;
  if (truncated) patch = patch.slice(0, PATCH_MAX);
  return { files, patch, truncated, ahead, uncommitted };
}

/** Every file on the branch (as the agent has it now), or one file's text. */
export async function branchFiles(dir: string, w: { repo: string; branch: string; base: string; file?: string }): Promise<{ tree: string[] } | { file: string; text: string; truncated: boolean; binary: boolean }> {
  const home = await branchHome(dir, w);
  if (w.file !== undefined) {
    const file = w.file.replace(/^\/+/, "");
    if (!file || file.split("/").some((p) => p === ".." || p === ".git")) throw new Error("that file isn't in the repo");
    let buf: Buffer;
    if (home.checkout) {
      const full = path.resolve(home.checkout, file);
      if (!full.startsWith(path.resolve(home.checkout) + path.sep)) throw new Error("that file isn't in the repo");
      buf = fs.readFileSync(full);
    } else buf = Buffer.from(await git(home.root, ["show", `${home.branch}:${file}`], 64 * 1024 * 1024), "utf8");
    const binary = buf.subarray(0, 8000).includes(0);
    return { file, text: binary ? "" : buf.subarray(0, FILE_MAX).toString("utf8"), truncated: buf.length > FILE_MAX, binary };
  }
  const listed = home.checkout ? await git(home.checkout, ["ls-files", "--cached", "--others", "--exclude-standard"]) : await git(home.root, ["ls-tree", "-r", "--name-only", home.branch]);
  return { tree: listed.split("\n").filter(Boolean).sort().slice(0, 5000) };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** the end of what it printed */
  output: string;
  ms: number;
}

/** The package.json scripts that count as checks, in the order a person would run them. */
export const CHECK_SCRIPTS = ["typecheck", "lint", "test", "build"];

/**
 * Run the branch's checks in the agent's checkout: its package.json scripts for types, lint,
 * tests and build, one after another. Only the computer's owner asks for this.
 */
export async function runChecks(dir: string, w: { repo: string; branch: string; base: string }, timeoutMs = 10 * 60_000): Promise<CheckResult[]> {
  const home = await branchHome(dir, w);
  const cwd = home.checkout;
  if (!cwd) throw new Error("the branch has no checkout on this device yet; checks run once its agent has worked on it here");
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    throw new Error("no package.json in the repo, so there are no checks to run yet");
  }
  const names = CHECK_SCRIPTS.filter((s) => typeof scripts[s] === "string");
  if (!names.length) throw new Error(`package.json has none of these scripts: ${CHECK_SCRIPTS.join(", ")}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const out: CheckResult[] = [];
  for (const name of names) {
    const started = Date.now();
    try {
      const r = await exec(npm, ["run", "--silent", name], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
      out.push({ name, ok: true, output: tail(`${r.stdout}\n${r.stderr}`), ms: Date.now() - started });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean; message: string };
      out.push({ name, ok: false, output: tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.killed ? "stopped: took too long" : ""}`) || err.message, ms: Date.now() - started });
    }
  }
  return out;
}

function tail(s: string, lines = 40) {
  return s.trim().split("\n").slice(-lines).join("\n").slice(-6000);
}
