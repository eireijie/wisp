import type { WebSocket } from "ws";
import { BUILTIN_SKILLS, HubToNode, agentSkillPath, skillFile, LoopGuard, NodeToHub, agentCommands, parseCommand, skillRequest, type AgentCommand, type ChannelTeam, harnessLabel, runsInVm, signInProblem, type Agent, activeLoan, parseMentions, readTunnelFrame, soulPath, type Actor, type AgentEvent, type ClientEvent, type Computer, type ComputerSpec, type Message, type MessagePart, type RunWorkspace, type ShelfItem } from "@warren/core";
import { id } from "./auth.ts";
import { Computers } from "./computers.ts";
import { Logins } from "./logins.ts";
import { Discussions } from "./discussions.ts";
import { Apns } from "./apns.ts";
import { Reach } from "./reach.ts";
import { Routines } from "./routines.ts";
import { BACKGROUND_THREAD, Background } from "./background.ts";
import { Push } from "./push.ts";
import { Marketplace } from "./marketplace.ts";
import { Logos } from "./logos.ts";
import { PublicSkills } from "./skill-store.ts";
import { Updates } from "./updates.ts";
import { ConnectorStore, SkillStore } from "./connectors.ts";
import type { Vault } from "@warren/vault";
import type { Vaults } from "./vaults.ts";
import { MemoryAccess } from "./access.ts";
import { ASK_BEFORE_TEXT, agentPolicy } from "./policy.ts";
import { AgentMemory } from "./memory.ts";
import { failTaskOfRun, leadSection, taskInstructions } from "./lead.ts";
import { spawnSection } from "./spawn.ts";
import { foldTeams } from "./fold-teams.ts";
import type { Store } from "./store.ts";
import { guestEvent } from "./guest-computers.ts";

const CONTEXT_MESSAGES = 20;

interface ClientConn {
  socket: WebSocket;
  workspaceId: string;
  userId: string;
  sessionHash: string;
}

interface NodeConn {
  socket: WebSocket;
  nodeId: string;
  workspaceId: string;
}

interface LiveRun {
  parts: MessagePart[];
  text: string;
}

/**
 * The hub runtime: fans events out to browsers, keeps node connections,
 * and turns messages into agent runs.
 */
export class Hub {
  /** Stable across restarts and address changes; joined computers use it to find this Wisp again. */
  id = "";
  private closed = false;
  private clients = new Set<ClientConn>();
  private nodes = new Map<string, NodeConn>();
  private live = new Map<string, LiveRun>();
  private taskReplies = new Map<string, { messageId: string; result: string }>();
  /** devices whose owner ran `warren node pause` there */
  private pausedNodes = new Set<string>();
  readonly guard = new LoopGuard();
  readonly access: MemoryAccess;
  readonly memory: AgentMemory;
  readonly discussions: Discussions;
  readonly computers: Computers;
  /** logins agents fill from the person's password manager */
  readonly logins: Logins;
  readonly routines: Routines;
  readonly background: Background;
  readonly push: Push;
  readonly marketplace: Marketplace;
  readonly logos: Logos;
  readonly publicSkills: PublicSkills;
  /** skills and MCP servers each device's harnesses already have (sent when it connects) */
  readonly shelves = new Map<string, ShelfItem[]>();
  readonly updates: Updates;
  readonly connectors: ConnectorStore;
  readonly skills: SkillStore;
  /** iOS push notifications (optional; needs an APNs key) */
  readonly apns: Apns;
  /** how people and devices reach this hub from elsewhere (home network, Tailscale) */
  reach = new Reach(Number(process.env.PORT ?? 4747));
  /** how the hub reaches outside services (Orgo); tests swap it */
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  /** where Orgo computers' screens are (websockify); tests point it at a fake */
  orgoWs = "wss://www.orgo.ai";
  /** git operations waiting for a device to answer */
  private pendingGit = new Map<string, { resolve: (r: { ok: boolean; output: string }) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    readonly store: Store,
    readonly vaults: Vaults,
  ) {
    this.access = new MemoryAccess(store);
    this.memory = new AgentMemory(store, (wsId) => this.vault(wsId), this.access);
    this.discussions = new Discussions(this);
    this.computers = new Computers(this);
    this.logins = new Logins(this);
    this.routines = new Routines(this);
    this.background = new Background(this);
    this.push = new Push(this);
    this.marketplace = new Marketplace(this);
    this.logos = new Logos(this);
    this.publicSkills = new PublicSkills(this);
    this.updates = new Updates(this);
    this.connectors = new ConnectorStore(store.db);
    this.skills = new SkillStore(store.db);
    this.apns = new Apns(this);
  }

  /** An organization's memory vault (each organization has its own). */
  vault(workspaceId: string): Vault {
    return this.vaults.get(workspaceId);
  }

