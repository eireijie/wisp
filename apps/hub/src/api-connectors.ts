import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type CatalogConnector, type Connector, type SignInOption, CONNECTOR_CATALOG, SETTINGS_HARNESSES, SIGN_IN_PROVIDERS, catalogConnector, signInReturnsTo, BUBBLE_COMMANDS, agentSkillPath, catalogSkill, fillTemplate, harnessLabel, skillBody, skillFile, skillSlug, skillTitle, type HarnessSkillFile, type Skill } from "@bubble-ai/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import { CALLBACK_PATH, ConnectorAuth, isPublicUrl } from "./connector-auth.ts";
import { APP_CALLBACK_PATH, AppSignInError } from "./app-signin.ts";
import { registerShopApi } from "./api-shop.ts";
import { ComputerError } from "./computers.ts";
import { MAX_LEARNED, holdsSecret } from "./connectors.ts";
import { checkConnector } from "./glance.ts";
import { checkLinkedApps } from "./composio.ts";
import { agentPolicy } from "./policy.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  commitAuthor(c: Caller): { name: string; email: string };
  deviceOwnerOf(agent: NonNullable<ReturnType<Hub["store"]["agent"]>>): string | null;
}

const ENV = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "names are letters, digits and _"), z.string().max(8000)).refine((o) => Object.keys(o).length <= 50, "at most 50 values");
const HEADERS = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "header names are letters, digits and dashes"), z.string().max(8000)).refine((o) => Object.keys(o).length <= 30, "at most 30 headers");
const URL_ = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");
const AGENT_IDS = z.array(z.string().min(1)).max(500);
const NAME = z.string().trim().min(1).max(60);
/** How long what an app hub said about its apps is trusted before the list asks again. */
const LINKED_FRESH_MS = 3 * 60_000;

const CONNECTOR = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcp-stdio"), name: NAME, catalogId: z.string().max(300).nullish(), command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100).default([]), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional(), nodeId: z.string().max(100).nullish() }),
  z.object({ kind: z.literal("mcp-http"), name: NAME, catalogId: z.string().max(300).nullish(), url: URL_, headers: HEADERS.default({}), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }),
  z.object({ kind: z.literal("secret"), name: NAME, catalogId: z.string().max(300).nullish(), env: ENV.refine((o) => Object.values(o).some(Boolean), "add at least one value"), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }),
]);

const CONNECTOR_PATCH = z
  .object({ name: NAME, command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100), url: URL_, headers: HEADERS, env: ENV, enabled: z.boolean(), agentIds: AGENT_IDS, allAgents: z.boolean(), nodeId: z.string().max(100).nullable() })
  .partial()
  .strict();

/** Where the browser goes after a sign-in: a web app page, or "close" for one opened in its own tab. */
const RETURN_TO = z.union([z.literal("close"), z.string().regex(/^#\/[A-Za-z0-9/_-]{0,200}$/, "a web app page like #/connectors")]);

/** A small page for a sign-in opened in its own tab: says how it went and closes itself. */
function closePage(ok: boolean, message: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "Signed in" : "Not signed in"}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}p{max-width:32ch;padding:0 16px}</style><p>${esc(message)}</p>${ok ? "<script>setTimeout(()=>window.close(),600)</script>" : ""}`;
}

/** Before finishing a sign-in that came back to a different browser than the one that started it. */
function confirmSignInPage(who: string, names: string, continueTo: string, cancelTo: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Finish signing in</title><style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#141414}@media(prefers-color-scheme:dark){body{background:#121214;color:#ededf0}a.go{background:#ededf0!important;color:#121214!important}}main{max-width:380px;padding:24px 16px}h1{font-size:19px;font-weight:600;margin:0 0 8px}p{margin:0 0 16px;opacity:.8}.row{display:flex;gap:12px;align-items:center}a.go{background:#141414;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:500}a.no{color:inherit;opacity:.7}</style><main><h1>Finish signing in</h1><p>${esc(who)} started this sign-in for ${esc(names)} in Bubble AI. Continuing connects the account you just signed in with to it. Continue only if you started it.</p><div class="row"><a class="go" href="${esc(continueTo)}">Continue</a><a class="no" href="${esc(cancelTo)}">Cancel</a></div></main>`;
}

const SKILL_BODY = z.object({ name: NAME, description: z.string().trim().max(500).default(""), content: z.string().min(1).max(100_000), tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]) });

/** What an agent sends to save how it did something (skill_save). */
const LEARNED = z.object({ name: NAME, description: z.string().trim().max(200).default(""), content: z.string().trim().min(1).max(20_000), slug: z.string().trim().min(1).max(60).optional() }).strict();

/**
 * Connectors (MCP servers and secrets agents use) and the skill shop (SKILL.md instructions agents
 * follow). Anyone in the workspace can look; guests can't change anything. Secret values never
 * come back out: they're masked on read, and sending a masked value back keeps the saved one.
 */
