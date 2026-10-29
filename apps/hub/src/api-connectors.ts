import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SETTINGS_HARNESSES, WISP_COMMANDS, agentSkillPath, catalogSkill, harnessLabel, skillBody, skillFile, skillSlug, skillTitle, type HarnessSkillFile, type Skill } from "@wisp/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import { CALLBACK_PATH } from "./connector-auth.ts";
import { registerShopApi } from "./api-shop.ts";
import { ComputerError } from "./computers.ts";
import { holdsSecret } from "./connectors.ts";
import { agentPolicy } from "./policy.ts";

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
  z.object({ kind: z.literal("mcp-stdio"), name: NAME, catalogId: z.string().max(300).nullish(), command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100).default([]), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }),
  z.object({ kind: z.literal("mcp-http"), name: NAME, catalogId: z.string().max(300).nullish(), url: URL_, headers: HEADERS.default({}), env: ENV.default({}), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }),
  z.object({ kind: z.literal("secret"), name: NAME, catalogId: z.string().max(300).nullish(), env: ENV.refine((o) => Object.values(o).some(Boolean), "add at least one value"), enabled: z.boolean().optional(), agentIds: AGENT_IDS.optional(), allAgents: z.boolean().optional() }),
]);

const CONNECTOR_PATCH = z
  .object({ name: NAME, command: z.string().trim().min(1).max(1000), args: z.array(z.string().max(4000)).max(100), url: URL_, headers: HEADERS, env: ENV, enabled: z.boolean(), agentIds: AGENT_IDS, allAgents: z.boolean() })
  .partial()
  .strict();

const SKILL_BODY = z.object({ name: NAME, description: z.string().trim().max(500).default(""), content: z.string().min(1).max(100_000), tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]) });

/** How many skills one agent can learn. */
const MAX_LEARNED = 200;

/** What an agent sends to save how it did something (skill_save). */
const LEARNED = z.object({ name: NAME, description: z.string().trim().max(200).default(""), content: z.string().trim().min(1).max(20_000), slug: z.string().trim().min(1).max(60).optional() }).strict();

/**
 * Connectors (MCP servers and secrets agents use) and the skill shop (SKILL.md instructions agents
 * follow). Anyone in the workspace can look; guests can't change anything. Secret values never
 * come back out: they're masked on read, and sending a masked value back keeps the saved one.
 */
export function registerConnectorApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, connectors, skills } = hub;
  const { need, parse, commitAuthor } = h;
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
  const changed = (c: Caller) => hub.broadcast(c.workspaceId, { type: "skills_changed" });

  // --- connectors -------------------------------------------------------------------------------

  app.get("/api/connectors", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return connectors.list(c.workspaceId).map((conn) => withWarnings(conn.id));
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

  app.post("/api/connectors/:id/signin", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    const body = parse(z.object({ origin: URL_ }), req.body, reply);
    if (!body) return;
    const url = connectors.serverUrl(conn.id);
    if (!url) return reply.code(400).send({ error: "only remote MCP servers can be signed in to" });
    try {
      const to = await connectors.auth.start(conn.id, url, new URL(body.origin).origin, c.actor.id);
      return to ? { url: to } : { signedIn: true };
    } catch (e) {
      return reply.code(502).send({ error: `${conn.name} didn't offer a way to sign in: ${(e as Error).message}` });
    }
  });

  /** Where the sign-in page sends the browser back. No Wisp token here: the state ties it to the sign-in that started it. */
  app.get(CALLBACK_PATH, async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
    const back = (msg?: string) => reply.redirect(`/?signin=${msg ? encodeURIComponent(msg) : "ok"}#/connectors`);
    if (q.error) return back(q.error_description || q.error);
    if (!q.state || !q.code) return back("the sign-in page didn't send a code back");
    try {
      await connectors.auth.finish(q.state, q.code, (id) => connectors.serverUrl(id));
      return back();
    } catch (e) {
      return back((e as Error).message);
    }
  });

  app.post("/api/connectors/:id/signout", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
    connectors.auth.signOut(conn.id);
    return connectors.get(conn.id);
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
    if (body.allAgents !== undefined && body.allAgents !== conn.allAgents && conn.createdBy !== c.actor.id && store.role(c.workspaceId, c.actor.id) !== "owner")
      return reply.code(403).send({ error: "Only the person who added this connector, or the workspace owner, can turn All agents on or off" });
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
    changed(c);
    return withWarnings(conn.id);
  });

  app.delete("/api/connectors/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const conn = ownConnector(c, req, reply);
    if (!conn) return;
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
      // not a name "/" already uses for this agent: Wisp's commands, or its harness's own
      const reserved = [...WISP_COMMANDS.map((w) => w.name), ...(hub.catalogFor(agent)?.commands ?? []).map((x) => x.name)];
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
    if (!agentIds) return;
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
    if (!s) return;
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
        if (!ids) return;
        skills.attach(s.id, ids[0], method === "PUT");
        // with "All agents" on, the agent keeps it (and its file) either way
        await syncFiles(c, s, ids, method === "PUT" || s.allAgents);
        changed(c);
        return skills.get(s.id);
      },
    });
  }
}
