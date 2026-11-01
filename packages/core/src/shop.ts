import { z } from "zod";
import type { MarketplaceEntry } from "./marketplace.ts";

/**
 * The marketplace: apps (MCP servers), skills from public SKILL.md repos, and what each device's
 * harnesses already have. Pure helpers shared by the hub, the device node and the web app.
 */

// --- logos -------------------------------------------------------------------------------------

/** What the hub knows about Simple Icons (simpleicons.org): slugs, and titles and aliases that point at them. */
export interface LogoIndex {
  /** squashed title or alias → slug */
  names: Map<string, string>;
  /** slug → brand color, hex without # */
  hex: Map<string, string>;
}

type SimpleIcon = { title: string; slug?: string; hex: string; aliases?: { aka?: string[]; dup?: { title: string }[]; loc?: Record<string, string> } };

/** Simple Icons' own rule for turning a title into a slug. */
export function titleToSlug(title: string): string {
  const map: Record<string, string> = { "+": "plus", ".": "dot", "&": "and", đ: "d", ħ: "h", ı: "i", ĸ: "k", ŀ: "l", ł: "l", ß: "ss", ŧ: "t" };
  return title
    .toLowerCase()
    .replace(/[+.&đħıĸŀłßŧ]/g, (c) => map[c])
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
}

const squash = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

export function logoIndex(icons: SimpleIcon[]): LogoIndex {
  const names = new Map<string, string>();
  const hex = new Map<string, string>();
  for (const i of icons) {
    const slug = i.slug ?? titleToSlug(i.title);
    hex.set(slug, i.hex);
    for (const n of [i.title, slug, ...(i.aliases?.aka ?? []), ...(i.aliases?.dup ?? []).map((d) => d.title)]) {
      const k = squash(n);
      if (k && !names.has(k)) names.set(k, slug);
    }
  }
  return { names, hex };
}

/** Words that say nothing about which app a server is for. */
const FILLER = /\b(mcp|server|servers|remote|official|connector|integration|api|the|for|tools?|by|and)\b/gi;

/**
 * The Simple Icons slug for an app, from its names in order of trust (e.g. its display name, then
 * its publisher's brand). A name only counts when all of it is a brand ("Google Calendar MCP" is
 * Google Calendar), never a word inside it, so "Square Root Calculator" isn't Square.
 */
export function logoSlug(names: (string | null | undefined)[], index: LogoIndex): string | null {
  for (const raw of names) {
    if (!raw) continue;
    for (const n of [raw, raw.replace(FILLER, " ")]) {
      const k = squash(n);
      if (k.length >= 2 && index.names.has(k)) return index.names.get(k)!;
    }
  }
  return null;
}

/** The address a brand's logo is served from, for <img src>. */
export const logoUrl = (names: (string | null | undefined)[]) => {
  const q = names.filter((n): n is string => !!n?.trim()).slice(0, 3);
  return q.length ? `/api/logo?${q.map((n) => `for=${encodeURIComponent(n)}`).join("&")}` : null;
};

/** Logos to try for a registry server, best first: its own icon, then its brand's. */
export function entryLogos(e: Pick<MarketplaceEntry, "icon" | "name" | "brand" | "id">): string[] {
  const short = e.id.split("/").pop() ?? "";
  // a favicon is too small for a tile, and often gone; the brand's own logo is better
  const icon = e.icon && !/favicon/i.test(e.icon) ? e.icon : null;
  return [icon, logoUrl([e.name, short, e.brand])].filter((x): x is string => !!x);
}

// --- app categories ----------------------------------------------------------------------------

export const APP_CATEGORIES = ["Email and calendar", "Developer", "Docs and notes", "Design", "Sales", "Finance", "Research", "Data", "Automation"] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

const CATEGORY_WORDS: [AppCategory, RegExp][] = [
  ["Email and calendar", /\b(e-?mail|gmail|outlook|inbox|calendar|meetings?|schedul\w*|zoom|calendly)\b/i],
  ["Design", /\b(figma|canva|design|webflow|wix|framer|sketch|image|video|sanity|cms)\b/i],
  ["Finance", /\b(payments?|stripe|paypal|invoice\w*|billing|accounting|bank\w*|quickbooks|xero|finance)\b/i],
  ["Sales", /\b(crm|sales|leads?|hubspot|salesforce|pipedrive|close|deals?|marketing|customers?|pandadoc|proposals?)\b/i],
  ["Docs and notes", /\b(notion|docs?|documents?|notes?|wiki|confluence|knowledge|pages|drive|files?)\b/i],
  ["Developer", /\b(github|gitlab|git|code|deploy\w*|vercel|cloudflare|issues?|pull requests?|ci|sentry|errors?|logs?|monitoring|grafana|pagerduty|linear|jira|playwright|browser|api testing|postman)\b/i],
  ["Data", /\b(database|sql|postgres\w*|supabase|neon|mongo\w*|redis|analytics|amplitude|warehouse|airtable|spreadsheets?|sheets)\b/i],
  ["Research", /\b(search|research|web|scrap\w*|crawl\w*|perplexity|exa|papers?|news)\b/i],
  ["Automation", /\b(zapier|automat\w*|workflows?|n8n|make\.com|agents?)\b/i],
];

