import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import { carryOverVault, resolveVaultLocation, saveVaultLocation, vaultDirProblem } from "../src/vault-location.ts";

let tmp: string;
let data: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wisp-where-")));
  data = path.join(tmp, "data");
  delete process.env.WISP_VAULT_DIR;
});
afterEach(() => {
  delete process.env.WISP_VAULT_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start a hub on a folder, sign up, run `fn`, stop it. */
async function withHub<T>(fn: (h: { hub: Awaited<ReturnType<typeof buildHub>>["hub"]; api: (m: string, u: string, b?: unknown) => Promise<any> }) => Promise<T>, existing = false): Promise<T> {
  const built = await buildHub({ dataDir: data });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  let token = "";
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  try {
    const r = existing ? await api("POST", "/api/auth/login", { email: "me@example.com", password: "password123", features: "everything" }) : await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", workspaceName: "Lab" });
    token = r.token;
    return await fn({ hub: built.hub, api });
  } finally {
    await built.app.close();
  }
}

describe("choosing the memory folder", () => {
  it("defaults to <data>/vault, and WISP_VAULT_DIR or a saved choice moves it", () => {
    expect(resolveVaultLocation(data)).toMatchObject({ path: path.join(data, "vault"), source: "default" });
    const mine = path.join(tmp, "Notes");
    expect(saveVaultLocation(data, mine)).toEqual({ ok: true });
    expect(resolveVaultLocation(data)).toMatchObject({ path: mine, source: "setting", setting: mine });
    const other = path.join(tmp, "Other");
    expect(resolveVaultLocation(data, { WISP_VAULT_DIR: other })).toMatchObject({ path: other, source: "env", setting: mine });
    expect(saveVaultLocation(data, null)).toEqual({ ok: true });
    expect(resolveVaultLocation(data).source).toBe("default");
  });

  it("refuses folders that can't be memory", () => {
    fs.mkdirSync(data, { recursive: true });
    write(path.join(tmp, "afile"), "x");
    expect(vaultDirProblem("/", data)).toMatch(/not the whole drive/);
    expect(vaultDirProblem(os.homedir(), data)).toMatch(/home folder/);
    expect(vaultDirProblem(data, data)).toMatch(/Wisp's own data/);
    expect(vaultDirProblem(tmp, data)).toMatch(/Wisp's own data/); // contains the database
    expect(vaultDirProblem(path.join(data, "files"), data)).toMatch(/uploaded files/);
    expect(vaultDirProblem(path.join(tmp, "afile"), data)).toMatch(/file, not a folder/);
    expect(vaultDirProblem(path.join(tmp, "nope", "deeper"), data)).toMatch(/doesn't exist/);
    expect(vaultDirProblem("", data)).toBeTruthy();
    expect(vaultDirProblem(path.join(tmp, "fine"), data)).toBeNull();
  });
});

describe("opening an existing Obsidian vault", () => {
  it("uses the folder as it is: indexes the notes, keeps .obsidian untouched, and agents can write there", async () => {
    const vault = path.join(tmp, "My Obsidian");
    write(path.join(vault, ".obsidian/app.json"), '{"mine":true}');
    write(path.join(vault, "Journal/today.md"), "# Today\nbasilisk meeting");
    process.env.WISP_VAULT_DIR = vault;
    await withHub(async ({ hub, api }) => {
      expect(hub.vaults.primary.root).toBe(vault);
      expect((await api("GET", "/api/vault/search?q=basilisk")).map((h: any) => h.path)).toEqual(["Journal/today.md"]);
      await api("PUT", "/api/vault/note", { path: "shared/from-wisp.md", content: "# Hi\n" });
      const storage = await api("GET", "/api/memory/storage");
      expect(storage).toMatchObject({ path: vault, source: "env" });
      // the owner can't override an environment setting from the app
      expect(await api("PUT", "/api/memory/storage", { path: path.join(tmp, "else") })).toMatchObject({ error: expect.stringMatching(/WISP_VAULT_DIR/) });
    });
    expect(fs.readFileSync(path.join(vault, ".obsidian/app.json"), "utf8")).toBe('{"mine":true}');
    expect(git(vault, "ls-files").split("\n")).toEqual(expect.arrayContaining(["Journal/today.md", "shared/from-wisp.md"]));
    expect(git(vault, "ls-files")).not.toContain(".obsidian");
    // nothing was made in the old default location
    expect(fs.existsSync(path.join(data, "vault", "Journal"))).toBe(false);
  });
});

describe("moving memory to another folder", () => {
  it("copies an earlier vault into an empty folder with its history and leaves the original alone", async () => {
    await withHub(async ({ api }) => {
      await api("PUT", "/api/vault/note", { path: "shared/keep.md", content: "# Keep\nthis moves" });
    });
    const oldDir = path.join(data, "vault");
    const target = path.join(tmp, "Moved");
    expect(saveVaultLocation(data, target)).toEqual({ ok: true });
    await withHub(async ({ hub, api }) => {
      expect(hub.vaults.primary.root).toBe(target);
      expect((await api("GET", "/api/vault/note?path=shared/keep.md")).content).toContain("this moves");
      expect((await api("GET", "/api/vault/changes")).length).toBeGreaterThan(1); // history came along
      const s = await api("GET", "/api/memory/storage");
      expect(s).toMatchObject({ path: target, previous: oldDir, moved: { how: "copied", to: target } });
    }, true);
    // the original is still complete
    expect(fs.readFileSync(path.join(oldDir, "shared/keep.md"), "utf8")).toContain("this moves");
    expect(git(oldDir, "log", "--format=%s")).toContain("Update shared/keep.md");
    expect(fs.readFileSync(path.join(target, "shared/keep.md"), "utf8")).toContain("this moves");
  });

  it("adds only what an existing vault lacks and never overwrites its files", async () => {
    await withHub(async ({ api }) => {
      await api("PUT", "/api/vault/note", { path: "shared/clash.md", content: "from wisp" });
      await api("PUT", "/api/vault/note", { path: "agents/a/mind.md", content: "agent memory" });
    });
    const target = path.join(tmp, "Existing");
    write(path.join(target, "shared/clash.md"), "from obsidian");
    write(path.join(target, ".obsidian/app.json"), "{}");
    write(path.join(target, "Ideas.md"), "# Ideas");
    const moved = (() => {
      saveVaultLocation(data, target);
      return carryOverVault(data, target);
    })();
    expect(moved).toMatchObject({ how: "merged" });
    expect(moved!.files).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(target, "shared/clash.md"), "utf8")).toBe("from obsidian");
    expect(fs.readFileSync(path.join(target, "agents/a/mind.md"), "utf8")).toBe("agent memory");
    // the earlier vault's own git folder isn't dropped into someone else's vault
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "vault/shared/clash.md"), "utf8")).toBe("from wisp");

    await withHub(async ({ hub }) => {
      expect(hub.vaults.primary.list().map((n) => n.path)).toEqual(expect.arrayContaining(["Ideas.md", "agents/a/mind.md", "shared/clash.md"]));
    }, true);
    expect(git(target, "log", "--format=%an")).toContain("Wisp");
  });
});
