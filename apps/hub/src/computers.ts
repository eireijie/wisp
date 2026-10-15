import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { ComputerAction, lentNow, tunnelFrame, type Actor, type Computer, type ComputerController, type ComputerSpec, type NodeToHub, type OrgoConfig, type Screenshot } from "@warren/core";
import { id, now } from "./auth.ts";
import { OrgoClient, parseResolution } from "./orgo.ts";
import type { Hub } from "./hub.ts";

import { computerDefaults } from "./policy.ts";
/** Viewer links are single-use and short-lived, since they travel in a URL. */
const TICKET_MS = 60_000;
/** The same thing done again within this long is one line in a computer's activity. */
const LOG_COALESCE_MS = 60_000;

export class ComputerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What browsers get: the stored computer plus who's on it and how to watch it. */
export type ComputerView = Computer & {
  online: boolean;
  /** a device's own screen: whose it is (only they see it) */
  ownerId: string | null;
  /** its device was paused there (`warren node pause`) */
  paused: boolean;
  transport: "vnc" | "frames";
  agents: string[];
  /** the last thing an agent did on it, for "Working" badges */
  activity: { agentId: string; text: string; at: string } | null;
};

interface PendingRequest {
  nodeId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Frame {
  image: string;
  width: number;
  height: number;
  at: number;
}

interface Ticket {
  computerId: string;
  userId: string;
  workspaceId: string;
  kind: "vnc" | "frames";
  expires: number;
}

/**
 * The hub's side of computers: routes actions to the device that runs a computer (or to Orgo),
 * keeps who's in control, relays live views to browsers, and remembers each screen's last frame.
 */
export class Computers {
  private pending = new Map<string, PendingRequest>();
  private control = new Map<string, ComputerController & { touched: number }>();
  private frames = new Map<string, Frame>();
  private shooting = new Map<string, Promise<Frame>>();
  private viewers = new Map<string, Set<{ socket: WebSocket; userId: string }>>();
  /** browser VNC sockets by tunnel id, for tunnels through a device */
  private tunnels = new Map<string, { socket: WebSocket; nodeId: string; computerId: string; ready: boolean; queue: Uint8Array[] }>();
  private tickets = new Map<string, Ticket>();
  private activity = new Map<string, { agentId: string; text: string; at: string }>();
  private lastBroadcast = new Map<string, number>();
  private lastLog = new Map<string, { who: string; text: string; at: number }>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor(private hub: Hub) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  // --- views ------------------------------------------------------------------------------------

  transport(c: Computer): "vnc" | "frames" {
    return c.kind === "device" && !c.config.vncPort ? "frames" : "vnc";
  }

  online(c: Computer): boolean {
    return c.kind === "orgo" ? !!this.hub.store.setting(c.workspaceId, "orgo.apiKey") : this.hub.isNodeOnline(c.nodeId);
  }

  /** A device's own screen belongs to the person who connected the device. Other computers are the workspace's. */
  ownerOf(c: Computer): string | null {
    return c.kind === "device" && c.nodeId ? (this.hub.store.node(c.nodeId)?.ownerId ?? null) : null;
  }

  /** Can this person see and use it? Everyone in the workspace, except for someone else's own screen. */
  canSee(c: Computer, userId: string): boolean {
    return c.kind !== "device" || this.ownerOf(c) === userId;
  }

  view(c: Computer): ComputerView {
    const ctl = this.control.get(c.id);
    return {
      ...c,
      controller: ctl ? { kind: "user", id: ctl.id, since: ctl.since } : null,
      ownerId: this.ownerOf(c),
      paused: this.hub.isNodePaused(c.nodeId),
      online: this.online(c),
      transport: this.transport(c),
      agents: this.hub.store.agentsOnComputer(c.id).map((a) => a.id),
      activity: this.activity.get(c.id) ?? null,
    };
  }

