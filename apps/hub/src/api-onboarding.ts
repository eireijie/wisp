import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { credentialSupport, harnessLabel, type AgentSettings } from "@wisp/core";
import { MEMORY_ANSWER_MAX, MEMORY_LINES_MAX } from "@wisp/core/src/memory-import.ts";
import type { Caller } from "./api.ts";
import { id } from "./auth.ts";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";
import { saveImportedMemory } from "./memory-import.ts";
import { httpOrigin } from "./reachable-addresses.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

/** How long asking a harness on a device may take. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
/** Asks are kept (for polling) this long after they end. */
const ASK_KEEP_MS = 30 * 60_000;
/** A one-time answer link takes an answer for this long. */
export const LINK_TTL_MS = 30 * 60_000;
/** An answer that came in is kept (in memory only) this long after the link ran out. */
const LINK_KEEP_MS = 30 * 60_000;
/** Open links per person, and in all. */
const LINKS_PER_USER = 5;
const LINKS_MAX = 500;
/** Answers one address may post to /m/ a minute (right or wrong code). */
const POSTS_PER_MINUTE = 20;

interface Ask {
  userId: string;
  workspaceId: string;
  status: "running" | "done" | "failed";
  answer?: string;
  error?: string;
  endedAt?: number;
}

interface Link {
  id: string;
  userId: string;
  workspaceId: string;
  expiresAt: number;
  answer: string | null;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * First-run setup's "bring what your AI already knows":
 *
 *   POST /api/agents/:id/memory-import   { lines: { heading, text }[] } → { saved, notes }
 *     (the agent's creator or an owner; lines that look secret are dropped here too)
 *   POST /api/memory-prompt/ask          { nodeId, harness: "claude-code" | "codex" } → { id }
 *   GET  /api/memory-prompt/ask/:id      → { status: "running" | "done" | "failed", answer?, error? }
 *     (the device's owner; the device runs the harness once, read-only, in their home folder)
 *   POST /api/memory-links               → { id, url, expiresAt }   (url: <hub>/m/<code>, works once, for 30 minutes)
 *   GET  /api/memory-links/:id           → { answer: string | null, expired: boolean }   (its creator only)
 *   POST /m/:code                        text/plain or { answer } → { ok: true }, else 410 (no sign-in: the code is the key)
 *
 * Asks and answers live in memory only; nothing here is written down until the person saves lines.
 */
export function registerOnboardingApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse } = h;
  const asks = new Map<string, Ask>();
  const links = new Map<string, Link>();
  /** link id by the hash of its code: a code is never kept, only its hash */
  const byHash = new Map<string, string>();
  const posts = new Map<string, number[]>();

  const sweep = () => {
    const now = Date.now();
    for (const [k, a] of asks) if (a.endedAt && now - a.endedAt > ASK_KEEP_MS) asks.delete(k);
    for (const [lid, l] of links) if (now > l.expiresAt + LINK_KEEP_MS) links.delete(lid);
    for (const [hash, lid] of byHash) if (!links.has(lid) || now > links.get(lid)!.expiresAt) byHash.delete(hash);
    for (const [ip, times] of posts) if (!times.some((t) => now - t < 60_000)) posts.delete(ip);
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    asks.clear();
    links.clear();
    byHash.clear();
  });

  // --- save the lines the person ticked -------------------------------------------------------

