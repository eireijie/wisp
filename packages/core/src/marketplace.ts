import type { CatalogField, ConnectorKind } from "./connectors.ts";

/**
 * The connector marketplace: MCP servers from the official MCP Registry
 * (registry.modelcontextprotocol.io), turned into connectors Warren can add. The registry is open
 * and large (tens of thousands of servers), so the hub searches it live, drops what can't work
 * here (paid-per-call settlement, unknown package types), and ranks official ones first.
 */

/** One way to add a marketplace server: a remote URL, or a package the device runs. */
export interface MarketplaceInstall {
  kind: Extract<ConnectorKind, "mcp-stdio" | "mcp-http">;
  /** "Remote", "npm", "PyPI", "Docker" */
  label: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  /** values it asks for; `{{KEY}}` in args, url and headers is filled with them */
  fields: CatalogField[];
  /** what the device needs besides the values */
  needs?: string;
}

export interface MarketplaceEntry {
  /** the registry name, e.g. "com.notion/mcp" */
  id: string;
  name: string;
  description: string;
  /** who published it: a domain for official servers, a GitHub owner, or a host like Smithery */
  publisher: string;
  /** the publisher's domain owns the server's address (com.notion → mcp.notion.com) */
  verified: boolean;
  version: string;
  website: string | null;
  repository: string | null;
  icon: string | null;
  /** remote first: nothing to install, and it may let people sign in instead of pasting keys */
  installs: MarketplaceInstall[];
}

type RegistryInput = { name: string; description?: string; isRequired?: boolean; isSecret?: boolean; default?: string; value?: string; format?: string; choices?: string[]; type?: string; valueHint?: string };
export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string } | null;
  icons?: { src: string; mimeType?: string; theme?: string }[] | null;
  remotes?: { type: string; url: string; headers?: RegistryInput[]; variables?: Record<string, RegistryInput> }[] | null;
  packages?: {
    registryType: string;
    identifier: string;
    version?: string;
    transport?: { type: string };
    runtimeArguments?: RegistryInput[];
    packageArguments?: RegistryInput[];
    environmentVariables?: RegistryInput[];
  }[] | null;
}

/** "com.notion" → "notion.com"; "io.github.someone" → null (a GitHub user, not a domain they own). */
function namespaceDomain(name: string): string | null {
  const ns = name.split("/")[0];
  if (/^io\.github\./i.test(ns)) return null;
  const parts = ns.split(".").filter(Boolean);
  return parts.length >= 2 ? parts.reverse().join(".").toLowerCase() : null;
}

/** Who a server is from, in a few words. */
function publisherOf(name: string): string {
  const ns = name.split("/")[0];
  const gh = /^io\.github\.(.+)$/i.exec(ns);
  if (gh) return gh[1];
  return namespaceDomain(name) ?? ns;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** GitHub organizations of the companies themselves (io.github.<org>/… names are proven by GitHub, not a domain). */
const OFFICIAL_GITHUB = ["github", "microsoft", "modelcontextprotocol", "awslabs", "googleapis", "cloudflare", "stripe", "supabase-community", "getsentry", "makenotion", "hashicorp", "mongodb-js", "elastic", "grafana", "redis", "neondatabase", "upstash", "brave", "exa-labs", "firecrawl", "browserbase", "apify", "figma", "atlassian", "linear"];

/** Where anyone can host a site: owning "x.vercel.app" says nothing about who you are. */
const HOSTING = ["vercel.app", "netlify.app", "supabase.co", "workers.dev", "pages.dev", "github.io", "onrender.com", "fly.dev", "herokuapp.com", "railway.app", "deno.dev", "web.app", "firebaseapp.com", "azurewebsites.net", "replit.app", "glitch.me", "ngrok.app", "ngrok.io"];
/** Hosts that publish other people's servers: their names aren't the publisher's own domain. */
const AGGREGATORS = ["smithery.ai", "mcparmory.com", "pulsemcp.com", "mintmcp.com", "waystation.ai", "pipeworx.io", "a2awire.com", "composio.dev", "glama.ai"];

/** A placeholder in the registry's style (`{api_key}`) becomes Warren's (`{{API_KEY}}`). */
const KEY = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
const templ = (s: string) => s.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_m, k: string) => `{{${KEY(k)}}}`);
const placeholders = (s: string) => [...s.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g)].map((m) => m[1]);

