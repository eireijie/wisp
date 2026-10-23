import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GHOST_ACCESSORIES,
  GHOST_EYES,
  GHOST_HATS,
  GHOST_MOTIONS,
  GHOST_MOUTHS,
  GHOST_SHAPES,
  MAX_MODEL_ID_LENGTH,
  accessChecker,
  atLeast,
  cleanRulePath,
  covers,
  soulPath,
  soulTemplate,
  personDir,
  specificity,
  startupRules,
  subjectKey,
  pickReviewer,
  teamChain,
  teamProblem,
  type AccessRule,
  type Actor,
  type ChannelTeam,
  type MemoryLevel,
  type Subject,
  type Viewer,
} from "@warren/core";
import { VaultError, notePath } from "@warren/vault";
import { MEMORY_KINDS } from "./profile.ts";
import { MAX_ROUNDS } from "./discussions.ts";
import { bearer, hashPassword, issueToken, resolveToken, revokeSubjectTokens, revokeToken, verifyPassword, type Principal } from "./auth.ts";
import type { Hub } from "./hub.ts";
import { HARNESS, registerComputerApi } from "./api-computers.ts";
import { registerUpdateApi } from "./updates.ts";
import { deviceLabel, registerSettingsApi } from "./api-settings.ts";
import { registerVoiceApi } from "./api-voice.ts";
import { registerMemoryStorageApi } from "./api-memory.ts";
import type { MoveResult, VaultLocation } from "./vault-location.ts";
import { registerConnectorApi } from "./api-connectors.ts";
import { registerBackgroundApi } from "./api-background.ts";
import { registerLeadApi, workspaceLead } from "./lead.ts";
import { registerPairingApi } from "./pairing.ts";
import { registerReachApi } from "./api-reach.ts";
import { agentPolicy } from "./policy.ts";
import { FEATURE_PRESET, createOrganization, registerOrgApi } from "./api-orgs.ts";
import { agentDefaults } from "./agent-defaults.ts";
import { spawnRight } from "./spawn.ts";
import { workspaceFeatures } from "./features.ts";
import { VM_SIZES, computerDefaults } from "./policy.ts";

export interface Caller {
  principal: Principal;
  workspaceId: string;
  actor: Actor;
  viewer: Viewer;
}

const HANDLE = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes; must start with a letter");
const CHANNEL_NAME = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,79}$/, "lowercase, no spaces");
/** One emoji (or a short emoji sequence); no text, markup or whitespace. */
const EMOJI = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u, "must be an emoji")
  // Emoji_Component alone also matches digits, # and *, so require a real pictograph or flag
  .refine((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s), "must be an emoji");
const APPEARANCE = z
  .object({
    shape: z.enum(GHOST_SHAPES),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb color"),
    color2: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb color").optional(),
    // glow was removed; older clients may still send it
    glow: z.boolean().optional(),
    eyes: z.enum(GHOST_EYES),
    mouth: z.enum(GHOST_MOUTHS),
    cheeks: z.boolean(),
    hat: z.enum(GHOST_HATS),
    accessory: z.enum(GHOST_ACCESSORIES),
    motion: z.enum(GHOST_MOTIONS),
  })
  .strict();
const SETTINGS = z
  .object({
    effort: z.string().regex(/^[a-z]{1,16}$/).nullable(),
    access: z.enum(["read-only", "edit", "full"]),
    soulLocked: z.boolean(),
    fast: z.boolean(),
    appearance: APPEARANCE,
    voice: z.object({ device: z.string().max(300).optional(), openai: z.string().max(100).optional(), elevenlabs: z.string().max(100).optional() }).strict(),
    headless: z.boolean(),
    anyoneCanAsk: z.boolean(),
    runIn: z.enum(["computer", "device"]),
    role: z.string().trim().max(60),
    roleNotes: z.string().max(2000),
    respondTo: z.enum(["me", "anyone", "people"]),
    respondPeople: z.array(z.string().min(1)).max(500),
    /** set by the hub when the agent is made; accepted (and ignored) so a client can send settings back as it got them */
    createdBy: z.string().optional(),
  })
  .partial()
  .strict();
const LEVEL = z.enum(["none", "read", "edit", "manage"]);
const SUBJECT = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1) }),
  z.object({ kind: z.literal("members") }),
  z.object({ kind: z.literal("guests") }),
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }),
  z.object({ kind: z.literal("team"), name: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("role"), team: z.string().min(1).max(60), role: z.string().min(1).max(60) }),
  z.object({ kind: z.literal("all_agents") }),
]);

/** The name an upload came with (`x-filename`, URL-encoded by the web app), as a plain file name; a badly encoded one is taken as it is. */
export function fileName(header: unknown): string {
  const raw = typeof header === "string" ? header : "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {}
  return name.replace(/[/\\]/g, "_").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || "file";
}

