import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { WATCH_SERVICES, type Watch } from "@wisp/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
}

const Config = z.record(z.union([z.string().max(2000), z.array(z.string().max(200)).max(100)])).refine((c) => Object.keys(c).length <= 20, "too many options");

/**
 * Watches on people's apps (watches.ts). People see and stop theirs; agents start them while
 * setting someone up ("I'll keep an eye on your Slack"), see the ones they're on, and stop
 * themselves. A watch is always for one person, and only reaches agents working for them.
 */
export function registerWatchesApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, watches } = hub;
  const { need, parse, requesterOf } = h;

  /** The person an agent's call is for: whoever it's working for now, or the workspace owner. */
  const personFor = (c: Caller) => requesterOf(c) ?? store.members(c.workspaceId).find((m) => m.role === "owner")?.id ?? null;

  /** A person may change their own watches; an agent only takes itself off one. */
  const mine = (c: Caller, w: Watch | undefined) => !!w && w.workspaceId === c.workspaceId && (c.actor.kind === "user" ? w.userId === c.actor.id : w.agentIds.includes(c.actor.id));

  const withEstimate = (w: Watch) => ({ ...w, estimate: watches.estimate(w.workspaceId, w.userId, w.service, w.everyMinutes, w.id) });

  app.get("/api/watches", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const list = c.actor.kind === "agent" ? watches.list(c.workspaceId, { agentId: c.actor.id, userId: personFor(c) ?? undefined }) : watches.list(c.workspaceId, { userId: c.actor.id });
    return { watches: list.map(withEstimate), services: watches.services() };
  });

  app.get("/api/watches/:id/recent", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const w = watches.get((req.params as { id: string }).id);
    if (!mine(c, w)) return reply.code(404).send({ error: "watch not found" });
    return watches.recent(w!.id);
  });

  app.post("/api/watches", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(
      z.object({
        service: z.enum(WATCH_SERVICES),
        connectorId: z.string().max(100).nullish(),
        /** a key for this watch alone: { GITHUB_TOKEN: "…" } */
        key: z.record(z.string().max(8000)).optional(),
        config: Config.optional(),
        label: z.string().max(80).optional(),
        everyMinutes: z.number().int().min(1).max(1440).optional(),
        /** people pick agents; an agent always watches for itself */
        agentIds: z.array(z.string()).max(50).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const userId = c.actor.kind === "agent" ? personFor(c) : c.actor.id;
    if (!userId) return reply.code(409).send({ error: "nobody to watch for" });
    const agentIds = c.actor.kind === "agent" ? [c.actor.id] : body.agentIds ?? [];
    const w = await watches.create({ workspaceId: c.workspaceId, userId, agentIds, service: body.service, connectorId: body.connectorId ?? null, secrets: body.key, config: body.config, label: body.label, everyMinutes: body.everyMinutes, createdBy: c.actor.id });
    if ("error" in w) return reply.code(400).send(w);
    const b = store.background(agentIds[0], userId);
    return { ...withEstimate(w), backgroundOn: !!b?.enabled };
  });

  app.patch("/api/watches/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const w = watches.get((req.params as { id: string }).id);
    if (!mine(c, w)) return reply.code(404).send({ error: "watch not found" });
    const body = parse(z.object({ paused: z.boolean().optional(), agentIds: z.array(z.string()).min(1).max(50).optional(), everyMinutes: z.number().int().min(1).max(1440).optional(), config: Config.optional(), label: z.string().max(80).optional() }).strict(), req.body, reply);
    if (!body) return;
    const r = watches.update(w!.id, body);
    if ("error" in r) return reply.code(400).send(r);
    return withEstimate(r);
  });

  app.delete("/api/watches/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const w = watches.get((req.params as { id: string }).id);
    if (!mine(c, w)) return reply.code(404).send({ error: "watch not found" });
    if (c.actor.kind === "agent") watches.removeAgent(w!.id, c.actor.id);
    else watches.remove(w!.id);
    return { ok: true };
  });
}
