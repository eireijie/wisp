import type { FastifyReply, FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ACCOUNT_ID, HarnessAccountOp, HarnessSettingsChange, SETTINGS_HARNESSES, describeChange, harnessLabel, type HarnessSettings, type HarnessSkillFile } from "@warren/core";
import type { Caller } from "./api.ts";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const HARNESS = z.enum(SETTINGS_HARNESSES);
const CHANGES = z.object({ changes: z.array(HarnessSettingsChange).min(1).max(20), account: ACCOUNT_ID.optional() });
const ACCOUNT_QUERY = z.object({ harness: HARNESS.optional(), account: ACCOUNT_ID.optional() });

/**
 * Harness settings: a harness's own model, provider, apps, plugins and skills on a device, from
 * Settings → Harnesses or from an agent asked in chat. The files are on the device, so only the
 * person who connected it reads or changes them (sharing a device lends its agents, not its config).
 */
export function registerHarnessSettingsApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse } = h;

  const ask = async <T>(nodeId: string, reply: FastifyReply, build: (requestId: string) => Parameters<Hub["sendToNode"]>[1], timeoutMs = 20_000): Promise<T | undefined> => {
    try {
      return (await hub.computers.nodeRequest(nodeId, build, timeoutMs)) as T;
    } catch (err) {
      if (err instanceof ComputerError) return void reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };

  /** Your own device, online. */
  const myDevice = (c: Caller, nodeId: string, reply: FastifyReply) => {
    const n = store.node(nodeId);
    if (!n || n.workspaceId !== c.workspaceId) return void reply.code(404).send({ error: "device not found" });
    if (n.ownerId !== c.actor.id) return void reply.code(403).send({ error: `only the person who connected ${n.name} can see or change its harness settings` });
    if (!hub.isNodeOnline(n.id)) return void reply.code(503).send({ error: `${n.name} is offline` });
    return n;
  };

  /** Which agents use each harness on the device, for "used by" and the "Ask … to change" box. */
  const agentsOn = (nodeId: string) => store.agentsOnNode(nodeId).map((a) => ({ id: a.id, handle: a.handle, name: a.name, harness: a.harness }));

  app.get("/api/nodes/:id/harness-settings", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const n = myDevice(c, (req.params as { id: string }).id, reply);
    if (!n) return;
    const q = parse(ACCOUNT_QUERY, req.query, reply);
    if (!q) return;
    // one harness can be shown as another of its accounts
    const harnesses = await ask<HarnessSettings[]>(n.id, reply, (requestId) => ({ type: "harness_settings", requestId, ...(q.harness && q.account ? { harness: q.harness, account: q.account } : {}) }));
    if (!harnesses) return;
    return { device: { id: n.id, name: n.name }, harnesses, agents: agentsOn(n.id), catalog: store.nodeCatalog(n.id) };
  });

  app.patch("/api/nodes/:id/harness-settings/:harness", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const p = req.params as { id: string; harness: string };
    const n = myDevice(c, p.id, reply);
    if (!n) return;
    const harness = parse(HARNESS, p.harness, reply);
    const body = parse(CHANGES, req.body, reply);
    if (!harness || !body) return;
    return ask<HarnessSettings>(n.id, reply, (requestId) => ({ type: "harness_settings_change", requestId, harness, account: body.account, changes: body.changes }));
  });

  /** A harness's accounts on the device: add, rename, forget, sign in, and which agent uses which. */
  app.post("/api/nodes/:id/harness-accounts/:harness", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const p = req.params as { id: string; harness: string };
    const n = myDevice(c, p.id, reply);
    if (!n) return;
    const harness = parse(HARNESS, p.harness, reply);
    const action = parse(HarnessAccountOp, req.body, reply);
    if (!harness || !action) return;
    if (action.op === "assign") {
      const agent = store.agent(action.agentId);
      if (!agent || agent.nodeId !== n.id || agent.harness !== harness) return reply.code(400).send({ error: `that agent doesn't use ${harnessLabel(harness)} on ${n.name}` });
    }
    // a sign-in can wait on a person typing a code, but each step answers right away
    return ask<unknown>(n.id, reply, (requestId) => ({ type: "harness_account", requestId, harness, action }), 30_000);
  });

  /** One of a harness's skills, to add it to Warren's skills and give it to other agents. */
  app.get("/api/nodes/:id/harness-settings/:harness/skills/:skill", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const p = req.params as { id: string; harness: string; skill: string };
    const n = myDevice(c, p.id, reply);
    if (!n) return;
    const harness = parse(HARNESS, p.harness, reply);
    if (!harness) return;
    const q = parse(ACCOUNT_QUERY, req.query, reply);
    if (!q) return;
    return ask<HarnessSkillFile>(n.id, reply, (requestId) => ({ type: "harness_skill", requestId, harness, account: q.account, id: p.skill }));
  });

  /** Open the config file in the device's editor (for someone sitting at it). */
  app.post("/api/nodes/:id/harness-settings/:harness/open", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const p = req.params as { id: string; harness: string };
    const n = myDevice(c, p.id, reply);
    if (!n) return;
    const harness = parse(HARNESS, p.harness, reply);
    if (!harness) return;
    const q = parse(ACCOUNT_QUERY, req.query, reply);
    if (!q) return;
    return ask<{ path: string }>(n.id, reply, (requestId) => ({ type: "harness_open_config", requestId, harness, account: q.account }));
  });

  // --- for agents (warren-mcp's harness_settings tools) -------------------------------------------

  /** The agent's own device, and the harness it means (its own unless it names another there). */
  const agentDevice = (c: Caller, reply: FastifyReply, harnessParam: string | undefined) => {
    const agent = c.actor.kind === "agent" ? store.agent(c.actor.id) : undefined;
    if (!agent) return void reply.code(403).send({ error: "agents only" });
    const n = agent.nodeId ? store.node(agent.nodeId) : undefined;
    if (!n) return void reply.code(409).send({ error: "you don't run on a device Warren starts you on, so there are no harness settings to change from here" });
    if (!hub.isNodeOnline(n.id)) return void reply.code(503).send({ error: `${n.name} is offline` });
    const harness = HARNESS.safeParse(harnessParam ?? agent.harness);
    if (!harness.success) return void reply.code(400).send({ error: `Warren can change the settings of ${SETTINGS_HARNESSES.map(harnessLabel).join(", ")}; not ${harnessLabel(harnessParam ?? agent.harness)}` });
    return { agent, node: n, harness: harness.data };
  };

  /** The settings an agent's harness runs with: those of the account it uses (for its own harness). */
  const agentSettings = async (a: NonNullable<ReturnType<typeof agentDevice>>, reply: FastifyReply) => {
    const first = await ask<HarnessSettings[]>(a.node.id, reply, (requestId) => ({ type: "harness_settings", requestId, harness: a.harness }));
    if (!first) return;
    const account = a.harness === a.agent.harness ? (first[0]?.agentAccounts[a.agent.id] ?? "default") : "default";
    if (account === "default") return first[0];
    return (await ask<HarnessSettings[]>(a.node.id, reply, (requestId) => ({ type: "harness_settings", requestId, harness: a.harness, account })))?.[0];
  };

  app.get("/api/agent/harness-settings", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const a = agentDevice(c, reply, (req.query as { harness?: string }).harness);
    if (!a) return;
    const current = await agentSettings(a, reply);
    if (!current) return;
    const list = [current];
    const models = store.nodeCatalog(a.node.id).find((x) => x.harness === a.harness)?.models.map((m) => m.id) ?? [];
    return { device: a.node.name, ...list[0], models };
  });

  /**
   * An agent changes a harness's settings on its device for the device's owner: only while working
   * on something the owner asked for, so nobody else can talk an agent into changing it.
   */
  app.patch("/api/agent/harness-settings", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(
      z.object({ harness: z.string().max(60).optional(), changes: z.array(HarnessSettingsChange).max(20).default([]), useAccount: z.string().max(80).optional() }).refine((b) => b.changes.length || b.useAccount, "nothing to change"),
      req.body,
      reply,
    );
    if (!body) return;
    const a = agentDevice(c, reply, body.harness);
    if (!a) return;
    const owner = a.node.ownerId ? (store.user(a.node.ownerId)?.name ?? "its owner") : "its owner";
    const askedBy = hub.currentRun(a.agent.id)?.requestedBy ?? null;
    if (!a.node.ownerId || askedBy !== a.node.ownerId)
      return reply.code(403).send({ error: `Only ${owner} can change ${harnessLabel(a.harness)}'s settings on ${a.node.name}. Tell whoever asked that ${owner} has to ask for it, or change it in Settings → Harnesses.` });
    const changed = body.changes.map(describeChange);
    const current = await agentSettings(a, reply);
    if (!current) return;
    let account = current.account;
    // "use my work account": the agent moves itself to another of the harness's accounts here
    if (body.useAccount) {
      if (a.harness !== a.agent.harness) return reply.code(400).send({ error: "you can only change which account your own harness uses" });
      const want = body.useAccount.toLowerCase();
      const pick = current.accounts.find((x) => x.id === want || x.label.toLowerCase() === want);
      if (!pick) return reply.code(400).send({ error: `${harnessLabel(a.harness)} on ${a.node.name} has no account "${body.useAccount}". It has: ${current.accounts.map((x) => x.label).join(", ")}` });
      const ok = await ask(a.node.id, reply, (requestId) => ({ type: "harness_account", requestId, harness: a.harness, action: { op: "assign", agentId: a.agent.id, account: pick.isDefault ? null : pick.id } }));
      if (!ok) return;
      account = pick.id;
      changed.push(`now uses the ${pick.label} account`);
    }
    const settings = body.changes.length ? await ask<HarnessSettings>(a.node.id, reply, (requestId) => ({ type: "harness_settings_change", requestId, harness: a.harness, account, changes: body.changes })) : (await ask<HarnessSettings[]>(a.node.id, reply, (requestId) => ({ type: "harness_settings", requestId, harness: a.harness, account })))?.[0];
    if (!settings) return;
    return { device: a.node.name, changed, ...settings };
  });
}
