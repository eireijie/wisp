import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { lanHttp } from "../src/api-connectors.ts";
import { listArgs, readConnections } from "../src/composio.ts";

/**
 * Composio (round 16, item 4): connecting it gives it to the agents asked for (every agent from
 * the iPhone and web), and the hub says whether any apps are picked inside it yet, by asking its
 * manage-connections tool to list. Its MCP server and sign-in are faked here.
 */

const COMPOSIO = "https://connect.composio.dev";
let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let agentA: string;
let agentB: string;
/** what Composio's manage-connections tool answers with */
let linked: unknown = { connections: [] };
const seen: { method: string; args?: unknown }[] = [];

const json = (status: number, v: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** Composio's server as the hub reaches it: OAuth discovery and sign-in, then MCP over Streamable HTTP. */
const composio = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== COMPOSIO) throw new Error(`the hub called ${url}`);
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
  if (url.pathname === "/mcp") {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer cat1") return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${COMPOSIO}/.well-known/oauth-protected-resource/mcp"` });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
    seen.push({ method: rpc.method, args: rpc.params?.arguments });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "composio", version: "1" } } });
    if (rpc.method === "tools/list")
      return json(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            { name: "COMPOSIO_SEARCH_TOOLS", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
            { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object", properties: {} } },
            { name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create", "list", "rename", "remove"] }, toolkits: { type: "array" } } } },
          ],
        },
      });
    if (rpc.method === "tools/call") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: typeof linked === "string" ? linked : JSON.stringify(linked) }] } });
    return json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no" } });
  }
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${COMPOSIO}/mcp`, authorization_servers: [COMPOSIO] });
  if (url.pathname === "/.well-known/oauth-authorization-server")
    return json(200, {
      issuer: COMPOSIO,
      authorization_endpoint: `${COMPOSIO}/authorize`,
      token_endpoint: `${COMPOSIO}/token`,
      registration_endpoint: `${COMPOSIO}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  if (url.pathname === "/register") return json(201, { ...JSON.parse(body), client_id: "bubble-client" });
  if (url.pathname === "/token") {
    const p = new URLSearchParams(body);
    if (p.get("grant_type") === "authorization_code" && p.get("code") === "good") return json(200, { access_token: "cat1", refresh_token: "crt1", expires_in: 3600, token_type: "Bearer" });
    return json(400, { error: "invalid_grant" });
  }
  return json(404, {});
};

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T; cookie: string }> {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble-composio-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  hub.connectors.auth.fetchFn = composio as typeof fetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await (await fetch(base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json()).token;
  const { node } = (await api("POST", "/api/nodes", { name: "box" })).data;
  agentA = (await api("POST", "/api/agents", { handle: "juno", name: "Juno", harness: "claude-code", nodeId: node.id })).data.id;
  agentB = (await api("POST", "/api/agents", { handle: "rae", name: "Rae", harness: "codex", nodeId: node.id })).data.id;
}, 300_000);

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("connecting Composio", () => {
  let connId: string;

  it("gives it to every agent when asked (as the iPhone and web do), and signs in on Composio's page", async () => {
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["composio"], origin: base, returnTo: "close", agentIds: [], allAgents: true });
    expect(r.status).toBe(200);
    const conn = r.data.connectors[0];
    connId = conn.id;
    expect(conn).toMatchObject({ catalogId: "composio", kind: "mcp-http", url: `${COMPOSIO}/mcp`, allAgents: true });
    const to = new URL(r.data.url);
    expect(to.origin + to.pathname).toBe(`${COMPOSIO}/authorize`);
    // before signing in it isn't sent to anyone's runs yet, but both agents have it
    expect(hub.connectors.forAgent(agentA).map((c) => c.id)).toContain(connId);
    expect(hub.connectors.forAgent(agentB).map((c) => c.id)).toContain(connId);
    // linkedApps is there for an app hub, unknown until it's asked
    expect((await api("GET", `/api/connectors/${connId}`)).data.linkedApps).toBeNull();

    linked = { connections: [] };
    const back = await fetch(`${base}/api/connectors/oauth/callback?state=${to.searchParams.get("state")}&code=good`, { redirect: "manual", headers: { cookie: r.cookie } });
    expect(back.status).toBe(200);
    // each agent's runs get the server with the sign-in token
    for (const a of [agentA, agentB]) expect(hub.connectors.specsFor(a).find((s) => s.name === "composio")).toMatchObject({ kind: "mcp-http", url: `${COMPOSIO}/mcp`, headers: { Authorization: "Bearer cat1" } });
    expect(hub.connectors.promptSection(agentA)).toContain("- Composio (composio): Hundreds of apps through one connection: Gmail, Slack, Notion, HubSpot, Salesforce and more.");
  });

  it("says no apps are picked yet, and which once some are", async () => {
    linked = { connections: [] };
    const none = (await api("GET", `/api/connectors/${connId}/linked-apps`)).data.linkedApps;
    expect(none).toMatchObject({ picked: false, names: [], pickUrl: "https://connect.composio.dev" });
    // only ever asked to list
    expect(seen.filter((s) => s.method === "tools/call").every((s) => (s.args as { action?: string }).action === "list")).toBe(true);
    // on the connector as people see it, and in the agent's prompt
    expect((await api("GET", `/api/connectors/${connId}`)).data.linkedApps.picked).toBe(false);
    expect(hub.connectors.promptSection(agentA)).toContain("No apps are picked inside Composio yet");

    linked = { connections: [{ toolkit: { slug: "gmail" }, status: "ACTIVE" }, { toolkit: { slug: "slack" }, status: "INITIATED" }, { toolkit: "notion", status: "ACTIVE" }] };
    const some = (await api("GET", `/api/connectors/${connId}/linked-apps`)).data.linkedApps;
    expect(some).toMatchObject({ picked: true, names: ["gmail", "notion"] });
    expect(hub.connectors.promptSection(agentA)).toContain("Apps picked there: gmail, notion.");

    // an answer it can't read: it doesn't guess
    linked = "Here you go!";
    expect((await api("GET", `/api/connectors/${connId}/linked-apps`)).data.linkedApps.picked).toBeNull();
  });

  it("isn't asked of apps without apps inside them", async () => {
    const other = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Tickets", url: "https://connect.composio.dev/other", agentIds: [] })).data;
    expect(other.linkedApps).toBeUndefined();
    expect((await api("GET", `/api/connectors/${other.id}/linked-apps`)).status).toBe(400);
  });

  it("explains a plain http address on the home network", async () => {
    const opt = (await api("GET", `/api/connectors/sign-in?origin=${encodeURIComponent("http://192.168.1.20:8787")}`)).data;
    expect(opt.composio.signIn).toBe(false);
    expect(opt.composio.reason).toBe(
      "Composio's sign-in page only sends people back to an https address, and Bubble AI is open at 192.168.1.20:8787, a plain http address on your home network. Open Bubble AI on the server itself (localhost), or turn on Tailscale under Settings → Computers for an https address, then connect Composio again.",
    );
    const r = await api("POST", "/api/connectors/connect", { catalogIds: ["composio"], origin: "http://192.168.1.20:8787", allAgents: true });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/plain http address on your home network/);
  });
});

describe("reading Composio's answers", () => {
  it("finds the list field", () => {
    expect(listArgs({ properties: { action: { enum: ["create", "list"] } } })).toEqual({ action: "list" });
    expect(listArgs({ properties: { operation: { type: "string" } } })).toEqual({ operation: "list" });
    expect(listArgs(undefined)).toEqual({});
  });

  it("reads the usual shapes, and says when it can't", () => {
    expect(readConnections([{ type: "text", text: JSON.stringify({ data: { connected_accounts: [{ app_name: "github", status: "active" }] } }) }])).toEqual(["github"]);
    expect(readConnections([{ type: "text", text: JSON.stringify({ toolkits: { gmail: { status: "ACTIVE" } } }) }])).toEqual(["gmail"]);
    expect(readConnections([{ type: "text", text: "No active connections found." }])).toEqual([]);
    expect(readConnections([{ type: "text", text: JSON.stringify({ ok: true }) }])).toBeNull();
    expect(readConnections([])).toBeNull();
  });

  it("knows a home-network address", () => {
    expect(lanHttp("http://192.168.1.5:8787")).toBe("192.168.1.5:8787");
    expect(lanHttp("http://sams-mac.local:8787")).toBe("sams-mac.local:8787");
    expect(lanHttp("http://localhost:8787")).toBeNull();
    expect(lanHttp("https://192.168.1.5")).toBeNull();
  });
});
