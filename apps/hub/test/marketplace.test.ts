import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { marketplaceEntry, rankMarketplace, type RegistryServer } from "@warren/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let agentId: string;
let fake: http.Server;
let mcpUrl: string;
const tokensSeen: string[] = [];

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T; res: Response }> {
  const res = await fetch(base + url, { method, redirect: "manual", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${owner}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, res };
}

/** A remote MCP server that wants people to sign in, with its own OAuth server, the way Notion's or Linear's do. */
function fakeServer(): Promise<string> {
  return new Promise((resolve) => {
    fake = http.createServer(async (req, res) => {
      const url = new URL(req.url!, "http://x");
      const me = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
      const body = await new Promise<string>((r) => {
        let b = "";
        req.on("data", (c) => (b += c)).on("end", () => r(b));
      });
      const json = (code: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === "/mcp") {
        const auth = req.headers.authorization ?? "";
        if (auth === "Bearer at1" || auth === "Bearer at2") return json(200, { jsonrpc: "2.0", id: 1, result: {} });
        return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${me}/.well-known/oauth-protected-resource/mcp"` });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${me}/mcp`, authorization_servers: [me] });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: me,
          authorization_endpoint: `${me}/authorize`,
          token_endpoint: `${me}/token`,
          registration_endpoint: `${me}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register") return json(201, { ...JSON.parse(body), client_id: "warren-client" });
      if (url.pathname === "/token") {
        const p = new URLSearchParams(body);
        tokensSeen.push(p.get("grant_type")!);
        if (p.get("grant_type") === "authorization_code" && p.get("code") === "good" && p.get("code_verifier")) return json(200, { access_token: "at1", refresh_token: "rt1", expires_in: 60, token_type: "Bearer" });
        if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "rt1") return json(200, { access_token: "at2", expires_in: 3600, token_type: "Bearer" });
        return json(400, { error: "invalid_grant" });
      }
      json(404, {});
    });
    fake.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fake.address() as { port: number }).port}`));
  });
}

beforeAll(async () => {
  mcpUrl = `${await fakeServer()}/mcp`;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-market-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await (await fetch(base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123" }) })).json()).token;
  const { node } = (await api("POST", "/api/nodes", { name: "box" })).data;
  agentId = (await api("POST", "/api/agents", { handle: "dot", name: "Dot", harness: "claude-code", nodeId: node.id })).data.id;
});

afterAll(async () => {
  await close();
  fake.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("signing in to a remote connector", () => {
  it("notices the server wants a sign-in, signs in, sends the token to agents, and refreshes it", async () => {
    const conn = (await api("POST", "/api/connectors", { kind: "mcp-http", name: "Notes", url: mcpUrl, agentIds: [agentId] })).data;
    expect(conn.auth).toEqual({ required: true, signedIn: false, error: null });

    const start = await api("POST", `/api/connectors/${conn.id}/signin`, { origin: base });
    const to = new URL(start.data.url);
    expect(to.pathname).toBe("/authorize");
    expect(to.searchParams.get("client_id")).toBe("warren-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${base}/api/connectors/oauth/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");

    // the sign-in page sends the browser back
    const back = await fetch(`${base}/api/connectors/oauth/callback?state=${to.searchParams.get("state")}&code=good`, { redirect: "manual" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/?signin=ok#/connectors");
    expect((await api("GET", `/api/connectors/${conn.id}`)).data.auth).toEqual({ required: true, signedIn: true, error: null });
    expect(hub.connectors.specsFor(agentId)[0].headers).toEqual({ Authorization: "Bearer at1" });
    // the token never shows to people
    expect(JSON.stringify((await api("GET", "/api/connectors")).data)).not.toContain("at1");

    // it expires within 5 minutes: refreshed before the next run
    await hub.connectors.prepare(agentId);
    expect(hub.connectors.specsFor(agentId)[0].headers).toEqual({ Authorization: "Bearer at2" });
    expect(tokensSeen).toEqual(["authorization_code", "refresh_token"]);

    // a stale or forged state goes nowhere
    const bad = await fetch(`${base}/api/connectors/oauth/callback?state=nope&code=good`, { redirect: "manual" });
    expect(decodeURIComponent(bad.headers.get("location")!)).toContain("expired");

    await api("POST", `/api/connectors/${conn.id}/signout`);
    expect(hub.connectors.specsFor(agentId)[0].headers).toEqual({});
  });
});

describe("the marketplace", () => {
  const notion: RegistryServer = { name: "com.notion/mcp", description: "Official Notion MCP server", version: "1.0.1", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }, { type: "sse", url: "https://mcp.notion.com/sse" }] };

  it("turns registry servers into connectors Warren can add", () => {
    const e = marketplaceEntry(notion)!;
    expect(e).toMatchObject({ id: "com.notion/mcp", name: "Notion", publisher: "notion.com", verified: true });
    expect(e.installs).toEqual([{ kind: "mcp-http", label: "Remote", url: "https://mcp.notion.com/mcp", headers: {}, fields: [] }]);

    const npm = marketplaceEntry({
      name: "io.github.someone/better-notion",
      version: "0.3.2",
      packages: [{ registryType: "npm", identifier: "better-mcp-notion", version: "0.3.2", transport: { type: "stdio" }, environmentVariables: [{ name: "NOTION_API_KEY", isRequired: true, isSecret: true, description: "starts with ntn_" }] }],
    })!;
    expect(npm.verified).toBe(false);
    expect(npm.publisher).toBe("someone");
    expect(npm.installs[0]).toMatchObject({ kind: "mcp-stdio", command: "npx", args: ["-y", "better-mcp-notion@0.3.2"], fields: [{ key: "NOTION_API_KEY", secret: true, hint: "starts with ntn_" }] });

    const header = marketplaceEntry({ name: "ai.smithery/x", remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/x/mcp", headers: [{ name: "Authorization", value: "Bearer {smithery_api_key}", isSecret: true, isRequired: true }] }] })!;
    expect(header.installs[0]).toMatchObject({ headers: { Authorization: "Bearer {{SMITHERY_API_KEY}}" }, fields: [{ key: "SMITHERY_API_KEY", secret: true }] });
    expect(header.verified).toBe(false);

    const docker = marketplaceEntry({ name: "com.example/tool", packages: [{ registryType: "oci", identifier: "ghcr.io/example/tool:1.0", transport: { type: "stdio" }, environmentVariables: [{ name: "TOKEN", isSecret: true }] }] })!;
    expect(docker.installs[0]).toMatchObject({ command: "docker", args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/example/tool:1.0"] });
  });

  it("leaves out what can't work here", () => {
    expect(marketplaceEntry({ name: "io.github.x/paid", remotes: [{ type: "sse", url: "https://api.example.com/sse", headers: [{ name: "Payment-Signature", description: "EIP-3009 signature", isSecret: true }] }] })).toBeNull();
    expect(marketplaceEntry({ name: "io.github.x/rust", packages: [{ registryType: "cargo", identifier: "x" }] })).toBeNull();
    expect(marketplaceEntry(notion, "deprecated")).toBeNull();
    // a site anyone can host doesn't make you official
    expect(marketplaceEntry({ name: "io.github.github/github-mcp-server", remotes: [{ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" }] })!.verified).toBe(true);
    expect(marketplaceEntry({ name: "io.github.randomperson/github-mcp", remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }] })!.verified).toBe(false);
    expect(marketplaceEntry({ name: "app.vercel.someone/thing", remotes: [{ type: "streamable-http", url: "https://someone.vercel.app/mcp" }] })!.verified).toBe(false);
  });

  it("puts official ones first", () => {
    const list = [marketplaceEntry({ name: "ai.smithery/smithery-notion", remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/n/mcp" }] })!, marketplaceEntry(notion)!];
    expect(rankMarketplace(list, "notion").map((e) => e.id)).toEqual(["com.notion/mcp", "ai.smithery/smithery-notion"]);
  });

  it("searches the registry through the hub", async () => {
    const seen: string[] = [];
    hub.fetchImpl = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ servers: [{ server: notion, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } }], metadata: {} }), { status: 200 });
    };
    const r = await api("GET", "/api/marketplace?q=notion");
    expect(r.data.entries.map((e: { id: string }) => e.id)).toEqual(["com.notion/mcp"]);
    expect(seen[0]).toBe("https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=100&search=notion");
    // cached
    await api("GET", "/api/marketplace?q=Notion");
    expect(seen.length).toBe(1);
  });
});
