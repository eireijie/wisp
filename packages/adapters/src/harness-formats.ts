import fs from "node:fs/promises";
import path from "node:path";
import { frontMatter, shortDescription, type HarnessSettingItem } from "@wisp/core";

/**
 * File formats harness configs come in, read and changed the way harness-config.ts needs: YAML and
 * TOML edited by line (comments and layout stay), JSON with comments read leniently, and writing a
 * config safely (backup, then swap in at once).
 */

export function mcpItem(name: string, v: Record<string, unknown>, enabled: boolean, canToggle: boolean): HarnessSettingItem {
  const detail = str(v.url) ?? [str(v.command), ...strings(v.args)].filter(Boolean).join(" ");
  return { id: name, name, enabled, canToggle, detail: detail ? detail.slice(0, 500) : undefined };
}

/** Skills under `root`: `<root>/<name>/SKILL.md`, or one level of categories deeper (Hermes). Ids are their names. */
export async function findSkills(root: string): Promise<{ id: string; name: string; description?: string; file: string }[]> {
  const out: { id: string; name: string; description?: string; file: string }[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const n of (await fs.readdir(dir).catch(() => [] as string[])).sort()) {
      if (n.startsWith(".")) continue;
      const file = path.join(dir, n, "SKILL.md");
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text === null) {
        if (depth < 2) await walk(path.join(dir, n), depth + 1);
        continue;
      }
      const fm = frontMatter(text);
      const id = fm.name || n;
      if (!out.some((s) => s.id === id)) out.push({ id, name: id, description: shortDescription(fm.description), file });
    }
  };
  await walk(root, 0);
  return out.slice(0, 500);
}

/**
 * Write `after` over `file` if it still holds `before`: a backup of it next to it first (the newest
 * three kept), then the new text into a temporary file that's renamed over it, so the harness never
 * reads half a file.
 */
export async function safeWrite(file: string, before: string, after: string) {
  const now = await fs.readFile(file, "utf8").catch(() => "");
  if (now !== before) throw new Error(`${path.basename(file)} changed while Wisp was changing it; try again`);
  const mode = (await fs.stat(file).catch(() => null))?.mode;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (before !== "") {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await fs.copyFile(file, `${file}.wisp-bak.${stamp}`);
    const base = path.basename(file);
    const old = (await fs.readdir(path.dirname(file))).filter((n) => (n.startsWith(`${base}.wisp-bak.`) || n.startsWith(`${base}.warren-bak.`))).sort().slice(0, -3);
    for (const n of old) await fs.rm(path.join(path.dirname(file), n), { force: true });
  }
  const tmp = `${file}.wisp-tmp-${process.pid}`;
  await fs.writeFile(tmp, after, { mode: mode ? mode & 0o777 : 0o644 });
  await fs.rename(tmp, file);
}

// --- YAML: edits by line, so comments and layout stay ---------------------------------------------

export interface YamlKey {
  line: number;
  /** the line after its value (its nested block or list) */
  end: number;
  indent: number;
}

