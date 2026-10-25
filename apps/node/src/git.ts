import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunWorkspace } from "@wisp/core";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error(`git ${args[0]}: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

const ok = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);
const safeName = (branch: string) => branch.replace(/[^\w.-]+/g, "_");

/** A repo given as a path on this device, or null when it's a URL. */
function localPath(repo: string): string | null {
  if (/^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(repo)) return null;
  return path.resolve(repo.replace(/^~(?=$|\/)/, os.homedir()));
}

/**
 * The repo on this device: the path itself for local repos, or Wisp's own clone for URLs
 * (shared by every agent here, so branches are visible to each other without pushing).
 */
async function repoRoot(dir: string, repo: string): Promise<{ root: string; remote: boolean }> {
  const local = localPath(repo);
  if (local) {
    if (!(await ok(local, ["rev-parse", "--git-dir"]))) throw new Error(`${repo} isn't a git repository on this device`);
    return { root: local, remote: await ok(local, ["remote", "get-url", "origin"]) };
  }
  const root = path.join(dir, "repos", crypto.createHash("sha1").update(repo).digest("hex").slice(0, 12));
  if (!fs.existsSync(path.join(root, ".git"))) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    await git(path.dirname(root), ["clone", "--quiet", repo, root]);
  }
  return { root, remote: true };
}

const hasRef = (root: string, ref: string) => ok(root, ["rev-parse", "--verify", "--quiet", ref]);

/** `origin/<name>` when the remote has it, else the local branch. */
async function bestRef(root: string, remote: boolean, name: string): Promise<string | null> {
  if (await hasRef(root, `refs/heads/${name}`)) return name;
  if (remote && (await hasRef(root, `refs/remotes/origin/${name}`))) return `origin/${name}`;
  return null;
}

/**
 * The directory a coding run works in. "work": the agent's own worktree on the task branch
 * (created from the base branch the first time). "review": a detached checkout of that branch.
 */
export async function prepareCheckout(dir: string, handle: string, w: RunWorkspace): Promise<string> {
  const { root, remote } = await repoRoot(dir, w.repo);
  if (remote) await git(root, ["fetch", "--quiet", "--prune", "origin"]).catch(() => undefined);
  await git(root, ["worktree", "prune"]).catch(() => undefined);
  const wt = path.join(dir, "agents", handle, w.mode === "work" ? "work" : "review", safeName(w.branch));
  const exists = fs.existsSync(path.join(wt, ".git"));
  if (!exists && fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(wt), { recursive: true });

  if (w.mode === "work") {
    // an existing checkout keeps the agent's uncommitted work between runs
    if (exists) return wt;
    if (await hasRef(root, `refs/heads/${w.branch}`)) await git(root, ["worktree", "add", "--quiet", wt, w.branch]);
    else if (remote && (await hasRef(root, `refs/remotes/origin/${w.branch}`))) await git(root, ["worktree", "add", "--quiet", "-b", w.branch, wt, `origin/${w.branch}`]);
    else {
      const base = await bestRef(root, remote, w.base);
      if (!base) throw new Error(`base branch ${w.base} not found in ${w.repo}`);
      await git(root, ["worktree", "add", "--quiet", "-b", w.branch, wt, base]);
    }
    return wt;
  }

  const ref = await bestRef(root, remote, w.branch);
  if (!ref) throw new Error(`branch ${w.branch} isn't in ${w.repo} yet${remote ? " (has it been pushed?)" : ""}`);
  if (exists) await git(wt, ["checkout", "--quiet", "--detach", ref]);
  else await git(root, ["worktree", "add", "--quiet", "--detach", wt, ref]);
  return wt;
}

/**
 * A checkout for an agent that works inside its VM: a clone of its own in the folder the VM
 * shares (a worktree wouldn't do: it points at the device's paths, which the VM doesn't have).
 * Its commits come back to the device's copy with `bringBack`, so reviews and merges see them.
 */
