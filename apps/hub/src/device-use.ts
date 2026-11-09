import type { Agent, Approval, Computer } from "@wisp/core";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";

/** How long "Allow for this task" lasts. */
export const TASK_GRANT_MS = 2 * 60 * 60_000;

/**
 * "Use my computers": an agent working for a device's owner may use that person's own computer
 * when they allowed it on the agent's Computer page: "ask" asks them first for each task (a card
 * with Allow for this task / Not now), "tell" goes ahead and says so in chat afterwards. The
 * screen still has to be turned on at the device, and one locked with a code opens only with it.
 */
export class DeviceUse {
  /** "agentId:nodeId" → until when "Allow for this task" lets it */
  private grants = new Map<string, number>();
  /** per run, the devices it used and from when to when, for "tell" */
  private used = new Map<string, Map<string, { from: number; to: number }>>();

  constructor(private hub: Hub) {}

  /** The devices this agent may use, with how, for its tools. */
  list(agent: Agent): { id: string; name: string; how: "ask" | "tell"; online: boolean; screenOn: boolean }[] {
    return Object.entries(agent.settings.useDevices ?? {}).flatMap(([nodeId, how]) => {
      const node = this.hub.store.node(nodeId);
      if (!node || node.workspaceId !== agent.workspaceId) return [];
      const screen = this.hub.store.nodeCapabilities(nodeId)?.screen;
      return [{ id: nodeId, name: node.name, how, online: this.hub.isNodeOnline(nodeId), screenOn: !!screen?.ok && !screen.off }];
    });
  }

  /** The device an agent named ("MacBook Air", or its id), among the workspace's. */
  private find(agent: Agent, on: string) {
    const want = on.trim().toLowerCase();
    const nodes = this.hub.store.nodes(agent.workspaceId);
    return nodes.find((n) => n.id === on) ?? nodes.find((n) => n.name.toLowerCase() === want) ?? nodes.find((n) => n.name.toLowerCase().includes(want));
  }

  /**
   * Check that this agent may use `on` now, for work `requester` asked for, and return the device's
   * screen as a computer. "ask" without a yes yet posts the card and throws (the agent ends its
   * turn and hears back), so a call only gets through once allowed.
   */
  use(agent: Agent, on: string, requester: string | null, reason: string): Computer {
    const { store } = this.hub;
    const node = this.find(agent, on);
    if (!node) throw new ComputerError(`There's no device called "${on}". Your choices: ${this.list(agent).map((d) => d.name).join(", ") || "none"}.`, 404);
    const how = agent.settings.useDevices?.[node.id];
    const owner = node.ownerId ? (store.user(node.ownerId)?.name ?? "its owner") : "its owner";
    if (!how || !node.ownerId) throw new ComputerError(`You can't use ${node.name}. Only ${owner} can allow it, on your Computer page (Use my computers).`, 403);
    if (requester !== node.ownerId) throw new ComputerError(`${node.name} is ${owner}'s own computer, so you can only use it for things ${owner} asked for.`, 403);
    let screen = store.computersOnNode(node.id).find((c) => c.kind === "device");
    if (!screen) screen = store.createComputer({ workspaceId: agent.workspaceId, name: node.name, kind: "device", nodeId: node.id, config: {}, status: "ready" });
    if (how === "ask" && (this.grants.get(`${agent.id}:${node.id}`) ?? 0) < Date.now()) {
      this.ask(agent, node, screen, reason);
      throw new ComputerError(`Asked ${owner} whether you can use ${node.name} for this. End your turn now; you'll get a message once they answer.`, 409);
    }
    return screen;
  }

  private ask(agent: Agent, node: { id: string; name: string; ownerId: string | null }, screen: Computer, reason: string) {
    const { store } = this.hub;
    // one card at a time for the same thing
    const open = store.approvals(agent.workspaceId, "pending").find((a) => a.agentId === agent.id && a.device?.nodeId === node.id);
    if (open) return;
    const where = this.hub.whereIs(agent.id);
    if (!where) throw new ComputerError("nobody to ask: this workspace has no owner", 409);
    const device = { nodeId: node.id, deviceName: node.name, ownerId: node.ownerId!, code: this.hub.computers.codeKind(screen) };
    const approval = store.createApproval({ workspaceId: agent.workspaceId, agentId: agent.id, ...where, summary: `Use your ${node.name}?`, details: reason.trim().slice(0, 2000), device });
    this.hub.postMessage({ ...where, author: { kind: "agent", id: agent.id }, body: `Can I use your ${node.name}? ${reason.trim()}`.trim(), parts: [{ type: "approval", approvalId: approval.id }], route: false });
  }

  /**
   * Its owner answered. A yes lets the agent use it for this task (and, for a screen with a code,
   * opens it for the agent with that code meanwhile); the agent is told either way.
   */
  async decide(a: Approval, approve: boolean, code: string | undefined): Promise<string> {
    const d = a.device!;
    const key = `${a.agentId}:${d.nodeId}`;
    if (!approve) {
      this.grants.delete(key);
      return `Don't use ${d.deviceName} for this.`;
    }
    const until = Date.now() + TASK_GRANT_MS;
    const screen = this.hub.store.computersOnNode(d.nodeId).find((c) => c.kind === "device");
    if (screen && this.hub.computers.codeKind(screen)) await this.hub.computers.unlockScreen(screen, `agent:${a.agentId}`, code, until);
    this.grants.set(key, until);
    return `Go ahead: you can use ${d.deviceName} for this task (pass its name to computer_switch).`;
  }

  /** It used a device in this run: remembered for the note afterwards ("tell"). */
  noteUse(runId: string | undefined, nodeId: string) {
    if (!runId) return;
    let m = this.used.get(runId);
    if (!m) this.used.set(runId, (m = new Map()));
    const was = m.get(nodeId);
    m.set(nodeId, { from: was?.from ?? Date.now(), to: Date.now() });
  }

  /** A run ended: for each device it used on "Allowed, tell me after", a line in chat saying so. */
  runEnded(run: { id: string; agentId: string; channelId: string; threadId: string | null }) {
    const m = this.used.get(run.id);
    this.used.delete(run.id);
    const agent = this.hub.store.agent(run.agentId);
    if (!m || !agent) return;
    for (const [nodeId, span] of m) {
      if (agent.settings.useDevices?.[nodeId] !== "tell") continue;
      const node = this.hub.store.node(nodeId);
      if (!node || !this.hub.store.channel(run.channelId)) continue;
      const mins = Math.max(1, Math.round((span.to - span.from) / 60_000));
      this.hub.postMessage({ channelId: run.channelId, threadId: run.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "notice", text: `@${agent.handle} used your ${node.name} for ${mins} min` }], route: false });
    }
  }
}