export const indentOf = (l: string) => /^ */.exec(l)![0].length;
export const blank = (l: string) => /^\s*(#.*)?$/.test(l);
export const yamlKeyRe = (key: string) => new RegExp(`^( *)(?:${escapeRe(key)}|"${escapeRe(key)}"|'${escapeRe(key)}'):(?:\\s|$)`);

/** `key` directly inside the block [from, to) whose keys sit at `indent`. */
export function yamlFind(lines: string[], key: string, from: number, to: number, indent: number): YamlKey | null {
  const re = yamlKeyRe(key);
  for (let i = from; i < to; i++) {
    if (blank(lines[i]) || indentOf(lines[i]) !== indent || !re.test(lines[i])) continue;
    let end = i + 1;
    // a list under a key may sit at the key's own indent ("key:\n- a")
    while (end < to && (blank(lines[end]) || indentOf(lines[end]) > indent || (indentOf(lines[end]) === indent && /^ *- /.test(lines[end])))) end++;
    while (end > i + 1 && blank(lines[end - 1])) end--;
    return { line: i, end, indent };
  }
  return null;
}

/** The indent of the keys inside `k`'s block, or `k.indent + 2` when it has none yet. */
export function childIndent(lines: string[], k: YamlKey): number {
  for (let i = k.line + 1; i < k.end; i++) if (!blank(lines[i])) return indentOf(lines[i]);
  return k.indent + 2;
}

/** Find (or add) each parent key on `path`; returns where the last key's line is (or should go) and its indent. */
export function yamlParents(lines: string[], parents: string[]): { from: number; to: number; indent: number } {
  let scope = { from: 0, to: lines.length, indent: 0 };
  for (const p of parents) {
    const k = yamlFind(lines, p, scope.from, scope.to, scope.indent);
    if (k) {
      if (/:\s*\S/.test(lines[k.line].replace(/\s+#.*$/, "")) && !/:\s*\{\s*\}\s*$/.test(lines[k.line]) && !/:\s*null\s*$/.test(lines[k.line])) throw new Error(`"${p}" isn't a section in this config; change it on the device`);
      // "key: {}" or "key: null": becomes a block
      lines[k.line] = lines[k.line].replace(/:\s*(\{\s*\}|null)\s*$/, ":");
      scope = { from: k.line + 1, to: k.end, indent: childIndent(lines, k) };
    } else {
      // a new section at the end of its parent
      let at = scope.to;
      while (at > scope.from && blank(lines[at - 1])) at--;
      lines.splice(at, 0, `${" ".repeat(scope.indent)}${yamlKey(p)}:`);
      scope = { from: at + 1, to: at + 1, indent: scope.indent + 2 };
    }
  }
  return scope;
}

/** Set a scalar at `path` (null removes the key's value, leaving "key:"). */
export function yamlSetScalar(text: string, keyPath: string[], value: string | boolean | null): string {
  const lines = splitLines(text);
  const scope = yamlParents(lines, keyPath.slice(0, -1));
  const key = keyPath.at(-1)!;
  const k = yamlFind(lines, key, scope.from, scope.to, scope.indent);
  const line = `${" ".repeat(scope.indent)}${yamlKey(key)}:${value === null ? "" : ` ${yamlScalar(value)}`}`;
  if (!k) lines.splice(scope.to, 0, line);
  else {
    if (k.end > k.line + 1 && value !== null) throw new Error(`"${keyPath.join(".")}" isn't a single value in this config; change it on the device`);
    const comment = /\s+#[^"']*$/.exec(lines[k.line])?.[0] ?? "";
    lines[k.line] = line + (value === null ? "" : comment);
  }
  return joinLines(lines, text);
}

/** Set a list of strings at `path`, as a block list (or [] when empty). */
export function yamlSetList(text: string, keyPath: string[], values: string[]): string {
  const lines = splitLines(text);
  const scope = yamlParents(lines, keyPath.slice(0, -1));
  const key = keyPath.at(-1)!;
  const k = yamlFind(lines, key, scope.from, scope.to, scope.indent);
  const pad = " ".repeat(scope.indent);
  const block = values.length ? [`${pad}${yamlKey(key)}:`, ...values.map((v) => `${pad}  - ${yamlScalar(v)}`)] : [`${pad}${yamlKey(key)}: []`];
  if (k) lines.splice(k.line, k.end - k.line, ...block);
  else lines.splice(scope.to, 0, ...block);
  return joinLines(lines, text);
}

export function yamlKey(k: string) {
  return /^[A-Za-z0-9_][\w.-]*$/.test(k) ? k : JSON.stringify(k);
}

export function yamlScalar(v: string | boolean) {
  if (typeof v === "boolean") return String(v);
  const plain = /^[A-Za-z_./][\w./+@-]*$/.test(v) && !/^(true|false|yes|no|on|off|null|~)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

// --- TOML: a reader for the parts Wisp needs, and edits by line ---------------------------------

export interface TomlTable {
  path: string[];
  array: boolean;
  /** which [[array]] entry this is (counted over the whole file), 0 for plain tables */
  arrayIndex: number;
  line: number;
}
export interface TomlEntry {
  table: string[];
  arrayIndex: number;
  key: string;
  /** the value as written */
  raw: string;
  value: unknown;
  line: number;
  end: number;
}
export interface TomlDoc {
  tables: TomlTable[];
  entries: TomlEntry[];
}

/** Dotted keys: `a.b."c d"` → ["a", "b", "c d"]. */
export function tomlKeyPath(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < s.length && (m = re.exec(s))) {
    out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3]));
    at = re.lastIndex;
    if (!m[4]) break;
  }
  if (at < s.trimEnd().length || !out.length) throw new Error(`can't read the key ${s}`);
  return out;
}

export function parseToml(text: string): TomlDoc {
  const lines = splitLines(text);
  const doc: TomlDoc = { tables: [], entries: [] };
  let table: string[] = [];
  let arrayIndex = 0;
  let arrays = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("#")) continue;
    // a key can't start with "[", so this is a [table] or [[array]] header
    if (l.startsWith("[")) {
      const header = /^(\[\[?)\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(l);
      if (!header) throw new Error(`line ${i + 1} isn't something Wisp can read: ${l.slice(0, 60)}`);
      const array = header[1] === "[[";
      table = tomlKeyPath(header[2]);
      arrayIndex = array ? ++arrays : 0;
      doc.tables.push({ path: table, array, arrayIndex, line: i });
      continue;
    }
    const eq = tomlSplitKey(l);
    if (!eq) throw new Error(`line ${i + 1} isn't something Wisp can read: ${l.slice(0, 60)}`);
    const keys = tomlKeyPath(eq.key);
    // a value can go on over several lines (arrays, """strings""")
    let raw = eq.value;
    let end = i + 1;
    while (!tomlComplete(raw) && end < lines.length) raw += `\n${lines[end++]}`;
    raw = stripTomlComment(raw);
    doc.entries.push({ table: [...table, ...keys.slice(0, -1)], arrayIndex, key: keys.at(-1)!, raw, value: tomlValue(raw), line: i, end });
    i = end - 1;
  }
  return doc;
}

export function tomlSplitKey(l: string): { key: string; value: string } | null {
  let q: string | null = null;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "=") return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  }
  return null;
}

