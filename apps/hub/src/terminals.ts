import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { TERM_PREFIX, tunnelFrame, type Computer, type RunCredential } from "@wisp/core";
import { ComputerError } from "./computers.ts";
import { featureOn } from "./features.ts";
import type { Hub } from "./hub.ts";

/**
 * The Code mod's terminals, relayed: a browser's socket on one side, a shell on the device that runs
 * the computer on the other, over the device's own link (binary frames, as live view's VNC uses).
 * The hub checks who may open one and passes bytes along; it never runs anything itself.
 */

const TICKET_MS = 60_000;
/** keys typed before the shell is up, at most */
const QUEUE_BYTES = 64 * 1024;

interface Ticket {
  computerId: string;
  workspaceId: string;
  userId: string;
  session: string;
  code?: string;
  expires: number;
  /** a harness's CLI to start in it (an id from HARNESSES) */
  launch?: string;
  /** the model sign-in that CLI uses: the one agent runs on that computer use */
  credential?: RunCredential;
}

interface Open {
  socket: WebSocket;
  nodeId: string;
  computerId: string;
  workspaceId: string;
  userId: string;
  ready: boolean;
  queue: Uint8Array[];
  queued: number;
  /** the person closed the pane, so the shell stops too */
  end: boolean;
}

/** A pane's name, as the device will name its shell: lowercase letters, digits and dashes. */
export function sessionName(raw: string | undefined): string {
  return (String(raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "main").slice(0, 40);
}

function send(socket: WebSocket, msg: unknown) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

export class Terminals {
  /** device:connection pairs a terminal's CLI was given, so a sign-in it renews is taken back */
  readonly handedOut = new Set<string>();

  private tickets = new Map<string, Ticket>();
  private open = new Map<string, Open>();

  constructor(private hub: Hub) {}

  /** Why this person can't open a terminal on it, or null when they can. */
  refusal(c: Computer, userId: string): { status: number; error: string } | null {
    if (!featureOn(this.hub.store, c.workspaceId, "code")) return { status: 403, error: "Code is turned off (More → Mods)." };
    if (c.kind === "orgo") return { status: 400, error: "Terminals on cloud computers aren't ready yet." };
    if (!this.hub.computers.canUseShell(c, userId)) {
      const node = c.nodeId ? this.hub.store.node(c.nodeId) : undefined;
      const owner = node?.ownerId ? (this.hub.store.user(node.ownerId)?.name ?? "its owner") : "a workspace owner";
      return { status: 403, error: `Only ${owner} can open a terminal on ${c.name}.` };
    }
    return null;
  }

  /** A one-time link to open the terminal named `session` on a computer, good for a minute. */
  ticket(c: Computer, userId: string, session: string, code?: string, launch?: string, credential?: RunCredential | null): string {
    const no = this.refusal(c, userId);
    if (no) throw new ComputerError(no.error, no.status);
    const kind = this.hub.computers.codeKind(c);
    if (c.kind === "device" && kind && !code) throw new ComputerError(`Enter ${c.name}'s ${kind === "pin" ? "PIN" : "password"}. It was picked at the device, and Wisp doesn't keep it.`, 403);
    if (!this.hub.computers.online(c)) throw new ComputerError(`${c.name} is offline: its device isn't connected`, 503);
    this.sweep();
    const t = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(t, { computerId: c.id, workspaceId: c.workspaceId, userId, session: sessionName(session), code: c.kind === "device" ? code : undefined, expires: Date.now() + TICKET_MS, launch, ...(launch && credential ? { credential } : {}) });
    return t;
  }

  /** Connect a browser's socket to the shell its ticket names. */
  connect(socket: WebSocket, computerId: string, ticket: string | undefined, size: { cols: number; rows: number }) {
    const t = ticket ? this.tickets.get(ticket) : undefined;
    if (ticket) this.tickets.delete(ticket);
    const c = this.hub.store.computer(computerId);
    if (!t || t.expires < Date.now() || t.computerId !== computerId || !c || c.workspaceId !== t.workspaceId) return socket.close(4401, "unauthorized");
    const no = this.refusal(c, t.userId);
    if (no) return socket.close(4403, no.error.slice(0, 120));
    if (!c.nodeId) return socket.close(4400, "no device");
    const termId = TERM_PREFIX + crypto.randomBytes(12).toString("base64url");
    const o: Open = { socket, nodeId: c.nodeId, computerId: c.id, workspaceId: c.workspaceId, userId: t.userId, ready: false, queue: [], queued: 0, end: false };
    this.open.set(termId, o);
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) return this.control(termId, o, raw.toString());
      const data = new Uint8Array(raw);
      if (o.ready) return this.hub.sendBinaryToNode(o.nodeId, tunnelFrame(termId, data));
      if (o.queued + data.length > QUEUE_BYTES) return;
      o.queue.push(data);
      o.queued += data.length;
    });
    socket.on("close", () => {
      if (this.open.delete(termId)) this.hub.sendToNode(o.nodeId, { type: "term_close", termId, end: o.end });
    });
    const cols = Math.max(2, Math.min(1000, Math.floor(size.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(size.rows) || 24));
    if (!this.hub.sendToNode(c.nodeId, { type: "term_open", termId, computer: this.hub.computers.spec(c), session: t.session, cols, rows, code: t.code, ...(t.launch ? { launch: t.launch } : {}), ...(t.credential ? { credential: t.credential } : {}) })) {
      this.open.delete(termId);
      return socket.close(4503, "device offline");
    }
    // the CLI may renew a rotating sign-in; the device sends the new one back, and it's kept
    if (t.credential) this.handedOut.add(`${c.nodeId}:${t.credential.connectionId}`);
    this.hub.computers.log(c, { kind: "user", id: t.userId }, `Opened a terminal (${t.session})`);
  }

  /** Text frames from the browser: a new size, or closing the pane for good. */
  private control(termId: string, o: Open, text: string) {
    let msg: { type?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "resize" && o.ready) {
      const cols = Math.floor(Number(msg.cols));
      const rows = Math.floor(Number(msg.rows));
      if (cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 500) this.hub.sendToNode(o.nodeId, { type: "term_resize", termId, cols, rows });
    } else if (msg.type === "end") {
      o.end = true;
      o.socket.close(1000, "closed");
    }
  }

  onReady(nodeId: string, termId: string, resumed: boolean) {
    const o = this.open.get(termId);
    if (!o || o.nodeId !== nodeId) return;
    o.ready = true;
    for (const data of o.queue.splice(0)) this.hub.sendBinaryToNode(nodeId, tunnelFrame(termId, data));
    o.queued = 0;
    send(o.socket, { type: "ready", resumed });
  }

  onData(nodeId: string, termId: string, payload: Uint8Array) {
    const o = this.open.get(termId);
    if (o && o.nodeId === nodeId && o.socket.readyState === 1) o.socket.send(payload, { binary: true });
  }

  onClosed(nodeId: string, termId: string, error?: string, exited?: boolean) {
    const o = this.open.get(termId);
    if (!o || o.nodeId !== nodeId) return;
    this.open.delete(termId);
    send(o.socket, { type: "closed", error, exited: !!exited });
    o.socket.close(error && !exited ? 4502 : 1000, (error ?? "closed").slice(0, 120));
  }

  /** A device went away: its terminals close (its shells keep running there, to come back to). */
  nodeGone(nodeId: string) {
    for (const [termId, o] of this.open) {
      if (o.nodeId !== nodeId) continue;
      this.open.delete(termId);
      o.socket.close(4503, "device offline");
    }
  }

  /** Code was turned off, or someone lost access: close what they can no longer have open. */
  recheck(workspaceId: string) {
    for (const [termId, o] of this.open) {
      if (o.workspaceId !== workspaceId) continue;
      const c = this.hub.store.computer(o.computerId);
      const no = c ? this.refusal(c, o.userId) : { error: "the computer was removed" };
      if (!no) continue;
      this.open.delete(termId);
      // the shell stops too: a terminal nobody may open shouldn't keep running
      this.hub.sendToNode(o.nodeId, { type: "term_close", termId, end: true });
      o.socket.close(4403, no.error.slice(0, 120));
    }
  }

  get count() {
    return this.open.size;
  }

  private sweep() {
    for (const [t, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(t);
  }
}