/** A `?limit=` query value as a whole number within [1, max]; anything else (missing, "abc", 0, -5) means the default. */
export function limitParam(raw: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export interface RegisterOptions {
  filesDir: string;
  dataDir: string;
  /** where memory was opened from at startup, and what happened to an earlier vault */
  vault: { location: VaultLocation; moved: MoveResult | null };
  /** stop the hub so whatever keeps it running starts it again */
  restart: () => void;
}

export function registerApi(app: FastifyInstance, hub: Hub, opts: RegisterOptions) {
  const { store } = hub;
  /** The memory vault of the caller's organization. */
  const vaultOf = (c: Caller) => hub.vault(c.workspaceId);
  const db = store.db;

  // --- helpers ----------------------------------------------------------------

  function caller(req: FastifyRequest): Caller | null {
    const p = resolveToken(db, bearer(req.headers.authorization));
    if (!p) return null;
    if (p.kind === "session") {
      const role = store.role(p.workspaceId, p.subjectId);
      if (!role) return null;
      return { principal: p, workspaceId: p.workspaceId, actor: { kind: "user", id: p.subjectId }, viewer: { actor: { kind: "user", id: p.subjectId }, role } };
    }
    let agentId = p.kind === "agent" ? p.subjectId : null;
    // Nodes act on behalf of the agents they host (the harness gets the node token + agent id).
    if (p.kind === "node") {
      const as = req.headers["x-warren-agent"];
      if (typeof as === "string") {
        const a = store.agent(as);
        if (!a || a.nodeId !== p.subjectId) return null;
        agentId = a.id;
      }
    }
    if (!agentId) return { principal: p, workspaceId: p.workspaceId, actor: { kind: "agent", id: "" }, viewer: { actor: { kind: "agent", id: "" } } };
    const agent = store.agent(agentId);
    if (!agent) return null;
    return { principal: p, workspaceId: p.workspaceId, actor: { kind: "agent", id: agent.id }, viewer: hub.access.agentViewer(agent) };
  }

  /**
   * The caller, or a 401/403. `user`: people only; `member`: people who aren't guests; `owner`:
   * workspace owners; `notGuest`: people who aren't guests, and agents (which act for a member).
   */
  function need(req: FastifyRequest, reply: FastifyReply, opts: { owner?: boolean; user?: boolean; member?: boolean; notGuest?: boolean } = {}): Caller | null {
    const c = caller(req);
    if (!c || (c.actor.kind === "agent" && !c.actor.id)) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if ((opts.user || opts.owner || opts.member) && c.actor.kind !== "user") {
      reply.code(403).send({ error: "users only" });
      return null;
    }
    if ((opts.member || opts.notGuest) && c.actor.kind === "user" && c.viewer.role === "guest") {
      reply.code(403).send({ error: opts.member ? "guests can't change agents or devices" : "guests can look around, but can't give agents work" });
      return null;
    }
    if (opts.owner && c.viewer.role !== "owner") {
      reply.code(403).send({ error: "owner only" });
      return null;
    }
    return c;
  }

  function parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null {
    const r = schema.safeParse(data);
    if (!r.success) {
      reply.code(400).send({ error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
      return null;
    }
    return r.data;
  }

  /** What this caller may do with each memory path. */
  const memory = (c: Caller) => hub.access.checker(c.workspaceId, c.viewer);
  const readable = (c: Caller) => {
    const check = memory(c);
    return (p: string) => atLeast(check(p).level, "read");
  };

  /** Validate a note path and require at least `need` on it. Returns the normalized path. */
  function noteFor(c: Caller, raw: string, need: MemoryLevel, reply: FastifyReply): string | null {
    let p: string;
    try {
      p = notePath(raw);
      vaultOf(c).resolve(p);
    } catch {
      reply.code(400).send({ error: "invalid path" });
      return null;
    }
    if (atLeast(memory(c)(p).level, need)) return p;
    const lockedSoul = c.actor.kind === "agent" && c.viewer.soulLocked && p.toLowerCase() === soulPath(c.actor.id).toLowerCase();
    reply.code(403).send({ error: lockedSoul ? "your soul is locked by your owner" : `no ${need} access to ${p}` });
    return null;
  }

  /** A folder or note path for an access rule ("" is the whole vault). */
  function rulePathFor(raw: string, reply: FastifyReply): string | null {
    const p = cleanRulePath(raw);
    try {
      if (p) hub.vaults.primary.resolve(p);
      return p;
    } catch {
      reply.code(400).send({ error: "invalid path" });
      return null;
    }
  }

  /** People who restrict a folder keep managing it, so nobody locks themselves out by accident. */
  function keepManaging(c: Caller, path: string) {
    if (c.actor.kind === "user" && !atLeast(memory(c)(path).level, "manage")) store.setAccessRule(c.workspaceId, { path, subject: { kind: "user", id: c.actor.id }, level: "manage", createdBy: c.actor });
  }

  /** Owners can look at memory through an agent's or person's eyes ("agent:<id>" / "user:<id>"). */
  function viewAs(c: Caller, key: string, reply: FastifyReply): Viewer | null {
    if (c.viewer.role !== "owner") {
      reply.code(403).send({ error: "owner only" });
      return null;
    }
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const agent = kind === "agent" ? store.agent(id) : undefined;
    if (agent && agent.workspaceId === c.workspaceId) return hub.access.agentViewer(agent);
    const role = kind === "user" ? store.role(c.workspaceId, id) : undefined;
    if (role) return { actor: { kind: "user", id }, role };
    reply.code(404).send({ error: "no such agent or person" });
    return null;
  }

  function commitAuthor(c: Caller) {
    if (c.actor.kind === "agent") {
      const a = store.agent(c.actor.id)!;
      return { name: `@${a.handle}`, email: `${a.handle}@agents.warren` };
    }
    const u = store.user(c.actor.id)!;
    return { name: u.name, email: u.email };
  }

  function channelVisible(c: Caller, channelId: string) {
    const ch = store.channel(channelId);
    if (!ch || ch.workspaceId !== c.workspaceId) return undefined;
    if (ch.kind === "dm" || ch.private) {
      const members = store.channelMembers(ch.id);
      const isMember = members.some((m) => m.kind === c.actor.kind && m.id === c.actor.id);
      if (!isMember && c.viewer.role !== "owner") return undefined;
    }
    return ch;
  }

  const agentView = (a: NonNullable<ReturnType<typeof store.agent>>) => ({ ...a, status: hub.agentStatus(a) });

  /** Can this person put agents and VMs on the device? Its owner can; others once the owner shares it. */
  const canUseDevice = (c: Caller, nodeId: string) => {
    const n = store.node(nodeId);
    return !!n && n.workspaceId === c.workspaceId && (n.ownerId === c.actor.id || n.shared);
  };
  /** The person whose device an agent's harness runs on directly; only they change or connect to it (unless they shared the device). */
  const deviceOwnerOf = (a: Parameters<typeof hub.harnessOnDevice>[0]) => {
    const node = a.nodeId && hub.harnessOnDevice(a) ? store.node(a.nodeId) : undefined;
    return node && !node.shared ? node.ownerId : null;
  };
  /**
   * The person a caller works for: a person themselves; an agent, whoever asked it for what it's
   * doing now, or else whoever made the token it connected with (a device's own token: its owner).
   */
  const requesterOf = (c: Caller): string | null => {
    if (c.actor.kind === "user") return c.actor.id;
    const running = hub.currentRun(c.actor.id);
    if (running) return running.requestedBy;
    return c.principal.kind === "node" ? (store.node(c.principal.subjectId)?.ownerId ?? null) : c.principal.createdBy;
  };
  /** A computer this person may give an agent: someone else's own screen isn't one. */
  const canAssignComputer = (c: Caller, computerId: string) => {
    const comp = store.computer(computerId);
    return !!comp && comp.workspaceId === c.workspaceId && hub.computers.canSee(comp, c.actor.id);
  };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof VaultError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  // --- setup & auth -----------------------------------------------------------

  app.get("/api/setup", async () => ({ needsSetup: store.userCount() === 0 }));

  app.post("/api/setup", async (req, reply) => {
    if (store.userCount() > 0) return reply.code(409).send({ error: "already set up" });
    const body = parse(
      z.object({ email: z.string().email(), name: z.string().min(1), password: z.string().min(8), workspaceName: z.string().min(1).default("Warren"), features: FEATURE_PRESET.default("simple") }),
      req.body,
      reply,
    );
    if (!body) return;
    const user = store.createUser(body.email, body.name, hashPassword(body.password));
    // the first organization keeps the vault the hub opened at startup
    const ws = await createOrganization(hub, user, body.workspaceName, body.features);
    return { token: issueToken(db, "session", user.id, ws.id, deviceLabel(req.headers["user-agent"])), user, workspace: ws };
  });

  // Slow down password guessing: at most 10 failed logins per IP+email per 15 minutes.
  const failures = new Map<string, number[]>();
  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string(), password: z.string() }), req.body, reply);
    if (!body) return;
    const key = `${req.ip}|${body.email.toLowerCase()}`;
    const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
    if (recent.length >= 10) return reply.code(429).send({ error: "too many attempts, try again in a few minutes" });
    const u = store.userByEmail(body.email);
    if (!u || !verifyPassword(body.password, u.password_hash)) {
      failures.set(key, [...recent, Date.now()]);
      return reply.code(401).send({ error: "wrong email or password" });
    }
    failures.delete(key);
    // back into the organization they used last (their latest sign-in), else the first they joined
    const ws = (db
      .prepare(
        `SELECT t.workspace_id FROM tokens t JOIN memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.subject_id
         WHERE t.kind = 'session' AND t.subject_id = ? ORDER BY COALESCE(t.last_used, t.created_at) DESC LIMIT 1`,
      )
      .get(u.id) ??
      db.prepare("SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at LIMIT 1").get(u.id)) as { workspace_id: string } | undefined;
    if (!ws) return reply.code(403).send({ error: "not a member of any workspace" });
    return { token: issueToken(db, "session", u.id, ws.workspace_id, deviceLabel(req.headers["user-agent"])) };
  });

  app.post("/api/auth/logout", async (req) => {
    const t = bearer(req.headers.authorization);
    if (t) {
      revokeToken(db, t);
      hub.disconnectRevokedSessions();
    }
    return { ok: true };
  });

  /** First-run checklist, derived from real state so steps complete themselves. */
  app.get("/api/onboarding", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const nodes = store.nodes(c.workspaceId);
    const agents = store.agents(c.workspaceId);
    const firstReply = db
      .prepare(
        `SELECT m.id, m.channel_id AS channelId, m.author_id AS agentId FROM messages m JOIN channels ch ON ch.id = m.channel_id
         WHERE ch.workspace_id = ? AND m.author_kind = 'agent' AND m.body != '' ORDER BY m.created_at LIMIT 1`,
      )
      .get(c.workspaceId) as { id: string; channelId: string; agentId: string } | undefined;
    const canRead = readable(c);
    const agentNotes = vaultOf(c).list((p) => canRead(p) && agents.some((a) => p.startsWith(`agents/${a.id}/`))).filter((n) => !/\/(About|SOUL)\.md$/.test(n.path));
    const sharedNotes = vaultOf(c).list((p) => canRead(p) && p.startsWith("shared/")).filter((n) => n.path !== "shared/Welcome.md");
    return {
      devices: nodes.map((n) => ({ id: n.id, name: n.name, online: hub.isNodeOnline(n.id), mine: n.ownerId === c.actor.id, role: n.role })),
      // computers agents can share: VMs and cloud computers (never someone's own screen)
      computers: store
        .computers(c.workspaceId)
        .filter((x) => x.kind !== "device")
        .map((x) => ({ id: x.id, name: x.name, kind: x.kind, nodeId: x.nodeId, status: x.status })),
      agents: agents.map(agentView),
      firstReply: firstReply ?? null,
      memoryNotes: [...agentNotes, ...sharedNotes].slice(0, 5).map((n) => ({ path: n.path, title: n.title })),
      reachable: !!(await hub.reach.publicUrl().catch(() => null)),
    };
  });

  app.get("/api/me", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ws = store.workspace(c.workspaceId);
    const features = workspaceFeatures(store, c.workspaceId);
    if (c.actor.kind === "user") return { kind: "user", user: store.user(c.actor.id), prefs: store.prefs(c.actor.id), role: c.viewer.role, workspace: ws, features };
    return { kind: "agent", agent: agentView(store.agent(c.actor.id)!), workspace: ws, features };
  });

  app.get("/api/members", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return store.members(c.workspaceId);
  });

  app.post("/api/members", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const body = parse(z.object({ email: z.string().email(), name: z.string().min(1), password: z.string().min(8), role: z.enum(["member", "guest", "owner"]).default("member") }), req.body, reply);
    if (!body) return;
    if (store.userByEmail(body.email)) return reply.code(409).send({ error: "email already registered" });
    const u = store.createUser(body.email, body.name, hashPassword(body.password));
    store.addMember(c.workspaceId, u.id, body.role);
    const general = store.channelByName(c.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "user", id: u.id });
    return u;
  });

  // --- channels & messages ----------------------------------------------------

  /** Channels you can see, with membership, member counts and (for people) unread state. DMs only if you're in them. */
  app.get("/api/channels", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const list = store.channels(c.workspaceId).filter((ch) => channelVisible(c, ch.id) && (ch.kind === "channel" || store.isMember(ch.id, c.actor)));
    const ids = list.map((ch) => ch.id);
    const counts = store.memberCounts(ids);
    const reads = c.actor.kind === "user" ? store.readState(c.actor.id, ids) : {};
    const prefs = c.actor.kind === "user" ? store.channelPrefs(c.actor.id) : {};
    const pins = store.pinnedIds(ids);
    return list.map((ch) => ({
      ...ch,
      joined: store.isMember(ch.id, c.actor),
      memberCount: counts[ch.id] ?? 0,
      unread: reads[ch.id]?.unread ?? 0,
      lastReadAt: reads[ch.id]?.lastReadAt ?? null,
      notify: prefs[ch.id]?.notify ?? "default",
      starred: prefs[ch.id]?.starred ?? false,
      pinnedIds: pins[ch.id] ?? [],
    }));
  });

  /**
   * How agents behave in a channel. The default agent must be in the workspace; it's added to the
   * channel so it shows up among the members it answers for.
   */
  const CHANNEL_TEAM = z.object({
    nodes: z
      .array(z.object({ agentId: z.string().min(1), lead: z.boolean(), x: z.number().finite(), y: z.number().finite(), role: z.string().trim().max(60).optional(), roleNotes: z.string().max(4000).optional() }))
      .max(50),
    edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).max(200),
    folder: z
      .string()
      .max(200)
      .transform((f) => cleanRulePath(f.trim()))
      .refine((f) => !f.split("/").some((p) => p === ".." || p === "."), "that folder isn't inside memory")
      .optional(),
    repo: z.string().trim().max(500).nullable().optional(),
    baseBranch: z.string().trim().max(100).optional(),
    reportsTo: z.string().nullable().optional(),
  });
  const CHANNEL_SETTINGS = z.object({ defaultAgentId: z.string().nullable(), replyInThread: z.boolean(), instructions: z.string().max(4_000), team: CHANNEL_TEAM.nullable() }).partial();
  const ours = (c: Caller, agentId: string) => store.agent(agentId)?.workspaceId === c.workspaceId;
  /** What's wrong with the settings (an agent from elsewhere, a chart that doesn't work), or null. */
  const settingsProblem = (c: Caller, settings: z.infer<typeof CHANNEL_SETTINGS> | undefined): string | null => {
    if (settings?.defaultAgentId && !ours(c, settings.defaultAgentId)) return "agent not found";
    const team = settings?.team;
    if (!team) return null;
    if (team.nodes.some((n) => !ours(c, n.agentId)) || (team.reportsTo && !ours(c, team.reportsTo))) return "agent not found";
    return team.nodes.length || !(team.folder || team.repo) ? teamProblem(team) : null;
  };
  /** Everyone on a channel's team (and the agent that answers there) is in the channel. */
  const joinTeam = (channelId: string, settings: z.infer<typeof CHANNEL_SETTINGS> | undefined) => {
    for (const n of settings?.team?.nodes ?? []) store.addChannelMember(channelId, { kind: "agent", id: n.agentId });
    if (settings?.defaultAgentId) store.addChannelMember(channelId, { kind: "agent", id: settings.defaultAgentId });
  };
  /**
   * A chart sent without the team's roles, memory folder, repo or boss (say, from an app that
   * only draws the chart) keeps the ones it had.
   */
  const keepTeamExtras = (next: z.infer<typeof CHANNEL_TEAM>, cur: ChannelTeam | null): z.infer<typeof CHANNEL_TEAM> => {
    if (!cur) return next;
    const old = new Map(cur.nodes.map((n) => [n.agentId, n]));
    return {
      ...next,
      nodes: next.nodes.map((n) => ({ ...n, role: n.role ?? old.get(n.agentId)?.role, roleNotes: n.roleNotes ?? old.get(n.agentId)?.roleNotes })),
      folder: next.folder ?? cur.folder,
      repo: next.repo !== undefined ? next.repo : cur.repo,
      baseBranch: next.baseBranch ?? cur.baseBranch,
      reportsTo: next.reportsTo !== undefined ? next.reportsTo : cur.reportsTo,
    };
  };
  /** Channels that can't be archived, made private or deleted: where everyone lands. */
  const protectedReason = (_c: Caller, ch: { id: string; name: string }, what: string) => (ch.name === "general" ? `#general can't be ${what}: everyone in the workspace lands there` : null);
  /** A team that just got a memory folder gets a starter brief there. */
  const briefFor = async (c: Caller, channelName: string, folder: string | undefined) => {
    if (!folder) return;
    const vault = vaultOf(c);
    const brief = `${folder}/README.md`;
    if (vault.list((p) => p.toLowerCase() === brief.toLowerCase()).length) return;
    await vault.write(brief, `# Team #${channelName}\n\nWhat this team is for, what it's working on, and how it works. The lead keeps this up to date.\n`, commitAuthor(c), `Brief for #${channelName}`).catch(() => undefined);
  };

  app.patch("/api/channels/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
    const body = parse(z.object({ name: CHANNEL_NAME, topic: z.string().max(250), sectionId: z.string().nullable(), private: z.boolean(), settings: CHANNEL_SETTINGS }).partial(), req.body, reply);
    if (!body) return;
    if (body.sectionId && store.section(body.sectionId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown section" });
    if (body.name && body.name !== ch.name && store.channelByName(c.workspaceId, body.name)) return reply.code(409).send({ error: "channel exists" });
    if (body.name && body.name !== ch.name && ch.name === "general") return reply.code(409).send({ error: "#general can't be renamed: everyone in the workspace lands there" });
    if (body.settings?.team) body.settings.team = keepTeamExtras(body.settings.team, ch.settings.team);
    const problem = settingsProblem(c, body.settings);
    if (problem) return reply.code(400).send({ error: problem });
    if (body.private && !ch.private) {
      const why = protectedReason(c, ch, "made private");
      if (why) return reply.code(409).send({ error: why });
      // making it private keeps you in it, so you don't lock yourself out
      if (c.actor.kind === "user") store.addChannelMember(ch.id, c.actor);
    }
    joinTeam(ch.id, body.settings);
    const updated = store.updateChannel(ch.id, body);
    if (body.settings?.team?.folder !== ch.settings.team?.folder) await briefFor(c, updated!.name, body.settings?.team?.folder);
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return updated;
  });

  /** Who's in a channel: people (with their workspace role) and agents, people first, by name. */
  type ChannelMember = { kind: "user" | "agent"; id: string; name: string; handle: string | null; role: string | null };
  const channelMemberList = (workspaceId: string, channelId: string) => {
    const people = new Map(store.members(workspaceId).map((m) => [m.id, m]));
    return store
      .channelMembers(channelId)
      .flatMap((m): ChannelMember[] => {
        if (m.kind === "user") {
          const p = people.get(m.id);
          return p ? [{ kind: "user" as const, id: p.id, name: p.preferredName || p.name, handle: null, role: p.role }] : [];
        }
        const a = store.agent(m.id);
        return a && a.workspaceId === workspaceId ? [{ kind: "agent" as const, id: a.id, name: a.name, handle: a.handle, role: null }] : [];
      })
      .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "user" ? -1 : 1));
  };

  app.get("/api/channels/:id/members", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    return channelMemberList(c.workspaceId, ch.id);
  });

  /** Add or remove a person or agent. People in the workspace (not guests) manage who's in a channel. */
  const MEMBER_PARAMS = z.object({ id: z.string(), kind: z.enum(["user", "agent"]), memberId: z.string().min(1) });
  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/channels/:id/members/:kind/:memberId",
      handler: async (req, reply) => {
        const c = need(req, reply, { member: true });
        if (!c) return;
        const p = parse(MEMBER_PARAMS, req.params, reply);
        if (!p) return;
        const ch = channelVisible(c, p.id);
        if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
        const exists = p.kind === "user" ? !!store.role(c.workspaceId, p.memberId) : store.agent(p.memberId)?.workspaceId === c.workspaceId;
        if (!exists) return reply.code(404).send({ error: p.kind === "user" ? "no such person in this workspace" : "agent not found" });
        const member: Actor = { kind: p.kind, id: p.memberId };
        if (method === "PUT") store.addChannelMember(ch.id, member);
        else {
          store.removeChannelMember(ch.id, member);
          // an agent that's no longer here stops answering here
          if (member.kind === "agent") store.clearDefaultAgent(member.id, ch.id);
        }
        hub.broadcast(c.workspaceId, { type: "channels_changed" });
        return channelMemberList(c.workspaceId, ch.id);
      },
    });
  }

  /** Delete a channel and everything said in it (and its team). Not DMs or #general. */
  app.delete("/api/channels/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
    const why = protectedReason(c, ch, "deleted");
    if (why) return reply.code(409).send({ error: why });
    // stop what's going on in it first, so nothing finishes into a channel that's gone
    for (const d of store.discussions(c.workspaceId, { channelId: ch.id })) if (d.status !== "done" && d.status !== "cancelled") store.updateDiscussion(d.id, { status: "cancelled" });
    for (const r of db.prepare("SELECT id FROM runs WHERE channel_id = ? AND status IN ('queued', 'running')").all(ch.id) as { id: string }[]) hub.cancelRun(r.id);
    store.deleteChannel(ch.id);
    // rules about its team go with it
    store.removeRulesFor(c.workspaceId, { kind: "team", name: ch.name });
    for (const role of new Set((ch.settings.team?.nodes ?? []).map((n) => n.role?.trim()).filter((r): r is string => !!r))) store.removeRulesFor(c.workspaceId, { kind: "role", team: ch.name, role });
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return { ok: true };
  });

  app.post("/api/channels/:id/join", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
    store.addChannelMember(ch.id, c.actor);
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return { ok: true };
  });

  app.post("/api/channels/:id/leave", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
    store.removeChannelMember(ch.id, c.actor);
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return { ok: true };
  });

  /** Archive a channel (read-only, out of everyone's sidebar, still searchable) or bring it back. */
  app.post("/api/channels/:id/archive", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch || ch.kind !== "channel") return reply.code(404).send({ error: "channel not found" });
    const body = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {}, reply);
    if (!body) return;
    if (body.archived) {
      const why = protectedReason(c, ch, "archived");
      if (why) return reply.code(409).send({ error: why });
      // nothing keeps working into a channel nobody's looking at
      for (const d of store.discussions(c.workspaceId, { channelId: ch.id })) if (d.status !== "done" && d.status !== "cancelled") store.updateDiscussion(d.id, { status: "cancelled" });
      for (const r of db.prepare("SELECT id FROM runs WHERE channel_id = ? AND status IN ('queued', 'running')").all(ch.id) as { id: string }[]) hub.cancelRun(r.id);
    }
    const updated = store.updateChannel(ch.id, { archivedAt: body.archived ? (ch.archivedAt ?? new Date().toISOString()) : null });
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return updated;
  });

  /** Your own settings for a channel: how much it notifies you, and whether it's starred. */
  app.put("/api/channels/:id/prefs", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    const body = parse(z.object({ notify: z.enum(["all", "default", "mute"]), starred: z.boolean() }).partial(), req.body, reply);
    if (!body) return;
    store.setChannelPrefs(c.actor.id, ch.id, body);
    return { ok: true, ...store.channelPrefs(c.actor.id)[ch.id] };
  });

  /** Pinned messages: the few things everyone in a channel should be able to find again. */
  app.get("/api/channels/:id/pins", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    return store.pins(ch.id).map((p) => ({ ...p, message: store.withReactions([p.message])[0] }));
  });

  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/messages/:id/pin",
      handler: async (req, reply) => {
        const c = need(req, reply);
        if (!c) return;
        const msg = store.message((req.params as { id: string }).id);
        const ch = msg && channelVisible(c, msg.channelId);
        if (!msg || !ch) return reply.code(404).send({ error: "message not found" });
        if (c.viewer.role === "guest") return reply.code(403).send({ error: "guests can't pin messages" });
        if (ch.archivedAt) return reply.code(409).send({ error: `#${ch.name} is archived` });
        if (method === "PUT") {
          if ((store.pinnedIds([ch.id])[ch.id]?.length ?? 0) >= 100) return reply.code(409).send({ error: "a channel can have 100 pins; unpin one first" });
          store.pin(ch.id, msg.id, c.actor);
        } else store.unpin(ch.id, msg.id);
        hub.broadcast(c.workspaceId, { type: "channels_changed" });
        return { ok: true, pinned: method === "PUT" };
      },
    });
  }

  /** Remember how far you've read, so unread counts and the "new" divider follow you across devices. */
  app.post("/api/channels/:id/read", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    const body = parse(z.object({ at: z.string().datetime().optional() }), req.body ?? {}, reply);
    if (!body) return;
    store.markRead(c.actor.id, ch.id, body.at);
    return { ok: true };
  });

  // --- sections ---------------------------------------------------------------

  app.get("/api/sections", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    return store.sections(c.workspaceId);
  });

  app.post("/api/sections", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), emoji: EMOJI.or(z.literal("")).default("") }), req.body, reply);
    if (!body) return;
    const sec = store.createSection(c.workspaceId, body.name, body.emoji);
    hub.broadcast(c.workspaceId, { type: "sections_changed" });
    return sec;
  });

  app.patch("/api/sections/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const sec = store.section((req.params as { id: string }).id);
    if (!sec || sec.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "section not found" });
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), emoji: EMOJI.or(z.literal("")), position: z.number().int().min(0).max(10_000) }).partial(), req.body, reply);
    if (!body) return;
    const updated = store.updateSection(sec.id, body);
    hub.broadcast(c.workspaceId, { type: "sections_changed" });
    return updated;
  });

  app.delete("/api/sections/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const sec = store.section((req.params as { id: string }).id);
    if (!sec || sec.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "section not found" });
    store.deleteSection(sec.id);
    hub.broadcast(c.workspaceId, { type: "sections_changed" });
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return { ok: true };
  });

  // --- reactions & search -----------------------------------------------------

  app.post("/api/messages/:id/reactions", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const msg = store.message((req.params as { id: string }).id);
    if (!msg || !channelVisible(c, msg.channelId)) return reply.code(404).send({ error: "message not found" });
    const body = parse(z.object({ emoji: EMOJI, on: z.boolean().optional() }), req.body, reply);
    if (!body) return;
    return { added: hub.react(msg.id, c.actor, body.emoji, body.on), reactions: store.reactions([msg.id])[msg.id] ?? [] };
  });

  /** Fix your own message. Agents that were asked aren't asked again. */
  app.patch("/api/messages/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const msg = store.message((req.params as { id: string }).id);
    const ch = msg && channelVisible(c, msg.channelId);
    if (!msg || !ch || msg.deletedAt) return reply.code(404).send({ error: "message not found" });
    if (msg.author.kind !== c.actor.kind || msg.author.id !== c.actor.id) return reply.code(403).send({ error: "you can only edit your own messages" });
    if (ch.archivedAt) return reply.code(409).send({ error: `#${ch.name} is archived` });
    const body = parse(z.object({ body: z.string().max(40_000) }), req.body, reply);
    if (!body) return;
    // a message with files can lose its text; one without has to keep some
    if (!body.body.trim() && !msg.parts.some((p) => p.type === "file")) return reply.code(400).send({ error: "empty message; delete it instead" });
    return hub.editMessage(msg, body.body);
  });

  /** Delete your own message, or anyone's as a workspace owner. A thread root with replies stays as "deleted" so the replies can still be read. */
  app.delete("/api/messages/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const msg = store.message((req.params as { id: string }).id);
    const ch = msg && channelVisible(c, msg.channelId);
    if (!msg || !ch || msg.deletedAt) return reply.code(404).send({ error: "message not found" });
    const mine = msg.author.kind === c.actor.kind && msg.author.id === c.actor.id;
    if (!mine && !(c.actor.kind === "user" && c.viewer.role === "owner")) return reply.code(403).send({ error: "you can only delete your own messages" });
    if (ch.archivedAt) return reply.code(409).send({ error: `#${ch.name} is archived` });
    return { ok: true, ...hub.removeMessage(msg) };
  });

  /** One search box for everything you can see: channels, agents, messages and memory. */
  app.get("/api/search", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = String((req.query as { q?: string }).q ?? "").trim().slice(0, 200);
    if (!q) return { channels: [], agents: [], messages: [], notes: [] };
    const lower = q.toLowerCase().replace(/^[#@]/, "");
    const visible = store.channels(c.workspaceId).filter((ch) => channelVisible(c, ch.id) && (ch.kind === "channel" || store.isMember(ch.id, c.actor)));
    const channels = visible.filter((ch) => ch.kind === "channel" && (ch.name.includes(lower) || ch.topic.toLowerCase().includes(lower))).slice(0, 8);
    const agents = store
      .agents(c.workspaceId)
      .filter((a) => a.handle.includes(lower) || a.name.toLowerCase().includes(lower))
      .slice(0, 8)
      .map(agentView);
    const messages = store.searchMessages(visible.map((ch) => ch.id), q, 15).map((m) => ({ ...m, channelName: visible.find((ch) => ch.id === m.channelId)?.name ?? "" }));
    const notes = vaultOf(c).search(q, readable(c), 8);
    return { channels, agents, messages, notes };
  });

  app.get("/api/agents/:id/runs", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const limit = limitParam((req.query as { limit?: string }).limit, 20, 100);
    // runs in a DM the caller isn't part of show as runs, but not where or what was said
    return store.agentRuns(agent.id, limit).map((r) => {
      const hidden = !channelVisible(c, r.channelId);
      return {
        ...r,
        channelName: hidden ? null : r.channelName,
        // a background check has no message behind it, so it's named for what it is
        trigger: r.kind === "background" ? `Background check · ${agent.name}` : hidden ? null : (r.trigger?.slice(0, 280) ?? null),
        // a failure in plain words when it's a known one (the harness needs signing in on its device)
        hint: r.status === "failed" && r.error ? (hub.explainFailure(agent, r.error) !== r.error ? hub.explainFailure(agent, r.error) : null) : null,
      };
    });
  });

  app.post("/api/channels", async (req, reply) => {
    const c = need(req, reply, { notGuest: true });
    if (!c) return;
    const body = parse(
      z.object({
        name: CHANNEL_NAME,
        topic: z.string().max(250).default(""),
        sectionId: z.string().nullable().optional(),
        private: z.boolean().default(false),
        settings: CHANNEL_SETTINGS.optional(),
        /** people and agents to add straight away */
        members: z.array(z.object({ kind: z.enum(["user", "agent"]), id: z.string().min(1) })).max(200).default([]),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    if (store.channelByName(c.workspaceId, body.name)) return reply.code(409).send({ error: "channel exists" });
    if (body.sectionId && store.section(body.sectionId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown section" });
    const problem = settingsProblem(c, body.settings);
    if (problem) return reply.code(400).send({ error: problem });
    const members = body.members.filter((m) => (m.kind === "user" ? !!store.role(c.workspaceId, m.id) : store.agent(m.id)?.workspaceId === c.workspaceId));
    if (members.length !== body.members.length) return reply.code(400).send({ error: "someone to add isn't in this workspace" });
    const created = store.createChannel(c.workspaceId, body.name, "channel", body.topic);
    const ch = store.updateChannel(created.id, { sectionId: body.sectionId ?? null, private: body.private, settings: body.settings ?? {} })!;
    store.addChannelMember(ch.id, c.actor);
    for (const m of members) store.addChannelMember(ch.id, m as Actor);
    joinTeam(ch.id, ch.settings);
    await briefFor(c, ch.name, ch.settings.team?.folder);
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
    return ch;
  });

  app.post("/api/dm/:agentId", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { agentId: string }).agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    return store.dmChannel(c.workspaceId, c.actor.id, agent.id);
  });

  app.get("/api/channels/:id/messages", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    const q = req.query as { thread?: string; before?: string; limit?: string };
    const messages = store.withReactions(store.messages(ch.id, { threadId: q.thread, before: q.before, limit: limitParam(q.limit, 50, 200) }));
    // replies in a thread can have sub-threads of their own
    return { messages, replyCounts: store.replyCounts(messages.filter((m) => m.id !== q.thread).map((m) => m.id)) };
  });

  app.post("/api/channels/:id/messages", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const ch = channelVisible(c, (req.params as { id: string }).id);
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    if (ch.archivedAt) return reply.code(409).send({ error: `#${ch.name} is archived; unarchive it to post here` });
    const body = parse(z.object({ body: z.string().max(40_000), voice: z.boolean().optional(), threadId: z.string().nullable().optional(), fileIds: z.array(z.string()).max(20).default([]) }), req.body, reply);
    if (!body) return;
    const files = body.fileIds.map((fid) => store.file(fid)).filter((f) => f && f.workspaceId === c.workspaceId);
    if (!body.body.trim() && !files.length) return reply.code(400).send({ error: "empty message" });
    // any message can start a thread, a reply in a thread too (a sub-thread)
    const threadId = body.threadId ?? null;
    if (threadId) {
      const root = store.message(threadId);
      if (!root || root.channelId !== ch.id) return reply.code(400).send({ error: "thread not in channel" });
    }
    // An agent posting mid-run continues that run's hop count so loops stay bounded.
    let hop = 0;
    if (c.actor.kind === "agent") {
      const running = db.prepare("SELECT hop FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(c.actor.id) as { hop: number } | undefined;
      hop = (running?.hop ?? 0) + 1;
    }
    store.addChannelMember(ch.id, c.actor);
    return hub.postMessage({ channelId: ch.id, threadId, author: c.actor, body: body.body, parts: [...files.map((f) => ({ type: "file" as const, fileId: f!.id, name: f!.name })), ...(body.voice ? [{ type: "status" as const, text: "Voice message" }] : [])], hop, onBehalfOf: requesterOf(c) });
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const run = store.run((req.params as { id: string }).id);
    if (!run || store.agent(run.agentId)?.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "run not found" });
    return { ok: hub.cancelRun(run.id) };
  });

  // --- agents & nodes ---------------------------------------------------------

  app.get("/api/agents", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    return store.agents(c.workspaceId).map(agentView);
  });

  /**
   * An agent makes an agent: a lead creating someone its team needs, or an agent a lead made
   * making a sub-agent (Settings → Agents switches both on; spawnRight says who may). The new agent
   * uses the organization's defaults, answers the person its maker works for, and joins the chart
   * of the channel its maker is working in, under its maker.
   */
  app.post("/api/agents/spawn", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only; people use New agent" });
    const maker = store.agent(c.actor.id);
    if (!maker) return reply.code(404).send({ error: "agent not found" });
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), handle: HANDLE.optional(), role: z.string().max(60).default(""), instructions: z.string().max(20_000).default("") }), req.body, reply);
    if (!body) return;
    const right = spawnRight(hub, maker);
    if (!("kind" in right)) return reply.code(403).send({ error: right.why });
    let handle = body.handle ?? (body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "agent");
    if (!/^[a-z]/.test(handle)) handle = `a-${handle}`.slice(0, 32);
    for (let n = 2; store.agentByHandle(c.workspaceId, handle); n++) handle = `${handle.replace(/-\d+$/, "")}-${n}`;
    const defaults = agentDefaults(store, c.workspaceId);
    const harness = defaults.harness ?? maker.harness;
    // a person's device only when it's shared, or theirs and this is their work; else where its maker runs
    const requester = requesterOf(c) ?? maker.settings.createdBy ?? null;
    const node = defaults.nodeId ? store.node(defaults.nodeId) : undefined;
    const nodeId = node && (node.shared || !node.ownerId || node.ownerId === requester) ? node.id : maker.nodeId;
    const policy = agentPolicy(hub, c.workspaceId);
    let settings: Record<string, unknown> = {
      respondTo: "me",
      access: policy.defaultAccess,
      ...(requester ? { createdBy: requester } : {}),
      parentAgentId: maker.id,
      madeDepth: right.depth,
      ...(body.role.trim() ? { role: body.role.trim() } : {}),
    };
    let computerId: string | null = null;
    const caps = nodeId ? store.nodeCapabilities(nodeId) : null;
    if (defaults.computer === "own-vm" && nodeId && caps?.vm.ok) {
      const size = VM_SIZES[computerDefaults(hub, c.workspaceId).vmSize];
      const comp = store.createComputer({ workspaceId: c.workspaceId, name: `${body.name}'s computer`.slice(0, 80), kind: "vm", nodeId, config: { cpus: size.cpus, memoryGb: size.memoryGb }, status: "starting" });
      hub.computers.startInBackground(comp);
      computerId = comp.id;
      settings = { runIn: "computer", ...settings };
    } else if (defaults.computer === "none") settings = { headless: true, ...settings };
    const created = store.createAgent({ workspaceId: c.workspaceId, handle, name: body.name, harness, model: harness === defaults.harness ? defaults.model : maker.model, nodeId: nodeId ?? null, computerId, instructions: body.instructions });
    const agent = store.updateAgent(created.id, { settings: settings as never })!;
    const general = store.channelByName(c.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "agent", id: agent.id });
    await vaultOf(c).write(soulPath(agent.id), soulTemplate(agent.name, agent.handle), commitAuthor(c), `Create soul for @${agent.handle}`);
    // it joins the chart of the channel its maker is working in, under its maker
    const run = hub.currentRun(maker.id);
    const ch = run ? store.channel(run.channelId) : undefined;
    const team = ch?.settings.team;
    const above = team?.nodes.find((n) => n.agentId === maker.id);
    if (ch && team && above) {
      // the first free spot on the row under its maker, so it doesn't land on another card
      const y = above.y + 132;
      let x = above.x;
      while (team.nodes.some((n) => Math.abs(n.y - y) < 64 && Math.abs(n.x - x) < 196)) x += 212;
      store.updateChannel(ch.id, { settings: { team: { nodes: [...team.nodes, { agentId: agent.id, lead: false, x, y }], edges: [...team.edges, { from: maker.id, to: agent.id }] } } });
      store.addChannelMember(ch.id, { kind: "agent", id: agent.id });
      hub.broadcast(c.workspaceId, { type: "channels_changed" });
    }
    if (run && ch) hub.postMessage({ channelId: ch.id, threadId: run.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "notice", text: `@${maker.handle} made ${right.kind === "agent" ? "a new agent" : "a sub-agent"}: @${agent.handle}${body.role.trim() ? ` (${body.role.trim()})` : ""}` }], route: false });
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return agentView(agent);
  });

  app.post("/api/agents", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(
      z.object({
        handle: HANDLE,
        name: z.string().min(1).max(80),
        /** optional with useDefaults: the organization's defaults fill it in */
        harness: HARNESS.optional(),
        model: z.string().max(MAX_MODEL_ID_LENGTH).nullable().optional(),
        nodeId: z.string().nullable().optional(),
        computerId: z.string().nullable().optional(),
        instructions: z.string().max(20_000).default(""),
        settings: SETTINGS.optional(),
        soul: z.string().max(50_000).optional(),
        /** fill in harness, model, device and computer from Settings' defaults where they aren't given */
        useDefaults: z.boolean().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const { useDefaults, ...fields } = body;
    const defaults = useDefaults ? agentDefaults(store, c.workspaceId) : null;
    if (defaults) {
      fields.harness ??= defaults.harness ?? undefined;
      if (fields.model === undefined && fields.harness === defaults.harness) fields.model = defaults.model;
      if (fields.nodeId === undefined && defaults.nodeId && canUseDevice(c, defaults.nodeId)) fields.nodeId = defaults.nodeId;
    }
    const harness = fields.harness;
    if (!harness) return reply.code(400).send({ error: "harness: pick a harness (no device offers one yet to use as a default)" });
    if (store.agentByHandle(c.workspaceId, body.handle)) return reply.code(409).send({ error: "handle taken" });
    if (body.settings?.respondPeople?.some((p) => !store.role(c.workspaceId, p))) return reply.code(400).send({ error: "respondPeople: someone isn't in this organization" });
    if (body.nodeId && store.node(body.nodeId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown node" });
    if (body.nodeId && !canUseDevice(c, body.nodeId)) return reply.code(403).send({ error: "that's someone else's device; they can let others add agents there under Devices" });
    if (body.computerId && !canAssignComputer(c, body.computerId)) return reply.code(400).send({ error: "unknown computer" });
    if (body.settings?.anyoneCanAsk && (!body.nodeId || store.node(body.nodeId)?.ownerId !== c.actor.id)) delete body.settings.anyoneCanAsk;
    // new agents start at the workspace's default access unless someone picked one
    if (!body.settings?.access) body.settings = { ...body.settings, access: agentPolicy(hub, c.workspaceId).defaultAccess };
    // it remembers who made it, and answers only them until they say otherwise
    body.settings = { respondTo: "me", ...body.settings, createdBy: c.actor.id };
    // "Use my defaults" with a VM: the agent gets a computer of its own on its device
    let computerId = fields.computerId;
    if (defaults && computerId === undefined) {
      const caps = fields.nodeId ? store.nodeCapabilities(fields.nodeId) : null;
      if (defaults.computer === "own-vm" && fields.nodeId && caps?.vm.ok) {
        const size = VM_SIZES[computerDefaults(hub, c.workspaceId).vmSize];
        const comp = store.createComputer({ workspaceId: c.workspaceId, name: `${body.name}'s computer`.slice(0, 80), kind: "vm", nodeId: fields.nodeId, config: { cpus: size.cpus, memoryGb: size.memoryGb }, status: "starting" });
        hub.computers.startInBackground(comp);
        computerId = comp.id;
        body.settings = { runIn: "computer", ...body.settings };
      } else if (defaults.computer === "none") body.settings = { headless: true, ...body.settings };
    }
    const created = store.createAgent({ ...fields, harness, computerId, workspaceId: c.workspaceId });
    const agent = store.updateAgent(created.id, { settings: body.settings })!;
    const general = store.channelByName(c.workspaceId, "general");
    if (general) store.addChannelMember(general.id, { kind: "agent", id: agent.id });
    await vaultOf(c).write(soulPath(agent.id), body.soul ?? soulTemplate(agent.name, agent.handle), commitAuthor(c), `Create soul for @${agent.handle}`);
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return agentView(agent);
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const body = parse(
      z
        .object({ name: z.string().min(1).max(80), harness: HARNESS, model: z.string().max(MAX_MODEL_ID_LENGTH).nullable(), nodeId: z.string().nullable(), computerId: z.string().nullable(), instructions: z.string().max(20_000), settings: SETTINGS })
        .partial(),
      req.body,
      reply,
    );
    if (!body) return;
    // who made it is the hub's record, not a setting
    if (body.settings) delete body.settings.createdBy;
    // who an agent answers is up to whoever made it (and the organization's owners)
    if (body.settings && (body.settings.respondTo !== undefined || body.settings.respondPeople !== undefined)) {
      const creator = agent.settings.createdBy;
      if (creator && creator !== c.actor.id && c.viewer.role !== "owner") return reply.code(403).send({ error: `only whoever made @${agent.handle} (or an owner) decides who it answers` });
      if (body.settings.respondPeople?.some((p) => !store.role(c.workspaceId, p))) return reply.code(400).send({ error: "respondPeople: someone isn't in this organization" });
    }
    // whoever's device the agent runs directly on (now, or after this change) decides about it
    const after = { ...agent, ...body, settings: { ...agent.settings, ...body.settings } };
    for (const owner of [deviceOwnerOf(agent), deviceOwnerOf(after)]) {
      if (!owner || owner === c.actor.id) continue;
      const name = store.user(owner)?.name ?? "its owner";
      return reply.code(403).send({ error: `@${agent.handle} ${owner === deviceOwnerOf(agent) ? "runs" : "would run"} directly on ${name}'s device, so only ${name} can ${owner === deviceOwnerOf(agent) ? "change it" : "make that change"}` });
    }
    if (body.nodeId && store.node(body.nodeId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "unknown node" });
    if (body.nodeId && body.nodeId !== agent.nodeId && !canUseDevice(c, body.nodeId)) return reply.code(403).send({ error: "that's someone else's device; they can let others add agents there under Devices" });
    if (body.computerId && body.computerId !== agent.computerId && !canAssignComputer(c, body.computerId)) return reply.code(400).send({ error: "unknown computer" });
    if (body.settings?.anyoneCanAsk !== undefined) {
      const target = store.node(body.nodeId ?? agent.nodeId ?? "");
      if (target?.ownerId !== c.actor.id) return reply.code(403).send({ error: "only the device's owner decides who can ask an agent that runs on it" });
    }
    // a harness token belongs to the device the agent ran on
    if (body.nodeId !== undefined && body.nodeId !== agent.nodeId) db.prepare("DELETE FROM tokens WHERE kind = 'agent' AND subject_id = ? AND label LIKE 'harness:%'").run(agent.id);
    // giving an agent a computer means it isn't headless anymore
    if (body.computerId) body.settings = { ...body.settings, headless: false };
    const updated = store.updateAgent(agent.id, body)!;
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return agentView(updated);
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    // an agent on someone's own device is theirs to remove, like it's theirs to change
    const owner = deviceOwnerOf(agent);
    if (owner && owner !== c.actor.id) {
      const name = store.user(owner)?.name ?? "its owner";
      return reply.code(403).send({ error: `@${agent.handle} runs directly on ${name}'s device, so only ${name} can remove it` });
    }
    for (const r of store.activeRuns(agent.id)) hub.cancelRun(r.id);
    // work it never finished fails; finished tasks stay, with nobody assigned
    for (const t of store.tasks(c.workspaceId).filter((t) => t.toAgentId === agent.id && (t.status === "open" || t.status === "in_progress"))) store.updateTask(t.id, "failed", `@${agent.handle} was removed before finishing this.`);
    revokeSubjectTokens(db, "agent", agent.id);
    store.removeRulesFor(c.workspaceId, { kind: "agent", id: agent.id });
    store.deleteAgent(agent.id);
    hub.broadcast(c.workspaceId, { type: "tasks_changed" });
    hub.broadcast(c.workspaceId, { type: "agents_changed" });
    return { ok: true };
  });

  /** A token for connecting an existing harness session directly (warren-mcp), without a node. */
  app.post("/api/agents/:id/token", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const deviceOwner = deviceOwnerOf(agent);
    if (deviceOwner && deviceOwner !== c.actor.id) return reply.code(403).send({ error: `@${agent.handle} runs directly on someone's device; only they can connect to it` });
    return { token: issueToken(db, "agent", agent.id, c.workspaceId, "mcp", c.actor.id) };
  });

  /** Models the agent's device offers for its harness, as reported by that device. */
  app.get("/api/agents/:id/models", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const node = agent.nodeId ? store.node(agent.nodeId) : undefined;
    return {
      device: node ? { id: node.id, name: node.name, online: hub.isNodeOnline(node.id) } : null,
      catalog: node ? (store.nodeCatalog(node.id).find((h) => h.harness === agent.harness) ?? null) : null,
    };
  });

  /** What can follow "/" for this agent in chat. */
  app.get("/api/agents/:id/commands", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    return { commands: hub.commands(agent) };
  });

  /**
   * What you're talking to: harness, model, effort, context window and permissions, combining
   * the agent's settings, its device's harness defaults, and what the last reply actually used.
   */
  app.get("/api/agents/:id/context", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const q = req.query as { channel?: string; thread?: string };
    const channel = q.channel ? channelVisible(c, q.channel) : undefined;
    const usage = channel ? store.latestUsage(agent.id, channel.id, q.thread || null) : null;
    const catalog = agent.nodeId ? store.nodeCatalog(agent.nodeId).find((h) => h.harness === agent.harness) : undefined;
    const model = agent.model ?? usage?.model ?? catalog?.defaultModel ?? null;
    const sameModel = !agent.model || !usage?.model || usage.model === agent.model;
    // the harness's configured effort wins over the model's own default, as in Codex
    const effort = agent.settings.effort ?? (sameModel ? usage?.effort : undefined) ?? catalog?.defaultEffort ?? catalog?.models.find((m) => m.id === model)?.defaultEffort ?? null;
    return {
      harness: agent.harness,
      harnessVersion: catalog?.version ?? null,
      model,
      modelIsDefault: !agent.model,
      effort,
      effortIsDefault: !agent.settings.effort,
      access: agent.settings.access ?? "edit",
      soulLocked: !!agent.settings.soulLocked,
      fast: !!agent.settings.fast,
      // whether the model in use offers a fast tier, and what it costs
      fastAvailable: !!catalog?.models.find((m) => m.id === model)?.fast,
      fastDescription: catalog?.models.find((m) => m.id === model)?.fast?.description ?? null,
      contextUsed: sameModel ? (usage?.contextUsed ?? null) : null,
      contextWindow: (sameModel ? usage?.contextWindow : undefined) ?? catalog?.models.find((m) => m.id === model)?.contextWindow ?? null,
      lastRunAt: usage?.at ?? null,
    };
  });

  app.get("/api/nodes", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    return store.nodes(c.workspaceId).map((n) => ({
      ...n,
      ownerName: n.ownerId ? (store.user(n.ownerId)?.name ?? null) : null,
      mine: n.ownerId === c.actor.id,
      online: hub.isNodeOnline(n.id),
      paused: hub.isNodePaused(n.id),
      agents: store.agentsOnNode(n.id).map((a) => a.handle),
      capabilities: store.nodeCapabilities(n.id),
      // what else lives on someone's device is theirs to see
      discovered: n.ownerId === c.actor.id || n.shared ? store.nodeDiscovered(n.id) : [],
      harnesses: store.nodeCatalog(n.id).map((h) => ({ id: h.harness, version: h.version })),
      version: hub.updates.deviceVersion(n.id),
      update: hub.updates.deviceUpdate(n.id),
    }));
  });

  app.post("/api/nodes", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const body = parse(z.object({ name: z.string().min(1).max(80) }), req.body, reply);
    if (!body) return;
    const node = store.createNode(c.workspaceId, body.name, c.actor.id);
    return { node, token: issueToken(db, "node", node.id, c.workspaceId, body.name) };
  });

  /**
   * A new connection code for a device that isn't connected, so it can still be connected after the
   * first code was lost (or a setup failed): the old code stops working.
   */
  app.post("/api/nodes/:id/token", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "node not found" });
    if (node.ownerId !== c.actor.id && c.viewer.role !== "owner") return reply.code(403).send({ error: "only the person who added this device, or a workspace owner, can connect it" });
    if (hub.isNodeOnline(node.id)) return reply.code(409).send({ error: `${node.name} is connected already` });
    revokeSubjectTokens(db, "node", node.id);
    return { token: issueToken(db, "node", node.id, c.workspaceId, node.name) };
  });

  /** The device's owner shares it (others can add agents and VMs there) or renames it. */
  app.patch("/api/nodes/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "node not found" });
    if (node.ownerId !== c.actor.id) return reply.code(403).send({ error: "only the person who connected this device can change it" });
    const body = parse(z.object({ shared: z.boolean(), role: z.enum(["vms", "screen", "headless"]).nullable() }).partial(), req.body, reply);
    if (!body) return;
    if (body.shared !== undefined) store.setNodeShared(node.id, body.shared);
    if (body.role !== undefined) store.setNodeRole(node.id, body.role);
    return { ...store.node(node.id), ok: true };
  });

  app.delete("/api/nodes/:id", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "node not found" });
    if (node.ownerId !== c.actor.id && c.viewer.role !== "owner") return reply.code(403).send({ error: "only the person who connected this device, or a workspace owner, can remove it" });
    revokeSubjectTokens(db, "node", node.id);
    db.prepare("DELETE FROM tokens WHERE kind = 'agent' AND label = ?").run(`harness:${node.id}`);
    for (const comp of store.computersOnNode(node.id)) await hub.computers.remove(comp);
    store.deleteNode(node.id);
    return { ok: true };
  });

  /**
   * A token for an agent's harness on this device, so the harness acts as that agent only (it never
   * gets the device's own token, which could act as every agent here).
   */
  app.post("/api/node/agents/:id/token", async (req, reply) => {
    const p = resolveToken(db, bearer(req.headers.authorization));
    if (!p || p.kind !== "node") return reply.code(401).send({ error: "node token required" });
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.nodeId !== p.subjectId) return reply.code(404).send({ error: "that agent isn't on this device" });
    return { token: issueToken(db, "agent", agent.id, agent.workspaceId, `harness:${p.subjectId}`) };
  });

  /** Node bootstrap: which agents does this node host? */
  app.get("/api/node/agents", async (req, reply) => {
    const p = resolveToken(db, bearer(req.headers.authorization));
    if (!p || p.kind !== "node") return reply.code(401).send({ error: "node token required" });
    return store.agentsOnNode(p.subjectId);
  });

  // --- teams: read-only, a channel's team is edited with the channel ---------

  /** Every channel's team, with `above`: who it reports to, nearest first. */
  app.get("/api/teams", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const teams = store.teams(c.workspaceId);
    return teams.filter((t) => channelVisible(c, t.channelId)).map((t) => ({ ...t, above: teamChain(t, teams) }));
  });

  // --- tasks ------------------------------------------------------------------

  app.get("/api/tasks", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { agent?: string; status?: string; team?: string };
    const all = store.tasks(c.workspaceId, { agentId: q.agent === "me" && c.actor.kind === "agent" ? c.actor.id : q.agent, status: q.status });
    // a person sees tasks in channels they can read: one in someone's DM or a private channel stays there
    const list = c.actor.kind === "user" ? all.filter((t) => !t.channelId || !!channelVisible(c, t.channelId)) : all;
    return q.team ? list.filter((t) => t.teamId === q.team) : list;
  });

  const isRemote = (repo: string) => /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(repo);
  const branchSlug = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 5)
      .join("-")
      .slice(0, 40) || "task";

  /**
   * Hand work to an agent: a task plus a message that wakes it up, in a thread everyone can follow.
   * When the agent's team codes in a repo, the task gets its own branch.
   */
  function delegate(o: {
    workspaceId: string;
    author: Actor;
    from: Actor;
    target: NonNullable<ReturnType<typeof store.agent>>;
    title: string;
    brief: string;
    channelId: string;
    fileIds?: string[];
    hop: number;
    team?: NonNullable<ReturnType<typeof store.team>> | null;
    branch?: string | null;
    reviewOf?: string | null;
    /** the task this is a piece of */
    parentId?: string | null;
    /** post the hand-off inside this thread, so the task's own thread is a sub-thread of it */
    threadId?: string | null;
    /** the person this work is for */
    onBehalfOf: string | null;
  }) {
    // team work is work handed out to someone on the chart of the channel it's in
    const here = o.team !== undefined ? o.team : store.team(o.channelId);
    const team = here?.members.some((m) => m.agentId === o.target.id) || o.team ? (here ?? null) : null;
    const task = store.createTask({ workspaceId: o.workspaceId, from: o.from, toAgentId: o.target.id, title: o.title, brief: o.brief, channelId: o.channelId, threadId: null, teamId: team?.id ?? null, reviewOf: o.reviewOf ?? null, parentId: o.parentId ?? null });
    let branch = o.branch ?? null;
    if (!branch && team?.repo && !o.reviewOf) branch = `warren/${o.target.handle}/${branchSlug(o.title)}-${task.id.slice(-5).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    if (branch) store.setTaskBranch(task.id, branch);
    const files = (o.fileIds ?? []).map((f) => store.file(f)).filter((f) => f && f.workspaceId === o.workspaceId);
    const msg = hub.postMessage({
      channelId: o.channelId,
      threadId: o.threadId ?? null,
      author: o.author,
      body: `@${o.target.handle} New task **${task.title}**\n\n${task.brief}`,
      parts: [{ type: "task" as const, taskId: task.id }, ...files.map((f) => ({ type: "file" as const, fileId: f!.id, name: f!.name }))],
      hop: o.hop,
      replyInThread: true,
      onBehalfOf: o.onBehalfOf,
    });
    db.prepare("UPDATE tasks SET thread_id = ? WHERE id = ?").run(msg.id, task.id);
    hub.broadcast(o.workspaceId, { type: "tasks_changed" });
    return store.task(task.id)!;
  }

  /** Delegate work to an agent. Posts a message so the agent wakes up and everyone can follow along. */
  app.post("/api/tasks", async (req, reply) => {
    const c = need(req, reply, { notGuest: true });
    if (!c) return;
    const body = parse(
      z.object({ to: z.string().default("auto"), title: z.string().min(1).max(200), brief: z.string().max(20_000), channelId: z.string().optional(), fileIds: z.array(z.string()).default([]), parentTaskId: z.string().optional() }),
      req.body,
      reply,
    );
    if (!body) return;
    // a piece of a bigger task: the one named, else the task the delegating agent is working on right now
    const running = c.actor.kind === "agent" ? hub.currentRun(c.actor.id) : undefined;
    let parent = body.parentTaskId ? store.task(body.parentTaskId) : undefined;
    if (body.parentTaskId && (!parent || parent.workspaceId !== c.workspaceId)) return reply.code(404).send({ error: "parent task not found" });
    if (!parent && running?.threadId) {
      const working = store.taskByThread(running.threadId);
      if (working && working.toAgentId === c.actor.id && (working.status === "open" || working.status === "in_progress")) parent = working;
    }
    // "auto": the workspace's lead, who splits it up; "team:<channel>" or "#channel": that channel team's lead
    const toTeam = body.to.startsWith("team:") ? body.to.slice(5) : body.to.startsWith("#") ? body.to : null;
    const teamTo = toTeam !== null ? store.teamByName(c.workspaceId, toTeam) : undefined;
    if (toTeam !== null && !teamTo?.leadId) return reply.code(404).send({ error: teamTo ? `#${teamTo.name} has no lead yet` : "no channel with a team called that" });
    const target = body.to === "auto" ? workspaceLead(store, c.workspaceId) : teamTo ? store.agent(teamTo.leadId!) : (store.agentByHandle(c.workspaceId, body.to.replace(/^@/, "")) ?? store.agent(body.to));
    if (!target || target.workspaceId !== c.workspaceId) return reply.code(404).send({ error: body.to === "auto" ? "add an agent first" : "agent not found" });
    if (body.to === "auto")
      body.brief =
        store.agents(c.workspaceId).length > 1
          ? `${body.brief}\n\n(You're the lead: plan this, break it into pieces and hand each to the agent whose role fits with task_delegate; they become subtasks of this task. Mark this task done when the pieces are in.)`
          : `${body.brief}\n\n(You're the only agent so far, so this one's yours to do.)`;
    const forTeam = teamTo;
    // an agent handing work to its own team (as lead, teammate or boss) does it in the team's channel
    const teams = store.teams(c.workspaceId);
    const shared =
      c.actor.kind === "agent"
        ? teams.find((t) => t.members.some((m) => m.agentId === target.id) && (t.members.some((m) => m.agentId === c.actor.id) || teamChain(t, teams).includes(c.actor.id)))
        : undefined;
    // an agent handing work to a teammate on the chart of the channel it's working in keeps it
    // there, as a sub-thread of the thread it's in
    const here = !body.channelId && running ? store.channel(running.channelId) : undefined;
    const onChart = here?.kind === "channel" && here.settings.team?.nodes.some((n) => n.agentId === target.id) && here.settings.team.nodes.some((n) => n.agentId === c.actor.id) ? here : undefined;
    // a person's task for a team goes to its channel; for one agent, to their DM with it
    const ch = body.channelId
      ? channelVisible(c, body.channelId)
      : onChart
        ? onChart
        : shared
        ? store.channel(shared.channelId)
        : forTeam
          ? store.channel(forTeam.channelId)
          : c.actor.kind === "user"
            ? store.dmChannel(c.workspaceId, c.actor.id, target.id)
            : store.channelByName(c.workspaceId, "general");
    if (!ch) return reply.code(404).send({ error: "channel not found" });
    const threadId = onChart && running?.threadId && store.message(running.threadId)?.channelId === ch.id ? running.threadId : null;
    return delegate({ workspaceId: c.workspaceId, author: c.actor, from: c.actor, target, title: body.title, brief: body.brief, channelId: ch.id, fileIds: body.fileIds, hop: running ? running.hop + 1 : 0, parentId: parent?.id ?? null, threadId, onBehalfOf: requesterOf(c) });
  });

  /**
   * When coding work is done, someone other than the builder gets a review task for the branch:
   * the team's reviewer, else a teammate on another harness, else the lead.
   */
  function requestReview(task: NonNullable<ReturnType<typeof store.task>>, onBehalfOf: string | null) {
    if (!task.branch || task.reviewOf || !task.teamId || !task.channelId || task.mergedAt) return;
    const team = store.team(task.teamId);
    if (!team?.repo) return;
    const builder = task.toAgentId ? store.agent(task.toAgentId) : undefined;
    if (!builder) return;
    const roles = new Map(team.members.map((m) => [m.agentId, m.role]));
    const candidates = (ids: (string | null | undefined)[]) =>
      [...new Set(ids.filter((id): id is string => !!id))]
        .map((id) => store.agent(id))
        .filter((a): a is NonNullable<typeof a> => !!a && a.workspaceId === task.workspaceId)
        .map((a) => ({ agentId: a.id, harness: a.harness, role: roles.get(a.id) ?? "", lead: team.leads.includes(a.id) }));
    // the workspace's lead only steps in when nobody on the team can
    const me = { agentId: builder.id, harness: builder.harness };
    const reviewerId = pickReviewer(me, candidates(team.members.map((m) => m.agentId))) ?? pickReviewer(me, candidates([workspaceLead(store, task.workspaceId)?.id]));
    const reviewer = reviewerId ? store.agent(reviewerId) : undefined;
    if (!reviewer) return;
    if (store.tasks(task.workspaceId).some((t) => t.reviewOf === task.id && (t.status === "open" || t.status === "in_progress"))) return;
    const author = task.toAgentId ? store.agent(task.toAgentId) : undefined;
    if (!author) return;
    delegate({
      workspaceId: task.workspaceId,
      author: { kind: "agent", id: author.id },
      from: task.from,
      target: reviewer,
      title: `Review: ${task.title}`,
      brief: `@${author.handle} finished **${task.title}** on branch \`${task.branch}\`.\n\nYour checkout is on that branch: read \`git diff ${team.baseBranch}...HEAD\` and run the tests.\n- If it's good, merge it with \`branch_merge\` (task \`${task.id}\`) and mark this review done.\n- If not, mark this review failed with what needs to change, and give @${author.handle} a follow-up task.`,
      channelId: task.channelId,
      hop: 1,
      team,
      branch: task.branch,
      reviewOf: task.id,
      onBehalfOf,
    });
  }

  app.patch("/api/tasks/:id", async (req, reply) => {
    const c = need(req, reply, { notGuest: true });
    if (!c) return;
    const task = store.task((req.params as { id: string }).id);
    if (!task || task.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "task not found" });
    if (c.actor.kind === "agent" && c.actor.id !== task.toAgentId && c.actor.id !== task.from.id) return reply.code(403).send({ error: "not your task" });
    const body = parse(z.object({ status: z.enum(["open", "in_progress", "done", "failed"]), result: z.string().max(40_000).optional() }), req.body, reply);
    if (!body) return;
    const updated = store.updateTask(task.id, body.status, body.result)!;
    hub.broadcast(c.workspaceId, { type: "tasks_changed" });
    if ((body.status === "done" || body.status === "failed") && task.channelId) {
      const requester = task.from.kind === "agent" ? `@${store.agent(task.from.id)?.handle} ` : "";
      // a subtask says how far along its parent is, so whoever planned it knows when to wrap up
      const parent = task.parentId ? store.task(task.parentId) : undefined;
      const siblings = parent ? store.subtasks(parent.id) : [];
      const progress = parent ? `\n\nPart of **${parent.title}** (\`${parent.id}\`): ${siblings.filter((t) => t.status === "done").length}/${siblings.length} subtasks done.` : "";
      // a hand-off in a sub-thread reports back in the thread it came from, where the lead and the person are
      const above = task.threadId ? (store.message(task.threadId)?.threadId ?? null) : null;
      // Mentioning the requesting agent hands the result back to it.
      hub.postMessage({
        channelId: task.channelId,
        threadId: above ?? task.threadId,
        author: c.actor,
        body: `${requester}Task **${task.title}** ${body.status === "done" ? "is done" : "failed"}.${body.result ? `\n\n${body.result}` : ""}${progress}`,
        ...(above ? { parts: [{ type: "task" as const, taskId: task.id }] } : {}),
        hop: 1,
        route: task.from.kind === "agent",
        onBehalfOf: requesterOf(c),
      });
    }
    if (body.status === "done") requestReview(updated, requesterOf(c));
    return updated;
  });

  /** Stop a task: cancels the assignee's queued or running work on it and marks it failed. Only this task, not its subtasks. */
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const c = need(req, reply, { notGuest: true });
    if (!c) return;
    const task = store.task((req.params as { id: string }).id);
    if (!task || task.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "task not found" });
    if (c.actor.kind === "agent" && c.actor.id !== task.from.id) return reply.code(403).send({ error: "not your task" });
    if (task.status === "done" || task.status === "failed") return reply.code(409).send({ error: "task already finished" });
    if (task.toAgentId && task.channelId && task.threadId) {
      const runs = db.prepare("SELECT id FROM runs WHERE agent_id = ? AND channel_id = ? AND thread_id = ? AND status IN ('queued', 'running')").all(task.toAgentId, task.channelId, task.threadId) as { id: string }[];
      for (const r of runs) hub.cancelRun(r.id);
    }
    const name = c.actor.kind === "agent" ? `@${store.agent(c.actor.id)?.handle ?? "agent"}` : (store.user(c.actor.id)?.name ?? "someone");
    const updated = store.updateTask(task.id, "failed", `Cancelled by ${name}.`)!;
    hub.broadcast(c.workspaceId, { type: "tasks_changed" });
    if (task.channelId) {
      hub.postMessage({ channelId: task.channelId, threadId: task.threadId, author: { kind: "user", id: "system" }, body: `Task **${task.title}** was cancelled by ${name}.`, hop: 1, route: false });
    }
    return updated;
  });

  /**
   * Merge a task's branch into the team's base branch, on a device that has the repo. People,
   * the team lead, whoever is reviewing it and whoever the team reports to can merge (never the one who built it). Works on a review task too.
   */
  app.post("/api/tasks/:id/merge", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    let task = store.task((req.params as { id: string }).id);
    if (!task || task.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "task not found" });
    if (task.reviewOf) task = store.task(task.reviewOf) ?? task;
    const team = task.teamId ? store.team(task.teamId) : undefined;
    if (!task.branch || !team?.repo) return reply.code(400).send({ error: "this task has no branch to merge" });
    if (task.mergedAt) return { ok: true, output: `${task.branch} is already merged`, task };
    if (c.actor.kind === "agent") {
      const me = c.actor.id;
      const role = team.members.find((m) => m.agentId === me)?.role ?? "";
      if (me === task.toAgentId) return reply.code(403).send({ error: "work gets merged by someone other than whoever built it" });
      const reviewing = store.tasks(c.workspaceId).some((t) => t.reviewOf === task!.id && t.toAgentId === me);
      if (!team.leads.includes(me) && !reviewing && !/review/i.test(role) && !teamChain(team, store.teams(c.workspaceId)).includes(me)) return reply.code(403).send({ error: "only the team lead, a reviewer, or whoever the team reports to can merge" });
    } else if (c.viewer.role === "guest") return reply.code(403).send({ error: "guests can't merge" });
    const via = c.actor.kind === "agent" ? c.actor.id : (task.toAgentId ?? team.leadId);
    if (!via) return reply.code(409).send({ error: "nobody's device has this repo anymore: the agent that did the work was removed" });
    const r = await hub.requestMerge(via, { repo: team.repo, branch: task.branch, base: team.baseBranch });
    if (!r.ok) return reply.code(409).send({ error: r.output });
    store.markTaskMerged(task.id);
    if (task.channelId) hub.postMessage({ channelId: task.channelId, threadId: task.threadId, author: c.actor, body: `Merged \`${task.branch}\` into \`${team.baseBranch}\`.`, parts: [{ type: "notice", text: r.output }], route: false });
    return { ok: true, output: r.output, task: store.task(task.id) };
  });

  // --- discussions --------------------------------------------------------------

  const discussionView = (d: NonNullable<ReturnType<typeof store.discussion>>) => ({
    ...d,
    progress: store.discussionRuns(d.id, d.round > d.rounds ? "summary" : `round:${d.round}`).map((r) => ({ agentId: r.agentId, status: r.status })),
  });

  /** Agents talk something through in rounds, then the moderator writes the decision and hands out tasks. */
  app.post("/api/discussions", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind === "user" && c.viewer.role === "guest") return reply.code(403).send({ error: "guests can't start discussions" });
    const body = parse(
      z.object({
        topic: z.string().trim().min(1).max(300),
        goal: z.string().max(4000).default(""),
        participants: z.array(z.string()).max(12).default([]),
        moderator: z.string().optional(),
        rounds: z.number().int().min(1).max(MAX_ROUNDS).default(2),
        team: z.string().optional(),
        channelId: z.string().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const agentRef = (r: string) => store.agentByHandle(c.workspaceId, r.replace(/^@/, "")) ?? (store.agent(r)?.workspaceId === c.workspaceId ? store.agent(r) : undefined);
    // a team is a channel's: by the channel's name ("web", "#web") or id
    const team = body.team ? (store.teamByName(c.workspaceId, body.team) ?? (store.team(body.team)?.workspaceId === c.workspaceId ? store.team(body.team) : undefined)) : undefined;
    if (body.team && (!team || !channelVisible(c, team.channelId))) return reply.code(404).send({ error: `no channel with a team called "${body.team}"` });
    const ids = body.participants.length ? body.participants.map(agentRef) : (team?.members.map((m) => store.agent(m.agentId)) ?? []);
    if (ids.some((a) => !a)) return reply.code(404).send({ error: "agent not found" });
    const participants = [...new Set(ids.map((a) => a!.id))];
    if (participants.length < 2) return reply.code(400).send({ error: "a discussion needs at least two agents" });
    const moderator = body.moderator ? agentRef(body.moderator) : store.agent(c.actor.kind === "agent" && participants.includes(c.actor.id) ? c.actor.id : (team?.leadId ?? participants[0]));
    if (!moderator) return reply.code(404).send({ error: "moderator not found" });
    const channel = body.channelId ? channelVisible(c, body.channelId) : team ? store.channel(team.channelId) : store.channelByName(c.workspaceId, "general");
    if (!channel) return reply.code(404).send({ error: "channel not found" });
    const requester = requesterOf(c);
    for (const a of [...participants, moderator.id]) {
      const agent = store.agent(a)!;
      if (!hub.answers(agent, requester)) return reply.code(403).send({ error: `@${agent.handle} only answers the people its owner picked` });
      const why = hub.whyNotAllowed(agent, requester);
      if (why) return reply.code(403).send({ error: why });
    }
    for (const a of [...participants, moderator.id]) store.addChannelMember(channel.id, { kind: "agent", id: a });
    const d = hub.discussions.start({ workspaceId: c.workspaceId, channelId: channel.id, topic: body.topic, goal: body.goal, participants, moderatorId: moderator.id, rounds: body.rounds, startedBy: c.actor, requestedBy: requester });
    return discussionView(d);
  });

  app.get("/api/discussions", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { channel?: string; status?: string };
    return store.discussions(c.workspaceId, { channelId: q.channel, status: q.status }).filter((d) => channelVisible(c, d.channelId)).map(discussionView);
  });

  app.get("/api/discussions/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const d = store.discussion((req.params as { id: string }).id);
    if (!d || d.workspaceId !== c.workspaceId || !channelVisible(c, d.channelId)) return reply.code(404).send({ error: "discussion not found" });
    return discussionView(d);
  });

  app.post("/api/discussions/:id/cancel", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const d = store.discussion((req.params as { id: string }).id);
    if (!d || d.workspaceId !== c.workspaceId || !channelVisible(c, d.channelId)) return reply.code(404).send({ error: "discussion not found" });
    if (c.viewer.role === "guest" || (c.actor.kind === "agent" && c.actor.id !== d.moderatorId && !(d.startedBy.kind === "agent" && d.startedBy.id === c.actor.id))) return reply.code(403).send({ error: "only people, the moderator or whoever started it can stop it" });
    if (d.status === "running" || d.status === "summarizing") hub.discussions.cancel(d);
    return discussionView(store.discussion(d.id)!);
  });

  // --- vault ------------------------------------------------------------------

  app.get("/api/vault/notes", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const as = (req.query as { as?: string }).as;
    const viewer = as ? viewAs(c, as, reply) : c.viewer;
    if (!viewer) return;
    const check = hub.access.checker(c.workspaceId, viewer);
    return vaultOf(c).list((p) => atLeast(check(p).level, "read"));
  });

  app.get("/api/vault/note", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const p = noteFor(c, (req.query as { path?: string }).path ?? "", "read", reply);
    if (!p) return;
    const [note, [last]] = await Promise.all([vaultOf(c).read(p), vaultOf(c).history(p, 1).catch(() => [])]);
    return { ...note, access: memory(c)(p).level, backlinks: vaultOf(c).backlinks(note.path, readable(c)), editedBy: last?.author ?? null, editedAt: last?.date ?? null };
  });

  app.put("/api/vault/note", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(z.object({ path: z.string().min(1), content: z.string().max(2_000_000), message: z.string().max(200).optional() }), req.body, reply);
    const p = body && noteFor(c, body.path, "edit", reply);
    if (!body || !p) return;
    return vaultOf(c).write(p, body.content, commitAuthor(c), body.message);
  });

  app.post("/api/vault/append", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(z.object({ path: z.string().min(1), text: z.string().max(200_000) }), req.body, reply);
    const p = body && noteFor(c, body.path, "edit", reply);
    if (!body || !p) return;
    return vaultOf(c).append(p, body.text, commitAuthor(c));
  });

  app.post("/api/vault/move", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(z.object({ from: z.string().min(1), to: z.string().min(1) }), req.body, reply);
    const from = body && noteFor(c, body.from, "edit", reply);
    const to = from && noteFor(c, body.to, "edit", reply);
    if (!from || !to) return;
    return vaultOf(c).move(from, to, commitAuthor(c));
  });

  app.delete("/api/vault/note", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const p = noteFor(c, (req.query as { path?: string }).path ?? "", "edit", reply);
    if (!p) return;
    await vaultOf(c).remove(p, commitAuthor(c));
    return { ok: true };
  });

  app.get("/api/vault/search", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { q?: string; limit?: string };
    return vaultOf(c).search(q.q ?? "", readable(c), limitParam(q.limit, 20, 100));
  });

  app.get("/api/vault/resolve", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { target?: string; from?: string };
    const p = vaultOf(c).resolveLink(q.target ?? "", q.from);
    return { path: p && readable(c)(p) ? p : null };
  });

  app.get("/api/vault/history", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const p = noteFor(c, (req.query as { path?: string }).path ?? "", "read", reply);
    if (!p) return;
    return vaultOf(c).history(p);
  });

  app.get("/api/vault/at", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { path?: string; rev?: string };
    const p = noteFor(c, q.path ?? "", "read", reply);
    if (!p) return;
    return { content: await vaultOf(c).readAt(p, q.rev ?? "") };
  });

  /** Pick up edits made outside Warren (Obsidian, git pull). */
  app.post("/api/vault/sync", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    // edits found on disk are credited to Obsidian, not to whoever pressed the button
    const changed = await vaultOf(c).syncFromDisk();
    return { notes: vaultOf(c).list().length, changed };
  });

  /** Who last changed each line of a note. */
  app.get("/api/vault/blame", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const p = noteFor(c, (req.query as { path?: string }).path ?? "", "read", reply);
    if (!p) return;
    return vaultOf(c).blame(p);
  });

  /** Recent edits across memory that you can see: who changed which notes, newest first. */
  app.get("/api/vault/changes", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const q = req.query as { limit?: string; author?: string; path?: string };
    const canRead = readable(c);
    const prefix = q.path ? cleanRulePath(q.path).toLowerCase() : "";
    const limit = limitParam(q.limit, 50, 200);
    return (await vaultOf(c).changes(limit * 4))
      .map((ch) => ({ ...ch, files: ch.files.filter((f) => canRead(f.path) && (!prefix || f.path.toLowerCase() === prefix || f.path.toLowerCase().startsWith(prefix + "/"))) }))
      .filter((ch) => ch.files.length && (!q.author || ch.author === q.author))
      .slice(0, limit);
  });

  // --- what agents remember about people ------------------------------------------

  /** A person by id, name, or "me" (the caller, when it's a person). */
  function personRef(c: Caller, ref: string | undefined): { id: string; name: string } | null {
    const members = store.members(c.workspaceId);
    const r = (ref ?? "").trim();
    if (!r || r === "me") {
      if (c.actor.kind === "user") return members.find((m) => m.id === c.actor.id) ?? null;
      const run = hub.currentRun(c.actor.id);
      return run ? hub.memory.personFor(c.workspaceId, run.channelId, run.threadId, run.triggerMessageId) : (members.find((m) => m.role === "owner") ?? null);
    }
    return members.find((m) => m.id === r || m.name.toLowerCase() === r.toLowerCase()) ?? null;
  }

  /** Everything saved about a person: preferences, plans, journal entries and details. */
  app.get("/api/memory/profile", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const person = personRef(c, (req.query as { user?: string }).user);
    if (!person) return reply.code(404).send({ error: "person not found" });
    const level = memory(c)(`${personDir(person.id)}/x.md`).level;
    if (!atLeast(level, "read")) return reply.code(403).send({ error: `you can't see what's saved about ${person.name}` });
    return { person: { id: person.id, name: person.name }, level, items: await hub.memory.profiles(c.workspaceId).items(person.id) };
  });

  /**
   * Remember something about a person. Agents call this as they learn; people use it to add or
   * correct things. Similar memories aren't duplicated: you get them back to replace instead.
   */
  app.post("/api/memory/remember", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(
      z.object({
        kind: z.enum(MEMORY_KINDS),
        text: z.string().max(4000).optional(),
        about: z.string().max(100).optional(),
        title: z.string().max(120).optional(),
        status: z.enum(["active", "done", "dropped"]).optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable().optional(),
        pinned: z.boolean().optional(),
        replaces: z.string().max(500).optional(),
        force: z.boolean().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const person = personRef(c, body.about);
    if (!person) return reply.code(404).send({ error: `no person "${body.about ?? ""}"` });
    const run = c.actor.kind === "agent" ? hub.currentRun(c.actor.id) : undefined;
    const channel = run ? store.channel(run.channelId) : undefined;
    const origin = {
      by: c.actor.kind === "agent" ? `@${store.agent(c.actor.id)!.handle}` : store.user(c.actor.id)!.name,
      source: channel ? (channel.kind === "dm" ? "a direct message" : `#${channel.name}`) : null,
      channelId: channel?.id ?? null,
      messageId: run?.triggerMessageId ?? null,
    };
    const check = memory(c);
    const result = await hub.memory.profiles(c.workspaceId).remember(person.id, body, origin, commitAuthor(c), (p) => atLeast(check(p).level, "edit"));
    if (!result.saved && result.error) return reply.code(result.error.startsWith("no edit access") ? 403 : 400).send({ error: result.error });
    return { ...result, person: { id: person.id, name: person.name } };
  });

  /** The memory an agent starts with (for MCP sessions that don't get Warren's prompt). */
  app.get("/api/memory/context", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(400).send({ error: "agents only" });
    const q = req.query as { about?: string; q?: string };
    return { text: await hub.memory.sections(store.agent(c.actor.id)!, { person: personRef(c, q.about), query: q.q ?? "" }) };
  });

  // --- memory access ------------------------------------------------------------

  /**
   * Who can do what with a folder or note, and why: every person and agent with their
   * effective level and the rule that decided it, plus the rules set right here.
   */
  app.get("/api/access", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const path = rulePathFor((req.query as { path?: string }).path ?? "", reply);
    if (path === null) return;
    const rules = hub.access.rules(c.workspaceId);
    const mine = accessChecker(c.viewer, rules)(path).level;
    if (!atLeast(mine, "read")) return reply.code(403).send({ error: `no read access to ${path || "the vault"}` });
    const applying = rules.filter((r) => covers(r.path, path));
    const decide = (v: Viewer) => {
      const d = accessChecker(v, rules)(path);
      return { level: d.level, via: d.rule };
    };
    const agents = store.agents(c.workspaceId);
    const teams = store.teams(c.workspaceId);
    const roles = teams.flatMap((t) => [...new Set(t.members.map((m) => m.role).filter(Boolean))].map((role) => ({ kind: "role" as const, team: t.name, role })));
    const kinds: Subject[] = [{ kind: "all_agents" }, ...teams.map((t) => ({ kind: "team" as const, name: t.name })), ...roles, { kind: "members" }, { kind: "guests" }];
    const depth = (r: AccessRule) => (r.path ? r.path.split("/").length : 0);
    return {
      path,
      level: mine,
      people: store.members(c.workspaceId).map((m) => ({ id: m.id, name: m.name, role: m.role, ...decide({ actor: { kind: "user", id: m.id }, role: m.role }) })),
      agents: agents.map((a) => {
        const v = hub.access.agentViewer(a, teams);
        const d = decide(v);
        return { id: a.id, handle: a.handle, ...d, startup: atLeast(d.level, "read") && startupRules(v, applying).length > 0 };
      }),
      // "everyone"-style subjects, decided only by rules that name them
      subjects: kinds.map((s) => {
        const via = applying.filter((r) => subjectKey(r.subject) === subjectKey(s)).sort((a, b) => depth(b) - depth(a) || Number(!!a.builtin) - Number(!!b.builtin))[0] ?? null;
        return { subject: s, level: via?.level ?? "none", via };
      }),
      rules: applying.filter((r) => !r.builtin && cleanRulePath(r.path).toLowerCase() === path.toLowerCase()),
    };
  });

  /** Set the level (and "load at startup") for one subject on a folder or note. Needs manage there. */
  app.put("/api/access", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ path: z.string().max(500), subject: SUBJECT, level: LEVEL, startup: z.boolean().default(false) }), req.body, reply);
    if (!body) return;
    const path = rulePathFor(body.path, reply);
    if (path === null) return;
    if (!atLeast(memory(c)(path).level, "manage")) return reply.code(403).send({ error: `you can't change who has access to ${path || "the vault"}` });
    // a team is named by its channel: "#web" and "web" are the same
    const ruleTeam = body.subject.kind === "team" || body.subject.kind === "role" ? store.teamByName(c.workspaceId, body.subject.kind === "team" ? body.subject.name : body.subject.team) : undefined;
    const s: Subject = body.subject.kind === "team" && ruleTeam ? { kind: "team", name: ruleTeam.name } : body.subject.kind === "role" && ruleTeam ? { ...body.subject, team: ruleTeam.name } : body.subject;
    const forAgents = s.kind === "agent" || s.kind === "team" || s.kind === "role" || s.kind === "all_agents";
    if (forAgents && body.level === "manage") return reply.code(400).send({ error: "agents can read or edit, but can't manage access" });
    if (s.kind === "agent" && store.agent(s.id)?.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    if ((s.kind === "team" || s.kind === "role") && !ruleTeam) return reply.code(404).send({ error: "no channel with a team called that" });
    const role = s.kind === "user" ? store.role(c.workspaceId, s.id) : undefined;
    if (s.kind === "user" && !role) return reply.code(404).send({ error: "person not found" });
    if ((s.kind === "guests" || role === "guest") && atLeast(body.level, "edit")) return reply.code(400).send({ error: "guests can only read" });
    const rule = store.setAccessRule(c.workspaceId, { path, subject: s, level: body.level, startup: forAgents && body.startup, createdBy: c.actor });
    keepManaging(c, path);
    return rule;
  });

  /** Remove a rule so the folder or note goes back to what it inherits. Agents can undo their own shares. */
  app.delete("/api/access/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const rule = store.accessRule((req.params as { id: string }).id);
    if (!rule || rule.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "rule not found" });
    const ownShare = c.actor.kind === "agent" && rule.createdBy?.kind === "agent" && rule.createdBy.id === c.actor.id;
    if (!ownShare && !(c.actor.kind === "user" && atLeast(memory(c)(rule.path).level, "manage"))) return reply.code(403).send({ error: `you can't change who has access to ${rule.path || "the vault"}` });
    store.removeAccessRule(c.workspaceId, rule.id!);
    keepManaging(c, rule.path);
    return { ok: true };
  });

  /** Custom rules on folders and notes you can read. */
  app.get("/api/access/rules", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const canRead = readable(c);
    return store.accessRules(c.workspaceId).filter((r) => canRead(r.path));
  });

  /**
   * Share a note or folder read-only with an agent ("@nova"), a team, or "all agents".
   * Anyone who can edit it may share; a level a person set for that subject there wins.
   */
  app.post("/api/access/share", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const body = parse(z.object({ path: z.string().max(500), with: z.string().trim().min(1).max(100) }), req.body, reply);
    if (!body) return;
    const path = rulePathFor(body.path, reply);
    if (path === null) return;
    if (!path || !atLeast(memory(c)(path).level, "edit")) return reply.code(403).send({ error: "you can only share notes and folders you can edit" });
    const w = body.with.replace(/^@/, "");
    const agent = store.agentByHandle(c.workspaceId, w.toLowerCase());
    const subject: Subject | null = /^all[ _-]?agents$/i.test(w)
      ? { kind: "all_agents" }
      : agent
        ? { kind: "agent", id: agent.id }
        : store.teamByName(c.workspaceId, w.replace(/^team\s+/i, ""))
          ? { kind: "team", name: store.teamByName(c.workspaceId, w.replace(/^team\s+/i, ""))!.name }
          : null;
    if (!subject) return reply.code(404).send({ error: `no agent or team called "${body.with}"` });
    const existing = store.accessRuleAt(c.workspaceId, path, subject);
    if (existing?.createdBy?.kind === "user") return reply.code(409).send({ error: "a person already set access for them here; ask them to change it" });
    if (existing && atLeast(existing.level, "read")) return existing;
    return store.setAccessRule(c.workspaceId, { path, subject, level: "read", createdBy: c.actor });
  });

  /** Everything an agent's memory access comes from, and who its own folder is shared with. */
  app.get("/api/access/agents/:id", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = store.agent((req.params as { id: string }).id);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    const v = hub.access.agentViewer(agent);
    const rules = hub.access.rules(c.workspaceId);
    return {
      rules: rules.filter((r) => specificity(v, r.subject) > 0),
      sharedOut: rules.filter((r) => !r.builtin && covers(`agents/${agent.id}`, r.path) && specificity(v, r.subject) === 0),
    };
  });

  // --- files ------------------------------------------------------------------

  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 100 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/api/files", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ error: "send the file as application/octet-stream" });
    const name = fileName(req.headers["x-filename"]);
    const mime = String(req.headers["x-mime-type"] ?? "application/octet-stream");
    const channelId = typeof req.headers["x-channel-id"] === "string" ? req.headers["x-channel-id"] : null;
    if (channelId && !channelVisible(c, channelId)) return reply.code(404).send({ error: "channel not found" });
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const dest = path.join(opts.filesDir, sha.slice(0, 2), sha);
    if (!fs.existsSync(dest)) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    }
    return store.insertFile({ workspaceId: c.workspaceId, sha256: sha, name, mime, size: buf.length, uploader: c.actor, channelId });
  });

  app.get("/api/files", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const channel = (req.query as { channel?: string }).channel;
    if (channel && !channelVisible(c, channel)) return reply.code(404).send({ error: "channel not found" });
    // files shared in a DM stay between the people in it
    return store.files(c.workspaceId, channel).filter((f) => !f.channelId || channelVisible(c, f.channelId));
  });

  app.get("/api/files/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const f = store.file((req.params as { id: string }).id);
    if (!f || f.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "file not found" });
    if (f.channelId && !channelVisible(c, f.channelId)) return reply.code(404).send({ error: "file not found" });
    const inline = /^(image|text|video|audio)\/|^application\/pdf$/.test(f.mime) && !/svg|html/.test(f.mime);
    reply.header("content-type", f.mime).header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`).header("x-content-type-options", "nosniff");
    return reply.send(fs.createReadStream(path.join(opts.filesDir, f.sha256.slice(0, 2), f.sha256)));
  });

  registerComputerApi(app, hub, { need, parse, commitAuthor, agentView, requesterOf, channelVisible });
  registerSettingsApi(app, hub, { need, parse, dataDir: opts.dataDir });
  registerOrgApi(app, hub, { need, parse });
  registerMemoryStorageApi(app, hub, { need, parse, dataDir: opts.dataDir, started: opts.vault, restart: opts.restart });
  registerConnectorApi(app, hub, { need, parse, commitAuthor });
  registerVoiceApi(app, hub, { need });
  registerBackgroundApi(app, hub, { need, parse, requesterOf });
  registerLeadApi(app, hub, { need, parse });
  registerUpdateApi(app, hub, { need });
  registerPairingApi(app, hub, { need, parse });
  registerReachApi(app, hub, { need, parse });

  // --- websockets -------------------------------------------------------------

  /** Live view of a computer: a one-time ticket from POST /api/computers/:id/view travels in the URL. */
  app.get("/ws/computers/:id/:transport", { websocket: true }, (socket, req) => {
    const { id: computerId, transport } = req.params as { id: string; transport: string };
    const ticket = hub.computers.redeem((req.query as { ticket?: string }).ticket, computerId);
    const comp = ticket ? store.computer(computerId) : undefined;
    if (!ticket || !comp || comp.workspaceId !== ticket.workspaceId || ticket.kind !== transport) return socket.close(4401, "unauthorized");
    socket.on("close", () => hub.computers.viewerGone(comp, ticket));
    if (transport !== "vnc") hub.computers.addFrameViewer(comp, socket, ticket.userId);
    else if (comp.kind === "orgo") hub.computers.openOrgoRelay(comp, socket);
    else hub.computers.openTunnel(comp, socket, ticket.code);
  });

  /** Browsers can't set headers on WebSockets, so the session token arrives in the first frame. */
  app.get("/ws", { websocket: true }, (socket) => {
    const timer = setTimeout(() => socket.close(4401, "auth timeout"), 5000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      let token: string | undefined;
      try {
        token = JSON.parse(raw.toString()).token;
      } catch {}
      const c = caller({ headers: { authorization: `Bearer ${token}` } } as FastifyRequest);
      if (!c || c.actor.kind !== "user") return socket.close(4401, "unauthorized");
      hub.addClient(socket, c.workspaceId, c.actor.id, crypto.createHash("sha256").update(token!).digest("hex"));
      socket.send(JSON.stringify({ type: "ready" }));
    });
  });

  app.get("/ws/node", { websocket: true }, (socket, req) => {
    const p = resolveToken(db, bearer(req.headers.authorization));
    if (!p || p.kind !== "node" || !store.node(p.subjectId)) return socket.close(4401, "unauthorized");
    hub.addNode(socket, p.subjectId, p.workspaceId);
  });
}