/** Brackets and braces balanced and no string left open, outside strings. */
export function tomlComplete(raw: string): boolean {
  if ((raw.match(/"""/g) ?? []).length % 2 || (raw.match(/'''/g) ?? []).length % 2) return false;
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#") {
      const nl = raw.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
    } else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth <= 0;
}

export function stripTomlComment(raw: string): string {
  if (raw.startsWith('"""') || raw.startsWith("'''")) return raw.trim();
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#" && !raw.includes("\n")) return raw.slice(0, i).trim();
  }
  return raw.trim();
}

/** Strings, booleans, numbers and arrays of them; anything else stays as written. */
export function tomlValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "true" || s === "false") return s === "true";
  if (/^"([^"\\]|\\.)*"$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(s)) return Number(s.replace(/_/g, ""));
  if (s.startsWith("[") && s.endsWith("]")) {
    const items: unknown[] = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?\d[\d_.]*)\s*(?:,|$)/y;
    const body = s.slice(1, -1).replace(/#[^\n]*/g, "").replace(/\s+/g, " ").trim().replace(/,\s*$/, "");
    let m: RegExpExecArray | null;
    let at = 0;
    while (at < body.length && (m = re.exec(body))) {
      items.push(tomlValue(m[1]));
      at = re.lastIndex;
    }
    return at >= body.length ? items : s;
  }
  return s;
}

export function tomlString(s: string) {
  return JSON.stringify(s);
}

export function tomlLiteral(v: string | boolean) {
  return typeof v === "boolean" ? String(v) : tomlString(v);
}

