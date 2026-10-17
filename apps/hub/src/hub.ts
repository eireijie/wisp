import type { WebSocket } from "ws";
import { HubToNode, LoopGuard, NodeToHub, harnessLabel, runsInVm, signInProblem, type Agent, activeLoan, parseMentions, readTunnelFrame, soulPath, type Actor, type AgentEvent, type ClientEvent, type Computer, type ComputerSpec, type Message, type MessagePart, type RunWorkspace } from "@warren/core";
import { id } from "./auth.ts";
import { Computers } from "./computers.ts";
import { Discussions } from "./discussions.ts";
import { Apns } from "./apns.ts";
import { Routines } from "./routines.ts";
import { BACKGROUND_THREAD, Background } from "./background.ts";
import { Push } from "./push.ts";
import { Marketplace } from "./marketplace.ts";
import { Updates } from "./updates.ts";
import { ConnectorStore, SkillStore } from "./connectors.ts";
import type { Vault } from "@warren/vault";
import { MemoryAccess } from "./access.ts";
import { ASK_BEFORE_TEXT, agentPolicy } from "./policy.ts";
import { AgentMemory } from "./memory.ts";
import { failTaskOfRun, leadSection, taskInstructions } from "./lead.ts";
import type { Store } from "./store.ts";

const CONTEXT_MESSAGES = 20;

interface ClientConn {
  socket: WebSocket;
  workspaceId: string;
  userId: string;
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
  private closed = false;
  private clients = new Set<ClientConn>();
  private nodes = new Map<string, NodeConn>();
  private live = new Map<string, LiveRun>();
  /** devices whose owner ran `warren node pause` there */
  private pausedNodes = new Set<string>();
  readonly guard = new LoopGuard();
  readonly access: MemoryAccess;
  readonly memory: AgentMemory;
  readonly discussions: Discussions;
  readonly computers: Computers;
  readonly routines: Routines;
  readonly background: Background;
  readonly push: Push;
  readonly marketplace: Marketplace;
  readonly updates: Updates;
  readonly connectors: ConnectorStore;
  readonly skills: SkillStore;
  /** iOS push notifications (optional; needs an APNs key) */
  readonly apns: Apns;
  /** how the hub reaches outside services (Orgo); tests swap it */
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  /** where Orgo computers' screens are (websockify); tests point it at a fake */
  orgoWs = "wss://www.orgo.ai";
  /** git operations waiting for a device to answer */
  private pendingGit = new Map<string, { resolve: (r: { ok: boolean; output: string }) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    readonly store: Store,
    readonly vault: Vault,
  ) {
    this.access = new MemoryAccess(store);
    this.memory = new AgentMemory(store, vault, this.access);
    this.discussions = new Discussions(this);
    this.computers = new Computers(this);
    this.routines = new Routines(this);
    this.background = new Background(this);
    this.push = new Push(this);
    this.marketplace = new Marketplace(this);
    this.updates = new Updates(this);
    this.connectors = new ConnectorStore(store.db);
    this.skills = new SkillStore(store.db);
    this.apns = new Apns(this);
  }

  /** Every team has its own channel and a brief; teams that came from v0.1 groups get them here. */
  async ensureTeams() {
    const rows = this.store.db.prepare("SELECT id, workspace_id FROM teams WHERE channel_id IS NULL").all() as { id: string; workspace_id: string }[];
    for (const r of rows) {
      const team = this.store.team(r.id)!;
      const name = `team-${team.name}`;
      const channel = this.store.channelByName(r.workspace_id, name) ?? this.store.createChannel(r.workspace_id, name, "channel", `Team ${team.name}`);
      this.store.updateTeam(team.id, { channelId: channel.id });
      for (const m of team.members) this.store.addChannelMember(channel.id, { kind: "agent", id: m.agentId });
      for (const p of this.store.members(r.workspace_id).filter((m) => m.role === "owner")) this.store.addChannelMember(channel.id, { kind: "user", id: p.id });
      const brief = `${team.folder}/README.md`;
      if (!this.vault.list((p) => p.toLowerCase() === brief.toLowerCase()).length) {
        await this.vault
          .write(brief, `# Team ${team.name}\n\nWhat this team is for, what it's working on, and how it works. The lead keeps this up to date.\n`, { name: "Warren", email: "warren@localhost" }, `Brief for team ${team.name}`)
          .catch(() => undefined);
      }
    }
  }

  /** Stop handling events and drop every connection (before the database closes). */
  shutdown() {
    this.closed = true;
    this.computers.shutdown();
    this.routines.stop();
    this.background.stop();
    for (const c of this.clients) c.socket.terminate();
    for (const n of this.nodes.values()) n.socket.terminate();
    this.clients.clear();
    this.nodes.clear();
  }

  // --- browser clients ------------------------------------------------------

