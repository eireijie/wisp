import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const { createMigration } = createRequire(import.meta.url)("../src/migration.cjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(platform = "darwin", overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-migration-")); roots.push(root);
  const home = path.join(root, "home"), appData = path.join(root, "appData"), systemUnits = path.join(root, "systemd");
  fs.mkdirSync(home);
  const runner = vi.fn(async () => ({ stdout: JSON.stringify({ actions: ["services migrated"] }) }));
  const log = vi.fn();
  const migration = createMigration({ home, appData, platform, runner, log, systemUnitDirs: [systemUnits], ...overrides });
  const write = (relative: string, content: string | Buffer = "settings") => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  return { root, home, appData, runner, log, migration, write };
}
const runtime = { node: "/bundled/electron", wispDir: "/bundled/wisp", env: { ELECTRON_RUN_AS_NODE: "1", WISP_DATA_DIR: "/data" } };

describe("desktop data migration", () => {
  it("moves the Electron profile before settings are read and preserves browser storage", () => {
    const f = fixture();
    f.write("appData/Warren/Local Storage/leveldb/000001.log", Buffer.from([0, 1, 2, 255]));
    f.write("appData/Warren/desktop.json", JSON.stringify({ warrenDir: `${f.home}/.warren/source`, mode: "local", bounds: { width: 1200 } }));
    const { userData } = f.migration.prepare();
    expect(userData).toBe(path.join(f.appData, "Wisp"));
    expect(fs.existsSync(path.join(f.appData, "Warren"))).toBe(false);
    expect(fs.readFileSync(path.join(userData, "Local Storage/leveldb/000001.log"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"))).toEqual({ wispDir: `${f.home}/.wisp/source`, mode: "local", bounds: { width: 1200 } });
  });

  it.each(["darwin", "linux", "win32"])("moves the home and all data on %s, rewrites settings and keeps an alias", (platform) => {
    const f = fixture(platform);
    f.write("home/.warren/node.json", JSON.stringify({ token: "secret", hub: "https://example/.warren/hub", workspaces: [`${f.home}/.warren/agents/nova`], windows: "C:\\Users\\me\\.warren\\agents" }));
    f.write("home/.warren/data/warren.db", "database bytes");
    f.write("home/.warren/agents/nova/user.json", '{"content":"/.warren/user content"}');
    f.migration.prepare();
    const old = path.join(f.home, ".warren"), next = path.join(f.home, ".wisp");
    expect(fs.lstatSync(old).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(old)).toBe(fs.realpathSync(next));
    expect(JSON.parse(fs.readFileSync(path.join(next, "node.json"), "utf8"))).toEqual({ token: "secret", hub: "https://example/.warren/hub", workspaces: [`${f.home}/.wisp/agents/nova`], windows: "C:\\Users\\me\\.wisp\\agents" });
    expect(fs.readFileSync(path.join(old, "data/warren.db"), "utf8")).toBe("database bytes");
    expect(fs.readFileSync(path.join(next, "agents/nova/user.json"), "utf8")).toContain("/.warren/user content");
    f.migration.prepare();
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("never replaces existing Wisp directories or follows an old home symlink", () => {
    const f = fixture();
    f.write("home/.warren/node.json", '{"token":"old"}');
    f.write("home/.wisp/node.json", '{"token":"new"}');
    f.write("appData/Warren/desktop.json", '{"mode":"old"}');
    f.write("appData/Wisp/desktop.json", '{"mode":"new"}');
    f.migration.prepare();
    expect(fs.lstatSync(path.join(f.home, ".warren")).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, ".wisp/node.json"), "utf8")).token).toBe("new");
    expect(fs.existsSync(path.join(f.appData, "Warren/desktop.json"))).toBe(true);
    const g = fixture();
    fs.mkdirSync(path.join(g.root, "external"));
    fs.symlinkSync(path.join(g.root, "external"), path.join(g.home, ".warren"));
    g.migration.prepare();
    expect(fs.existsSync(path.join(g.home, ".wisp"))).toBe(false);
  });

  it("uses verified copy only for EXDEV, including symlinks, before removing the source", () => {
    const renameSync = vi.fn((from: string, to: string) => {
      if (from.endsWith("/.warren")) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      return fs.renameSync(from, to);
    });
    const f = fixture("darwin", { fs: { ...fs, renameSync } });
    f.write("home/.warren/node.json", '{"token":"keep"}');
    f.write("home/.warren/data/vault/note.md", "memory");
    fs.symlinkSync("node.json", path.join(f.home, ".warren/link"));
    f.migration.prepare();
    expect(fs.readFileSync(path.join(f.home, ".wisp/data/vault/note.md"), "utf8")).toBe("memory");
    expect(fs.readlinkSync(path.join(f.home, ".wisp/link"))).toBe("node.json");
    expect(fs.lstatSync(path.join(f.home, ".warren")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(f.home).sort()).toEqual([".warren", ".wisp"]);
  });

  it("keeps the original when cross-device copy verification fails", () => {
    const f = fixture("linux", { fs: { ...fs,
      renameSync: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
      cpSync: (from: string, to: string, opts: object) => { fs.cpSync(from, to, opts); fs.writeFileSync(path.join(to, "node.json"), "damaged"); },
    } });
    f.write("home/.warren/node.json", '{"token":"keep"}');
    expect(() => f.migration.prepare()).toThrow("verification failed");
    expect(fs.readFileSync(path.join(f.home, ".warren/node.json"), "utf8")).toBe('{"token":"keep"}');
    expect(fs.readdirSync(f.home)).toEqual([".warren"]);
  });

  it("does not fall back to copy on a permission error", () => {
    const cpSync = vi.fn();
    const f = fixture("darwin", { fs: { ...fs, cpSync, renameSync: () => { throw Object.assign(new Error("permission"), { code: "EACCES" }); } } });
    f.write("home/.warren/node.json", "{}");
    expect(() => f.migration.prepare()).toThrow("permission");
    expect(cpSync).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.home, ".warren/node.json"))).toBe(true);
  });
});

