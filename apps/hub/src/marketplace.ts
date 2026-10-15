import { marketplaceEntry, rankMarketplace, type MarketplaceEntry, type RegistryServer } from "@warren/core";
import type { Hub } from "./hub.ts";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const SEARCH_TTL = 10 * 60_000;
const FEATURED_TTL = 6 * 60 * 60_000;

/**
 * Official servers from companies people use every day, shown before anyone searches. Fetched
 * from the registry by name, so they're always its latest version; a name it no longer has is
 * skipped. Zapier and MintMCP stand in for apps with no official server yet (Gmail, Google
 * Calendar, Outlook, Todoist…).
 */
export const FEATURED = [
  "com.zapier/mcp",
  "com.notion/mcp",
  "com.mintmcp/gmail",
  "com.mintmcp/outlook-email",
  "com.mintmcp/outlook-calendar",
  "io.github.github/github-mcp-server",
  "app.linear/linear",
  "com.atlassian/atlassian-mcp-server",
  "com.airtable/mcp",
  "com.monday/monday.com",
  "com.figma.mcp/mcp",
  "com.canva.mcp/mcp",
  "ai.fireflies/fireflies",
  "com.gitlab/mcp",
  "com.stripe/mcp",
  "com.paypal.mcp/mcp",
  "com.supabase/mcp",
  "com.neon/mcp",
  "com.vercel/vercel-mcp",
  "com.cloudflare.mcp/mcp",
  "com.webflow/mcp",
  "com.wix/mcp",
  "com.close/close-mcp",
  "com.pandadoc.mcp/mcp",
  "com.postman/postman-mcp-server",
  "com.amplitude/mcp-server",
  "com.apify/apify-mcp-server",
  "ai.exa/exa",
  "co.huggingface/hf-mcp-server",
  "io.elevenlabs/mcp",
];

type Item = { server: RegistryServer; _meta?: Record<string, { status?: string }> };
const status = (i: Item) => i._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active";

/** Some entries carry raw control characters in their text; JSON.parse refuses those. */
async function readJson(res: Response) {
  const text = await res.text();
  return JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "));
}

/** The MCP Registry, searched live and cached for a while so the page stays quick. */
export class Marketplace {
  private searches = new Map<string, { at: number; entries: MarketplaceEntry[] }>();
  private featured: { at: number; entries: MarketplaceEntry[] } | null = null;

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

  async search(q: string): Promise<MarketplaceEntry[]> {
    const key = q.trim().toLowerCase();
    if (!key) return this.featuredEntries();
    const hit = this.searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.entries;
    const data = (await this.get(`${REGISTRY}?version=latest&limit=100&search=${encodeURIComponent(key)}`)) as { servers: Item[] } | null;
    const entries = rankMarketplace(
      (data?.servers ?? []).map((i) => marketplaceEntry(i.server, status(i))).filter((e): e is MarketplaceEntry => !!e),
      key,
    );
    if (this.searches.size > 200) this.searches.clear();
    this.searches.set(key, { at: Date.now(), entries });
    return entries;
  }

  async featuredEntries(): Promise<MarketplaceEntry[]> {
    if (this.featured && Date.now() - this.featured.at < FEATURED_TTL) return this.featured.entries;
    // a few at a time: thirty at once gets a busy registry to push back
    const found: (MarketplaceEntry | null)[] = [];
    for (let i = 0; i < FEATURED.length; i += 5) found.push(...(await Promise.all(FEATURED.slice(i, i + 5).map((name) => this.entry(name).catch(() => null)))));
    const entries = found.filter((e): e is MarketplaceEntry => !!e);
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
