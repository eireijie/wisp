import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ComputerAction, DEVICE_HARNESS, FileName, LOAN_MAX_MINUTES, MAX_TRANSFER_BYTES, activeLoan, HARNESS_IDS, parseCron, runsInVm, soulPath, soulTemplate, type Computer, type DiscoveredAgent, type FileData, type FolderListing, type RecordedStep } from "@warren/core";
import type { Caller } from "./api.ts";
import { ComputerError } from "./computers.ts";
import { OrgoClient, OrgoError } from "./orgo.ts";
import { routineSlug } from "./routines.ts";
import type { Hub } from "./hub.ts";
import { VM_SIZES, computerDefaults } from "./policy.ts";

export const HARNESS = z.union([z.enum(HARNESS_IDS as [string, ...string[]]), z.string().regex(DEVICE_HARNESS, 'a known harness, or "acp:<name>" declared on a device')]);

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  commitAuthor(c: Caller): { name: string; email: string };
  agentView(a: NonNullable<ReturnType<Hub["store"]["agent"]>>): unknown;
  /** the person a caller works for */
  requesterOf(c: Caller): string | null;
  /** the channel, when the caller may see it (DMs only for their members and owners) */
  channelVisible(c: Caller, channelId: string): unknown;
}

const NAME = z.string().trim().min(1).max(80);
/** A screen's code, passed straight to its device to check; Warren never keeps it. */
const SCREEN_CODE = z.string().min(1).max(200);
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
  element: z
    .object({ url: z.string().max(2000), title: z.string().max(300).optional(), role: z.string().max(40), name: z.string().max(200), selector: z.string().max(300).optional() })
    .optional(),
});

const WARREN = { name: "Warren", email: "warren@localhost" };

/**
 * Routes for computers (devices' screens, VMs, Orgo), approvals, routines, harness settings and
 * importing agents that already exist on a device.
 */
