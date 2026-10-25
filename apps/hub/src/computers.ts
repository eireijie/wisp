import crypto from "node:crypto";
import WebSocket from "ws";
import { ComputerAction, TRANSFER_ACTIONS, tunnelFrame, type Actor, type Computer, type ComputerController, type ComputerSpec, type NodeToHub, type OrgoConfig, type Screenshot } from "@wisp/core";
import { id, now } from "./auth.ts";
import { OrgoClient } from "./orgo.ts";
import { relayVnc } from "./vnc-relay.ts";
import type { Hub } from "./hub.ts";

import { computerDefaults } from "./policy.ts";
/** Viewer links are single-use and short-lived, since they travel in a URL. */
const TICKET_MS = 60_000;
/** How long one code entry opens a screen for a viewer (the device caps every opening at a day). */
const VIEW_UNLOCK_MS = 12 * 60 * 60_000;
/** How long a person has to leave a computer alone before an agent that needs it takes it back. */
const AGENT_RECLAIM_MS = 30_000;
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
  /** its device was paused there (`wisp node pause`) */
  paused: boolean;
  /** a device's own screen that opens with the code picked at the device: which kind it is */
  code: "pin" | "password" | null;
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
  id: string;
  computerId: string;
  /** the screen's code, for the device to check again when the viewer connects; kept for the ticket's minute only */
  code?: string;
  redeemed?: boolean;
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
    return c.kind === "device" && !c.config.vncPort && !this.screenCaps(c)?.remote ? "frames" : "vnc";
  }

  /** What a device's own screen offers, as its device last said. */
  private screenCaps(c: Computer) {
    return c.kind === "device" && c.nodeId ? this.hub.store.nodeCapabilities(c.nodeId)?.screen : undefined;
  }

  /** The kind of code a device's own screen opens with, if it has one. */
  codeKind(c: Computer): "pin" | "password" | null {
    return this.screenCaps(c)?.code ?? null;
  }

  /**
   * Open a device's own screen with its code, for `purpose` until `until`. The device checks the
   * code (and counts wrong ones); the hub only passes it along. Returns when the opening ends, which
   * the device may make sooner. Screens without a code open as they always have.
   */
  async unlockScreen(c: Computer, purpose: string, code: string | undefined, until: number): Promise<number> {
    const kind = this.codeKind(c);
    if (!kind) return until;
    const label = kind === "pin" ? "PIN" : "password";
    if (!code) throw new ComputerError(`Enter ${c.name}'s ${label}. It was picked at the device, and Wisp doesn't keep it.`, 403);
    if (!c.nodeId || !this.hub.isNodeOnline(c.nodeId)) throw new ComputerError(`${c.name} is offline: its device isn't connected`, 503);
    try {
      const r = (await this.nodeRequest(c.nodeId, (requestId) => ({ type: "screen_unlock", requestId, purpose, code, until: new Date(until).toISOString() }), 20_000)) as { until?: string };
      return Date.parse(r?.until ?? "") || until;
    } catch (err) {
      if (err instanceof ComputerError && err.status === 422) throw new ComputerError(err.message, 403);
      throw err;
    }
  }

  /** Close what a code opened for `purpose`, when there's a code at all. */
  lockScreen(c: Computer, purpose: string) {
    if (c.kind === "device" && c.nodeId && this.codeKind(c)) this.hub.sendToNode(c.nodeId, { type: "screen_lock", purpose });
  }

  /** Something about a screen's code its owner should hear about (wrong codes, a lockout). */
  onScreenEvent(nodeId: string, msg: Extract<NodeToHub, { type: "screen_event" }>) {
    const screen = this.hub.store.computersOnNode(nodeId).find((x) => x.kind === "device");
    if (!screen) return;
    this.log(screen, { kind: "user", id: "system" }, msg.text);
    const owner = this.ownerOf(screen);
    if (msg.alert && owner) void this.hub.apns.sendTo(screen.workspaceId, owner, { aps: { alert: { title: screen.name, body: msg.text } }, wisp: { kind: "computer", category: "help", computerId: screen.id } }).catch(() => {});
  }

  online(c: Computer): boolean {
    return c.kind === "orgo" ? !!this.hub.store.setting(c.workspaceId, "orgo.apiKey") : this.hub.isNodeOnline(c.nodeId);
  }

  /** A device's own screen belongs to the person who connected the device. Other computers are the workspace's. */
  ownerOf(c: Computer): string | null {
    return c.kind === "device" && c.nodeId ? (this.hub.store.node(c.nodeId)?.ownerId ?? null) : null;
  }

  /** Can this person see and use it? Members, except for someone else's own screen. */
  canSee(c: Computer, userId: string): boolean {
    const role = this.hub.store.role(c.workspaceId, userId);
    return (role === "owner" || role === "member") && (c.kind !== "device" || this.ownerOf(c) === userId);
  }

  view(c: Computer): ComputerView {
    const ctl = this.control.get(c.id);
    return {
      ...c,
      controller: ctl ? { kind: "user", id: ctl.id, since: ctl.since } : null,
      ownerId: this.ownerOf(c),
      code: this.codeKind(c),
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

  /** Start a new VM or cloud computer, with its status kept up to date while it comes up. */
  startInBackground(comp: Computer) {
    if (comp.kind === "device") return;
    const { store } = this.hub;
    store.updateComputer(comp.id, { status: "starting", statusText: comp.kind === "vm" ? "Setting up the VM…" : "Starting…" });
    this.changed(comp.id);
    this.act(comp, { action: "start" }, { kind: "user", id: "system" }).then(
      () => {
        store.updateComputer(comp.id, { status: "ready", statusText: "" });
        this.changed(comp.id);
      },
      (err) => {
        store.updateComputer(comp.id, { status: "error", statusText: (err as Error).message.slice(0, 500) });
        this.changed(comp.id);
      },
    );
  }

  spec(c: Computer): ComputerSpec {
    if (c.kind === "orgo") throw new ComputerError("cloud computers don't run on a device");
    return { id: c.id, name: c.name, kind: c.kind, config: c.config as Record<string, unknown> };
  }

  orgo(workspaceId: string): OrgoClient | null {
    const key = this.hub.store.setting(workspaceId, "orgo.apiKey");
    return key ? new OrgoClient(key, this.hub.fetchImpl, undefined, this.hub.orgoWs) : null;
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
    const transfer = (TRANSFER_ACTIONS as readonly string[]).includes(action.action);
    // moving files and clipboard text doesn't need control: it doesn't touch the screen
    const input = !transfer && !["screenshot", "status", "start", "stop", "destroy", "harness_status", "signin", "inspect"].includes(action.action);
    if (c.kind === "device") this.checkScreenUse(c, by, opts.requester !== undefined ? opts.requester : by.kind === "agent" ? (this.hub.currentRun(by.id)?.requestedBy ?? null) : null, action);
    if (this.hub.isNodePaused(c.nodeId)) throw new ComputerError(`${c.name} is paused at its device. Someone there has to run \`wisp node resume\` first.`, 423);
    if (by.kind === "agent" && ctl && input) {
      // a person who's stopped using it doesn't keep the agent waiting: it takes the computer back
      if (Date.now() - ctl.touched >= AGENT_RECLAIM_MS) {
        this.control.delete(c.id);
        this.log(c, by, "Took control back");
        this.changed(c.id);
      } else {
        const who = this.hub.store.user(ctl.id)?.name ?? "Someone";
        throw new ComputerError(`${who} is using ${c.name} right now. Wait until they hand it back (you'll hear from them), or ask them in chat.`, 409);
      }
    }
    if (by.kind === "agent" && input) this.dropHelp(c.id, by.id);
    if (by.kind === "user" && input) {
      if (!ctl || ctl.id !== by.id) throw new ComputerError("take control of the computer first", 409);
      ctl.touched = Date.now();
    }
    const timeoutMs = opts.timeoutMs ?? (action.action === "start" ? 60 * 60_000 : action.action === "run" ? ((action.timeout ?? 120) + 30) * 1000 : transfer ? 10 * 60_000 : 120_000);
    let result: unknown;
    // a login is put into the page through the VM's own browser, which only VMs on a device have
    if (action.action === "fill_login" && c.kind !== "vm") throw new ComputerError(`${c.name} can't fill logins: only VMs can`, 409);
    if (c.kind === "orgo") {
      const client = this.orgo(c.workspaceId);
      if (!client) throw new ComputerError("add an Orgo API key in Settings → Computers first", 412);
      const cfg = c.config as OrgoConfig & { resolution?: string };
      result = await client.act(cfg, action);
    } else {
      if (!c.nodeId || !this.hub.isNodeOnline(c.nodeId)) throw new ComputerError(`${c.name} is offline: its device isn't connected`, 503);
      result = await this.nodeRequest(c.nodeId, (requestId) => ({ type: "computer", requestId, computer: this.spec(c), action, ...(by.kind === "agent" ? { agentId: by.id } : {}) }), timeoutMs);
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
    // files people move in and out are worth a line too
    if (by.kind === "user" && by.id !== "system" && ["file_read", "file_write", "file_mkdir"].includes(action.action)) this.log(c, by, describe(action));
    return result;
  }

  /**
   * A device's own screen: its owner can use it, and agents only when they run on that device
   * (their harness is there, with the screen as their computer) and only in work the owner asked
   * for. Agents anywhere else can't reach it: to have an agent use a computer, run it on that computer.
   */
  private checkScreenUse(c: Computer, by: Actor, requester: string | null, action: ComputerAction) {
    const owner = this.ownerOf(c);
    const name = owner ? (this.hub.store.user(owner)?.name ?? "its owner") : "its owner";
    if (by.kind === "user") {
      if (by.id !== "system" && by.id !== owner) throw new ComputerError(`${c.name} is ${name}'s own screen; only ${name} can use it`, 403);
      return;
    }
    // its files and clipboard go through the agent's own folder on the device, not Wisp's file transfer
    if ((TRANSFER_ACTIONS as readonly string[]).includes(action.action)) throw new ComputerError(`${c.name} is ${name}'s own screen; its files and clipboard stay with ${name}. Use the screen, or ask ${name} in chat for a file.`, 403);
    const why = this.whyNotOnDevice(c, by.id);
    if (why) throw new ComputerError(why, 403);
    if (!owner || requester !== owner) throw new ComputerError(`${c.name} is ${name}'s own screen, so you can only use it for things ${name} asked for. Use a VM for this instead.`, 403);
  }

  /** Why this agent can't have a device's screen as its computer, or null when it can: it has to run on that device. */
  whyNotOnDevice(c: Pick<Computer, "kind" | "name" | "nodeId">, agentId: string | null, nodeId?: string | null): string | null {
    if (c.kind !== "device") return null;
    const agent = agentId ? this.hub.store.agent(agentId) : undefined;
    const runsOn = nodeId !== undefined ? nodeId : agent?.nodeId;
    if (runsOn && runsOn === c.nodeId) return null;
    return `${c.name} is a person's own computer. Only agents that run on it can use its screen; to have an agent work there, run the agent on ${c.name}.`;
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
    // a screen with a code is asked every time, so a picture from while it was open isn't served once it's closed
    const f = this.codeKind(c) ? undefined : this.frames.get(c.id);
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
    // taking it again while you have it just says you're still using it (the browser does this as you work)
    if (cur?.id === userId) {
      cur.touched = Date.now();
      return;
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

  /**
   * An agent ended its turn asking for a hand on its screen in plain words instead of with
   * computer_ask_human: mark it the same way so the person gets the popup, without a second message.
   */
  flagHelp(c: Computer, agentId: string, request: string, where: { channelId: string; threadId: string | null }) {
    if (c.help) return;
    this.hub.store.updateComputer(c.id, { help: { agentId, request, channelId: where.channelId, threadId: where.threadId, at: now() } });
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
    for (const [t, ticket] of this.tickets)
      if (ticket.expires < Date.now()) {
        this.tickets.delete(t);
        // opened with the code but never watched: close it again
        const c = this.hub.store.computer(ticket.computerId);
        if (c) this.lockScreen(c, `view:${t}`);
      }
  }

  // --- live view --------------------------------------------------------------------------------------

  /**
   * A one-time link to watch a computer. A device's own screen with a code opens with the code
   * first, while the viewer watches; the device checks it again when the viewer connects.
   */
  async ticket(c: Computer, userId: string, code?: string): Promise<string> {
    if (!this.canSee(c, userId)) throw new ComputerError("only its owner can watch this screen", 403);
    const t = crypto.randomBytes(24).toString("base64url");
    const locked = !!this.codeKind(c);
    if (locked) await this.unlockScreen(c, `view:${t}`, code, Date.now() + VIEW_UNLOCK_MS);
    this.log(c, { kind: "user", id: userId }, "Opened the live view");
    this.tickets.set(t, { id: t, computerId: c.id, userId, workspaceId: c.workspaceId, kind: this.transport(c), code: locked ? code : undefined, expires: Date.now() + TICKET_MS });
    return t;
  }

  redeem(ticket: string | undefined, computerId: string): Ticket | null {
    const t = ticket ? this.tickets.get(ticket) : undefined;
    if (!t) return null;
    this.tickets.delete(ticket!);
    const c = this.hub.store.computer(computerId);
    if (t.expires < Date.now() || t.computerId !== computerId || !c || !this.canSee(c, t.userId)) return null;
    return t;
  }

  /** The viewer a ticket was for left: what its code opened closes. */
  viewerGone(c: Computer, ticket: Ticket) {
    this.lockScreen(c, `view:${ticket.id}`);
  }

  /** A browser watching a screen through frames; it can send input once it has control. */
  addFrameViewer(c: Computer, socket: WebSocket, userId: string) {
    if (!this.canSee(c, userId)) return socket.close(4403, "forbidden");
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
    for (const v of this.viewers.get(c.id) ?? []) {
      if (this.canSee(c, v.userId)) send(v.socket, { type: "frame", ...frame });
      else v.socket.close(4403, "forbidden");
    }
  }

  /** Relay a browser's VNC connection to a computer on a device. */
  openTunnel(c: Computer, socket: WebSocket, code?: string) {
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
    if (!this.hub.sendToNode(c.nodeId, { type: "tunnel_open", tunnelId, computer: this.spec(c), code })) {
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

  /**
   * Relay a browser's VNC connection to an Orgo computer. The hub signs in with the computer's
   * password, which stays here; the browser gets a password-free connection.
   */
  openOrgoRelay(c: Computer, socket: WebSocket) {
    const client = this.orgo(c.workspaceId);
    if (!client) return socket.close(4412, "add an Orgo API key in Settings → Computers first");
    let upstream: WebSocket | undefined;
    void client
      .vncTarget(c.config as OrgoConfig)
      .then(({ url, password }) => relayVnc(socket, (upstream = new WebSocket(url)), password))
      .catch((err) => {
        upstream?.close();
        if (socket.readyState <= 1) socket.close(4502, String((err as Error).message).slice(0, 120));
      });
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
    case "fill_login":
      return `Signing in to ${a.site}`;
    case "clipboard_get":
      return "Reading the clipboard";
    case "clipboard_set":
      return "Setting the clipboard";
    case "files_list":
      return "Looking at files";
    case "file_read":
      return `Downloaded ${a.path.split(/[/\\]/).pop()}`;
    case "file_write":
      return `Uploaded ${a.name}`;
    case "file_mkdir":
      return `Made the folder ${a.name}`;
    default:
      return "Working";
  }
}

function send(socket: WebSocket, msg: unknown) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}
