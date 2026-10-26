import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";
import { LoginError } from "./logins.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; owner?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
}

/**
 * Settings → Logins (owners connect a password manager; members see which logins agents can use)
 * and login_fill for agents. No route ever returns a password or the manager's token.
 */
export function registerLoginsApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { need, parse } = h;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof LoginError || err instanceof ComputerError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get("/api/logins", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const source = hub.logins.status(c.workspaceId);
    try {
      const logins = source ? await hub.logins.list(c.workspaceId, (req.query as { fresh?: string }).fresh === "1") : [];
      return { source, logins, problem: null };
    } catch (err) {
      // a token that stopped working still shows what's connected, so it can be replaced
      return { source, logins: [], problem: (err as Error).message };
    }
  });

  app.put("/api/logins/source", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ kind: z.literal("1password"), token: z.string().trim().min(1).max(4000) }), req.body, reply);
    if (!body) return;
    try {
      return await hub.logins.connect(c.workspaceId, c.actor.id, body.kind, body.token);
    } catch (err) {
      if (err instanceof LoginError) return fail(reply, err);
      return reply.code(400).send({ error: `Couldn't open 1Password: ${(err as Error).message}` });
    }
  });

  app.delete("/api/logins/source", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    hub.logins.disconnect(c.workspaceId);
    return { ok: true };
  });

  /** Stop letting one agent use a login without asking. */
  app.delete("/api/logins/:itemId/always/:agentId", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const { itemId, agentId } = req.params as { itemId: string; agentId: string };
    hub.logins.forget(c.workspaceId, itemId, agentId);
    return { ok: true };
  });

  /** An agent signs in on its own computer: filled now, or the person is asked first. */
  app.post("/api/logins/fill", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const agent = hub.store.agent(c.actor.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const body = parse(z.object({ site: z.string().trim().min(1).max(500), account: z.string().trim().max(500).optional() }), req.body, reply);
    if (!body) return;
    try {
      const r = await hub.logins.request(agent, body.site, body.account || undefined, h.requesterOf(c));
      if ("asked" in r) return { status: "asked", approvalId: r.asked, message: `Asked the person whether you may use the ${r.login.title} login. End your turn now; you'll get a message with their answer.` };
      return { status: r.filled.filled.length ? "filled" : "not_filled", message: hub.logins.say(r.login, r.filled) };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