export async function prepareClone(dir: string, into: string, w: RunWorkspace): Promise<string> {
  const { root, remote } = await repoRoot(dir, w.repo);
  if (remote) await git(root, ["fetch", "--quiet", "--prune", "origin"]).catch(() => undefined);
  const wt = path.join(into, "repos", w.mode === "work" ? "work" : "review", safeName(w.branch));
  if (!fs.existsSync(path.join(wt, ".git"))) {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await git(path.dirname(wt), ["clone", "--quiet", "--no-checkout", root, wt]);
    // inside the VM the device's path means nothing: point origin at the real remote, if any
    if (remote) await git(wt, ["remote", "set-url", "origin", w.repo]);
    else await git(wt, ["remote", "remove", "origin"]);
    await git(wt, ["remote", "add", "device", root]);
  }
  await git(wt, ["fetch", "--quiet", "device", "+refs/heads/*:refs/remotes/device/*", "+refs/remotes/origin/*:refs/remotes/device-origin/*"]);
  if (w.mode === "work") {
    if (await hasRef(wt, `refs/heads/${w.branch}`)) {
      // keep the agent's uncommitted work between runs
      if (!(await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).includes(w.branch)) await git(wt, ["checkout", "--quiet", w.branch]);
      return wt;
    }
    const start = (await hasRef(wt, `refs/remotes/device/${w.branch}`))
      ? `device/${w.branch}`
      : (await hasRef(wt, `refs/remotes/device/${w.base}`))
        ? `device/${w.base}`
        : (await hasRef(wt, `refs/remotes/device-origin/${w.base}`))
          ? `device-origin/${w.base}`
          : null;
    if (!start) throw new Error(`base branch ${w.base} not found in ${w.repo}`);
    await git(wt, ["checkout", "--quiet", "-b", w.branch, start]);
    return wt;
  }
  const ref = await bestRef(root, remote, w.branch);
  if (!ref) throw new Error(`branch ${w.branch} isn't in ${w.repo} yet${remote ? " (has it been pushed?)" : ""}`);
  await git(wt, ["checkout", "--quiet", "--detach", ref.startsWith("origin/") ? `device-origin/${ref.slice(7)}` : `device/${ref}`]);
  return wt;
}

/** After a run in a VM: the branch's commits go to the device's copy of the repo. */
export async function bringBack(dir: string, clone: string, w: RunWorkspace): Promise<void> {
  if (w.mode !== "work" || !(await hasRef(clone, `refs/heads/${w.branch}`))) return;
  const { root } = await repoRoot(dir, w.repo);
  // never move a branch someone has checked out on the device
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  if (list.includes(`branch refs/heads/${w.branch}\n`) || list.endsWith(`branch refs/heads/${w.branch}`)) return;
  await git(root, ["fetch", "--quiet", clone, `+refs/heads/${w.branch}:refs/heads/${w.branch}`]);
}

/**
 * Merge `branch` into `base` without touching anyone's working copy: the merge happens in a
 * temporary worktree, then goes to the remote, or (for a local repo) moves the base branch,
 * fast-forwarding the checkout that has it when that checkout is clean.
 */
export async function mergeBranch(dir: string, w: { repo: string; branch: string; base: string }): Promise<string> {
  const { root, remote } = await repoRoot(dir, w.repo);
  if (remote) await git(root, ["fetch", "--quiet", "--prune", "origin"]).catch(() => undefined);
  const from = await bestRef(root, remote, w.branch);
  if (!from) throw new Error(`branch ${w.branch} not found${remote ? " (has it been pushed?)" : ""}`);
  const onto = remote && (await hasRef(root, `refs/remotes/origin/${w.base}`)) ? `origin/${w.base}` : w.base;
  if (!(await hasRef(root, onto))) throw new Error(`base branch ${w.base} not found`);

  const tmp = path.join(dir, "merges", `${safeName(w.branch)}-${Date.now()}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await git(root, ["worktree", "add", "--quiet", "--detach", tmp, onto]);
  try {
    // commits need an identity; use the device's, or Wisp's when it has none
    const who = (await ok(tmp, ["config", "user.email"])) ? [] : ["-c", "user.name=Wisp", "-c", "user.email=wisp@localhost"];
    try {
      await git(tmp, [...who, "merge", "--no-ff", "--no-edit", "-m", `Merge ${w.branch} into ${w.base}`, from]);
    } catch (e) {
      await git(tmp, ["merge", "--abort"]).catch(() => undefined);
      throw new Error(`${w.branch} doesn't merge cleanly into ${w.base}; it needs the conflicts fixed on the branch first.\n${(e as Error).message}`);
    }
    const sha = await git(tmp, ["rev-parse", "HEAD"]);
    if (remote) {
      await git(tmp, ["push", "--quiet", "origin", `HEAD:refs/heads/${w.base}`]);
      return `Merged ${w.branch} into ${w.base} (${sha.slice(0, 8)}) and pushed it.`;
    }
    // a local repo: if someone has the base branch checked out, only a clean fast-forward is safe
    const list = await git(root, ["worktree", "list", "--porcelain"]);
    const holder = list
      .split("\n\n")
      .map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch (.+)$/m)?.[1] }))
      .find((b) => b.branch === `refs/heads/${w.base}`);
    if (holder?.path) {
      if (await git(holder.path, ["status", "--porcelain", "--untracked-files=no"])) throw new Error(`${w.base} is checked out at ${holder.path} with uncommitted changes. Commit or stash them, then run there: git merge ${w.branch}`);
      await git(holder.path, ["merge", "--quiet", "--ff-only", sha]);
    } else {
      const old = await git(root, ["rev-parse", `refs/heads/${w.base}`]);
      await git(root, ["update-ref", `refs/heads/${w.base}`, sha, old]);
    }
    return `Merged ${w.branch} into ${w.base} (${sha.slice(0, 8)}).`;
  } finally {
    await git(root, ["worktree", "remove", "--force", tmp]).catch(() => fs.rmSync(tmp, { recursive: true, force: true }));
  }
}
