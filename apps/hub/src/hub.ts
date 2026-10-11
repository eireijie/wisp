import type { WebSocket } from "ws";
import { HubToNode, LoopGuard, NodeToHub, harnessLabel, parseMentions, readTunnelFrame, soulPath, type Actor, type AgentEvent, type ClientEvent, type Computer, type ComputerSpec, type Message, type MessagePart, type RunWorkspace } from "@warren/core";
import { id } from "./auth.ts";
import { Computers } from "./computers.ts";
import { Discussions } from "./discussions.ts";
import { Routines } from "./routines.ts";
import type { Vault } from "@warren/vault";
import { MemoryAccess } from "./access.ts";
import { AgentMemory } from "./memory.ts";
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
  readonly guard = new LoopGuard();
  readonly access: MemoryAccess;
  readonly memory: AgentMemory;
  readonly discussions: Discussions;
  readonly computers: Computers;
  readonly routines: Routines;
  /** how the hub reaches outside services (Orgo); tests swap it */
  fetchImpl: typeof fetch = (...args) => fetch(...args);
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

  broadcast(workspaceId: string, event: ClientEvent) {
    const data = JSON.stringify(event);
    for (const c of this.clients) if (c.workspaceId === workspaceId && c.socket.readyState === 1) c.socket.send(data);
  }

  // --- nodes ----------------------------------------------------------------

  isNodeOnline(nodeId: string | null): boolean {
    return !!nodeId && this.nodes.has(nodeId);
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
      for (const a of this.store.agentsOnNode(nodeId)) this.broadcast(workspaceId, { type: "agent_status", agentId: a.id, status: "offline" });
      this.computers.nodeGone(nodeId);
    });
  }

  private onNodeMessage(conn: NodeConn, msg: NodeToHub) {
    const { store } = this;
    switch (msg.type) {
      case "hello": {
        store.touchNode(conn.nodeId, msg.nodeName);
        for (const a of store.agentsOnNode(conn.nodeId)) this.broadcast(conn.workspaceId, { type: "agent_status", agentId: a.id, status: this.agentStatus(a) });
        for (const r of store.queuedRunsForNode(conn.nodeId)) this.dispatchRun(r.id);
        this.computers.nodeBack(conn.nodeId);
        return;
      }
      case "capabilities": {
        store.setNodeCapabilities(conn.nodeId, msg.capabilities);
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
        this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: run.agentId, channelId: run.channelId, event: msg.event });
        return;
      }
      case "run_done":
      case "run_failed": {
        const run = this.ownedRun(conn, msg.runId);
        if (!run || run.status === "done" || run.status === "failed") return;
        const live = this.live.get(run.id) ?? { parts: [], text: "" };
        this.live.delete(run.id);
        const author: Actor = { kind: "agent", id: run.agentId };
        // in a discussion, replies don't wake anyone: the discussion moves on by itself
        const route = run.discussionId ? false : undefined;
        let body = "";
        if (msg.type === "run_done") {
          store.setRunStatus(run.id, "done");
          body = msg.finalText.trim() || live.text.trim();
          if (body) this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body, parts: live.parts, hop: run.hop + 1, route });
        } else {
          store.setRunStatus(run.id, "failed", msg.error);
          this.postMessage({ channelId: run.channelId, threadId: run.threadId, author, body: "", parts: [...live.parts, { type: "status", text: `Run failed: ${msg.error}` }], hop: run.hop + 1, route: false });
        }
        const agent = store.agent(run.agentId);
        if (agent) this.broadcast(conn.workspaceId, { type: "agent_status", agentId: agent.id, status: this.agentStatus(agent) });
        if (run.discussionId) void this.discussions.onRunFinished(run, body);
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

  /** Persist a message, broadcast it, and start runs for any agents it addresses. */
  postMessage(m: { channelId: string; threadId?: string | null; author: Actor; body: string; parts?: MessagePart[]; hop?: number; route?: boolean; replyInThread?: boolean }): Message {
    const channel = this.store.channel(m.channelId);
    if (!channel) throw new Error("channel not found");
    const msg = this.store.insertMessage(m);
    this.broadcast(channel.workspaceId, { type: "message", message: msg });
    if (m.route !== false) this.route(msg, channel.workspaceId, m.replyInThread ?? false);
    return msg;
  }

  /** Decide which agents should respond to a message. */
  targets(msg: Message, workspaceId: string): string[] {
    const { store } = this;
    const out = new Set<string>();
    for (const handle of parseMentions(msg.body)) {
      const a = store.agentByHandle(workspaceId, handle);
      if (a) out.add(a.id);
    }
    const channel = store.channel(msg.channelId);
    if (channel?.kind === "dm" && msg.author.kind === "user") {
      for (const m of store.channelMembers(channel.id)) if (m.kind === "agent") out.add(m.id);
    }
    // A plain reply in a thread an agent started goes back to that agent.
    if (!out.size && msg.threadId && msg.author.kind === "user") {
      const root = store.message(msg.threadId);
      if (root?.author.kind === "agent") out.add(root.author.id);
    }
    if (msg.author.kind === "agent") out.delete(msg.author.id);
    return [...out];
  }

  private route(msg: Message, workspaceId: string, replyInThread: boolean) {
    const threadId = msg.threadId ?? (replyInThread ? msg.id : null);
    for (const agentId of this.targets(msg, workspaceId)) {
      const verdict = this.guard.allow(msg.channelId, msg.hop);
      if (!verdict.ok) {
        this.postSystem(msg, `Not waking ${this.handleOf(agentId)}: ${verdict.reason}.`);
        continue;
      }
      const runId = this.store.createRun({ agentId, channelId: msg.channelId, threadId, triggerMessageId: msg.id, hop: msg.hop });
      const agent = this.store.agent(agentId)!;
      if (!agent.nodeId) this.postSystem(msg, `${this.handleOf(agentId)} isn't connected to a node yet. The request is queued.`);
      else if (!this.isNodeOnline(agent.nodeId)) this.postSystem(msg, `${this.handleOf(agentId)} is offline. The request is queued until its node reconnects.`);
      this.dispatchRun(runId);
    }
  }

  private postSystem(near: Message, text: string) {
    const channel = this.store.channel(near.channelId)!;
    const sys = this.store.insertMessage({ channelId: near.channelId, threadId: near.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "status", text }], hop: near.hop });
    this.broadcast(channel.workspaceId, { type: "message", message: sys });
  }

  /** Send a queued run to its agent's device (if it's online; otherwise it waits until the device connects). */
  dispatchRun(runId: string) {
    const run = this.store.run(runId);
    if (!run || run.status !== "queued") return;
    const agent = this.store.agent(run.agentId);
    const conn = agent?.nodeId ? this.nodes.get(agent.nodeId) : undefined;
    if (!agent || !conn) return;
    // mark it running before the (async) prompt build so it can't be dispatched twice
    this.store.setRunStatus(run.id, "running");
    this.broadcast(conn.workspaceId, { type: "agent_status", agentId: agent.id, status: "busy" });
    // like a teammate saying "on it": the agent marks the message it picked up
    this.react(run.triggerMessageId, { kind: "agent", id: agent.id }, "👀", true);
    // lets browsers show "Nova: thinking" right away, before the harness streams anything
    this.broadcast(conn.workspaceId, { type: "run_event", runId: run.id, agentId: agent.id, channelId: run.channelId, event: { type: "status", text: "started" } });
    this.buildPrompt(agent.id, run.channelId, run.threadId, run.triggerMessageId, run).then(
      (prompt) => {
        // looked up after the prompt so a task handed out in this same tick is linked to its thread by now
        const workspace = this.workspaceFor(run);
        // a VM on the agent's own device shares its folder with the agent's harness
        const c = agent.computerId ? this.store.computer(agent.computerId) : undefined;
        const computer: ComputerSpec | undefined = c?.kind === "vm" && c.nodeId === agent.nodeId ? this.computers.spec(c) : undefined;
        this.send(conn, { type: "run", run: { runId: run.id, agentId: agent.id, channelId: run.channelId, threadId: run.threadId, prompt, hop: run.hop, ...(workspace ? { workspace } : {}), ...(computer ? { computer } : {}) } });
      },
      (err) => this.store.setRunStatus(run.id, "failed", (err as Error).message),
    );
  }

  /** Toggle (or force) a reaction and push the message's new reaction list to browsers. */
  react(messageId: string, actor: Actor, emoji: string, on?: boolean) {
    const msg = this.store.message(messageId);
    const channel = msg && this.store.channel(msg.channelId);
    if (!msg || !channel) return false;
    const added = this.store.toggleReaction(messageId, actor, emoji, on);
    this.broadcast(channel.workspaceId, { type: "reactions", messageId, channelId: msg.channelId, threadId: msg.threadId, reactions: this.store.reactions([messageId])[messageId] ?? [] });
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
      c.kind === "vm" ? `a Linux desktop (a VM on ${node?.name ?? "a device"}) with Chromium, a terminal and a file manager` : c.kind === "orgo" ? "a Linux cloud computer (Orgo) with a browser and terminal" : `the screen of ${node?.name ?? "a device"} (${os})`;
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
    if (c.kind === "vm" && c.nodeId === agent.nodeId) lines.push(`Your working folder is shared with the computer: it's ~/files there, and downloads land in it.`);
    if (c.kind === "device") lines.push(`This is a person's own computer: don't close their windows, change settings or read private things unless the task needs it.`);
    return lines.join("\n");
  }

  handleOf(agentId: string): string {
    return `@${this.store.agent(agentId)?.handle ?? "unknown"}`;
  }

  displayName(actor: Actor): string {
    if (actor.kind === "agent") return this.handleOf(actor.id);
    if (actor.id === "system") return "system";
    return this.store.user(actor.id)?.name ?? "someone";
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
  async buildPrompt(agentId: string, channelId: string, threadId: string | null, triggerId: string, run?: { discussionId: string | null; phase: string | null }): Promise<string> {
    const { store } = this;
    const agent = store.agent(agentId)!;
    const channel = store.channel(channelId)!;
    // a discussion thread is the whole conversation, so agents see all of it
    const history = store.messages(channelId, { threadId, limit: run?.discussionId ? 100 : CONTEXT_MESSAGES }).filter((m) => m.id !== triggerId && m.author.id !== "system");
    const discussion = run ? this.discussions.promptSection(run) : "";
    const trigger = store.message(triggerId)!;
    const others = store
      .agents(agent.workspaceId)
      .filter((a) => a.id !== agent.id)
      .map((a) => `@${a.handle} (${a.name}, ${a.harness})`);
    const where = channel.kind === "dm" ? "a direct message" : `#${channel.name}${threadId ? " (in a thread)" : ""}`;
    const person = this.memory.personFor(agent.workspaceId, channelId, threadId, triggerId);
    const [soul, memory, routines] = await Promise.all([this.soul(agent.id), this.memory.sections(agent, { person, query: trigger.body }), this.routines.promptSection(agent.id, trigger)]);
    const soulNote = agent.settings.soulLocked
      ? "Your soul is locked by your owner; don't try to edit it."
      : "As you learn who you are, you may refine it with memory_write on me/SOUL.md. Keep it short.";

    return [
      `You are @${agent.handle} ("${agent.name}"), an agent in the Warren workspace "${store.workspace(agent.workspaceId)?.name}".`,
      // models often don't know their exact version, so say what this agent actually runs on
      `You run in ${harnessLabel(agent.harness)} with ${agent.model ? `the model "${agent.model}"` : "its default model"}${agent.settings.effort ? ` at ${agent.settings.effort} reasoning effort` : ""}. If asked what model you are, say exactly that.`,
      soul ? `\n## Your soul (me/SOUL.md): who you are\n${soul}\n\n${soulNote}` : "",
      agent.instructions ? `\n## Your instructions (from your owner): your job\n${agent.instructions}` : "",
      memory ? `\n${memory}` : "",
      `\n## Where you are`,
      `You are replying in ${where}. Other agents you can bring in by @mentioning them: ${others.join(", ") || "none yet"}.`,
      `Your memory vault: your private notes live under agents/${agent.id}/ (shorthand me/), shared notes under shared/, and people may give you other folders. Use the warren MCP tools (memory_search, memory_read, memory_write, memory_remember, memory_share) when they are available.`,
      `Reply with the message you want posted. Keep it conversational; only @mention another agent when you actually need them to act.`,
      `Before anything sensitive or hard to undo that nobody asked for in so many words (sending email or messages outside Warren, buying something, deleting things, posting publicly), ask first with approval_request and end your turn; you'll be woken with the answer.`,
      this.computerSection(agent.id),
      routines ? `\n${routines}` : "",
      discussion ? `\n${discussion}` : "",
      history.length ? `\nRecent conversation:\n${history.map((m) => `${this.displayName(m.author)}: ${m.body}`).join("\n")}` : "",
      `\nNew message from ${this.displayName(trigger.author)}:\n${trigger.body}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function collect(live: LiveRun, e: AgentEvent) {
  if (e.type === "text") live.text += e.text;
  else if (e.type === "tool_call") live.parts.push({ type: "tool_call", name: e.name, input: e.input });
  else if (e.type === "tool_result") {
    const call = [...live.parts].reverse().find((p) => p.type === "tool_call" && p.name === e.name && p.output === undefined);
    if (call && call.type === "tool_call") call.output = e.output;
  }
}
