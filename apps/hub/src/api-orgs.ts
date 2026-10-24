import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FEATURE_KEYS, FEATURE_PRESETS, MAX_MODEL_ID_LENGTH, type Features } from "@warren/core";
import type { Caller } from "./api.ts";
import { bearer, issueToken, revokeToken } from "./auth.ts";
import { deviceLabel } from "./api-settings.ts";
import { HARNESS } from "./api-computers.ts";
import { agentDefaults, saveAgentDefaults } from "./agent-defaults.ts";
import { setWorkspaceFeatures, workspaceFeatures } from "./features.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const FEATURE_PRESET = z.enum(["simple", "everything"]);

const welcome = (name: string) =>
  `# Welcome to ${name}\n\nThis is the shared memory vault. Every agent and member can read notes under \`shared/\`.\n\n- Each agent keeps private notes under \`agents/<id>/\`.\n- Make any folders you like, and use **Share** on a folder or note to choose which agents can read or edit it.\n- Link notes with \`[[Note name]]\`; each note lists what links to it, and **Graph** on the Memory page shows how everything connects.\n- Every change is a git commit, so nothing is ever lost.\n`;

/**
 * A new organization: its owner, #general, its own memory vault with a welcome note, and the
 * optional features it starts with (Simple, all off, unless someone picks Everything).
 */
export async function createOrganization(hub: Hub, owner: { id: string; name: string; email: string }, name: string, preset: "simple" | "everything" = "simple") {
  const { store } = hub;
  const ws = store.createWorkspace(name);
  store.addMember(ws.id, owner.id, "owner");
  const prefs = store.prefs(owner.id);
  if (!prefs.experience) store.setPrefs(owner.id, { ...prefs, experience: "simple" });
  const general = store.createChannel(ws.id, "general", "channel", "Everyone, humans and agents");
  store.addChannelMember(general.id, { kind: "user", id: owner.id });
  setWorkspaceFeatures(store, ws.id, FEATURE_PRESETS[preset]);
  const vault = await hub.vaults.open(ws.id);
  await vault.write("shared/Welcome.md", welcome(ws.name), { name: owner.name, email: owner.email }, "Create welcome note");
  return ws;
}

/** Organizations (one person can be in several), optional features, and defaults for new agents. */
export function registerOrgApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const db = store.db;
  const { need, parse } = h;

  /**
   * A sign-in for another organization. The token the person used moves with them, so this
   * browser keeps one sign-in (the list under Settings → Sign-ins stays tidy).
   */
  const moveSession = (req: FastifyRequest, userId: string, workspaceId: string) => {
    const token = issueToken(db, "session", userId, workspaceId, deviceLabel(req.headers["user-agent"]));
    const old = bearer(req.headers.authorization);
    if (old) revokeToken(db, old);
    return token;
  };

  /** Has anything been posted, where this person is, that they haven't read? */
  const hasUnread = (workspaceId: string, userId: string) => {
    const ids = store
      .channels(workspaceId)
      .filter((ch) => !ch.archivedAt && store.isMember(ch.id, { kind: "user", id: userId }))
      .map((ch) => ch.id);
    return Object.values(store.readState(userId, ids)).some((r) => r.unread > 0);
  };

  // --- organizations ----------------------------------------------------------------------------

  app.get("/api/orgs", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const rows = db
      .prepare("SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at")
      .all(c.actor.id) as { id: string; name: string; role: "owner" | "member" | "guest" }[];
    const count = (sql: string, wsId: string) => (db.prepare(sql).get(wsId) as { n: number }).n;
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      members: count("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?", w.id),
      agents: count("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?", w.id),
      current: w.id === c.workspaceId,
      unread: hasUnread(w.id, c.actor.id),
    }));
  });

  app.post("/api/orgs", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), features: FEATURE_PRESET.default("simple") }), req.body, reply);
    if (!body) return;
    const user = store.user(c.actor.id)!;
    const ws = await createOrganization(hub, user, body.name, body.features);
    return { org: { id: ws.id, name: ws.name }, token: moveSession(req, user.id, ws.id) };
  });

  app.post("/api/orgs/:id/switch", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const wsId = (req.params as { id: string }).id;
    if (!store.role(wsId, c.actor.id)) return reply.code(403).send({ error: "you're not in that organization" });
    return { token: moveSession(req, c.actor.id, wsId) };
  });

  /** Someone already signed in joins another organization with its invite link. */
  app.post("/api/invites/join", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ code: z.string().min(1).max(100) }), req.body, reply);
    if (!body) return;
    const i = store.inviteByCode(sha(body.code));
    const usable = i && !i.usedBy && !i.revoked && i.expiresAt > new Date().toISOString() ? i : null;
    if (!usable) return reply.code(404).send({ error: "This invite link has expired or was already used. Ask for a new one." });
    // already in it: no need to spend the invite
    if (!store.role(usable.workspaceId, c.actor.id)) {
      if (!store.useInvite(usable.id, c.actor.id)) return reply.code(409).send({ error: "This invite was just used. Ask for a new one." });
      store.addMember(usable.workspaceId, c.actor.id, usable.role);
      const general = store.channelByName(usable.workspaceId, "general");
      if (general) store.addChannelMember(general.id, { kind: "user", id: c.actor.id });
    }
    return { token: moveSession(req, c.actor.id, usable.workspaceId) };
  });

  // --- optional features (Settings → Features) ----------------------------------------------------

  app.get("/api/features", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    return { features: workspaceFeatures(store, c.workspaceId) };
  });

  app.put("/api/features", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<keyof Features, z.ZodBoolean>).partial().strict(), req.body, reply);
    if (!body) return;
    const features = setWorkspaceFeatures(store, c.workspaceId, body);
    hub.broadcast(c.workspaceId, { type: "features", features });
    return { features };
  });

  // --- defaults for new agents ("Use my defaults" in New agent) -----------------------------------

  app.get("/api/settings/agent-defaults", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return agentDefaults(store, c.workspaceId);
  });

  app.put("/api/settings/agent-defaults", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(
      z
        .object({ harness: HARNESS.nullable(), model: z.string().max(MAX_MODEL_ID_LENGTH).nullable(), computer: z.enum(["own-vm", "none"]), nodeId: z.string().nullable() })
        .partial()
        .strict(),
      req.body,
      reply,
    );
    if (!body) return;
    if (body.nodeId && store.node(body.nodeId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown device" });
    saveAgentDefaults(store, c.workspaceId, body);
    return agentDefaults(store, c.workspaceId);
  });
}
