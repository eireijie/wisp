import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkForUpdate, run, runUpdate, version, watchForUpdates, type Runner } from "../src/index.ts";

// Each test gets a GitHub stand-in (a bare repo), an "upstream" clone to publish changes from,
// and the install being updated. npm is faked; git is real.
let dir: string;
let upstream: string;
let install: string;
let npm: string[][];
let npmFails: boolean;

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const runner: Runner = async (cmd, args, opts) => {
  if (cmd !== "npm") return run(cmd, args, opts);
  npm.push(args);
  if (npmFails) throw new Error("npm install failed: no network");
  return "";
};

function publish(files: Record<string, string>, message: string) {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(upstream, f)), { recursive: true });
    fs.writeFileSync(path.join(upstream, f), content);
  }
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", message);
  git(upstream, "push", "-q");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "warren-update-"));
  const origin = path.join(dir, "origin.git");
  upstream = path.join(dir, "upstream");
  install = path.join(dir, "install");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, upstream);
  git(upstream, "checkout", "-q", "-b", "main");
  publish({ "README.md": "v1\n", "package-lock.json": "{}\n", "apps/web/src/app.ts": "1\n" }, "First");
  git(dir, "clone", "-q", origin, install);
  npm = [];
  npmFails = false;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("checkForUpdate", () => {
  it("says when there's nothing new", async () => {
    const c = await checkForUpdate(install, { runner });
    expect(c).toMatchObject({ behind: 0, canUpdate: false, reason: "Up to date." });
    expect(c.commit).toBe(git(install, "rev-parse", "--short", "HEAD"));
  });

  it("lists what's new", async () => {
    publish({ "README.md": "v2\n" }, "Better docs");
    const c = await checkForUpdate(install, { runner });
    expect(c).toMatchObject({ behind: 1, canUpdate: true, reason: "1 update available." });
    expect(c.changes[0]).toMatch(/^[0-9a-f]+ Better docs$/);
  });

  it("won't update over files changed by hand", async () => {
    publish({ "README.md": "v2\n" }, "Better docs");
    fs.writeFileSync(path.join(install, "README.md"), "my edit\n");
    const c = await checkForUpdate(install, { runner });
    expect(c.canUpdate).toBe(false);
    expect(c.reason).toContain("changed by hand (README.md)");
    await expect(runUpdate(install, { runner })).rejects.toThrow("changed by hand");
  });

  it("explains a copy that isn't a git checkout", async () => {
    const plain = fs.mkdtempSync(path.join(dir, "plain-"));
    const c = await checkForUpdate(plain, { runner });
    expect(c).toMatchObject({ commit: null, canUpdate: false });
    expect(c.reason).toMatch(/git/);
  });
});

describe("runUpdate", () => {
  it("fast-forwards and marks the update, skipping npm when dependencies didn't change", async () => {
    const before = (await version(install, runner)).commit;
    publish({ "README.md": "v2\n" }, "Better docs");
    const r = await runUpdate(install, { runner });
    expect(r).toMatchObject({ from: before, installed: false, built: false });
    expect(r.to).toBe(git(upstream, "rev-parse", "--short", "HEAD"));
    expect(npm).toEqual([]);
    expect(fs.readFileSync(path.join(install, ".warren-updated"), "utf8").trim()).toBe(r.to);
  });

  it("installs dependencies, and rebuilds the web app on a hub", async () => {
    fs.mkdirSync(path.join(install, "apps/web/dist"), { recursive: true });
    publish({ "package-lock.json": '{"v":2}\n' }, "New dependency");
    const r = await runUpdate(install, { runner });
    expect(r).toMatchObject({ installed: true, built: true });
    expect(npm).toEqual([["install", "--no-audit", "--no-fund"], ["run", "build"]]);
  });

  it("doesn't build on a device, which has no web app", async () => {
    publish({ "apps/web/src/app.ts": "2\n" }, "New screen");
    expect(await runUpdate(install, { runner })).toMatchObject({ installed: false, built: false });
  });

  it("goes back to the old code when installing fails", async () => {
    const before = git(install, "rev-parse", "HEAD");
    publish({ "package-lock.json": '{"v":2}\n' }, "New dependency");
    npmFails = true;
    await expect(runUpdate(install, { runner })).rejects.toThrow(/went back to/);
    expect(git(install, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(install, ".warren-updated"))).toBe(false);
  });

  it("does nothing when already up to date", async () => {
    const r = await runUpdate(install, { runner });
    expect(r.from).toBe(r.to);
    expect(fs.existsSync(path.join(install, ".warren-updated"))).toBe(false);
  });
});

describe("watchForUpdates", () => {
  it("fires once when this checkout is updated", async () => {
    let calls = 0;
    const stop = watchForUpdates(() => calls++, install, 20);
    publish({ "README.md": "v2\n" }, "Better docs");
    await runUpdate(install, { runner });
    await new Promise((r) => setTimeout(r, 150));
    stop();
    expect(calls).toBe(1);
  });
});