  addClient(socket: WebSocket, workspaceId: string, userId: string) {
    const c = { socket, workspaceId, userId };
    this.clients.add(c);
    socket.on("close", () => this.clients.delete(c));
  }

  /** Send an event to everyone in a workspace, or only to the people `only` picks. */
  broadcast(workspaceId: string, event: ClientEvent, only?: (userId: string) => boolean) {
    const data = JSON.stringify(event);
    for (const c of this.clients) if (c.workspaceId === workspaceId && c.socket.readyState === 1 && (!only || only(c.userId))) c.socket.send(data);
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
      case "discovered": {
        store.setNodeDiscovered(conn.nodeId, msg.agents);
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
        if (run.kind !== "background") this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: run.agentId, channelId: run.channelId, event: msg.event }, this.audience(run.channelId));
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
      if (body && !gone) this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body, parts: live.parts, hop: run.hop + 1, route, onBehalfOf: run.requestedBy });
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

  private route(msg: Message, workspaceId: string, replyInThread: boolean, requestedBy: string | null) {
    // a channel can ask agents to answer people in a thread under their message
    const tidy = msg.author.kind === "user" && this.store.channel(msg.channelId)?.settings.replyInThread;
    const threadId = msg.threadId ?? (replyInThread || tidy ? msg.id : null);
    for (const agentId of this.targets(msg, workspaceId)) {
      const agent = this.store.agent(agentId)!;
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
      const runId = this.store.createRun({ agentId, channelId: msg.channelId, threadId, triggerMessageId: msg.id, hop: msg.hop, requestedBy });
      if (!agent.nodeId) this.postSystem(msg, `${this.handleOf(agentId)} isn't connected to a device yet. The request is queued.`);
      else if (!this.isNodeOnline(agent.nodeId)) this.postSystem(msg, `${this.handleOf(agentId)} is offline. The request is queued until its device reconnects.`);
      else if (this.isNodePaused(agent.nodeId)) this.postSystem(msg, `${this.handleOf(agentId)}'s device is paused. The request is queued until it's resumed there.`);
      this.dispatchRun(runId);
    }
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
    if (run.kind !== "background") this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: agent.id, channelId: run.channelId, event: { type: "status", text: "started" } }, this.audience(run.channelId));
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

  /** The run an agent is working on right now, if any (its latest, when several are running). */
  currentRun(agentId: string) {
    const r = this.store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(agentId) as { id: string } | undefined;
    return r ? this.store.run(r.id) : undefined;
  }

  cancelRun(runId: string) {
    const run = this.store.run(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return false;
    const agent = this.store.agent(run.agentId);
    const conn = agent?.nodeId ? this.nodes.get(agent.nodeId) : undefined;
    if (conn) this.send(conn, { type: "cancel", runId });
    this.store.setRunStatus(runId, "cancelled");
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
      `When you need a person (to sign in, enter a code, solve a captcha, or confirm something on screen), call computer_ask_human with exactly what you need and end your turn; you'll be woken when they hand the computer back. Never ask for passwords in chat.`,
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
      return (await this.vault.read(soulPath(agentId))).content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    } catch {
      return "";
    }
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
      memory ? `\n${memory}` : "",
      `\n## Where you are`,
      background ? `Other agents in the workspace: ${others.join(", ") || "none yet"}.` : `You are replying in ${where}. Other agents you can bring in by @mentioning them: ${others.join(", ") || "none yet"}.`,
      channelNotes ? `\n## This channel\n${channelNotes}` : "",
      `Your memory vault: your private notes live under agents/${agent.id}/ (shorthand me/), shared notes under shared/, and people may give you other folders. Use the warren MCP tools (memory_search, memory_read, memory_write, memory_remember, memory_share) when they are available.`,
      background ? "" : `Reply with the message you want posted. Keep it conversational; only @mention another agent when you actually need them to act.`,
      asks.length
        ? `Before any of these that nobody asked for in so many words: ${asks.join("; ")}, ask first with approval_request and end your turn; you'll be woken with the answer. Ask about anything else that's hard to undo, too.`
        : `When something is hard to undo and nobody asked for it in so many words, ask first with approval_request and end your turn; you'll be woken with the answer.`,
      background ? "" : `To come back to something at a set time (a reminder they asked for, checking whether a reply came), use followup_set; you'll be woken then.`,
      localTime,
      this.computerSection(agent.id),
      this.borrowSection(agent.id),
      skills ? `\n${skills}` : "",
      connectors ? `\n${connectors}` : "",
      routines ? `\n${routines}` : "",
      discussion ? `\n${discussion}` : "",
      background,
      history.length ? `\nRecent conversation:\n${history.map((m) => `${this.displayName(m.author)}: ${this.historyLine(m)}`).join("\n")}` : "",
      background ? "" : `\nNew message from ${this.displayName(trigger.author)}:\n${trigger.body}${taskInstructions(store, agent.id, trigger)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
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
