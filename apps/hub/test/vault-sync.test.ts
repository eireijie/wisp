import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

// real git over real HTTP, several round trips per push
vi.setConfig({ testTimeout: 30_000 });

let tmp: string;
let base: string;
let hub: Awaited<ReturnType<typeof buildHub>>["hub"];
let close: () => Promise<void>;
let owner: string;
let sam: string;
let samId: string;
let ownerId: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null) as T };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Laptop", GIT_AUTHOR_EMAIL: "laptop@example.com", GIT_COMMITTER_NAME: "Laptop", GIT_COMMITTER_EMAIL: "laptop@example.com" };
const run = promisify(execFile);
// asynchronous on purpose: the hub runs in this process and has to answer git while we wait
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: GIT_ENV, encoding: "utf8" })).stdout.trim();
}
/** Run git and return what it said instead of throwing. */
async function tryGit(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, ...args) };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
const remote = (token: string) => `http://warren:${token}@${base.replace("http://", "")}/git/vault.git`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error("timed out");
}

let ownerToken: string;
let clone: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warren-sync-"));
  delete process.env.WARREN_VAULT_DIR;
  const built = await buildHub({ dataDir: path.join(tmp, "data") });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  ownerId = (await api("GET", "/api/me")).data.user.id;
  const invite = (await api("POST", "/api/invites", { role: "member" })).data;
  sam = (await api("POST", "/api/invites/accept", { code: invite.code, name: "Sam", email: "sam@example.com", password: "password123" }, "")).data.token;
  samId = (await api("GET", "/api/me", undefined, sam)).data.user.id;
  await api("PUT", "/api/vault/note", { path: "shared/hello.md", content: "# Hello\nfirst note\n" });
  await api("PUT", "/api/vault/note", { path: "shared/plan.md", content: "# Plan\nship it\n" });
  ownerToken = (await api("POST", "/api/memory/tokens", { label: "Laptop" })).data.token;
  clone = path.join(tmp, "laptop");
});