export function registerComputerApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store, computers } = hub;
  const { need, parse, channelVisible } = h;

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ComputerError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof OrgoError) return reply.code(err.status === 401 || err.status === 403 ? 400 : 502).send({ error: err.message });
    throw err;
  };

  /** The computer, if the caller may see it: someone else's own screen is as good as missing. */
  const own = (c: Caller, computerId: string): Computer | null => {
    const comp = store.computer(computerId);
    if (!comp || comp.workspaceId !== c.workspaceId) return null;
    if (c.actor.kind === "user" && !computers.canSee(comp, c.actor.id)) return null;
    return comp;
  };

  /** Removing a computer: a screen by its owner, a VM by its device's owner or a workspace owner. */
  const canRemove = (c: Caller, comp: Computer) => {
    if (comp.kind === "device") return computers.ownerOf(comp) === c.actor.id;
    if (comp.kind === "vm") return c.viewer.role === "owner" || (!!comp.nodeId && store.node(comp.nodeId)?.ownerId === c.actor.id);
    return true;
  };

  const startInBackground = (comp: Computer) => computers.startInBackground(comp);

  // --- computers ------------------------------------------------------------------------------

  app.get("/api/computers", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    return store
      .computers(c.workspaceId)
      .filter((x) => computers.canSee(x, c.actor.id))
      .map((x) => computers.view(x));
  });

  app.get("/api/computers/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
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
      const owner = node.ownerId ? (store.user(node.ownerId)?.name ?? "its owner") : "its owner";
      if (body.kind === "device") {
        if (node.ownerId !== c.actor.id) return reply.code(403).send({ error: `${node.name} is ${owner}'s device; only ${owner} can use its screen` });
        if (caps?.screen.off) return reply.code(400).send({ error: `${node.name}'s screen is off. Turn it on at the device itself: \`warren node screen on\`` });
        // one computer per device screen; asking again returns it
        const existing = store.computersOnNode(node.id).find((x) => x.kind === "device");
        if (existing) return computers.view(existing);
        const comp = store.createComputer({ workspaceId: c.workspaceId, name: body.name ?? node.name, kind: "device", nodeId: node.id, config: body.vncPort ? { vncPort: body.vncPort } : {}, statusText: caps && !caps.screen.ok ? caps.screen.detail : "" });
        computers.changed(comp.id);
        return computers.view(comp);
      }
      if (node.ownerId !== c.actor.id && !node.shared) return reply.code(403).send({ error: `${node.name} is ${owner}'s device; ask ${owner} to let others add VMs there (Devices)` });
      if (caps && !caps.vm.ok) return reply.code(400).send({ error: `${node.name} can't run VMs yet: ${caps.vm.detail}` });
      // a custom image runs whatever it contains on someone's device
      if (body.image && c.viewer.role !== "owner") return reply.code(403).send({ error: "only owners can choose a custom VM image" });
      // a size nobody picked is the workspace's default (Settings → Computers)
      const size = VM_SIZES[computerDefaults(hub, c.workspaceId).vmSize];
      const comp = store.createComputer({ workspaceId: c.workspaceId, name: body.name, kind: "vm", nodeId: node.id, config: { resolution: body.resolution, cpus: body.cpus ?? size.cpus, memoryGb: body.memoryGb ?? size.memoryGb, image: body.image }, status: "starting" });
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
    if (!canRemove(c, comp)) return reply.code(403).send({ error: "only its device's owner or a workspace owner can delete this VM" });
    await computers.remove(comp);
    return { ok: true };
  });

  /** Lend your own screen to agents (for `minutes`, or until you stop with null), or stop lending it. */
  app.post("/api/computers/:id/lend", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    if (comp.kind !== "device") return reply.code(400).send({ error: "only a device's own screen is lent; agents can always use VMs and cloud computers" });
    const body = parse(z.union([z.object({ off: z.literal(true) }), z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).nullable(), code: SCREEN_CODE.optional() })]), req.body, reply);
    if (!body) return;
    try {
      await computers.lend(comp, c.actor.id, "off" in body ? false : body.minutes, "code" in body ? body.code : undefined);
    } catch (err) {
      return fail(reply, err);
    }
    return computers.view(store.computer(comp.id)!);
  });

  /** What people and agents did on a computer, newest first. */
  app.get("/api/computers/:id/log", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    return store.computerLog(comp.id);
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
    const c = need(req, reply, { member: true });
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

  /** How to watch it live: a one-time link for the hub's relay (through the device, or to Orgo with the hub signing in). */
  app.post("/api/computers/:id/view", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    const body = parse(z.object({ code: SCREEN_CODE.optional() }), req.body ?? {}, reply);
    if (!body) return;
    try {
      if (!computers.online(comp)) return reply.code(503).send({ error: comp.kind === "orgo" ? "add an Orgo API key in Settings → Computers first" : `${comp.name} is offline: its device isn't connected` });
      const transport = computers.transport(comp);
      return { transport, url: `/ws/computers/${comp.id}/${transport}?ticket=${await computers.ticket(comp, c.actor.id, body.code)}`, direct: false };
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

  // --- clipboard and files: keeping a computer in step with your device -------------------------------

  /** A computer people may move things to and from (members; a device's screen: its owner, see `own`). */
  const transferTarget = (req: FastifyRequest, reply: FastifyReply): { c: Caller; comp: Computer } | null => {
    const c = need(req, reply, { member: true });
    if (!c) return null;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) {
      reply.code(404).send({ error: "computer not found" });
      return null;
    }
    return { c, comp };
  };

  app.get("/api/computers/:id/clipboard", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    try {
      return await computers.act(t.comp, { action: "clipboard_get" }, t.c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put("/api/computers/:id/clipboard", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    const body = parse(z.object({ text: z.string().max(1_000_000) }), req.body, reply);
    if (!body) return;
    try {
      return await computers.act(t.comp, { action: "clipboard_set", text: body.text }, t.c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** What's in a folder on the computer (`?path=`, default its home folder). */
  app.get("/api/computers/:id/files", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    const path = (req.query as { path?: string }).path;
    try {
      return (await computers.act(t.comp, { action: "files_list", path: path ? path.slice(0, 4000) : undefined }, t.c.actor)) as FolderListing;
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A file from the computer, as a download. */
  app.get("/api/computers/:id/files/download", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    const path = (req.query as { path?: string }).path;
    if (!path) return reply.code(400).send({ error: "which file? (?path=)" });
    try {
      const f = (await computers.act(t.comp, { action: "file_read", path: path.slice(0, 4000) }, t.c.actor)) as FileData;
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
        .header("cache-control", "no-store")
        .send(Buffer.from(f.data, "base64"));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Put a file on the computer: the body is the file (application/octet-stream), `?folder=` where, X-Filename its name. */
  app.post("/api/computers/:id/files", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf)) return reply.code(400).send({ error: "send the file as application/octet-stream" });
    if (buf.length > MAX_TRANSFER_BYTES) return reply.code(413).send({ error: `files bigger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB can't be sent to a computer` });
    let raw = String(req.headers["x-filename"] ?? "");
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    const name = FileName.safeParse(raw.trim());
    if (!name.success) return reply.code(400).send({ error: `bad file name: ${name.error.issues[0]?.message}` });
    const folder = String((req.query as { folder?: string }).folder ?? "~").slice(0, 4000);
    try {
      return await computers.act(t.comp, { action: "file_write", folder, name: name.data, data: buf.toString("base64") }, t.c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/computers/:id/files/folder", async (req, reply) => {
    const t = transferTarget(req, reply);
    if (!t) return;
    const body = parse(z.object({ folder: z.string().max(4000), name: FileName }), req.body, reply);
    if (!body) return;
    try {
      return await computers.act(t.comp, { action: "file_mkdir", folder: body.folder, name: body.name }, t.c.actor);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- where an agent's harness runs ----------------------------------------------------------------

  /** Whether the agent runs inside its computer, and if so whether its harness is signed in there. */
  app.get("/api/agents/:id/harness", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    if (c.viewer.role === "guest") return { possible: false, inComputer: false, signedIn: null, computerId: null };
    const comp = agent.computerId ? store.computer(agent.computerId) : undefined;
    const possible = !!comp && comp.kind === "vm" && comp.nodeId === agent.nodeId && runsInVm(agent.harness);
    const inComputer = hub.runsInComputer(agent);
    let signedIn: boolean | null = null;
    // only ask a VM that's running; looking at the page shouldn't start one
    if (inComputer && comp && computers.online(comp) && comp.status === "ready") {
      try {
        signedIn = ((await computers.act(comp, { action: "harness_status", harness: agent.harness }, { kind: "user", id: "system" }, { timeoutMs: 120_000 })) as { signedIn: boolean | null }).signedIn;
      } catch {}
    }
    return { possible, inComputer, signedIn, computerId: comp?.id ?? null };
  });

  /** Open a sign-in for the agent's harness on its VM's screen, and give the caller control to finish it. */
  app.post("/api/agents/:id/signin", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const comp = agent.computerId ? own(c, agent.computerId) : null;
    if (!comp || comp.kind !== "vm") return reply.code(400).send({ error: "it needs a VM to sign in on" });
    try {
      await computers.act(comp, { action: "signin", harness: agent.harness }, { kind: "user", id: "system" }, { timeoutMs: 10 * 60_000 });
      computers.take(comp, c.actor.id);
      return { computerId: comp.id };
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
    // `computer` names a device the agent is borrowing; without it the action is on its own computer
    const borrowed = (req.body as { computer?: unknown })?.computer;
    let comp: Computer | null;
    if (typeof borrowed === "string" && borrowed.trim() && !/^(mine|my vm|my computer)$/i.test(borrowed.trim())) {
      const want = borrowed.trim().toLowerCase();
      const own = store.agent(c.actor.id)?.computerId;
      comp = store.computers(c.workspaceId).find((x) => x.kind === "device" && (x.id === borrowed || x.name.toLowerCase() === want) && (x.config as { loan?: { agentId: string } }).loan?.agentId === c.actor.id && x.id !== own) ?? null;
      if (!comp) return reply.code(403).send({ error: `You aren't borrowing "${borrowed}". Ask its owner with device_request (it may also have run out or been taken back); leave the computer argument out to use your own computer.` });
    } else {
      comp = myComputer(c, reply);
      if (!comp) return;
    }
    const action = parse(ComputerAction, (req.body as { action?: unknown })?.action, reply);
    if (!action) return;
    if (["destroy", "stop", "signin"].includes(action.action)) return reply.code(403).send({ error: action.action === "signin" ? "people sign harnesses in; use computer_ask_human" : "only people can stop or remove a computer" });
    try {
      return await computers.act(comp, action, c.actor, { requester: h.requesterOf(c) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- borrowing a device -----------------------------------------------------------------------

  /** Devices this agent could ask to borrow, and whether each can be asked right now. */
  app.get("/api/computers/borrowable", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    return computers.borrowable(c.workspaceId, c.actor.id);
  });

  /** An agent asks to use a device's screen; the device's owner gets an Approve / Deny card. */
  app.post("/api/computers/loans", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents ask to borrow a device; people lend it on the Computers page" });
    const body = parse(z.object({ device: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000) }), req.body, reply);
    if (!body) return;
    try {
      const approval = computers.requestLoan(c.workspaceId, c.actor.id, body.device, body.reason);
      return { ok: true, approvalId: approval.id, deviceName: approval.loan!.deviceName };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** An agent hands a borrowed device back. */
  app.post("/api/computers/loans/return", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(z.object({ device: z.string().max(200).optional() }), req.body ?? {}, reply);
    if (!body) return;
    try {
      return { ok: true, deviceName: computers.returnLoan(c.workspaceId, c.actor.id, body.device).name };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** The owner takes the device back from the agent borrowing it. */
  app.post("/api/computers/:id/loan/end", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const comp = own(c, (req.params as { id: string }).id);
    if (!comp) return reply.code(404).send({ error: "computer not found" });
    if (!activeLoan(comp)) return reply.code(409).send({ error: "nobody is borrowing it" });
    computers.endLoan(comp, "taken back", c.actor);
    return computers.view(store.computer(comp.id)!);
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
    hub.broadcast(c.workspaceId, { type: "approval", approval }, hub.audience(approval.channelId));
    return approval;
  });

  /** An approval is part of the conversation it was asked in: only people who can see that see it. */
  const canSeeApproval = (c: Caller, a: { workspaceId: string; channelId: string }) => a.workspaceId === c.workspaceId && !!channelVisible(c, a.channelId);

  app.get("/api/approvals", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const status = (req.query as { status?: string }).status;
    return store.approvals(c.workspaceId, status === "pending" || status === "approved" || status === "denied" ? status : undefined).filter((a) => canSeeApproval(c, a));
  });

  app.get("/api/approvals/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const a = store.approval((req.params as { id: string }).id);
    if (!a || !canSeeApproval(c, a)) return reply.code(404).send({ error: "not found" });
    return a;
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const a = store.approval((req.params as { id: string }).id);
    if (!a || !canSeeApproval(c, a)) return reply.code(404).send({ error: "not found" });
    const body = parse(z.object({ approve: z.boolean(), note: z.string().max(4000).default(""), minutes: z.number().int().min(1).max(LOAN_MAX_MINUTES).nullable().optional(), code: SCREEN_CODE.optional() }), req.body, reply);
    if (!body) return;
    if (a.status !== "pending") return reply.code(409).send({ error: `already ${a.status}` });
    const agent = store.agent(a.agentId);
    const note = body.note.trim() ? ` ${body.note.trim()}` : "";
    if (a.loan) {
      // lending a device is its owner's call alone
      const owner = store.user(a.loan.ownerId)?.name ?? "its owner";
      if (c.actor.id !== a.loan.ownerId) return reply.code(403).send({ error: `Only ${owner} can lend ${a.loan.deviceName}` });
      let verdict: string;
      if (body.approve) {
        try {
          const loan = await computers.startLoan(a, c.actor.id, body.minutes === undefined ? 60 : body.minutes, body.code);
          const mins = Math.round((new Date(loan.until).getTime() - Date.now()) / 60_000);
          verdict = `Approved: you can use "${a.loan.deviceName}" for ${mins >= 60 && mins % 60 === 0 ? `${mins / 60} hour${mins === 60 ? "" : "s"}` : `${mins} minutes`} (until ${new Date(loan.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}). Pass computer: "${a.loan.deviceName}" to the computer_* tools to act on it; without it they still act on your own computer. When you're done, call device_return.`;
        } catch (err) {
          return fail(reply, err);
        }
      } else verdict = `Denied: ${owner} didn't lend you "${a.loan.deviceName}". Carry on without it, or ask in chat.`;
      const decided = store.decideApproval(a.id, body.approve ? "approved" : "denied", c.actor.id, body.note)!;
      hub.broadcast(c.workspaceId, { type: "approval", approval: decided }, hub.audience(a.channelId));
      // the agent is woken where it was working, for the person it was working for
      if (agent && store.channel(a.loan.channelId)) hub.postMessage({ channelId: a.loan.channelId, threadId: a.loan.threadId, author: c.actor, body: `@${agent.handle} ${verdict}${note}`, onBehalfOf: a.loan.requestedBy ?? c.actor.id });
      return decided;
    }
    const decided = store.decideApproval(a.id, body.approve ? "approved" : "denied", c.actor.id, body.note)!;
    hub.broadcast(c.workspaceId, { type: "approval", approval: decided }, hub.audience(a.channelId));
    if (agent && store.channel(a.channelId)) {
      const verdict = body.approve ? `Approved: go ahead with "${a.summary}".` : `Don't do "${a.summary}".`;
      hub.postMessage({ channelId: a.channelId, threadId: a.threadId, author: c.actor, body: `@${agent.handle} ${verdict}${note}` });
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
    await hub.vault(c.workspaceId).write(notePath, body.steps.trim().startsWith("#") ? body.steps : `# ${body.name}\n\n${body.steps}\n`, h.commitAuthor(c), `Routine "${body.name}" for @${agent.handle}`);
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
    await hub.vault(c.workspaceId).write(notePath, body.steps.trim().startsWith("#") ? body.steps : `# ${name}\n\n${body.steps}\n`, { name: `@${agent.handle}`, email: `${agent.handle}@agents.warren` }, `Routine "${name}"`);
    if (r) r = store.updateRoutine(r.id, { name, status: "ready", ...(body.schedule !== undefined ? { schedule: body.schedule } : {}), ...(body.timezone ? { timezone: body.timezone } : {}) })!;
    else r = store.createRoutine({ workspaceId: c.workspaceId, agentId: agent.id, name, notePath, schedule: body.schedule ?? null, timezone: body.timezone ?? "UTC", channelId: null, status: "ready", createdBy: c.actor });
    hub.broadcast(c.workspaceId, { type: "routines_changed" });
    return r;
  });

  // --- settings -------------------------------------------------------------------------------

  app.get("/api/settings/computers", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const key = store.setting(c.workspaceId, "orgo.apiKey");
    return { orgo: { configured: !!key, hint: key ? `…${key.slice(-4)}` : null }, defaults: computerDefaults(hub, c.workspaceId) };
  });

  app.put("/api/settings/computers", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z.object({ orgoApiKey: z.string().trim().max(300).nullable(), vmSize: z.enum(["small", "medium", "large"]), controlIdleMinutes: z.number().int().min(1).max(240) }).partial(),
      req.body,
      reply,
    );
    if (!body) return;
    if (body.vmSize) store.setSetting(c.workspaceId, "computers.vmSize", body.vmSize);
    if (body.controlIdleMinutes) store.setSetting(c.workspaceId, "computers.controlIdleMinutes", String(body.controlIdleMinutes));
    if (body.orgoApiKey === undefined) {
      const key = store.setting(c.workspaceId, "orgo.apiKey");
      return { orgo: { configured: !!key, hint: key ? `…${key.slice(-4)}` : null }, defaults: computerDefaults(hub, c.workspaceId) };
    }
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
    return { orgo: { configured: !!body.orgoApiKey, hint: body.orgoApiKey ? `…${body.orgoApiKey.slice(-4)}` : null }, defaults: computerDefaults(hub, c.workspaceId) };
  });

  // --- bringing in existing agents ---------------------------------------------------------------

  app.post("/api/nodes/:id/discover", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "device not found" });
    if (node.ownerId !== c.actor.id && !node.shared) return reply.code(403).send({ error: `only the person who connected ${node.name} can look for agents on it` });
    if (!hub.sendToNode(node.id, { type: "discover" })) return reply.code(503).send({ error: "the device is offline" });
    return { ok: true };
  });

  /** Make a Warren agent from one that already exists on a device: its soul, instructions and notes come along. */
  app.post("/api/agents/import", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(
      z.object({
        nodeId: z.string(),
        key: z.string().max(200),
        handle: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        name: NAME.optional(),
        harness: HARNESS.optional(),
        computerId: z.string().nullable().default(null),
        headless: z.boolean().default(false),
        runIn: z.enum(["computer", "device"]).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const node = store.node(body.nodeId);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown device" });
    if (node.ownerId !== c.actor.id && !node.shared) return reply.code(403).send({ error: `only the person who connected ${node.name} can bring in agents from it` });
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
    // like any new agent, it remembers who brought it in and answers only them to start with
    store.updateAgent(agent.id, { settings: { respondTo: "me", createdBy: c.actor.id, ...(body.headless ? { headless: true } : {}), ...(body.runIn ? { runIn: body.runIn } : {}) } });
    const general = store.channelByName(c.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "agent", id: agent.id });
    const author = h.commitAuthor(c);
    await hub.vault(c.workspaceId).write(soulPath(agent.id), found.soul?.trim() ? found.soul : soulTemplate(agent.name, agent.handle), author, `Import @${agent.handle} from ${node.name}`);
    for (const m of found.memories ?? []) {
      const name = m.name.replace(/[^\w.-]+/g, "-").replace(/\.md$/i, "");
      await hub.vault(c.workspaceId).write(`agents/${agent.id}/imported/${name}.md`, m.content, author, `Import ${m.name} for @${agent.handle}`);
    }
    return h.agentView(store.agent(agent.id)!);
  });
}
