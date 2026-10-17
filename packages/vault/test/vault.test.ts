import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OUTSIDE_AUTHOR, Vault, fillFrontmatter, guessType, parseNote } from "../src/index.ts";

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

  it("reads a [[link]] property as one value that links, and ignores links shown as code", () => {
    const n = parseNote("shared/a.md", "---\nowner: [[Maya Chen]]\npeople: [\"[[A]]\", \"[[B]]\"]\n---\nSee [[Real]], not `[[Example]]` or\n```\n[[Fenced]]\n```\n");
    expect(n.frontmatter.owner).toBe("[[Maya Chen]]");
    expect(n.frontmatter.people).toEqual(["[[A]]", "[[B]]"]);
    // front matter links count; code doesn't
    expect(n.links.sort()).toEqual(["a", "b", "maya chen", "real"]);
    expect(parseNote("a.md", "---\nby: [[[Maya Chen]], [[Sam]]]\n---\n").links.sort()).toEqual(["maya chen", "sam"]);
  });
});

describe("links", () => {
  it("skips examples in code and counts links in front matter", () => {
    const n = parseNote("shared/a.md", '---\nrelated: ["[[Acme]]", "[[pricing]]"]\n---\nWrite `[[note-name]]` like this:\n```\n[[example]]\n```\nSee [[Beta]].\n');
    expect(n.links.sort()).toEqual(["acme", "beta", "pricing"]);
  });
});

