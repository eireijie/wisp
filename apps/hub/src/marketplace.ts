import { marketplaceEntry, rankMarketplace, storeApp, type AppCategory, type MarketplaceEntry, type RegistryServer, type StoreApp } from "@wisp/core";
import type { Hub } from "./hub.ts";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const SEARCH_TTL = 10 * 60_000;
const FEATURED_TTL = 6 * 60 * 60_000;

/**
 * Official servers from companies people use every day, shown before anyone searches, with the
 * shelf each goes on. Fetched from the registry by name, so they're always its latest version; a
 * name it no longer has is skipped. Zapier and MintMCP stand in for apps with no official server
 * yet (Gmail, Outlook…).
 */
export const FEATURED: [string, AppCategory][] = [
  ["io.github.github/github-mcp-server", "Developer"],
  ["com.notion/mcp", "Docs and notes"],
  ["app.linear/linear", "Developer"],
  ["com.mintmcp/gmail", "Email and calendar"],
  ["com.zapier/mcp", "Automation"],
  ["com.mintmcp/outlook-email", "Email and calendar"],
  ["com.mintmcp/outlook-calendar", "Email and calendar"],
  ["net.todoist/mcp", "Docs and notes"],
  ["io.github.zoom/zoom-meetings", "Email and calendar"],
  ["com.atlassian/atlassian-mcp-server", "Developer"],
  ["com.airtable/mcp", "Data"],
  ["com.monday/monday.com", "Docs and notes"],
  ["com.figma.mcp/mcp", "Design"],
  ["com.canva.mcp/mcp", "Design"],
  ["com.webflow/mcp", "Design"],
  ["com.wix/mcp", "Design"],
  ["io.sanity.www/mcp", "Design"],
  ["ai.fireflies/fireflies", "Email and calendar"],
  ["com.gitlab/mcp", "Developer"],
  ["io.github.getsentry/sentry-mcp", "Developer"],
  ["io.github.PagerDuty/pagerduty-mcp", "Developer"],
  ["io.github.grafana/mcp-grafana", "Developer"],
  ["io.github.microsoft/playwright-mcp", "Developer"],
  ["io.github.upstash/context7", "Developer"],
  ["com.microsoft/microsoft-learn-mcp", "Developer"],
  ["com.vercel/vercel-mcp", "Developer"],
  ["com.cloudflare.mcp/mcp", "Developer"],
  ["com.postman/postman-mcp-server", "Developer"],
  ["com.stripe/mcp", "Finance"],
  ["com.paypal.mcp/mcp", "Finance"],
  ["com.close/close-mcp", "Sales"],
  ["com.pandadoc.mcp/mcp", "Sales"],
  ["com.supabase/mcp", "Data"],
  ["com.neon/mcp", "Data"],
  ["io.github.mongodb-js/mongodb-mcp-server", "Data"],
  ["io.github.redis/mcp-redis", "Data"],
  ["com.amplitude/mcp-server", "Data"],
  ["ai.exa/exa", "Research"],
  ["ai.perplexity/mcp-server", "Research"],
  ["io.github.brave/brave-search-mcp-server", "Research"],
  ["io.github.firecrawl/firecrawl-mcp-server", "Research"],
  ["io.github.browserbase/mcp-server-browserbase", "Research"],
  ["com.apify/apify-mcp-server", "Research"],
  ["co.huggingface/hf-mcp-server", "Research"],
  ["io.elevenlabs/mcp", "Design"],
];

/** Pages of search results read per search (100 each): enough to find most apps by name. */
const SEARCH_PAGES = 3;

type Item = { server: RegistryServer; _meta?: Record<string, { status?: string }> };
const status = (i: Item) => i._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active";

/** Some entries carry raw control characters in their text; JSON.parse refuses those. */
async function readJson(res: Response) {
  const text = await res.text();
  return JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "));
}

/** The MCP Registry, searched live and cached for a while so the page stays quick. */
export class Marketplace {
  private searches = new Map<string, { at: number; entries: StoreApp[] }>();
  private featured: { at: number; entries: StoreApp[] } | null = null;

  constructor(private hub: Hub) {}

  /** The registry is sometimes slow or busy: one more try after a pause. */
  private async get(url: string, tries = 2): Promise<unknown> {
    try {
      const res = await this.hub.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`the MCP Registry answered ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`the MCP Registry answered ${res.status}`), { final: true });
      return await readJson(res);
    } catch (e) {
      if (tries <= 1 || (e as { final?: boolean }).final) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      return this.get(url, tries - 1);
    }
  }

  async search(q: string): Promise<StoreApp[]> {
    const key = q.trim().toLowerCase();
    if (!key) return this.featuredEntries();
    const hit = this.searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.entries;
    const items: Item[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const data = (await this.get(`${REGISTRY}?version=latest&limit=100&search=${encodeURIComponent(key)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { servers?: Item[]; metadata?: { nextCursor?: string } } | null;
      items.push(...(data?.servers ?? []));
      cursor = data?.metadata?.nextCursor;
      if (!cursor || (data?.servers?.length ?? 0) < 100) break;
    }
    const seen = new Set<string>();
    const found = items.map((i) => marketplaceEntry(i.server, status(i))).filter((e): e is MarketplaceEntry => !!e && !seen.has(e.id) && !!seen.add(e.id));
    const category = new Map(FEATURED);
    const entries = rankMarketplace(found, key).map((e) => storeApp(e, category.get(e.id)));
    if (this.searches.size > 200) this.searches.clear();
    this.searches.set(key, { at: Date.now(), entries });
    return entries;
  }

  async featuredEntries(): Promise<StoreApp[]> {
    if (this.featured && Date.now() - this.featured.at < FEATURED_TTL) return this.featured.entries;
    // a few at a time: fifty at once gets a busy registry to push back
    const found: (StoreApp | null)[] = [];
    for (let i = 0; i < FEATURED.length; i += 5) {
      found.push(...(await Promise.all(FEATURED.slice(i, i + 5).map(([name, category]) => this.entry(name).then((e) => e && storeApp(e, category), () => null)))));
    }
    const entries = found.filter((e): e is StoreApp => !!e);
    // a registry hiccup shouldn't stick for six hours
    if (entries.length) this.featured = { at: Date.now(), entries };
    return entries;
  }

  /** One server by its registry name, latest version. */
  async entry(name: string): Promise<MarketplaceEntry | null> {
    const data = (await this.get(`${REGISTRY}/${encodeURIComponent(name)}/versions/latest`)) as Item | null;
    return data ? marketplaceEntry(data.server, status(data)) : null;
  }
}
