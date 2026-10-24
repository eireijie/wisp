import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WarrenClient } from "@warren/sdk";
import { createWarrenMcp } from "@warren/mcp/src/server.ts";
import { z } from "zod";
import type { Caller } from "./api.ts";
import { bearer, id, issueToken, now, resolveToken, sha } from "./auth.ts";
import type { Hub } from "./hub.ts";

/**
 * The remote MCP endpoint: `/mcp` speaks Streamable HTTP with the same tools as warren-mcp, for
 * cloud MCP clients that connect by URL (Grok connectors, ChatGPT connectors, Claude custom
 * connectors). They sign in with OAuth 2.1 as the MCP spec describes: protected-resource and
 * authorization-server metadata, dynamic client registration, PKCE, and a consent page in the web
 * app where the person picks which agent the client acts as.
 *
 * An access token is an ordinary agent token (made by the person who approved, expiring after an
 * hour), so everything an agent may or may not do applies unchanged. A grant (the refresh token)
 * lasts until it's revoked on the agent's page, or the agent is removed.
 */

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  /** the person whose own device an agent runs on, who alone may connect to it */
  deviceOwnerOf(agent: NonNullable<ReturnType<Hub["store"]["agent"]>>): string | null;
}

const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 15 * 60_000;
const SESSION_IDLE_MS = 60 * 60_000;
const MAX_SESSIONS = 200;
const grantLabel = (grantId: string) => `oauth:${grantId}`;

/** This hub as the caller reached it (behind a tunnel or Tailscale, its public https address). */
export function publicOrigin(req: FastifyRequest): string {
  const fixed = process.env.WARREN_PUBLIC_URL?.replace(/\/+$/, "");
  if (fixed) return fixed;
  const first = (v: unknown) => (typeof v === "string" ? v.split(",")[0].trim() : "");
  const host = first(req.headers["x-forwarded-host"]) || req.headers.host || "localhost";
  let proto = first(req.headers["x-forwarded-proto"]) || req.protocol;
  // Tailscale Serve and Funnel only ever serve https
  if (/\.ts\.net(:\d+)?$/i.test(host)) proto = "https";
  return `${proto}://${host}`;
}

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Where a client may be sent back to: https, http on this machine, or an app's own scheme. */
export function validRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"].includes(u.protocol)) return false;
  if (u.protocol === "http:") return isLoopback(u.hostname);
  return true;
}

/** A redirect_uri from an authorization request matches a registered one (any port on loopback, as OAuth 2.1 allows). */
function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !isLoopback(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch {
      return false;
    }
  });
}

const pkce = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");
const random = () => crypto.randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface ClientRow {
  id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris_json: string;
  auth_method: string;
}
interface Pending {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | undefined;
  challenge: string;
  scope: string;
  expires: number;
}
interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  agentId: string;
  userId: string;
  workspaceId: string;
  scope: string;
  expires: number;
}
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentId: string;
  /** the latest access token the client used; the session's own calls into the API use it */
  auth: { token: string };
  lastSeen: number;
}