describe("legacy services are migrated by the bundled CLI", () => {
  it.each(["hub", "node"])("detects old launchd %s plists and waits for the injected runner", async (kind) => {
    const f = fixture();
    const plist = f.write(`home/Library/LaunchAgents/ai.warren.${kind}.plist`);
    let finish: (value: { stdout: string }) => void = () => {};
    f.runner.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let completed = false;
    const pending = f.migration.migrateServices(runtime).then(() => { completed = true; });
    await vi.waitFor(() => expect(f.runner).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(f.runner).toHaveBeenCalledWith(runtime.node, ["/bundled/wisp/bin/wisp.mjs", "migrate", "--json"], expect.objectContaining({ cwd: runtime.wispDir, env: expect.objectContaining({ HOME: f.home, ELECTRON_RUN_AS_NODE: "1", WISP_DATA_DIR: "/data" }) }));
    fs.rmSync(plist); // what the CLI does after replacing the service
    finish({ stdout: '{"actions":["migrated"]}' });
    await pending;
    expect(completed).toBe(true);
    await f.migration.migrateServices(runtime);
    expect(f.runner).toHaveBeenCalledOnce();
  });

  it.each(["home/.config/systemd/user/warren.service", "systemd/warren-node.service"])("recognizes %s", async (file) => {
    const f = fixture("linux"); f.write(file);
    await f.migration.migrateServices(runtime);
    expect(f.runner).toHaveBeenCalledOnce();
  });

  it("recognizes old Windows task names and preserves failure for the caller", async () => {
    const f = fixture("win32");
    f.runner.mockResolvedValueOnce({ stdout: "Warren hub\r\nWarren node\r\n" }).mockRejectedValueOnce(new Error("migration failed"));
    await expect(f.migration.migrateServices(runtime)).rejects.toThrow("migration failed");
    expect(f.runner.mock.calls[0][0]).toBe("powershell.exe");
    expect(f.runner.mock.calls[1][0]).toBe(runtime.node);
  });

  it("does not resolve the runtime or invoke commands with no old services", async () => {
    const f = fixture(); const findRuntime = vi.fn();
    expect(await f.migration.migrateServices(findRuntime)).toEqual([]);
    expect(findRuntime).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled();
  });
});


describe("Windows service migration with no legacy tasks", () => {
  it("continues startup when the task query returns no matches", async () => {
    const f = fixture("win32");
    f.runner.mockResolvedValueOnce({ stdout: "" });
    expect(await f.migration.migrateServices(runtime)).toEqual([]);
    expect(f.runner).toHaveBeenCalledOnce();
    expect(f.runner.mock.calls[0][1][2]).toContain("exit 0");
  });
});
