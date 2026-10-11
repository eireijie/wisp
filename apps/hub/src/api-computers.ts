import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ComputerAction, DEVICE_HARNESS, HARNESS_IDS, parseCron, soulPath, soulTemplate, type Computer, type DiscoveredAgent, type RecordedStep } from "@warren/core";
import type { Caller } from "./api.ts";
import { ComputerError } from "./computers.ts";
import { OrgoClient, OrgoError } from "./orgo.ts";
import { routineSlug } from "./routines.ts";
import type { Hub } from "./hub.ts";

export const HARNESS = z.union([z.enum(HARNESS_IDS as [string, ...string[]]), z.string().regex(DEVICE_HARNESS, 'a known harness, or "acp:<name>" declared on a device')]);

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  commitAuthor(c: Caller): { name: string; email: string };
  agentView(a: NonNullable<ReturnType<Hub["store"]["agent"]>>): unknown;
}

const NAME = z.string().trim().min(1).max(80);
const TIMEZONE = z.string().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown time zone");
const SCHEDULE = z
  .string()
  .max(120)
  .refine((s) => {
    try {
      parseCron(s);
      return true;
    } catch {
      return false;
    }
  }, "not a valid schedule (five fields: minute hour day month weekday)");
const STEP = z.object({
  at: z.number().int().min(0).max(24 * 3600_000),
  kind: z.enum(["click", "double_click", "right_click", "drag", "scroll", "type", "key", "note"]),
  x: z.number().min(0).max(100_000).optional(),
  y: z.number().min(0).max(100_000).optional(),
  toX: z.number().min(0).max(100_000).optional(),
  toY: z.number().min(0).max(100_000).optional(),
  text: z.string().max(5000).optional(),
  keys: z.string().max(100).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  imageFileId: z.string().max(100).optional(),
});

const WARREN = { name: "Warren", email: "warren@localhost" };

/**
 * Routes for computers (devices' screens, VMs, Orgo), approvals, routines, harness settings and
 * importing agents that already exist on a device.
 */