export function registerConnectorApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, connectors, skills } = hub;
  const { need, parse, commitAuthor, deviceOwnerOf } = h;
  registerShopApi(app, hub, h);

  /** Agents in the caller's workspace, or a 400 naming the ones that aren't. */
  function agentsIn(c: Caller, ids: string[], reply: FastifyReply): string[] | null {
    const bad = ids.filter((id) => store.agent(id)?.workspaceId !== c.workspaceId);
    if (bad.length) {
      reply.code(400).send({ error: `no such agent: ${bad.join(", ")}` });
      return null;
    }
    return [...new Set(ids)];
  }

  /**
   * Why a connector may not start for the agents it's given: a command its device doesn't have
   * (as the device last reported). Said when it's connected, so nobody finds out from a failed run.
   */
  function warnings(connectorId: string): string[] {
    const conn = connectors.get(connectorId);
    if (!conn || conn.kind !== "mcp-stdio" || !conn.command) return [];
    const out: string[] = [];
    for (const agentId of conn.allAgents ? store.agents(conn.workspaceId).map((a) => a.id) : conn.agentIds) {
      const agent = store.agent(agentId);
      const node = agent?.nodeId ? store.node(agent.nodeId) : undefined;
      const commands = node ? store.nodeCapabilities(node.id)?.commands : undefined;
      if (node && commands && commands[conn.command] === false) out.push(`@${agent!.handle}'s device ${node.name} doesn't have "${conn.command}", so ${conn.name} won't start there until it's installed.`);
    }
    return out;
  }
  const withWarnings = (connectorId: string) => ({ ...connectors.get(connectorId)!, warnings: warnings(connectorId) });
  /** Guests see that a connector exists, not how it's set up (arguments and addresses can hold secrets). */
  const guestView = <T extends Connector>(conn: T): T => ({ ...conn, command: null, args: [], url: null, headers: {}, env: {}, ...("warnings" in conn ? { warnings: [] } : {}) });
  const isOwner = (c: Caller) => c.viewer.role === "owner";

  /** An agent on someone's own device takes connectors only from them: what it's given runs there. Sends a 403 otherwise. */
  function deviceAllows(c: Caller, agentIds: string[], reply: FastifyReply): boolean {
    for (const agentId of agentIds) {
      const agent = store.agent(agentId);
      const owner = agent && deviceOwnerOf(agent);
      if (owner && owner !== c.actor.id) {
        reply.code(403).send({ error: `@${agent!.handle} runs directly on ${store.user(owner)?.name ?? "someone"}'s device, so only they can change its connected apps` });
        return false;
      }
    }
    return true;
  }

  /**
   * Changing a connector changes what runs for everyone who has it, so it's for an owner or the
   * person who added it, and for them only while it isn't on an agent on someone else's device.
   */
  function canChange(c: Caller, conn: Connector, reply: FastifyReply): boolean {
    if (isOwner(c)) return true;
    if (conn.createdBy !== c.actor.id) {
      reply.code(403).send({ error: "Only the person who added this connected app, or an owner, can change it" });
      return false;
    }
    return deviceAllows(c, conn.agentIds, reply);
  }

  /** Whether the hub may call this address for the caller: only owners can point it at their own network. */
  async function addressAllowed(c: Caller, url: string, env: Record<string, string>, reply: FastifyReply): Promise<boolean> {
    if (isOwner(c) || (await isPublicUrl(fillTemplate(url, env)))) return true;
    reply.code(400).send({ error: "Connected apps can only reach public addresses. Ask an owner to add one on a private network." });
    return false;
  }
  const changed = (c: Caller) => hub.broadcast(c.workspaceId, { type: "skills_changed" });

  /**
   * A command can live on a device the caller owns, or one its owner shared: it runs there, for
   * agents on every device. Sends a 403 (or 400) otherwise.
   */
  function homeAllowed(c: Caller, nodeId: string | null | undefined, reply: FastifyReply): boolean {
    if (!nodeId) return true;
    const n = store.node(nodeId);
    if (!n || n.workspaceId !== c.workspaceId) {
      reply.code(400).send({ error: "that device isn't part of this workspace" });
      return false;
    }
    if (n.ownerId && n.ownerId !== c.actor.id && !n.shared) {
      reply.code(403).send({ error: `${n.name} is ${store.user(n.ownerId)?.name ?? "someone"}'s own device, so only they can put an app on it (or share it under Computers)` });
      return false;
    }
    return true;
  }
  const CONNECTOR_CATALOG_WITH_SIGN_IN = () => CONNECTOR_CATALOG.filter((e) => e.signIn);

  // --- connectors -------------------------------------------------------------------------------

  app.get("/api/connectors", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const list = connectors.list(c.workspaceId).map((conn) => withWarnings(conn.id));
    // app hubs (Composio) checked over a few minutes ago look again in the background; a change refreshes the page
    for (const conn of list) {
      if (conn.linkedApps === undefined || !conn.auth?.signedIn) continue;
      if (conn.linkedApps && Date.now() - Date.parse(conn.linkedApps.checkedAt) < LINKED_FRESH_MS) continue;
      const was = JSON.stringify(conn.linkedApps ? [conn.linkedApps.picked, conn.linkedApps.names] : null);
      // marked as checked now, so pages asking again meanwhile don't start another
      connectors.linked.set(conn.id, { picked: conn.linkedApps?.picked ?? null, names: conn.linkedApps?.names ?? [], pickUrl: catalogConnector(conn.catalogId ?? "")!.appsPage!, checkedAt: new Date().toISOString() });
      void checkLinkedApps(hub, conn.id).then((v) => {
        if (JSON.stringify(v ? [v.picked, v.names] : null) !== was) changed(c);
      });
    }
    return c.viewer.role === "guest" ? list.map(guestView) : list;
  });

  app.post("/api/connectors", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(CONNECTOR, req.body, reply);
    if (!body) return;
    if (body.kind === "mcp-stdio" && !isOwner(c)) return reply.code(403).send({ error: "Only an owner can add a connected app that runs a command" });
    if (body.kind === "mcp-http" && !(await addressAllowed(c, body.url, body.env, reply))) return;
    if (connectors.byName(c.workspaceId, body.name)) return reply.code(409).send({ error: `there's already a connected app named "${body.name}"` });
    if (body.kind === "mcp-stdio" && !homeAllowed(c, body.nodeId, reply)) return;
    const agentIds = agentsIn(c, body.agentIds ?? [], reply);
    if (!agentIds || !deviceAllows(c, agentIds, reply)) return;
    const conn = connectors.create(c.workspaceId, c.actor.id, body);
    // its device says which tools it has (in the background: it may have to start the server first)
    if (conn.nodeId) void hub.deviceApps.refresh(conn.id).then(() => changed(c), () => changed(c));
    if (agentIds.length) connectors.setAgents(conn.id, agentIds);
    changed(c);
    // a remote server that wants people to sign in says so now, so the page can offer it
    if (conn.kind === "mcp-http") await connectors.auth.probe(conn.id, connectors.serverUrl(conn.id)!, connectors.serverHeaders(conn.id));
    return withWarnings(conn.id);
  });

  // --- the marketplace (the MCP Registry) and signing in -----------------------------------------

  app.get("/api/marketplace", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const q = String((req.query as { q?: string }).q ?? "").slice(0, 100);
    try {
      return { entries: await hub.marketplace.search(q), featured: !q.trim() };
    } catch (e) {
      return reply.code(502).send({ error: `Couldn't reach the MCP Registry: ${(e as Error).message}` });
    }
  });


  // --- one-click sign-in for catalog apps ----------------------------------------------------------

  /** How each catalog app with a sign-in can be connected from where this person opened Bubble AI. */
  async function signInOption(entry: CatalogConnector, origin: string): Promise<{ ok: true } | { ok: false; reason: string; soon?: boolean }> {
    const s = entry.signIn!;
    if (s.via === "app") return connectors.auth.apps.available(s.provider);
    if (signInReturnsTo(origin, s.localOnly)) return { ok: true };
    const lan = lanHttp(origin);
    if (lan && !s.localOnly)
      return { ok: false, reason: `${entry.name}'s sign-in page only sends people back to an https address, and Bubble AI is open at ${lan}, a plain http address on your home network. Open Bubble AI on the server itself (localhost), or turn on Tailscale under Settings → Computers for an https address, then connect ${entry.name} again.` };
    return { ok: false, reason: s.localOnly ? `${entry.name} only signs in when Bubble AI is open on this computer (localhost).` : `${entry.name} only signs in when Bubble AI is open over https or on this computer.` };
  }

  app.get("/api/connectors/sign-in", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const origin = String((req.query as { origin?: string }).origin ?? "");
    if (!URL_.safeParse(origin).success) return reply.code(400).send({ error: "origin: the address Bubble AI is open at" });
    const out: Record<string, SignInOption> = {};
    for (const entry of CONNECTOR_CATALOG_WITH_SIGN_IN()) {
      const o = await signInOption(entry, origin);
      out[entry.id] = { signIn: o.ok, ...(o.ok ? {} : { reason: o.reason, ...(o.soon ? { soon: true } : {}) }), ...(entry.signInReads ? { reads: entry.signInReads } : {}), key: entry.fields.some((f) => f.secret) };
    }
    return out;
  });

  /**
   * Connect catalog apps by signing in: makes the connector (the company's own remote MCP server)
   * and returns the sign-in page. Several apps from one company (Gmail and Google Calendar) share
   * one sign-in. Signing in again to a connector made this way reuses it.
   */
  app.post("/api/connectors/connect", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ catalogIds: z.array(z.string().max(100)).min(1).max(5), origin: URL_, returnTo: RETURN_TO.nullish(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }).strict(), req.body, reply);
    if (!body) return;
    const entries = [...new Set(body.catalogIds)].map((cid) => catalogConnector(cid));
    if (entries.some((e) => !e?.signIn)) return reply.code(400).send({ error: `can't sign in to ${body.catalogIds.filter((cid) => !catalogConnector(cid)?.signIn).join(", ")}` });
    const list = entries as (CatalogConnector & { signIn: NonNullable<CatalogConnector["signIn"]> })[];
    const first = list[0].signIn;
    const together = list.every((e) => e.signIn.via === "app" && first.via === "app" && e.signIn.provider === first.provider);
    if (list.length > 1 && !together) return reply.code(400).send({ error: "only apps from the same company can share one sign-in" });
    const option = await signInOption(list[0], body.origin);
    if (!option.ok) return reply.code(409).send({ error: option.reason });
    const agentIds = agentsIn(c, body.agentIds ?? [], reply);
    if (!agentIds || !deviceAllows(c, agentIds, reply)) return;

    const made: string[] = [];
    for (const e of list) {
      const s = e.signIn;
      // one made by signing in before (same app, same server): sign in to it again
      const again = connectors.list(c.workspaceId).find((x) => x.catalogId === e.id && x.kind === "mcp-http" && x.url === s.url && (x.createdBy === c.actor.id || isOwner(c)));
      let name = e.name;
      for (let n = 2; !again && connectors.byName(c.workspaceId, name); n++) name = `${e.name} ${n}`;
      const conn = again ?? connectors.create(c.workspaceId, c.actor.id, { kind: "mcp-http", name, catalogId: e.id, url: s.url, headers: s.via === "app" ? (s.headers ?? {}) : {}, env: {}, allAgents: body.allAgents ?? false });
      const add = agentIds.filter((a) => !conn.agentIds.includes(a));
      if (add.length) connectors.setAgents(conn.id, [...conn.agentIds, ...add]);
      if (again && body.allAgents && !again.allAgents) connectors.update(conn.id, { allAgents: true });
      made.push(conn.id);
    }
    changed(c);
    const origin = new URL(body.origin).origin;
    try {
      if (first.via === "app") {
        const scopes = [...new Set(list.flatMap((e) => (e.signIn.via === "app" ? e.signIn.scopes : [])))];
        const url = bindBrowser(reply, await connectors.auth.apps.start(made, first.provider, scopes, origin, c.actor.id, body.returnTo ?? null), origin);
        return { connectors: made.map((cid) => connectors.get(cid)), url };
      }
      const url = bindBrowser(reply, await connectors.auth.start(made[0], first.url, origin, c.actor.id, { scope: first.scope, returnTo: body.returnTo ?? null }), origin);
      return { connectors: made.map((cid) => connectors.get(cid)), ...(url ? { url } : { signedIn: true }) };
    } catch (e) {
      const why = e instanceof AppSignInError ? e.message : `${list[0].name} didn't offer a way to sign in: ${(e as Error).message}`;
      return reply.code(502).send({ error: why, connectors: made.map((cid) => connectors.get(cid)) });
    }
  });

  /** The browser starting a sign-in gets a cookie with a secret (see ConnectorAuth.sameBrowser). Returns the sign-in page, unchanged. */
  function bindBrowser<T extends string | null>(reply: FastifyReply, url: T, origin: string): T {
    const state = url ? new URL(url).searchParams.get("state") : null;
    if (state) reply.header("set-cookie", connectors.auth.bindBrowser(state, origin.startsWith("https:")));
    return url;
  }

  const page = (reply: FastifyReply, html: string) => reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'").type("text/html").send(html);

  /** After a sign-in: back to the web app page it started from, or a small page that closes its own tab. */
  const afterSignIn = (reply: FastifyReply, returnTo: string | null, ok: boolean, message: string) => {
    if (returnTo === "close") return page(reply, closePage(ok, message));
    return reply.redirect(`/?signin=${ok ? "ok" : encodeURIComponent(message)}${returnTo ?? "#/connectors"}`);
  };

  /**
   * Where every sign-in comes back: GitHub, Slack and Google (through Bubble AI's relay, or straight
   * here) at APP_CALLBACK_PATH, the servers' own MCP sign-ins at CALLBACK_PATH. No Bubble AI token here:
   * the state ties it to the sign-in that started it, and only the browser that started it
   * finishes without being asked (a sign-in link passed to someone else must not quietly put
   * their account on the sender's connector).
   */
  async function signInCallback(req: FastifyRequest, reply: FastifyReply, kind: "app" | "mcp") {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string; confirm?: string };
    const pending = q.state ? connectors.auth.pending(q.state) : null;
    // only a sign-in under way here gets to put the sign-in page's words on this page
    if (!q.state || !pending || pending.app !== (kind === "app")) return afterSignIn(reply, null, false, "This sign-in link has expired. Start it again.");
    const state = q.state;
    const returnTo = connectors.auth.returnToFor(state);
    reply.header("set-cookie", ConnectorAuth.clearCookie(state));
    if (q.error || !q.code) {
      const msg = q.error === "access_denied" ? "Sign-in was cancelled." : (q.error_description || q.error || "the sign-in page didn't send a code back").slice(0, 300);
      connectors.auth.failPending(state, msg);
      return afterSignIn(reply, returnTo, false, msg);
    }
    const names = pending.connectorIds.map((cid) => connectors.get(cid)?.name).filter(Boolean).join(" and ") || "a connected app";
    if (!connectors.auth.sameBrowser(state, req.headers.cookie) && q.confirm !== "1") {
      reply.removeHeader("set-cookie");
      const who = (pending.userId && store.user(pending.userId)?.name) || "Someone";
      const here = new URL(req.url, "http://hub");
      here.searchParams.set("confirm", "1");
      const cancel = new URL(req.url, "http://hub");
      for (const k of ["code", "confirm", "error_description"]) cancel.searchParams.delete(k);
      cancel.searchParams.set("error", "access_denied");
      return page(reply, confirmSignInPage(who, names, here.pathname + here.search, cancel.pathname + cancel.search));
    }
    try {
      let ids: string[];
      if (kind === "app") ids = (await connectors.auth.apps.finish(state, q.code)).connectorIds;
      else ids = [await connectors.auth.finish(state, q.code, (id) => connectors.serverUrl(id))];
      const conns = ids.map((cid) => connectors.get(cid)).filter((x): x is Connector => !!x);
      for (const ws of new Set(conns.map((x) => x.workspaceId))) hub.broadcast(ws, { type: "skills_changed" });
      // an app hub (Composio): find out now whether apps are picked inside it, for the connected card
      for (const x of conns) if (catalogConnector(x.catalogId ?? "")?.appsPage) void checkLinkedApps(hub, x.id).then(() => hub.broadcast(x.workspaceId, { type: "skills_changed" }));
      return afterSignIn(reply, returnTo, true, `Signed in to ${conns.map((x) => x.name).join(" and ") || "the app"}. You can close this tab.`);
    } catch (e) {
      return afterSignIn(reply, returnTo, false, (e as Error).message);
    }
  }

  app.get(APP_CALLBACK_PATH, (req, reply) => signInCallback(req, reply, "app"));

  app.post("/api/connectors/:id/signin", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn || !canChange(c, conn, reply)) return;
    const body = parse(z.object({ origin: URL_, returnTo: RETURN_TO.nullish() }), req.body, reply);
    if (!body) return;
    const url = connectors.serverUrl(conn.id);
    if (!url) return reply.code(400).send({ error: "only remote MCP servers can be signed in to" });
    if (!(await addressAllowed(c, url, {}, reply))) return;
    const s = catalogConnector(conn.catalogId ?? "")?.signIn;
    try {
      // made by signing in through Bubble AI's app with GitHub, Slack or Google: sign in the same way again
      if (s?.via === "app" && s.url === conn.url) return { url: bindBrowser(reply, await connectors.auth.apps.start([conn.id], s.provider, s.scopes, new URL(body.origin).origin, c.actor.id, body.returnTo ?? null), body.origin) };
      const to = bindBrowser(reply, await connectors.auth.start(conn.id, url, new URL(body.origin).origin, c.actor.id, { scope: s?.via === "mcp" && s.url === conn.url ? s.scope : undefined, returnTo: body.returnTo ?? null }), body.origin);
      return to ? { url: to } : { signedIn: true };
    } catch (e) {
      if (e instanceof AppSignInError) return reply.code(502).send({ error: e.message });
      return reply.code(502).send({ error: `${conn.name} didn't offer a way to sign in: ${(e as Error).message}` });
    }
  });

  app.get(CALLBACK_PATH, (req, reply) => signInCallback(req, reply, "mcp"));

  app.post("/api/connectors/:id/signout", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn || !canChange(c, conn, reply)) return;
    connectors.auth.signOut(conn.id);
    return connectors.get(conn.id);
  });

  const ownConnector = (c: Caller, req: FastifyRequest, reply: FastifyReply) => {
    const conn = connectors.get((req.params as { id: string }).id);
    if (!conn || conn.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "connected app not found" });
      return null;
    }
    return conn;
  };

  app.get("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    return c.viewer.role === "guest" ? guestView(conn) : conn;
  });

  app.patch("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    if (conn.kind === "mcp-stdio" && !isOwner(c)) return reply.code(403).send({ error: "Only an owner can change a connected app that runs a command" });
    if (!canChange(c, conn, reply)) return;
    const body = parse(CONNECTOR_PATCH, req.body, reply);
    if (!body) return;
    if (conn.kind === "mcp-http" && (body.url || body.env) && !(await addressAllowed(c, body.url ?? conn.url ?? "", body.env ?? {}, reply))) return;
    if (body.allAgents !== undefined && body.allAgents !== conn.allAgents && conn.createdBy !== c.actor.id && store.role(c.workspaceId, c.actor.id) !== "owner")
      return reply.code(403).send({ error: "Only the person who added this connected app, or the workspace owner, can turn All agents on or off" });
    if (body.nodeId !== undefined && body.nodeId !== conn.nodeId) {
      if (conn.kind !== "mcp-stdio") return reply.code(400).send({ error: "only an app that runs a command lives on a device" });
      if (!homeAllowed(c, body.nodeId, reply)) return;
      // moving it off someone's device is theirs to do too
      if (conn.nodeId && !homeAllowed(c, conn.nodeId, reply)) return;
    }
    if (body.name) {
      const other = connectors.byName(c.workspaceId, body.name);
      if (other && other.id !== conn.id) return reply.code(409).send({ error: `there's already a connected app named "${body.name}"` });
    }
    if (body.agentIds) {
      const ids = agentsIn(c, body.agentIds, reply);
      if (!ids) return;
      if (!deviceAllows(c, [...ids.filter((a) => !conn.agentIds.includes(a)), ...conn.agentIds.filter((a) => !ids.includes(a))], reply)) return;
      connectors.setAgents(conn.id, ids);
    }
    const addressBefore = connectors.serverUrl(conn.id);
    const updated = connectors.update(conn.id, body);
    changed(c);
    if (updated?.nodeId && (body.nodeId !== undefined || body.command || body.args || body.env)) void hub.deviceApps.refresh(conn.id).then(() => changed(c), () => changed(c));
    // a new address may want its own sign-in
    const address = connectors.serverUrl(conn.id);
    if (address && address !== addressBefore) await connectors.auth.probe(conn.id, address, connectors.serverHeaders(conn.id));
    return withWarnings(conn.id);
  });

  /** Does its key work? A sign-in with the app's watcher (read-only); 200 either way, apps with no watcher aren't checked. */
  app.post("/api/connectors/:id/check", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    if (!canChange(c, conn, reply)) return;
    return checkConnector(hub, conn.id);
  });

  /**
   * The apps picked inside an app hub (Composio), checked now: `linkedApps.picked` false means none
   * yet, null that it couldn't tell. The connected card asks again when the person comes back from its page.
   */
  app.get("/api/connectors/:id/linked-apps", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    if (!catalogConnector(conn.catalogId ?? "")?.appsPage) return reply.code(400).send({ error: `${conn.name} has no apps inside it` });
    const was = JSON.stringify(connectors.get(conn.id)?.linkedApps?.names ?? null) + String(connectors.get(conn.id)?.linkedApps?.picked);
    const linked = await checkLinkedApps(hub, conn.id);
    if (JSON.stringify(linked?.names ?? null) + String(linked?.picked) !== was) changed(c);
    return { linkedApps: linked };
  });

  app.delete("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    if (!isOwner(c) && conn.createdBy !== c.actor.id) return reply.code(403).send({ error: "Only the person who added this connected app, or an owner, can remove it" });
    connectors.remove(conn.id);
    changed(c);
    return { ok: true };
  });

  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/connectors/:id/agents/:agentId",
      handler: async (req, reply) => {
        const c = need(req, reply, { member: true });
        if (!c) return;
        const conn = ownConnector(c, req, reply);
        if (!conn) return;
        const ids = agentsIn(c, [(req.params as { agentId: string }).agentId], reply);
        if (!ids) return;
        // whoever added a connector can always take it back off
        if ((method === "PUT" || conn.createdBy !== c.actor.id) && !deviceAllows(c, ids, reply)) return;
        if (method === "PUT" && !isOwner(c) && conn.createdBy !== c.actor.id) {
          if (conn.kind === "mcp-stdio") return reply.code(403).send({ error: "Only an owner can give an agent a connected app that runs a command" });
          // its values go to the agent's device in the clear, and that could be the caller's own
          if (connectors.holdsSecrets(conn.id)) return reply.code(403).send({ error: `${conn.name} holds someone's keys, so only they or an owner can give it to agents` });
        }
        connectors.attach(conn.id, ids[0], method === "PUT");
        changed(c);
        return withWarnings(conn.id);
      },
    });
  }

  // --- skills -----------------------------------------------------------------------------------

  /** Put the skill's SKILL.md in each agent's folder (or take it out). */
  async function syncFiles(c: Caller, s: Skill, agentIds: string[], on: boolean) {
    for (const agentId of agentIds) {
      const p = agentSkillPath(agentId, s.slug);
      const handle = store.agent(agentId)?.handle ?? agentId;
      const vault = hub.vault(c.workspaceId);
      if (on) await vault.write(p, skillFile(s), commitAuthor(c), `Skill "${s.name}" for @${handle}`);
      else await vault.remove(p, commitAuthor(c)).catch(() => {});
    }
  }

  /** Agents that have the skill: every agent in the workspace when it's on for all, else the ones given it. */
  const holders = (s: Skill) => (s.allAgents ? store.agents(s.workspaceId).map((a) => a.id) : s.agentIds);

  app.get("/api/skills", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return skills.list(c.workspaceId);
  });

  /**
   * The harnesses' own skills and commands (Codex's system skills, Claude Code's built-ins), as
   * the devices last listed them for where this workspace's agents run. One entry per harness and name.
   */
  app.get("/api/skills/built-in", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const out = new Map<string, { name: string; description?: string; harness: string; harnessLabel: string; agentIds: string[] }>();
    for (const agent of store.agents(c.workspaceId)) {
      const catalog = hub.catalogFor(agent);
      for (const cmd of catalog?.commands ?? []) {
        if (!cmd.builtIn && cmd.kind !== "skill") continue;
        const key = `${agent.harness}\n${cmd.name}`;
        const entry = out.get(key) ?? { name: cmd.name, ...(cmd.description ? { description: cmd.description } : {}), harness: agent.harness, harnessLabel: harnessLabel(agent.harness), agentIds: [] };
        if (!entry.agentIds.includes(agent.id)) entry.agentIds.push(agent.id);
        out.set(key, entry);
      }
    }
    return { skills: [...out.values()].sort((a, b) => a.harnessLabel.localeCompare(b.harnessLabel) || a.name.localeCompare(b.name)) };
  });

  /**
   * The skill an agent learned before that a save means: one at the slug asked for or its name's
   * slug (or the "-2", "-3"… freeSlug gave it when that was taken), else one with the same name.
   */
  function learnedMatch(workspaceId: string, agentId: string, body: { name: string; slug?: string }): Skill | undefined {
    const bases = [...new Set([body.slug && skillSlug(body.slug), skillSlug(body.name)].filter((b): b is string => !!b))];
    const mine = skills.learnedBy(workspaceId, agentId);
    const numbered = (slug: string, base: string) => slug.startsWith(`${base}-`) && /^\d+$/.test(slug.slice(base.length + 1));
    return (
      mine.find((s) => bases.includes(s.slug)) ??
      mine.find((s) => bases.some((b) => numbered(s.slug, b))) ??
      mine.find((s) => s.name.toLowerCase() === body.name.toLowerCase())
    );
  }

  /**
   * An agent saves how it did something, to do it the same way next time (skill_save). Saving
   * under the name (or slug) of a skill it learned before updates that one.
   */
  app.post("/api/skills/learn", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only; people add skills with POST /api/skills" });
    if (!agentPolicy(hub, c.workspaceId).learnSkills) return reply.code(403).send({ error: "Learning skills is off in Settings → Skills" });
    const body = parse(LEARNED, req.body, reply);
    if (!body) return;
    if (holdsSecret(`${body.name}\n${body.description}\n${body.content}`)) return reply.code(400).send({ error: "Skills can't hold passwords, keys or card numbers" });
    const agent = store.agent(c.actor.id)!;
    const slug = skillSlug(body.slug ?? body.name);
    const mine = learnedMatch(c.workspaceId, agent.id, body);
    let skill: Skill;
    if (mine) {
      const shared = mine.allAgents ? holders(mine).filter((a) => a !== agent.id) : [];
      skill = skills.update(mine.id, { name: body.name, description: body.description, content: body.content, allAgents: false })!;
      if (mine.allAgents) {
        // a shared skill its agent changed goes back to just that agent, until a person shares it again
        for (const a of skill.agentIds.filter((a) => a !== agent.id)) skills.attach(skill.id, a, false);
        skills.attach(skill.id, agent.id, true);
        skill = skills.get(skill.id)!;
        await syncFiles(c, skill, shared, false);
      }
    } else {
      if (skills.learnedBy(c.workspaceId, agent.id).length >= MAX_LEARNED) return reply.code(400).send({ error: "Too many learned skills. Forget some in Settings → Skills." });
      // not a name "/" already uses for this agent: Bubble AI's commands, or its harness's own
      const reserved = [...BUBBLE_COMMANDS.map((w) => w.name), ...(hub.catalogFor(agent)?.commands ?? []).map((x) => x.name)];
      skill = skills.create(c.workspaceId, agent.id, { name: body.name, slug: skills.freeSlug(c.workspaceId, slug, reserved), description: body.description, source: "learned", content: body.content, learnedBy: agent.id });
      skills.attach(skill.id, agent.id, true);
      skill = skills.get(skill.id)!;
    }
    await syncFiles(c, skill, holders(skill), true);
    const run = hub.runFor(agent.id, req.headers["x-wisp-run"]);
    if (run) hub.skillUsed(run.id, skill.id, "learned");
    changed(c);
    return { skill };
  });

  /**
   * Add a skill: from the catalog (`catalogId`), from a public repo in the store (`storeId`), from a
   * harness on one of your devices (`nodeId`, `harness`, `skillId`), or your own (name, description,
   * content). Installs it for `agentIds`.
   */
  app.post("/api/skills", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(
      z.union([
        z.object({ catalogId: z.string().min(1).max(60), agentIds: AGENT_IDS.default([]), allAgents: z.boolean().optional() }).strict(),
        z.object({ storeId: z.string().min(1).max(200), agentIds: AGENT_IDS.default([]), allAgents: z.boolean().optional() }).strict(),
        z.object({ nodeId: z.string().min(1).max(100), harness: z.enum(SETTINGS_HARNESSES), skillId: z.string().min(1).max(300), agentIds: AGENT_IDS.default([]), allAgents: z.boolean().optional() }).strict(),
        SKILL_BODY.extend({ agentIds: AGENT_IDS.default([]), allAgents: z.boolean().optional() }).strict(),
      ]),
      req.body,
      reply,
    );
    if (!body) return;
    const agentIds = agentsIn(c, body.agentIds, reply);
    if (!agentIds || !deviceAllows(c, agentIds, reply)) return;
    if (body.allAgents && !isOwner(c)) return reply.code(403).send({ error: "Only an owner can give a skill to every agent" });
    let skill: Skill;
    if ("storeId" in body) {
      let found;
      try {
        found = await hub.publicSkills.installable(body.storeId);
      } catch (e) {
        return reply.code((e as { status?: number }).status ?? 502).send({ error: (e as Error).message });
      }
      if (!found) return reply.code(404).send({ error: "no such skill in the store" });
      skill =
        skills.byCatalog(c.workspaceId, body.storeId) ??
        skills.create(c.workspaceId, c.actor.id, { name: found.name, slug: skills.freeSlug(c.workspaceId, skillSlug(found.skill.id.split(":")[1] ?? found.name)), description: found.description, source: "catalog", catalogId: body.storeId, tags: found.tags, content: found.content });
    } else if ("skillId" in body) {
      // a skill a harness on your own device has: the device sends its SKILL.md (sharing a device lends its agents, not its files)
      const n = store.node(body.nodeId);
      if (!n || n.workspaceId !== c.workspaceId || n.ownerId !== c.actor.id) return reply.code(404).send({ error: "device not found" });
      const from = `device:${n.id}:${body.harness}:${body.skillId}`;
      let file: HarnessSkillFile;
      try {
        file = (await hub.computers.nodeRequest(n.id, (requestId) => ({ type: "harness_skill", requestId, harness: body.harness, id: body.skillId }), 20_000)) as HarnessSkillFile;
      } catch (e) {
        if (e instanceof ComputerError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      const name = skillTitle(file.name || body.skillId).slice(0, 60);
      skill =
        skills.byCatalog(c.workspaceId, from) ??
        skills.create(c.workspaceId, c.actor.id, { name, slug: skills.freeSlug(c.workspaceId, skillSlug(body.skillId)), description: file.description.replace(/\s+/g, " ").trim().slice(0, 500), source: "custom", catalogId: from, tags: [body.harness], content: skillBody(file.content) || file.content });
    } else if ("catalogId" in body) {
      const entry = catalogSkill(body.catalogId);
      if (!entry) return reply.code(404).send({ error: "no such skill in the catalog" });
      skill =
        skills.byCatalog(c.workspaceId, entry.id) ??
        skills.create(c.workspaceId, c.actor.id, { name: entry.name, slug: skills.freeSlug(c.workspaceId, entry.id), description: entry.description, source: "catalog", catalogId: entry.id, tags: entry.tags, content: entry.content });
    } else {
      const { agentIds: _ids, allAgents: _all, ...fields } = body;
      skill = skills.create(c.workspaceId, c.actor.id, { ...fields, slug: skills.freeSlug(c.workspaceId, skillSlug(body.name)), source: "custom" });
    }
    for (const a of agentIds) skills.attach(skill.id, a, true);
    if (body.allAgents !== undefined) skills.update(skill.id, { allAgents: body.allAgents });
    skill = skills.get(skill.id)!;
    await syncFiles(c, skill, skill.allAgents ? holders(skill) : agentIds, true);
    changed(c);
    return skill;
  });

  const ownSkill = (c: Caller, req: FastifyRequest, reply: FastifyReply) => {
    const s = skills.get((req.params as { id: string }).id);
    if (!s || s.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "skill not found" });
      return null;
    }
    return s;
  };

  app.get("/api/skills/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return ownSkill(c, req, reply) ?? undefined;
  });

  app.patch("/api/skills/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const s = ownSkill(c, req, reply);
    if (!s) return;
    const body = parse(SKILL_BODY.partial().extend({ agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }).strict(), req.body, reply);
    if (!body) return;
    if (body.allAgents !== undefined && body.allAgents !== s.allAgents && !isOwner(c)) return reply.code(403).send({ error: "Only an owner can give a skill to every agent" });
    // its text goes into the prompt of every agent that has it
    if (!deviceAllows(c, [...holders(s), ...(body.agentIds ?? [])], reply)) return;
    const { agentIds, ...patch } = body;
    const ids = agentIds && agentsIn(c, agentIds, reply);
    if (agentIds && !ids) return;
    const before = holders(s);
    skills.update(s.id, patch);
    if (ids) {
      for (const a of s.agentIds.filter((a) => !ids.includes(a))) skills.attach(s.id, a, false);
      for (const a of ids) skills.attach(s.id, a, true);
    }
    const after = skills.get(s.id)!;
    const now = holders(after);
    // agents that no longer have it lose the file (switching "All agents" off keeps it for the ones given it)
    await syncFiles(c, after, before.filter((a) => !now.includes(a)), false);
    // everyone who has it gets the new version
    await syncFiles(c, after, now, true);
    changed(c);
    return after;
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const s = ownSkill(c, req, reply);
    if (!s || !deviceAllows(c, holders(s), reply)) return;
    await syncFiles(c, s, holders(s), false);
    skills.remove(s.id);
    changed(c);
    return { ok: true };
  });

  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/skills/:id/agents/:agentId",
      handler: async (req, reply) => {
        const c = need(req, reply, { member: true });
        if (!c) return;
        const s = ownSkill(c, req, reply);
        if (!s) return;
        const ids = agentsIn(c, [(req.params as { agentId: string }).agentId], reply);
        if (!ids || !deviceAllows(c, ids, reply)) return;
        skills.attach(s.id, ids[0], method === "PUT");
        // with "All agents" on, the agent keeps it (and its file) either way
        await syncFiles(c, s, ids, method === "PUT" || s.allAgents);
        changed(c);
        return skills.get(s.id);
      },
    });
  }
}

/** The address when it's plain http on a home or office network (192.168.1.20:3000), else null. */
export function lanHttp(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return null;
    const h = u.hostname;
    const lan = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(h) || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home");
    return lan ? u.host : null;
  } catch {
    return null;
  }
}