describe("filing notes", () => {
  it("guesses a note's type from its folder", () => {
    expect(guessType("shared/people/dana.md")).toBe("person");
    expect(guessType("agents/a/projects/acme.md")).toBe("project");
    expect(guessType("shared/projects/acme-pricing-decision.md")).toBe("decision");
    expect(guessType("teams/web/topics/caching.md")).toBe("topic");
    expect(guessType("shared/journal/2026-10-17.md")).toBe("journal");
    expect(guessType("shared/research/llms.md")).toBe("reference");
  });

  it("adds missing front matter without touching what's there", () => {
    expect(fillFrontmatter("# A\n", { type: "topic", created: "2026-10-17" })).toBe("---\ntype: topic\ncreated: 2026-10-17\n---\n\n# A\n");
    expect(fillFrontmatter("---\ntype: decision\nrelated:\n  - x\n---\n# A\n", { type: "topic", updated: "2026-10-17" })).toBe("---\ntype: decision\nrelated:\n  - x\nupdated: 2026-10-17\n---\n# A\n");
    const full = "---\ntype: person\n---\nx";
    expect(fillFrontmatter(full, { type: "topic" })).toBe(full);
  });

  it("saves an agent's note with a header and hints, and keeps the first created date", async () => {
    await vault.write("shared/projects/acme.md", "# Acme\nOur biggest customer.", me);
    await vault.write("shared/topics/pricing.md", "# Pricing\nHow we charge.", me);
    await vault.write("shared/projects/acme-pricing.md", "# Acme pricing\nAcme pays per seat, billed yearly, with a discount for nonprofits.", me);

    const r = await vault.save("shared/projects/acme-seats.md", "# Acme seats\nAcme pays per seat, billed yearly; nonprofits get a discount. See [[acme]].\nPricing review next month.", me, { today: "2026-10-01" });
    expect(r.similar).toEqual([{ path: "shared/projects/acme-pricing.md", title: "Acme pricing" }]);
    expect(r.links).toEqual(["[[pricing]]"]); // acme is already linked
    expect((await vault.read("shared/projects/acme-seats.md")).content).toMatch(/^---\ntype: project\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n# Acme seats/);

    // rewritten without a header: it keeps its type and first date, and gets a new updated date
    await vault.save("shared/projects/acme-seats.md", "---\ntype: decision\n---\n# Acme seats\nPer seat.", me, { today: "2026-10-17" });
    expect((await vault.read("shared/projects/acme-seats.md")).content).toBe("---\ntype: decision\ncreated: 2026-10-01\nupdated: 2026-10-17\n---\n# Acme seats\nPer seat.");

    // hints only cover notes the writer can read, and fill can be turned off
    const hidden = await vault.save("shared/x.md", "Pricing for Acme", me, { fill: false, allow: (p) => !p.includes("pricing") });
    expect(hidden.links).toEqual(["[[acme]]"]);
    expect((await vault.read("shared/x.md")).content).toBe("Pricing for Acme");
  });

  it("appends with a header for new notes and hints about the new text only", async () => {
    await vault.write("shared/topics/caching.md", "# Caching\nWhat we cache.", me);
    const r = await vault.save("shared/journal/2026-10-17.md", "- Looked at caching for the API", me, { append: true, today: "2026-10-17" });
    expect(r.links).toEqual(["[[caching]]"]);
    await vault.save("shared/journal/2026-10-17.md", "- Shipped it", me, { append: true, today: "2026-10-17" });
    expect((await vault.read("shared/journal/2026-10-17.md")).content).toBe("---\ntype: journal\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n\n- Looked at caching for the API\n- Shipped it\n");
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

const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = async (root: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

describe("an existing Obsidian vault", () => {
  it("is adopted in place: notes indexed, settings and trash left alone and out of git", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "warren-obsidian-"));
    try {
      await put(root, ".obsidian/app.json", '{"theme":"mine"}');
      await put(root, ".obsidian/plugins/thing/README.md", "# plugin readme");
      await put(root, ".trash/old.md", "# thrown away");
      await put(root, "Daily/2026-01-01.md", "# New year\nlinks to [[Ideas]]");
      await put(root, "Ideas.md", "# Ideas\nunicornlantern");
      await put(root, "Attachments/pic.png", "not really a png");
      const v = new Vault(root, new Database(":memory:"));
      await v.init();

      expect(v.list().map((n) => n.path)).toEqual(["Daily/2026-01-01.md", "Ideas.md"]);
      expect(v.backlinks("Ideas.md")).toEqual(["Daily/2026-01-01.md"]);
      expect(v.search("unicornlantern")).toHaveLength(1);
      // Obsidian's own folder is exactly as it was, and git never saw it
      expect(await fs.readFile(path.join(root, ".obsidian/app.json"), "utf8")).toBe('{"theme":"mine"}');
      const tracked = gitOut(root, "ls-files").split("\n");
      expect(tracked).toEqual(expect.arrayContaining(["Daily/2026-01-01.md", "Ideas.md", "Attachments/pic.png", ".gitignore"]));
      expect(tracked.some((f) => f.startsWith(".obsidian") || f.startsWith(".trash"))).toBe(false);
      expect(gitOut(root, "log", "-1", "--format=%s")).toBe("Start tracking this folder");
      // starting again changes nothing
      const head = gitOut(root, "rev-parse", "HEAD");
      await new Vault(root, new Database(":memory:")).init();
      expect(gitOut(root, "rev-parse", "HEAD")).toBe(head);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the history of a folder that is already a git repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "warren-obsidian-"));
    try {
      gitOut(root, "init", "-q");
      await put(root, "note.md", "# Mine");
      await put(root, ".gitignore", "secret/");
      gitOut(root, "add", "-A");
      gitOut(root, "-c", "user.name=Me", "-c", "user.email=me@example.com", "commit", "-q", "-m", "my own commit");
      const v = new Vault(root, new Database(":memory:"));
      await v.init();
      expect(gitOut(root, "log", "--format=%s")).toBe("Keep Obsidian settings and trash out of memory\nmy own commit");
      expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe("secret/\n.obsidian/\n.trash/\n");
      expect((await v.history("note.md"))[0].author).toBe("Me");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("edits made outside Warren", () => {
  it("are committed as 'Edited in Obsidian', indexed, and never confused with Warren's own saves", async () => {
    await vault.write("shared/ours.md", "# Ours\n", me);
    const stop = vault.watch({ debounceMs: 30, intervalMs: 600_000 });
    try {
      await put(dir, "Notes/outside.md", "# Outside\nmarmotbrigade");
      await until(() => vault.search("marmotbrigade").length > 0);
      const first = (await vault.changes(1))[0];
      expect(first).toMatchObject({ author: OUTSIDE_AUTHOR.name, files: [{ path: "Notes/outside.md", change: "added" }] });

      // Warren's own save while the watcher is running: exactly one commit, by Warren's author
      const count = () => Number(gitOut(dir, "rev-list", "--count", "HEAD"));
      const before = count();
      await vault.write("shared/ours.md", "# Ours\nedited", me);
      await sleep(400);
      expect(count()).toBe(before + 1);
      expect(gitOut(dir, "log", "-1", "--format=%an")).toBe("Tester");

      // edit and delete on disk
      await put(dir, "Notes/outside.md", "# Outside\nlemurcouncil");
      await until(() => vault.search("lemurcouncil").length > 0);
      expect(vault.search("marmotbrigade")).toHaveLength(0);
      await fs.rm(path.join(dir, "Notes/outside.md"));
      await until(() => vault.search("lemurcouncil").length === 0);
      expect(vault.list().map((n) => n.path)).not.toContain("Notes/outside.md");
    } finally {
      stop();
    }
  });

  it("are left alone while Warren is saving that very note", async () => {
    const saving = vault.write("shared/race.md", "# Race\n", me);
    // an outside sync that runs while the save is in flight must not commit it as an outside edit
    const sync = vault.syncFromDisk();
    await Promise.all([saving, sync]);
    expect(gitOut(dir, "log", "-1", "--format=%an", "--", "shared/race.md")).toBe("Tester");
  });

  it("notices a git pull or checkout made on the machine, and skips Obsidian's hidden folders", async () => {
    await vault.write("shared/a.md", "# A\nbefore", me);
    const first = gitOut(dir, "rev-parse", "HEAD");
    await vault.write("shared/a.md", "# A\nrabbitwarren", me);
    gitOut(dir, "-c", "advice.detachedHead=false", "checkout", "-q", first, "--", "shared/a.md");
    await put(dir, ".obsidian/workspace.json", "{}");
    await put(dir, ".trash/gone.md", "# gone");
    await vault.syncFromDisk();
    expect(vault.search("rabbitwarren")).toHaveLength(0);
    expect(vault.list().map((n) => n.path)).not.toContain(".trash/gone.md");
    expect(gitOut(dir, "ls-files")).not.toMatch(/\.obsidian|\.trash/);
  });

  it("credits pushed commits to the person in Activity, history and blame", async () => {
    await vault.write("shared/p.md", "# P\n", me);
    const hash = gitOut(dir, "rev-parse", "HEAD");
    vault.attribute([hash], "Sam");
    expect((await vault.changes(1))[0].author).toBe("Sam");
    expect((await vault.history("shared/p.md"))[0].author).toBe("Sam");
    expect((await vault.blame("shared/p.md"))[0].author).toBe("Sam");
  });
});