afterAll(async () => {
  await close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("memory over git", () => {
  it("needs a sync token: nothing is served without one", async () => {
    const none = await fetch(`${base}/git/vault.git/info/refs?service=git-upload-pack`);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Basic/);
    // a normal sign-in token isn't a sync token
    const session = await fetch(`${base}/git/vault.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${owner}` } });
    expect(session.status).toBe(401);
    const bad = await tryGit(tmp, "clone", "-q", remote("wr_sync_nope"), path.join(tmp, "bad"));
    expect(bad.ok).toBe(false);
    // only the smart protocol: no raw files
    expect((await fetch(`${base}/git/vault.git/HEAD`, { headers: { authorization: `Basic ${Buffer.from("x:" + ownerToken).toString("base64")}` } })).status).toBe(404);
    expect((await fetch(`${base}/git/vault.git/info/refs`, { headers: { authorization: `Basic ${Buffer.from("x:" + ownerToken).toString("base64")}` } })).status).toBe(403);
  });

  it("clones the vault with its notes and leaves Obsidian's own settings out", async () => {
    await git(tmp, "clone", "-q", remote(ownerToken), clone);
    expect(fs.readFileSync(path.join(clone, "shared/hello.md"), "utf8")).toContain("first note");
    expect(fs.readFileSync(path.join(clone, ".gitignore"), "utf8")).toContain(".obsidian/");
    expect((await git(clone, "log", "--format=%an")).split("\n")).toContain("Alex");
  });

  it("takes a push from Obsidian, credits the person in Activity, and indexes the note", async () => {
    await git(clone, "config", "user.name", "Laptop");
    fs.writeFileSync(path.join(clone, "shared/hello.md"), "# Hello\nedited on the laptop\n");
    fs.writeFileSync(path.join(clone, "shared/new.md"), "# New\nwritten in Obsidian #fromlaptop\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "Laptop edits");
    await git(clone, "push", "-q", "origin", "HEAD");

    expect((await api("GET", "/api/vault/note?path=shared/hello.md")).data.content).toContain("edited on the laptop");
    expect((await api<any[]>("GET", "/api/vault/search?q=fromlaptop")).data.map((h) => h.path)).toEqual(["shared/new.md"]);
    const changes = (await api<any[]>("GET", "/api/vault/changes")).data;
    expect(changes[0]).toMatchObject({ author: "Alex", message: "Laptop edits" });
    expect(changes[0].files.map((f: any) => f.path).sort()).toEqual(["shared/hello.md", "shared/new.md"]);
    expect((await api<any[]>("GET", "/api/vault/history?path=shared/new.md")).data[0].author).toBe("Alex");
    // the line-by-line view says the same
    expect((await api<any[]>("GET", "/api/vault/blame?path=shared/new.md")).data[0].author).toBe("Alex");
    // and the vault on disk is at the pushed commit, with a clean working folder
    expect(await git(hub.vaults.primary.root, "rev-parse", "HEAD")).toBe(await git(clone, "rev-parse", "HEAD"));
    expect(await git(hub.vaults.primary.root, "status", "--porcelain")).toBe("");
  });

  it("handles big pushes and pulls (git compresses these requests)", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} of a long meeting transcript ${Math.random()}`).join("\n");
    fs.writeFileSync(path.join(clone, "shared/big.md"), `# Big\n${big}\n`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "A long transcript");
    await git(clone, "push", "-q", "origin", "HEAD");
    expect((await api("GET", "/api/vault/note?path=shared/big.md")).data.content.length).toBeGreaterThan(200_000);
    const again = path.join(tmp, "again");
    await git(tmp, "clone", "-q", remote(ownerToken), again);
    expect(fs.readFileSync(path.join(again, "shared/big.md"), "utf8")).toHaveLength(fs.readFileSync(path.join(clone, "shared/big.md"), "utf8").length);
  });

  it("pulls what agents and people wrote in Warren", async () => {
    await api("PUT", "/api/vault/note", { path: "shared/from-warren.md", content: "# From Warren\n" });
    await git(clone, "pull", "-q", "--ff-only");
    expect(fs.existsSync(path.join(clone, "shared/from-warren.md"))).toBe(true);
  });

  it("refuses a push that isn't up to date, and one that touches hidden files, links or other branches", async () => {
    // not up to date: Warren has a newer commit than this clone
    fs.writeFileSync(path.join(clone, "shared/stale.md"), "stale\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "stale");
    await api("PUT", "/api/vault/note", { path: "shared/newer.md", content: "# Newer\n" });
    const stale = await tryGit(clone, "push", "origin", "HEAD");
    expect(stale.ok).toBe(false);
    expect(stale.out).toMatch(/rejected|failed to push|fetch first|non-fast-forward|stale/i);
    await git(clone, "pull", "-q", "--no-rebase", "--no-edit");
    await git(clone, "push", "-q", "origin", "HEAD");
    expect(await api("GET", "/api/vault/note?path=shared/stale.md")).toMatchObject({ status: 200 });

    // hidden files stay on the laptop
    fs.mkdirSync(path.join(clone, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(clone, ".obsidian/app.json"), "{}");
    await git(clone, "add", "-f", ".obsidian/app.json");
    await git(clone, "commit", "-q", "-m", "settings");
    const hidden = await tryGit(clone, "push", "origin", "HEAD");
    expect(hidden.ok).toBe(false);
    expect(hidden.out).toMatch(/hidden file or folder/);
    await git(clone, "reset", "-q", "--hard", "HEAD~1");

    // links could point outside the vault
    fs.symlinkSync("/etc/passwd", path.join(clone, "shared/passwd.md"));
    await git(clone, "add", "-A");
    await git(clone, "commit", "-q", "-m", "link");
    const link = await tryGit(clone, "push", "origin", "HEAD");
    expect(link.ok).toBe(false);
    expect(link.out).toMatch(/link or a nested repository/);
    await git(clone, "reset", "-q", "--hard", "HEAD~1");

    // only the vault's branch, and never deleted
    const other = await tryGit(clone, "push", "origin", "HEAD:refs/heads/side");
    expect(other.ok).toBe(false);
    expect(other.out).toMatch(/only the .* branch can be pushed/);
    const branch = await git(clone, "branch", "--show-current");
    expect((await tryGit(clone, "push", "origin", `:${branch}`)).ok).toBe(false);
    expect(fs.existsSync(path.join(hub.vaults.primary.root, "shared/passwd.md"))).toBe(false);
    expect(fs.existsSync(path.join(hub.vaults.primary.root, ".obsidian"))).toBe(false);
    // nothing odd got into the vault
    expect(await git(hub.vaults.primary.root, "status", "--porcelain")).toBe("");
  });

  it("only lets people who can read everything clone, and holds their pushes to what they can edit", async () => {
    // Sam is a member: he can read all of memory today, so he can sync
    const samToken = (await api("POST", "/api/memory/tokens", { label: "Sam's Mac" }, sam)).data.token;
    expect(samToken).toBeTruthy();
    // lock one folder for Sam to reading only
    await api("PUT", "/api/vault/note", { path: "team/charter.md", content: "# Charter\nrules\n" });
    const rule = await api("PUT", "/api/access", { path: "team", subject: { kind: "user", id: samId }, level: "read" });
    expect(rule.status, JSON.stringify(rule.data)).toBe(200);
    expect((await api("GET", "/api/vault/note?path=team/charter.md", undefined, sam)).data.access).toBe("read");
    const mine = path.join(tmp, "sam");
    await git(tmp, "clone", "-q", remote(samToken), mine);
    expect(fs.existsSync(path.join(mine, "team/charter.md"))).toBe(true);

    fs.writeFileSync(path.join(mine, "team/charter.md"), "# Charter\nSam changed the rules\n");
    await git(mine, "add", "-A");
    await git(mine, "commit", "-q", "-m", "tweak charter");
    const blocked = await tryGit(mine, "push", "origin", "HEAD");
    expect(blocked.ok).toBe(false);
    expect(blocked.out).toMatch(/you can't edit team\/charter\.md/);
    expect((await api("GET", "/api/vault/note?path=team/charter.md")).data.content).not.toContain("Sam changed");
    await git(mine, "reset", "-q", "--hard", "HEAD~1");

    // somewhere he can edit works, and Activity says Sam
    fs.writeFileSync(path.join(mine, "shared/sam.md"), "# Sam\nhi from Sam\n");
    await git(mine, "add", "-A");
    await git(mine, "commit", "-q", "-m", "Sam's note");
    await git(mine, "push", "-q", "origin", "HEAD");
    expect((await api<any[]>("GET", "/api/vault/changes")).data[0]).toMatchObject({ author: "Sam" });

    // a note Sam can't read means Sam can't clone or pull any more, and the tokens stop working
    await api("PUT", "/api/vault/note", { path: "private/ideas.md", content: "# Ideas\n" });
    await api("PUT", "/api/access", { path: "private", subject: { kind: "user", id: samId }, level: "none" });
    const denied = await fetch(`${base}/git/vault.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${Buffer.from("x:" + samToken).toString("base64")}` } });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toMatch(/Ask an owner/);
    expect((await tryGit(mine, "pull", "-q")).ok).toBe(false);
    expect((await api("POST", "/api/memory/tokens", {}, sam)).status).toBe(403);
    expect((await api("GET", "/api/memory/storage", undefined, sam)).data.sync.allowed).toBe(false);
    // and the owner still can
    expect((await tryGit(clone, "pull", "-q", "--no-rebase", "--no-edit")).ok).toBe(true);
    expect(fs.existsSync(path.join(clone, "private/ideas.md"))).toBe(true);
  });

  it("keeps guests out and stops working when a token is revoked or the person leaves", async () => {
    const invite = (await api("POST", "/api/invites", { role: "guest" })).data;
    const guest = (await api("POST", "/api/invites/accept", { code: invite.code, name: "Gus", email: "gus@example.com", password: "password123" }, "")).data.token;
    expect((await api("POST", "/api/memory/tokens", {}, guest)).status).toBe(403);

    const t = (await api("POST", "/api/memory/tokens", { label: "temp" })).data;
    const url = `${base}/git/vault.git/info/refs?service=git-upload-pack`;
    const auth = (token: string) => ({ authorization: `Basic ${Buffer.from("x:" + token).toString("base64")}` });
    expect((await fetch(url, { headers: auth(t.token) })).status).toBe(200);
    const listed = (await api("GET", "/api/memory/storage")).data.tokens;
    expect(listed.map((x: any) => x.label)).toContain("temp");
    expect(JSON.stringify(listed)).not.toContain(t.token);
    expect((await api("DELETE", `/api/memory/tokens/${t.id}`)).status).toBe(200);
    expect((await fetch(url, { headers: auth(t.token) })).status).toBe(401);
    // one person can't remove another's token
    expect((await api("DELETE", `/api/memory/tokens/${listed[0].id}`, undefined, sam)).status).toBe(404);
    void ownerId;
  });
});