/** Set `key` in `[table]` (the top when empty; the `arrayIndex`th [[table]] entry for arrays), adding the table if it's missing. */
export function tomlSet(text: string, table: string[], key: string, value: string | boolean, arrayIndex = 0): string {
  const doc = parseToml(text);
  const lines = splitLines(text);
  const line = `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlLiteral(value)}`;
  const entry = doc.entries.find((e) => sameKey(e.table, table) && e.key === key && e.arrayIndex === arrayIndex);
  if (entry) {
    if (entry.end - entry.line > 1) throw new Error(`${key} is written over several lines; change it on the device`);
    const comment = /\s+#[^"']*$/.exec(lines[entry.line])?.[0] ?? "";
    lines.splice(entry.line, 1, `${/^\s*/.exec(lines[entry.line])![0]}${line}${comment}`);
    return joinLines(lines, text);
  }
  if (!table.length) {
    // before the first table, after any leading comments
    const first = doc.tables[0]?.line ?? lines.length;
    let at = 0;
    while (at < first && /^\s*#/.test(lines[at])) at++;
    lines.splice(at, 0, line);
    return joinLines(lines, text);
  }
  const t = doc.tables.find((x) => sameKey(x.path, table) && x.arrayIndex === arrayIndex);
  if (t) {
    lines.splice(t.line + 1, 0, line);
    return joinLines(lines, text);
  }
  const header = `[${table.map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p))).join(".")}]`;
  const body = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${body ? "\n" : ""}${header}\n${line}\n`;
}

// --- helpers -----------------------------------------------------------------------------------

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function joinLines(lines: string[], like: string): string {
  const nl = like.includes("\r\n") ? "\r\n" : "\n";
  return lines.join(nl) + (lines.length ? nl : "");
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const sameKey = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function boolish(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return !/^(false|no|off|0)$/i.test(v.trim());
  return fallback;
}

export async function readJson(file: string, strict = false): Promise<unknown> {
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    if (strict) throw err;
    return {};
  }
}

export function setPath(obj: Record<string, unknown>, keyPath: string[], value: unknown) {
  let o = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keyPath.at(-1)!] = value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // an empty section reads back as null
  if ((a === null && isEmptyObj(b)) || (b === null && isEmptyObj(a))) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export const isEmptyObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length;

// --- JSON with comments (OpenCode's JSONC, OpenClaw's JSON5) --------------------------------------

/** Comments and trailing commas out, outside strings; then JSON. Throws for what's still not JSON (JSON5's bare keys). */
export function parseJsonc(text: string): unknown {
  if (!text.trim()) return {};
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Plain JSON (no comments), so it can be written back without losing anything but spacing. */
export function isPlainJson(text: string): boolean {
  if (!text.trim()) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Change a JSON config by mutating its parsed value; keeps its indent. Refuses a file with comments. */
export function editJson(text: string, name: string, mutate: (o: Record<string, unknown>) => void): string {
  if (!isPlainJson(text)) throw new Error(`${name} has comments in it, so Wisp leaves it as it is; change it on the device`);
  const o = text.trim() ? asObject(JSON.parse(text)) : {};
  mutate(o);
  const indent = /^\{\s*\n(\s+)"/.exec(text)?.[1] ?? "  ";
  return JSON.stringify(o, null, indent.includes("\t") ? "\t" : indent.length) + (text === "" || text.endsWith("\n") ? "\n" : "");
}

/** An object at `keyPath`, made if it isn't there. */
export function objAt(o: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  let cur = o;
  for (const k of keyPath) {
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

/** Add or take a name out of a list of names at `keyPath`; drops the list when it ends up empty. */
export function toggleInList(o: Record<string, unknown>, keyPath: string[], name: string, present: boolean) {
  const parent = objAt(o, keyPath.slice(0, -1));
  const key = keyPath.at(-1)!;
  const set = new Set(strings(parent[key]));
  present ? set.add(name) : set.delete(name);
  if (set.size) parent[key] = [...set];
  else delete parent[key];
}

/**
 * YAML edits by line (see yamlSetScalar/yamlSetList), checked: the file must read back as before
 * plus exactly these values.
 */
export function editYaml(text: string, name: string, sets: { path: string[]; value: string | boolean | string[] }[], load: (t: string) => unknown): string {
  const expected = structuredClone(asObject(load(text)));
  let out = text;
  for (const s of sets) {
    out = Array.isArray(s.value) ? yamlSetList(out, s.path, s.value) : yamlSetScalar(out, s.path, s.value);
    setPath(expected, s.path, s.value);
  }
  let parsed: unknown;
  try {
    parsed = load(out);
  } catch (err) {
    throw new Error(`the change would leave ${name} unreadable (${(err as Error).message}); nothing was changed`);
  }
  if (!deepEqual(parsed, expected)) throw new Error(`the change didn't come out as expected, so ${name} was left as it was`);
  return out;
}

/** What a reader gives back about a harness's config. */
export interface ConfigSummary {
  model: string | null;
  provider: string | null;
  providers: { id: string; signedIn: boolean }[] | null;
  apps: HarnessSettingItem[];
  plugins: HarnessSettingItem[];
  skills: HarnessSettingItem[];
  /** what Wisp shows but can't change for this harness ("model", "provider"), or everything ("file") */
  fixed?: ("model" | "provider" | "file")[];
  modelChoices?: string[];
  /** the default reasoning effort, for harnesses whose config has one Wisp can change */
  effort?: string | null;
}

/** Skills under each root, in order, the first of a name winning; `on` says which are on and `canToggle` whether that can change. */
export async function skillItems(roots: string[], on: (id: string) => boolean, canToggle: boolean): Promise<HarnessSettingItem[]> {
  const out: HarnessSettingItem[] = [];
  for (const root of roots) for (const s of await findSkills(root)) if (!out.some((k) => k.id === s.id)) out.push({ id: s.id, name: s.name, description: s.description, enabled: on(s.id), canToggle });
  return out;
}

/** Plugins or extensions kept as folders with a manifest (`<root>/<name>/<manifest>`). */
export async function manifestDirs(root: string, manifest: string): Promise<{ id: string; name: string; description?: string }[]> {
  const out: { id: string; name: string; description?: string }[] = [];
  for (const n of (await fs.readdir(root).catch(() => [] as string[])).sort()) {
    if (n.startsWith(".")) continue;
    const m = asObject(await readJson(path.join(root, n, manifest)));
    if (!Object.keys(m).length && !(await fs.stat(path.join(root, n, manifest)).catch(() => null))) continue;
    out.push({ id: n, name: str(m.name) ?? n, description: shortDescription(str(m.description) ?? undefined) });
  }
  return out;
}