/** A shelf for an app, from its name first and then what it says it does. */
export function appCategory(e: { name: string; description?: string | null }): AppCategory | null {
  for (const text of [e.name, e.description ?? ""]) for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return null;
}

// --- public skills -----------------------------------------------------------------------------

export interface SkillLicense {
  /** "Apache-2.0", "MIT", "Proprietary"… */
  label: string;
  /** whether it may be copied into agents' folders (an open-source license) */
  open: boolean;
}

/**
 * A skill's license, from its front matter `license` and the LICENSE file beside it. Only a
 * recognized open-source license counts as open; anything else (proprietary terms, "all rights
 * reserved", nothing at all) can be read at its source but isn't copied.
 */
export function skillLicense(frontMatterLicense: string | undefined, licenseText: string | undefined, repoLicense?: string): SkillLicense {
  const both = `${frontMatterLicense ?? ""}\n${(licenseText ?? "").slice(0, 2000)}`;
  if (/proprietary|all rights reserved/i.test(both)) return { label: "Proprietary", open: false };
  if (/apache[- ]?(license)?,?\s*(version\s*)?2\.0|apache-2/i.test(both)) return { label: "Apache-2.0", open: true };
  if (/\bMIT\b/.test(both)) return { label: "MIT", open: true };
  if (/\bBSD\b/.test(both)) return { label: "BSD", open: true };
  if (/\bCC0\b|creative commons zero/i.test(both)) return { label: "CC0", open: true };
  if (/\bCC[- ]BY(-4\.0)?\b(?![- ]?(NC|ND))/i.test(both)) return { label: "CC BY", open: true };
  if (/\bMPL\b|mozilla public/i.test(both)) return { label: "MPL-2.0", open: true };
  if (!frontMatterLicense && !licenseText && repoLicense) return skillLicense(repoLicense, undefined);
  return { label: frontMatterLicense?.trim().slice(0, 40) || "No license", open: false };
}

const ACRONYMS = new Set(["pdf", "docx", "pptx", "xlsx", "mcp", "api", "ci", "cli", "gh", "ui", "ux", "ai", "llm", "sql", "csv", "seo", "gif", "pr"]);

/** Names written their own way. */
const NAMES: Record<string, string> = { chatgpt: "ChatGPT", github: "GitHub", openai: "OpenAI", aspnet: "ASP.NET", winui: "WinUI", gitlab: "GitLab", arxiv: "arXiv", macos: "macOS", ios: "iOS" };

/** "frontend-design" → "Frontend design", "mcp-builder" → "MCP builder", "chatgpt-apps" → "ChatGPT apps". */
export function skillTitle(slug: string): string {
  const words = slug.replace(/[_-]+/g, " ").trim().split(/\s+/);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (NAMES[lower]) return NAMES[lower];
      if (ACRONYMS.has(lower)) return w.toUpperCase();
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : lower;
    })
    .join(" ");
}

/** The body of a SKILL.md, without its front matter. */
export const skillBody = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/**
 * A public skill as installed: its own words, with links to the files beside it pointing at its
 * source (so scripts and references are read from there rather than copied), and a line naming
 * where it came from and its license.
 */
