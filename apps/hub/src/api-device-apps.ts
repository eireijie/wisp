import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import { DeviceAppError } from "./device-apps.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; owner?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
}

const CALL = z.object({ app: z.string().trim().min(1).max(100), tool: z.string().trim().min(1).max(128), arguments: z.record(z.unknown()).default({}) }).strict();

/**
 * What an agent asks about its apps: the list with what each does (connected_apps), its apps that
 * live on other devices (device_apps), and calling one of their tools (device_app_call).
 */
export function registerDeviceAppsApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { need, parse, requesterOf } = h;

  const agentOf = (req: FastifyRequest, reply: FastifyReply) => {
    const c = need(req, reply);
    if (!c) return null;
    if (c.actor.kind !== "agent") {
      reply.code(403).send({ error: "agents only" });
      return null;
    }
    const agent = hub.store.agent(c.actor.id);
    if (!agent) {
      reply.code(404).send({ error: "agent not found" });
      return null;
    }
    return { c, agent };
  };

  /** The agent's apps, one line each saying what it does and how to reach it (and which are new). */
  app.get("/api/connectors/mine", async (req, reply) => {
    const a = agentOf(req, reply);
    if (!a) return;
    reply.header("cache-control", "no-store");
    const lines = hub.connectors.appLines(a.agent.id, hub.deviceApps.lines(a.agent));
    return { apps: lines, recent: hub.connectors.recentlyConnected(a.agent.id).line || null };
  });

  app.get("/api/device-apps/mine", async (req, reply) => {
    const a = agentOf(req, reply);
    if (!a) return;
    reply.header("cache-control", "no-store");
    return hub.deviceApps.forAgent(a.agent);
  });

  app.post("/api/device-apps/call", async (req, reply) => {
    const a = agentOf(req, reply);
    if (!a) return;
    const body = parse(CALL, req.body, reply);
    if (!body) return;
    try {
      return await hub.deviceApps.call(a.agent, body.app, body.tool, body.arguments, requesterOf(a.c));
    } catch (e) {
      if (e instanceof DeviceAppError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
}
