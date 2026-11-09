import { CONNECTOR_CATALOG, zonedParts, type Allowance, type BackgroundSource, type BackgroundUsage, type BackgroundWork, type Followup } from "@wisp/core";
import { featureOn } from "./features.ts";
import type { Hub } from "./hub.ts";
import { watcherFor } from "./watchers/index.ts";

export type UsageRange = "today" | "7d" | "30d";
export interface UsageReport {
  range: UsageRange;
  /** the time zone the buckets are cut in */
  tz: string;
  /** hourly for today, daily otherwise, oldest first, empty ones included; `start` is an ISO time */
  buckets: { start: string; chat: number; background: number }[];
  totals: { tokens: number; runs: number; failed: number; estimated: boolean };
  /** tokens in the equal-length period just before this one */
  previousTokens: number;
  agents: { agentId: string; tokens: number; runs: number }[];
  models: { model: string; tokens: number }[];
  background: { todayTokens: number; dailyTokens: number | null; resetsAt: string };
}

/** The device sees background checks as their own conversation, so they don't mix into the DM's. */
export const BACKGROUND_THREAD = "background";
/** Regular checks a day, per agent and person, until they pick another number. */
export const DEFAULT_DAILY_CAP = 24;
/** Tokens a day background checks may use for one person, across all their agents, until they pick another amount. */
export const DEFAULT_ALLOWANCE = 1_000_000;
/** What a check that didn't report its usage is counted as. */
export const ESTIMATED_CHECK_TOKENS = 25_000;
/** Past this share of the allowance, checks come half as often. */
export const SLOW_DOWN_AT = 0.8;
const MIN_MINUTES = 10;
const MAX_MINUTES = 24 * 60;
/**
 * Quiet checks stretch the usual wait up to this (a usual wait that's longer stays as it is). Apps
 * with a watch (watches.ts) wake the agent themselves when something changes, so this only delays
 * what the hub can't see: apps without one.
 */
export const BACKOFF_CEILING_MINUTES = 4 * 60;
/** An agent with nothing to watch is looked at again this often, or at its usual pace if that's sooner (no tokens: the hub only checks its sources). */
const IDLE_RECHECK_MINUTES = 60;
/** Quiet checks in a row that keep doubling the wait (2^6 × 10 minutes is already past the ceiling). */
const MAX_QUIET_STREAK = 6;
/** The person hears that usage is climbing once at least this share is used and the last hour's pace would use the rest before the day ends. */
export const WARN_FROM_SHARE = 0.25;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Whether `at` falls in the quiet hours (which may wrap past midnight) on the person's clock. */
export function inQuietHours(at: Date, timeZone: string, start: string, end: string): boolean {
  const { hour, minute } = zonedParts(at, timeZone);
  const t = hour * 60 + minute;
  const s = minutes(start);
  const e = minutes(end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** The first minute after `at` that isn't in quiet hours (at most a day ahead). */
export function afterQuietHours(at: Date, timeZone: string, start: string, end: string): Date {
  let t = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 24 * 60 && inQuietHours(t, timeZone, start, end); i += 5) t = new Date(t.getTime() + 5 * 60_000);
  return t;
}

/** The calendar day `at` falls on, on the person's clock, as "YYYY-MM-DD". */
const dayOf = (at: Date, timeZone: string) => at.toLocaleDateString("en-CA", { timeZone });

/** Midnight at the start of `at`'s day on the person's clock; `plusDays` = 1 gives the start of tomorrow. */
export function startOfDay(at: Date, timeZone: string, plusDays = 0): Date {
  const [y, m, d] = dayOf(at, timeZone).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + plusDays));
  return parseWhen(`${day.toISOString().slice(0, 10)} 00:00`, timeZone) ?? day;
}

/**
 * Agents working in the background, like a good assistant who keeps an eye on things: every so
 * often (at a pace the agent picks itself) it wakes with no message, looks at what it can reach,
 * and messages the person only when something needs them. Follow-ups are the one-off version:
 * "8am tomorrow, remind Sam the essay is due".
 */
export const NOTHING_TO_WATCH = "nothing to watch yet";
export const QUIET_LATELY = "quiet lately";

