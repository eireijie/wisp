import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentSkillPath, catalogSkill, skillFile, skillSlug, type Skill } from "@warren/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  commitAuthor(c: Caller): { name: string; email: string };
}

const ENV = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "names are letters, digits and _"), z.string().max(8000)).refine((o) => Object.keys(o).length <= 50, "at most 50 values");
const HEADERS = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "header names are letters, digits and dashes"), z.string().max(8000)).refine((o) => Object.keys(o).length <= 30, "at most 30 headers");
const URL_ = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL");
const AGENT_IDS = z.array(z.string().min(1)).max(500);
const NAME = z.string().trim().min(1).max(60);

const CONNECTOR = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcp-stdio"), name: NAME, catalogId: z.string().max(60).nullish(), command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100).default([]), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional() }),
  z.object({ kind: z.literal("mcp-http"), name: NAME, catalogId: z.string().max(60).nullish(), url: URL_, headers: HEADERS.default({}), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional() }),
  z.object({ kind: z.literal("secret"), name: NAME, catalogId: z.string().max(60).nullish(), env: ENV.refine((o) => Object.values(o).some(Boolean), "add at least one value"), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional() }),
]);

const CONNECTOR_PATCH = z
  .object({ name: NAME, command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100), url: URL_, headers: HEADERS, env: ENV, enabled: z.boolean(), agentIds: AGENT_IDS })
  .partial()
  .strict();

const SKILL_BODY = z.object({ name: NAME, description: z.string().trim().max(500).default(""), content: z.string().min(1).max(100_000), tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]) });

/**
 * Connectors (MCP servers and secrets agents use) and the skill shop (SKILL.md instructions agents
 * follow). Anyone in the workspace can look; guests can't change anything. Secret values never
 * come back out: they're masked on read, and sending a masked value back keeps the saved one.
 */
export function registerConnectorApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, vault, connectors, skills } = hub;
  const { need, parse, commitAuthor } = h;

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
    for (const agentId of conn.agentIds) {
      const agent = store.agent(agentId);
      const node = agent?.nodeId ? store.node(agent.nodeId) : undefined;
      const commands = node ? store.nodeCapabilities(node.id)?.commands : undefined;
      if (node && commands && commands[conn.command] === false) out.push(`@${agent!.handle}'s device ${node.name} doesn't have "${conn.command}", so ${conn.name} won't start there until it's installed.`);
    }
    return out;
  }
  const withWarnings = (connectorId: string) => ({ ...connectors.get(connectorId)!, warnings: warnings(connectorId) });

  // --- connectors -------------------------------------------------------------------------------

  app.get("/api/connectors", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return connectors.list(c.workspaceId);
  });

  app.post("/api/connectors", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(CONNECTOR, req.body, reply);
    if (!body) return;
    if (connectors.byName(c.workspaceId, body.name)) return reply.code(409).send({ error: `there's already a connector named "${body.name}"` });
    const agentIds = agentsIn(c, body.agentIds ?? [], reply);
    if (!agentIds) return;
    const conn = connectors.create(c.workspaceId, c.actor.id, body);
    if (agentIds.length) connectors.setAgents(conn.id, agentIds);
    return withWarnings(conn.id);
  });

  const ownConnector = (c: Caller, req: FastifyRequest, reply: FastifyReply) => {
    const conn = connectors.get((req.params as { id: string }).id);
    if (!conn || conn.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "connector not found" });
      return null;
    }
    return conn;
  };

  app.get("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return ownConnector(c, req, reply) ?? undefined;
  });

  app.patch("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    const body = parse(CONNECTOR_PATCH, req.body, reply);
    if (!body) return;
    if (body.name) {
      const other = connectors.byName(c.workspaceId, body.name);
      if (other && other.id !== conn.id) return reply.code(409).send({ error: `there's already a connector named "${body.name}"` });
    }
    if (body.agentIds) {
      const ids = agentsIn(c, body.agentIds, reply);
      if (!ids) return;
      connectors.setAgents(conn.id, ids);
    }
    connectors.update(conn.id, body);
    return withWarnings(conn.id);
  });

  app.delete("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    connectors.remove(conn.id);
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
        connectors.attach(conn.id, ids[0], method === "PUT");
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
      if (on) await vault.write(p, skillFile(s), commitAuthor(c), `Skill "${s.name}" for @${handle}`);
      else await vault.remove(p, commitAuthor(c)).catch(() => {});
    }
  }

  app.get("/api/skills", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return skills.list(c.workspaceId);
  });

  /** Add a skill: from the catalog (`catalogId`) or your own (name, description, content). Installs it for `agentIds`. */
  app.post("/api/skills", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.union([z.object({ catalogId: z.string().min(1).max(60), agentIds: AGENT_IDS.default([]) }).strict(), SKILL_BODY.extend({ agentIds: AGENT_IDS.default([]) }).strict()]), req.body, reply);
    if (!body) return;
    const agentIds = agentsIn(c, body.agentIds, reply);
    if (!agentIds) return;
    let skill: Skill;
    if ("catalogId" in body) {
      const entry = catalogSkill(body.catalogId);
      if (!entry) return reply.code(404).send({ error: "no such skill in the catalog" });
      skill =
        skills.byCatalog(c.workspaceId, entry.id) ??
        skills.create(c.workspaceId, c.actor.id, { name: entry.name, slug: skills.freeSlug(c.workspaceId, entry.id), description: entry.description, source: "catalog", catalogId: entry.id, tags: entry.tags, content: entry.content });
    } else {
      skill = skills.create(c.workspaceId, c.actor.id, { ...body, slug: skills.freeSlug(c.workspaceId, skillSlug(body.name)), source: "custom" });
    }
    for (const a of agentIds) skills.attach(skill.id, a, true);
    await syncFiles(c, skill, agentIds, true);
    return skills.get(skill.id);
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
    const body = parse(SKILL_BODY.partial().extend({ agentIds: AGENT_IDS.optional() }).strict(), req.body, reply);
    if (!body) return;
    const { agentIds, ...patch } = body;
    const ids = agentIds && agentsIn(c, agentIds, reply);
    if (agentIds && !ids) return;
    const updated = skills.update(s.id, patch)!;
    if (ids) {
      const removed = s.agentIds.filter((a) => !ids.includes(a));
      for (const a of removed) skills.attach(s.id, a, false);
      for (const a of ids) skills.attach(s.id, a, true);
      await syncFiles(c, updated, removed, false);
    }
    const after = skills.get(s.id)!;
    // everyone who has it gets the new version
    await syncFiles(c, after, after.agentIds, true);
    return after;
  });

  app.delete("/api/skills/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const s = ownSkill(c, req, reply);
    if (!s) return;
    await syncFiles(c, s, s.agentIds, false);
    skills.remove(s.id);
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
        if (!ids) return;
        skills.attach(s.id, ids[0], method === "PUT");
        await syncFiles(c, s, ids, method === "PUT");
        return skills.get(s.id);
      },
    });
  }
}