const field = (key: string, i: Partial<RegistryInput>): CatalogField => ({
  key: KEY(key),
  label: key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  ...(i.isSecret !== false && (i.isSecret || /key|token|secret|password|auth/i.test(key)) ? { secret: true } : {}),
  ...(i.isRequired ? {} : { optional: true }),
  ...(i.description ? { hint: i.description.slice(0, 300) } : {}),
  ...(i.default ? { placeholder: i.default } : i.valueHint ? { placeholder: i.valueHint } : {}),
});

/** Paid per-call servers want a crypto payment signature on every request; agents can't do that. */
const paywalled = (headers: RegistryInput[] = []) => headers.some((h) => /payment|x402/i.test(h.name) || /x402|EIP-3009|USDC/i.test(h.description ?? ""));

function remoteInstall(r: NonNullable<RegistryServer["remotes"]>[number]): MarketplaceInstall | null {
  if (r.type !== "streamable-http" && r.type !== "sse") return null;
  if (!/^https:\/\//i.test(r.url) || paywalled(r.headers)) return null;
  const fields = new Map<string, CatalogField>();
  for (const k of placeholders(r.url)) fields.set(KEY(k), field(k, { ...(r.variables?.[k] ?? {}), isRequired: true, isSecret: false }));
  const headers: Record<string, string> = {};
  for (const h of r.headers ?? []) {
    if (h.value) {
      headers[h.name] = templ(h.value);
      for (const k of placeholders(h.value)) fields.set(KEY(k), field(k, { ...h, ...(r.variables?.[k] ?? {}) }));
    } else {
      const k = KEY(h.name);
      headers[h.name] = `{{${k}}}`;
      fields.set(k, field(h.name, h));
    }
  }
  return { kind: "mcp-http", label: r.type === "sse" ? "Remote (SSE)" : "Remote", url: templ(r.url), headers, fields: [...fields.values()] };
}

function argList(list: RegistryInput[] = [], fields: Map<string, CatalogField>): string[] | null {
  const out: string[] = [];
  for (const a of list) {
    const v = a.value ?? a.default;
    if (a.type === "named") {
      if (v !== undefined) out.push(a.name, templ(v));
      else if (a.isRequired) {
        const k = KEY(a.name.replace(/^-+/, ""));
        fields.set(k, field(a.name.replace(/^-+/, ""), a));
        out.push(a.name, `{{${k}}}`);
      }
    } else if (v !== undefined) out.push(templ(v));
    else if (a.isRequired) {
      const name = a.valueHint ?? a.name ?? "value";
      const k = KEY(name);
      fields.set(k, field(name, a));
      out.push(`{{${k}}}`);
    }
    for (const k of placeholders(v ?? "")) if (!fields.has(KEY(k))) fields.set(KEY(k), field(k, { isRequired: true }));
  }
  return out;
}

function packageInstall(p: NonNullable<RegistryServer["packages"]>[number]): MarketplaceInstall | null {
  if (p.transport && p.transport.type !== "stdio") return null;
  const fields = new Map<string, CatalogField>();
  const env = p.environmentVariables ?? [];
  for (const e of env) fields.set(KEY(e.name), field(e.name, e));
  const pkgArgs = argList(p.packageArguments, fields) ?? [];
  const ref = p.version && !p.version.includes("*") ? `${p.identifier}@${p.version}` : p.identifier;
  if (p.registryType === "npm") return { kind: "mcp-stdio", label: "npm", command: "npx", args: ["-y", ref, ...pkgArgs], fields: [...fields.values()], needs: "Node on the device" };
  if (p.registryType === "pypi") return { kind: "mcp-stdio", label: "PyPI", command: "uvx", args: [p.version ? `${p.identifier}==${p.version}` : p.identifier, ...pkgArgs], fields: [...fields.values()], needs: "uv on the device (uvx)" };
  if (p.registryType === "oci") {
    // the container gets the values through -e NAME (docker passes them on from its own environment)
    const image = p.identifier.includes(":") || !p.version ? p.identifier : `${p.identifier}:${p.version}`;
    return { kind: "mcp-stdio", label: "Docker", command: "docker", args: ["run", "-i", "--rm", ...env.flatMap((e) => ["-e", e.name]), image, ...pkgArgs], fields: [...fields.values()], needs: "Docker on the device" };
  }
  return null;
}

/** A registry server as Warren shows it, or null when there's no way to add it here. */
export function marketplaceEntry(s: RegistryServer, status = "active"): MarketplaceEntry | null {
  if (status !== "active") return null;
  const installs = [...(s.remotes ?? []).map(remoteInstall), ...(s.packages ?? []).map(packageInstall)].filter((x): x is MarketplaceInstall => !!x);
  // one remote is enough: streamable HTTP over SSE
  const remote = installs.find((i) => i.kind === "mcp-http" && i.label === "Remote") ?? installs.find((i) => i.kind === "mcp-http");
  const list = [...(remote ? [remote] : []), ...installs.filter((i) => i.kind === "mcp-stdio")];
  if (!list.length) return null;
  const domain = namespaceDomain(s.name);
  const urls = (s.remotes ?? []).map((r) => hostOf(r.url));
  const ghOrg = /^io\.github\.([^/]+)\//i.exec(s.name)?.[1]?.toLowerCase();
  const verified = (!!ghOrg && OFFICIAL_GITHUB.includes(ghOrg)) || (!!domain && ![...AGGREGATORS, ...HOSTING].some((a) => domain === a || domain.endsWith(`.${a}`)) && (urls.some((h) => h === domain || h.endsWith(`.${domain}`)) || (!!s.websiteUrl && hostOf(s.websiteUrl).endsWith(domain))));
  const short = s.name.split("/").pop() ?? s.name;
  // "com.cloudflare.mcp/mcp" is Cloudflare: the brand is the label before the top-level domain
  const brand = domain ? (domain.split(".").at(-2) ?? domain) : publisherOf(s.name);
  const generic = /^(mcp|mcp-server|server|remote|remote-mcp)$/i.test(short);
  const name = s.title?.trim() || (generic ? brand : short).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const nice = name.replace(/\bMcp\b/g, "MCP");
  const icon = s.icons?.find((i) => /^https:\/\//.test(i.src))?.src ?? null;
  return {
    id: s.name,
    name: nice,
    description: (s.description ?? "").trim(),
    publisher: publisherOf(s.name),
    verified,
    version: s.version ?? "",
    website: s.websiteUrl ?? null,
    repository: s.repository?.url || null,
    icon,
    installs: list,
  };
}

/** Best first: official ones, then the closest name match, then ones with nothing to fill in. */
export function rankMarketplace(entries: MarketplaceEntry[], q: string): MarketplaceEntry[] {
  const needle = q.trim().toLowerCase();
  const score = (e: MarketplaceEntry) => {
    const n = e.name.toLowerCase();
    const short = (e.id.split("/").pop() ?? "").toLowerCase();
    let s = 0;
    if (e.verified) s += 100;
    if (needle && (n === needle || short === needle || e.publisher.toLowerCase().split(".")[0] === needle)) s += 50;
    else if (needle && n.startsWith(needle)) s += 20;
    if (e.installs[0]?.kind === "mcp-http") s += 10;
    if (!e.installs[0]?.fields.some((f) => !f.optional)) s += 5;
    if (/^ai\.smithery\//.test(e.id)) s -= 5;
    return s;
  };
  return entries.map((e) => [score(e), e] as const).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map(([, e]) => e);
}
