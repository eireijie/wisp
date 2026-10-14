import { zonedParts, type Followup } from "@warren/core";
import type { Hub } from "./hub.ts";

/** The device sees background checks as their own conversation, so they don't mix into the DM's. */
export const BACKGROUND_THREAD = "background";
const MIN_MINUTES = 10;
const MAX_MINUTES = 24 * 60;

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

/**
 * Agents working in the background, like a good assistant who keeps an eye on things: every so
 * often (at a pace the agent picks itself) it wakes with no message, looks at what it can reach,
 * and messages the person only when something needs them. Follow-ups are the one-off version:
 * "8am tomorrow, remind Sam the essay is due".
 */
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
      if (this.wake(agentId, userId, list, at)) for (const f of list) store.setFollowupStatus(f.id, "done");
    }
    for (const b of store.activeBackground()) {
      if (b.checking || (b.nextAt && new Date(b.nextAt) > at)) continue;
      const tz = this.timezone(b.userId);
      if (inQuietHours(at, tz, b.quietStart, b.quietEnd)) {
        store.setBackground(b.agentId, b.userId, { nextAt: afterQuietHours(at, tz, b.quietStart, b.quietEnd).toISOString(), nextReason: "after quiet hours" });
        continue;
      }
      this.wake(b.agentId, b.userId, [], at);
    }
  }

  private ownerOf(agentId: string) {
    const agent = this.hub.store.agent(agentId);
    return agent ? (this.hub.store.members(agent.workspaceId).find((m) => m.role === "owner")?.id ?? null) : null;
  }

  private checking(agentId: string, userId: string) {
    return !!this.hub.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND kind = 'background' AND requested_by = ? AND status IN ('queued','running')").get(agentId, userId);
  }

  /** Start a background check for one person, now. Returns the run, or null if it can't start. */
  wake(agentId: string, userId: string, followups: Followup[] = [], at = new Date()): string | null {
    const { store } = this.hub;
    const agent = store.agent(agentId);
    if (!agent || !store.user(userId) || this.hub.whyNotAllowed(agent, userId)) return null;
    if (this.checking(agentId, userId)) return null;
    const channel = store.dmChannel(agent.workspaceId, userId, agentId);
    const runId = store.createRun({ agentId, channelId: channel.id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: userId, kind: "background" });
    this.pendingFollowups.set(runId, followups);
    const b = store.background(agentId, userId);
    // the default pace until the agent says otherwise during the check
    if (b) store.setBackground(agentId, userId, { lastAt: at.toISOString(), nextAt: new Date(at.getTime() + b.everyMinutes * 60_000).toISOString(), nextReason: "" });
    this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
    this.hub.dispatchRun(runId);
    return runId;
  }

  private pendingFollowups = new Map<string, Followup[]>();

  /** The agent picked when to look again (from `next_check`). */
  setNext(agentId: string, userId: string, inMinutes: number, reason: string) {
    const m = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(inMinutes)));
    const nextAt = new Date(Date.now() + m * 60_000).toISOString();
    const b = this.hub.store.background(agentId, userId);
    if (b) this.hub.store.setBackground(agentId, userId, { nextAt, nextReason: reason.slice(0, 300) });
    const agent = this.hub.store.agent(agentId);
    if (agent) this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId });
    return { nextAt, minutes: m, on: !!b?.enabled };
  }

  /** A check ended: keep the agent's note to itself; nothing is posted. */
  finished(run: { id: string; agentId: string; requestedBy: string | null }, note: string) {
    this.pendingFollowups.delete(run.id);
    const agent = this.hub.store.agent(run.agentId);
    if (!agent || !run.requestedBy) return;
    if (this.hub.store.background(run.agentId, run.requestedBy)) this.hub.store.setBackground(run.agentId, run.requestedBy, { lastNote: note.trim().slice(0, 2000) });
    this.hub.broadcast(agent.workspaceId, { type: "background_changed", agentId: agent.id });
  }

  /** What a background check is about, for the prompt: replaces "where you are" and the new message. */
  promptSection(run: { id: string; agentId: string; channelId: string; requestedBy: string | null }): string {
    const { store } = this.hub;
    const agent = store.agent(run.agentId)!;
    const user = run.requestedBy ? store.user(run.requestedBy) : undefined;
    const name = user ? user.preferredName || user.name : "the person you work for";
    const b = user ? store.background(agent.id, user.id) : undefined;
    const followups = this.pendingFollowups.get(run.id) ?? [];
    const tz = user ? this.timezone(user.id) : "UTC";
    const quiet = b && inQuietHours(new Date(), tz, b.quietStart, b.quietEnd);
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
    const dm = store.messages(run.channelId, { limit: 20 }).filter((m) => m.author.id !== "system");
    const tasks = store.tasks(agent.workspaceId, { agentId: agent.id }).filter((t) => t.status === "open" || t.status === "in_progress").slice(0, 15);
    const later = store.pendingFollowups(agent.id).filter((f) => !f.userId || f.userId === user?.id);
    const approvals = store.db.prepare("SELECT summary, created_at AS createdAt FROM approvals WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10").all(agent.id) as { summary: string; createdAt: string }[];

    return [
      `\n## Working in the background`,
      `Nobody messaged you. You're checking in on your own for ${name}, the way a good assistant keeps an eye on things for someone.`,
      followups.length
        ? `You set ${followups.length === 1 ? "a follow-up" : "follow-ups"} for now:\n${followups.map((f) => `- ${f.note} (set for ${fmt(f.dueAt)})`).join("\n")}\nDo what you said you'd do.`
        : `This is a regular check.${b?.lastAt ? ` Your last one started ${fmt(b.lastAt)}.` : ""}`,
      b?.lastNote ? `Your note to yourself from last time: ${b.lastNote}` : "",
      `Look at what you can reach: the apps you're connected to (email, calendar, school or work tools…), what you know about ${name} (plans and due dates above), your open tasks, and your recent conversation with them. Then decide whether anything needs ${name} now. Good reasons: a deadline coming up, something important they haven't seen, a reply they were waiting for, a task that finished or got stuck, something you said you'd follow up on.`,
      `- If something does, tell them with message_person: short, specific, and readable on a phone's lock screen. If you can do the work, do it first (write the draft, find the answer), then show it. Before sending, buying or deleting anything for them, ask with approval_request and include the draft.`,
      `- If nothing does, don't message. Saying nothing is usually right. Never message just to say you checked, and don't repeat what you already told them unless it's become urgent.`,
      quiet ? `- It's quiet hours for ${name} (${b!.quietStart}–${b!.quietEnd}). Only message for something that can't wait until morning.` : "",
      `- Before you finish, call next_check with when to look again and why: soon (10–30 minutes) while something is moving, like waiting on a reply; a few hours when it's calm. For a set time ("8am tomorrow, before the assignment is due"), use followup_set.`,
      `Your final reply isn't posted anywhere. Make it a one-line note to yourself about what you looked at and decided; you'll see it next time.`,
      tasks.length ? `\nYour open tasks:\n${tasks.map((t) => `- ${t.title} (${t.status.replace("_", " ")})`).join("\n")}` : "",
      approvals.length ? `\nStill waiting for an OK on:\n${approvals.map((a) => `- ${a.summary} (asked ${fmt(a.createdAt)})`).join("\n")}` : "",
      later.length ? `\nFollow-ups you've set:\n${later.map((f) => `- ${fmt(f.dueAt)}: ${f.note}`).join("\n")}` : "",
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
