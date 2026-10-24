/** Obsidian-flavoured markdown helpers. */

export interface ParsedNote {
  frontmatter: Record<string, string | string[]>;
  body: string;
  links: string[]; // wikilink targets, normalized (no alias/heading, no .md)
  tags: string[];
  title: string;
}

export function parseNote(path: string, raw: string): ParsedNote {
  let frontmatter: ParsedNote["frontmatter"] = {};
  let body = raw;
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    frontmatter = parseFrontmatter(fm[1]);
    body = raw.slice(fm[0].length);
  }
  const links = new Set<string>();
  // like Obsidian, a [[link]] inside code is an example, not a link
  for (const m of withoutCode(body).matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    links.add(normalizeTarget(m[1]));
  }
  // links in front matter (`related: ["[[acme]]"]`) count too, as they do in Obsidian
  // (a target never starts with "[", so YAML like `[[[a]], [[b]]]` still finds a and b)
  for (const m of (fm?.[1] ?? "").matchAll(/\[\[([^[\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) links.add(normalizeTarget(m[1]));
  const tags = new Set<string>();
  for (const m of body.replace(/```[\s\S]*?```/g, "").matchAll(/(^|\s)#([\w/-]+)/g)) tags.add(m[2]);
  const fmTags = frontmatter.tags;
  for (const t of Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []) tags.add(t);

  const heading = body.match(/^#\s+(.+)$/m)?.[1];
  const title = (typeof frontmatter.title === "string" && frontmatter.title) || heading || basename(path);
  return { frontmatter, body, links: [...links], tags: [...tags], title };
}

/** Minimal YAML subset: `key: value`, `key: [a, b]`, and `- item` lists. */
function parseFrontmatter(src: string): ParsedNote["frontmatter"] {
  const out: ParsedNote["frontmatter"] = {};
  let listKey: string | null = null;
  for (const line of src.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "") {
      out[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]") && !/^\[\[[^\]]*\]\]$/.test(value)) {
      // a list, but not a single [[link]]
      out[key] = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      listKey = null;
    } else {
      out[key] = unquote(value);
      listKey = null;
    }
  }
  return out;
}

function unquote(s: string) {
  return s.replace(/^["']|["']$/g, "");
}

/** The text with fenced and inline code taken out. */
export function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function normalizeTarget(target: string): string {
  return target.trim().replace(/\.md$/i, "").toLowerCase();
}

export function basename(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}
