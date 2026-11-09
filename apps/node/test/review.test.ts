import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { branchDiff, branchFiles, runChecks } from "../src/review.ts";

/** A repo with main, and a task branch checked out in its own worktree with uncommitted work. */
let dir: string;
let repo: string;
let work: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-review-"));
  repo = path.join(dir, "shop");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "cart.js"), "export const total = (xs) => xs.length;\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"console.log('bad'); process.exit(1)\"" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  work = path.join(dir, "work");
  git(repo, "worktree", "add", "-q", "-b", "wisp/harry/discount", work, "main");
  fs.writeFileSync(path.join(work, "discount.js"), "export const off = 0.1;\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "discount");
  // not committed yet
  fs.writeFileSync(path.join(work, "cart.js"), "export const total = (xs) => xs.length * 2;\n");
});

const w = () => ({ repo, branch: "wisp/harry/discount", base: "main" });

describe("a task branch, read on the device", () => {
  it("shows what the branch changed, uncommitted work included", async () => {
    const d = await branchDiff(dir, w());
    expect(d.ahead).toBe(1);
    expect(d.uncommitted).toBe(true);
    expect(d.files).toEqual(
      expect.arrayContaining([
        { path: "discount.js", add: 1, del: 0, status: "A" },
        { path: "cart.js", add: 1, del: 1, status: "M" },
      ]),
    );
    expect(d.patch).toContain("+export const off = 0.1;");
    expect(d.truncated).toBe(false);
  });

  it("lists its files and reads one, but nothing outside the repo", async () => {
    const t = await branchFiles(dir, w());
    expect("tree" in t && t.tree).toEqual(["cart.js", "discount.js", "package.json"]);
    const f = await branchFiles(dir, { ...w(), file: "cart.js" });
    expect("text" in f && f.text).toContain("* 2");
    await expect(branchFiles(dir, { ...w(), file: "../shop/.git/config" })).rejects.toThrow(/isn't in the repo/);
  });

  it("runs the package's checks and says which failed", async () => {
    const r = await runChecks(dir, w());
    expect(r.map((c) => [c.name, c.ok])).toEqual([
      ["lint", false],
      ["test", true],
    ]);
    expect(r[0].output).toContain("bad");
  }, 60_000);

  it("says plainly when a branch isn't there", async () => {
    await expect(branchDiff(dir, { ...w(), branch: "nope" })).rejects.toThrow(/isn't on this device yet/);
  });
});
