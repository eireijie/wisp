import type { ChatLoop, Followup, MessagePart, WrapUp } from "@wisp/core";
import { afterQuietHours, inQuietHours } from "./background.ts";
import type { Hub } from "./hub.ts";

/** When a chat waits on the person and they go quiet, the first check-back comes this much later. */
export const FIRST_CHECKBACK_MINUTES = 180;
/** The second check-back, where the agent lets it go, comes a day after the first. */
export const LAST_CHECKBACK_MINUTES = 24 * 60;
/** One check-back that asks again, then one that drops it. */
export const MAX_CHECKBACKS = 2;

/**
 * Open loops and promises in a chat: where a DM stands (chat_status), the follow-ups shown under
 * the reply that set them, Wisp checking back when a chat stops while it waits on the person, and
 * the wrap-up when it's done.
 */
export class Loops {
  /** what a run said about its chat, waiting for the reply it belongs under */
  private pending = new Map<string, MessagePart[]>();
  /** the last message_person message of a background run, for runs that post no reply of their own */
  private written = new Map<string, string>();

  constructor(private hub: Hub) {}

  /** The agent said where its DM stands. */
  setStatus(run: { id: string; agentId: string; channelId: string; requestedBy: string | null }, s: { status: ChatLoop["status"]; summary?: string; wrap?: Partial<WrapUp>; checkBackInMinutes?: number }): ChatLoop | { error: string } {
    const { store } = this.hub;
    const channel = store.channel(run.channelId);
    if (channel?.kind !== "dm" || !run.requestedBy) return { error: "chat_status is for your DM with the person you work for" };
    const was = store.chatLoop(channel.id);
    const summary = s.summary?.trim().slice(0, 200) || (s.status === "waiting" || s.status === "closed" ? was?.summary ?? "" : "");
    // a new "waiting" after the person wrote again starts over; one the agent repeats after a check-back keeps counting
    const loop = store.setChatLoop({ channelId: channel.id, agentId: run.agentId, userId: run.requestedBy, status: s.status, summary, nudges: s.status === "waiting" ? was?.nudges ?? 0 : 0 });
    this.cancelCheckbacks(channel.id);
    if (s.status === "waiting" && loop.nudges < MAX_CHECKBACKS) this.scheduleCheckback(loop, loop.nudges === 0 ? s.checkBackInMinutes ?? FIRST_CHECKBACK_MINUTES : LAST_CHECKBACK_MINUTES);
    const wrap = { did: s.wrap?.did?.trim() ?? "", saved: s.wrap?.saved?.trim() ?? "", next: s.wrap?.next?.trim() ?? "" };
    if (s.status === "done" && (wrap.did || wrap.saved || wrap.next)) this.queue(run.id, { type: "wrapup", ...wrap });
    if (s.status === "closed") this.queue(run.id, { type: "closed" });
    this.changed(loop);
    return loop;
  }

  /** The person wrote in a DM: a chat that waited on them is open again, and its check-backs are off. */
  personWrote(channelId: string) {
    const loop = this.hub.store.chatLoop(channelId);
    if (!loop || (loop.status !== "waiting" && loop.status !== "closed")) return;
    this.cancelCheckbacks(channelId);
    this.changed(this.hub.store.setChatLoop({ ...loop, status: "open", nudges: 0 }));
  }

  /** Follow-ups woke a check: keep their pills current and count check-backs, dropping the chat after the last one. */
  fired(followups: Followup[], runId: string) {
    const { store } = this.hub;
    for (const f of followups) {
      this.refreshPill(f.id);
      if (f.kind !== "checkback" || !f.channelId) continue;
      const loop = store.chatLoop(f.channelId);
      if (!loop || loop.status !== "waiting") continue;
      const nudges = loop.nudges + 1;
      if (nudges >= MAX_CHECKBACKS) {
        this.changed(store.setChatLoop({ ...loop, status: "closed", nudges }));
        this.queue(runId, { type: "closed" });
      } else {
        const next = store.setChatLoop({ ...loop, nudges });
        this.scheduleCheckback(next, LAST_CHECKBACK_MINUTES);
      }
    }
  }

