import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CREDENTIAL_SUPPORT, MODEL_PROVIDER_INFO, MODEL_PROVIDERS, ModelProviderId, harnessLabel, providerLabel, type ModelLogin, type ModelProvider } from "@wisp/core";
import type { Caller } from "./api.ts";
import { id } from "./auth.ts";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";
import { modelsForHarness } from "./model-connections.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const LABEL = z.string().trim().min(1).max(80);
const SIGN_IN_HARNESS = z.enum(["claude-code", "codex", "hermes"]);

/**
 * Model connections: "connect once in Wisp". A person signs in to a model provider (on one of
 * their devices, which runs the harness's own sign-in in a scratch folder) or pastes an API key;
 * the hub keeps it and hands it to whichever device or VM runs an agent that uses it. Connections
 * are their owner's: only they list, rename, remove or assign them, and no answer here ever
 * carries a secret (a key's last four characters at most).
 *
 *   GET    /api/model-providers                     → { providers: ModelProviderInfo[], support: CredentialSupport[] }
 *   GET    /api/model-connections                   → { connections: ModelConnection[] }
 *   POST   /api/model-connections                   { provider, kind: "key", key, label? } → ModelConnection
 *   PATCH  /api/model-connections/:id               { label } → ModelConnection
 *   DELETE /api/model-connections/:id               → { ok, agents }  (agents that were on it go back to their device's login)
 *   GET    /api/model-connections/:id/models        ?harness=&agent=&fresh=1 → { connectionId, provider, harness, models, efforts }
 *   POST   /api/model-connections/login             { provider, nodeId?, harness?, label? } → ModelLogin & { nodeId }
 *   GET    /api/model-connections/login/:loginId    → ModelLogin
 *   POST   /api/model-connections/login/:loginId/input  { text } → ModelLogin   (the code Claude's page shows)
 *   DELETE /api/model-connections/login/:loginId    → { ok }
 *   GET    /api/harnesses                           → { computers: [...] }  (Settings → Harnesses, by computer)
 *
 * A sign-in's progress is also pushed on the browser socket as { type: "model_login", login } to the
 * person who started it, and { type: "model_connections_changed" } when a connection is added,
 * renamed, removed, renewed or reports plan usage.
 */