const REGISTER = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export function registerRemoteMcp(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const db = store.db;
  const pending = new Map<string, Pending>();
  const codes = new Map<string, Code>();
  const sessions = new Map<string, Session>();
  const registrations = new Map<string, number[]>();

  const sweep = () => {
    const t = Date.now();
    for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
    for (const [k, v] of codes) if (v.expires < t) codes.delete(k);
    for (const [k, s] of sessions) if (t - s.lastSeen > SESSION_IDLE_MS) void closeSession(k, s);
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  app.addHook("preClose", async () => {
    clearInterval(timer);
    await Promise.all([...sessions].map(([k, s]) => closeSession(k, s)));
  });

  async function closeSession(key: string, s: Session) {
    sessions.delete(key);
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  }

  // cloud clients (and browser-based ones like MCP Inspector) call these cross-origin, with bearer tokens, never cookies
  const cors = (reply: FastifyReply) => {
    const r = reply.raw;
    r.setHeader("access-control-allow-origin", "*");
    r.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    r.setHeader("access-control-allow-headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id");
    r.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version, www-authenticate");
  };
  for (const p of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/register", "/oauth/token"])
    app.options(p, async (_req, reply) => {
      cors(reply);
      return reply.code(204).send();
    });

  // --- metadata ------------------------------------------------------------------------------

  const resourceMetadata = (req: FastifyRequest) => {
    const o = publicOrigin(req);
    return { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: ["agent"], resource_name: "Wisp" };
  };
  const serverMetadata = (req: FastifyRequest) => {
    const o = publicOrigin(req);
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["agent"],
    };
  };
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    app.get(p, async (req, reply) => {
      cors(reply);
      return resourceMetadata(req);
    });
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"])
    app.get(p, async (req, reply) => {
      cors(reply);
      return serverMetadata(req);
    });

  // --- dynamic client registration (RFC 7591) ------------------------------------------------

  app.post("/oauth/register", async (req, reply) => {
    cors(reply);
    // anyone can register, so keep one address from filling the table
    const ip = req.ip;
    const recent = (registrations.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
    if (recent.length >= 30) return reply.code(429).send({ error: "slow_down", error_description: "too many registrations" });
    registrations.set(ip, [...recent, Date.now()]);
    const r = REGISTER.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: "invalid_client_metadata", error_description: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const bad = r.data.redirect_uris.find((u) => !validRedirectUri(u));
    if (bad) return reply.code(400).send({ error: "invalid_redirect_uri", error_description: `not allowed: ${bad}` });
    // clients nobody approved within a week go away
    db.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)").run(new Date(Date.now() - 7 * 86400_000).toISOString());
    const method = r.data.token_endpoint_auth_method ?? "none";
    const clientId = id("mcpc");
    const secret = method === "none" ? null : random();
    const name = (r.data.client_name ?? "").trim() || "An app";
    db.prepare("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris_json, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(clientId, secret ? sha(secret) : null, name, JSON.stringify(r.data.redirect_uris), method, now());
    return reply.code(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: r.data.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  const client = (clientId: unknown) => (typeof clientId === "string" ? (db.prepare("SELECT * FROM oauth_clients WHERE id = ?").get(clientId) as ClientRow | undefined) : undefined);

  // --- authorization: the consent page lives in the web app ----------------------------------

  const problem = (reply: FastifyReply, message: string) =>
    reply
      .code(400)
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Can't connect</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.2rem">Can't connect</h1><p>${message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p></body>`);

  app.get("/oauth/authorize", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const c = client(q.client_id);
    if (!c) return problem(reply, "This app isn't registered with this Warren hub. Remove it and add it again.");
    const registered = JSON.parse(c.redirect_uris_json) as string[];
    const redirectUri = q.redirect_uri ?? (registered.length === 1 ? registered[0] : undefined);
    if (!redirectUri || !redirectMatches(registered, redirectUri)) return problem(reply, "This app asked to return to an address it didn't register.");
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      return reply.redirect(u.toString());
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "only response_type=code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with S256 is required");
    if (q.resource) {
      let path = "";
      try {
        path = new URL(q.resource).pathname.replace(/\/+$/, "");
      } catch {}
      if (path !== "/mcp") return back("invalid_target", "this hub's resource is /mcp");
    }
    const requestId = random();
    pending.set(requestId, { clientId: c.id, clientName: c.name, redirectUri, state: q.state, challenge: q.code_challenge, scope: q.scope || "agent", expires: Date.now() + REQUEST_TTL_MS });
    return reply.redirect(`${publicOrigin(req)}/#/authorize/${requestId}`);
  });

  const pendingFor = (req: FastifyRequest, reply: FastifyReply) => {
    const p = pending.get((req.params as { id: string }).id);
    if (!p || p.expires < Date.now()) {
      reply.code(404).send({ error: "This sign-in link expired. Start connecting again from the app." });
      return null;
    }
    return p;
  };
  const returnTo = (p: Pending, params: Record<string, string>) => {
    const u = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (p.state) u.searchParams.set("state", p.state);
    return u.toString();
  };

  /** What the consent page shows: which app, and where it sends you back to. */
  app.get("/api/oauth/requests/:id", async (req, reply) => {
    if (!h.need(req, reply, { member: true })) return;
    const p = pendingFor(req, reply);
    if (!p) return;
    const u = new URL(p.redirectUri);
    return { client: p.clientName, returnsTo: u.protocol === "https:" || u.protocol === "http:" ? u.host : u.protocol.replace(/:$/, "") };
  });

  app.post("/api/oauth/requests/:id/approve", async (req, reply) => {
    const c = h.need(req, reply, { member: true });
    if (!c) return;
    const body = h.parse(z.object({ agentId: z.string().min(1) }), req.body, reply);
    if (!body) return;
    const p = pendingFor(req, reply);
    if (!p) return;
    const agent = store.agent(body.agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const owner = h.deviceOwnerOf(agent);
    if (owner && owner !== c.actor.id) return reply.code(403).send({ error: `@${agent.handle} runs directly on someone's device; only they can connect to it` });
    pending.delete((req.params as { id: string }).id);
    const code = random();
    codes.set(code, { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, agentId: agent.id, userId: c.actor.id, workspaceId: c.workspaceId, scope: p.scope, expires: Date.now() + CODE_TTL_MS });
    return { redirect: returnTo(p, { code, iss: publicOrigin(req) }) };
  });

  app.post("/api/oauth/requests/:id/deny", async (req, reply) => {
    if (!h.need(req, reply, { member: true })) return;
    const p = pendingFor(req, reply);
    if (!p) return;
    pending.delete((req.params as { id: string }).id);
    return { redirect: returnTo(p, { error: "access_denied", error_description: "The person said no." }) };
  });

  // --- tokens --------------------------------------------------------------------------------

  if (!app.hasContentTypeParser("application/x-www-form-urlencoded"))
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  const issue = (grant: { id: string; agent_id: string; workspace_id: string; user_id: string }, scope: string) => {
    const refresh = `wr_refresh_${random()}`;
    db.prepare("UPDATE oauth_grants SET refresh_hash = ?, last_used = ? WHERE id = ?").run(sha(refresh), now(), grant.id);
    const access = issueToken(db, "agent", grant.agent_id, grant.workspace_id, grantLabel(grant.id), grant.user_id, new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString());
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  };

  app.post("/oauth/token", async (req, reply) => {
    cors(reply);
    reply.header("cache-control", "no-store");
    const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, string | undefined>;
    const fail = (status: number, error: string, description: string) => reply.code(status).send({ error, error_description: description });
    // the client: client_secret_basic, client_secret_post, or a public client by id alone
    let clientId = b.client_id;
    let secret = b.client_secret;
    const basic = req.headers.authorization?.match(/^Basic\s+(\S+)$/i)?.[1];
    if (basic) {
      const [u, s] = Buffer.from(basic, "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(s ?? "");
    }
    const c = client(clientId);
    if (!c) return fail(401, "invalid_client", "unknown client");
    if (c.secret_hash && !(secret && safeEqual(sha(secret), c.secret_hash))) return fail(401, "invalid_client", "wrong client secret");

    if (b.grant_type === "authorization_code") {
      const code = b.code ? codes.get(b.code) : undefined;
      if (b.code) codes.delete(b.code);
      if (!code || code.expires < Date.now() || code.clientId !== c.id) return fail(400, "invalid_grant", "the code is wrong or expired");
      if (b.redirect_uri !== undefined && b.redirect_uri !== code.redirectUri) return fail(400, "invalid_grant", "redirect_uri doesn't match");
      if (!b.code_verifier || !safeEqual(pkce(b.code_verifier), code.challenge)) return fail(400, "invalid_grant", "PKCE check failed");
      if (!store.agent(code.agentId)) return fail(400, "invalid_grant", "that agent was removed");
      const grant = { id: id("grant"), agent_id: code.agentId, workspace_id: code.workspaceId, user_id: code.userId };
      db.prepare("INSERT INTO oauth_grants (id, client_id, client_name, agent_id, workspace_id, user_id, refresh_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(grant.id, c.id, c.name, grant.agent_id, grant.workspace_id, grant.user_id, sha(random()), now());
      hub.broadcast(code.workspaceId, { type: "agents_changed" });
      return issue(grant, code.scope);
    }
    if (b.grant_type === "refresh_token") {
      const grant = b.refresh_token
        ? (db.prepare("SELECT id, client_id, agent_id, workspace_id, user_id FROM oauth_grants WHERE refresh_hash = ?").get(sha(b.refresh_token)) as { id: string; client_id: string; agent_id: string; workspace_id: string; user_id: string } | undefined)
        : undefined;
      if (!grant || grant.client_id !== c.id) return fail(400, "invalid_grant", "the refresh token is wrong or was revoked");
      // whoever approved it has to still be in the organization
      if (!store.role(grant.workspace_id, grant.user_id) || !store.agent(grant.agent_id)) {
        revokeGrant(grant.id);
        return fail(400, "invalid_grant", "this connection is no longer allowed");
      }
      return issue(grant, "agent");
    }
    return fail(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  });

  function revokeGrant(grantId: string) {
    db.prepare("DELETE FROM oauth_grants WHERE id = ?").run(grantId);
    db.prepare("DELETE FROM tokens WHERE label = ?").run(grantLabel(grantId));
    // open sessions whose token stopped working end now rather than at their next request
    for (const [k, s] of sessions) if (!resolveToken(db, s.auth.token)) void closeSession(k, s);
  }

  // --- the agent's page: apps connected as it --------------------------------------------------

  const agentFor = (req: FastifyRequest, reply: FastifyReply, c: Caller) => {
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "agent not found" });
      return null;
    }
    return agent;
  };

  app.get("/api/agents/:id/apps", async (req, reply) => {
    const c = h.need(req, reply, { user: true });
    if (!c) return;
    const agent = agentFor(req, reply, c);
    if (!agent) return;
    const rows = db
      .prepare("SELECT g.id, g.client_name, g.user_id, g.created_at, MAX(COALESCE(g.last_used, ''), COALESCE((SELECT MAX(last_used) FROM tokens t WHERE t.label = 'oauth:' || g.id), '')) AS last_used FROM oauth_grants g WHERE g.agent_id = ? ORDER BY g.created_at DESC")
      .all(agent.id) as { id: string; client_name: string; user_id: string; created_at: string; last_used: string | null }[];
    return rows.map((r) => ({ id: r.id, name: r.client_name, approvedBy: store.user(r.user_id)?.name ?? null, createdAt: r.created_at, lastUsed: r.last_used || null }));
  });

  app.delete("/api/agents/:id/apps/:grantId", async (req, reply) => {
    const c = h.need(req, reply, { member: true });
    if (!c) return;
    const agent = agentFor(req, reply, c);
    if (!agent) return;
    const { grantId } = req.params as { grantId: string };
    const g = db.prepare("SELECT id FROM oauth_grants WHERE id = ? AND agent_id = ?").get(grantId, agent.id);
    if (!g) return reply.code(404).send({ error: "not connected" });
    revokeGrant(grantId);
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return { ok: true };
  });

  /** Every app connected to any agent in this workspace, for Settings → Devices. */
  app.get("/api/mcp/clients", async (req, reply) => {
    const c = h.need(req, reply, { user: true });
    if (!c) return;
    const rows = db
      .prepare("SELECT g.id, g.client_name, g.agent_id, g.created_at, MAX(COALESCE(g.last_used, ''), COALESCE((SELECT MAX(last_used) FROM tokens t WHERE t.label = 'oauth:' || g.id), '')) AS last_used FROM oauth_grants g WHERE g.workspace_id = ? ORDER BY g.created_at DESC")
      .all(c.workspaceId) as { id: string; client_name: string; agent_id: string; created_at: string; last_used: string | null }[];
    return rows.map((r) => ({ id: r.id, name: r.client_name, agentId: r.agent_id, agentName: store.agent(r.agent_id)?.name ?? null, createdAt: r.created_at, lastUsed: r.last_used || null }));
  });

  app.delete("/api/mcp/clients/:grantId", async (req, reply) => {
    const c = h.need(req, reply, { member: true });
    if (!c) return;
    const { grantId } = req.params as { grantId: string };
    const g = db.prepare("SELECT id FROM oauth_grants WHERE id = ? AND workspace_id = ?").get(grantId, c.workspaceId);
    if (!g) return reply.code(404).send({ error: "not connected" });
    revokeGrant(grantId);
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return { ok: true };
  });

  // --- /mcp ----------------------------------------------------------------------------------

  /** The session's tools call the hub's own API in-process, as the agent, with the client's latest token. */
  const inProcess =
    (auth: { token: string }): typeof fetch =>
    async (input, init = {}) => {
      const u = new URL(String(input));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      headers.authorization = `Bearer ${auth.token}`;
      const body = init.body;
      const res = await app.inject({
        method: (init.method ?? "GET") as "GET",
        url: u.pathname + u.search,
        headers,
        payload: body == null ? undefined : typeof body === "string" ? body : Buffer.from(body as Uint8Array),
      });
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      return new Response([101, 204, 205, 304].includes(res.statusCode) ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
    };

  const rpcError = (reply: FastifyReply, status: number, message: string) => reply.code(status).send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    const token = bearer(req.headers.authorization);
    const p = resolveToken(db, token);
    if (!token || !p || p.kind !== "agent") {
      const o = publicOrigin(req);
      return reply
        .code(401)
        .header("www-authenticate", `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource/mcp"${token ? ', error="invalid_token"' : ""}`)
        .send({ error: "unauthorized" });
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const s = sessions.get(sid);
      if (!s) return rpcError(reply, 404, "Session not found");
      if (s.agentId !== p.subjectId) return rpcError(reply, 403, "This session belongs to another agent");
      s.auth.token = token;
      s.lastSeen = Date.now();
      reply.hijack();
      await s.transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) return rpcError(reply, 400, "No session: send initialize first");

    const auth = { token };
    let server: McpServer;
    try {
      server = await createWarrenMcp(new WarrenClient({ url: "http://hub.internal", token, fetch: inProcess(auth) }), { localFiles: false });
    } catch (e) {
      return rpcError(reply, 500, (e as Error).message);
    }
    // the oldest idle session makes room
    if (sessions.size >= MAX_SESSIONS) {
      const [k, s] = [...sessions].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      await closeSession(k, s);
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, agentId: p.subjectId, auth, lastSeen: Date.now() });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
