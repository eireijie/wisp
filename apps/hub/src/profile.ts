import { personDir } from "@wisp/core";
import { parseNote, type CommitAuthor, type Vault } from "@wisp/vault";

/** What agents remember about a person. "did" is a dated journal of what they did. */
export const MEMORY_KINDS = ["preference", "plan", "did", "detail"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const FOLDER: Record<MemoryKind, string> = { preference: "preferences", plan: "plans", did: "journal", detail: "details" };
const KIND_OF_FOLDER = Object.fromEntries(Object.entries(FOLDER).map(([k, v]) => [v, k])) as Record<string, MemoryKind>;

export interface MemoryItem {
  path: string;
  kind: MemoryKind;
  text: string;
  title: string;
  /** who wrote it: "@atlas" or a person's name */
  by: string | null;
  /** where it came from, e.g. "#general" */
  source: string | null;
  /** message it came from, for linking back */
  messageId: string | null;
  channelId: string | null;
  created: string | null;
  updated: string | null;
  pinned: boolean;
  /** plans: active, done or dropped */
  status: string | null;
  due: string | null;
  /** journal entries: the day, and the entry's line in that day's note */
  date: string | null;
  line: number | null;
}

export interface Origin {
  by: string;
  source?: string | null;
  messageId?: string | null;
  channelId?: string | null;
}

const STOP = new Set("a an and are as at be but by for from has have i in is it its of on or that the this to was with their they them he she his her you your".split(" "));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

/** How alike two memories are: shared meaningful words over all of them (0..1). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const yaml = (v: string) => JSON.stringify(oneLine(v).replace(/"/g, "'"));
const slug = (t: string) =>
  oneLine(t)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 7)
    .join("-")
    .slice(0, 60)
    .replace(/(-[^-]{1,2})+$/, "") || "memory";
const today = () => new Date().toISOString().slice(0, 10);

function render(kind: MemoryKind, text: string, meta: { title: string; origin: Origin | null; created: string; updated?: string; pinned?: boolean; status?: string | null; due?: string | null }): string {
  const fm = [
    `kind: ${kind}`,
    `title: ${yaml(meta.title)}`,
    meta.origin ? `by: ${yaml(meta.origin.by)}` : "",
    meta.origin?.source ? `source: ${yaml(meta.origin.source)}` : "",
    meta.origin?.channelId ? `channel: ${meta.origin.channelId}` : "",
    meta.origin?.messageId ? `message: ${meta.origin.messageId}` : "",
    `created: ${meta.created}`,
    meta.updated ? `updated: ${meta.updated}` : "",
    meta.pinned ? "pinned: true" : "",
    kind === "plan" ? `status: ${meta.status ?? "active"}` : "",
    meta.due ? `due: ${meta.due}` : "",
  ].filter(Boolean);
  return `---\n${fm.join("\n")}\n---\n${text.trim()}\n`;
}

/** Notes under people/<id>/: one note per preference, plan and detail, and a journal note per day. */
export class Profiles {
  constructor(private vault: Vault) {}

  async items(userId: string): Promise<MemoryItem[]> {
    const dir = personDir(userId) + "/";
    const out: MemoryItem[] = [];
    for (const meta of this.vault.list((p) => p.startsWith(dir))) {
      const folder = meta.path.slice(dir.length).split("/")[0];
      const kind = KIND_OF_FOLDER[folder];
      if (!kind) continue;
      let raw: string;
      try {
        raw = (await this.vault.read(meta.path)).content;
      } catch {
        continue;
      }
      const { frontmatter: fm, body } = parseNote(meta.path, raw);
      const str = (k: string) => (typeof fm[k] === "string" && fm[k] ? (fm[k] as string) : null);
      const base = { path: meta.path, kind, by: str("by"), source: str("source"), messageId: str("message"), channelId: str("channel"), created: str("created"), updated: str("updated"), pinned: fm.pinned === "true", status: str("status"), due: str("due"), date: null, line: null };
      if (kind === "did") {
        // one entry per "- " line; "— @atlas" at the end says who wrote it
        const date = meta.path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1] ?? null;
        body.split("\n").forEach((l, i) => {
          const m = l.match(/^\s*[-*]\s+(.*?)(?:\s+—\s+(@[\w-]+|[^—]+))?\s*$/);
          if (m && m[1]) out.push({ ...base, text: m[1], title: m[1], by: m[2]?.trim() ?? base.by, date, line: i, created: date });
        });
      } else {
        const text = body.trim();
        if (text) out.push({ ...base, text, title: str("title") ?? meta.title });
      }
    }
    return out.sort((a, b) => (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? ""));
  }

  /**
   * Save one memory about a person. A new preference, plan or detail that reads like one already
   * saved is not written; the caller gets the similar ones back and can pass `replaces` instead.
   */
  async remember(
    userId: string,
    m: { kind: MemoryKind; text?: string; title?: string; status?: string | null; due?: string | null; pinned?: boolean; replaces?: string; force?: boolean },
    origin: Origin,
    author: CommitAuthor,
    canEdit: (path: string) => boolean,
  ): Promise<{ saved: true; path: string } | { saved: false; similar: MemoryItem[]; error?: string }> {
    const dir = personDir(userId);
    const text = m.text?.trim() ?? "";
    if (m.kind === "did") {
      if (!text) return { saved: false, similar: [], error: "say what they did" };
      const path = `${dir}/journal/${today()}.md`;
      if (!canEdit(path)) return { saved: false, similar: [], error: `no edit access to ${path}` };
      let existing = "";
      try {
        existing = (await this.vault.read(path)).content;
      } catch {}
      const head = existing ? "" : render("did", "", { title: today(), origin: null, created: today() });
      await this.vault.write(path, `${head || existing}${existing && !existing.endsWith("\n") ? "\n" : ""}- ${oneLine(text)} — ${origin.by}\n`, author, `Journal: ${oneLine(text).slice(0, 60)}`);
      return { saved: true, path };
    }

    if (m.replaces) {
      const old = (await this.items(userId)).find((i) => i.path.toLowerCase() === m.replaces!.replace(/^\/+/, "").toLowerCase() && i.kind !== "did");
      if (!old) return { saved: false, similar: [], error: `no ${m.kind} at ${m.replaces} to replace` };
      if (!canEdit(old.path)) return { saved: false, similar: [], error: `no edit access to ${old.path}` };
      const body = text || old.text;
      const keep: Origin | null = old.by ? { by: old.by, source: old.source, messageId: old.messageId, channelId: old.channelId } : origin;
      const content = render(old.kind, body, {
        title: m.title ?? (text ? oneLine(text).slice(0, 80) : old.title),
        origin: keep,
        created: old.created ?? today(),
        updated: new Date().toISOString(),
        pinned: m.pinned ?? old.pinned,
        status: m.status ?? old.status,
        due: m.due !== undefined ? m.due : old.due,
      });
      await this.vault.write(old.path, content, author, `Update memory: ${oneLine(body).slice(0, 60)}`);
      return { saved: true, path: old.path };
    }

    if (!text) return { saved: false, similar: [], error: "nothing to remember" };
    if (!m.force) {
      const similar = (await this.items(userId)).filter((i) => i.kind === m.kind && similarity(i.text, text) >= 0.6);
      if (similar.length) return { saved: false, similar };
    }
    let path = `${dir}/${FOLDER[m.kind]}/${slug(m.title ?? text)}.md`;
    for (let n = 2; this.vault.list((p) => p.toLowerCase() === path.toLowerCase()).length; n++) path = `${dir}/${FOLDER[m.kind]}/${slug(m.title ?? text)}-${n}.md`;
    if (!canEdit(path)) return { saved: false, similar: [], error: `no edit access to ${path}` };
    const content = render(m.kind, text, { title: m.title ?? oneLine(text).slice(0, 80), origin, created: new Date().toISOString(), pinned: m.pinned, status: m.kind === "plan" ? (m.status ?? "active") : null, due: m.due ?? null });
    await this.vault.write(path, content, author, `Remember: ${oneLine(text).slice(0, 60)}`);
    return { saved: true, path };
  }

  /**
   * What an agent should know about a person when it starts working: every preference, active
   * plans, the last week of what they did, and the details most related to the message.
   */
  async context(userId: string, query: string, budget = 6000): Promise<string> {
    const items = await this.items(userId);
    if (!items.length) return "";
    const line = (i: MemoryItem, extra = "") => `- ${oneLine(i.text)}${extra} (${i.path})`;
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const q = words(query);
    const relevance = (i: MemoryItem) => [...words(i.text)].filter((w) => q.has(w)).length;
    const sections: [string, string[]][] = [
      ["Preferences", items.filter((i) => i.kind === "preference").sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((i) => line(i))],
      ["Plans", items.filter((i) => i.kind === "plan" && (i.status ?? "active") === "active").map((i) => line(i, i.due ? ` (due ${i.due})` : ""))],
      [
        "What they did recently",
        items
          .filter((i) => i.kind === "did" && (i.date ?? "") >= weekAgo)
          .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.line ?? 0) - (b.line ?? 0))
          .slice(-25)
          .map((i) => `- ${i.date}: ${oneLine(i.text)}`),
      ],
      ["Details", items.filter((i) => i.kind === "detail").sort((a, b) => Number(b.pinned) - Number(a.pinned) || relevance(b) - relevance(a)).map((i) => line(i))],
    ];
    let left = budget;
    const out: string[] = [];
    for (const [title, lines] of sections) {
      if (!lines.length) continue;
      const kept: string[] = [];
      for (const l of lines) {
        if (l.length + 1 > left) break;
        kept.push(l);
        left -= l.length + 1;
      }
      if (kept.length) out.push(`### ${title}\n${kept.join("\n")}${kept.length < lines.length ? `\n- …and ${lines.length - kept.length} more in ${personDir(userId)}/` : ""}`);
    }
    return out.join("\n\n");
  }
}