  /** What a follow-up asks of the agent when it comes due, for a background check's prompt. */
  describe(f: Followup, name: string): string {
    if (f.kind === "checkback") {
      const loop = f.channelId ? this.hub.store.chatLoop(f.channelId) : undefined;
      const what = loop?.summary || f.note;
      return loop?.status === "closed"
        ? `- Your check-back on "${what}" went unanswered. Tell ${name} with message_person, in one short line, that you're dropping it for now and they can say the word to pick it back up. Don't ask again.`
        : `- Check back on "${what}": the chat stopped while it waited on ${name}. Look first (their sent mail, the file, the calendar) in case it already happened; if it did, don't write, call chat_status with "done". Otherwise ask where it stands with message_person, in one or two short sentences, offering to do the next step for them, with 2–4 quick replies.`;
    }
    const what = f.label ? `${f.label} (${f.note})` : f.note;
    return f.waitingOn === "person"
      ? `- ${name} said they'd do this: ${what}${f.condition ? `. Only if ${f.condition.replace(/^only if /i, "")}` : ""}. Look whether it happened first; if it did, don't write. If not, nudge them with message_person: short, offering to help, with 2–4 quick replies.`
      : `- ${what}. Do what you said you'd do, then tell ${name} how it went with message_person.`;
  }

