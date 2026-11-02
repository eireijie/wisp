import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { WispClient } from "@wisp/sdk";
import { buildHub } from "../src/app.ts";
import { validRedirectUri } from "../src/remote-mcp.ts";

let dir: string;
let url: string;
let close: () => Promise<void>;
let owner: WispClient;
let ownerToken: string;
let agentId: string;
let built: Awaited<ReturnType<typeof buildHub>>;

const REDIRECT = "http://127.0.0.1:6274/oauth/callback";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-remote-mcp-"));
  built = await buildHub({ dataDir: dir, setupCode: false });
  const { app } = built;
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  ownerToken = setup.token;
  owner = new WispClient({ url, token: ownerToken });
  await owner.request("POST", "/api/channels", { name: "general" });
  agentId = (await owner.request("POST", "/api/agents", { handle: "grok", name: "Grok", harness: "grok" })).id;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** An in-memory OAuth client, like MCP Inspector's. */
class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: "Inspector", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** What a person does in the browser: open the authorize URL, land on the consent page, approve as an agent. */
async function consent(authUrl: URL, as = agentId) {
  const res = await fetch(authUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  const page = res.headers.get("location")!;
  const requestId = page.match(/#\/authorize\/([\w-]+)$/)![1];
  const shown = await owner.request("GET", `/api/oauth/requests/${requestId}`);
  expect(shown).toEqual({ client: "Inspector", returnsTo: "127.0.0.1:6274" });
  const { redirect } = await owner.request<{ redirect: string }>("POST", `/api/oauth/requests/${requestId}/approve`, { agentId: as });
  const back = new URL(redirect);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return back;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

describe("remote MCP", () => {
  it("turns away requests without a token, pointing at the resource metadata", async () => {
    const res = await fetch(url + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await fetch(url + "/mcp", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // a person's own session token isn't an agent
    const person = await fetch(url + "/mcp", { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: "{}" });
    expect(person.status).toBe(401);
  });

  it("publishes protected-resource and authorization-server metadata", async () => {
    const pr = await (await fetch(url + "/.well-known/oauth-protected-resource/mcp")).json();
    expect(pr).toMatchObject({ resource: `${url}/mcp`, authorization_servers: [url] });
    const as = await (await fetch(url + "/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({ issuer: url, authorization_endpoint: `${url}/oauth/authorize`, token_endpoint: `${url}/oauth/token`, registration_endpoint: `${url}/oauth/register`, code_challenge_methods_supported: ["S256"] });
    const tunneled = await (await fetch(url + "/.well-known/oauth-protected-resource", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "hub.example.com" } })).json();
    expect(tunneled.resource).toBe("https://hub.example.com/mcp");
  });

  it("connects through OAuth and calls chat and task tools as the chosen agent", async () => {
    const provider = new Provider();
    const first = new StreamableHTTPClientTransport(new URL(url + "/mcp"), { authProvider: provider });
    await expect(new Client({ name: "inspector", version: "0" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toMatch(/^mcpc_/);
    expect(provider.authUrl?.searchParams.get("code_challenge_method")).toBe("S256");

    const back = await consent(provider.authUrl!);
    await first.finishAuth(back.searchParams.get("code")!);
    expect(provider.saved?.access_token).toMatch(/^wr_agent_/);
    expect(provider.saved?.refresh_token).toBeTruthy();

    const mcp = new Client({ name: "inspector", version: "0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { authProvider: provider }));
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toContain("chat_send");
    expect(names).toContain("task_delegate");
    // the hub's own files aren't the caller's
    expect(names).not.toContain("file_upload");
    expect(names).not.toContain("file_download");

    const sent = await mcp.callTool({ name: "chat_send", arguments: { channel: "general", message: "hello from the car" } });
    expect(text(sent)).toMatch(/^Posted /);
    const general = (await owner.channelByName("general"))!;
    const { messages } = await owner.messages(general.id);
    const m = messages.find((x) => x.body === "hello from the car")!;
    expect(m.author).toEqual({ kind: "agent", id: agentId });

    const tasks = await mcp.callTool({ name: "task_list", arguments: {} });
    expect((tasks as { isError?: boolean }).isError).toBeFalsy();

    // it shows on the agent's page, and revoking it there ends access
    const apps = await owner.request<{ id: string; name: string; approvedBy: string }[]>("GET", `/api/agents/${agentId}/apps`);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "Inspector", approvedBy: "Me" });
    // Settings → Devices lists every connected app in the workspace, with the agent it acts as
    const all = await owner.request<{ id: string; name: string; agentId: string; agentName: string | null }[]>("GET", "/api/mcp/clients");
    expect(all).toEqual([expect.objectContaining({ id: apps[0].id, name: "Inspector", agentId })]);
    expect(all[0].agentName).toBeTruthy();
    await owner.request("DELETE", `/api/mcp/clients/${apps[0].id}`);
    expect(await owner.request("GET", `/api/agents/${agentId}/apps`)).toEqual([]);
    const after = await fetch(url + "/mcp", { method: "POST", headers: { authorization: `Bearer ${provider.saved!.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
    const refresh = await fetch(url + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: provider.saved!.refresh_token!, client_id: String(provider.info!.client_id) }) });
    expect(refresh.status).toBe(400);
    await mcp.close().catch(() => {});
  });

  describe("by hand", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    let clientId: string;

    const authorize = (extra: Record<string, string> = {}) => {
      const u = new URL(url + "/oauth/authorize");
      for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${url}/mcp`, ...extra })) u.searchParams.set(k, v);
      return u;
    };
    const token = (body: Record<string, string>) => fetch(url + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...body }) });

    beforeAll(async () => {
      const reg = await fetch(url + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Inspector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
      expect(reg.status).toBe(201);
      clientId = (await reg.json()).client_id;
    });

    it("refuses unsafe redirect addresses at registration and authorization", async () => {
      expect(validRedirectUri("https://grok.com/callback")).toBe(true);
      expect(validRedirectUri("cursor://anysphere/callback")).toBe(true);
      expect(validRedirectUri("http://evil.example/cb")).toBe(false);
      expect(validRedirectUri("javascript:alert(1)")).toBe(false);
      const reg = await fetch(url + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
      expect(reg.status).toBe(400);
      const res = await fetch(authorize({ redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
      expect(res.status).toBe(400);
      // a loopback client may come back on another port
      expect((await fetch(authorize({ redirect_uri: "http://127.0.0.1:9999/oauth/callback" }), { redirect: "manual" })).status).toBe(302);
    });

    it("requires PKCE", async () => {
      // bad requests get a page on the hub, never a redirect to the app's (unapproved) address
      const res = await fetch(authorize({ code_challenge_method: "plain" }), { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect((await fetch(authorize({ response_type: "token" }), { redirect: "manual" })).status).toBe(400);
      // a token for some other server's resource isn't handed out here
      expect((await fetch(authorize({ resource: "https://foreign.example/mcp" }), { redirect: "manual" })).status).toBe(400);
      // malformed client input is a client error, not a crash
      const basic = await fetch(url + "/oauth/token", { method: "POST", headers: { authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" });
      expect(basic.status).toBe(401);
      const arr = await fetch(url + "/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, grant_type: "authorization_code", code: "x", code_verifier: ["x"] }) });
      expect(arr.status).toBe(400);

      const code = (await consent(authorize())).searchParams.get("code")!;
      const wrong = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "not-the-verifier-not-the-verifier-not-the" });
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).error).toBe("invalid_grant");
      // a code works once, so the failed try used it up
      const again = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
      expect(again.status).toBe(400);
    });

    it("says no back to the app when the person denies", async () => {
      const res = await fetch(authorize(), { redirect: "manual" });
      const requestId = res.headers.get("location")!.split("/authorize/")[1];
      const { redirect } = await owner.request<{ redirect: string }>("POST", `/api/oauth/requests/${requestId}/deny`);
      const back = new URL(redirect);
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("state")).toBe("xyz");
      await expect(owner.request("POST", `/api/oauth/requests/${requestId}/approve`, { agentId })).rejects.toThrow(/expired/);
    });

    it("refreshes, rotating the refresh token", async () => {
      const back = await consent(authorize());
      expect(back.searchParams.get("state")).toBe("xyz");
      const first = await (await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier })).json();
      expect(first).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
      const me = await new WispClient({ url, token: first.access_token }).me();
      expect(me.agent?.id).toBe(agentId);

      const second = await (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).json();
      expect(second.access_token).toMatch(/^wr_agent_/);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).status).toBe(400);
      expect((await new WispClient({ url, token: second.access_token }).me()).agent?.id).toBe(agentId);
    });

    it("needs a signed-in member to approve", async () => {
      const res = await fetch(authorize(), { redirect: "manual" });
      const requestId = res.headers.get("location")!.split("/authorize/")[1];
      const anon = await fetch(`${url}/api/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }) });
      expect(anon.status).toBe(401);
      // a member can't hand an app an agent's access, which may be more than their own
      const { code } = await owner.request<{ code: string }>("POST", "/api/invites", { role: "member" });
      const member = (await (await fetch(`${url}/api/invites/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, email: "m@example.com", name: "Member", password: "password123" }) })).json()).token;
      const asMember = await fetch(`${url}/api/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${member}` }, body: JSON.stringify({ agentId }) });
      expect(asMember.status).toBe(403);
    });
  });

  it("takes an agent's connection token too, for clients with a fixed header", async () => {
    const { token } = await owner.request<{ token: string }>("POST", `/api/agents/${agentId}/token`);
    const mcp = new Client({ name: "fixed", version: "0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect(text(await mcp.callTool({ name: "chat_channels", arguments: {} }))).toContain("general");
    await mcp.close();
  });
});

describe("through the door for Grok, ChatGPT and Claude", () => {
  const HOST = "box.tail1234.ts.net";
  const DOOR = `https://${HOST}:8443`;
  // Tailscale is a stand-in: the door is open on this made-up computer
  beforeAll(() => {
    built.hub.reach.connectorUrl = async () => DOOR;
  });
  const inject = (o: { method?: "GET" | "POST"; url: string; host: string; payload?: unknown; token?: string; form?: boolean }) =>
    built.app.inject({
      method: o.method ?? "GET",
      url: o.url,
      headers: { host: o.host, "x-forwarded-for": "203.0.113.9", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      payload: o.form ? new URLSearchParams(o.payload as Record<string, string>).toString() : (o.payload as object),
      remoteAddress: "127.0.0.1",
    });

  it("names the public door to cloud servers, and the private address for the person's approval", async () => {
    const as = (await inject({ url: "/.well-known/oauth-authorization-server", host: `${HOST}:8443` })).json();
    expect(as).toMatchObject({ issuer: DOOR, authorization_endpoint: `https://${HOST}/oauth/authorize`, token_endpoint: `${DOOR}/oauth/token`, registration_endpoint: `${DOOR}/oauth/register` });
    expect((await inject({ url: "/.well-known/oauth-protected-resource/mcp", host: `${HOST}:8443` })).json()).toMatchObject({ resource: `${DOOR}/mcp`, authorization_servers: [DOOR] });
    const denied = await inject({ method: "POST", url: "/mcp", host: `${HOST}:8443`, payload: {} });
    expect(denied.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${DOOR}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("signs in end to end with the consent page on the private address", async () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const reg = await inject({ method: "POST", url: "/oauth/register", host: `${HOST}:8443`, payload: { client_name: "Grok", redirect_uris: ["https://grok.com/oauth/callback"] } });
    expect(reg.statusCode).toBe(201);
    const clientId = reg.json().client_id;
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://grok.com/oauth/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${DOOR}/mcp` });
    const auth = await inject({ url: `/oauth/authorize?${q}`, host: HOST });
    expect(auth.statusCode).toBe(302);
    expect(auth.headers.location).toMatch(new RegExp(`^https://${HOST.replace(/\./g, "\\.")}/#/authorize/`));
    const requestId = String(auth.headers.location).split("/authorize/")[1];
    const approved = await inject({ method: "POST", url: `/api/oauth/requests/${requestId}/approve`, host: HOST, token: ownerToken, payload: { agentId } });
    const back = new URL(approved.json().redirect);
    // RFC 9207: the app checks this against the issuer it fetched
    expect(back.searchParams.get("iss")).toBe(DOOR);
    const tok = await inject({ method: "POST", url: "/oauth/token", host: `${HOST}:8443`, form: true, payload: { grant_type: "authorization_code", client_id: clientId, code: back.searchParams.get("code")!, redirect_uri: "https://grok.com/oauth/callback", code_verifier: verifier } });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().access_token).toMatch(/^wr_agent_/);
  });

  it("limits registrations per visitor, as Tailscale reports them, not per Tailscale", async () => {
    const register = (ip: string, remoteAddress = "127.0.0.1") =>
      built.app.inject({ method: "POST", url: "/oauth/register", headers: { host: `${HOST}:8443`, "x-forwarded-for": ip }, payload: { redirect_uris: ["https://grok.com/cb"] }, remoteAddress });
    for (let i = 0; i < 30; i++) expect((await register("198.51.100.1")).statusCode).toBe(201);
    expect((await register("198.51.100.1")).statusCode).toBe(429);
    // someone else coming through the same Funnel isn't held back by that
    expect((await register("198.51.100.2")).statusCode).toBe(201);
    // and a stranger on the network can't claim to be someone new to dodge the limit
    for (let i = 0; i < 30; i++) await register(`192.0.2.${i}`, "192.168.1.50");
    expect((await register("192.0.2.200", "192.168.1.50")).statusCode).toBe(429);
  });
});
