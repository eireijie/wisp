import { createHash } from "node:crypto";

/**
 * Reading a web page without a model: the text a person would see, one line per block, so two looks
 * at the same page can be compared. Website watches use it to wake an agent only when lines were
 * added, instead of paying for a model to open the page every time.
 */

/** Lines remembered per page; a longer page keeps its first ones. */
const MAX_LINES = 3000;
/** Under this much text, the page is probably a shell that needs scripts, or a sign-in: let the agent look. */
const MIN_TEXT = 200;
/** Pages bigger than this aren't read. */
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…", mdash: "—", ndash: "–", middot: "·", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", bull: "•" };

/** "3 minutes ago", "just now", "yesterday": they change on their own, so they don't count as a change. */
const RELATIVE_TIME = /\b(?:(?:\d+|an?|one|a few)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago|just now|yesterday|today|\d+\s*(?:s|m|h|d|w|mo|y)\s+ago)\b/gi;

/** The text a person would see on the page, one trimmed line per block, without times that only say how long ago. */
export function pageLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|main|aside|button|option|dt|dd|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(RELATIVE_TIME, " ").replace(/\s+/g, " ").trim();
    // lines with almost no words (counters, dates, icons) change without anything happening
    if ((line.match(/\p{L}/gu)?.length ?? 0) < 3 || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** A short fingerprint for one line, so the hub keeps no page text between looks. */
export const lineKey = (line: string) => createHash("sha256").update(line.toLowerCase()).digest("base64url").slice(0, 12);

/** Whether the page asks to sign in: then only the agent's own browser, where the person signed in, sees the real page. */
export const asksToSignIn = (html: string) => /<input\b[^>]*type\s*=\s*["']?password/i.test(html);

export type PageRead = { ok: true; lines: string[] } | { ok: false; why: string };

/**
 * Fetch a page the way a signed-out browser would and read its lines. Anything that needs a person's
 * sign-in, scripts, or a redirect comes back not ok: the agent looks itself instead.
 */
export async function readPage(fetchImpl: typeof fetch, url: string): Promise<PageRead> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "Mozilla/5.0 (compatible; Wisp watch)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, why: `the site answered ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/html|text\/plain|xhtml/i.test(type)) return { ok: false, why: "not a web page" };
    const html = await res.text();
    if (html.length > MAX_BYTES) return { ok: false, why: "page too big" };
    if (asksToSignIn(html)) return { ok: false, why: "it asks to sign in" };
    const lines = pageLines(html);
    if (lines.join(" ").length < MIN_TEXT) return { ok: false, why: "the page needs a browser to show" };
    return { ok: true, lines };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/** Lines on the page now that weren't there last time (`before` holds line keys). */
export function addedLines(before: string[], now: string[]): string[] {
  const had = new Set(before);
  return now.filter((l) => !had.has(lineKey(l)));
}
