import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeBranch, prepareCheckout } from "../../node/src/git.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
let tmp: string;
let dir: string; // the device's warren dir

/** A repo with one commit on main. */
function makeRepo(at: string) {
  fs.mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(at, "README.md"), "hello\n");
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "init");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warren-git-"));
  dir = path.join(tmp, "device");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("coding checkouts", () => {
  it("works on a branch of a local repo, reviews it read-only, and merges it into the checked-out base", async () => {
    const repo = path.join(tmp, "app");
    makeRepo(repo);
    const w = { repo, branch: "warren/nova/login", base: "main" };
    const wt = await prepareCheckout(dir, "nova", { ...w, mode: "work" });
    expect(git(wt, "branch", "--show-current")).toBe("warren/nova/login");
    fs.writeFileSync(path.join(wt, "login.ts"), "export {};\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "add login");
    // a second run reuses the same checkout
    expect(await prepareCheckout(dir, "nova", { ...w, mode: "work" })).toBe(wt);

    const review = await prepareCheckout(dir, "rex", { ...w, mode: "review" });
    expect(fs.existsSync(path.join(review, "login.ts"))).toBe(true);
    expect(git(review, "branch", "--show-current")).toBe("");

    const out = await mergeBranch(dir, w);
    expect(out).toMatch(/^Merged warren\/nova\/login into main/);
    // the user's checkout of main was clean, so it moved forward too
    expect(fs.existsSync(path.join(repo, "login.ts"))).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("won't touch a base checkout with uncommitted changes", async () => {
    const repo = path.join(tmp, "app");
    makeRepo(repo);
    const w = { repo, branch: "warren/a/x", base: "main" };
    const wt = await prepareCheckout(dir, "a", { ...w, mode: "work" });
    fs.writeFileSync(path.join(wt, "x.txt"), "x\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "x");
    fs.writeFileSync(path.join(repo, "README.md"), "edited but not committed\n");
    await expect(mergeBranch(dir, w)).rejects.toThrow(/uncommitted changes/);
    expect(fs.existsSync(path.join(repo, "x.txt"))).toBe(false);
  });

  it("clones a remote repo, and merges by pushing to it", async () => {
    const origin = path.join(tmp, "origin.git");
    const seed = path.join(tmp, "seed");
    makeRepo(seed);
    git(tmp, "clone", "-q", "--bare", seed, origin);
    const w = { repo: `file://${origin}`, branch: "warren/nova/api", base: "main" };
    const wt = await prepareCheckout(dir, "nova", { ...w, mode: "work" });
    fs.writeFileSync(path.join(wt, "api.ts"), "export {};\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "api");
    git(wt, "push", "-q", "origin", "warren/nova/api");
    expect(await mergeBranch(dir, w)).toMatch(/and pushed it\.$/);
    expect(git(origin, "show", "main:api.ts")).toBe("export {};");
  });

  it("explains a branch that isn't there", async () => {
    const repo = path.join(tmp, "app");
    makeRepo(repo);
    await expect(prepareCheckout(dir, "rex", { repo, branch: "nope", base: "main", mode: "review" })).rejects.toThrow(/isn't in/);
    await expect(prepareCheckout(dir, "rex", { repo: path.join(tmp, "missing"), branch: "b", base: "main", mode: "work" })).rejects.toThrow(/isn't a git repository/);
  });
});
