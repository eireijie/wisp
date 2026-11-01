import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { harnessInfo, type UserPrefs } from "@wisp/core";
import type { Caller } from "./api.ts";
import { bearer, hashPassword, issueToken, revokeSubjectTokens, verifyPassword } from "./auth.ts";
import { ComputerError } from "./computers.ts";
import type { Hub } from "./hub.ts";
import { ASK_BEFORE, agentPolicy } from "./policy.ts";
import { DEFAULT_TOPIC } from "./apns.ts";
import { parseServiceAccount } from "./fcm.ts";
import { registerHarnessSettingsApi } from "./api-harness-settings.ts";
import { featureOn } from "./features.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  /** where the hub keeps its data (for the Data page) */
  dataDir: string;
}

const TIMEZONE = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone");
const ROLE = z.enum(["owner", "member", "guest"]);
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** "Chrome on Mac", "Safari on iPhone": enough to recognize a sign-in. */
export function deviceLabel(ua: string | undefined): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? "Script" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Settings: your profile, preferences, password and sign-ins; the workspace's name, people and
 * invites; rules for agents; computer defaults; connection tokens; harnesses on devices; exports.
 */
export function registerSettingsApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const db = store.db;
  const { need, parse } = h;

  // --- you ------------------------------------------------------------------------------------

  app.patch("/api/me", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email(), preferredName: z.string().trim().max(40).nullable(), timezone: TIMEZONE.nullable() }).partial(),
      req.body,
      reply,
    );
    if (!body) return;
    if (body.email) {
      const other = store.userByEmail(body.email);
      if (other && other.id !== c.actor.id) return reply.code(409).send({ error: "another account already uses that email" });
    }
    return store.updateUser(c.actor.id, { ...body, preferredName: body.preferredName === "" ? null : body.preferredName });
  });

  app.put("/api/me/prefs", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ sendWith: z.enum(["enter", "mod-enter"]), clock: z.enum(["auto", "12h", "24h"]), toolCalls: z.enum(["collapsed", "expanded", "hidden"]), experience: z.enum(["simple", "advanced"]) }).partial(), req.body, reply);
    if (!body) return;
    return store.setPrefs(c.actor.id, { ...store.prefs(c.actor.id), ...body } as UserPrefs);
  });

  /** Change your password; your other sign-ins end. */
  app.post("/api/me/password", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ current: z.string().max(200), next: z.string().min(8).max(200) }), req.body, reply);
    if (!body) return;
    const hash = store.passwordHash(c.actor.id);
    if (!hash || !verifyPassword(body.current, hash)) return reply.code(403).send({ error: "your current password isn't right" });
    store.updateUser(c.actor.id, { passwordHash: hashPassword(body.next) });
    const mine = sha(bearer(req.headers.authorization) ?? "");
    db.prepare("DELETE FROM tokens WHERE kind = 'session' AND subject_id = ? AND hash != ?").run(c.actor.id, mine);
    hub.disconnectRevokedSessions(c.actor.id);
    return { ok: true };
  });

  app.get("/api/me/sessions", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const mine = sha(bearer(req.headers.authorization) ?? "");
    return store.sessions(c.actor.id).map(({ hash, ...s }) => ({ ...s, current: hash === mine }));
  });

  app.delete("/api/me/sessions/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    if (!store.revokeTokenById("session", (req.params as { id: string }).id, { subjectId: c.actor.id })) return reply.code(404).send({ error: "sign-in not found" });
    hub.disconnectRevokedSessions(c.actor.id);
    return { ok: true };
  });

  app.post("/api/me/sessions/sign-out-others", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const mine = sha(bearer(req.headers.authorization) ?? "");
    const n = db.prepare("DELETE FROM tokens WHERE kind = 'session' AND subject_id = ? AND hash != ?").run(c.actor.id, mine).changes;
    hub.disconnectRevokedSessions(c.actor.id);
    return { signedOut: n };
  });

  // --- push notifications to Wisp's iOS app ---------------------------------------------------------

  /** Whether this hub can send pushes, and the phones you get them on. */
  app.get("/api/me/push", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    // `android` is what the Android app starts Firebase with (null when this hub has no Firebase set up)
    const firebase = hub.fcm.client(c.workspaceId);
    return { available: !!hub.apns.config(c.workspaceId), devices: hub.apns.devices(c.actor.id).length, android: { available: !!firebase, firebase } };
  });

  /** The iOS app sends its APNs device token here after you allow notifications; the Android app its FCM token (platform "android"). */
  app.post("/api/me/push", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(
      z.discriminatedUnion("platform", [
        z.object({ platform: z.literal("ios").default("ios"), token: z.string().regex(/^[0-9a-fA-F]{32,200}$/, "an APNs device token in hex"), bundleId: z.string().max(200).nullish(), environment: z.enum(["production", "sandbox"]).nullish() }),
        z.object({ platform: z.literal("android"), token: z.string().regex(/^[A-Za-z0-9:_-]{20,4096}$/, "an FCM registration token"), bundleId: z.string().max(200).nullish() }),
      ]),
      { platform: "ios", ...(req.body as object) },
      reply,
    );
    if (!body) return;
    if (c.principal.kind !== "session") return reply.code(403).send({ error: "only a signed-in app can get pushes" });
    hub.apns.register(sha(bearer(req.headers.authorization) ?? ""), c.actor.id, c.workspaceId, body);
    return { ok: true, available: body.platform === "android" ? !!hub.fcm.config(c.workspaceId) : !!hub.apns.config(c.workspaceId) };
  });

  /** Stop pushes to this sign-in (or one of its phones). Signing out does this too. */
  app.delete("/api/me/push", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const token = (req.query as { token?: string }).token;
    return { removed: hub.apns.unregister(sha(bearer(req.headers.authorization) ?? ""), token) };
  });

  /** Send yourself a test push. */
  app.post("/api/me/push/test", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    if (!hub.apns.config(c.workspaceId) && !hub.fcm.config(c.workspaceId)) return reply.code(409).send({ error: "push isn't set up on this hub; add an APNs key (iPhone) or a Firebase service account (Android) first" });
    return hub.apns.sendTo(c.workspaceId, c.actor.id, { aps: { alert: { title: "Wisp", body: "Notifications work on this phone." } }, wisp: { kind: "test", category: "other" } });
  });

  /** The APNs key, without the key itself. */
  const pushSettings = (workspaceId: string) => {
    const cfg = hub.apns.config(workspaceId);
    return cfg ? { configured: true, source: cfg.source, keyId: cfg.keyId, teamId: cfg.teamId, topic: cfg.topic, environment: cfg.environment } : { configured: false };
  };

  app.get("/api/settings/push", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    return pushSettings(c.workspaceId);
  });

  app.put("/api/settings/push", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z
        .object({
          keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, "the 10-character Key ID"),
          teamId: z.string().trim().regex(/^[A-Z0-9]{10}$/, "the 10-character Team ID"),
          key: z.string().trim().max(10_000),
          topic: z.string().trim().max(200).default(DEFAULT_TOPIC),
          environment: z.enum(["production", "sandbox"]).default("production"),
        }),
      req.body,
      reply,
    );
    if (!body) return;
    try {
      hub.apns.saveConfig(c.workspaceId, body);
    } catch {
      return reply.code(400).send({ error: "that isn't a .p8 key; paste the whole file, BEGIN and END lines included" });
    }
    return pushSettings(c.workspaceId);
  });

  app.delete("/api/settings/push", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    hub.apns.saveConfig(c.workspaceId, null);
    return pushSettings(c.workspaceId);
  });

  /** The Firebase setup for Android push, without the service account's key. */
  const androidSettings = (workspaceId: string) => {
    const cfg = hub.fcm.config(workspaceId);
    return cfg ? { configured: true, source: cfg.source, projectId: cfg.serviceAccount.project_id, clientEmail: cfg.serviceAccount.client_email, applicationId: cfg.applicationId, apiKey: cfg.apiKey, senderId: cfg.senderId } : { configured: false };
  };

  app.get("/api/settings/push/android", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    return androidSettings(c.workspaceId);
  });

  app.put("/api/settings/push/android", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z.object({
        serviceAccount: z.string().trim().max(20_000),
        applicationId: z.string().trim().regex(/^\d+:\d+:android:[0-9a-f]+$/, "the Android app id, like 1:1234567890:android:abc123"),
        apiKey: z.string().trim().min(10).max(200),
        senderId: z.string().trim().regex(/^\d+$/, "the numeric sender id (project number)"),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    try {
      hub.fcm.saveConfig(c.workspaceId, { ...body, serviceAccount: parseServiceAccount(body.serviceAccount) });
    } catch {
      return reply.code(400).send({ error: "that isn't a Firebase service account key; paste the whole JSON file" });
    }
    return androidSettings(c.workspaceId);
  });

  app.delete("/api/settings/push/android", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    hub.fcm.saveConfig(c.workspaceId, null);
    return androidSettings(c.workspaceId);
  });

  // --- the workspace and its people ------------------------------------------------------------------

  app.patch("/api/workspace", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body, reply);
    if (!body) return;
    store.renameWorkspace(c.workspaceId, body.name);
    return store.workspace(c.workspaceId);
  });

  const owners = (wsId: string) => store.members(wsId).filter((m) => m.role === "owner");
  const memberOf = (c: Caller, userId: string) => store.members(c.workspaceId).find((m) => m.id === userId);

  app.patch("/api/members/:id", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const m = memberOf(c, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not a member" });
    const body = parse(z.object({ role: ROLE }), req.body, reply);
    if (!body) return;
    if (m.role === "owner" && body.role !== "owner" && owners(c.workspaceId).length === 1) return reply.code(409).send({ error: "a workspace needs at least one owner; make someone else an owner first" });
    store.addMember(c.workspaceId, m.id, body.role);
    return memberOf(c, m.id);
  });

  app.delete("/api/members/:id", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const m = memberOf(c, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not a member" });
    if (m.id === c.actor.id) return reply.code(409).send({ error: "you can't remove yourself; another owner can" });
    // what they connected stops working too: their tokens, and the devices they own (with the
    // harness tokens of the agents on them). The devices stay listed, owned by nobody, until an
    // owner removes them; they can't reconnect without a new token.
    db.prepare("DELETE FROM tokens WHERE created_by = ?").run(m.id);
    for (const n of store.nodes(c.workspaceId).filter((n) => n.ownerId === m.id)) {
      revokeSubjectTokens(db, "node", n.id);
      for (const a of store.agentsOnNode(n.id)) db.prepare("DELETE FROM tokens WHERE kind = 'agent' AND subject_id = ? AND label LIKE 'harness:%'").run(a.id);
      store.setNodeOwner(n.id, null);
      hub.disconnectNode(n.id);
    }
    store.removeMember(c.workspaceId, m.id);
    hub.disconnectUser(m.id);
    return { ok: true };
  });

  /** An owner sets a temporary password for someone who's locked out; their sign-ins end. */
  app.post("/api/members/:id/password", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const m = memberOf(c, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: "not a member" });
    const body = parse(z.object({ password: z.string().min(8).max(200) }), req.body, reply);
    if (!body) return;
    store.updateUser(m.id, { passwordHash: hashPassword(body.password) });
    db.prepare("DELETE FROM tokens WHERE kind = 'session' AND subject_id = ?").run(m.id);
    hub.disconnectRevokedSessions(m.id);
    return { ok: true };
  });

  // --- invites: a link someone opens to make their account ---------------------------------------------

  const inviteView = (i: NonNullable<ReturnType<typeof store.invite>>) => ({ id: i.id, role: i.role, createdBy: i.createdBy, createdAt: i.createdAt, expiresAt: i.expiresAt });

  app.get("/api/invites", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    return store.openInvites(c.workspaceId).map(inviteView);
  });

  app.post("/api/invites", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    if (!featureOn(store, c.workspaceId, "invite")) return reply.code(403).send({ error: "Inviting people is switched off for this organization. Turn on the Invite people mod first." });
    const body = parse(z.object({ role: ROLE.default("member"), days: z.number().int().min(1).max(30).default(7) }), req.body, reply);
    if (!body) return;
    const code = crypto.randomBytes(18).toString("base64url");
    const invite = store.createInvite({ workspaceId: c.workspaceId, codeHash: sha(code), role: body.role, createdBy: c.actor.id, expiresAt: new Date(Date.now() + body.days * 86_400_000).toISOString() });
    // the code is shown once; only its hash is kept
    return { ...inviteView(invite), code };
  });

  app.delete("/api/invites/:id", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const i = store.invite((req.params as { id: string }).id);
    if (!i || i.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "invite not found" });
    store.revokeInvite(i.id);
    return { ok: true };
  });

  const usable = (code: string | undefined) => {
    const i = code ? store.inviteByCode(sha(code)) : undefined;
    return i && !i.usedBy && !i.revoked && i.expiresAt > new Date().toISOString() ? i : null;
  };

  /** For the sign-up page: is this invite good, and to what? Anyone with the link can ask. */
  app.get("/api/invites/check", async (req, reply) => {
    const i = usable((req.query as { code?: string }).code);
    if (!i) return reply.code(404).send({ error: "This invite link has expired or was already used. Ask for a new one." });
    return { workspace: store.workspace(i.workspaceId)?.name ?? "Wisp", role: i.role, expiresAt: i.expiresAt };
  });

  app.post("/api/invites/accept", async (req, reply) => {
    const body = parse(z.object({ code: z.string().max(100), name: z.string().trim().min(1).max(80), email: z.string().trim().email(), password: z.string().min(8).max(200) }), req.body, reply);
    if (!body) return;
    const i = usable(body.code);
    if (!i) return reply.code(404).send({ error: "This invite link has expired or was already used. Ask for a new one." });
    if (store.userByEmail(body.email)) return reply.code(409).send({ error: "There's already an account with that email. Sign in instead." });
    const u = store.createUser(body.email, body.name, hashPassword(body.password));
    if (!store.useInvite(i.id, u.id)) return reply.code(409).send({ error: "This invite was just used. Ask for a new one." });
    store.addMember(i.workspaceId, u.id, i.role);
    const general = store.channelByName(i.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "user", id: u.id });
    return { token: issueToken(db, "session", u.id, i.workspaceId, deviceLabel(req.headers["user-agent"])) };
  });

  // --- agents: what they ask about first, and limits ------------------------------------------------------

  app.get("/api/settings/agents", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return agentPolicy(hub, c.workspaceId);
  });

  app.put("/api/settings/agents", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z.object({ askBefore: z.array(z.enum(ASK_BEFORE)), maxHops: z.number().int().min(1).max(30), maxRunsPerMinute: z.number().int().min(1).max(200), defaultAccess: z.enum(["read-only", "edit", "full"]), leadsCreateAgents: z.boolean(), subAgents: z.boolean(), maxAgentMade: z.number().int().min(1).max(50), learnSkills: z.boolean() }).partial(),
      req.body,
      reply,
    );
    if (!body) return;
    if (body.askBefore) store.setSetting(c.workspaceId, "agents.askBefore", JSON.stringify([...new Set(body.askBefore)]));
    if (body.maxHops) store.setSetting(c.workspaceId, "agents.maxHops", String(body.maxHops));
    if (body.maxRunsPerMinute) store.setSetting(c.workspaceId, "agents.maxRunsPerMinute", String(body.maxRunsPerMinute));
    if (body.defaultAccess) store.setSetting(c.workspaceId, "agents.defaultAccess", body.defaultAccess);
    if (body.leadsCreateAgents !== undefined) store.setSetting(c.workspaceId, "agents.leadsCreateAgents", String(body.leadsCreateAgents));
    if (body.subAgents !== undefined) store.setSetting(c.workspaceId, "agents.subAgents", String(body.subAgents));
    if (body.maxAgentMade) store.setSetting(c.workspaceId, "agents.maxAgentMade", String(body.maxAgentMade));
    if (body.learnSkills !== undefined) store.setSetting(c.workspaceId, "agents.learnSkills", String(body.learnSkills));
    return agentPolicy(hub, c.workspaceId);
  });

  // --- connections: tokens agents and harnesses connect with ---------------------------------------------

  app.get("/api/connections", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const rows = db
      .prepare("SELECT t.hash, t.subject_id, t.label, t.created_by, t.created_at, t.last_used FROM tokens t JOIN agents a ON a.id = t.subject_id WHERE t.kind = 'agent' AND t.workspace_id = ? ORDER BY t.created_at DESC")
      .all(c.workspaceId) as { hash: string; subject_id: string; label: string; created_by: string | null; created_at: string; last_used: string | null }[];
    return rows
      .filter((r) => c.viewer.role === "owner" || r.created_by === c.actor.id)
      .map((r) => {
        const nodeId = r.label.startsWith("harness:") ? r.label.slice(8) : null;
        return {
          id: r.hash.slice(0, 16),
          agentId: r.subject_id,
          kind: nodeId ? ("harness" as const) : ("connection" as const),
          device: nodeId ? (store.node(nodeId)?.name ?? null) : null,
          createdBy: r.created_by,
          createdAt: r.created_at,
          lastUsed: r.last_used,
        };
      });
  });

  app.delete("/api/connections/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const id = (req.params as { id: string }).id;
    const row = /^[0-9a-f]{16}$/.test(id) ? (db.prepare("SELECT t.created_by, t.workspace_id FROM tokens t WHERE t.kind = 'agent' AND t.hash LIKE ?").all(`${id}%`) as { created_by: string | null; workspace_id: string }[]) : [];
    if (row.length !== 1 || row[0].workspace_id !== c.workspaceId) return reply.code(404).send({ error: "connection not found" });
    if (c.viewer.role !== "owner" && row[0].created_by !== c.actor.id) return reply.code(403).send({ error: "only its creator or an owner can disconnect it" });
    store.revokeTokenById("agent", id);
    return { ok: true };
  });

  // --- harnesses on devices ------------------------------------------------------------------------------

  const deviceFor = (c: Caller, nodeId: string, reply: FastifyReply, opts: { ownerOnly?: boolean } = {}) => {
    const n = store.node(nodeId);
    if (!n || n.workspaceId !== c.workspaceId) return void reply.code(404).send({ error: "device not found" });
    if (n.ownerId !== c.actor.id && (opts.ownerOnly || !n.shared)) return void reply.code(403).send({ error: `only the person who connected ${n.name} can do that` });
    if (!hub.isNodeOnline(n.id)) return void reply.code(503).send({ error: `${n.name} is offline` });
    return n;
  };

  /** Look again at what a device has: harnesses, VM support, agents to import. */
  app.post("/api/nodes/:id/refresh", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const n = deviceFor(c, (req.params as { id: string }).id, reply);
    if (!n) return;
    hub.sendToNode(n.id, { type: "refresh" });
    return { ok: true };
  });

  /** Install a harness on your device. The device runs its own recipe for it (npm), nothing the hub sends. */
  app.post("/api/nodes/:id/install", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const n = deviceFor(c, (req.params as { id: string }).id, reply, { ownerOnly: true });
    if (!n) return;
    const body = parse(z.object({ harness: z.string().max(60) }), req.body, reply);
    if (!body) return;
    if (!harnessInfo(body.harness)?.install?.npm) return reply.code(400).send({ error: "Wisp can't install that one for you; use its installer on the device" });
    try {
      return await hub.computers.nodeRequest(n.id, (requestId) => ({ type: "install_harness", requestId, harness: body.harness }), 16 * 60_000);
    } catch (err) {
      if (err instanceof ComputerError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  registerHarnessSettingsApi(app, hub, h);

  // --- your data ------------------------------------------------------------------------------------

  app.get("/api/settings/data", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const count = (sql: string) => (db.prepare(sql).get(c.workspaceId) as { n: number }).n;
    return {
      dataDir: h.dataDir,
      notes: hub.vault(c.workspaceId).list(() => true).length,
      messages: count("SELECT COUNT(*) AS n FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.workspace_id = ?"),
      files: count("SELECT COUNT(*) AS n FROM files WHERE workspace_id = ?"),
      agents: count("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?"),
    };
  });

  /** The whole memory vault as a zip of markdown files, straight from its git repository. */
  app.get("/api/export/vault.zip", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const child = spawn("git", ["-C", hub.vault(c.workspaceId).root, "archive", "--format=zip", "--prefix=memory/", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="wisp-memory-${new Date().toISOString().slice(0, 10)}.zip"`);
    return reply.send(child.stdout);
  });

  /** Every conversation you can see, as JSON: channels, DMs and threads with who said what. */
  app.get("/api/export/conversations.json", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const members = Object.fromEntries(store.members(c.workspaceId).map((m) => [m.id, m.name]));
    const agents = Object.fromEntries(store.agents(c.workspaceId).map((a) => [a.id, `@${a.handle}`]));
    const channels = store.channels(c.workspaceId).filter((ch) => ch.kind === "channel" || store.isMember(ch.id, c.actor));
    const out = channels.map((ch) => ({
      name: ch.kind === "dm" ? `DM ${store.channelMembers(ch.id).map((m) => (m.kind === "user" ? members[m.id] : agents[m.id]) ?? m.id).join(", ")}` : `#${ch.name}`,
      topic: ch.topic,
      messages: (db.prepare("SELECT id, thread_id, author_kind, author_id, body, created_at FROM messages WHERE channel_id = ? ORDER BY created_at").all(ch.id) as { id: string; thread_id: string | null; author_kind: string; author_id: string; body: string; created_at: string }[])
        .filter((m) => m.body)
        .map((m) => ({ id: m.id, thread: m.thread_id, at: m.created_at, from: m.author_kind === "agent" ? (agents[m.author_id] ?? "agent") : (members[m.author_id] ?? (m.author_id === "system" ? "Wisp" : "someone")), text: m.body })),
    }));
    reply.header("content-disposition", `attachment; filename="wisp-conversations-${new Date().toISOString().slice(0, 10)}.json"`);
    return { workspace: store.workspace(c.workspaceId)?.name, exportedAt: new Date().toISOString(), channels: out };
  });
}
