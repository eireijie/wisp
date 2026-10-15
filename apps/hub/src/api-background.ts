import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import { parseWhen } from "./background.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 22:00");

/**
 * Background work (an agent checking in on its own for a person), follow-ups (one-off "come
 * back to this at 8am"), messaging the person first, and web push so it reaches their phone.
 */
export function registerBackgroundApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse, requesterOf } = h;

  /** The person an agent's call is for: whoever it's working for now, or the workspace owner. */
  const personFor = (c: Caller) => requesterOf(c) ?? store.members(c.workspaceId).find((m) => m.role === "owner")?.id ?? null;

  const agentFor = (c: Caller, agentId: string, reply: FastifyReply) => {
    const agent = store.agent(agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "agent not found" });
      return null;
    }
    return agent;
  };

  // --- people: turning it on, and seeing what it's doing ---------------------------------------

  app.get("/api/agents/:id/background", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    return {
      background: store.background(agent.id, c.actor.id) ?? null,
      followups: store.pendingFollowups(agent.id).filter((f) => !f.userId || f.userId === c.actor.id),
      notAllowed: hub.whyNotAllowed(agent, c.actor.id),
      sources: hub.background.sources(agent.id),
    };
  });

  app.put("/api/agents/:id/background", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    const notAllowed = hub.whyNotAllowed(agent, c.actor.id);
    if (notAllowed) return reply.code(403).send({ error: notAllowed });
    const body = parse(z.object({ enabled: z.boolean(), everyMinutes: z.number().int().min(10).max(1440), focus: z.string().trim().max(2000), quietStart: HHMM, quietEnd: HHMM }).partial().strict(), req.body, reply);
    if (!body) return;
    const was = store.background(agent.id, c.actor.id);
    // turning it on starts with a check right away, so you see it working
    const b = store.setBackground(agent.id, c.actor.id, { ...body, ...(body.enabled && !was?.enabled ? { nextAt: null } : {}) });
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: agent.id });
    // even in quiet hours: they just turned it on, so they expect to see it work
    if (body.enabled && !was?.enabled) hub.background.wake(agent.id, c.actor.id);
    return { background: store.background(agent.id, c.actor.id) ?? b };
  });

  app.post("/api/agents/:id/background/check", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    const runId = hub.background.wake(agent.id, c.actor.id);
    if (!runId) return reply.code(409).send({ error: hub.whyNotAllowed(agent, c.actor.id) ?? "it's already checking" });
    return { runId };
  });

  app.delete("/api/followups/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const f = store.followup((req.params as { id: string }).id);
    const agent = f && store.agent(f.agentId);
    if (!f || !agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "follow-up not found" });
    // the agent that set it, the person it's for, or an owner
    if (c.actor.kind === "agent" ? c.actor.id !== f.agentId : f.userId && f.userId !== c.actor.id && c.viewer.role !== "owner") return reply.code(403).send({ error: "not your follow-up" });
    store.setFollowupStatus(f.id, "cancelled");
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: f.agentId });
    return { ok: true };
  });

  // --- agents: pacing themselves, follow-ups, and writing first --------------------------------

  app.post("/api/background/next", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(z.object({ minutes: z.number().positive().max(100_000), reason: z.string().max(300).default("") }), req.body, reply);
    if (!body) return;
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to work for" });
    return hub.background.setNext(c.actor.id, userId, body.minutes, body.reason);
  });

  app.get("/api/followups", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const agentId = c.actor.kind === "agent" ? c.actor.id : (req.query as { agent?: string }).agent;
    if (!agentId || store.agent(agentId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "which agent?" });
    return store.pendingFollowups(agentId);
  });

  app.post("/api/followups", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents set follow-ups" });
    const body = parse(z.object({ at: z.string().max(40).optional(), inMinutes: z.number().positive().max(60 * 24 * 366).optional(), note: z.string().trim().min(1).max(1000) }), req.body, reply);
    if (!body) return;
    const userId = personFor(c);
    const tz = (userId && store.user(userId)?.timezone) || "UTC";
    const due = body.inMinutes ? new Date(Date.now() + body.inMinutes * 60_000) : body.at ? parseWhen(body.at, tz) : null;
    if (!due) return reply.code(400).send({ error: `give "at" as "YYYY-MM-DD HH:MM" on ${tz} time (or ISO with an offset), or "in_minutes"` });
    if (due.getTime() < Date.now() - 60_000) return reply.code(400).send({ error: "that time has already passed" });
    const f = store.createFollowup({ agentId: c.actor.id, userId, dueAt: due.toISOString(), note: body.note });
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: c.actor.id });
    return { ...f, timezone: tz };
  });

  app.post("/api/message-person", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(z.object({ text: z.string().trim().min(1).max(20_000), fileIds: z.array(z.string()).max(20).default([]) }), req.body, reply);
    if (!body) return;
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to message" });
    const channel = store.dmChannel(c.workspaceId, userId, c.actor.id);
    const files = body.fileIds.map((f) => store.file(f)).filter((f) => f?.workspaceId === c.workspaceId);
    const msg = hub.postMessage({ channelId: channel.id, author: c.actor, body: body.text, parts: files.map((f) => ({ type: "file" as const, fileId: f!.id, name: f!.name })), route: false, onBehalfOf: userId });
    return { messageId: msg.id, channelId: channel.id };
  });

  // --- web push ----------------------------------------------------------------------------------

  app.get("/api/push/key", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return { publicKey: hub.push.keys(c.workspaceId).publicKey };
  });

  const SUB = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

  app.post("/api/push/subscribe", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(SUB, req.body, reply);
    if (!body) return;
    store.savePushSubscription(c.actor.id, body.endpoint, body.keys);
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ endpoint: z.string().max(2000) }), req.body, reply);
    if (!body) return;
    if (store.pushSubscriptions(c.actor.id).some((s) => s.endpoint === body.endpoint)) store.deletePushSubscription(body.endpoint);
    return { ok: true };
  });

  app.post("/api/push/test", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const sent = await hub.push.notify(c.workspaceId, [c.actor.id], { title: "Warren", body: "Notifications reach this device.", tag: "test", url: "/#/settings/notifications" });
    return { sent };
  });
}