  /** For a reply in a DM: how to keep track of promises and where the chat stands, and what's open now. */
  promptSection(agentId: string, channelId: string, userId: string, name: string): string {
    const { store } = this.hub;
    const tz = store.user(userId)?.timezone || "UTC";
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
    const open = store.pendingFollowups(agentId).filter((f) => f.kind === "followup" && (!f.userId || f.userId === userId) && (!f.channelId || f.channelId === channelId));
    const loop = store.chatLoop(channelId);
    return [
      `## Keeping track`,
      `- When you promise to come back to something ("I'll look when the build finishes"), when ${name} says they'll do something later ("I'll send it tonight"), or when they mention something worth asking about later ("my interview is Friday"), set it with followup_set: a label they'll see under your reply (2–5 words: "Check the build", "Nudge you about the deck", "Ask how the interview went"), waiting_on "agent" or "person", and when. For their promises, add the condition ("only if it hasn't gone out"). Don't set one for small talk.`,
      `- When this chat's state changes, call chat_status: "waiting" when the next step is ${name}'s (you asked them something, or they owe a step; summary in their words, like "send Sam the deck"), and Wisp checks back for you if they go quiet; "done" when what they asked for is finished (with did, saved and next when real work got done); "open" otherwise.`,
      `- When something you're tracking is done or no longer needed, call followup_cancel (done: true when it happened).`,
      loop && loop.status !== "open" ? `This chat is ${loop.status === "waiting" ? `waiting on ${name}: ${loop.summary}` : loop.status}.` : "",
      open.length ? `You're keeping track of:
${open.map((f) => `- ${f.id}: ${f.label ?? f.note}${f.label ? ` (${f.note})` : ""}, ${fmt(f.dueAt)}${f.waitingOn === "person" ? `, on ${name}` : ""}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A message_person message from a background run: its pills and wrap-up go there when the run posts no reply. */
  wrote(runId: string, messageId: string) {
    this.written.set(runId, messageId);
  }

  /** A run ended: put what it said about its chat (follow-ups, wrap-up) under its reply. */
  runEnded(run: { id: string }, replyId: string | null) {
    const { store } = this.hub;
    const target = replyId ?? this.written.get(run.id) ?? null;
    const parts = this.pending.get(run.id) ?? [];
    this.pending.delete(run.id);
    this.written.delete(run.id);
    const pills = store.unplacedFollowups(run.id).filter((f) => f.label && f.kind === "followup" && f.status === "pending");
    if (!target || (!parts.length && !pills.length)) return;
    for (const f of pills) store.placeFollowup(f.id, target);
    this.updateParts(target, (old) => [...old, ...pills.map((f) => pill(f)), ...parts]);
  }

  /** Show a follow-up's latest time and status under the reply that set it. */
  refreshPill(followupId: string) {
    const f = this.hub.store.followup(followupId);
    if (!f?.messageId || !f.label) return;
    this.updateParts(f.messageId, (old) => old.map((p) => (p.type === "followup" && p.followupId === f.id ? pill(f) : p)));
  }

  /** The DMs a person sees in their chat list: where each stands, and the next thing its agent will come back to. */
  chatList(userId: string, channelIds: string[]) {
    const { store } = this.hub;
    const loops = store.chatLoopsFor(userId, channelIds);
    const next = new Map<string, Followup>();
    if (channelIds.length) {
      const rows = store.db
        .prepare(`SELECT id FROM followups WHERE status = 'pending' AND kind = 'followup' AND waiting_on = 'agent' AND label IS NOT NULL AND (user_id = ? OR user_id IS NULL) AND channel_id IN (${channelIds.map(() => "?").join(",")}) ORDER BY due_at`)
        .all(userId, ...channelIds) as { id: string }[];
      for (const r of rows) {
        const f = store.followup(r.id)!;
        if (!next.has(f.channelId!)) next.set(f.channelId!, f);
      }
    }
    return (channelId: string) => {
      const l = loops[channelId];
      const n = next.get(channelId);
      return {
        loop: l && l.status !== "open" ? { status: l.status, summary: l.summary } : null,
        next: n ? { label: n.label!, dueAt: n.dueAt, waitingOn: n.waitingOn } : null,
      };
    };
  }

  private queue(runId: string, part: MessagePart) {
    this.pending.set(runId, [...(this.pending.get(runId) ?? []).filter((p) => p.type !== part.type), part]);
  }

  private scheduleCheckback(loop: ChatLoop, minutes: number) {
    const { store } = this.hub;
    if (!store.checkbackOn(loop.agentId, loop.userId)) return;
    const tz = store.user(loop.userId)?.timezone || "UTC";
    const b = store.background(loop.agentId, loop.userId);
    const [start, end] = b ? [b.quietStart, b.quietEnd] : ["22:00", "07:00"];
    let due = new Date(Date.now() + Math.min(Math.max(minutes, 10), 7 * 24 * 60) * 60_000);
    if (inQuietHours(due, tz, start, end)) due = afterQuietHours(due, tz, start, end);
    store.createFollowup({ agentId: loop.agentId, userId: loop.userId, dueAt: due.toISOString(), note: `Check back on: ${loop.summary || "the open question in your DM"}`, kind: "checkback", waitingOn: "person", channelId: loop.channelId });
  }

  private cancelCheckbacks(channelId: string) {
    this.hub.store.db.prepare("UPDATE followups SET status = 'cancelled' WHERE channel_id = ? AND kind = 'checkback' AND status = 'pending'").run(channelId);
  }

  private updateParts(messageId: string, change: (parts: MessagePart[]) => MessagePart[]) {
    const { store } = this.hub;
    const msg = store.message(messageId);
    const channel = msg && store.channel(msg.channelId);
    if (!msg || msg.deletedAt || !channel) return;
    const message = { ...msg, parts: change(msg.parts) };
    store.db.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(JSON.stringify(message.parts), message.id);
    this.hub.broadcast(channel.workspaceId, { type: "message_updated", message: store.withReactions([message])[0] }, this.hub.audience(channel.id));
  }

  private changed(loop: ChatLoop) {
    const ws = this.hub.store.agent(loop.agentId)?.workspaceId;
    if (!ws) return;
    this.hub.broadcast(ws, { type: "channels_changed" }, (u) => u === loop.userId);
    this.hub.broadcast(ws, { type: "background_changed", agentId: loop.agentId }, (u) => u === loop.userId);
  }
}

const pill = (f: Followup): MessagePart => ({ type: "followup", followupId: f.id, label: f.label ?? f.note, dueAt: f.dueAt, waitingOn: f.waitingOn, status: f.status });
