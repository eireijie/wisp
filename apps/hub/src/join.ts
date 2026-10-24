import crypto from "node:crypto";
import os from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JoinRequestView } from "@warren/core";
import type { Caller } from "./api.ts";
import { issueToken, revokeToken } from "./auth.ts";
import type { Hub } from "./hub.ts";
import { httpOrigin, isLocalJoinAddress, reachableAddresses } from "./reachable-addresses.ts";

export const JOIN_TTL_MS = 10 * 60_000;
export const INVITE_TTL_MS = 24 * 60 * 60_000;
type Status = "pending" | "approved" | "denied" | "expired";
interface JoinRequest extends JoinRequestView {
  secretHash: string;
  workspaceId: string;
  expiresAt: number;
  status: Status;
  hubUrl: string;
  credentials?: { nodeId: string; nodeToken: string; hubUrl: string; workspaceName: string; hubId: string };
}
interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const secret = () => crypto.randomBytes(24).toString("base64url");
const view = (r: JoinRequest): JoinRequestView => ({ id: r.id, name: r.name, kind: r.kind, platform: r.platform, code: r.code, createdAt: r.createdAt });
const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const shell = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export function registerJoinApi(app: FastifyInstance, hub: Hub, { need, parse }: Helpers) {
  const { store } = hub, db = store.db;
  const requests = new Map<string, JoinRequest>();
  const attempts = new Map<string, number[]>();
  // The current role model has owners, members and guests; owner is its administrator role.
  const owners = (ws: string) => (userId: string) => store.role(ws, userId) === "owner";
  const done = (r: JoinRequest) => hub.broadcast(r.workspaceId, { type: "join_request_done", id: r.id }, owners(r.workspaceId));
  const sweep = () => {
    const now = Date.now();
    for (const [id, r] of requests) {
      if (now >= r.expiresAt) {
        if (r.status === "pending") { r.status = "expired"; done(r); }
        if (r.credentials) { revokeToken(db, r.credentials.nodeToken); delete r.credentials; r.status = "expired"; }
      }
      if (now >= r.expiresAt + JOIN_TTL_MS) requests.delete(id);
    }
    for (const [ip, times] of attempts) if (!times.some((t) => now - t < 60_000)) attempts.delete(ip);
    db.prepare("DELETE FROM device_invites WHERE expires_at <= ?").run(now);
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); requests.clear(); attempts.clear(); });
  const invite = (s: string) => db.prepare("SELECT workspace_id AS workspaceId FROM device_invites WHERE hash = ? AND expires_at > ?").get(sha(s), Date.now()) as { workspaceId: string } | undefined;
  const origin = async (req: FastifyRequest) => {
    const publicUrl = httpOrigin(await hub.reach.publicUrl().catch(() => null));
    const browserOrigin = httpOrigin(typeof req.headers.origin === "string" ? req.headers.origin : null);
    const own = browserOrigin && new URL(browserOrigin).host === req.host ? browserOrigin : httpOrigin(`${req.protocol}://${req.host}`);
    return publicUrl ?? reachableAddresses(own, req.socket.localPort ?? Number(process.env.PORT ?? 4747))[0] ?? own;
  };

  app.post("/api/join/requests", async (req, reply) => {
    sweep();
    // Do not trust caller-supplied forwarding headers to grant LAN access; proxied joins use invites.
    const ip = req.socket.remoteAddress ?? req.ip;
    const recent = (attempts.get(ip) ?? []).filter((t) => Date.now() - t < 60_000);
    if (recent.length >= 10) return reply.code(429).header("retry-after", "60").send({ error: "Try again in a minute." });
    attempts.set(ip, [...recent, Date.now()]);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).default(os.hostname()), kind: z.literal("computer"), platform: z.string().trim().min(1).max(80), invite: z.string().min(1).max(200).optional() }), req.body, reply);
    if (!body) return;
    const i = body.invite ? invite(body.invite) : undefined;
    const forwarded = ["forwarded", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"].some((h) => req.headers[h] !== undefined);
    if ((body.invite && !i) || ((!isLocalJoinAddress(ip) || forwarded) && !i)) return reply.code(403).send({ error: "Ask for a new invite link from your Wisp." });
    const workspaceId = i?.workspaceId ?? store.firstWorkspace()?.id;
    if (!workspaceId) return reply.code(409).send({ error: "Finish getting Wisp ready on this computer first." });
    const hubUrl = await origin(req);
    if (!hubUrl) return reply.code(409).send({ error: "Wisp needs a reachable address first." });
    const key = secret(), requestId = crypto.randomBytes(12).toString("base64url");
    const r: JoinRequest = { id: requestId, name: body.name, kind: body.kind, platform: body.platform, code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), createdAt: new Date().toISOString(), secretHash: sha(key), workspaceId, hubUrl, status: "pending", expiresAt: Date.now() + JOIN_TTL_MS };
    requests.set(r.id, r);
    hub.broadcast(workspaceId, { type: "join_request", request: view(r) }, owners(workspaceId));
    return reply.code(201).send({ requestId, secret: key, code: r.code, expiresAt: new Date(r.expiresAt).toISOString() });
  });

  app.get("/api/join/requests", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    sweep();
    return [...requests.values()].filter((r) => r.workspaceId === c.workspaceId && r.status === "pending").map(view);
  });
  app.get("/api/join/requests/:id", async (req, reply) => {
    sweep();
    const r = requests.get((req.params as { id: string }).id), key = req.headers["x-join-secret"];
    if (!r || typeof key !== "string" || !crypto.timingSafeEqual(Buffer.from(sha(key)), Buffer.from(r.secretHash))) return reply.code(404).send({ error: "This request has ended; ask to join again." });
    const credentials = r.credentials;
    delete r.credentials;
    return { status: r.status, ...credentials };
  });
  for (const action of ["approve", "deny"] as const) app.post(`/api/join/requests/:id/${action}`, async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    sweep();
    const r = requests.get((req.params as { id: string }).id);
    if (!r || r.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "This request has ended." });
    if (r.status !== "pending") return reply.code(409).send({ error: "This request has already ended." });
    if (action === "approve") {
      // Synchronous transaction: repeated approvals cannot create extra devices or credentials.
      db.transaction(() => {
        const node = store.createNode(c.workspaceId, r.name, c.actor.id);
        r.credentials = { nodeId: node.id, nodeToken: issueToken(db, "node", node.id, c.workspaceId, r.name), hubUrl: r.hubUrl, workspaceName: store.workspace(c.workspaceId)!.name, hubId: hub.id };
      })();
      r.status = "approved";
    } else r.status = "denied";
    done(r);
    return { status: r.status };
  });

  app.post("/api/join/invites", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    sweep();
    const base = await origin(req);
    if (!base) return reply.code(409).send({ error: "Wisp needs a reachable address first." });
    const key = secret(), expiresAt = Date.now() + INVITE_TTL_MS;
    db.prepare("INSERT INTO device_invites (hash, workspace_id, expires_at) VALUES (?, ?, ?)").run(sha(key), c.workspaceId, expiresAt);
    return { url: `${base}/join/${key}`, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.get("/join/:secret", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    const key = (req.params as { secret: string }).secret;
    if (!invite(key)) return reply.code(410).type("text/html; charset=utf-8").send("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Wisp</title><p>This invite has expired; ask for a new link from your Wisp.</p></html>");
    const base = await origin(req);
    if (!base) return reply.code(409).send({ error: "Wisp needs a reachable address first." });
    const command = `curl -fsSL ${shell(`${base}/install.sh`)} | sh -s join ${shell(`${base}/join/${key}`)}`;
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Join my Wisp</title><style>body{font:18px system-ui;max-width:640px;margin:12vh auto;padding:24px;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:20px;border-radius:12px}</style><h1>Join my Wisp</h1><p>Open Wisp on that computer and pick Join my Wisp, then paste this link.</p><pre>${html(`${base}/join/${key}`)}</pre><p>Or run this on that computer:</p><pre>${html(command)}</pre></html>`);
  });
}
