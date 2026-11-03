import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FEATURE_INFO, FEATURE_KEYS, type BackgroundWork, type FeatureKey, type MessagePart } from "@wisp/core";
import type { Caller } from "./api.ts";
import { DEFAULT_DAILY_CAP, parseWhen } from "./background.ts";
import { setWorkspaceFeatures, workspaceFeatures } from "./features.ts";
import type { Hub } from "./hub.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
  requesterOf(c: Caller): string | null;
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 22:00");

/** What an agent may change about its own background work for someone. */
type BackgroundPatch = Partial<Pick<BackgroundWork, "enabled" | "everyMinutes" | "focus" | "quietStart" | "quietEnd">>;
/** How to put things back the way they were before an agent changed them. */
interface Undo {
  /** `patch` puts things back; `after` is what the change set, so undo leaves alone anything changed since */
  background?: { agentId: string; patch: BackgroundPatch; after?: BackgroundPatch };
  mods?: Partial<Record<FeatureKey, boolean>>;
}

/** "every 30 min", "every hour", "every 2 hours" */
export function everyText(minutes: number) {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes % 60) return `every ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
}

/** "22:00" → "10pm", "07:30" → "7:30am" */
export function clockText(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** One line per thing that's different, e.g. "Checks: every 30 min → every 2 hours". */
function backgroundLines(was: BackgroundPatch, now: BackgroundPatch): string[] {
  const out: string[] = [];
  if (now.enabled !== undefined && now.enabled !== was.enabled) out.push(`Works in the background: ${now.enabled ? "on" : "off"}`);
  if (now.everyMinutes !== undefined && now.everyMinutes !== was.everyMinutes) out.push(`Checks: ${was.everyMinutes ? `${everyText(was.everyMinutes)} → ` : ""}${everyText(now.everyMinutes)}`);
  const qs = now.quietStart ?? was.quietStart;
  const qe = now.quietEnd ?? was.quietEnd;
  if ((now.quietStart !== undefined && now.quietStart !== was.quietStart) || (now.quietEnd !== undefined && now.quietEnd !== was.quietEnd)) out.push(qs === qe ? "Quiet hours: none" : `Quiet hours: ${clockText(qs!)} – ${clockText(qe!)}`);
  if (now.focus !== undefined && now.focus !== was.focus) out.push(now.focus ? `Keeps an eye on: ${now.focus}` : "Keeps an eye on: everything it can reach");
  return out;
}

/**
 * Background work (an agent checking in on its own for a person), follow-ups (one-off "come
 * back to this at 8am"), messaging the person first, and web push so it reaches their phone.
 */
export function registerBackgroundApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;
  const { need, parse, requesterOf } = h;

  /** The person an agent's call is for: whoever it's working for now, or the workspace owner. */
  const personFor = (c: Caller) => requesterOf(c) ?? store.members(c.workspaceId).find((m) => m.role === "owner")?.id ?? null;

  const agentFor = (c: Caller, agentId: string, reply: FastifyReply) => {
    const agent = store.agent(agentId);
    if (!agent || agent.workspaceId !== c.workspaceId) {
      reply.code(404).send({ error: "agent not found" });
      return null;
    }
    return agent;
  };

  // --- people: turning it on, and seeing what it's doing ---------------------------------------

  app.get("/api/agents/:id/background", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    return {
      background: store.background(agent.id, c.actor.id) ?? null,
      followups: store.pendingFollowups(agent.id).filter((f) => f.kind === "followup" && (!f.userId || f.userId === c.actor.id)),
      // chats with it that wait on this person, and whether it checks back when they go quiet
      loops: store.waitingLoops(agent.id, c.actor.id),
      checkback: store.checkbackOn(agent.id, c.actor.id),
      notAllowed: hub.whyNotAllowed(agent, c.actor.id),
      sources: hub.background.sources(agent.id).filter((s) => c.viewer.role !== "guest" || s.kind !== "computer"),
      usage: hub.background.usage(agent.id, c.actor.id),
      defaultDailyCap: DEFAULT_DAILY_CAP,
    };
  });

  app.put("/api/agents/:id/background", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    const notAllowed = hub.whyNotAllowed(agent, c.actor.id);
    if (notAllowed) return reply.code(403).send({ error: notAllowed });
    if (!hub.answers(agent, c.actor.id)) return reply.code(403).send({ error: `@${agent.handle} only answers the people its owner picked` });
    const body = parse(z.object({ enabled: z.boolean(), everyMinutes: z.number().int().min(10).max(1440), focus: z.string().trim().max(2000), quietStart: HHMM, quietEnd: HHMM, model: z.string().trim().max(200).nullable(), effort: z.string().trim().max(32).nullable(), dailyCap: z.number().int().min(1).max(1000).nullable() }).partial().strict(), req.body, reply);
    if (!body) return;
    const was = store.background(agent.id, c.actor.id);
    // turning it on starts with a check right away, so you see it working
    // a blank model or effort means "the same as the agent"; a higher limit lets a check that was waiting for tomorrow go ahead
    const raised = body.dailyCap === null || (body.dailyCap !== undefined && body.dailyCap > (was?.dailyCap ?? Infinity));
    const patch = { ...body, ...(body.model !== undefined ? { model: body.model || null } : {}), ...(body.effort !== undefined ? { effort: body.effort || null } : {}) };
    const b = store.setBackground(agent.id, c.actor.id, { ...patch, ...((body.enabled && !was?.enabled) || (raised && was?.nextReason === "daily limit reached") ? { nextAt: null, nextReason: "" } : {}) });
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: agent.id });
    // even in quiet hours: they just turned it on, so they expect to see it work
    if (body.enabled && !was?.enabled) hub.background.wake(agent.id, c.actor.id);
    if (body.enabled === false && was?.enabled) hub.background.turnedOff(agent.id, c.actor.id);
    return { background: store.background(agent.id, c.actor.id) ?? b };
  });

  app.post("/api/agents/:id/background/check", async (req, reply) => {
    const c = need(req, reply, { member: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    const runId = hub.background.wake(agent.id, c.actor.id);
    if (!runId) return reply.code(409).send({ error: hub.whyNotAllowed(agent, c.actor.id) ?? "it's already checking" });
    return { runId };
  });

  app.put("/api/agents/:id/checkback", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const agent = agentFor(c, (req.params as { id: string }).id, reply);
    if (!agent) return;
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body, reply);
    if (!body) return;
    store.setCheckback(agent.id, c.actor.id, body.enabled);
    // off: the check-backs already waiting don't happen either
    if (!body.enabled) store.db.prepare("UPDATE followups SET status = 'cancelled' WHERE agent_id = ? AND user_id = ? AND kind = 'checkback' AND status = 'pending'").run(agent.id, c.actor.id);
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: agent.id }, (u) => u === c.actor.id);
    return { checkback: body.enabled };
  });

  /** A follow-up its agent, the person it's for, or an owner may change. */
  const followupFor = (c: Caller, reply: FastifyReply, followupId: string) => {
    const f = store.followup(followupId);
    const agent = f && store.agent(f.agentId);
    if (!f || !agent || agent.workspaceId !== c.workspaceId) return void reply.code(404).send({ error: "follow-up not found" });
    if (c.actor.kind === "agent" ? c.actor.id !== f.agentId : f.userId && f.userId !== c.actor.id && c.viewer.role !== "owner") return void reply.code(403).send({ error: "not your follow-up" });
    return f;
  };
  const followupChanged = (c: Caller, f: { id: string; agentId: string }) => {
    hub.loops.refreshPill(f.id);
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: f.agentId });
    hub.broadcast(c.workspaceId, { type: "channels_changed" });
  };

  app.delete("/api/followups/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const f = followupFor(c, reply, (req.params as { id: string }).id);
    if (!f) return;
    // `?done=1`: it happened, so there's nothing to come back to
    store.setFollowupStatus(f.id, (req.query as { done?: string }).done === "1" ? "done" : "cancelled");
    followupChanged(c, f);
    return { ok: true };
  });

  app.patch("/api/followups/:id", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const f = followupFor(c, reply, (req.params as { id: string }).id);
    if (!f) return;
    const body = parse(z.object({ dueAt: z.string().datetime({ offset: true }), status: z.enum(["done", "cancelled"]) }).partial().strict(), req.body, reply);
    if (!body) return;
    if (f.status !== "pending") return reply.code(409).send({ error: "that already happened" });
    if (body.dueAt) {
      if (new Date(body.dueAt).getTime() < Date.now() - 60_000) return reply.code(400).send({ error: "that time has already passed" });
      store.rescheduleFollowup(f.id, new Date(body.dueAt).toISOString());
    }
    if (body.status) store.setFollowupStatus(f.id, body.status);
    followupChanged(c, f);
    return store.followup(f.id);
  });

  // --- agents: pacing themselves, follow-ups, and writing first --------------------------------

  app.post("/api/background/next", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(z.object({ minutes: z.number().positive().max(100_000), reason: z.string().max(300).default("") }), req.body, reply);
    if (!body) return;
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to work for" });
    return hub.background.setNext(c.actor.id, userId, body.minutes, body.reason);
  });

  app.get("/api/followups", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    const agentId = c.actor.kind === "agent" ? c.actor.id : (req.query as { agent?: string }).agent;
    if (!agentId || store.agent(agentId)?.workspaceId !== c.workspaceId) return reply.code(400).send({ error: "which agent?" });
    return store.pendingFollowups(agentId);
  });

  app.post("/api/followups", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents set follow-ups" });
    const body = parse(
      z.object({
        at: z.string().max(40).optional(),
        inMinutes: z.number().positive().max(60 * 24 * 366).optional(),
        note: z.string().trim().min(1).max(1000),
        // cosmetic: cut to fit rather than failing the call
        label: z.string().trim().transform((s) => s.slice(0, 60)).optional(),
        waitingOn: z.enum(["agent", "person"]).default("agent"),
        condition: z.string().trim().transform((s) => s.slice(0, 200)).default(""),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const userId = personFor(c);
    const tz = (userId && store.user(userId)?.timezone) || "UTC";
    const due = body.inMinutes ? new Date(Date.now() + body.inMinutes * 60_000) : body.at ? parseWhen(body.at, tz) : null;
    if (!due) return reply.code(400).send({ error: `give "at" as "YYYY-MM-DD HH:MM" on ${tz} time (or ISO with an offset), or "in_minutes"` });
    if (due.getTime() < Date.now() - 60_000) return reply.code(400).send({ error: "that time has already passed" });
    // set while answering someone: it shows under that answer
    const run = hub.runFor(c.actor.id, req.headers["x-wisp-run"]);
    const f = store.createFollowup({ agentId: c.actor.id, userId, dueAt: due.toISOString(), note: body.note, label: body.label || null, waitingOn: body.waitingOn, condition: body.condition, channelId: run?.channelId ?? null, runId: run?.id ?? null });
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: c.actor.id });
    // a chat's line in the list says when the agent will be back
    if (userId) hub.broadcast(c.workspaceId, { type: "channels_changed" }, (u) => u === userId);
    return { ...f, timezone: tz };
  });

  app.post("/api/message-person", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(
      z.object({
        text: z.string().trim().min(1).max(20_000),
        fileIds: z.array(z.string()).max(20).default([]),
        replies: z.array(z.string()).default([]).transform((r) => r.map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, 4)),
        // what it's about ("notion:<page id>"), so it's only ever raised once
        about: z.string().trim().max(200).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to message" });
    if (body.about) {
      const may = hub.watches.mayRaise(c.actor.id, userId, body.about);
      if (!may.ok) return reply.code(409).send({ error: `You already raised "${body.about}" on ${new Date(may.saidAt).toUTCString()} and they didn't answer, so it's dropped. Don't bring it up again unless they do.` });
    }
    const channel = store.dmChannel(c.workspaceId, userId, c.actor.id);
    const files = body.fileIds.map((f) => store.file(f)).filter((f) => f?.workspaceId === c.workspaceId);
    // written because something came due: the person sees the agent checking back, with its quick replies;
    // not the line where it lets a chat go (that one shows "Closed")
    const run = hub.runFor(c.actor.id, req.headers["x-wisp-run"]);
    const checkingBack = run?.kind === "background" && hub.background.carriesFollowups(run.id) && !hub.loops.closing(run.id);
    const parts: MessagePart[] = files.map((f) => ({ type: "file" as const, fileId: f!.id, name: f!.name }));
    if (checkingBack || body.replies.length) parts.push({ type: "checkback", replies: body.replies });
    // checking back on something brings back the chat it came from, even after a quiet break
    const due = (run?.kind === "background" ? hub.background.followupsOf(run.id) : []).filter((f) => f.channelId === channel.id);
    const from = due.find((f) => f.messageId)?.messageId;
    const contextId = due.length ? ((from && store.message(from)?.conversationId) || store.latestWritten(channel.id)?.conversationId || null) : null;
    const msg = hub.postMessage({ channelId: channel.id, author: c.actor, body: body.text, parts, route: false, onBehalfOf: userId, contextId });
    if (run?.kind === "background") hub.loops.wrote(run.id, msg.id);
    if (body.about) hub.watches.raised(c.actor.id, userId, body.about, msg.id);
    return { messageId: msg.id, channelId: channel.id };
  });

  app.post("/api/chat-status", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const body = parse(
      z.object({
        status: z.enum(["open", "waiting", "done", "closed"]),
        summary: z.string().optional(),
        did: z.string().optional(),
        saved: z.string().optional(),
        next: z.string().optional(),
        // Loops trims the text and keeps the time between 10 minutes and a week
        checkBackInMinutes: z.number().positive().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const run = hub.runFor(c.actor.id, req.headers["x-wisp-run"]);
    if (!run) return reply.code(409).send({ error: "only while answering someone (if you're answering several people at once, update Wisp on your device)" });
    const r = hub.loops.setStatus(run, { status: body.status, summary: body.summary, wrap: { did: body.did, saved: body.saved, next: body.next }, checkBackInMinutes: body.checkBackInMinutes });
    if ("error" in r) return reply.code(400).send(r);
    return r;
  });

  // --- one allowance for all of a person's background work -----------------------------------------

  app.get("/api/background/allowance", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return hub.background.allowance(c.workspaceId, c.actor.id);
  });

  app.get("/api/usage", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const q = parse(z.object({ range: z.enum(["today", "7d", "30d"]).default("7d") }), req.query, reply);
    if (!q) return;
    return hub.background.usageReport(c.workspaceId, c.actor.id, q.range);
  });

  app.put("/api/background/allowance", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ dailyTokens: z.number().int().min(10_000).max(1_000_000_000).nullable() }).strict(), req.body, reply);
    if (!body) return;
    hub.background.setDailyTokens(c.workspaceId, c.actor.id, body.dailyTokens);
    hub.broadcast(c.workspaceId, { type: "background_changed", agentId: "" });
    return hub.background.allowance(c.workspaceId, c.actor.id);
  });

  // --- agents changing settings and mods for their person, and undoing that -------------------------

  /** Apply a background patch for one agent and person: turning it on or off starts or stops checks like the Background tab does. */
  const applyBackground = (agentId: string, userId: string, workspaceId: string, patch: BackgroundPatch) => {
    const was = store.background(agentId, userId);
    store.setBackground(agentId, userId, { ...patch, ...(patch.enabled && !was?.enabled ? { nextAt: null, nextReason: "" } : {}) });
    hub.broadcast(workspaceId, { type: "background_changed", agentId });
    if (patch.enabled && !was?.enabled) hub.background.wake(agentId, userId);
    if (patch.enabled === false && was?.enabled) hub.background.turnedOff(agentId, userId);
  };

  app.get("/api/agent/settings", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to work for" });
    const b = store.background(c.actor.id, userId);
    const features = workspaceFeatures(store, c.workspaceId);
    return {
      background: b ? { enabled: b.enabled, everyMinutes: b.everyMinutes, quietStart: b.quietStart, quietEnd: b.quietEnd, focus: b.focus } : null,
      mods: FEATURE_KEYS.map((k) => ({ key: k, name: FEATURE_INFO[k].name, description: FEATURE_INFO[k].description, on: features[k] })),
      canChangeMods: store.members(c.workspaceId).some((m) => m.id === userId && m.role === "owner"),
      allowance: hub.background.allowance(c.workspaceId, userId),
    };
  });

  app.post("/api/agent/settings", async (req, reply) => {
    const c = need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const agent = store.agent(c.actor.id)!;
    const body = parse(
      z
        .object({
          background: z.object({ enabled: z.boolean(), everyMinutes: z.number().int().min(10).max(1440), focus: z.string().trim().max(2000), quietStart: HHMM, quietEnd: HHMM }).partial().strict(),
          mods: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<FeatureKey, z.ZodBoolean>).partial().strict(),
        })
        .partial()
        .strict(),
      req.body,
      reply,
    );
    if (!body) return;
    const userId = personFor(c);
    if (!userId) return reply.code(409).send({ error: "nobody to work for" });
    const undo: Undo = {};
    const lines: string[] = [];
    if (body.background && Object.keys(body.background).length) {
      const notAllowed = hub.whyNotAllowed(agent, userId);
      if (notAllowed) return reply.code(403).send({ error: notAllowed });
      const was = store.background(agent.id, userId);
      const before: BackgroundPatch = was ? { enabled: was.enabled, everyMinutes: was.everyMinutes, focus: was.focus, quietStart: was.quietStart, quietEnd: was.quietEnd } : { enabled: false };
      lines.push(...backgroundLines(before, body.background));
      // background work that didn't exist yet goes back to off
      // changing how often or what to watch for someone who never turned it on keeps it off
      const patch: BackgroundPatch = !was && body.background.enabled === undefined ? { ...body.background, enabled: false } : body.background;
      undo.background = { agentId: agent.id, after: patch, patch: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof BackgroundPatch] ?? (k === "enabled" ? false : undefined)]).filter(([, v]) => v !== undefined)) };
      applyBackground(agent.id, userId, c.workspaceId, patch);
    }
    if (body.mods && Object.keys(body.mods).length) {
      if (!store.members(c.workspaceId).some((m) => m.id === userId && m.role === "owner")) return reply.code(403).send({ error: "only an owner can turn mods on or off; ask them to" });
      const was = workspaceFeatures(store, c.workspaceId);
      const changed = (Object.keys(body.mods) as FeatureKey[]).filter((k) => was[k] !== body.mods![k]);
      if (changed.length) {
        undo.mods = Object.fromEntries(changed.map((k) => [k, was[k]]));
        lines.push(...changed.map((k) => `Mod ${FEATURE_INFO[k].name}: ${body.mods![k] ? "on" : "off"}`));
        hub.broadcast(c.workspaceId, { type: "features", features: setWorkspaceFeatures(store, c.workspaceId, body.mods) });
      }
    }
    if (!lines.length) return { changed: [], note: "Nothing was different, so nothing changed." };
    const change = store.createChange({ workspaceId: c.workspaceId, userId, agentId: agent.id, lines, undo });
    // the person sees what changed in your DM, with an Undo
    const channel = store.dmChannel(c.workspaceId, userId, agent.id);
    hub.postMessage({ channelId: channel.id, author: c.actor, body: lines.join("\n"), parts: [{ type: "change", changeId: change.id }], route: false, onBehalfOf: userId });
    hub.broadcast(c.workspaceId, { type: "changes_changed" });
    return { changed: lines, changeId: change.id };
  });

  app.get("/api/changes", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return store.changes(c.workspaceId, c.actor.id).map(({ undo: _, ...ch }) => ch);
  });

  app.post("/api/changes/:id/undo", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const ch = store.change((req.params as { id: string }).id);
    if (!ch || ch.userId !== c.actor.id || store.agent(ch.agentId)?.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "change not found" });
    if (ch.undoneAt) return reply.code(409).send({ error: "already undone" });
    const undo = ch.undo as Undo;
    if (undo.mods && c.viewer.role !== "owner") return reply.code(403).send({ error: "only an owner can turn mods on or off" });
    // only what still is as the change left it goes back; anything changed since stays
    if (undo.background) {
      const { agentId, patch, after } = undo.background;
      const now = store.background(agentId, c.actor.id);
      const keep = Object.fromEntries(Object.entries(patch).filter(([k]) => !after || !now || now[k as keyof BackgroundPatch] === after[k as keyof BackgroundPatch]));
      if (Object.keys(keep).length) applyBackground(agentId, c.actor.id, c.workspaceId, keep);
    }
    if (undo.mods) {
      const now = workspaceFeatures(store, c.workspaceId);
      const keep = Object.fromEntries((Object.keys(undo.mods) as FeatureKey[]).filter((k) => now[k] !== undo.mods![k]).map((k) => [k, undo.mods![k]]));
      if (Object.keys(keep).length) hub.broadcast(c.workspaceId, { type: "features", features: setWorkspaceFeatures(store, c.workspaceId, keep) });
    }
    store.markChangeUndone(ch.id);
    hub.broadcast(c.workspaceId, { type: "changes_changed" });
    return { ok: true };
  });

  // --- web push ----------------------------------------------------------------------------------

  app.get("/api/push/key", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    return { publicKey: hub.push.keys(c.workspaceId).publicKey };
  });

  const SUB = z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
    prefs: z.object({ dms: z.boolean().optional(), replies: z.boolean().optional(), approvals: z.boolean().optional(), help: z.boolean().optional(), tasks: z.boolean().optional() }).optional(),
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(SUB, req.body, reply);
    if (!body) return;
    store.savePushSubscription(c.actor.id, body.endpoint, body.keys, body.prefs);
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const body = parse(z.object({ endpoint: z.string().max(2000) }), req.body, reply);
    if (!body) return;
    if (store.pushSubscriptions(c.actor.id).some((s) => s.endpoint === body.endpoint)) store.deletePushSubscription(body.endpoint);
    return { ok: true };
  });

  app.post("/api/push/test", async (req, reply) => {
    const c = need(req, reply, { user: true });
    if (!c) return;
    const sent = await hub.push.notify(c.workspaceId, [c.actor.id], { title: "Wisp", body: "Notifications reach this device.", tag: "test", url: "/#/settings/notifications" });
    return { sent };
  });
}
