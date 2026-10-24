/**
 * Helpers that keep a vault tidy when agents save notes: a small front-matter header, and hints
 * (similar notes to merge into, names to link). They only ever add; nothing is rejected.
 */
import { basename } from "./markdown.ts";

export const NOTE_TYPES = ["person", "project", "topic", "decision", "journal", "reference"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** The type a note's folder (or name) suggests: people/ → person, projects/ → project, and so on. */
export function guessType(path: string): NoteType {
  const dirs = path.toLowerCase().split("/").slice(0, -1);
  const name = basename(path).toLowerCase();
  if (dirs.includes("journal")) return "journal";
  if (dirs.includes("decisions") || /(^|-)decision(s)?(-|$)/.test(name)) return "decision";
  if (dirs.includes("people")) return "person";
  if (dirs.includes("projects")) return "project";
  if (dirs.includes("topics")) return "topic";
  return "reference";
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Add the front-matter keys a note is missing. Keys it already has are left exactly as they are. */
export function fillFrontmatter(raw: string, fields: Record<string, string | null | undefined>): string {
  const fm = raw.match(FRONTMATTER);
  const has = new Set(fm ? [...fm[1].matchAll(/^([\w-]+):/gm)].map((m) => m[1].toLowerCase()) : []);
  const add = Object.entries(fields)
    .filter(([k, v]) => v && !has.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`);
  if (!add.length) return raw;
  if (!fm) return `---\n${add.join("\n")}\n---\n\n${raw.replace(/^\s*\n/, "")}`;
  const nl = fm[0].includes("\r\n") ? "\r\n" : "\n";
  return `---${nl}${fm[1]}${nl}${add.join(nl)}${nl}---${nl}${raw.slice(fm[0].length)}`;
}

const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its just me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about also not".split(" "),
);

/** The meaningful words in a text (lowercase, 3+ letters, no stopwords). */
export function noteWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * How much two notes say the same thing: shared words over all their words (0..1). A short hub
 * note that a longer note mentions scores low, so it's offered as a link, not a merge.
 */
export function overlap(a: Set<string>, b: Set<string>): { shared: number; score: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const all = a.size + b.size - shared;
  return { shared, score: all ? shared / all : 0 };
}

/** Names that are too generic to suggest as links. */
const GENERIC = new Set(["readme", "soul", "skill", "index", "notes", "note", "todo", "untitled", "journal", "inbox"]);

/** The names a note goes by in text: its title and its file name with dashes as spaces. */
export function linkNames(path: string, title: string): string[] {
  const names = [title, basename(path).replace(/[-_]+/g, " ")].map((n) => n.toLowerCase().replace(/\s+/g, " ").trim());
  return [...new Set(names)].filter((n) => n.length >= 4 && /\p{L}/u.test(n) && !GENERIC.has(n));
}

/** Whether `text` (lowercase) mentions `name` as whole words. */
export function mentions(text: string, name: string): boolean {
  const pattern = name
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u").test(text);
}
