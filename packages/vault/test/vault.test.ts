import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault, parseNote } from "../src/index.ts";

const me = { name: "Tester", email: "t@example.com" };
let dir: string;
let vault: Vault;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-vault-"));
  vault = new Vault(dir, new Database(":memory:"));
  await vault.init();
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("parseNote", () => {
  it("parses frontmatter, wikilinks, tags", () => {
    const n = parseNote("shared/a.md", "---\ntitle: Alpha\ntags: [x, y]\n---\nSee [[Beta|b]] and ![[img.png]] #todo\n");
    expect(n.title).toBe("Alpha");
    expect(n.links.sort()).toEqual(["beta", "img.png"]);
    expect(n.tags.sort()).toEqual(["todo", "x", "y"]);
  });
});

describe("Vault", () => {
  it("writes, reads, links, searches, and versions notes", async () => {
    await vault.write("shared/projects/warren", "# Warren\nUses [[Obsidian]] style links.", me);
    await vault.write("shared/obsidian.md", "# Obsidian\nA markdown knowledge base.", me);
    expect((await vault.read("shared/projects/warren.md")).title).toBe("Warren");
    expect(vault.backlinks("shared/obsidian.md")).toEqual(["shared/projects/warren.md"]);
    expect(vault.resolveLink("Obsidian")).toBe("shared/obsidian.md");
    expect(vault.search("knowledge").map((h) => h.path)).toEqual(["shared/obsidian.md"]);

    await vault.write("shared/obsidian.md", "# Obsidian\nEdited.", me, "edit");
    const h = await vault.history("shared/obsidian.md");
    expect(h).toHaveLength(2);
    expect(h[0].author).toBe("Tester");
    expect(await vault.readAt("shared/obsidian.md", h[1].hash)).toContain("knowledge base");
  });

  it("filters by an access check", async () => {
    await vault.write("agents/a/secret.md", "alpha secret", me);
    await vault.write("shared/public.md", "alpha public", me);
    expect(vault.search("alpha", (p) => p.startsWith("shared/")).map((h) => h.path)).toEqual(["shared/public.md"]);
    expect(vault.list((p) => p.startsWith("agents/a/")).map((n) => n.path)).toEqual(["agents/a/secret.md"]);
  });

  it("finds readable notes even when many hidden ones match better", async () => {
    await fs.mkdir(path.join(dir, "hidden"), { recursive: true });
    for (let i = 0; i < 150; i++) await fs.writeFile(path.join(dir, "hidden", `n${i}.md`), "gamma gamma gamma");
    await fs.writeFile(path.join(dir, "shared", "seen.md"), "gamma and a lot of other words that dilute the match");
    await vault.reindex();
    expect(vault.search("gamma", (p) => !p.startsWith("hidden/")).map((h) => h.path)).toEqual(["shared/seen.md"]);
  });

  it("finds notes related to a message by any meaningful word", async () => {
    await vault.write("shared/launch.md", "# Launch\nThe release ships in November.", me);
    await vault.write("shared/other.md", "# Other\nNothing relevant.", me);
    expect(vault.search("what did we decide about the release?", undefined, 5)).toEqual([]);
    expect(vault.search("what did we decide about the release?", undefined, 5, "any").map((h) => h.path)).toEqual(["shared/launch.md"]);
  });

  it("knows who wrote each line and what changed recently", async () => {
    await vault.write("shared/team.md", "# Team\nfirst line\n", { name: "@atlas", email: "atlas@agents.warren" });
    await vault.append("shared/team.md", "added by nova", { name: "@nova", email: "nova@agents.warren" });
    const blame = await vault.blame("shared/team.md");
    expect(blame.map((b) => [b.author, b.lines])).toEqual([
      ["@atlas", ["# Team", "first line"]],
      ["@nova", ["added by nova"]],
    ]);
    await vault.move("shared/team.md", "shared/crew.md", me);
    const changes = await vault.changes(3);
    expect(changes[0].files).toEqual([{ path: "shared/crew.md", change: "renamed", from: "shared/team.md" }]);
    expect(changes[1]).toMatchObject({ author: "@nova", files: [{ path: "shared/team.md", change: "modified" }] });
  });

  it("refuses dot folders", async () => {
    await expect(vault.write(".obsidian/x.md", "x", me)).rejects.toThrow("invalid path");
    await expect(vault.write("shared/.trash/x.md", "x", me)).rejects.toThrow("invalid path");
  });

  it("rejects path traversal", async () => {
    await expect(vault.write("../evil.md", "x", me)).rejects.toThrow("invalid path");
    await expect(vault.write(".git/config", "x", me)).rejects.toThrow("invalid path");
  });

  it("picks up external edits", async () => {
    await fs.mkdir(path.join(dir, "shared"), { recursive: true });
    await fs.writeFile(path.join(dir, "shared/external.md"), "made in obsidian");
    expect(await vault.syncFromDisk(me)).toBe(1);
    expect(vault.search("obsidian")[0].path).toBe("shared/external.md");
  });

  it("append and move", async () => {
    await vault.append("agents/a/log", "first", me);
    await vault.append("agents/a/log", "second", me);
    expect((await vault.read("agents/a/log")).content).toBe("first\nsecond\n");
    await vault.move("agents/a/log", "agents/a/archive/log", me);
    expect(vault.list().map((n) => n.path)).toEqual(["agents/a/archive/log.md"]);
  });
});