  /** Old teams (and v0.1 groups) become their channel's team; each memory folder keeps a brief. */
  async foldTeams() {
    for (const t of foldTeams(this.store)) {
      if (!t.folder) continue;
      const brief = `${t.folder}/README.md`;
      const vault = this.vault(t.workspaceId);
      if (!vault.list((p) => p.toLowerCase() === brief.toLowerCase()).length) {
        await vault
          .write(brief, `# Team #${t.name}\n\nWhat this team is for, what it's working on, and how it works. The lead keeps this up to date.\n`, { name: "Warren", email: "warren@localhost" }, `Brief for #${t.name}`)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Every agent has the built-in skills in its folder. Missing copies are put back (they can't be
   * removed); `refresh` also rewrites copies that differ, so a new Warren version reaches them.
   */
  async ensureBuiltinSkills(agentIds?: string[], refresh = false) {
    const rows = this.store.db.prepare("SELECT id, workspace_id AS workspaceId FROM agents").all() as { id: string; workspaceId: string }[];
    for (const { id: agentId, workspaceId } of agentIds ? rows.filter((r) => agentIds.includes(r.id)) : rows) {
      const vault = this.vault(workspaceId);
      for (const s of BUILTIN_SKILLS) {
        const p = agentSkillPath(agentId, s.id);
        const file = skillFile({ slug: s.id, name: s.name, description: s.description, content: s.content });
        const have = await vault.read(p).then((n) => n.content, () => null);
        if (have === file || (have !== null && !refresh)) continue;
        await vault.write(p, file, { name: "Warren", email: "warren@localhost" }, `Built-in skill "${s.name}"`).catch(() => undefined);
      }
    }
  }

  /** Stop handling events and drop every connection (before the database closes). */
  shutdown() {
    this.closed = true;
    void this.reach.cloudflare.close();
    this.computers.shutdown();
    this.routines.stop();
    this.background.stop();
    for (const c of this.clients) c.socket.terminate();
    for (const n of this.nodes.values()) n.socket.terminate();
    this.clients.clear();
    this.nodes.clear();
  }

  // --- browser clients ------------------------------------------------------

  addClient(socket: WebSocket, workspaceId: string, userId: string, sessionHash: string) {
    const c = { socket, workspaceId, userId, sessionHash };
    this.clients.add(c);
    socket.on("close", () => this.clients.delete(c));
  }

  /** Send an event to everyone in a workspace, or only to the people `only` picks. */
  broadcast(workspaceId: string, event: ClientEvent, only?: (userId: string) => boolean) {
    const data = JSON.stringify(event);
    const guest = guestEvent(event);
    for (const c of this.clients) {
      if (c.workspaceId !== workspaceId || c.socket.readyState !== 1 || (only && !only(c.userId))) continue;
      if (this.store.role(workspaceId, c.userId) === "guest") {
        if (guest) c.socket.send(JSON.stringify(guest));
      } else c.socket.send(data);
    }
    if (!this.closed) this.apns.onEvent(workspaceId, event, only);
  }

  /**
   * Who may hear about a channel: everyone for a channel; for a DM or a private channel, its
   * members and the workspace's owners (the same rule the REST API uses). Undefined means everyone.
   */
  audience(channelId: string): ((userId: string) => boolean) | undefined {
    const ch = this.store.channel(channelId);
    if (!ch || (ch.kind !== "dm" && !ch.private)) return undefined;
    const members = new Set(this.store.channelMembers(ch.id).filter((m) => m.kind === "user").map((m) => m.id));
    return (userId) => members.has(userId) || this.store.role(ch.workspaceId, userId) === "owner";
  }

  /** Drop a person's browser connections (they were removed from the workspace). */
  disconnectUser(userId: string) {
    for (const c of this.clients) {
      if (c.userId !== userId) continue;
      this.clients.delete(c);
      c.socket.close(4401, "removed from the workspace");
    }
  }

  /** Stop sending events to sign-ins whose tokens were revoked. */
  disconnectRevokedSessions(userId?: string) {
    const session = this.store.db.prepare("SELECT 1 FROM tokens WHERE kind = 'session' AND hash = ?");
    for (const c of this.clients) {
      if ((userId && c.userId !== userId) || session.get(c.sessionHash)) continue;
      this.clients.delete(c);
      c.socket.close(4401, "session revoked");
    }
  }

  /** Drop a device's connection; with its token revoked it can't come back. */
  disconnectNode(nodeId: string) {
    const conn = this.nodes.get(nodeId);
    if (!conn) return;
    this.nodes.delete(nodeId);
    this.pausedNodes.delete(nodeId);
    conn.socket.close(4401, "device removed");
    for (const a of this.store.agentsOnNode(nodeId)) this.broadcast(conn.workspaceId, { type: "agent_status", agentId: a.id, status: "offline" });
    this.computers.nodeGone(nodeId);
  }

  // --- nodes ----------------------------------------------------------------

  isNodeOnline(nodeId: string | null): boolean {
    return !!nodeId && this.nodes.has(nodeId);
  }

  /** Paused at the device itself (`warren node pause`): it takes no work until it's resumed there. */
  isNodePaused(nodeId: string | null): boolean {
    return !!nodeId && this.pausedNodes.has(nodeId);
  }

  /** Could this agent start a run right now: is its device connected and not paused? */
  agentAvailable(agent: { nodeId: string | null }): boolean {
    return this.isNodeOnline(agent.nodeId) && !this.isNodePaused(agent.nodeId);
  }

  /**
   * Does this agent's harness run inside its computer: a VM on the same device, with a harness
   * that comes in the VM image? Then its shell, files and browser all stay in the VM.
   */
  runsInComputer(agent: Pick<Agent, "nodeId" | "computerId" | "harness" | "settings">): boolean {
    if (agent.settings.runIn !== "computer" || !runsInVm(agent.harness) || !agent.computerId) return false;
    const c = this.store.computer(agent.computerId);
    return c?.kind === "vm" && !!c.nodeId && c.nodeId === agent.nodeId;
  }

  /**
   * Does this agent's harness run directly on a person's device (not inside a VM)? Then it can
   * reach that device's files, so only the device's owner can ask it for things unless they open it up.
   */
  harnessOnDevice(agent: Pick<Agent, "nodeId" | "computerId" | "harness" | "settings">): boolean {
    return !!agent.nodeId && !this.runsInComputer(agent);
  }

  /** Why `requestedBy` can't ask this agent for something, or null when they can. */
  whyNotAllowed(agent: Pick<Agent, "handle" | "nodeId" | "computerId" | "harness" | "settings">, requestedBy: string | null): string | null {
    if (!this.harnessOnDevice(agent) || agent.settings.anyoneCanAsk) return null;
    const node = this.store.node(agent.nodeId!);
    // a device its owner shared with the workspace takes requests from everyone
    if (!node?.ownerId || node.shared || node.ownerId === requestedBy) return null;
    const owner = this.store.user(node.ownerId)?.name ?? "its owner";
    return `@${agent.handle} runs directly on ${owner}'s device "${node.name}", so only ${owner} can ask it for things. ${owner} can open it up to everyone on its page`;
  }

  /**
   * Does this agent answer `personId`? Its "Who it answers" setting: only its creator ("me"; the
   * organization's owners when nobody is recorded as its creator, or they left), chosen people
   * (and its creator), or anyone. Unset is anyone, as agents did before the setting existed. Work
   * nobody asked for (a schedule, the system) always goes through.
   */
  answers(agent: Pick<Agent, "workspaceId" | "settings">, personId: string | null): boolean {
    const mode = agent.settings.respondTo ?? "anyone";
    if (mode === "anyone" || !personId || personId === "system") return true;
    const creator = agent.settings.createdBy && this.store.role(agent.workspaceId, agent.settings.createdBy) ? agent.settings.createdBy : null;
    if (creator ? creator === personId : this.store.role(agent.workspaceId, personId) === "owner") return true;
    return mode === "people" && (agent.settings.respondPeople ?? []).includes(personId);
  }

  agentStatus(agent: { id: string; nodeId: string | null }): "online" | "busy" | "offline" {
    if (!this.isNodeOnline(agent.nodeId)) return "offline";
    return this.store.activeRunCount(agent.id) > 0 ? "busy" : "online";
  }

  /** Send to a device if it's connected. */
  sendToNode(nodeId: string, msg: HubToNode): boolean {
    const conn = this.nodes.get(nodeId);
    if (!conn || conn.socket.readyState !== 1) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  sendBinaryToNode(nodeId: string, data: Uint8Array) {
    const conn = this.nodes.get(nodeId);
    if (conn?.socket.readyState === 1) conn.socket.send(data, { binary: true });
  }

  addNode(socket: WebSocket, nodeId: string, workspaceId: string) {
    this.nodes.get(nodeId)?.socket.close(4000, "replaced by a newer connection");
    const conn = { socket, nodeId, workspaceId };
    this.nodes.set(nodeId, conn);
    this.send(conn, { type: "welcome", nodeId });

    socket.on("message", (raw, isBinary) => {
      if (this.closed) return;
      if (isBinary) {
        const frame = readTunnelFrame(new Uint8Array(raw as Buffer));
        if (frame) this.computers.onTunnelData(nodeId, frame.tunnelId, frame.payload);
        return;
      }
      let msg: NodeToHub;
      try {
        msg = NodeToHub.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      this.onNodeMessage(conn, msg);
    });
    socket.on("close", () => {
      if (this.closed || this.nodes.get(nodeId) !== conn) return;
      this.nodes.delete(nodeId);
      this.pausedNodes.delete(nodeId);
      for (const a of this.store.agentsOnNode(nodeId)) this.broadcast(workspaceId, { type: "agent_status", agentId: a.id, status: "offline" });
      this.computers.nodeGone(nodeId);
    });
  }

  private onNodeMessage(conn: NodeConn, msg: NodeToHub) {
    const { store } = this;
    switch (msg.type) {
      case "hello": {
        store.touchNode(conn.nodeId, msg.nodeName);
        this.updates.deviceConnected(conn.nodeId, msg.version);
        for (const a of store.agentsOnNode(conn.nodeId)) this.broadcast(conn.workspaceId, { type: "agent_status", agentId: a.id, status: this.agentStatus(a) });
        for (const r of store.queuedRunsForNode(conn.nodeId)) this.dispatchRun(r.id);
        this.computers.nodeBack(conn.nodeId);
        return;
      }
      case "capabilities": {
        store.setNodeCapabilities(conn.nodeId, msg.capabilities);
        const was = this.pausedNodes.has(conn.nodeId);
        if (msg.capabilities.paused) this.pausedNodes.add(conn.nodeId);
        else this.pausedNodes.delete(conn.nodeId);
        if (was && !msg.capabilities.paused) for (const r of store.queuedRunsForNode(conn.nodeId)) this.dispatchRun(r.id);
        for (const c of store.computersOnNode(conn.nodeId)) this.computers.changed(c.id);
        return;
      }
      case "screen_event": {
        this.computers.onScreenEvent(conn.nodeId, msg);
        return;
      }
      case "discovered": {
        store.setNodeDiscovered(conn.nodeId, msg.agents);
        return;
      }
      case "shelf": {
        this.shelves.set(conn.nodeId, msg.items);
        return;
      }
      case "result": {
        this.computers.onResult(conn.nodeId, msg);
        return;
      }
      case "computer_status": {
        const c = store.computer(msg.computerId);
        if (!c || c.nodeId !== conn.nodeId) return;
        store.updateComputer(c.id, { status: msg.status, statusText: msg.text });
        this.computers.changed(c.id);
        return;
      }
      case "screen_frame": {
        this.computers.onFrame(conn.nodeId, msg);
        return;
      }
      case "tunnel_ready": {
        this.computers.onTunnelReady(conn.nodeId, msg.tunnelId);
        return;
      }
      case "tunnel_closed": {
        this.computers.onTunnelClosed(conn.nodeId, msg.tunnelId, msg.error);
        return;
      }
      case "catalog": {
        store.setNodeCatalog(conn.nodeId, msg.catalog);
        return;
      }
      case "run_event": {
        const run = this.ownedRun(conn, msg.runId);
        if (!run) return;
        if (msg.event.type === "usage") {
          const { type: _t, ...usage } = msg.event;
          store.setRunUsage(run.id, usage);
        }
        const live = this.live.get(run.id) ?? { parts: [], text: "" };
        collect(live, msg.event);
        this.live.set(run.id, live);
        // a background check works quietly: nothing shows in the DM unless it messages the person
        if (run.kind !== "background") this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: run.agentId, channelId: run.channelId, ...this.whereRuns(run), event: msg.event }, this.audience(run.channelId));
        return;
      }
      case "run_done":
      case "run_failed": {
        const run = this.ownedRun(conn, msg.runId);
        // a device reporting late (after a cancel, or twice) doesn't reopen a run that's over
        if (!run || run.status !== "running") return;
        this.finishRun(conn.workspaceId, run, msg.type === "run_done" ? { finalText: msg.finalText } : { error: msg.error });
        return;
      }
      case "git_done": {
        const pending = this.pendingGit.get(msg.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingGit.delete(msg.requestId);
        pending.resolve({ ok: msg.ok, output: msg.output });
        return;
      }
    }
  }

  /**
   * A run ended: post its reply (or a "Run failed" line), free the agent, and move on whatever
   * waited on it (a discussion, a task). Used for the device's report and for failures on the hub.
   */
  private finishRun(workspaceId: string, run: NonNullable<ReturnType<Store["run"]>>, result: { finalText: string } | { error: string }) {
    const { store } = this;
    const live = this.live.get(run.id) ?? { parts: [], text: "" };
    this.live.delete(run.id);
    const taskReply = this.taskReplies.get(run.id);
    this.taskReplies.delete(run.id);
    const author: Actor = { kind: "agent", id: run.agentId };
    // in a discussion, replies don't wake anyone: the discussion moves on by itself
    const route = run.discussionId ? false : undefined;
    // the channel may have been deleted while the agent worked; then there's nowhere to reply
    const gone = !store.channel(run.channelId);
    const agent = store.agent(run.agentId);
    let body = "";
    if (run.kind === "background") {
      store.setRunStatus(run.id, "finalText" in result ? "done" : "failed", "error" in result ? result.error : undefined);
      this.background.finished(run, "finalText" in result ? result.finalText.trim() || live.text.trim() : `The check failed: ${result.error}`);
    } else if ("finalText" in result) {
      store.setRunStatus(run.id, "done");
      this.routines.runFinished(run);
      body = result.finalText.trim() || live.text.trim();
      // a harness command (/compact, say) may finish without a word; say it ran
      const trigger = !body && agent && run.triggerMessageId ? store.message(run.triggerMessageId) : undefined;
      const ran = trigger && agent ? this.commandFor(agent, trigger.body) : null;
      if (ran?.via === "raw" && !gone) this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body: "", parts: [...live.parts, { type: "notice", text: `Ran /${ran.name}.` }], hop: run.hop + 1, route: false });
      const posted = taskReply ? store.message(taskReply.messageId) : undefined;
      // the answer task_update already posted, repeated as the final reply (as-is, or wrapped in a line or two)
      const same = (a: string, b: string) => !!a.trim() && !!b.trim() && a.includes(b.trim());
      const repeated = taskReply && posted && !posted.deletedAt && (same(taskReply.result, body) || (same(body, taskReply.result) && body.length <= taskReply.result.length + 300));
      if (repeated && posted && live.parts.length) {
        const message = { ...posted, parts: [...posted.parts, ...live.parts] };
        store.db.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(JSON.stringify(message.parts), message.id);
        this.broadcast(workspaceId, { type: "message_updated", message: store.withReactions([message])[0] }, this.audience(message.channelId));
      }
      // it worked on its screen: the reply keeps the screen, so it doesn't vanish when the run ends
      const screen = agent?.computerId && !gone ? this.screenAfterRun(agent.computerId, live.parts, body, run) : null;
      const parts = screen ? [...live.parts, screen] : live.parts;
      if (body && !gone && !repeated) this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body, parts, hop: run.hop + 1, route, onBehalfOf: run.requestedBy });
    } else {
      store.setRunStatus(run.id, "failed", result.error);
      const text = agent ? this.explainFailure(agent, result.error) : result.error;
      if (!gone) {
        this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body: "", parts: [...live.parts, { type: "status", text: `Run failed: ${text}` }], hop: run.hop + 1, route: false });
        failTaskOfRun(this, run, text);
      }
    }
    if (agent) this.broadcast(workspaceId, { type: "agent_status", agentId: agent.id, status: this.agentStatus(agent) });
    if (run.discussionId) void this.discussions.onRunFinished(run, body);
  }

  /**
   * After a run that used the agent's own computer: the screen to show with its reply, and when
   * the reply asks the person to do something there ("sign in to Zendesk"), the same "needs you"
   * as computer_ask_human. Nothing when it already asked properly (that message has the screen).
   */
  private screenAfterRun(computerId: string, parts: MessagePart[], body: string, run: { agentId: string; channelId: string; threadId: string | null }): MessagePart | null {
    const calls = parts.filter((p) => p.type === "tool_call").map((p) => (p.type === "tool_call" ? p.name : ""));
    if (!calls.some((n) => /computer_/.test(n)) || calls.some((n) => /computer_ask_human/.test(n))) return null;
    const c = this.store.computer(computerId);
    if (!c) return null;
    const request = asksForHand(body);
    if (request) this.computers.flagHelp(c, run.agentId, request, { channelId: run.channelId, threadId: run.threadId });
    return { type: "computer", computerId, ...(request ? { request } : {}) };
  }

  /** A failure in plain words when it's a known one (a harness that needs signing in again), else as reported. */
  explainFailure(agent: Pick<Agent, "harness" | "nodeId">, error: string): string {
    const problem = signInProblem(agent.harness, error);
    if (!problem) return error;
    const device = agent.nodeId ? this.store.node(agent.nodeId)?.name : undefined;
    return problem.explain(device ?? "its device");
  }

  private ownedRun(conn: NodeConn, runId: string) {
    const run = this.store.run(runId);
    if (!run) return undefined;
    const agent = this.store.agent(run.agentId);
    return agent?.nodeId === conn.nodeId ? run : undefined;
  }

  private send(conn: NodeConn, msg: HubToNode) {
    if (conn.socket.readyState === 1) conn.socket.send(JSON.stringify(msg));
  }

  // --- messages & routing ---------------------------------------------------

  /**
   * Persist a message, broadcast it, and start runs for any agents it addresses. `onBehalfOf` is
   * the person the message ultimately serves; by default the person who wrote it, or for an
   * agent, whoever asked it for the work it's doing now.
   */
  postMessage(m: { channelId: string; threadId?: string | null; author: Actor; body: string; parts?: MessagePart[]; hop?: number; route?: boolean; replyInThread?: boolean; onBehalfOf?: string | null }): Message {
    const channel = this.store.channel(m.channelId);
    if (!channel) throw new Error("channel not found");
    const msg = this.store.insertMessage(m);
    this.broadcast(channel.workspaceId, { type: "message", message: msg }, this.audience(channel.id));
    this.push.onMessage(msg, channel, m.onBehalfOf !== undefined ? m.onBehalfOf : this.requester(m.author));
    if (m.route !== false) this.route(msg, channel.workspaceId, m.replyInThread ?? false, m.onBehalfOf !== undefined ? m.onBehalfOf : this.requester(m.author));
    return msg;
  }

  /** The person a message from `author` is for, when nobody says otherwise. */
  requester(author: Actor): string | null {
    if (author.kind === "user") return author.id === "system" ? null : author.id;
    return this.currentRun(author.id)?.requestedBy ?? null;
  }

  /**
   * Decide which agents should respond to a message: anyone @mentioned; in a DM, its agent; for a
   * person's plain reply in a thread, the agent already talking there; otherwise the channel's
   * default agent, if it has one. Agents only wake each other by @mention, so they can't loop.
   */
  targets(msg: Message, workspaceId: string): string[] {
    const { store } = this;
    const out = new Set<string>();
    const channel = store.channel(msg.channelId);
    if (channel?.archivedAt) return [];
    for (const handle of parseMentions(msg.body)) {
      const a = store.agentByHandle(workspaceId, handle);
      if (a) out.add(a.id);
    }
    if (channel?.kind === "dm" && msg.author.kind === "user") {
      for (const m of store.channelMembers(channel.id)) if (m.kind === "agent") out.add(m.id);
    }
    if (!out.size && msg.author.kind === "user" && msg.author.id !== "system") {
      // with a team, only the leads read a new message at the top of the channel
      const leads = channel?.kind === "channel" && !msg.threadId ? this.leads(channel) : [];
      for (const l of leads) out.add(l);
      // a plain reply in a thread goes to the agent already in it: the last one that spoke, or
      // else the one that started it or was asked at the start
      if (msg.threadId) {
        const root = store.message(msg.threadId);
        const last = store
          .messages(msg.channelId, { threadId: msg.threadId, limit: 200 })
          .filter((m) => m.author.kind === "agent" && store.agent(m.author.id))
          .at(-1);
        const asked = root ? parseMentions(root.body).map((h) => store.agentByHandle(workspaceId, h)?.id).find(Boolean) : undefined;
        const inThread = last?.author.id ?? (root?.author.kind === "agent" ? root.author.id : asked);
        if (inThread) out.add(inThread);
      }
      const fallback = channel?.kind === "channel" ? channel.settings.defaultAgentId : null;
      if (!out.size && fallback && store.agent(fallback)) out.add(fallback);
    }
    if (msg.author.kind === "agent") out.delete(msg.author.id);
    return [...out];
  }

  /** A channel's team leads that still exist, in chart order. */
  leads(channel: { settings: { team: ChannelTeam | null } }): string[] {
    return (channel.settings.team?.nodes ?? []).filter((n) => n.lead && this.store.agent(n.agentId)).map((n) => n.agentId);
  }

  /** Where a run works: its thread, and every thread above that one (outermost first). */
  whereRuns(run: { threadId: string | null }): { threadId: string | null; threadPath: string[] } {
    return { threadId: run.threadId, threadPath: run.threadId ? this.threadPath(run.threadId) : [] };
  }

  /** The threads a thread sits in, outermost first (empty for a thread at the top of a channel). */
  threadPath(threadId: string): string[] {
    const path: string[] = [];
    let cur = this.store.message(threadId)?.threadId ?? null;
    while (cur && path.length < 20 && !path.includes(cur)) {
      path.unshift(cur);
      cur = this.store.message(cur)?.threadId ?? null;
    }
    return path;
  }

  private route(msg: Message, workspaceId: string, replyInThread: boolean, requestedBy: string | null) {
    const channel = this.store.channel(msg.channelId);
    const fromPerson = msg.author.kind === "user" && msg.author.id !== "system";
    // a channel can ask agents to answer people in a thread under their message; a team always does
    const tidy = fromPerson && (channel?.settings.replyInThread || !!channel?.settings.team);
    // a hand-off asks for its own thread, even inside another thread (a sub-thread)
    const threadId = replyInThread ? msg.id : (msg.threadId ?? (tidy ? msg.id : null));
    let targets = this.targets(msg, workspaceId);
    // two or more leads read a new request: they plan it together before anyone starts
    const leads = channel && fromPerson && !msg.threadId && !parseMentions(msg.body).length ? this.leads(channel) : [];
    if (leads.length > 1 && targets.length === leads.length && targets.every((t) => leads.includes(t))) {
      const here = leads.filter((l) => this.answers(this.store.agent(l)!, msg.author.id) && !this.whyNotAllowed(this.store.agent(l)!, requestedBy));
      const online = here.filter((l) => this.agentAvailable(this.store.agent(l)!));
      if (online.length > 1) {
        const policy = agentPolicy(this, workspaceId);
        const verdict = this.guard.allow(msg.channelId, msg.hop, Date.now(), { maxHops: policy.maxHops, maxRunsPerWindow: policy.maxRunsPerMinute });
        if (!verdict.ok) {
          this.postSystem(msg, `Not waking the leads: ${verdict.reason}.`);
          return;
        }
        const d = this.discussions.plan({ workspaceId, request: msg, leads: here, requestedBy, startedBy: msg.author });
        this.discussions.broadcast(d.id);
        return;
      }
      // with only one lead around, it plans alone rather than two leads handing out the same work
      const solo = online[0] ?? here[0];
      if (solo && here.length > 1) this.postSystem({ ...msg, threadId }, `${here.filter((l) => l !== solo).map((l) => this.handleOf(l)).join(" and ")} ${here.length > 2 ? "are" : "is"} away, so ${this.handleOf(solo)} plans this on its own.`);
      targets = solo ? [solo] : [];
    }
    for (const agentId of targets) {
      const agent = this.store.agent(agentId)!;
      // an agent that only answers certain people stays quiet for everyone else
      if (!this.answers(agent, msg.author.kind === "user" ? msg.author.id : requestedBy)) continue;
      const notAllowed = this.whyNotAllowed(agent, requestedBy);
      if (notAllowed) {
        this.postSystem(msg, `Not waking ${this.handleOf(agentId)}: ${notAllowed}.`);
        continue;
      }
      const policy = agentPolicy(this, workspaceId);
      const verdict = this.guard.allow(msg.channelId, msg.hop, Date.now(), { maxHops: policy.maxHops, maxRunsPerWindow: policy.maxRunsPerMinute });
      if (!verdict.ok) {
        this.postSystem(msg, `Not waking ${this.handleOf(agentId)}: ${verdict.reason}.`);
        continue;
      }
      // commands Warren answers itself don't wake the agent
      if (msg.author.kind === "user" && this.commandFor(agent, msg.body)?.via === "warren") {
        this.answerCommand(agent, msg, threadId);
        continue;
      }
      const runId = this.store.createRun({ agentId, channelId: msg.channelId, threadId, triggerMessageId: msg.id, hop: msg.hop, requestedBy });
      if (!agent.nodeId) this.postSystem(msg, `${this.handleOf(agentId)} isn't connected to a device yet. The request is queued.`);
      else if (!this.isNodeOnline(agent.nodeId)) this.postSystem(msg, `${this.handleOf(agentId)} is offline. The request is queued until its device reconnects.`);
      else if (this.isNodePaused(agent.nodeId)) this.postSystem(msg, `${this.handleOf(agentId)}'s device is paused. The request is queued until it's resumed there.`);
      this.dispatchRun(runId);
    }
  }

  /** What follows "/" for this agent: its harness's commands on its device, its Warren skills, and Warren's own. */
  commands(agent: Agent): AgentCommand[] {
    const catalog = agent.nodeId ? this.store.nodeCatalog(agent.nodeId).find((h) => h.harness === agent.harness) : undefined;
    return agentCommands(catalog?.commands, this.skills.forAgent(agent.id));
  }

  /** The command a message runs for this agent ("/name args", or "@handle /name args" in a channel), if it names one it has. */
  commandFor(agent: Agent, body: string): (AgentCommand & { args: string }) | null {
    const parsed = parseCommand(body, agent.handle);
    if (!parsed) return null;
    const cmd = this.commands(agent).find((c) => c.name === parsed.name);
    return cmd ? { ...cmd, args: parsed.args } : null;
  }

  /** /context: how full the agent's conversation here is, from its last reply's usage. */
  private answerCommand(agent: Agent, msg: Message, threadId: string | null) {
    const usage = this.store.latestUsage(agent.id, msg.channelId, threadId);
    this.postMessage({ channelId: msg.channelId, threadId, author: { kind: "agent", id: agent.id }, body: "", parts: [{ type: "context", usage }], hop: msg.hop + 1, route: false });
  }

  private postSystem(near: Message, text: string) {
    const channel = this.store.channel(near.channelId)!;
    const sys = this.store.insertMessage({ channelId: near.channelId, threadId: near.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "status", text }], hop: near.hop });
    this.broadcast(channel.workspaceId, { type: "message", message: sys }, this.audience(channel.id));
    return sys;
  }

  /** The "queued until its device reconnects" note under a message no longer applies once its run starts. */
  private dropWaitingNotice(run: { channelId: string; threadId: string | null; triggerMessageId: string }, agent: Agent) {
    const trigger = run.triggerMessageId ? this.store.message(run.triggerMessageId) : undefined;
    if (!trigger) return;
    const isWaiting = (text: string) => (text.startsWith(`@${agent.handle} `) || text.startsWith(`@${agent.handle}'s `)) && text.includes("The request is queued");
    // the note is posted right after its message, so it's the first one for this agent from then on;
    // notes further down belong to later messages whose runs are still waiting
    const sys = this.store.systemNotices(trigger.channelId, trigger.threadId, trigger.createdAt).find((m) => m.parts.some((p) => p.type === "status" && isWaiting(p.text)));
    if (!sys) return;
    this.store.deleteMessage(sys.id);
    this.broadcast(agent.workspaceId, { type: "message_removed", messageId: sys.id, channelId: sys.channelId, threadId: sys.threadId }, this.audience(sys.channelId));
  }

  /** Send a queued run to its agent's device (if it's online; otherwise it waits until the device connects). */
  dispatchRun(runId: string) {
    const run = this.store.run(runId);
    if (!run || run.status !== "queued") return;
    const agent = this.store.agent(run.agentId);
    const conn = agent?.nodeId ? this.nodes.get(agent.nodeId) : undefined;
    if (!agent || !conn || this.pausedNodes.has(conn.nodeId)) return;
    // mark it running before the (async) prompt build so it can't be dispatched twice
    this.store.setRunStatus(run.id, "running");
    this.broadcast(conn.workspaceId, { type: "agent_status", agentId: agent.id, status: "busy" });
    if (run.kind === "background") this.background.started(run);
    else this.dropWaitingNotice(run, agent);
    // like a teammate saying "on it": the agent marks the message it picked up
    if (run.kind !== "background") this.react(run.triggerMessageId, { kind: "agent", id: agent.id }, "👀", true);
    // working again, so an earlier "needs you on my computer" no longer stands
    if (agent.computerId) this.computers.dropHelp(agent.computerId, agent.id);
    // lets browsers show "Nova: thinking" right away, before the harness streams anything
    if (run.kind !== "background") this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: agent.id, channelId: run.channelId, ...this.whereRuns(run), event: { type: "status", text: "started" } }, this.audience(run.channelId));
    this.buildPrompt(agent.id, run.channelId, run.threadId, run.triggerMessageId, run).then(
      async (prompt) => {
        // sign-ins to remote connectors that are about to expire are refreshed first
        await this.connectors.prepare(agent.id).catch(() => {});
        // looked up after the prompt so a task handed out in this same tick is linked to its thread by now
        const workspace = this.workspaceFor(run);
        // a task the agent starts on is being worked on
        const task = run.threadId ? this.store.taskByThread(run.threadId) : undefined;
        if (task && task.toAgentId === agent.id && task.status === "open") {
          this.store.updateTask(task.id, "in_progress");
          this.broadcast(conn.workspaceId, { type: "tasks_changed" });
        }
        // a VM on the agent's own device shares its folder with the agent's harness
        const c = agent.computerId ? this.store.computer(agent.computerId) : undefined;
        const computer: ComputerSpec | undefined = c?.kind === "vm" && c.nodeId === agent.nodeId ? this.computers.spec(c) : undefined;
        const inComputer = this.runsInComputer(agent);
        const connectors = this.connectors.specsFor(agent.id);
        // every background check starts a new session (the watch notes carry what it needs), on the model the person picked for checks
        const bg = run.kind === "background" && run.requestedBy ? this.store.background(agent.id, run.requestedBy) : undefined;
        this.send(conn, {
          type: "run",
          run: { runId: run.id, agentId: agent.id, channelId: run.channelId, threadId: run.kind === "background" ? BACKGROUND_THREAD : run.threadId, prompt, hop: run.hop, ...(run.kind === "background" ? { fresh: true } : {}), ...(bg?.model ? { model: bg.model } : {}), ...(bg?.effort ? { effort: bg.effort } : {}), ...(workspace ? { workspace } : {}), ...(computer ? { computer } : {}), ...(inComputer ? { inComputer } : {}), ...(connectors.length ? { connectors } : {}) },
        });
      },
      // the prompt couldn't be built (a vault read failed, say): say so like any other failure
      (err) => this.finishRun(conn.workspaceId, run, { error: `couldn't prepare the request: ${(err as Error).message}` }),
    );
  }

  /** Toggle (or force) a reaction and push the message's new reaction list to browsers. */
  react(messageId: string, actor: Actor, emoji: string, on?: boolean) {
    const msg = this.store.message(messageId);
    const channel = msg && this.store.channel(msg.channelId);
    if (!msg || !channel) return false;
    const added = this.store.toggleReaction(messageId, actor, emoji, on);
    this.broadcast(channel.workspaceId, { type: "reactions", messageId, channelId: msg.channelId, threadId: msg.threadId, reactions: this.store.reactions([messageId])[messageId] ?? [] }, this.audience(channel.id));
    return added;
  }

  /** Change a message's text. Agents aren't asked again: an edit fixes what was said, it isn't a new request. */
  editMessage(msg: Message, body: string) {
    const channel = this.store.channel(msg.channelId)!;
    const updated = this.store.withReactions([this.store.editMessage(msg.id, body)!])[0];
    this.broadcast(channel.workspaceId, { type: "message_updated", message: updated }, this.audience(channel.id));
    return updated;
  }

  /**
   * Delete a message. A thread root with replies is emptied instead of removed, so the replies stay
   * reachable; it goes for good once its last reply is deleted.
   */
  removeMessage(msg: Message): { kept: boolean } {
    const channel = this.store.channel(msg.channelId)!;
    const only = this.audience(channel.id);
    const pinned = this.store.pinnedIds([channel.id])[channel.id]?.includes(msg.id);
    let kept = false;
    // a message with replies (a thread, or a sub-thread in one) stays as a blank so its replies keep their place
    if ((this.store.replyCounts([msg.id])[msg.id] ?? 0) > 0) {
      this.broadcast(channel.workspaceId, { type: "message_updated", message: { ...this.store.blankMessage(msg.id)!, reactions: [] } }, only);
      kept = true;
    } else {
      this.store.deleteMessage(msg.id);
      this.broadcast(channel.workspaceId, { type: "message_removed", messageId: msg.id, channelId: msg.channelId, threadId: msg.threadId }, only);
      const root = msg.threadId ? this.store.message(msg.threadId) : undefined;
      if (root?.deletedAt && !this.store.replyCounts([root.id])[root.id]) {
        this.store.deleteMessage(root.id);
        this.broadcast(channel.workspaceId, { type: "message_removed", messageId: root.id, channelId: root.channelId, threadId: root.threadId }, only);
      }
    }
    if (pinned) this.broadcast(channel.workspaceId, { type: "channels_changed" });
    return { kept };
  }

  /** The run an agent is working on right now, if any (its latest, when several are running). */
  currentRun(agentId: string) {
    const r = this.store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(agentId) as { id: string } | undefined;
    return r ? this.store.run(r.id) : undefined;
  }

  /** Remember the answer already posted by task_update, only for runs working on that task. */
  taskReplyPosted(task: { toAgentId: string | null; channelId: string | null; threadId: string | null }, message: Message, result: string) {
    if (message.author.kind !== "agent" || message.author.id !== task.toAgentId || !result.trim()) return;
    const runs = this.store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND channel_id = ? AND thread_id = ? AND status = 'running'").all(task.toAgentId, task.channelId, task.threadId) as { id: string }[];
    for (const run of runs) this.taskReplies.set(run.id, { messageId: message.id, result: result.trim() });
  }

  cancelRun(runId: string) {
    const run = this.store.run(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    const agent = this.store.agent(run.agentId);
    const conn = agent?.nodeId ? this.nodes.get(agent.nodeId) : undefined;
    if (conn) this.send(conn, { type: "cancel", runId });
    this.store.setRunStatus(runId, "cancelled");
    this.live.delete(runId);
    this.taskReplies.delete(runId);
    // the device's late report is ignored, so clients hear from here that the agent is free again
    if (agent) this.broadcast(agent.workspaceId, { type: "agent_status", agentId: agent.id, status: this.agentStatus(agent) });
    // stopping one participant doesn't stop the discussion; it goes on without them
    if (run.discussionId) void this.discussions.onRunFinished(run, "");
    return true;
  }

  /** A run in a coding task's thread works in a checkout of the team's repo on the task's branch. */
  workspaceFor(run: { agentId: string; channelId: string; threadId: string | null }): RunWorkspace | undefined {
    const task = run.threadId ? this.store.taskByThread(run.threadId) : undefined;
    if (!task?.branch || task.channelId !== run.channelId) return undefined;
    const team = task.teamId ? this.store.team(task.teamId) : undefined;
    if (!team?.repo) return undefined;
    // the assignee commits on the branch; reviewers (and anyone else pulled in) get a read-only checkout of it
    const mode = !task.reviewOf && run.agentId === task.toAgentId ? "work" : "review";
    return { repo: team.repo, branch: task.branch, base: team.baseBranch, mode };
  }

  /** Ask a device to merge a branch into the base branch in its checkout of the repo. */
  requestMerge(agentId: string, w: { repo: string; branch: string; base: string }): Promise<{ ok: boolean; output: string }> {
    const agent = this.store.agent(agentId);
    const conn = agent?.nodeId ? this.nodes.get(agent.nodeId) : undefined;
    if (!agent || !conn) return Promise.resolve({ ok: false, output: `${agent ? `@${agent.handle}'s device` : "the device"} is offline` });
    const requestId = id("git");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingGit.delete(requestId);
        resolve({ ok: false, output: "the device didn't answer within 2 minutes" });
      }, 120_000);
      this.pendingGit.set(requestId, { resolve, timer });
      this.send(conn, { type: "merge", requestId, agentId, ...w });
    });
  }

  /** Where an agent is working right now (its running run), or its DM with an owner. */
  whereIs(agentId: string): { channelId: string; threadId: string | null } | null {
    const run = this.currentRun(agentId);
    if (run) return { channelId: run.channelId, threadId: run.threadId };
    const agent = this.store.agent(agentId);
    const owner = agent && this.store.members(agent.workspaceId).find((m) => m.role === "owner");
    return agent && owner ? { channelId: this.store.dmChannel(agent.workspaceId, owner.id, agent.id).id, threadId: null } : null;
  }

  // --- prompt ---------------------------------------------------------------

  /** How an agent should think about its computer. */
  computerSection(agentId: string): string {
    const agent = this.store.agent(agentId);
    const c: Computer | undefined = agent?.computerId ? this.store.computer(agent.computerId) : undefined;
    if (!agent || !c) return "";
    const node = c.nodeId ? this.store.node(c.nodeId) : undefined;
    const caps = c.nodeId ? this.store.nodeCapabilities(c.nodeId) : null;
    const os = caps?.platform === "darwin" ? "macOS" : caps?.platform === "win32" ? "Windows" : "Linux";
    const what =
      c.kind === "vm" ? `a Debian 13 desktop (a VM on ${node?.name ?? "a device"}) with Google Chrome, a terminal and a file manager on its dock` : c.kind === "orgo" ? "a Linux cloud computer (Orgo) with a browser and terminal" : `the screen of ${node?.name ?? "a device"} (${os})`;
    const sharing = this.store
      .agentsOnComputer(c.id)
      .filter((a) => a.id !== agentId)
      .map((a) => `@${a.handle}`);
    const lines = [
      `\n## Your computer`,
      `You have a computer: "${c.name}", ${what}. Use it like a person would: computer_screenshot to look, then computer_click, computer_type, computer_key, computer_scroll and computer_drag; computer_open opens a link, file or app${c.kind === "device" ? "" : "; computer_run runs a shell command on it"}. Each action returns a fresh screenshot; coordinates are pixels in the latest screenshot.`,
      `It keeps its files, browser and sign-ins between runs${sharing.length ? `, and you share it with ${sharing.join(", ")}` : ""}. People can watch it live and take control.`,
      `When you need a person (to sign in, enter a code, solve a captcha, or confirm something on screen), call computer_ask_human with exactly what you need and end your turn; you'll be woken when they hand the computer back. For a website sign-in, try login_fill first when you have it: it fills a login from the person's password manager without you seeing it. Never ask for passwords in chat.`,
    ];
    if (this.runsInComputer(agent)) {
      lines.push(
        `You run inside this computer: your shell, files and tools are all on it, and your working folder is ~/files (downloads land there too). You can install what you need with sudo. Nothing you do here touches anyone's own computer.`,
        `For websites, use the browser tools (browser_navigate, browser_snapshot, then browser_click / browser_type / browser_fill_form with the ref from the snapshot): they drive the Chrome people watch, with its sign-ins, and work on the page's elements, so they're faster and surer than clicking pixels. Use computer_screenshot and the other computer tools for everything that isn't a web page.`,
      );
    } else if (c.kind === "vm" && c.nodeId === agent.nodeId) {
      lines.push(
        `Your working folder is shared with the computer: it's ~/files there, and downloads land in it.`,
        `For websites, use the browser tools (browser_navigate, browser_snapshot, then browser_click / browser_type / browser_fill_form with the ref from the snapshot): they drive the computer's Chrome, the one people watch, with its sign-ins. Use the computer tools for everything else.`,
      );
    }
    if (c.kind === "device") {
      const owner = node?.ownerId ? (this.store.user(node.ownerId)?.name ?? "its owner") : "its owner";
      lines.push(
        `This is ${owner}'s own computer. You can use it only while ${owner} lends it to you, and only for things ${owner} asked for. Don't close their windows, change settings or read private things unless the task needs it.`,
      );
    }
    return lines.join("\n");
  }

  /** How an agent borrows a person's device when a task needs one, and what it has on loan now. */
  borrowSection(agentId: string): string {
    const agent = this.store.agent(agentId);
    if (!agent || agent.settings.headless) return "";
    const loans = this.store
      .loanedComputers()
      .filter((c) => c.workspaceId === agent.workspaceId && activeLoan(c)?.agentId === agentId)
      .map((c) => `"${c.name}" until ${new Date(activeLoan(c)!.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}`);
    const devices = this.computers.borrowable(agent.workspaceId, agentId).filter((d) => d.available);
    if (!loans.length && !devices.length) return "";
    return [
      `\n## Borrowing a person's device`,
      `Your own computer is your default: every computer_* tool acts on it. Only when a task needs an app or file that lives on a person's own device (say, the POS app on the shop PC), ask for its screen with device_request, say why, and end your turn; its owner decides how long you get and you'll be woken with the answer. Once you have it, add computer: "<device name>" to a computer_* tool to act on the device; leave it out to act on your own computer. Stay on what you asked for: it's their personal computer. Call device_return the moment you're done. The loan also ends when its time runs out or the owner takes it back, and you'll be told.`,
      loans.length ? `You're borrowing right now: ${loans.join(", ")}.` : "",
      devices.length ? `Devices you could ask for (device_list has the latest): ${devices.map((d) => `"${d.name}" (${d.owner}'s)`).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A message as an agent reads it in its history; an approval card shows the draft it was about and the answer. */
  historyLine(m: Message): string {
    const part = m.parts.find((p) => p.type === "approval");
    const a = part && part.type === "approval" ? this.store.approval(part.approvalId) : undefined;
    if (!a) return m.body;
    return `${m.body}${a.details ? `\n${a.details}` : ""}\n(${a.status === "pending" ? "not answered yet" : a.status}${a.note ? `: ${a.note}` : ""})`;
  }

  handleOf(agentId: string): string {
    return `@${this.store.agent(agentId)?.handle ?? "unknown"}`;
  }

  displayName(actor: Actor): string {
    if (actor.kind === "agent") return this.handleOf(actor.id);
    if (actor.id === "system") return "system";
    const u = this.store.user(actor.id);
    return u ? u.preferredName || u.name : "someone";
  }

  /** The agent's SOUL.md from its private vault folder, or "" if it doesn't have one. */
  async soul(agentId: string): Promise<string> {
    try {
      const agent = this.store.agent(agentId);
      if (!agent) return "";
      return (await this.vault(agent.workspaceId).read(soulPath(agentId))).content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    } catch {
      return "";
    }
  }

  /**
   * The channel's team, as this agent sees it: who leads, who hands work to whom, and what that
   * means for it. Everyone on the team knows everyone else on it. Empty when the channel has no
   * team or the agent isn't on it.
   */
  teamSection(channel: { name: string; settings: { team: ChannelTeam | null } }, agentId: string): string {
    const team = channel.settings.team;
    const me = team?.nodes.find((n) => n.agentId === agentId);
    if (!team || !me) return "";
    const live = team.nodes.filter((n) => this.store.agent(n.agentId));
    // its role on this team, else the one in its own settings
    const roleOf = (id: string) => team.nodes.find((n) => n.agentId === id)?.role?.trim() || this.store.agent(id)?.settings.role?.trim() || "";
    const describe = (id: string) => `${this.handleOf(id)} (${this.store.agent(id)!.name}${roleOf(id) ? `, ${roleOf(id)}` : ""})`;
    const handles = (ids: string[]) => ids.filter((id) => this.store.agent(id)).map(describe).join(", ");
    const leads = live.filter((n) => n.lead).map((n) => n.agentId);
    const fromMe = team.edges.filter((e) => e.from === agentId).map((e) => e.to);
    const toMe = team.edges.filter((e) => e.to === agentId).map((e) => e.from);
    const chart = live
      .map((n) => {
        const gives = team.edges.filter((e) => e.from === n.agentId).map((e) => this.handleOf(e.to));
        return `- ${describe(n.agentId)}${n.lead ? ", lead" : ""}${gives.length ? `; hands work to ${gives.join(", ")}` : ""}`;
      })
      .join("\n");
    const coLeads = leads.filter((l) => l !== agentId);
    const job = me.lead
      ? [
          `You ${coLeads.length ? `lead #${channel.name} together with ${handles(coLeads)}` : `lead #${channel.name}`}. New messages in the channel come to the leads${coLeads.length ? "; when they do, the leads first talk it over and agree on a plan in the thread, and only then hand out work" : ""}.`,
          fromMe.length
            ? `Plan the work, then hand each piece to the agent it fits with task_delegate (${handles(fromMe)} get work from you). Each hand-off opens its own sub-thread under the thread you're in, so people can follow it. Keep the thread posted: who's doing what, and the result when the pieces are in.`
            : "Nobody on the chart gets work from you, so do the work yourself.",
        ]
      : [
          `You get work in #${channel.name} from ${handles(toMe) || "the leads"}. Messages at the top of the channel go to the leads, not to you; you're woken when you're handed a task or someone @mentions you.`,
          fromMe.length ? `You can hand pieces of your work to ${handles(fromMe)} with task_delegate.` : "",
          "When you finish a task, report the result with task_update so whoever handed it to you hears back.",
        ];
    const role = me.role?.trim() ? `Your role here: ${me.role.trim()}.${me.roleNotes?.trim() ? ` ${me.roleNotes.trim()}` : ""}` : "";
    return [`## Your team in #${channel.name}`, role, ...job.filter(Boolean), `The whole team:\n${chart}`].filter(Boolean).join("\n");
  }

  /**
   * The prompt an agent receives: its soul (who it is), its instructions (its job),
   * where it is, the recent conversation, and the new message. Sent fresh every run so
   * edits to the soul or instructions apply to ongoing conversations too.
   */
  async buildPrompt(
    agentId: string,
    channelId: string,
    threadId: string | null,
    triggerId: string,
    run?: { id?: string; discussionId: string | null; phase: string | null; kind?: "background" | null; requestedBy?: string | null },
  ): Promise<string> {
    const { store } = this;
    const agent = store.agent(agentId)!;
    const channel = store.channel(channelId)!;
    // a background check has no message that woke it; it gets its own section instead
    const background = run?.kind === "background" && run.id ? await this.background.promptSection({ id: run.id, agentId, channelId, requestedBy: run.requestedBy ?? null }) : "";
    // a discussion thread is the whole conversation, so agents see all of it
    const history = background ? [] : store.messages(channelId, { threadId, limit: run?.discussionId ? 100 : CONTEXT_MESSAGES }).filter((m) => m.id !== triggerId && m.author.id !== "system");
    const discussion = run && !background ? this.discussions.promptSection(run) : "";
    const trigger = store.message(triggerId) ?? { body: "", parts: [], author: { kind: "user" as const, id: "system" } };
    // a harness's own command goes to it exactly as typed, into the same conversation
    const command = !background && trigger.author.kind === "user" ? this.commandFor(agent, trigger.body) : null;
    if (command?.via === "raw") return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    const others = store
      .agents(agent.workspaceId)
      .filter((a) => a.id !== agent.id)
      .map((a) => `@${a.handle} (${a.name}, ${a.harness}${a.settings.role?.trim() ? `, ${a.settings.role.trim()}` : ""})`);
    const where = channel.kind === "dm" ? "a direct message" : `#${channel.name}${threadId ? " (in a thread)" : ""}`;
    const channelNotes =
      channel.kind === "channel" && !background
        ? [
            channel.topic.trim() ? `#${channel.name} is for: ${channel.topic.trim()}` : "",
            channel.settings.defaultAgentId === agent.id ? `You answer messages in #${channel.name} that don't @mention anyone, so not every message here needs a long reply.` : "",
            channel.settings.instructions.trim() ? `Notes from the people in #${channel.name}; follow them while you work here:\n${channel.settings.instructions.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";
    const teamNotes = channel.kind === "channel" && !background ? this.teamSection(channel, agent.id) : "";
    // a sub-thread branched off another thread: what was said there, so the agent isn't lost
    const parentId = threadId ? store.message(threadId)?.threadId : null;
    const parentThread = parentId && !background ? store.messages(channelId, { threadId: parentId, limit: 10 }).filter((m) => m.author.id !== "system" && m.id !== threadId) : [];
    const forUser = background && run?.requestedBy ? store.user(run.requestedBy) : undefined;
    const person = forUser ? { id: forUser.id, name: forUser.name } : this.memory.personFor(agent.workspaceId, channelId, threadId, triggerId);
    // the person's own clock, so "tomorrow morning" means theirs
    const user = person ? store.user(person.id) : undefined;
    const tz = user?.timezone ?? null;
    const localTime = user
      ? `It's ${new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : { timeZone: "UTC", timeZoneName: "short" }) })} for ${user.preferredName || user.name}${tz ? ` (${tz})` : ""}.`
      : "";
    const asks = agentPolicy(this, agent.workspaceId).askBefore.map((k) => ASK_BEFORE_TEXT[k]);
    const [soul, memory, routines] = await Promise.all([this.soul(agent.id), this.memory.sections(agent, { person, query: trigger.body }), this.routines.promptSection(agent.id, trigger)]);
    const leading = leadSection(store, agent);
    const making = background ? "" : spawnSection(this, agent);
    await this.ensureBuiltinSkills([agent.id]);
    const skills = this.skills.promptSection(agent.id);
    const connectors = this.connectors.promptSection(agent.id);
    const soulNote = agent.settings.soulLocked
      ? "Your soul is locked by your owner; don't try to edit it."
      : "As you learn who you are, you may refine it with memory_write on me/SOUL.md. Keep it short.";

    return [
      `You are @${agent.handle} ("${agent.name}"), an agent in the Warren workspace "${store.workspace(agent.workspaceId)?.name}".`,
      // models often don't know their exact version, so say what this agent actually runs on
      `You run in ${harnessLabel(agent.harness)} with ${agent.model ? `the model "${agent.model}"` : "its default model"}${agent.settings.effort ? ` at ${agent.settings.effort} reasoning effort` : ""}. If asked what model you are, say exactly that.`,
      soul ? `\n## Your soul (me/SOUL.md): who you are\n${soul}\n\n${soulNote}` : "",
      agent.settings.role?.trim() ? `\n## Your role\nYou are the workspace's ${agent.settings.role.trim()}.${agent.settings.roleNotes?.trim() ? ` ${agent.settings.roleNotes.trim()}` : ""}` : "",
      agent.instructions ? `\n## Your instructions (from your owner): your job\n${agent.instructions}` : "",
      leading ? `\n${leading}` : "",
      making ? `\n${making}` : "",
      memory ? `\n${memory}` : "",
      `\n## Where you are`,
      background ? `Other agents in the workspace: ${others.join(", ") || "none yet"}.` : `You are replying in ${where}. Other agents you can bring in by @mentioning them: ${others.join(", ") || "none yet"}.`,
      channelNotes ? `\n## This channel\n${channelNotes}` : "",
      teamNotes ? `\n${teamNotes}` : "",
      `Your memory vault: your private notes live under agents/${agent.id}/ (shorthand me/), shared notes under shared/, and people may give you other folders. Use the warren MCP tools (memory_search, memory_read, memory_write, memory_remember, memory_share) when they are available, and follow your memory skill (me/skills/memory/SKILL.md) whenever you save something.`,
      background ? "" : `Reply with the message you want posted. Keep it conversational; only @mention another agent when you actually need them to act.`,
      asks.length
        ? `Before any of these that nobody asked for in so many words: ${asks.join("; ")}, ask first with approval_request and end your turn; you'll be woken with the answer. Ask about anything else that's hard to undo, too.`
        : `When something is hard to undo and nobody asked for it in so many words, ask first with approval_request and end your turn; you'll be woken with the answer.`,
      background ? "" : `To come back to something at a set time (a reminder they asked for, checking whether a reply came), use followup_set; you'll be woken then.`,
      background ? "" : `When someone asks you to change how Warren works for them (how often you check in, quiet hours, what to watch, turning a mod on or off), do it with settings_read and settings_change instead of sending them to Settings.`,
      localTime,
      this.computerSection(agent.id),
      this.borrowSection(agent.id),
      skills ? `\n${skills}` : "",
      connectors ? `\n${connectors}` : "",
      routines ? `\n${routines}` : "",
      discussion ? `\n${discussion}` : "",
      background,
      parentThread.length ? `\nThis is a sub-thread. Earlier, in the thread it branched off from:\n${parentThread.map((m) => `${this.displayName(m.author)}: ${this.historyLine(m)}`).join("\n")}` : "",
      history.length ? `\nRecent conversation:\n${history.map((m) => `${this.displayName(m.author)}: ${this.historyLine(m)}`).join("\n")}` : "",
      background ? "" : `\nNew message from ${this.displayName(trigger.author)}:\n${command?.via === "prompt" ? skillRequest(command.name, command.args) : trigger.body}${taskInstructions(store, agent.id, trigger)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * A reply that asks the person to do something on the screen ("Please sign in to Zendesk and
 * I'll continue"), as the sentence that says so; null for an ordinary answer.
 */
export function asksForHand(body: string): string | null {
  const thing = /\b(sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|password|2fa|two[- ]factor|verification|one[- ]time|captcha|security code|passcode|authenticat\w*|approve the|take (?:over|control))\b/i;
  const ask = /\b(please|can you|could you|would you|need you|needs you|i need|your help|once you(?:'ve| have)?|when you(?:'ve| have)?|let me know when|hand (?:it )?back)\b/i;
  const sentences = body.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => thing.test(s) && ask.test(s));
  return hit ? hit.trim().slice(0, 300) : null;
}

function collect(live: LiveRun, e: AgentEvent) {
  if (e.type === "text") live.text += e.text;
  else if (e.type === "notice") live.parts.push({ type: "notice", text: e.text });
  else if (e.type === "tool_call") live.parts.push({ type: "tool_call", name: e.name, input: e.input });
  else if (e.type === "tool_result") {
    const call = [...live.parts].reverse().find((p) => p.type === "tool_call" && p.name === e.name && p.output === undefined);
    if (call && call.type === "tool_call") call.output = e.output;
  }
}