  /** Tell browsers a computer changed. `throttle` limits chatty updates (agent activity) to one every 2s. */
  changed(computerId: string, throttle = false) {
    const c = this.hub.store.computer(computerId);
    if (!c) return;
    if (throttle && Date.now() - (this.lastBroadcast.get(computerId) ?? 0) < 2000) return;
    this.lastBroadcast.set(computerId, Date.now());
    this.hub.broadcast(c.workspaceId, { type: "computer", computer: this.view(c) }, (userId) => this.canSee(c, userId));
    for (const v of this.viewers.get(computerId) ?? []) send(v.socket, { type: "computer", computer: this.view(c) });
  }

  spec(c: Computer): ComputerSpec {
    if (c.kind === "orgo") throw new ComputerError("cloud computers don't run on a device");
    return { id: c.id, name: c.name, kind: c.kind, config: c.config as Record<string, unknown> };
  }

  orgo(workspaceId: string): OrgoClient | null {
    const key = this.hub.store.setting(workspaceId, "orgo.apiKey");
    return key ? new OrgoClient(key, this.hub.fetchImpl) : null;
  }

  // --- requests to devices ------------------------------------------------------------------------

  /** Send a request to a device and wait for its `result`. */
  nodeRequest(nodeId: string, build: (requestId: string) => Parameters<Hub["sendToNode"]>[1], timeoutMs: number): Promise<unknown> {
    const requestId = id("req");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ComputerError("the device didn't answer in time", 504));
      }, timeoutMs);
      this.pending.set(requestId, { nodeId, resolve, reject, timer });
      if (!this.hub.sendToNode(nodeId, build(requestId))) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new ComputerError("the device is offline", 503));
      }
    });
  }

  onResult(nodeId: string, msg: Extract<NodeToHub, { type: "result" }>) {
    const p = this.pending.get(msg.requestId);
    if (!p || p.nodeId !== nodeId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.requestId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ComputerError(msg.error ?? "failed", 422));
  }

  // --- actions ------------------------------------------------------------------------------------

  /**
   * Do something on a computer. Agents are held back while a person has control; people act
   * only once they've taken control.
   */
  /** `requester`: the person an agent is working for (see the API's requesterOf); by default, whoever asked for its current run. */
  async act(c: Computer, action: ComputerAction, by: Actor, opts: { timeoutMs?: number; requester?: string | null } = {}): Promise<unknown> {
    const ctl = this.control.get(c.id);
    const input = !["screenshot", "status", "start", "stop", "destroy", "harness_status", "signin", "inspect"].includes(action.action);
    if (c.kind === "device") this.checkScreenUse(c, by, opts.requester !== undefined ? opts.requester : by.kind === "agent" ? (this.hub.currentRun(by.id)?.requestedBy ?? null) : null);
    if (this.hub.isNodePaused(c.nodeId)) throw new ComputerError(`${c.name} is paused at its device. Someone there has to run \`warren node resume\` first.`, 423);
    if (by.kind === "agent" && ctl && input) {
      const who = this.hub.store.user(ctl.id)?.name ?? "Someone";
      throw new ComputerError(`${who} has taken control of ${c.name}. Wait until they hand it back (you'll hear from them), or ask them in chat.`, 409);
    }
    if (by.kind === "agent" && input) this.dropHelp(c.id, by.id);
    if (by.kind === "user" && input) {
      if (!ctl || ctl.id !== by.id) throw new ComputerError("take control of the computer first", 409);
      ctl.touched = Date.now();
    }
    const timeoutMs = opts.timeoutMs ?? (action.action === "start" ? 60 * 60_000 : action.action === "run" ? ((action.timeout ?? 120) + 30) * 1000 : 120_000);
    let result: unknown;
    if (c.kind === "orgo") {
      const client = this.orgo(c.workspaceId);
      if (!client) throw new ComputerError("add an Orgo API key in Settings → Computers first", 412);
      const cfg = c.config as OrgoConfig & { resolution?: string };
      result = await client.act(cfg, action);
    } else {
      if (!c.nodeId || !this.hub.isNodeOnline(c.nodeId)) throw new ComputerError(`${c.name} is offline: its device isn't connected`, 503);
      result = await this.nodeRequest(c.nodeId, (requestId) => ({ type: "computer", requestId, computer: this.spec(c), action }), timeoutMs);
    }
    if (action.action === "screenshot") {
      const s = result as Screenshot;
      this.frames.set(c.id, { image: s.image, width: s.width, height: s.height, at: Date.now() });
    }
    if (by.kind === "agent") {
      this.activity.set(c.id, { agentId: by.id, text: describe(action), at: now() });
      this.changed(c.id, true);
      // on a person's own screen even looking is worth recording
      if (action.action !== "status" && (action.action !== "screenshot" || c.kind === "device")) this.log(c, by, describe(action));
    }
    return result;
  }

  /**
   * A device's own screen: its owner can use it, and agents only while the owner lends it to them
   * and only in work the owner asked for (directly, or through other agents).
   */
  private checkScreenUse(c: Computer, by: Actor, requester: string | null) {
    const owner = this.ownerOf(c);
    const name = owner ? (this.hub.store.user(owner)?.name ?? "its owner") : "its owner";
    if (by.kind === "user") {
      if (by.id !== "system" && by.id !== owner) throw new ComputerError(`${c.name} is ${name}'s own screen; only ${name} can use it`, 403);
      return;
    }
    if (!lentNow(c)) throw new ComputerError(`${c.name} is ${name}'s own screen and it isn't lent to agents right now. Ask ${name} to lend it to you (Computers → ${c.name} → Lend to agents), or use a VM.`, 403);
    if (!owner || requester !== owner) throw new ComputerError(`${c.name} is ${name}'s own screen, so you can only use it for things ${name} asked for. Use a VM for this instead.`, 403);
  }

  /** Lend a device's screen to agents for `minutes`, until the owner stops it (null), or stop lending (false). */
  lend(c: Computer, userId: string, minutes: number | null | false) {
    const config = { ...c.config };
    if (minutes === false) delete config.lend;
    else config.lend = { until: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString() };
    this.hub.store.updateComputer(c.id, { config });
    const span = (m: number) => (m % 60 ? `${m} minute${m === 1 ? "" : "s"}` : `${m / 60} hour${m === 60 ? "" : "s"}`);
    const what = minutes === false ? "Stopped lending it to agents" : minutes === null ? "Lent it to agents until they stop it" : `Lent it to agents for ${span(minutes)}`;
    this.log(c, { kind: "user", id: userId }, what);
    this.changed(c.id);
  }

  /** Add a line to the computer's activity, folding repeats of the same thing into one. */
  log(c: Computer, by: Actor, text: string) {
    const who = `${by.kind}:${by.id}`;
    const last = this.lastLog.get(c.id);
    if (last && last.who === who && last.text === text && Date.now() - last.at < LOG_COALESCE_MS) return;
    this.lastLog.set(c.id, { who, text, at: Date.now() });
    this.hub.store.logComputer(c.id, by, text);
  }

  /** The screen as it looks now (or within `maxAgeMs`), for thumbnails. */
  async latest(c: Computer, maxAgeMs = 5000): Promise<Frame> {
    const f = this.frames.get(c.id);
    if (f && Date.now() - f.at < maxAgeMs) return f;
    let p = this.shooting.get(c.id);
    if (!p) {
      p = this.act(c, { action: "screenshot" }, { kind: "user", id: "system" }).then(() => this.frames.get(c.id)!);
      this.shooting.set(c.id, p);
      p.finally(() => this.shooting.delete(c.id)).catch(() => {});
    }
    return p.catch((err) => {
      if (f) return f; // an old frame beats none
      throw err;
    });
  }

  // --- control --------------------------------------------------------------------------------------

  controller(computerId: string) {
    return this.control.get(computerId) ?? null;
  }

  take(c: Computer, userId: string) {
    if (!this.canSee(c, userId)) throw new ComputerError("only its owner can use this screen", 403);
    const cur = this.control.get(c.id);
    if (cur && cur.id !== userId && Date.now() - cur.touched < this.idleMs(c.workspaceId)) {
      throw new ComputerError(`${this.hub.store.user(cur.id)?.name ?? "Someone"} is using it right now`, 409);
    }
    this.control.set(c.id, { kind: "user", id: userId, since: now(), touched: Date.now() });
    this.log(c, { kind: "user", id: userId }, "Took control");
    this.changed(c.id);
  }

  /** Give the computer back to the agents. An agent that asked for help hears about it. */
  release(c: Computer, userId: string, note?: string) {
    const cur = this.control.get(c.id);
    if (cur && cur.id !== userId) throw new ComputerError("someone else has control", 409);
    this.control.delete(c.id);
    if (cur) this.log(c, { kind: "user", id: userId }, "Handed it back");
    const help = c.help;
    if (help) {
      this.hub.store.updateComputer(c.id, { help: null });
      const agent = this.hub.store.agent(help.agentId);
      if (agent && this.hub.store.channel(help.channelId)) {
        const body = `@${agent.handle} ${note?.trim() || "Done, the computer is yours again."}`;
        this.hub.postMessage({ channelId: help.channelId, threadId: help.threadId, author: { kind: "user", id: userId }, body });
      }
    }
    this.changed(c.id);
  }

  /**
   * The agent that asked for help is working again (someone messaged it, or it went ahead on the
   * computer itself): its "needs you" request is stale, so drop it.
   */
  dropHelp(computerId: string, agentId: string) {
    const c = this.hub.store.computer(computerId);
    if (!c?.help || c.help.agentId !== agentId) return;
    this.hub.store.updateComputer(c.id, { help: null });
    this.changed(c.id);
  }

  /** An agent asks a person to do something on its computer, e.g. sign in somewhere. */
  requestHelp(c: Computer, agentId: string, request: string, where: { channelId: string; threadId: string | null }) {
    const help = { agentId, request, channelId: where.channelId, threadId: where.threadId, at: now() };
    this.hub.store.updateComputer(c.id, { help });
    const msg = this.hub.postMessage({
      channelId: where.channelId,
      threadId: where.threadId,
      author: { kind: "agent", id: agentId },
      body: request,
      parts: [{ type: "computer", computerId: c.id, request }],
      route: false,
    });
    this.changed(c.id);
    return msg;
  }

  /** How long a person keeps control without touching a computer before agents get it back (Settings → Computers). */
  private idleMs(workspaceId: string) {
    return computerDefaults(this.hub, workspaceId).controlIdleMinutes * 60_000;
  }

  private sweep() {
    for (const [computerId, ctl] of this.control) {
      const ws = this.hub.store.computer(computerId)?.workspaceId;
      const idle = ws ? this.idleMs(ws) : 10 * 60_000;
      if (Date.now() - ctl.touched < idle) continue;
      // nobody is watching or touching it: give it back quietly
      const watching = [...(this.viewers.get(computerId) ?? [])].some((v) => v.userId === ctl.id);
      if (watching && Date.now() - ctl.touched < 3 * idle) continue;
      this.control.delete(computerId);
      this.changed(computerId);
    }
    for (const [t, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(t);
  }

  // --- live view --------------------------------------------------------------------------------------

  ticket(c: Computer, userId: string): string {
    if (!this.canSee(c, userId)) throw new ComputerError("only its owner can watch this screen", 403);
    this.log(c, { kind: "user", id: userId }, "Opened the live view");
    const t = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(t, { computerId: c.id, userId, workspaceId: c.workspaceId, kind: this.transport(c), expires: Date.now() + TICKET_MS });
    return t;
  }

  redeem(ticket: string | undefined, computerId: string): Ticket | null {
    const t = ticket ? this.tickets.get(ticket) : undefined;
    if (!t) return null;
    this.tickets.delete(ticket!);
    if (t.expires < Date.now() || t.computerId !== computerId) return null;
    return t;
  }

  /** A browser watching a screen through frames; it can send input once it has control. */
  addFrameViewer(c: Computer, socket: WebSocket, userId: string) {
    const viewer = { socket, userId };
    let set = this.viewers.get(c.id);
    if (!set) this.viewers.set(c.id, (set = new Set()));
    set.add(viewer);
    send(socket, { type: "computer", computer: this.view(c) });
    const f = this.frames.get(c.id);
    if (f) send(socket, { type: "frame", ...f });
    if (set.size === 1 && c.nodeId) this.hub.sendToNode(c.nodeId, { type: "screen_watch", computer: this.spec(c), on: true, fps: 2 });

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type !== "input") return;
      const parsed = ComputerAction.safeParse(msg.action);
      const fresh = this.hub.store.computer(c.id);
      if (!parsed.success || !fresh) return;
      if (!["click", "move", "mouse", "drag", "scroll", "type", "key"].includes(parsed.data.action)) return;
      this.act(fresh, parsed.data, { kind: "user", id: userId }).catch((err) => send(socket, { type: "error", message: (err as Error).message }));
    });
    socket.on("close", () => {
      set!.delete(viewer);
      if (set!.size === 0) {
        this.viewers.delete(c.id);
        const cur = this.hub.store.computer(c.id);
        if (cur?.nodeId) this.hub.sendToNode(cur.nodeId, { type: "screen_watch", computer: this.spec(cur), on: false });
      }
    });
  }

  onFrame(nodeId: string, msg: Extract<NodeToHub, { type: "screen_frame" }>) {
    const c = this.hub.store.computer(msg.computerId);
    if (!c || c.nodeId !== nodeId) return;
    const frame = { image: msg.image, width: msg.width, height: msg.height, at: Date.now() };
    this.frames.set(c.id, frame);
    for (const v of this.viewers.get(c.id) ?? []) send(v.socket, { type: "frame", ...frame });
  }

  /** Relay a browser's VNC connection to a computer on a device. */
  openTunnel(c: Computer, socket: WebSocket) {
    if (!c.nodeId) return socket.close(4400, "no device");
    const tunnelId = id("tun");
    const t = { socket, nodeId: c.nodeId, computerId: c.id, ready: false, queue: [] as Uint8Array[] };
    this.tunnels.set(tunnelId, t);
    socket.on("message", (raw: Buffer) => {
      const data = new Uint8Array(raw);
      if (t.ready) this.hub.sendBinaryToNode(t.nodeId, tunnelFrame(tunnelId, data));
      else t.queue.push(data);
    });
    socket.on("close", () => {
      if (this.tunnels.delete(tunnelId)) this.hub.sendToNode(t.nodeId, { type: "tunnel_close", tunnelId });
    });
    if (!this.hub.sendToNode(c.nodeId, { type: "tunnel_open", tunnelId, computer: this.spec(c) })) {
      this.tunnels.delete(tunnelId);
      socket.close(4503, "device offline");
    }
  }

  onTunnelReady(nodeId: string, tunnelId: string) {
    const t = this.tunnels.get(tunnelId);
    if (!t || t.nodeId !== nodeId) return;
    t.ready = true;
    for (const data of t.queue.splice(0)) this.hub.sendBinaryToNode(nodeId, tunnelFrame(tunnelId, data));
  }

  onTunnelData(nodeId: string, tunnelId: string, payload: Uint8Array) {
    const t = this.tunnels.get(tunnelId);
    if (t && t.nodeId === nodeId && t.socket.readyState === 1) t.socket.send(payload, { binary: true });
  }

  onTunnelClosed(nodeId: string, tunnelId: string, error?: string) {
    const t = this.tunnels.get(tunnelId);
    if (!t || t.nodeId !== nodeId) return;
    this.tunnels.delete(tunnelId);
    t.socket.close(error ? 4502 : 1000, (error ?? "closed").slice(0, 120));
  }

  /** A device went away: its live views end and pending requests fail. */
  nodeGone(nodeId: string) {
    for (const [tid, t] of this.tunnels) {
      if (t.nodeId !== nodeId) continue;
      this.tunnels.delete(tid);
      t.socket.close(4503, "device offline");
    }
    for (const [rid, p] of this.pending) {
      if (p.nodeId !== nodeId) continue;
      clearTimeout(p.timer);
      this.pending.delete(rid);
      p.reject(new ComputerError("the device disconnected", 503));
    }
    for (const c of this.hub.store.computersOnNode(nodeId)) this.changed(c.id);
  }

  /** A device came back: resume streaming to anyone still watching. */
  nodeBack(nodeId: string) {
    for (const c of this.hub.store.computersOnNode(nodeId)) {
      if (this.viewers.get(c.id)?.size) this.hub.sendToNode(nodeId, { type: "screen_watch", computer: this.spec(c), on: true, fps: 2 });
      this.changed(c.id);
    }
  }

  /** The Orgo VNC address, for the browser to connect to directly. Contains the computer's password. */
  async orgoVnc(c: Computer): Promise<string> {
    const client = this.orgo(c.workspaceId);
    if (!client) throw new ComputerError("add an Orgo API key in Settings → Computers first", 412);
    return client.vncUrl(c.config as OrgoConfig);
  }

  /** Make an Orgo computer for this workspace. */
  async createOrgo(workspaceId: string, name: string, size: { ram?: number; cpu?: number }): Promise<Computer> {
    const client = this.orgo(workspaceId);
    if (!client) throw new ComputerError("add an Orgo API key in Settings → Computers first", 412);
    const resolution = "1280x800";
    const created = await client.create({ name: `${name}-${crypto.randomBytes(3).toString("hex")}`, ram: size.ram, cpu: size.cpu, resolution: `${resolution}x24` });
    return this.hub.store.createComputer({
      workspaceId,
      name,
      kind: "orgo",
      nodeId: null,
      config: { computerId: created.id, instanceId: created.instanceId ?? undefined, ram: size.ram, cpu: size.cpu, resolution },
      status: created.status === "running" ? "ready" : "starting",
    });
  }

  /** Remove a computer everywhere: its VM or cloud computer is deleted too. */
  async remove(c: Computer) {
    if (c.kind !== "device") await this.act(c, { action: "destroy" }, { kind: "user", id: "system" }).catch(() => {});
    this.control.delete(c.id);
    this.frames.delete(c.id);
    for (const v of this.viewers.get(c.id) ?? []) v.socket.close(4404, "removed");
    this.viewers.delete(c.id);
    this.hub.store.deleteComputer(c.id);
    this.hub.broadcast(c.workspaceId, { type: "computer_removed", computerId: c.id });
  }

  /** Screen size used for coordinates on cloud computers. */
  static orgoScreen(c: Computer) {
    return parseResolution((c.config as { resolution?: string }).resolution);
  }
}

/** A few words for what an agent did, shown on the computer's card. */
export function describe(a: ComputerAction): string {
  switch (a.action) {
    case "screenshot":
      return "Looking at the screen";
    case "click":
      return a.double ? "Double-clicking" : a.button === "right" ? "Right-clicking" : "Clicking";
    case "type":
      return "Typing";
    case "key":
      return `Pressing ${a.keys}`;
    case "scroll":
      return `Scrolling ${a.direction}`;
    case "drag":
      return "Dragging";
    case "run":
      return `Running ${a.command.split(/\s+/)[0]}`;
    case "open":
      return `Opening ${a.target.slice(0, 60)}`;
    case "signin":
      return `Opening a sign-in for ${a.harness}`;
    default:
      return "Working";
  }
}

function send(socket: WebSocket, msg: unknown) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}
