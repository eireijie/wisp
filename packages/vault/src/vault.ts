import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { basename, normalizeTarget, parseNote } from "./markdown.ts";

const exec = promisify(execFile);

export interface NoteMeta {
  path: string; // vault-relative, forward slashes, ends in .md
  title: string;
  tags: string[];
  links: string[];
  updatedAt: number;
}

export interface Note extends NoteMeta {
  content: string;
  frontmatter: Record<string, string | string[]>;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface HistoryEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

/** A run of consecutive lines last changed by the same commit. */
export interface BlameBlock {
  hash: string;
  author: string;
  date: string;
  lines: string[];
}

export interface Change {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: { path: string; change: "added" | "modified" | "deleted" | "renamed"; from?: string }[];
}

/**
 * A git-backed folder of markdown notes, compatible with Obsidian.
 * Files on disk are the source of truth; the SQLite index is a rebuildable cache.
 */
export class Vault {
  private gitQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    private db: Database.Database,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.root, "shared"), { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_notes (path TEXT PRIMARY KEY, title TEXT, tags TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS vault_links (src TEXT, target TEXT);
      CREATE INDEX IF NOT EXISTS vault_links_target ON vault_links(target);
      CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(path UNINDEXED, title, body);
    `);
    try {
      await fs.access(path.join(this.root, ".git"));
    } catch {
      await this.git(["init", "-q"]);
      await fs.writeFile(path.join(this.root, ".gitignore"), ".obsidian/workspace*.json\n.trash/\n");
      await this.commitAll({ name: "Warren", email: "warren@localhost" }, "Initialize vault");
    }
    await this.reindex();
  }

  /** Resolve a vault-relative path safely, refusing anything that escapes the root. */
  resolve(rel: string): string {
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    // dot folders (.git, .obsidian, .trash) belong to tools, not notes
    if (!clean || clean.split("/").some((p) => !p || p.startsWith("."))) throw new VaultError("invalid path", 400);
    const abs = path.resolve(this.root, clean);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new VaultError("invalid path", 400);
    return abs;
  }

  async read(rel: string): Promise<Note> {
    const p = notePath(rel);
    let raw: string;
    let stat;
    try {
      raw = await fs.readFile(this.resolve(p), "utf8");
      stat = await fs.stat(this.resolve(p));
    } catch {
      throw new VaultError("note not found", 404);
    }
    const parsed = parseNote(p, raw);
    return { path: p, title: parsed.title, tags: parsed.tags, links: parsed.links, frontmatter: parsed.frontmatter, content: raw, updatedAt: stat.mtimeMs };
  }

  async write(rel: string, content: string, author: CommitAuthor, message?: string): Promise<NoteMeta> {
    const p = notePath(rel);
    const abs = this.resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    const meta = this.indexNote(p, content, Date.now());
    await this.commit([p], author, message ?? `Update ${p}`);
    return meta;
  }

  async append(rel: string, text: string, author: CommitAuthor): Promise<NoteMeta> {
    let existing = "";
    try {
      existing = (await this.read(rel)).content;
    } catch (e) {
      if (!(e instanceof VaultError && e.status === 404)) throw e;
    }
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    return this.write(rel, existing + sep + text + (text.endsWith("\n") ? "" : "\n"), author, `Append to ${notePath(rel)}`);
  }

  async remove(rel: string, author: CommitAuthor): Promise<void> {
    const p = notePath(rel);
    try {
      await fs.unlink(this.resolve(p));
    } catch {
      throw new VaultError("note not found", 404);
    }
    this.unindex(p);
    await this.commit([p], author, `Delete ${p}`);
  }

  async move(from: string, to: string, author: CommitAuthor): Promise<NoteMeta> {
    const a = notePath(from);
    const b = notePath(to);
    const note = await this.read(a);
    await fs.mkdir(path.dirname(this.resolve(b)), { recursive: true });
    await fs.rename(this.resolve(a), this.resolve(b));
    this.unindex(a);
    const meta = this.indexNote(b, note.content, Date.now());
    await this.commit([a, b], author, `Move ${a} -> ${b}`);
    return meta;
  }

  /** All notes, optionally only those `allow` accepts (used to apply access rules). */
  list(allow?: (path: string) => boolean): NoteMeta[] {
    const rows = this.db.prepare("SELECT path, title, tags, updated_at FROM vault_notes ORDER BY path").all() as Row[];
    const linkRows = this.db.prepare("SELECT src, target FROM vault_links").all() as { src: string; target: string }[];
    const links = new Map<string, string[]>();
    for (const l of linkRows) links.set(l.src, [...(links.get(l.src) ?? []), l.target]);
    return rows
      .filter((r) => !allow || allow(r.path))
      .map((r) => ({ path: r.path, title: r.title, tags: JSON.parse(r.tags), links: links.get(r.path) ?? [], updatedAt: r.updated_at }));
  }

  /** Notes linking to `rel`, matched Obsidian-style by basename or full path. */
  backlinks(rel: string, allow?: (path: string) => boolean): string[] {
    const p = notePath(rel);
    const keys = [normalizeTarget(p), normalizeTarget(basename(p))];
    const rows = this.db.prepare("SELECT DISTINCT src FROM vault_links WHERE target IN (?, ?) ORDER BY src").all(...keys) as { src: string }[];
    return rows.map((r) => r.src).filter((s) => s !== p && (!allow || allow(s)));
  }

  /** Resolve a wikilink target to a note path, preferring the same scope folder. */
  resolveLink(target: string, fromPath?: string): string | null {
    const t = normalizeTarget(target);
    const all = this.list().map((n) => n.path);
    const exact = all.find((p) => normalizeTarget(p) === t);
    if (exact) return exact;
    const byName = all.filter((p) => normalizeTarget(basename(p)) === t);
    if (fromPath) {
      const dir = fromPath.split("/").slice(0, 2).join("/");
      const local = byName.find((p) => p.startsWith(dir + "/"));
      if (local) return local;
    }
    return byName[0] ?? null;
  }

  /**
   * Full-text search. "all" needs every word (a search box); "any" ranks notes by how well they
   * match any of the meaningful words (finding memory related to a message).
   */
  search(query: string, allow?: (path: string) => boolean, limit = 20, mode: "all" | "any" = "all"): SearchHit[] {
    const q = toFtsQuery(query, mode);
    if (!q) return [];
    const page = 100;
    const stmt = this.db.prepare(`SELECT path, title, snippet(vault_fts, 2, '**', '**', '…', 12) AS snippet FROM vault_fts WHERE vault_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`);
    // filter page by page so notes the caller can't read never crowd out ones it can
    const out: SearchHit[] = [];
    for (let offset = 0; out.length < limit; offset += page) {
      const rows = stmt.all(q, page, offset) as SearchHit[];
      for (const r of rows) if ((!allow || allow(r.path)) && out.push(r) >= limit) break;
      if (rows.length < page) break;
    }
    return out;
  }

  async history(rel: string, limit = 50): Promise<HistoryEntry[]> {
    const p = notePath(rel);
    this.resolve(p);
    const { stdout } = await this.git(["log", `-n${limit}`, "--follow", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", p]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, message] = l.split("\x1f");
        return { hash, author, date, message };
      });
  }

  /** Who last changed each line of a note. */
  async blame(rel: string): Promise<BlameBlock[]> {
    const p = notePath(rel);
    this.resolve(p);
    let stdout: string;
    try {
      ({ stdout } = await this.git(["blame", "--line-porcelain", "--", p]));
    } catch {
      return [];
    }
    const blocks: BlameBlock[] = [];
    let cur: { hash: string; author: string; time: number } = { hash: "", author: "", time: 0 };
    for (const line of stdout.split("\n")) {
      const head = line.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (head) cur = { hash: head[1], author: "", time: 0 };
      else if (line.startsWith("author ")) cur.author = line.slice(7);
      else if (line.startsWith("author-time ")) cur.time = Number(line.slice(12));
      else if (line.startsWith("\t")) {
        const last = blocks[blocks.length - 1];
        if (last?.hash === cur.hash) last.lines.push(line.slice(1));
        else blocks.push({ hash: cur.hash, author: cur.author, date: new Date(cur.time * 1000).toISOString(), lines: [line.slice(1)] });
      }
    }
    return blocks;
  }

  /** Recent commits across the vault, newest first, with the notes each one touched. */
  async changes(limit = 100): Promise<Change[]> {
    const { stdout } = await this.git(["log", `-n${limit}`, "--name-status", "-M", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s"]);
    const kinds: Record<string, Change["files"][number]["change"]> = { A: "added", M: "modified", D: "deleted", R: "renamed" };
    return stdout
      .split("\x1e")
      .filter((c) => c.trim())
      .map((c) => {
        const [header, ...rest] = c.split("\n");
        const [hash, author, date, message] = header.split("\x1f");
        const files = rest
          .filter(Boolean)
          .map((l) => l.split("\t"))
          .filter((f) => f.length >= 2 && f[f.length - 1].toLowerCase().endsWith(".md"))
          .map((f) => ({ path: f[f.length - 1], change: kinds[f[0][0]] ?? "modified", ...(f[0][0] === "R" ? { from: f[1] } : {}) }));
        return { hash, author, date, message, files };
      });
  }

  async readAt(rel: string, hash: string): Promise<string> {
    const p = notePath(rel);
    this.resolve(p);
    if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new VaultError("invalid revision", 400);
    const { stdout } = await this.git(["show", `${hash}:${p}`]);
    return stdout;
  }

  /** Rebuild the index from disk (e.g. after edits made in Obsidian or a git pull). */
  async reindex(): Promise<number> {
    const files = await walk(this.root);
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM vault_notes; DELETE FROM vault_links; DELETE FROM vault_fts;");
    });
    tx();
    for (const f of files) {
      const abs = path.join(this.root, f);
      const [raw, stat] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
      this.indexNote(f, raw, stat.mtimeMs);
    }
    return files.length;
  }

  /** Commit any changes made outside Warren (Obsidian, editors) and reindex. */
  async syncFromDisk(author: CommitAuthor): Promise<number> {
    await this.commitAll(author, "Sync external changes");
    return this.reindex();
  }

  private indexNote(p: string, raw: string, updatedAt: number): NoteMeta {
    const parsed = parseNote(p, raw);
    const tx = this.db.transaction(() => {
      this.unindexRows(p);
      this.db.prepare("INSERT INTO vault_notes (path, title, tags, updated_at) VALUES (?, ?, ?, ?)").run(p, parsed.title, JSON.stringify(parsed.tags), Math.round(updatedAt));
      const ins = this.db.prepare("INSERT INTO vault_links (src, target) VALUES (?, ?)");
      for (const l of parsed.links) ins.run(p, l);
      this.db.prepare("INSERT INTO vault_fts (path, title, body) VALUES (?, ?, ?)").run(p, parsed.title, parsed.body);
    });
    tx();
    return { path: p, title: parsed.title, tags: parsed.tags, links: parsed.links, updatedAt };
  }

  private unindex(p: string) {
    this.db.transaction(() => this.unindexRows(p))();
  }

  private unindexRows(p: string) {
    this.db.prepare("DELETE FROM vault_notes WHERE path = ?").run(p);
    this.db.prepare("DELETE FROM vault_links WHERE src = ?").run(p);
    this.db.prepare("DELETE FROM vault_fts WHERE path = ?").run(p);
  }

  private commit(paths: string[], author: CommitAuthor, message: string) {
    return this.serial(async () => {
      await this.git(["add", "-A", "--", ...paths]);
      const { stdout } = await this.git(["status", "--porcelain", "--", ...paths]);
      if (!stdout.trim()) return;
      await this.git(["commit", "-q", "-m", message, "--author", `${author.name} <${author.email}>`, "--", ...paths], author);
    });
  }

  private commitAll(author: CommitAuthor, message: string) {
    return this.serial(async () => {
      await this.git(["add", "-A"]);
      const { stdout } = await this.git(["status", "--porcelain"]);
      if (!stdout.trim()) return;
      await this.git(["commit", "-q", "-m", message, "--author", `${author.name} <${author.email}>`], author);
    });
  }

  /** git operations must not interleave (index.lock). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  private git(args: string[], author?: CommitAuthor) {
    const who = author ?? { name: "Warren", email: "warren@localhost" };
    return exec("git", args, {
      cwd: this.root,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email },
    });
  }
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Row = { path: string; title: string; tags: string; updated_at: number };

/** A note's vault path: forward slashes, no leading slash, ending in .md. */
export function notePath(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return clean.toLowerCase().endsWith(".md") ? clean : clean + ".md";
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its just me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about please thanks hey hi ok okay".split(" "),
);

/** Turn free text into a safe FTS5 prefix query: every word ("all"), or any meaningful word ("any"). */
function toFtsQuery(q: string, mode: "all" | "any" = "all"): string {
  if (mode === "any") {
    const words = q.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").split(" ");
    return [...new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)))]
      .slice(0, 24)
      .map((t) => `"${t}"*`)
      .join(" OR ");
  }
  return q
    .split(/\s+/)
    .map((t) => t.replace(/["*^():]/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
}

async function walk(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else if (e.name.toLowerCase().endsWith(".md")) out.push(rel);
  }
  return out;
}