describe("edits made in Obsidian on this machine", () => {
  it("show up in Warren, credited to Obsidian, without looping on Warren's own saves", async () => {
    const root = hub.vaults.primary.root;
    fs.mkdirSync(path.join(root, "Projects"), { recursive: true });
    fs.writeFileSync(path.join(root, "Projects/Idea.md"), "# Idea\nwritten straight to disk zebrafinch\n");
    await waitFor(async () => (await api<any[]>("GET", "/api/vault/search?q=zebrafinch")).data.length > 0);
    const changes = (await api<any[]>("GET", "/api/vault/changes")).data;
    expect(changes[0]).toMatchObject({ author: "Edited in Obsidian" });
    expect(changes[0].files[0].path).toBe("Projects/Idea.md");

    // Warren's own save is not mistaken for an outside edit
    const before = await git(root, "rev-list", "--count", "HEAD");
    await api("PUT", "/api/vault/note", { path: "shared/agent-note.md", content: "# Agent\nsaved by Warren\n" });
    await sleep(2500);
    expect(Number(await git(root, "rev-list", "--count", "HEAD"))).toBe(Number(before) + 1);
    expect(await git(root, "log", "-1", "--format=%an")).toBe("Alex");

    // editing and deleting in Warren (the web app's Save and Delete) don't add outside-edit commits either
    const n = Number(await git(root, "rev-list", "--count", "HEAD"));
    await api("PUT", "/api/vault/note", { path: "shared/agent-note.md", content: "# Agent\nfixed by a person" });
    await api("DELETE", "/api/vault/note?path=shared/agent-note.md");
    await sleep(2500);
    expect(Number(await git(root, "rev-list", "--count", "HEAD"))).toBe(n + 2);
    expect(await git(root, "log", "-2", "--format=%an")).toBe("Alex\nAlex");

    // deleting in Obsidian removes it from search too
    fs.rmSync(path.join(root, "Projects/Idea.md"));
    await waitFor(async () => (await api<any[]>("GET", "/api/vault/search?q=zebrafinch")).data.length === 0);
  }, 30_000);
});

describe("where memory lives", () => {
  it("shows the folder to the owner only, and refuses folders that would hold Warren's own data", async () => {
    const s = (await api("GET", "/api/memory/storage")).data;
    expect(s).toMatchObject({ path: hub.vaults.primary.root, source: "default", pendingRestart: false, sync: { allowed: true, urlPath: "/git/vault.git" } });
    expect((await api("GET", "/api/memory/storage", undefined, sam)).data.path).toBeNull();
    expect((await api("PUT", "/api/memory/storage", { path: path.join(tmp, "x") }, sam)).status).toBe(403);
    for (const bad of ["/", os.homedir(), path.join(tmp, "data"), tmp, "relative/not/ok"]) {
      expect((await api("PUT", "/api/memory/storage", { path: bad })).status, bad).toBe(400);
    }
    const target = path.join(tmp, "my-obsidian-vault");
    const set = await api("PUT", "/api/memory/storage", { path: target });
    expect(set.data).toMatchObject({ setting: target, pendingRestart: true, path: hub.vaults.primary.root });
    expect((await api("PUT", "/api/memory/storage", { path: null })).data).toMatchObject({ setting: null, pendingRestart: false });
  });
});
