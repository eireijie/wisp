import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import { LoginError } from "./logins.ts";
import { STORAGE_CALLBACK, StorageError } from "./storage.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; owner?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
  channelVisible(c: Caller, channelId: string): unknown;
  dataDir: string;
  filesDir: string;
}

const PATH = z.string().max(4096);
const REF = z.string().trim().min(1).max(200);
const FOLDERS = z.array(z.object({ path: PATH, access: z.enum(["read", "write"]) })).max(50);

/**
 * The Storage mod. Owners connect storage and pick folders and agents (members can see what's
 * connected); agents use it through the storage_* tools. Nothing here answers while the mod is
 * off, and no route ever returns a password or token.
 */
export function registerStorageApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { need, parse } = h;
  const storage = hub.storage;
  storage.configure({ dataDir: h.dataDir, filesDir: h.filesDir });

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof StorageError || err instanceof LoginError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  /** The caller, if the mod is on for their workspace. */
  const caller = (req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; member?: boolean }) => {
    const c = need(req, reply, opts);
    if (!c) return null;
    if (!storage.on(c.workspaceId)) {
      reply.code(404).send({ error: "The Storage mod is off. Turn it on in Mods." });
      return null;
    }
    return c;
  };
  const own = (c: Caller, req: FastifyRequest, reply: FastifyReply) => {
    const conn = storage.get((req.params as { id: string }).id);
    if (!conn || conn.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "No such storage." });
      return null;
    }
    return conn;
  };
  const agentOf = (c: Caller, reply: FastifyReply) => {
    if (c.actor.kind !== "agent") {
      reply.code(403).send({ error: "agents only" });
      return null;
    }
    const agent = hub.store.agent(c.actor.id);
    if (!agent) reply.code(404).send({ error: "agent not found" });
    return agent ?? null;
  };

  // --- people ----------------------------------------------------------------------------------

  app.get("/api/storage", async (req, reply) => {
    const c = caller(req, reply, { member: true });
    if (!c) return;
    return { connections: storage.list(c.workspaceId), apps: c.viewer.role === "owner" ? storage.oauthApps(c.workspaceId) : {} };
  });

  app.post("/api/storage/webdav", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z.object({
        service: z.enum(["nextcloud", "truenas", "webdav"]),
        url: z.string().trim().min(1).max(2000),
        name: z.string().trim().max(80).optional(),
        username: z.string().trim().max(200).optional(),
        password: z.string().max(2000).optional(),
        loginItemId: z.string().trim().max(200).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    try {
      return await storage.connectWebdav(c.workspaceId, c.actor.id, body);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/api/storage/nextcloud/start", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ server: z.string().trim().min(1).max(2000) }), req.body, reply);
    if (!body) return;
    try {
      return await storage.nextcloudStart(c.workspaceId, c.actor.id, body.server);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** The page asks every couple of seconds until the person has approved Wisp in Nextcloud. */
  app.post("/api/storage/nextcloud/poll", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ pendingId: z.string().min(1).max(100) }), req.body, reply);
    if (!body) return;
    try {
      const conn = await storage.nextcloudPoll(c.workspaceId, body.pendingId);
      return conn ? { connection: conn } : { waiting: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/api/storage/oauth/start", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ service: z.enum(["gdrive", "dropbox"]), origin: z.string().url().max(2000), clientId: z.string().trim().max(500).optional(), clientSecret: z.string().trim().max(500).optional() }), req.body, reply);
    if (!body) return;
    try {
      return storage.oauthStart(c.workspaceId, c.actor.id, body.service, body.origin, { clientId: body.clientId, clientSecret: body.clientSecret });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** Where Google or Dropbox sends the browser back. No Wisp token here: the state ties it to the sign-in that started it. */
  app.get(STORAGE_CALLBACK, async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
    const back = (msg?: string) => reply.redirect(`/?storage=${msg ? encodeURIComponent(msg) : "ok"}#/settings/storage`);
    if (q.error) return back(q.error_description || q.error);
    if (!q.state || !q.code) return back("the sign-in page didn't send a code back");
    try {
      const conn = await storage.oauthFinish(q.state, q.code);
      return reply.redirect(`/?storage=ok#/settings/storage/${encodeURIComponent(conn.id)}`);
    } catch (e) {
      return back((e as Error).message);
    }
  });

  app.patch("/api/storage/:id", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const conn = own(c, req, reply);
    if (!conn) return;
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), folders: FOLDERS.optional(), allAgents: z.boolean().optional(), agentIds: z.array(z.string()).max(500).optional() }), req.body, reply);
    if (!body) return;
    try {
      return storage.update(conn.id, body);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete("/api/storage/:id", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const conn = own(c, req, reply);
    if (!conn) return;
    storage.remove(conn.id);
    return { ok: true };
  });

  /** Folders to pick from, a level at a time. */
  app.get("/api/storage/:id/browse", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const conn = own(c, req, reply);
    if (!conn) return;
    try {
      return { entries: await storage.browse(conn.id, String((req.query as { path?: string }).path ?? "/")) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete("/api/storage/:id/always/:agentId", async (req, reply) => {
    const c = caller(req, reply, { owner: true });
    if (!c) return;
    const conn = own(c, req, reply);
    if (!conn) return;
    storage.forgetAlways(conn.id, (req.params as { agentId: string }).agentId, String((req.query as { folder?: string }).folder ?? ""));
    return storage.get(conn.id);
  });

  // --- agents ----------------------------------------------------------------------------------

  app.get("/api/storage/mine", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const agent = agentOf(c, reply);
    if (!agent) return;
    // an agent without the mod simply has none
    return storage.forAgent(agent).map((s) => ({ id: s.id, name: s.name, service: s.service, folders: s.folders }));
  });

  const agentRoute = <S extends z.ZodTypeAny>(url: string, schema: S, fn: (agent: NonNullable<ReturnType<typeof agentOf>>, body: z.output<S>, c: Caller) => Promise<unknown>) =>
    app.post(url, async (req, reply) => {
      const c = caller(req, reply);
      if (!c) return;
      const agent = agentOf(c, reply);
      if (!agent) return;
      const body = parse(schema, req.body, reply);
      if (!body) return;
      try {
        return await fn(agent, body, c);
      } catch (e) {
        return fail(reply, e);
      }
    });

  agentRoute("/api/storage/agent/list", z.object({ storage: REF, path: PATH.optional() }), (agent, b) => storage.agentList(agent, b.storage, b.path));

  agentRoute("/api/storage/agent/read", z.object({ storage: REF, path: PATH }), async (agent, b) => {
    const f = await storage.agentRead(agent, b.storage, b.path);
    const text = /^text\/|json|xml|csv|markdown|yaml/.test(f.mime);
    return { name: f.name, mime: f.mime, size: f.data.length, ...(text ? { text: f.data.toString("utf8") } : { base64: f.data.toString("base64") }) };
  });

  agentRoute("/api/storage/agent/search", z.object({ storage: REF, query: z.string().trim().min(1).max(200), path: PATH.optional() }), (agent, b) => storage.agentSearch(agent, b.storage, b.query, b.path));

  agentRoute("/api/storage/agent/download", z.object({ storage: REF, path: PATH, channelId: z.string().optional() }), async (agent, b, c) => {
    if (b.channelId && !h.channelVisible(c, b.channelId)) throw new StorageError("channel not found", 404);
    // the copy belongs to the conversation the agent is in, not to everyone in the workspace
    const channelId = b.channelId ?? hub.whereIs(agent.id)?.channelId ?? null;
    return storage.agentToWisp(agent, b.storage, b.path, channelId);
  });

  agentRoute("/api/storage/agent/change", z.object({ storage: REF, action: z.enum(["put", "delete", "mkdir"]), path: PATH, fileId: z.string().optional() }), async (agent, b, c) => {
    const r = await storage.agentChange(agent, b.storage, b.action, b.path, b.fileId ?? null, h.requesterOf(c));
    if ("asked" in r) return { status: "asked", approvalId: r.asked, message: `Asked the person: "${r.summary}". End your turn now; you'll get a message with their answer.` };
    return { status: "done", message: r.done };
  });
}
