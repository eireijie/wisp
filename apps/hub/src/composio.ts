import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { catalogConnector, type LinkedApps } from "@bubble-ai/core";
import { now } from "./auth.ts";
import type { Hub } from "./hub.ts";

/** How long asking an app hub about its apps may take. */
const CHECK_TIMEOUT_MS = 12_000;

/**
 * Which apps are picked inside an app hub like Composio. Its MCP server always offers the same
 * handful of meta tools (search, execute, manage connections…), so its tool list says nothing;
 * its "manage connections" tool, asked to list, does. Read-only: only "list" is ever sent.
 * Kept on the connector (Connector.linkedApps); `picked` is null whenever the answer isn't clear.
 */
export async function checkLinkedApps(hub: Hub, connectorId: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<LinkedApps | null> {
  const conn = hub.connectors.get(connectorId);
  const page = catalogConnector(conn?.catalogId ?? "")?.appsPage;
  const url = hub.connectors.serverUrl(connectorId);
  if (!conn || !page || !url) return null;
  const done = (picked: boolean | null, names: string[] = []): LinkedApps => {
    const v = { picked, names, pickUrl: page, checkedAt: now() };
    hub.connectors.linked.set(connectorId, v);
    return v;
  };
  if (!conn.auth?.signedIn) return done(null);
  await hub.connectors.auth.fresh(connectorId, url).catch(() => {});
  const token = hub.connectors.auth.accessToken(connectorId);
  if (!token) return done(null);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (u, init) => hub.connectors.auth.fetchFn(u, init),
    requestInit: { headers: { ...hub.connectors.serverHeaders(connectorId), Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "bubble-ai", version: "0.1" });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs).unref?.());
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const manage = tools.find((t) => /MANAGE_CONNECTIONS$/i.test(t.name)) ?? tools.find((t) => /LIST_CONNECT|CONNECTED_ACCOUNTS/i.test(t.name));
        if (!manage) return done(null);
        const out = await client.callTool({ name: manage.name, arguments: listArgs(manage.inputSchema as Schema) });
        if (out.isError) return done(null);
        const parsed = readConnections(out.content as { type: string; text?: string }[]);
        return parsed ? done(parsed.length > 0, parsed) : done(null);
      })(),
      timer,
    ]);
  } catch {
    return done(null);
  } finally {
    void client.close().catch(() => {});
  }
}

type Schema = { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] } | undefined;

/** The arguments that ask a manage-connections tool to list: whichever field takes "list". */
export function listArgs(schema: Schema): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) if (p?.enum?.some((v) => String(v).toLowerCase() === "list")) args[k] = p.enum.find((v) => String(v).toLowerCase() === "list");
  if (!Object.keys(args).length) for (const k of ["action", "operation", "mode"]) if (k in props) args[k] = "list";
  if (!Object.keys(args).length && !Object.keys(props).length) return {};
  if (!Object.keys(args).length) args.action = "list";
  return args;
}

const CONNECTION_LISTS = ["connections", "connected_accounts", "connectedAccounts", "accounts", "items", "results", "toolkits", "active_connections", "data"];
const NAME_KEYS = ["toolkit", "toolkit_slug", "toolkitSlug", "app", "app_name", "appName", "slug", "name"];

/**
 * The apps an answer lists as connected (active ones), [] when it says there are none, or null when
 * it can't be read. Takes JSON (any of the usual shapes) or a plain sentence like "No active connections".
 */
export function readConnections(content: { type: string; text?: string }[] | undefined): string[] | null {
  const texts = (content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text!.trim());
  for (const t of texts) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      if (/\bno (active |connected )?(connections|accounts|apps|toolkits)\b|\bnot connected to any\b|\bnothing (is )?connected\b/i.test(t)) return [];
      continue;
    }
    const list = findList(v, 0);
    if (list) return names(list);
  }
  return null;
}

function findList(v: unknown, depth: number): unknown[] | null {
  if (depth > 4 || !v || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.every((x) => x && typeof x === "object") ? v : null;
  const o = v as Record<string, unknown>;
  for (const k of CONNECTION_LISTS) if (Array.isArray(o[k])) return o[k] as unknown[];
  // keyed by app ({ gmail: { status: "ACTIVE" } })
  for (const k of CONNECTION_LISTS) if (o[k] && typeof o[k] === "object") {
    const inner = findList(o[k], depth + 1);
    if (inner) return inner;
    const entries = Object.entries(o[k] as Record<string, unknown>).filter(([, x]) => x && typeof x === "object");
    if (entries.length) return entries.map(([name, x]) => ({ name, ...(x as object) }));
    if (!Object.keys(o[k] as object).length) return [];
  }
  return null;
}

function names(list: unknown[]): string[] {
  const out = new Set<string>();
  for (const item of list) {
    const o = item as Record<string, unknown>;
    const status = String(o.status ?? o.state ?? "active").toLowerCase();
    if (!/active|connected|enabled|ok|ready/.test(status)) continue;
    let n: unknown;
    for (const k of NAME_KEYS) {
      const x = o[k];
      if (typeof x === "string" && x.trim()) n = x;
      else if (x && typeof x === "object" && typeof (x as { slug?: unknown }).slug === "string") n = (x as { slug: string }).slug;
      else if (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string") n = (x as { name: string }).name;
      if (n) break;
    }
    if (typeof n === "string") out.add(n.trim().slice(0, 60));
  }
  return [...out].slice(0, 100);
}