export class Background {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private hub: Hub) {}

  start() {
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private timezone(userId: string) {
    return this.hub.store.user(userId)?.timezone || "UTC";
  }

  /** Start every check and follow-up that's due. */
  tick(at = new Date()) {
    const { store } = this.hub;
    // follow-ups first: due ones for the same agent and person go into one check
    const due = new Map<string, Followup[]>();
    for (const f of store.dueFollowups(at.toISOString())) {
      const userId = f.userId ?? this.ownerOf(f.agentId);
      if (!userId) {
        store.setFollowupStatus(f.id, "cancelled");
        continue;
      }
      const key = `${f.agentId}:${userId}`;
      due.set(key, [...(due.get(key) ?? []), { ...f, userId }]);
    }
    for (const [key, list] of due) {
      const [agentId, userId] = key.split(":");
      if (this.checking(agentId, userId)) continue;
      const runId = this.wake(agentId, userId, list, at);
      if (!runId) continue;
      for (const f of list) store.setFollowupStatus(f.id, "done");
      this.hub.loops.fired(list, runId);
      // its chat's "Back at 4:35" line is over
      const ws = store.agent(agentId)?.workspaceId;
      if (ws) this.hub.broadcast(ws, { type: "channels_changed" }, (u) => u === userId);
    }
    for (const b of store.activeBackground()) {
      if (b.checking) continue;
      // something urgent the hub can see ends a stretched or skipped wait
      if ((b.nextReason === QUIET_LATELY || b.nextReason === NOTHING_TO_WATCH) && b.nextAt && new Date(b.nextAt) > at && this.waitIsOver(b)) {
        const usual = (b.lastAt ? new Date(b.lastAt).getTime() : at.getTime()) + b.everyMinutes * 60_000;
        b.nextAt = store.setBackground(b.agentId, b.userId, { quietStreak: 0, nextAt: new Date(usual).toISOString(), nextReason: "" }).nextAt;
        const inWs = store.agent(b.agentId)?.workspaceId;
        if (inWs) this.hub.broadcast(inWs, { type: "background_changed", agentId: b.agentId });
      }
      if (b.nextAt && new Date(b.nextAt) > at) continue;
      // no checks while the organization has Background agents switched off (Settings → General → Mods)
      const ws = store.agent(b.agentId)?.workspaceId;
      if (!ws || !featureOn(store, ws, "background")) continue;
      const tz = this.timezone(b.userId);
      if (inQuietHours(at, tz, b.quietStart, b.quietEnd)) {
        store.setBackground(b.agentId, b.userId, { nextAt: afterQuietHours(at, tz, b.quietStart, b.quietEnd).toISOString(), nextReason: "after quiet hours" });
        continue;
      }
      // a regular check waits for tomorrow once the person's allowance or this agent's limit is used up; follow-ups above never wait
      if (this.allowanceShare(ws, b.userId, at) >= 1) {
        store.setBackground(b.agentId, b.userId, { nextAt: startOfDay(at, tz, 1).toISOString(), nextReason: "allowance used up" });
        continue;
      }
      if (this.capReached(b.agentId, b.userId, b.dailyCap, at)) {
        store.setBackground(b.agentId, b.userId, { nextAt: startOfDay(at, tz, 1).toISOString(), nextReason: "daily limit reached" });
        continue;
      }
      // nothing only a model can look at, and nothing the hub can see changed: a check would only spend
      // tokens finding that out. Apps and sites with a watch wake the agent themselves when they change.
      if (!this.hasSomethingToWatch(b.agentId, b.lastAt, b.userId)) {
        const reason = this.hub.watches.active(b.agentId, b.userId).length ? QUIET_LATELY : NOTHING_TO_WATCH;
        if (b.nextReason !== reason) this.hub.broadcast(ws, { type: "background_changed", agentId: b.agentId });
        store.setBackground(b.agentId, b.userId, { nextAt: new Date(at.getTime() + Math.min(IDLE_RECHECK_MINUTES, b.everyMinutes) * 60_000).toISOString(), nextReason: reason });
        continue;
      }
      this.wake(b.agentId, b.userId, [], at);
    }
  }

  /** Checks started today (any kind) on the person's clock. */
  private checksToday(agentId: string, userId: string, at: Date) {
    return this.hub.store.backgroundRuns(agentId, userId, startOfDay(at, this.timezone(userId)).toISOString()).length;
  }

  capReached(agentId: string, userId: string, cap: number | null, at: Date) {
    return cap !== null && this.checksToday(agentId, userId, at) >= cap;
  }

  private allowanceKey = (userId: string) => `allowance:${userId}`;

  /** Tokens a day this person lets background checks use in a workspace; null = no limit. */
  dailyTokens(workspaceId: string, userId: string): number | null {
    const v = this.hub.store.setting(workspaceId, this.allowanceKey(userId));
    if (v === null) return DEFAULT_ALLOWANCE;
    return v === "none" ? null : Number(v) || DEFAULT_ALLOWANCE;
  }

  setDailyTokens(workspaceId: string, userId: string, tokens: number | null) {
    const { store } = this.hub;
    store.setSetting(workspaceId, this.allowanceKey(userId), tokens === null ? "none" : String(tokens));
    // checks that were waiting for tomorrow because of the old amount can go ahead if there's room now
    if (this.allowanceShare(workspaceId, userId) < 1)
      for (const b of store.activeBackground()) {
        if (b.userId !== userId || b.nextReason !== "allowance used up" || store.agent(b.agentId)?.workspaceId !== workspaceId) continue;
        store.setBackground(b.agentId, userId, { nextAt: null, nextReason: "" });
        this.hub.broadcast(workspaceId, { type: "background_changed", agentId: b.agentId });
      }
  }

  /** What every agent's checks used today for one person, against their allowance. */
  allowance(workspaceId: string, userId: string, at = new Date()): Allowance {
    const runs = this.hub.store.backgroundRunsFor(workspaceId, userId, startOfDay(at, this.timezone(userId)).toISOString());
    const per = new Map<string, { agentId: string; tokens: number; checks: number }>();
    for (const r of runs) {
      const a = per.get(r.agentId) ?? { agentId: r.agentId, tokens: 0, checks: 0 };
      a.tokens += r.tokens ?? ESTIMATED_CHECK_TOKENS;
      a.checks += 1;
      per.set(r.agentId, a);
    }
    const agents = [...per.values()].sort((a, b) => b.tokens - a.tokens);
    return { dailyTokens: this.dailyTokens(workspaceId, userId), todayTokens: agents.reduce((n, a) => n + a.tokens, 0), estimated: runs.some((r) => r.tokens === null), agents };
  }

  /** Everything this person's agents used over a range, for the Usage page. */
  usageReport(workspaceId: string, userId: string, range: UsageRange, at = new Date()): UsageReport {
    const { store } = this.hub;
    const tz = this.timezone(userId);
    const hourly = range === "today";
    const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
    const first = startOfDay(at, tz, 1 - days);
    const end = startOfDay(at, tz, 1);
    const prevStart = startOfDay(at, tz, 1 - 2 * days);
    const starts: number[] = [];
    if (hourly) for (let i = 0; i < 24; i++) starts.push(first.getTime() + i * 3_600_000);
    else for (let i = 0; i < days; i++) starts.push(startOfDay(at, tz, 1 - days + i).getTime());
    const buckets = starts.map((s) => ({ start: new Date(s).toISOString(), chat: 0, background: 0 }));
    const owner = store.members(workspaceId).find((m) => m.role === "owner")?.id === userId;
    const rows = store.usageRows(workspaceId, userId, owner, first.toISOString(), end.toISOString(), ESTIMATED_CHECK_TOKENS);
    const totals = { tokens: 0, runs: 0, failed: 0, estimated: false };
    const agents = new Map<string, { agentId: string; tokens: number; runs: number }>();
    const models = new Map<string, number>();
    for (const r of rows) {
      const t = Date.parse(`${r.slot}:00Z`);
      let i = starts.length - 1;
      while (i > 0 && starts[i] > t) i--;
      buckets[i][r.background ? "background" : "chat"] += r.tokens;
      totals.tokens += r.tokens;
      totals.runs += r.runs;
      totals.failed += r.failed;
      if (r.guessed) totals.estimated = true;
      const a = agents.get(r.agentId) ?? { agentId: r.agentId, tokens: 0, runs: 0 };
      a.tokens += r.tokens;
      a.runs += r.runs;
      agents.set(r.agentId, a);
      const m = r.model || "Unknown";
      models.set(m, (models.get(m) ?? 0) + r.tokens);
    }
    const previousTokens = store.usageRows(workspaceId, userId, owner, prevStart.toISOString(), first.toISOString(), ESTIMATED_CHECK_TOKENS).reduce((n, r) => n + r.tokens, 0);
    const today = this.allowance(workspaceId, userId, at);
    return {
      range,
      tz,
      buckets,
      totals,
      previousTokens,
      agents: [...agents.values()].sort((a, b) => b.tokens - a.tokens),
      models: [...models].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens),
      background: { todayTokens: today.todayTokens, dailyTokens: today.dailyTokens, resetsAt: end.toISOString() },
    };
  }

  /** How much of today's allowance is used (1 = all of it); 0 when there's no limit. */
  allowanceShare(workspaceId: string, userId: string, at = new Date()): number {
    const a = this.allowance(workspaceId, userId, at);
    return a.dailyTokens ? a.todayTokens / a.dailyTokens : 0;
  }

  /** What this person's checks used, from the token counts the harness reported. */
  usage(agentId: string, userId: string, at = new Date()): BackgroundUsage {
    const tz = this.timezone(userId);
    const today = startOfDay(at, tz).toISOString();
    const runs = this.hub.store.backgroundRuns(agentId, userId, new Date(at.getTime() - 7 * 86_400_000).toISOString());
    const sum = (list: typeof runs) => (list.some((r) => r.tokens !== null) ? list.reduce((n, r) => n + (r.tokens ?? 0), 0) : null);
    const todays = runs.filter((r) => r.createdAt >= today);
    const finished = runs.find((r) => r.status === "done" || r.status === "failed");
    return {
      lastTokens: finished?.tokens ?? null,
      todayTokens: sum(todays),
      weekTokens: sum(runs),
      checksToday: todays.length,
      capReached: this.capReached(agentId, userId, this.hub.store.background(agentId, userId)?.dailyCap ?? null, at),
    };
  }

  private ownerOf(agentId: string) {
    const agent = this.hub.store.agent(agentId);
    return agent ? (this.hub.store.members(agent.workspaceId).find((m) => m.role === "owner")?.id ?? null) : null;
  }

  private checking(agentId: string, userId: string) {
    return !!this.hub.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND kind = 'background' AND requested_by = ? AND status IN ('queued','running')").get(agentId, userId);
  }

  /** Start a background check for one person, now, carrying any follow-ups and app changes. Returns the run, or null if it can't start. */
  wake(agentId: string, userId: string, followups: Followup[] = [], at = new Date(), eventIds: string[] = []): string | null {
    const { store } = this.hub;
    const agent = store.agent(agentId);
    if (!agent || !store.user(userId) || this.hub.whyNotAllowed(agent, userId) || !this.hub.answers(agent, userId)) return null;
    if (this.checking(agentId, userId)) return null;
    const channel = store.dmChannel(agent.workspaceId, userId, agentId);
    // queued until its device takes it: not a check yet, so it isn't counted, listed or shown as "last checked"
    const runId = store.createRun({ agentId, channelId: channel.id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: userId, kind: "background" });
    this.pendingFollowups.set(runId, followups);
    if (eventIds.length) this.hub.watches.claim(eventIds, runId);
    this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
    this.hub.dispatchRun(runId);
    return runId;
  }

  /** The device took the check: now it counts as one, and "last checked" is now. */
  started(run: { id: string; agentId: string; requestedBy: string | null }, at = new Date()) {
    const { store } = this.hub;
    const agent = store.agent(run.agentId);
    if (!agent || !run.requestedBy) return;
    const b = store.background(run.agentId, run.requestedBy);
    // the default pace until the agent says otherwise during the check; half as often once most of the allowance is used
    const slow = this.allowanceShare(agent.workspaceId, run.requestedBy, at) >= SLOW_DOWN_AT;
    if (b) store.setBackground(run.agentId, run.requestedBy, { lastAt: at.toISOString(), nextAt: new Date(at.getTime() + b.everyMinutes * (slow ? 2 : 1) * 60_000).toISOString(), nextReason: slow ? "saving allowance" : "" });
    this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId: agent.id });
  }

  /** Turned off while a check was still waiting for its device: that check never happens. */
  turnedOff(agentId: string, userId: string) {
    const { store } = this.hub;
    const queued = store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND kind = 'background' AND requested_by = ? AND status = 'queued'").all(agentId, userId) as { id: string }[];
    for (const r of queued) {
      // a check that carries follow-ups the agent promised still goes ahead
      if (this.pendingFollowups.get(r.id)?.length) continue;
      if (store.deleteQueuedRun(r.id)) {
        this.pendingFollowups.delete(r.id);
        this.hub.watches.release(r.id);
      }
    }
    const agent = store.agent(agentId);
    if (agent) this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
  }

  private pendingFollowups = new Map<string, Followup[]>();

  /** What a background run was woken for (follow-ups that came due), if anything. */
  followupsOf(runId: string): Followup[] {
    return this.pendingFollowups.get(runId) ?? [];
  }

  /** A check that follow-ups woke: what it writes is the agent coming back to something. */
  carriesFollowups(runId: string) {
    return !!this.pendingFollowups.get(runId)?.length;
  }

  /** The agent picked when to look again (from `next_check`). */
  setNext(agentId: string, userId: string, inMinutes: number, reason: string) {
    const ws = this.hub.store.agent(agentId)?.workspaceId;
    // near the end of the allowance, the agent's own pick stretches too
    const slow = !!ws && this.allowanceShare(ws, userId) >= SLOW_DOWN_AT;
    const m = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(inMinutes * (slow ? 2 : 1))));
    const nextAt = new Date(Date.now() + m * 60_000).toISOString();
    const b = this.hub.store.background(agentId, userId);
    if (b) this.hub.store.setBackground(agentId, userId, { nextAt, nextReason: reason.slice(0, 300) });
    const agent = this.hub.store.agent(agentId);
    if (agent) this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
    return { nextAt, minutes: m, on: !!b?.enabled };
  }

  /**
   * A check ended: keep the agent's note to itself; nothing is posted. Checks that keep saying nothing
   * (no message to anyone, no follow-up due, and the person hasn't written since the check before)
   * double the usual wait from the second in a row, up to BACKOFF_CEILING_MINUTES; anything else starts
   * the pace over. Only the usual wait stretches: a time the agent picked (next_check) stands.
   */
  finished(run: { id: string; agentId: string; requestedBy: string | null; channelId?: string }, note: string, at = new Date()) {
    const followups = this.pendingFollowups.get(run.id)?.length ?? 0;
    this.pendingFollowups.delete(run.id);
    this.hub.watches.delivered(run.id);
    const { store } = this.hub;
    const agent = store.agent(run.agentId);
    if (!agent || !run.requestedBy) return;
    const b = store.background(run.agentId, run.requestedBy);
    const quiet = !followups && this.wasQuiet(run.id, run.agentId, run.requestedBy);
    this.hub.watches.checked(run.id, quiet);
    if (b) {
      const streak = quiet ? Math.min(MAX_QUIET_STREAK, b.quietStreak + 1) : 0;
      const patch: Parameters<typeof store.setBackground>[2] = { lastNote: note.trim().slice(0, 2000), quietStreak: streak };
      // one quiet check is normal; from the second in a row the wait doubles each time
      if (streak > 1 && this.onUsualPace(b)) {
        const from = new Date(b.lastAt!).getTime();
        const later = new Date(from + Math.min(Math.max(b.everyMinutes, BACKOFF_CEILING_MINUTES), b.everyMinutes * 2 ** (streak - 1)) * 60_000);
        if (!b.nextAt || later > new Date(b.nextAt)) Object.assign(patch, { nextAt: later.toISOString(), nextReason: QUIET_LATELY });
      }
      store.setBackground(run.agentId, run.requestedBy, patch);
    }
    this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId: agent.id });
    this.warnIfClimbing(agent.workspaceId, run.requestedBy, at);
  }

  /**
   * Tell the person once a day, in plain words, when background work is on pace to use up their allowance
   * well before the day ends: a status line in the chat with the agent that used the most. Not during
   * their quiet hours; it says again the next day if it's still true.
   */
  warnIfClimbing(workspaceId: string, userId: string, at = new Date()) {
    const { store } = this.hub;
    const a = this.allowance(workspaceId, userId, at);
    if (!a.dailyTokens || a.todayTokens < a.dailyTokens * WARN_FROM_SHARE || !a.agents.length) return;
    const tz = this.timezone(userId);
    const day = dayOf(at, tz);
    const key = `usage-warned:${userId}`;
    if (store.setting(workspaceId, key) === day) return;
    // tokens in the last hour, and what that pace adds up to by midnight
    const hour = store.backgroundRunsFor(workspaceId, userId, new Date(at.getTime() - 3_600_000).toISOString()).reduce((n, r) => n + (r.tokens ?? ESTIMATED_CHECK_TOKENS), 0);
    const left = a.dailyTokens - a.todayTokens;
    const end = startOfDay(at, tz, 1).getTime();
    if (left > 0 && hour * ((end - at.getTime()) / 3_600_000) < left) return;
    const top = store.agent(a.agents[0].agentId);
    if (!top) return;
    const b = store.background(top.id, userId);
    if (b && inQuietHours(at, tz, b.quietStart, b.quietEnd)) return;
    store.setSetting(workspaceId, key, day);
    const share = Math.min(100, Math.round((a.todayTokens / a.dailyTokens) * 100));
    const runsOut = left > 0 && hour > 0 ? new Date(at.getTime() + (left / hour) * 3_600_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : null;
    const most = a.agents.length > 1 ? `, most of it by ${top.name}` : "";
    const text = left <= 0
      ? `Background work used all of today's allowance${most}. Checks wait until tomorrow; you can raise it in Settings → Usage.`
      : `Background work used ${share}% of today's allowance already${most}. At this pace it runs out around ${runsOut}, and then checks wait until tomorrow. You can change it in Settings → Usage, or ask ${top.name} to check less often.`;
    const channel = store.dmChannel(workspaceId, userId, top.id);
    const msg = store.insertMessage({ channelId: channel.id, threadId: null, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "status", text }], hop: 0 });
    this.hub.broadcast(workspaceId, { type: "message", message: msg }, this.hub.audience(channel.id));
  }

  /** Is the next check still the one `started` set? If it's anything else, the agent or the person chose it. */
  private onUsualPace(b: BackgroundWork) {
    if (!b.lastAt || !b.nextAt) return false;
    const wait = new Date(b.nextAt).getTime() - new Date(b.lastAt).getTime();
    return wait === b.everyMinutes * 60_000 || wait === b.everyMinutes * 2 * 60_000;
  }

  /** Something urgent the hub can see: a task waiting on the agent, an answer to its approval, or (when it had nothing to watch) something to watch now. */
  private waitIsOver(b: BackgroundWork) {
    const { store } = this.hub;
    if (store.db.prepare("SELECT 1 FROM tasks WHERE to_agent_id = ? AND status IN ('open','in_progress') LIMIT 1").get(b.agentId)) return true;
    if (b.lastAt && store.db.prepare("SELECT 1 FROM approvals WHERE agent_id = ? AND status != 'pending' AND decided_at > ? LIMIT 1").get(b.agentId, b.lastAt)) return true;
    return b.nextReason === NOTHING_TO_WATCH && this.blindSources(b.agentId, b.userId).length > 0;
  }

  /** The check posted nothing anywhere, a task isn't waiting on the agent, and the person hasn't written to the agent since the check before it. */
  private wasQuiet(runId: string, agentId: string, userId: string) {
    const { db } = this.hub.store;
    const started = (db.prepare("SELECT created_at AS at FROM runs WHERE id = ?").get(runId) as { at: string } | undefined)?.at;
    if (!started) return false;
    const spoke = db.prepare("SELECT 1 FROM messages WHERE author_kind = 'agent' AND author_id = ? AND created_at >= ? AND (thread_id IS NULL OR thread_id != ?) LIMIT 1").get(agentId, started, BACKGROUND_THREAD);
    if (spoke) return false;
    if (db.prepare("SELECT 1 FROM tasks WHERE to_agent_id = ? AND status IN ('open','in_progress') LIMIT 1").get(agentId)) return false;
    const before = (db.prepare("SELECT created_at AS at FROM runs WHERE agent_id = ? AND kind = 'background' AND requested_by = ? AND created_at < ? AND status != 'queued' ORDER BY created_at DESC LIMIT 1").get(agentId, userId, started) as { at: string } | undefined)?.at;
    // the first check has nothing to compare with
    if (!before) return false;
    const agent = this.hub.store.agent(agentId);
    const dm = agent && this.hub.store.dmChannel(agent.workspaceId, userId, agentId);
    const wrote = dm && db.prepare("SELECT 1 FROM messages WHERE channel_id = ? AND author_kind = 'user' AND author_id = ? AND created_at >= ? LIMIT 1").get(dm.id, userId, before);
    return !wrote;
  }

  /** The person wrote to the agent: checks go back to the usual pace. */
  heardFrom(agentId: string, userId: string, at = new Date()) {
    const { store } = this.hub;
    const b = store.background(agentId, userId);
    if (!b?.enabled || (!b.quietStreak && b.nextReason !== NOTHING_TO_WATCH)) return;
    const soon = new Date(at.getTime() + b.everyMinutes * 60_000);
    // only a stretched or skipped wait is pulled in: a time the agent picked stands
    const stretched = b.nextReason === QUIET_LATELY || b.nextReason === NOTHING_TO_WATCH;
    const sooner = stretched && (!b.nextAt || soon < new Date(b.nextAt));
    store.setBackground(agentId, userId, { quietStreak: 0, ...(sooner ? { nextAt: soon.toISOString(), nextReason: "" } : {}) });
    const agent = store.agent(agentId);
    if (agent) this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
  }

  /**
   * What only a model can look at for this person: connected apps with no watch on them (Wisp can't see
   * when those change), and the agent's computer unless a website watch already covers what it looks at
   * there. Apps and sites with a watch don't count: the watch wakes the agent when they change.
   */
  blindSources(agentId: string, userId: string | null): string[] {
    const agent = this.hub.store.agent(agentId);
    if (!agent) return [];
    const watched = userId ? this.hub.watches.active(agentId, userId) : [];
    const covered = (c: { id: string; catalogId?: string | null }) => watched.some((w) => w.connectorId === c.id || (!!c.catalogId && watcherFor(w.service)?.catalogIds.includes(c.catalogId)));
    const out = this.hub.connectors.forAgent(agentId).filter((c) => !covered(c)).map((c) => c.name);
    if (agent.computerId && !watched.some((w) => w.service === "browser")) out.push("its computer");
    return out;
  }

  /**
   * Anything a check could find: apps or a computer only a model can look at, tasks waiting on it, or
   * notes it can read (beyond its own) that changed since its last check. Notes alone don't count
   * otherwise: they only change inside Wisp.
   */
  hasSomethingToWatch(agentId: string, since: string | null = null, userId: string | null = null) {
    const { store, access } = this.hub;
    const agent = store.agent(agentId);
    if (!agent) return false;
    if (this.blindSources(agentId, userId).length) return true;
    if (store.db.prepare("SELECT 1 FROM tasks WHERE to_agent_id = ? AND status IN ('open','in_progress') LIMIT 1").get(agentId)) return true;
    if (!since) return false;
    const after = new Date(since).getTime();
    const can = access.checker(agent.workspaceId, access.agentViewer(agent));
    return this.hub.vault(agent.workspaceId).list().some((n) => n.updatedAt > after && !n.path.startsWith(`agents/${agentId}/`) && can(n.path).level !== "none");
  }

  /**
   * Everything the agent can look at for someone: the apps it's connected to, its computer, the
   * memory folders it can read, and Wisp itself. Shown on its Background tab and in each check.
   */
  sources(agentId: string): BackgroundSource[] {
    const { store, access } = this.hub;
    const agent = store.agent(agentId);
    if (!agent) return [];
    const vault = this.hub.vault(agent.workspaceId);
    const out: BackgroundSource[] = [];
    const connectors = this.hub.connectors.forAgent(agentId);
    for (const c of connectors) out.push({ kind: "app", name: c.name, detail: CONNECTOR_CATALOG.find((x) => x.id === c.catalogId)?.description ?? "an app connected through MCP" });
    const computer = agent.computerId ? store.computer(agent.computerId) : undefined;
    if (computer) out.push({ kind: "computer", name: computer.name, detail: "its computer: websites signed in on its browser, and the files on it" });
    // top-level memory folders it can read (its own folder counts once, as "me/")
    const can = access.checker(agent.workspaceId, access.agentViewer(agent));
    const folders = new Set<string>();
    for (const n of vault.list()) {
      const parts = n.path.split("/");
      const folder = parts[0] === "agents" || parts[0] === "people" || parts[0] === "teams" ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : "";
      if (folder && !folders.has(folder) && folder !== `agents/${agentId}` && can(n.path).level !== "none") folders.add(folder);
    }
    for (const f of [...folders].sort().slice(0, 20)) out.push({ kind: "memory", name: `${f}/`, detail: "notes in Wisp's memory" });
    return out;
  }

  /** Where the agent keeps its notes for checks for one person: where it left off in each source. */
  watchNotesPath(agentId: string, userId: string) {
    return `agents/${agentId}/background/${userId}.md`;
  }

  /** What a background check is about, for the prompt: replaces "where you are" and the new message. */
  async promptSection(run: { id: string; agentId: string; channelId: string; requestedBy: string | null }): Promise<string> {
    const { store } = this.hub;
    const agent = store.agent(run.agentId)!;
    const user = run.requestedBy ? store.user(run.requestedBy) : undefined;
    const name = user ? user.preferredName || user.name : "the person you work for";
    const b = user ? store.background(agent.id, user.id) : undefined;
    const followups = this.pendingFollowups.get(run.id) ?? [];
    const tz = user ? this.timezone(user.id) : "UTC";
    const quiet = b && inQuietHours(new Date(), tz, b.quietStart, b.quietEnd);
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
    const latestRun = store.db.prepare("SELECT status FROM runs WHERE trigger_message_id = ? OR thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
    const stopped = (messageId: string | null) => !!messageId && (latestRun.get(messageId, messageId) as { status: string } | undefined)?.status === "cancelled";
    const dm = store.messages(run.channelId, { limit: 20 }).filter((m) => m.author.id !== "system" && !stopped(m.id) && !stopped(m.threadId));
    const tasks = store.tasks(agent.workspaceId, { agentId: agent.id }).filter((t) => (t.status === "open" || t.status === "in_progress") && !stopped(t.threadId)).slice(0, 15);
    const later = store.pendingFollowups(agent.id).filter((f) => f.kind === "followup" && (!f.userId || f.userId === user?.id));
    const sources = this.sources(agent.id);
    const notesPath = user ? this.watchNotesPath(agent.id, user.id) : null;
    const notes = notesPath ? await this.hub.vault(agent.workspaceId).read(notesPath).then((n) => n.content.trim(), () => "") : "";
    const sourceLine = (x: BackgroundSource) => `- ${x.kind === "app" ? `${x.name} (connected app: ${x.detail})` : x.kind === "computer" ? `${x.name}, ${x.detail}` : `${x.name} (memory folder)`}`;
    const approvals = store.db.prepare("SELECT summary, created_at AS createdAt FROM approvals WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10").all(agent.id) as { summary: string; createdAt: string }[];
    const watched = this.hub.watches.promptLines(run, name, fmt);
    const woken = this.hub.watches.eventsForRun(run.id).length > 0;

    return [
      `\n## Working in the background`,
      `Nobody messaged you. You're checking in on your own for ${name}, the way a good assistant keeps an eye on things for someone.`,
      `A request whose run the person stopped or cancelled is finished, even if it has no answer. Don't retry it, hand it to another agent, or do it yourself unless the person asks again.`,
      followups.length
        ? `${followups.length === 1 ? "Something is" : "Some things are"} due now:\n${followups.map((f) => this.hub.loops.describe(f, name)).join("\n")}`
        : woken
          ? `Something changed in what you watch for ${name} (below).`
          : `This is a regular check.${b?.lastAt ? ` Your last one started ${fmt(b.lastAt)}.` : ""}`,
      b?.lastNote ? `Your note to yourself from last time: ${b.lastNote}` : "",
      ...watched,
      `\nWhat you can look at:`,
      ...sources.map(sourceLine),
      `- Wisp itself: your tasks and approvals (below), channels you're in (chat_read), files people shared (file_view), and what you know about ${name} (above).`,
      sources.some((x) => x.kind === "app")
        ? ""
        : `You aren't connected to any apps yet (email, calendar, drive, project tools…). If ${name} seems to expect you to watch something you can't reach, tell them once which connection would let you (Connectors in Wisp), not on every check.`,
      b?.focus ? `\n${name} asked you to keep an eye on: ${b.focus}\nStart there, then look at the rest.` : `\n${name} hasn't said what matters most, so keep an eye on all of it.`,
      `Go through each source and look for what's new or changed since your last check, and what's coming up. Then decide whether any of it needs ${name} now: something to do, answer, decide or get ready for; something they'd want to know; a problem, conflict or risk; a change to something they care about; or something you said you'd follow up on.`,
      notesPath
        ? `\nYour watch notes (${notesPath.replace(`agents/${agent.id}/`, "me/")}) are your working memory for these checks: for each source, where you left off (the latest thing you've seen) and what you're keeping track of. Read them before you look, and update them with memory_write before you finish.${notes ? `\nThey say now:\n${notes.length > 6000 ? notes.slice(0, 6000) + "\n…(read the rest with memory_read)" : notes}` : " You haven't written any yet: start them this time."}`
        : "",
      `- If something does, tell them with message_person: short, specific, and readable on a phone's lock screen; when they'd answer in a few words, add 2–4 quick replies. If you can do the work, do it first (write the draft, find the answer), then show it. Before sending, buying or deleting anything for them, ask with approval_request and include the draft.`,
      `- If nothing does, don't message. Saying nothing is usually right. Never message just to say you checked, and don't repeat what you already told them unless it's become urgent.`,
      user && this.allowanceShare(agent.workspaceId, user.id) >= SLOW_DOWN_AT ? `- Most of ${name}'s daily allowance for background work is used. Keep this check short: look only at what matters most.` : "",
      quiet ? `- It's quiet hours for ${name} (${b!.quietStart}–${b!.quietEnd}). Only message for something that can't wait until morning.` : "",
      `- If you need to look again at a particular time, call next_check with when and why: soon (10–30 minutes) while something is moving, like waiting on a reply. If it's calm, don't call it: checks slow down by themselves while nothing's happening. For a set time ("8am tomorrow, before the assignment is due"), use followup_set.`,
      `Your final reply isn't posted anywhere. Make it a one-line note to yourself about what you looked at and decided; you'll see it next time.`,
      tasks.length ? `\nYour open tasks:\n${tasks.map((t) => `- ${t.title} (${t.status.replace("_", " ")})`).join("\n")}` : "",
      approvals.length ? `\nStill waiting for an OK on:\n${approvals.map((a) => `- ${a.summary} (asked ${fmt(a.createdAt)})`).join("\n")}` : "",
      later.length ? `\nFollow-ups you've set:\n${later.map((f) => `- ${f.id} ${fmt(f.dueAt)}: ${f.label ? `${f.label} (${f.note})` : f.note}`).join("\n")}` : "",
      dm.length ? `\nYour recent conversation with ${name} (your DM):\n${dm.map((m) => `${this.hub.displayName(m.author)}: ${this.hub.historyLine(m)}`).join("\n")}` : `\nYou haven't talked with ${name} in your DM yet.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * A time an agent gave for a follow-up: ISO with an offset ("2026-10-15T08:00:00-04:00") is taken
 * as is; a local one ("2026-10-15 08:00" or "2026-10-15T08:00") is on the person's clock.
 */
export function parseWhen(when: string, timeZone: string): Date | null {
  const s = when.trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d?):(\d\d)(?::\d\d)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  // start from the clock time read as UTC, then correct by the zone's offset (twice, for DST edges)
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const seen = Date.UTC(y, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(y, mo - 1, d, h, mi) - seen;
  }
  return new Date(t);
}
