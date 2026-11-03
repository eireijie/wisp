import { execFile } from "node:child_process";
import { watch as watchDir, type FSWatcher } from "node:fs";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { fillFrontmatter, guessType, linkNames, mentions, noteWords, overlap } from "./filing.ts";
import { basename, normalizeTarget, parseNote, withoutCode } from "./markdown.ts";

const exec = promisify(execFile);

/** Who edits made outside Wisp (in Obsidian, an editor, a git pull on the hub's machine) are credited to. */
export const OUTSIDE_AUTHOR: CommitAuthor = { name: "Edited in Obsidian", email: "obsidian@localhost" };
const WISP_AUTHOR: CommitAuthor = { name: "Wisp", email: "wisp@localhost" };

/** Folders that belong to tools (.git, .obsidian, .trash), never notes. */
export const isHiddenPath = (p: string) => p.replace(/\\/g, "/").split("/").some((s) => s.startsWith("."));

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

/** What an agent hears back after saving: notes on the same idea, and names it could link. */
export interface SaveHints {
  similar: { path: string; title: string }[];
  /** [[links]] it could add (not `links`, which is what the note already links to) */
  linkable: string[];
  /** [[links]] Wisp added itself because the note linked to nothing (a guarded save) */
  linked?: string[];
}

/** A new note sharing this much with an existing one (shared words over all words) says the same thing again. */
export const DUPLICATE_SCORE = 0.8;
/** At most this many links go on the "Related:" line Wisp adds to a note that links nothing. */
const AUTO_LINKS = 3;

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
  /** notes Wisp is in the middle of saving: the watcher must not mistake them for outside edits */
  private pending = new Map<string, number>();
  /** the commit the search index is up to date with */
  private indexedHead: string | null = null;
  private authored = new Map<string, string>();

  constructor(
    readonly root: string,
    private db: Database.Database,
  ) {}

  /**
   * Open the folder as a vault: a new or empty folder, an existing Obsidian vault, or a folder
   * that is already a git repository. Nothing in it is deleted or rewritten; `.obsidian/` and
   * `.trash/` are kept out of git and out of the index.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.join(this.root, "shared"), { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_notes (path TEXT PRIMARY KEY, title TEXT, tags TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS vault_links (src TEXT, target TEXT);
      CREATE INDEX IF NOT EXISTS vault_links_target ON vault_links(target);
      CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(path UNINDEXED, title, body);
      CREATE TABLE IF NOT EXISTS vault_authors (hash TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
    // front matter `type:` (person, project, decision…), added after the first release
    const cols = this.db.prepare("PRAGMA table_info(vault_notes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "type")) this.db.exec("ALTER TABLE vault_notes ADD COLUMN type TEXT");
    try {
      await fs.access(path.join(this.root, ".git"));
    } catch {
      await this.git(["init", "-q"]);
    }
    const started = !!(await this.head());
    const ignoreChanged = await this.ensureIgnore();
    if (!started) {
      const existing = (await walk(this.root)).length;
      await this.commitAll(WISP_AUTHOR, existing ? "Start tracking this folder" : "Initialize vault");
    } else if (ignoreChanged) {
      await this.commit([".gitignore"], WISP_AUTHOR, "Keep Obsidian settings and trash out of memory");
    }
    await this.reindex();
  }

  /** Make sure git skips Obsidian's settings and trash. Returns whether .gitignore changed. */
  private async ensureIgnore(): Promise<boolean> {
    const file = path.join(this.root, ".gitignore");
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {}
    const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, ""));
    const missing = [".obsidian/", ".trash/"].filter((e) => !lines.includes(e) && !lines.includes(e.slice(0, -1)));
    if (!missing.length) return false;
    await fs.writeFile(file, text + (text && !text.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
    return true;
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
    return this.saving([p], async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      const meta = this.indexNote(p, content, Date.now());
      await this.commit([p], author, message ?? `Update ${p}`);
      return meta;
    });
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

  /**
   * Save a note the way agents do (memory_write, or memory_append with `append`): fill in the
   * front matter it's missing (type, created, updated), save, and return hints. `fill: false`
   * saves the text as given; `allow` limits the hints to notes the writer can read. `guard`
   * keeps the graph tidy: a new note that repeats an existing one is refused (409, naming the
   * note to update), and a note that links to nothing gets a "Related:" line to its closest notes.
   */
  async save(
    rel: string,
    text: string,
    author: CommitAuthor,
    opts: { append?: boolean; message?: string; fill?: boolean; allow?: (path: string) => boolean; today?: string; guard?: boolean } = {},
  ): Promise<NoteMeta & SaveHints> {
    const p = notePath(rel);
    const old = await this.read(p).catch((e) => {
      if (e instanceof VaultError && e.status === 404) return null;
      throw e;
    });
    let content = text;
    if (opts.append && old) content = old.content + (old.content.endsWith("\n") ? "" : "\n") + text;
    if (opts.append && !content.endsWith("\n")) content += "\n";
    if (opts.fill !== false) {
      const today = opts.today ?? new Date().toISOString().slice(0, 10);
      const was = (k: string) => (typeof old?.frontmatter[k] === "string" ? (old.frontmatter[k] as string) : null);
      content = fillFrontmatter(content, { type: was("type") ?? guessType(p), created: was("created") ?? today, updated: today });
    }
    const found = await this.scoredHints(p, opts.append ? text : content, opts.allow);
    if (opts.guard && !old && !opts.append) {
      const same = found.similar.find((s) => s.body >= DUPLICATE_SCORE || (s.sameTitle && s.body >= 0.5));
      if (same) throw new VaultError(`${same.path} ("${same.title}") already says this. Update that note instead: memory_read it, then memory_write it with your change.`, 409);
    }
    // a note that links nothing is an island in the graph: link what it's closest to
    let linked: string[] = [];
    if (opts.guard && !opts.append && !isMachinery(p) && !this.linksAnything(p, content)) {
      linked = [...new Set([...found.linkable, ...found.similar.map((s) => s.link)])].slice(0, AUTO_LINKS);
      if (linked.length) content = `${content.replace(/\s+$/, "")}\n\nRelated: ${linked.join(", ")}\n`;
    }
    const meta = await this.write(p, content, author, opts.message ?? (opts.append ? `Append to ${p}` : undefined));
    const hints: SaveHints = { similar: found.similar.slice(0, 3).map(({ path, title }) => ({ path, title })), linkable: found.linkable.filter((l) => !linked.includes(l)) };
    return { ...meta, ...hints, ...(linked.length ? { linked } : {}) };
  }

  /** Whether a note links to another note that exists. */
  private linksAnything(p: string, content: string): boolean {
    return parseNote(p, content).links.some((t) => {
      const to = this.resolveLink(t, p);
      return !!to && to.toLowerCase() !== p.toLowerCase();
    });
  }

  /**
   * Hints for saving `text` at `rel`: up to `limit` existing notes on the same idea (to merge
   * into instead of keeping two), and notes the text names without linking them.
   */
  async hints(rel: string, text: string, allow?: (path: string) => boolean, limit = 3): Promise<SaveHints> {
    const found = await this.scoredHints(rel, text, allow);
    return { similar: found.similar.slice(0, limit).map(({ path, title }) => ({ path, title })), linkable: found.linkable };
  }

  /** `hints` with how close each similar note is (`body`: shared words over all words) and the [[link]] that reaches it. */
  private async scoredHints(rel: string, text: string, allow?: (path: string) => boolean) {
    const p = notePath(rel);
    const parsed = parseNote(p, text);
    const readable = (q: string) => q !== p && !isMachinery(q) && (!allow || allow(q));
    const notes = this.list(readable);
    const byName = new Map<string, number>();
    for (const n of notes) byName.set(normalizeTarget(basename(n.path)), (byName.get(normalizeTarget(basename(n.path))) ?? 0) + 1);
    // two notes with the same file name need the full path to tell them apart
    const linkTo = (q: string) => `[[${(byName.get(normalizeTarget(basename(q))) ?? 0) > 1 ? q.replace(/\.md$/i, "") : basename(q)}]]`;

    const similar: { path: string; title: string; score: number; body: number; sameTitle: boolean; link: string }[] = [];
    const mine = noteWords(`${parsed.title} ${parsed.body}`);
    const myTitle = noteWords(parsed.title);
    if (mine.size >= 3) {
      for (const hit of this.search(`${parsed.title} ${parsed.body}`, readable, 10, "any")) {
        const other = await this.read(hit.path).catch(() => null);
        if (!other) continue;
        const o = parseNote(hit.path, other.content);
        const body = overlap(mine, noteWords(`${o.title} ${o.body}`));
        const title = overlap(myTitle, noteWords(o.title));
        const score = Math.max(body.shared >= 3 ? body.score : 0, title.shared >= 2 ? title.score : 0);
        if (score >= 0.5) similar.push({ path: hit.path, title: o.title, score, body: body.shared >= 3 ? body.score : 0, sameTitle: title.shared >= 2 && title.score === 1, link: linkTo(hit.path) });
      }
    }
    similar.sort((a, b) => b.score - a.score);

    const linked = new Set(parsed.links);
    const plain = withoutCode(parsed.body).replace(/!?\[\[[^\]]*\]\]/g, " ").toLowerCase();
    const links: { link: string; weight: number }[] = [];
    for (const n of notes) {
      const name = normalizeTarget(basename(n.path));
      if (linked.has(name) || linked.has(normalizeTarget(n.path))) continue;
      const hit = linkNames(n.path, n.title).filter((m) => mentions(plain, m));
      if (!hit.length) continue;
      links.push({ link: linkTo(n.path), weight: Math.max(...hit.map((m) => m.length)) });
    }
    links.sort((a, b) => b.weight - a.weight);

    return { similar, linkable: [...new Set(links.map((l) => l.link))].slice(0, 5) };
  }

  async remove(rel: string, author: CommitAuthor): Promise<void> {
    const p = notePath(rel);
    await this.saving([p], async () => {
      try {
        await fs.unlink(this.resolve(p));
      } catch {
        throw new VaultError("note not found", 404);
      }
      this.unindex(p);
      await this.commit([p], author, `Delete ${p}`);
    });
  }

  async move(from: string, to: string, author: CommitAuthor): Promise<NoteMeta> {
    const a = notePath(from);
    const b = notePath(to);
    const note = await this.read(a);
    return this.saving([a, b], async () => {
      await fs.mkdir(path.dirname(this.resolve(b)), { recursive: true });
      await fs.rename(this.resolve(a), this.resolve(b));
      this.unindex(a);
      const meta = this.indexNote(b, note.content, Date.now());
      await this.commit([a, b], author, `Move ${a} -> ${b}`);
      return meta;
    });
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

  /**
   * The link graph of the notes `allow` accepts: a node per note and an edge per resolved
   * [[link]] between two of them. Links resolve among those notes only, the way the Memory page
   * does, so a hidden note never shows up; links that resolve to nothing become ghost nodes.
   * Skills and souls run agents rather than hold knowledge, so they stay out.
   */
  graph(allow?: (path: string) => boolean): VaultGraph {
    const rows = (this.db.prepare("SELECT path, title, tags, updated_at, type FROM vault_notes ORDER BY path").all() as (Row & { type: string | null })[]).filter((r) => !isMachinery(r.path) && (!allow || allow(r.path)));
    const paths = rows.map((r) => r.path);
    const resolveIn = linkResolver(paths);
    const linkRows = this.db.prepare("SELECT src, target FROM vault_links").all() as { src: string; target: string }[];
    const visible = new Set(paths);
    const edges = new Map<string, GraphEdge>();
    const ghosts = new Map<string, GraphNode>();
    for (const l of linkRows) {
      if (!visible.has(l.src)) continue;
      // attachments (![[photo.png]]) aren't notes
      if (/\.(png|jpe?g|gif|svg|webp|pdf|mp[34]|mov|wav|canvas)$/i.test(l.target)) continue;
      let to = resolveIn(l.target, l.src);
      if (!to) {
        to = `ghost:${l.target}`;
        if (!ghosts.has(to)) ghosts.set(to, { id: to, path: null, title: l.target.split("/").pop()!, kind: "ghost", type: null, tags: [], updatedAt: null, links: 0, inbound: 0 });
      }
      if (to !== l.src) edges.set(`${l.src}\n${to}`, { source: l.src, target: to });
    }
    const nodes: GraphNode[] = rows.map((r) => ({ id: r.path, path: r.path, title: r.title, kind: folderKind(r.path), type: r.type, tags: JSON.parse(r.tags), updatedAt: r.updated_at, links: 0, inbound: 0 }));
    const byId = new Map([...nodes, ...ghosts.values()].map((n) => [n.id, n]));
    const neighbours = new Map<string, Set<string>>();
    const near = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    for (const e of edges.values()) {
      near(e.source, e.target);
      near(e.target, e.source);
      byId.get(e.target)!.inbound++;
    }
    for (const [id, set] of neighbours) byId.get(id)!.links = set.size;
    return { nodes: [...nodes, ...ghosts.values()], edges: [...edges.values()] };
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
        return { hash, author: this.credit(hash, author), date, message };
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
        else blocks.push({ hash: cur.hash, author: this.credit(cur.hash, cur.author), date: new Date(cur.time * 1000).toISOString(), lines: [line.slice(1)] });
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
        return { hash, author: this.credit(hash, author), date, message, files };
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
    this.db.transaction(() => {
      this.db.exec("DELETE FROM vault_notes; DELETE FROM vault_links; DELETE FROM vault_fts;");
    })();
    for (const f of files) {
      const abs = path.join(this.root, f);
      const [raw, stat] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
      this.indexNote(f, raw, stat.mtimeMs);
    }
    this.indexedHead = await this.head();
    return files.length;
  }

  /**
   * Pick up changes made outside Wisp (Obsidian, another editor, a git pull on this machine):
   * commit them to git as `author`, then re-index just the notes that changed. Returns how many
   * notes changed. Notes Wisp is saving this moment are left to the save.
   */
  syncFromDisk(author: CommitAuthor = OUTSIDE_AUTHOR, message = "Edited in Obsidian"): Promise<number> {
    return this.serial(() => this.syncNow(author, message));
  }

  private async syncNow(author: CommitAuthor, message: string): Promise<number> {
    const dirty = (await this.dirtyPaths()).filter((p) => !isHiddenPath(p) && !this.pending.has(p));
    if (dirty.length) {
      for (let i = 0; i < dirty.length; i += 200) await this.git(["add", "-A", "--", ...dirty.slice(i, i + 200)]);
      await this.commitStaged(author, message, undefined, false);
    }
    const head = await this.head();
    if (head === this.indexedHead) return 0;
    let changed: string[] | null = null;
    if (head && this.indexedHead) {
      try {
        changed = await this.changedPaths(this.indexedHead, head);
      } catch {} // history was rewritten
    }
    if (!changed) return this.reindex();
    this.indexedHead = head;
    return this.reindexPaths(changed);
  }

  /** Files git sees as changed or new in the working folder. */
  private async dirtyPaths(): Promise<string[]> {
    const { stdout } = await this.git(["status", "--porcelain=v1", "-z", "--no-renames", "-uall"]);
    return stdout
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3));
  }

  private async changedPaths(from: string, to: string): Promise<string[]> {
    const { stdout } = await this.git(["diff", "--name-only", "-z", "--no-renames", from, to]);
    return stdout.split("\0").filter(Boolean);
  }

  /** Bring the index in line with these paths on disk. Returns how many notes that touched. */
  private async reindexPaths(paths: string[]): Promise<number> {
    let n = 0;
    for (const p of paths) {
      if (isHiddenPath(p) || !p.toLowerCase().endsWith(".md")) continue;
      n++;
      try {
        const abs = path.join(this.root, p);
        const stat = await fs.lstat(abs);
        if (!stat.isFile()) throw new Error("not a file");
        this.indexNote(p, await fs.readFile(abs, "utf8"), stat.mtimeMs);
      } catch {
        this.unindex(p);
      }
    }
    return n;
  }

  /**
   * Keep watching the folder so edits made in Obsidian show up: a file watcher (with a quiet
   * moment before acting, since editors save in bursts) plus a slow timer in case the watcher
   * misses something. Returns a function that stops it.
   */
  watch(opts: { intervalMs?: number; debounceMs?: number; onChange?: (notes: number) => void } = {}): () => void {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const run = () => {
      this.syncFromDisk()
        .then((n) => n && !stopped && opts.onChange?.(n))
        .catch(() => undefined);
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(run, opts.debounceMs ?? 1000);
    };
    let watcher: FSWatcher | undefined;
    try {
      watcher = watchDir(this.root, { recursive: true }, (_event, name) => {
        if (!name || !isHiddenPath(name.toString())) soon();
      });
      watcher.on("error", () => undefined);
    } catch {} // not supported here: the timer still catches everything
    const poll = setInterval(run, opts.intervalMs ?? 30_000);
    poll.unref();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    };
  }

  /** Mark commits as made by someone (pushes from Obsidian carry the person's own git name; Activity shows who they are in Wisp). */
  attribute(hashes: string[], name: string) {
    const ins = this.db.prepare("INSERT OR REPLACE INTO vault_authors (hash, name) VALUES (?, ?)");
    this.db.transaction(() => hashes.forEach((h) => ins.run(h, name)))();
    for (const h of hashes) this.authored.set(h, name);
  }

  private credit(hash: string, author: string): string {
    const known = this.authored.get(hash);
    if (known) return known;
    const row = this.db.prepare("SELECT name FROM vault_authors WHERE hash = ?").get(hash) as { name: string } | undefined;
    if (row) this.authored.set(hash, row.name);
    return row?.name ?? author;
  }

  /** The commit the vault is at, or null before the first commit. */
  async head(): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** The branch the vault is on, or null when it's detached. */
  async branch(): Promise<string | null> {
    try {
      return (await this.git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Every path that has ever been in the vault's history, for deciding what a clone would reveal. */
  async pathsEver(): Promise<string[]> {
    const head = await this.head();
    if (!head) return [];
    if (this.everCache?.head !== head) {
      const { stdout } = await this.git(["log", "--name-only", "--no-renames", "-z", "--format="]);
      this.everCache = { head, paths: [...new Set(stdout.split("\0").filter(Boolean))] };
    }
    return this.everCache.paths;
  }
  private everCache?: { head: string; paths: string[] };

  /** Where git keeps the vault's objects, so another repository can borrow them. */
  async objectsDir(): Promise<string> {
    return (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "objects"])).stdout.trim();
  }

  /**
   * Run `fn` while nothing else changes the vault's git state (no other commits, merges or
   * syncs). Used to take in a push from another computer.
   */
  exclusive<T>(fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    return this.serial(() =>
      fn({
        head: () => this.head(),
        branch: () => this.branch(),
        sync: () => this.syncNow(OUTSIDE_AUTHOR, "Edited in Obsidian"),
        adopt: (source, branch, from, to, who) => this.adopt(source, branch, from, to, who),
      }),
    );
  }

  /** Fast-forward the vault to commits fetched from `source` (the one given as `to`), index what changed and credit `who`. */
  private async adopt(source: string, branch: string, from: string, to: string, who: string): Promise<string[]> {
    if ((await this.head()) !== from) throw new VaultError("memory changed while receiving; pull and try again", 409);
    await this.git(["fetch", "-q", "--no-tags", source, `refs/heads/${branch}`]);
    try {
      await this.git(["merge", "--ff-only", "-q", to]);
    } catch {
      throw new VaultError("Wisp is saving changes to the same notes right now; try again in a moment", 409);
    }
    const paths = await this.changedPaths(from, to);
    const commits = (await this.git(["rev-list", `${from}..${to}`])).stdout.split("\n").filter(Boolean);
    this.attribute(commits, who);
    if (this.indexedHead === from) this.indexedHead = to;
    await this.reindexPaths(paths);
    return paths;
  }

  /** Mark notes as being saved by Wisp while `fn` runs. */
  private async saving<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    for (const p of paths) this.pending.set(p, (this.pending.get(p) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const p of paths) {
        const n = (this.pending.get(p) ?? 1) - 1;
        if (n > 0) this.pending.set(p, n);
        else this.pending.delete(p);
      }
    }
  }

  private indexNote(p: string, raw: string, updatedAt: number): NoteMeta {
    const parsed = parseNote(p, raw);
    const tx = this.db.transaction(() => {
      this.unindexRows(p);
      const type = typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type.trim().toLowerCase() || null : null;
      this.db.prepare("INSERT INTO vault_notes (path, title, tags, updated_at, type) VALUES (?, ?, ?, ?, ?)").run(p, parsed.title, JSON.stringify(parsed.tags), Math.round(updatedAt), type);
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
      await this.commitStaged(author, message, paths);
    });
  }

  private commitAll(author: CommitAuthor, message: string) {
    return this.serial(async () => {
      await this.git(["add", "-A"]);
      await this.commitStaged(author, message);
    });
  }

  /** Commit what's staged (only `paths`, when given). Does nothing when there's nothing to commit. `indexed`: the commit's notes are already in the index. */
  private async commitStaged(author: CommitAuthor, message: string, paths?: string[], indexed = true) {
    const { stdout } = await this.git(["status", "--porcelain", ...(paths ? ["--", ...paths] : [])]);
    if (!stdout.trim()) return;
    const before = await this.head();
    await this.git(["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message, "--author", `${author.name} <${author.email}>`, ...(paths ? ["--", ...paths] : [])], author);
    // Wisp's own saves are already in the index; edits found on disk are not
    if (indexed && this.indexedHead === before) this.indexedHead = await this.head();
  }

  /** git operations must not interleave (index.lock). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  private git(args: string[], author?: CommitAuthor) {
    const who = author ?? { name: "Wisp", email: "wisp@localhost" };
    return exec("git", args, {
      cwd: this.root,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email },
    });
  }
}

/** What a caller holding the vault exclusively may do. */
export interface VaultTx {
  head(): Promise<string | null>;
  branch(): Promise<string | null>;
  /** commit and index edits made outside Wisp first, so the vault is up to date */
  sync(): Promise<number>;
  adopt(source: string, branch: string, from: string, to: string, who: string): Promise<string[]>;
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

/** The built-in top folders a note lives under, or "other" for folders people made. */
export type FolderKind = "people" | "agents" | "teams" | "groups" | "shared" | "other";
export interface GraphNode {
  /** the note's path, or "ghost:<target>" for a link to a note that doesn't exist (or that you can't see) */
  id: string;
  path: string | null;
  title: string;
  kind: FolderKind | "ghost";
  /** front matter `type:` (person, project, topic, decision, journal, reference), lowercased */
  type: string | null;
  tags: string[];
  updatedAt: number | null;
  /** how many notes it's linked with, either way */
  links: number;
  /** how many notes link to it */
  inbound: number;
}
export interface GraphEdge {
  source: string;
  target: string;
}
export interface VaultGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const KINDS = new Set(["people", "agents", "teams", "groups", "shared"]);
export function folderKind(p: string): FolderKind {
  const top = p.split("/")[0]!.toLowerCase();
  return p.includes("/") && KINDS.has(top) ? (top as FolderKind) : "other";
}

/**
 * Obsidian-style link resolution among `paths`: the exact path, then a note with that name,
 * preferring one in the linking note's own scope (`shared/`, or `agents/<id>/`, `people/<id>/`…).
 */
export function linkResolver(paths: string[]): (target: string, from?: string | null) => string | null {
  const exact = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    exact.set(normalizeTarget(p), p);
    const k = normalizeTarget(basename(p));
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  return (target, from) => {
    const t = normalizeTarget(target);
    const hit = exact.get(t);
    if (hit) return hit;
    const named = byName.get(t) ?? [];
    const scope = from?.split("/").slice(0, from.startsWith("shared/") ? 1 : 2).join("/");
    return (scope && named.find((p) => p.startsWith(scope + "/"))) || named[0] || null;
  };
}

/** Notes that run agents rather than hold knowledge (skills, souls): never suggested as links or merges. */
const isMachinery = (p: string) => /(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(p) || /(^|\/)SOUL\.md$/i.test(p);

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
    // links to other places aren't followed: a note must really live in the vault
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(rel);
  }
  return out;
}