export function linkedSkillContent(body: string, folderUrl: string, rawFolderUrl: string, license: SkillLicense, from: string): string {
  const base = folderUrl.replace(/\/$/, "");
  const raw = rawFolderUrl.replace(/\/$/, "");
  const linked = body.replace(/\]\((?!https?:|mailto:|#|\/)([^)\s]+)\)/g, (_m, rel: string) => `](${raw}/${rel.replace(/^\.\//, "")})`);
  return `${linked.trim()}\n\n---\nFrom ${from}: ${base} (${license.label}). Files this skill mentions (scripts, references) are there; read them from that address when a step needs one.\n`;
}

/** A skill in the store. Built-in ones come from SKILL_CATALOG; the rest from public repos. */
export interface StoreSkill {
  /** "anthropic:pdf", "openai:linear" */
  id: string;
  name: string;
  description: string;
  source: { id: string; label: string };
  /** the skill's folder on GitHub */
  url: string;
  license: SkillLicense;
}

// --- what's already on a device ------------------------------------------------------------------

/**
 * A skill or MCP server a harness on a device already has. Secret values never leave the device:
 * env values and headers that look secret come as names only, and arguments that look like keys
 * become `{{NAME}}` placeholders the person fills in (or signs in instead).
 */
export const ShelfItem = z.object({
  /** stable within the device: "claude-code:skill:pdf", "codex:mcp:github" */
  key: z.string().max(300),
  harness: z.string().max(60),
  kind: z.enum(["skill", "mcp"]),
  name: z.string().max(120),
  description: z.string().max(300).optional(),
  /** where it was found, for people to recognize it */
  path: z.string().max(1000),
  transport: z.enum(["stdio", "http"]).optional(),
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  url: z.string().max(2000).optional(),
  /** values that aren't secret, copied as they are */
  env: z.record(z.string().max(4000)).optional(),
  /** names whose values stayed on the device (keys, tokens) */
  secrets: z.array(z.string().max(64)).max(50).optional(),
  /** header names; their values stay on the device */
  headers: z.array(z.string().max(64)).max(30).optional(),
});
export type ShelfItem = z.infer<typeof ShelfItem>;

/** Things found on one device, as the hub hands them to the page. */
export interface DeviceShelf {
  nodeId: string;
  nodeName: string;
  online: boolean;
  items: ShelfItem[];
}

const SECRET_NAME = /key|token|secret|passw|pwd|auth|credential|cookie|session|private|\bpat\b/i;

/** A value that looks like a credential: long, no spaces, no path or URL, letters and digits mixed. */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (/^(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|glpat|AKIA|ya29|eyJ)[-_A-Za-z0-9.]{8,}/.test(v)) return true;
  // an address with a password in it (postgres://user:pass@host/db)
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)) return true;
  if (v.length < 24 || /[\s/\\:@.]/.test(v)) return false;
  return /[a-z]/.test(v) && /[A-Z0-9]/.test(v) && /^[A-Za-z0-9_\-=+]+$/.test(v);
}

const envName = (s: string) => s.replace(/^-+/, "").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 64) || "VALUE";

/**
 * Split a server's environment into what can be copied and what must stay on the device, and
 * replace key-like arguments with placeholders. The result is safe to send to the hub.
 */
export function redactServer(s: { command?: string; args?: string[]; url?: string; env?: Record<string, string> }): { args?: string[]; url?: string; env: Record<string, string>; secrets: string[] } {
  const env: Record<string, string> = {};
  const secrets = new Set<string>();
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (SECRET_NAME.test(k) || looksSecret(String(v))) secrets.add(k);
    else env[k] = String(v);
  }
  let pendingName: string | null = null;
  const args = s.args?.map((a) => {
    const flag = /^(--?[A-Za-z][\w-]*)=(.*)$/.exec(a);
    if (flag && (SECRET_NAME.test(flag[1]) || looksSecret(flag[2]))) {
      const k = envName(flag[1]);
      secrets.add(k);
      pendingName = null;
      return `${flag[1]}={{${k}}}`;
    }
    if (pendingName && !a.startsWith("-")) {
      const k = pendingName;
      pendingName = null;
      secrets.add(k);
      return `{{${k}}}`;
    }
    pendingName = /^--?[A-Za-z][\w-]*$/.test(a) && SECRET_NAME.test(a) ? envName(a) : null;
    if (looksSecret(a)) {
      secrets.add("SECRET");
      return "{{SECRET}}";
    }
    return a;
  });
  let url = s.url;
  if (url) {
    try {
      const u = new URL(url);
      for (const [k, v] of [...u.searchParams]) {
        if (SECRET_NAME.test(k) || looksSecret(v)) {
          const name = envName(k);
          secrets.add(name);
          u.searchParams.set(k, `{{${name}}}`);
        }
      }
      url = u.toString().replace(/%7B%7B/g, "{{").replace(/%7D%7D/g, "}}");
    } catch {
      url = undefined;
    }
  }
  return { ...(args ? { args } : {}), ...(url !== undefined ? { url } : {}), env, secrets: [...secrets] };
}

/** "N skills and N apps": the banner's count, in words. */
export function shelfSummary(items: Pick<ShelfItem, "kind">[]): string {
  const skills = items.filter((i) => i.kind === "skill").length;
  const apps = items.length - skills;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (skills && apps) return `${n(skills, "skill", "skills")} and ${n(apps, "app", "apps")}`;
  return skills ? n(skills, "skill", "skills") : n(apps, "app", "apps");
}

// --- apps in the store -------------------------------------------------------------------------

/** A registry server as the store shows it: with logos to try and a shelf. */
export type StoreApp = MarketplaceEntry & { category: AppCategory | null; logos: string[] };

/** The big cards at the top, when the registry has them. */
export const POPULAR_APPS = ["io.github.github/github-mcp-server", "com.notion/mcp", "app.linear/linear"];

export const storeApp = (e: MarketplaceEntry, category?: AppCategory | null): StoreApp => ({ ...e, category: category ?? appCategory(e), logos: entryLogos(e) });