export function registerModelsApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse } = h;

  const usedBy = (workspaceId: string, connectionId: string) =>
    store
      .agents(workspaceId)
      .filter((a) => a.settings.connectionId === connectionId)
      .map((a) => ({ id: a.id, handle: a.handle, name: a.name }));

  const view = (c: Caller, connectionId: string) => {
    const r = hub.models.row(connectionId)!;
    return hub.models.view(r, c.actor.id, usedBy(c.workspaceId, r.id));
  };

  /** One of the caller's own connections. */
  const mine = (c: Caller, connectionId: string, reply: FastifyReply) => {
    const r = hub.models.row(connectionId);
    if (!r || r.workspace_id !== c.workspaceId || r.user_id !== c.actor.id) return void reply.code(404).send({ error: "connection not found" });
    return r;
  };

  const changed = (c: Caller) => hub.broadcast(c.workspaceId, { type: "model_connections_changed" }, (u) => u === c.actor.id);

  app.get("/api/model-providers", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    return { providers: MODEL_PROVIDERS.map((p) => MODEL_PROVIDER_INFO[p]), support: CREDENTIAL_SUPPORT };
  });

  app.get("/api/model-connections", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    return { connections: hub.models.mine(c.workspaceId, c.actor.id).map((r) => hub.models.view(r, c.actor.id, usedBy(c.workspaceId, r.id))) };
  });

  /** Connect an API key: checked with the provider first (a key it turns down isn't kept). */
  app.post("/api/model-connections", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ provider: ModelProviderId, kind: z.literal("key"), key: z.string().trim().min(8).max(4000), label: LABEL.optional() }).strict(), req.body, reply);
    if (!body) return;
    const info = MODEL_PROVIDER_INFO[body.provider];
    if (/\s/.test(body.key)) return reply.code(400).send({ error: "key: a key has no spaces in it" });
    // an OpenRouter key in the Anthropic box, say: the most specific prefix the key has, when it's another provider's
    const ours = info.keyPrefix && body.key.startsWith(info.keyPrefix) ? info.keyPrefix.length : 0;
    const other = MODEL_PROVIDERS.filter((p) => p !== body.provider && MODEL_PROVIDER_INFO[p].keyPrefix && body.key.startsWith(MODEL_PROVIDER_INFO[p].keyPrefix!) && MODEL_PROVIDER_INFO[p].keyPrefix!.length > ours).sort((x, y) => MODEL_PROVIDER_INFO[y].keyPrefix!.length - MODEL_PROVIDER_INFO[x].keyPrefix!.length)[0];
    if (other) return reply.code(400).send({ error: `key: that looks like a ${providerLabel(other)} key` });
    const problem = await hub.models.checkKey(body.provider, body.key);
    if (problem) return reply.code(400).send({ error: `key: ${problem}` });
    const cid = hub.models.create({ workspaceId: c.workspaceId, userId: c.actor.id, provider: body.provider, kind: "key", label: body.label ?? `${info.label} key`, secret: { key: body.key } });
    changed(c);
    return view(c, cid);
  });

  app.patch("/api/model-connections/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const r = mine(c, (req.params as { id: string }).id, reply);
    if (!r) return;
    const body = parse(z.object({ label: LABEL }).strict(), req.body, reply);
    if (!body) return;
    hub.models.rename(r.id, body.label);
    changed(c);
    return view(c, r.id);
  });

  /** Remove a connection; agents on it go back to the harness's own login where they run. */
  app.delete("/api/model-connections/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const r = mine(c, (req.params as { id: string }).id, reply);
    if (!r) return;
    const agents = usedBy(c.workspaceId, r.id);
    for (const a of agents) store.updateAgent(a.id, { settings: { connectionId: null } });
    hub.models.remove(r.id);
    if (agents.length) hub.broadcast(c.workspaceId, { type: "agents_changed" });
    changed(c);
    return { ok: true, agents: agents.map((a) => a.id) };
  });

  /**
   * The models a connection offers, as `harness` can run them (default: the agent's, else the
   * first harness that can use it). Efforts come with each model where the provider says, and
   * `efforts` is the harness's own list for models that don't.
   */
  app.get("/api/model-connections/:id/models", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const r = hub.models.row((req.params as { id: string }).id);
    const q = parse(z.object({ harness: z.string().max(60).optional(), agent: z.string().max(64).optional(), fresh: z.string().optional() }), req.query, reply);
    if (!q) return;
    const agent = q.agent ? store.agent(q.agent) : undefined;
    if (!r || r.workspace_id !== c.workspaceId || (r.user_id !== c.actor.id && agent?.settings.connectionId !== r.id)) return reply.code(404).send({ error: "connection not found" });
    if (q.agent && (!agent || agent.workspaceId !== c.workspaceId)) return reply.code(404).send({ error: "agent not found" });
    const harness = q.harness ?? agent?.harness ?? CREDENTIAL_SUPPORT.find((s) => s.provider === r.provider && s.kind === r.kind)?.harness ?? "";
    // a sign-in's list comes from the harness that runs it: the agent's, else any device's
    const catalog = (agent ? hub.catalogFor({ ...agent, harness }) : undefined) ?? store.nodes(c.workspaceId).flatMap((n) => store.nodeCatalog(n.id)).find((h) => h.harness === harness);
    const models = await hub.models.models(r.id, catalog, { fresh: !!q.fresh }).catch((err) => {
      reply.code(502).send({ error: (err as Error).message });
      return null;
    });
    if (!models) return;
    return { connectionId: r.id, provider: r.provider, harness, models: modelsForHarness(harness, r.provider, models), efforts: catalog?.efforts ?? [] };
  });

  // --- signing in ------------------------------------------------------------------------------

  /**
   * Start a sign-in on one of the caller's online devices: `nodeId` when given, else the first
   * one with a harness that can do it. The answer has the login's id; the link and code follow
   * (poll GET …/login/:loginId or listen for model_login on the socket).
   */
  app.post("/api/model-connections/login", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ provider: ModelProviderId, nodeId: z.string().max(100).optional(), harness: SIGN_IN_HARNESS.optional(), label: LABEL.optional() }).strict(), req.body, reply);
    if (!body) return;
    const ways = MODEL_PROVIDER_INFO[body.provider].signIn ?? [];
    if (!ways.length) return reply.code(400).send({ error: `${providerLabel(body.provider)} connects with an API key, not a sign-in` });
    const harnesses = body.harness ? ways.filter((w) => w.harness === body.harness).map((w) => w.harness) : ways.map((w) => w.harness);
    if (!harnesses.length) return reply.code(400).send({ error: `harness: ${harnessLabel(body.harness!)} can't sign in to ${providerLabel(body.provider)}` });
    const devices = store.nodes(c.workspaceId).filter((n) => n.ownerId === c.actor.id && hub.isNodeOnline(n.id) && !hub.isNodePaused(n.id) && (!body.nodeId || n.id === body.nodeId));
    if (body.nodeId && !devices.length) return reply.code(400).send({ error: "nodeId: that isn't one of your devices, or it's offline" });
    let pick: { nodeId: string; harness: (typeof harnesses)[number] } | null = null;
    for (const n of devices) {
      const installed = store.nodeCatalog(n.id).map((h) => h.harness);
      const harness = harnesses.find((x) => installed.includes(x));
      if (harness) {
        pick = { nodeId: n.id, harness };
        break;
      }
    }
    if (!pick) return reply.code(400).send({ error: `None of your devices that are online has ${harnesses.map(harnessLabel).join(" or ")} to sign in with. Install it on one, or connect an API key instead.` });
    const loginId = id("ml");
    const state: ModelLogin = { id: loginId, provider: body.provider, harness: pick.harness, status: "running", output: "" };
    hub.modelLogins.set(loginId, { workspaceId: c.workspaceId, userId: c.actor.id, nodeId: pick.nodeId, label: body.label, state });
    try {
      const started = (await hub.computers.nodeRequest(pick.nodeId, (requestId) => ({ type: "model_login", requestId, op: "start", loginId, provider: body.provider, harness: pick!.harness }), 20_000)) as ModelLogin;
      const l = hub.modelLogins.get(loginId);
      // progress may have come in already; keep whichever knows more
      if (l && l.state.status === "running") l.state = { ...started, ...l.state, url: l.state.url ?? started.url, code: l.state.code ?? started.code, wantsInput: started.wantsInput, provider: body.provider };
      return { ...(l?.state ?? state), nodeId: pick.nodeId };
    } catch (err) {
      hub.modelLogins.delete(loginId);
      if (err instanceof ComputerError) return reply.code(err.status === 504 ? 502 : err.status).send({ error: err.status === 504 ? `${store.node(pick.nodeId)?.name ?? "The device"} didn't answer; update Wisp there and try again` : err.message });
      throw err;
    }
  });

  const myLogin = (c: Caller, loginId: string, reply: FastifyReply) => {
    const l = hub.modelLogins.get(loginId);
    if (!l || l.workspaceId !== c.workspaceId || l.userId !== c.actor.id) return void reply.code(404).send({ error: "that sign-in isn't running anymore; start it again" });
    return l;
  };

  app.get("/api/model-connections/login/:loginId", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const l = myLogin(c, (req.params as { loginId: string }).loginId, reply);
    if (!l) return;
    return l.state;
  });

  app.post("/api/model-connections/login/:loginId/input", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const l = myLogin(c, (req.params as { loginId: string }).loginId, reply);
    if (!l) return;
    const body = parse(z.object({ text: z.string().trim().min(1).max(2000) }).strict(), req.body, reply);
    if (!body) return;
    try {
      const s = (await hub.computers.nodeRequest(l.nodeId, (requestId) => ({ type: "model_login", requestId, op: "input", loginId: l.state.id, text: body.text }), 20_000)) as ModelLogin;
      if (l.state.status === "running") l.state = { ...l.state, output: s.output };
      return l.state;
    } catch (err) {
      if (err instanceof ComputerError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.delete("/api/model-connections/login/:loginId", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const l = myLogin(c, (req.params as { loginId: string }).loginId, reply);
    if (!l) return;
    hub.sendToNode(l.nodeId, { type: "model_login", requestId: id("req"), op: "cancel", loginId: l.state.id });
    if (l.state.status === "running") l.state = { ...l.state, status: "failed", error: "Cancelled." };
    return { ok: true };
  });

  // --- harnesses, by computer ---------------------------------------------------------------------

  /**
   * Every harness on every computer the caller can see: each device's own, and each VM's (what
   * agents running inside it use), with versions and the agents on each. VMs a device hasn't
   * reported yet are listed with `reported: false` and no harnesses.
   */
  app.get("/api/harnesses", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agents = store.agents(c.workspaceId);
    const users = (where: (a: (typeof agents)[number]) => boolean, harness: string) => agents.filter((a) => a.harness === harness && where(a)).map((a) => ({ id: a.id, handle: a.handle, name: a.name }));
    const out: unknown[] = [];
    for (const n of store.nodes(c.workspaceId)) {
      if (n.ownerId && n.ownerId !== c.actor.id && !n.shared) continue;
      const onDevice = (a: (typeof agents)[number]) => a.nodeId === n.id && !hub.runsInComputer(a);
      out.push({ id: n.id, kind: "device", name: n.name, nodeId: n.id, online: hub.isNodeOnline(n.id), reported: true, harnesses: store.nodeCatalog(n.id).map((h) => ({ id: h.harness, label: harnessLabel(h.harness), version: h.version, agents: users(onDevice, h.harness) })) });
      for (const vm of store.computersOnNode(n.id).filter((x) => x.kind === "vm")) {
        const catalog = store.computerCatalog(n.id, vm.id);
        const inVm = (a: (typeof agents)[number]) => a.computerId === vm.id && hub.runsInComputer(a);
        out.push({ id: vm.id, kind: "vm", name: vm.name, nodeId: n.id, online: hub.isNodeOnline(n.id), reported: !!catalog, harnesses: (catalog ?? []).map((h) => ({ id: h.harness, label: harnessLabel(h.harness), version: h.version, agents: users(inVm, h.harness) })) });
        // not reported since the hub last heard: ask (the device answers only when the VM is already up)
        if (!catalog && hub.isNodeOnline(n.id)) hub.sendToNode(n.id, { type: "computer_catalog", computer: hub.computers.spec(vm) });
      }
    }
    return { computers: out };
  });
}

/** For API code that checks a connection before assigning it to an agent. */
export function connectionProblem(hub: Hub, c: Caller, connectionId: string, harness: string, nodeId?: string | null): string | null {
  const r = hub.models.row(connectionId);
  if (!r || r.workspace_id !== c.workspaceId) return "settings.connectionId: no such connection";
  if (r.user_id !== c.actor.id) return "settings.connectionId: only its owner can put an agent on that connection";
  // a connection only ever goes to its owner's own devices (Hub.connectionWithheld)
  const node = nodeId ? hub.store.node(nodeId) : undefined;
  if (node && node.ownerId !== r.user_id) return `settings.connectionId: your ${providerLabel(r.provider)} ${r.kind === "oauth" ? "sign-in" : "key"} only goes to your own devices, and ${node.name} isn't one`;
  if (!CREDENTIAL_SUPPORT.some((s) => s.harness === harness && s.provider === r.provider && s.kind === r.kind)) return `${harnessLabel(harness)} can't use a ${providerLabel(r.provider as ModelProvider)} ${r.kind === "oauth" ? "sign-in" : "key"}`;
  return null;
}