  app.post("/api/agents/:id/memory-import", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    if (agent.settings.createdBy !== c.actor.id && c.viewer.role !== "owner") return reply.code(403).send({ error: "only whoever made this agent, or an owner, can add to its notes" });
    const body = parse(z.object({ lines: z.array(z.object({ heading: z.string().max(80), text: z.string().max(500) })).max(MEMORY_LINES_MAX) }), req.body, reply);
    if (!body) return;
    const u = store.user(c.actor.id)!;
    return saveImportedMemory(hub.vault(c.workspaceId), agent, body.lines, { name: u.name, email: u.email });
  });

  // --- ask the AI on one of the person's devices ----------------------------------------------

  app.post("/api/memory-prompt/ask", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ nodeId: z.string().max(100), harness: z.enum(["claude-code", "codex"]) }), req.body, reply);
    if (!body) return;
    const node = store.node(body.nodeId);
    if (!node || node.workspaceId !== c.workspaceId || node.ownerId !== c.actor.id) return reply.code(404).send({ error: "nodeId: that isn't one of your devices" });
    const label = harnessLabel(body.harness);
    if (!hub.isNodeOnline(node.id)) return reply.code(409).send({ error: `${node.name} is offline` });
    if (hub.isNodePaused(node.id)) return reply.code(409).send({ error: `${node.name} is paused` });
    if ([...asks.values()].filter((a) => a.userId === c.actor.id && a.status === "running").length >= 2) return reply.code(429).send({ error: "Wait for the last answer first." });
    // their own connection for that harness, so a device login that ran out doesn't matter
    const conns = hub.models.mine(c.workspaceId, c.actor.id).filter((r) => credentialSupport(body.harness, r.provider, r.kind));
    const conn = conns.find((r) => !r.last_error) ?? conns[0];
    const here = store.nodeCatalog(node.id).find((x) => x.harness === body.harness);
    if (!here) return reply.code(409).send({ error: `${label} isn't installed on ${node.name}` });
    if (!conn && here.accounts?.default === false) return reply.code(409).send({ error: `${label} isn't signed in on ${node.name}` });
    const sent = conn ? hub.models.credentialFor(conn.id) : null;
    const model = sent ? await hub.connectionDefaultModel({ nodeId: node.id, computerId: null, harness: body.harness, settings: {} as AgentSettings }, sent.connectionId).catch(() => undefined) : undefined;
    if (sent) {
      // the device may send back a renewed sign-in for it, as a terminal's
      hub.terminals.handedOut.add(`${node.id}:${sent.connectionId}`);
      hub.models.used(sent.connectionId);
    }
    const askId = id("mask");
    const ask: Ask = { userId: c.actor.id, workspaceId: c.workspaceId, status: "running" };
    asks.set(askId, ask);
    hub.computers
      .nodeRequest(node.id, (requestId) => ({ type: "memory_ask", requestId, harness: body.harness, timeoutMs: ASK_TIMEOUT_MS, ...(sent ? { credential: { ...sent, ...(model ? { model } : {}) } } : {}) }), ASK_TIMEOUT_MS + 30_000)
      .then(
        (r) => {
          const answer = typeof (r as { answer?: unknown })?.answer === "string" ? (r as { answer: string }).answer.slice(0, MEMORY_ANSWER_MAX) : "";
          Object.assign(ask, answer.trim() ? { status: "done", answer } : { status: "failed", error: `${label} didn't answer` }, { endedAt: Date.now() });
        },
        (err) => {
          const why = err instanceof ComputerError && err.status === 504 ? "It took too long" : err instanceof ComputerError && err.status === 503 ? `${node.name} is offline` : (err as Error).message;
          Object.assign(ask, { status: "failed", error: why.slice(0, 500), endedAt: Date.now() });
        },
      );
    return { id: askId };
  });

  app.get("/api/memory-prompt/ask/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const a = asks.get((req.params as { id: string }).id);
    if (!a || a.userId !== c.actor.id || a.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "not found" });
    return { status: a.status, ...(a.answer !== undefined ? { answer: a.answer } : {}), ...(a.error ? { error: a.error } : {}) };
  });

  // --- a one-time link an AI elsewhere can send its answer to ---------------------------------

  app.post("/api/memory-links", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    sweep();
    const now = Date.now();
    const open = [...links.values()].filter((l) => l.userId === c.actor.id && l.expiresAt > now && l.answer === null);
    if (open.length >= LINKS_PER_USER || links.size >= LINKS_MAX) return reply.code(429).send({ error: "Too many links are open. Try again in a few minutes." });
    // 192 random bits: the code is the only key to the link
    const code = crypto.randomBytes(24).toString("base64url");
    const link: Link = { id: id("mlink"), userId: c.actor.id, workspaceId: c.workspaceId, expiresAt: now + LINK_TTL_MS, answer: null };
    links.set(link.id, link);
    byHash.set(sha(code), link.id);
    return { id: link.id, url: `${await baseUrl(req)}/m/${code}`, expiresAt: new Date(link.expiresAt).toISOString() };
  });

  app.get("/api/memory-links/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const l = links.get((req.params as { id: string }).id);
    if (!l || l.userId !== c.actor.id || l.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "not found" });
    return { answer: l.answer, expired: l.answer === null && Date.now() > l.expiresAt };
  });

  /**
   * The AI's answer. No sign-in: the code is the key. It works once, while the link is open; every
   * other code (wrong, used or run out) gets the same 410, so nothing can be learned by trying codes,
   * and nothing is ever sent back but { ok }.
   */
  app.post("/m/:code", { bodyLimit: 4 * MEMORY_ANSWER_MAX + 4096 }, async (req, reply) => {
    const ip = req.ip;
    const now = Date.now();
    const recent = (posts.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= POSTS_PER_MINUTE) return reply.code(429).header("retry-after", "60").send({ error: "Try again in a minute." });
    posts.set(ip, [...recent, now]);
    const gone = () => reply.code(410).send({ error: "This link has run out or was already used. Paste the answer into Wisp instead." });
    const code = (req.params as { code: string }).code;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return gone();
    const lid = byHash.get(sha(code));
    const link = lid ? links.get(lid) : undefined;
    if (!link || link.answer !== null || now > link.expiresAt) return gone();
    const raw = req.body;
    const answer = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { answer?: unknown }).answer === "string" ? (raw as { answer: string }).answer : null;
    if (answer === null || !answer.trim()) return reply.code(400).send({ error: 'Send the answer as plain text, or as JSON: { "answer": "..." }' });
    if (answer.length > MEMORY_ANSWER_MAX) return reply.code(413).send({ error: `That's too long; the most is ${MEMORY_ANSWER_MAX} characters.` });
    link.answer = answer;
    // used: the code no longer opens anything
    byHash.delete(sha(code));
    return { ok: true };
  });

  /** The address people's AIs reach this hub at: its public one, else the one this request came to. */
  async function baseUrl(req: FastifyRequest): Promise<string> {
    const pub = httpOrigin(await hub.reach.publicUrl().catch(() => null));
    if (pub) return pub;
    const browser = httpOrigin(typeof req.headers.origin === "string" ? req.headers.origin : null);
    const own = httpOrigin(`${req.protocol}://${req.host}`) ?? `${req.protocol}://${req.host}`;
    return browser && new URL(browser).host === req.host ? browser : own;
  }
}
