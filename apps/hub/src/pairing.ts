import crypto from "node:crypto";
import os from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Caller } from "./api.ts";
import { issueToken } from "./auth.ts";
import type { Hub } from "./hub.ts";

/**
 * Pairing a phone with Warren on a computer, without typing an address or a password.
 *
 * 1. Settings → Mobile starts a pairing: the hub makes a one-time secret and the page shows it as
 *    a QR code, along with the addresses a phone could reach this hub at.
 * 2. The phone scans it, finds an address that answers, and claims the pairing with the secret.
 *    The hub picks a six-digit code and both screens show it.
 * 3. The person checks the codes match and confirms on the computer. Only then does the phone get
 *    a sign-in of its own (it shows under Security → Sign-ins and can be signed out there).
 *
 * The code is what stops someone who photographed the QR code from pairing instead of you: the
 * first phone to claim gets the code, and you only confirm it if it's the one on your phone.
 * Pairings live in memory for a few minutes; nothing is written until you confirm.
 */

export const PAIR_TTL_MS = 5 * 60_000;

export type PairState = "waiting" | "claimed" | "approved" | "rejected" | "expired";

interface Pairing {
  id: string;
  secret: string;
  userId: string;
  workspaceId: string;
  state: PairState;
  expiresAt: number;
  code?: string;
  deviceName?: string;
  platform?: string;
  /** handed to the phone once, then forgotten */
  token?: string;
}

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const isLoopback = (host: string) => /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/i.test(host);
/** 100.64.0.0/10, the range Tailscale hands out */
const isTailscale = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

/**
 * Where a phone might reach this hub, best first: the address the page was opened at (unless it's
 * this computer's own loopback), then the computer's Wi-Fi/Ethernet addresses, then Tailscale.
 */
export function pairingAddresses(origin: string | null, port: number, interfaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  if (origin) {
    try {
      const u = new URL(origin);
      if (!isLoopback(u.hostname)) out.push(u.origin);
    } catch {
      // not a URL; skip it
    }
  }
  const lan: string[] = [];
  const tailnet: string[] = [];
  for (const list of Object.values(interfaces))
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      (isTailscale(a.address) ? tailnet : lan).push(`http://${a.address}:${port}`);
    }
  for (const a of [...lan, ...tailnet]) if (!out.includes(a)) out.push(a);
  return out;
}

/** The link a QR code carries; the phone apps open warren://pair links. */
export function pairingLink(p: { id: string; secret: string; addresses: string[] }): string {
  const q = new URLSearchParams({ v: "1", id: p.id, s: p.secret });
  for (const a of p.addresses) q.append("u", a);
  return `warren://pair?${q}`;
}

const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerPairingApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { need, parse } = h;
  const db = hub.store.db;
  const pairings = new Map<string, Pairing>();

  /** A live pairing, marking it expired once its time is up (expired ones are dropped a bit later). */
  function get(id: string): Pairing | null {
    const p = pairings.get(id);
    if (!p) return null;
    if (Date.now() > p.expiresAt + PAIR_TTL_MS) {
      pairings.delete(id);
      return null;
    }
    if (Date.now() > p.expiresAt && (p.state === "waiting" || p.state === "claimed")) p.state = "expired";
    return p;
  }
  const sweep = () => {
    for (const id of pairings.keys()) get(id);
  };

  const view = (p: Pairing) => ({ id: p.id, state: p.state, code: p.code ?? null, deviceName: p.deviceName ?? null, platform: p.platform ?? null, expiresAt: new Date(p.expiresAt).toISOString() });

  // --- the computer ---------------------------------------------------------------------------

  app.post("/api/pair", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    sweep();
    // one pairing at a time per person: starting again cancels the last one
    for (const p of pairings.values()) if (p.userId === c.actor.id && (p.state === "waiting" || p.state === "claimed")) p.state = "expired";
    const p: Pairing = {
      id: crypto.randomBytes(9).toString("base64url"),
      secret: crypto.randomBytes(24).toString("base64url"),
      userId: c.actor.id,
      workspaceId: c.workspaceId,
      state: "waiting",
      expiresAt: Date.now() + PAIR_TTL_MS,
    };
    pairings.set(p.id, p);
    const body = (req.body ?? {}) as { origin?: unknown };
    const origin = typeof body.origin === "string" ? body.origin : null;
    const addresses = pairingAddresses(origin, req.socket.localPort ?? 4747);
    return { ...view(p), addresses, link: pairingLink({ id: p.id, secret: p.secret, addresses }) };
  });

  app.get("/api/pair/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const p = get((req.params as { id: string }).id);
    if (!p || p.userId !== c.actor.id) return reply.code(404).send({ error: "That pairing has ended. Start again." });
    return view(p);
  });

  app.post("/api/pair/:id/confirm", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const p = get((req.params as { id: string }).id);
    if (!p || p.userId !== c.actor.id) return reply.code(404).send({ error: "That pairing has ended. Start again." });
    if (p.state !== "claimed") return reply.code(409).send({ error: p.state === "expired" ? "The code expired. Start again." : "No phone has scanned the code yet." });
    p.state = "approved";
    p.token = issueToken(db, "session", p.userId, p.workspaceId, `Warren on ${p.deviceName || (p.platform === "android" ? "Android" : "iPhone")}`);
    return view(p);
  });

  app.post("/api/pair/:id/cancel", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const p = get((req.params as { id: string }).id);
    if (p && p.userId === c.actor.id && p.state !== "approved") p.state = "rejected";
    return { ok: true };
  });

  // --- the phone (no sign-in yet: the secret from the QR code is the proof) ------------------------

  const phone = (req: FastifyRequest, reply: FastifyReply, secret: unknown): Pairing | null => {
    const p = get((req.params as { id: string }).id);
    if (!p || typeof secret !== "string" || !same(secret, p.secret)) {
      reply.code(404).send({ error: "This code isn't valid anymore. Show a new one in Warren → Settings → Mobile." });
      return null;
    }
    return p;
  };

  app.post("/api/pair/:id/claim", async (req, reply) => {
    const body = parse(z.object({ secret: z.string(), deviceName: z.string().trim().max(60).default(""), platform: z.enum(["ios", "android", "web"]).default("ios") }), req.body, reply);
    if (!body) return;
    const p = phone(req, reply, body.secret);
    if (!p) return;
    if (p.state === "expired") return reply.code(410).send({ error: "The code expired. Show a new one on your computer." });
    if (p.state !== "waiting") return reply.code(409).send({ error: "Another phone already scanned this code. Show a new one on your computer." });
    p.state = "claimed";
    p.code = sixDigits();
    p.deviceName = body.deviceName;
    p.platform = body.platform;
    const user = hub.store.user(p.userId);
    const ws = hub.store.workspace(p.workspaceId);
    return { code: p.code, userName: user?.name ?? null, workspaceName: ws?.name ?? null, expiresAt: new Date(p.expiresAt).toISOString() };
  });

  /** The phone asks until you confirm; the sign-in is handed over exactly once. */
  app.post("/api/pair/:id/status", async (req, reply) => {
    const body = parse(z.object({ secret: z.string() }), req.body, reply);
    if (!body) return;
    const p = phone(req, reply, body.secret);
    if (!p) return;
    if (p.state === "approved" && p.token) {
      const token = p.token;
      pairings.delete(p.id);
      return { state: "approved", token };
    }
    return { state: p.state };
  });
}
