import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: true });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// a small ghost (Phosphor, MIT), inlined so mention chips need no extra requests
const BOT_ICON =
  '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M112,116a12,12,0,1,1-12-12A12,12,0,0,1,112,116Zm44-12a12,12,0,1,0,12,12A12,12,0,0,0,156,104Zm68,16v96a8,8,0,0,1-13.07,6.19l-24.26-19.85L162.4,222.19a8,8,0,0,1-10.13,0L128,202.34l-24.27,19.85a8,8,0,0,1-10.13,0L69.33,202.34,45.07,222.19A8,8,0,0,1,32,216V120a96,96,0,0,1,192,0Zm-16,0a80,80,0,0,0-160,0v79.12l16.27-13.31a8,8,0,0,1,10.13,0l24.27,19.85,24.26-19.85a8,8,0,0,1,10.14,0l24.26,19.85,24.27-19.85a8,8,0,0,1,10.13,0L208,199.12Z"/></svg>';

/**
 * Markdown -> sanitized HTML, with Obsidian [[wikilinks]], @mentions and #tags.
 * `known` decides whether a wikilink target exists (rendered differently if missing).
 * `handles` maps agent handles to display names; mentions of them become chips, tinted with the
 * agent's own color when `colors` has one.
 */
export function renderMarkdown(src: string, opts: { known?: (target: string) => boolean; handles?: Set<string> | Map<string, string>; colors?: Map<string, string>; stripFrontmatter?: boolean } = {}): string {
  let text = src;
  if (opts.stripFrontmatter) text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

  // Protect code before rewriting links and mentions.
  const stash: string[] = [];
  text = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => `\u0000${stash.push(m) - 1}\u0000`);

  text = text.replace(/(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, _embed, target: string, _h, alias?: string) => {
    const t = target.trim();
    const cls = opts.known && !opts.known(t) ? "wikilink missing" : "wikilink";
    return `<a class="${cls}" data-wikilink="${escape(t)}">${escape(alias?.trim() || t)}</a>`;
  });
  if (opts.handles) {
    const names = opts.handles;
    text = text.replace(/(^|[^\w@.`])@([a-zA-Z][\w-]{0,31})/g, (m, pre: string, h: string) => {
      const key = h.toLowerCase();
      if (!names.has(key)) return m;
      const label = names instanceof Map ? names.get(key)! : `@${h}`;
      const color = opts.colors?.get(key);
      const tint = color && /^#[0-9a-fA-F]{6}$/.test(color) ? ` agent" style="--agent:${color}` : "";
      return `${pre}<span class="mention${tint}" title="@${escape(key)}">${BOT_ICON}${escape(label)}</span>`;
    });
  }
  text = text.replace(/(^|\s)#([a-zA-Z][\w/-]*)/g, (_m, pre: string, tag: string) => `${pre}<span class="tag">#${escape(tag)}</span>`);
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)]);

  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-wikilink", "target"], ADD_TAGS: ["svg", "path", "rect"] });
}