export function registerComputerApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, vault, computers } = hub;
  const { need, parse } = h;

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ComputerError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof OrgoError) return reply.code(err.status === 401 || err.status === 403 ? 400 : 502).send({ error: err.message });
    throw err;
  };

  const own = (c: Caller, computerId: string): Computer | null => {
    const comp = store.computer(computerId);
    return comp && comp.workspaceId === c.workspaceId ? comp : null;
  };

  const startInBackground = (comp: Computer) => {
    if (comp.kind === "device") return;
    store.updateComputer(comp.id, { status: "starting", statusText: comp.kind === "vm" ? "Setting up the VM…" : "Starting…" });
    computers.changed(comp.id);
    computers.act(comp, { action: "start" }, { kind: "user", id: "system" }).then(
      () => {
        store.updateComputer(comp.id, { status: "ready", statusText: "" });
        computers.changed(comp.id);
      },
      (err) => {
        store.updateComputer(comp.id, { status: "error", statusText: (err as Error).message.slice(0, 500) });
        computers.changed(comp.id);
      },
    );
  };

  // --- computers ------------------------------------------------------------------------------

  app.get("/api/computers", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return store.computers(c.workspaceId).map((x) => computers.view(x));
  });

  app.get("/api/computers/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    return computers.view(comp);
  });

  app.post("/api/computers", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("device"), nodeId: z.string(), name: NAME.optional(), vncPort: z.number().int().min(1).max(65535).optional() }),
        z.object({
          kind: z.literal("vm"),
          nodeId: z.string(),
          name: NAME,
          resolution: z.string().regex(/^\d{3,5}x\d{3,5}$/).optional(),
          cpus: z.number().min(0.5).max(64).optional(),
          memoryGb: z.number().min(1).max(256).optional(),
          image: z.string().max(200).optional(),
        }),
        z.object({ kind: z.literal("orgo"), name: NAME, ram: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32)]).optional(), cpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(), computerId: z.string().uuid().optional() }),
      ]),
      req.body,
      reply,
    );
    if (!body) return;
    try {
      if (body.kind === "orgo") {
        if (body.computerId) {
          // connect a computer that already exists in the Orgo account
          const client = computers.orgo(c.workspaceId);
          if (!client) throw new ComputerError("add an Orgo API key in Settings → Computers first", 412);
          const found = await client.get(body.computerId);
          const comp = store.createComputer({ workspaceId: c.workspaceId, name: body.name, kind: "orgo", nodeId: null, config: { computerId: found.id, instanceId: found.instanceId ?? undefined } });
          computers.changed(comp.id);
          return computers.view(comp);
        }
        const comp = await computers.createOrgo(c.workspaceId, body.name, { ram: body.ram, cpu: body.cpu });
        computers.changed(comp.id);
        return computers.view(comp);
      }
      const node = store.node(body.nodeId);
      if (!node || node.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown device" });
      const caps = store.nodeCapabilities(node.id);
      if (body.kind === "device") {
        // one computer per device screen; asking again returns it
        const existing = store.computersOnNode(node.id).find((x) => x.kind === "device");
        if (existing) return computers.view(existing);
        const comp = store.createComputer({ workspaceId: c.workspaceId, name: body.name ?? node.name, kind: "device", nodeId: node.id, config: body.vncPort ? { vncPort: body.vncPort } : {}, statusText: caps && !caps.screen.ok ? caps.screen.detail : "" });
        computers.changed(comp.id);
        return computers.view(comp);
      }
      if (caps && !caps.vm.ok) return reply.code(400).send({ error: `${node.name} can't run VMs yet: ${caps.vm.detail}` });
      // a custom image runs whatever it contains on someone's device
      if (body.image && c.viewer.role !== "owner") return reply.code(403).send({ error: "only owners can choose a custom VM image" });
      const comp = store.createComputer({ workspaceId: c.workspaceId, name: body.name, kind: "vm", nodeId: node.id, config: { resolution: body.resolution, cpus: body.cpus, memoryGb: body.memoryGb, image: body.image }, status: "starting" });
      startInBackground(comp);
      return computers.view(store.computer(comp.id)!);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/api/computers/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    const body = parse(z.object({ name: NAME, vncPort: z.number().int().min(1).max(65535).nullable() }).partial(), req.body, reply);
    if (!body) return;
    const config = body.vncPort !== undefined && comp.kind === "device" ? { ...comp.config, vncPort: body.vncPort ?? undefined } : comp.config;
    store.updateComputer(comp.id, { name: body.name, config });
    computers.changed(comp.id);
    return computers.view(store.computer(comp.id)!);
  });

  app.delete("/api/computers/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    await computers.remove(comp);
    return { ok: true };
  });

  for (const op of ["start", "stop"] as const) {
    app.post(`/api/computers/:id/${op}`, async (req, reply) => {
      const c = need(req, reply, { member: true });
      if (!c) return;
      const comp = own(c, (req.params as { id: string }).id);
      if (!comp) return reply.code(404).send({ error: "computer not found" });
      if (op === "start") {
        startInBackground(comp);
        return computers.view(store.computer(comp.id)!);
      }
      try {
        await computers.act(comp, { action: "stop" }, c.actor);
        store.updateComputer(comp.id, { status: "stopped", statusText: "Stopped; it starts again when it's next used" });
        computers.changed(comp.id);
        return computers.view(store.computer(comp.id)!);
      } catch (err) {
        return fail(reply, err);
      }
    });
  }

  /** Take control of a computer (agents wait), or hand it back (an agent that asked for help is woken). */
  app.post("/api/computers/:id/control", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    const body = parse(z.object({ take: z.boolean(), note: z.string().max(2000).optional() }), req.body, reply);
    if (!body) return;
    try {
      if (body.take) computers.take(comp, c.actor.id);
      else computers.release(comp, c.actor.id, body.note);
      return computers.view(store.computer(comp.id)!);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** The screen right now, as a JPEG (thumbnails, the card in chat). */
  app.get("/api/computers/:id/screen", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    try {
      const maxAge = Math.min(60_000, Math.max(1000, Number((req.query as { maxAge?: string }).maxAge) || 5000));
      const f = await computers.latest(comp, maxAge);
      reply.header("content-type", "image/jpeg").header("cache-control", "no-store").header("x-frame-width", String(f.width)).header("x-frame-height", String(f.height));
      return reply.send(Buffer.from(f.image, "base64"));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** How to watch it live: a one-time link for the hub's relay, or Orgo's own address. */
  app.post("/api/computers/:id/view", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    try {
      if (comp.kind === "orgo") return { transport: "vnc", url: await computers.orgoVnc(comp), direct: true };
      if (!computers.online(comp)) return reply.code(503).send({ error: `${comp.name} is offline: its device isn't connected` });
      const transport = computers.transport(comp);
      return { transport, url: `/ws/computers/${comp.id}/${transport}?ticket=${computers.ticket(comp, c.actor.id)}`, direct: false };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Do one thing on the computer as a person (needs control). Live view uses its socket instead. */
  app.post("/api/computers/:id/act", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    const action = parse(ComputerAction, (req.body as { action?: unknown })?.action, reply);
    if (!action) return;
    try {
      return await computers.act(comp, action, c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- an agent's own computer ---------------------------------------------------------------------

  const myComputer = (c: Caller, reply: FastifyReply): Computer | null => {
    const agent = store.agent(c.actor.id);
    const comp = agent?.computerId ? store.computer(agent.computerId) : undefined;
    if (!comp) {
      reply.code(404).send({ error: "you don't have a computer; a person can give you one on your page in Warren (Agents → Computer)" });
      return null;
    }
    return comp;
  };

  app.get("/api/computers/mine", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const comp = myComputer(c, reply);
    return comp ? computers.view(comp) : undefined;
  });

  app.post("/api/computers/mine/act", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const comp = myComputer(c, reply);
    if (!comp) return;
    const action = parse(ComputerAction, (req.body as { action?: unknown })?.action, reply);
    if (!action) return;
    if (["destroy", "stop"].includes(action.action)) return reply.code(403).send({ error: "only people can stop or remove a computer" });
    try {
      return await computers.act(comp, action, c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/computers/mine/help", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const comp = myComputer(c, reply);
    if (!comp) return;
    const body = parse(z.object({ request: z.string().trim().min(1).max(2000) }), req.body, reply);
    if (!body) return;
    const where = hub.whereIs(c.actor.id);
    if (!where) return reply.code(409).send({ error: "nobody to ask: this workspace has no owner" });
    const msg = computers.requestHelp(comp, c.actor.id, body.request, where);
    return { ok: true, messageId: msg.id };
  });

  // --- approvals ------------------------------------------------------------------------------

  app.post("/api/approvals", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents ask for approval; people give it" });
    const body = parse(z.object({ summary: z.string().trim().min(1).max(300), details: z.string().max(20_000).default("") }), req.body, reply);
    if (!body) return;
    const where = hub.whereIs(c.actor.id);
    if (!where) return reply.code(409).send({ error: "nobody to ask: this workspace has no owner" });
    const approval = store.createApproval({ workspaceId: c.workspaceId, agentId: c.actor.id, ...where, ...body });
    hub.postMessage({ ...where, author: c.actor, body: `Can I go ahead? ${body.summary}`, parts: [{ type: "approval", approvalId: approval.id }], route: false });
    hub.broadcast(c.workspaceId, { type: "approval", approval });
    return approval;
  });

  app.get("/api/approvals", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const status = (req.query as { status?: string }).status;
    return store.approvals(c.workspaceId, status === "pending" || status === "approved" || status === "denied" ? status : undefined);
  });

  app.get("/api/approvals/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const a = store.approval((req.params as { id: string }).id);
    if (!a || a.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "not found" });
    return a;
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const a = store.approval((req.params as { id: string }).id);
    if (!a || a.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "not found" });
    const body = parse(z.object({ approve: z.boolean(), note: z.string().max(4000).default("") }), req.body, reply);
    if (!body) return;
    if (a.status !== "pending") return reply.code(409).send({ error: `already ${a.status}` });
    const decided = store.decideApproval(a.id, body.approve ? "approved" : "denied", c.actor.id, body.note)!;
    hub.broadcast(c.workspaceId, { type: "approval", approval: decided });
    const agent = store.agent(a.agentId);
    if (agent && store.channel(a.channelId)) {
      const verdict = body.approve ? `Approved: go ahead with "${a.summary}".` : `Don't do "${a.summary}".`;
      hub.postMessage({ channelId: a.channelId, threadId: a.threadId, author: c.actor, body: `@${agent.handle} ${verdict}${body.note.trim() ? ` ${body.note.trim()}` : ""}` });
    }
    return decided;
  });

  // --- routines -------------------------------------------------------------------------------

  const routineFor = (c: Caller, routineId: string, reply: FastifyReply) => {
    const r = store.routine(routineId);
    if (!r || r.workspaceId !== c.workspaceId || (c.actor.kind === "agent" && r.agentId !== c.actor.id)) {
      reply.code(404).send({ error: "routine not found" });
      return null;
    }
    return r;
  };

  app.get("/api/routines", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const agentId = c.actor.kind === "agent" ? c.actor.id : (req.query as { agent?: string }).agent;
    return store.routines(c.workspaceId, agentId || undefined);
  });

  /** People write a routine's steps themselves (or agents save what they learned: see /save). */
  app.post("/api/routines", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ agentId: z.string(), name: NAME, steps: z.string().max(50_000), schedule: SCHEDULE.nullable().default(null), timezone: TIMEZONE.default("UTC"), channelId: z.string().nullable().default(null) }), req.body, reply);
    if (!body) return;
    const agent = store.agent(body.agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown agent" });
    if (body.channelId && store.channel(body.channelId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown channel" });
    const notePath = `agents/${agent.id}/routines/${routineSlug(body.name)}-${Date.now().toString(36)}.md`;
    await vault.write(notePath, body.steps.trim().startsWith("#") ? body.steps : `# ${body.name}\n\n${body.steps}\n`, h.commitAuthor(c), `Routine "${body.name}" for @${agent.handle}`);
    const r = store.createRoutine({ workspaceId: c.workspaceId, agentId: agent.id, name: body.name, notePath, schedule: body.schedule, timezone: body.timezone, channelId: body.channelId, status: "ready", createdBy: c.actor });
    hub.broadcast(c.workspaceId, { type: "routines_changed" });
    return r;
  });

  app.patch("/api/routines/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const r = routineFor(c, (req.params as { id: string }).id, reply);
    if (!r) return;
    const body = parse(z.object({ name: NAME, schedule: SCHEDULE.nullable(), timezone: TIMEZONE, channelId: z.string().nullable(), enabled: z.boolean() }).partial(), req.body, reply);
    if (!body) return;
    if (body.channelId && store.channel(body.channelId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown channel" });
    const updated = store.updateRoutine(r.id, body);
    hub.broadcast(c.workspaceId, { type: "routines_changed" });
    return updated;
  });

  app.delete("/api/routines/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const r = routineFor(c, (req.params as { id: string }).id, reply);
    if (!r) return;
    store.deleteRoutine(r.id);
    hub.broadcast(c.workspaceId, { type: "routines_changed" });
    return { ok: true };
  });

  app.post("/api/routines/:id/run", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind === "user" && c.viewer.role === "guest") return reply.code(403).send({ error: "guests can't run routines" });
    const r = routineFor(c, (req.params as { id: string }).id, reply);
    if (!r) return;
    if (r.status !== "ready") return reply.code(409).send({ error: "the agent is still learning this one" });
    const msg = hub.routines.run(r, c.actor);
    if (!msg) return reply.code(409).send({ error: "no channel to run it in" });
    return { ok: true, messageId: msg.id, channelId: msg.channelId };
  });

  /** "Show a Bot how it's done": a person's recording becomes a routine the agent learns. */
  app.post("/api/routines/teach", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ agentId: z.string(), name: NAME, computerId: z.string().nullable().default(null), steps: z.array(STEP).min(1).max(500), durationMs: z.number().int().min(0).max(24 * 3600_000), narration: z.string().max(10_000).optional() }), req.body, reply);
    if (!body) return;
    const agent = store.agent(body.agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown agent" });
    if (body.computerId && !own(c, body.computerId)) return reply.code(400).send({ error: "unknown computer" });
    for (const s of body.steps) if (s.imageFileId && store.file(s.imageFileId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown screenshot file" });
    const r = await hub.routines.teach({ workspaceId: c.workspaceId, agentId: agent.id, userId: c.actor.id, name: body.name, computerId: body.computerId, steps: body.steps as RecordedStep[], durationMs: body.durationMs, narration: body.narration });
    return r;
  });

  /** An agent saves the steps of a routine it learned (or a new one it was asked to keep). */
  app.post("/api/routines/save", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only; people use PATCH /api/routines/:id" });
    const body = parse(z.object({ routineId: z.string().optional(), name: NAME.optional(), steps: z.string().min(1).max(50_000), schedule: SCHEDULE.nullable().optional(), timezone: TIMEZONE.optional() }), req.body, reply);
    if (!body) return;
    const agent = store.agent(c.actor.id)!;
    let r = body.routineId ? routineFor(c, body.routineId, reply) : null;
    if (body.routineId && !r) return;
    if (!r && !body.name) return reply.code(400).send({ error: "name a new routine" });
    const notePath = r?.notePath ?? `agents/${agent.id}/routines/${routineSlug(body.name!)}-${Date.now().toString(36)}.md`;
    const name = body.name ?? r!.name;
    await vault.write(notePath, body.steps.trim().startsWith("#") ? body.steps : `# ${name}\n\n${body.steps}\n`, { name: `@${agent.handle}`, email: `${agent.handle}@agents.warren` }, `Routine "${name}"`);
    if (r) r = store.updateRoutine(r.id, { name, status: "ready", ...(body.schedule !== undefined ? { schedule: body.schedule } : {}), ...(body.timezone ? { timezone: body.timezone } : {}) })!;
    else r = store.createRoutine({ workspaceId: c.workspaceId, agentId: agent.id, name, notePath, schedule: body.schedule ?? null, timezone: body.timezone ?? "UTC", channelId: null, status: "ready", createdBy: c.actor });
    hub.broadcast(c.workspaceId, { type: "routines_changed" });
    return r;
  });

  // --- settings -------------------------------------------------------------------------------

  app.get("/api/settings/computers", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const key = store.setting(c.workspaceId, "orgo.apiKey");
    return { orgo: { configured: !!key, hint: key ? `…${key.slice(-4)}` : null } };
  });

  app.put("/api/settings/computers", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ orgoApiKey: z.string().trim().max(300).nullable() }), req.body, reply);
    if (!body) return;
    if (body.orgoApiKey) {
      // check the key before saving it
      try {
        await new OrgoClient(body.orgoApiKey, hub.fetchImpl).request("GET", "/workspaces", undefined, 20_000);
      } catch (err) {
        return reply.code(400).send({ error: `Orgo didn't accept that key: ${(err as Error).message}` });
      }
    }
    store.setSetting(c.workspaceId, "orgo.apiKey", body.orgoApiKey || null);
    for (const comp of store.computers(c.workspaceId).filter((x) => x.kind === "orgo")) computers.changed(comp.id);
    return { orgo: { configured: !!body.orgoApiKey, hint: body.orgoApiKey ? `…${body.orgoApiKey.slice(-4)}` : null } };
  });

  // --- bringing in existing agents ---------------------------------------------------------------

  app.post("/api/nodes/:id/discover", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "device not found" });
    if (!hub.sendToNode(node.id, { type: "discover" })) return reply.code(503).send({ error: "the device is offline" });
    return { ok: true };
  });

  /** Make a Warren agent from one that already exists on a device: its soul, instructions and notes come along. */
  app.post("/api/agents/import", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(
      z.object({ nodeId: z.string(), key: z.string().max(200), handle: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), name: NAME.optional(), harness: HARNESS.optional(), computerId: z.string().nullable().default(null), headless: z.boolean().default(false) }),
      req.body,
      reply,
    );
    if (!body) return;
    const node = store.node(body.nodeId);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown device" });
    if (store.agentByHandle(c.workspaceId, body.handle)) return reply.code(409).send({ error: "handle taken" });
    if (body.computerId && !own(c, body.computerId)) return reply.code(400).send({ error: "unknown computer" });
    let found: DiscoveredAgent;
    try {
      found = (await computers.nodeRequest(node.id, (requestId) => ({ type: "read_agent", requestId, key: body.key }), 30_000)) as DiscoveredAgent;
    } catch (err) {
      return fail(reply, err);
    }
    const harness = body.harness ?? found.harness;
    const agent = store.createAgent({ workspaceId: c.workspaceId, handle: body.handle, name: body.name ?? found.name.slice(0, 80), harness, model: found.model ?? null, nodeId: node.id, computerId: body.computerId, instructions: (found.instructions ?? "").slice(0, 20_000) });
    if (body.headless) store.updateAgent(agent.id, { settings: { headless: true } });
    const general = store.channelByName(c.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "agent", id: agent.id });
    const author = h.commitAuthor(c);
    await vault.write(soulPath(agent.id), found.soul?.trim() ? found.soul : soulTemplate(agent.name, agent.handle), author, `Import @${agent.handle} from ${node.name}`);
    for (const m of found.memories ?? []) {
      const name = m.name.replace(/[^\w.-]+/g, "-").replace(/\.md$/i, "");
      await vault.write(`agents/${agent.id}/imported/${name}.md`, m.content, author, `Import ${m.name} for @${agent.handle}`);
    }
    return h.agentView(store.agent(agent.id)!);
  });
}
