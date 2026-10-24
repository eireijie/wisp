import type { ClientEvent, Message } from "@warren/core";
import type { useStore } from "./store.ts";
import { api } from "./api.ts";
import { href } from "./router.ts";

type State = ReturnType<typeof useStore.getState>;
export interface BuddyNotice {
  id: string;
  agentId: string;
  text: string;
  mood: "done" | "waiting";
  route: string;
}

export const firstLine = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
};
const chat = (channelId: string, threadId: string | null) => href({ view: "chat", channelId, threadId });

/** Only new, person-facing events; loading history never raises a bubble. */
/** `ignoreMute` leaves the channel's mute to `unlessMuted`, which reads it fresh from the hub. */
export function buddyNotice(e: ClientEvent, state: State, selectedId?: string, { ignoreMute = false } = {}): BuddyNotice | null {
  if (!state.me) return null;
  if (e.type === "approval") {
    const a = e.approval;
    if (a.status !== "pending" || state.approvals[a.id]?.status === "pending") return null;
    if (!state.channels.some((c) => c.id === a.channelId && (c.joined || c.kind === "dm"))) return null;
    return { id: `approval:${a.id}`, agentId: a.agentId, text: firstLine(a.summary), mood: "waiting", route: chat(a.channelId, a.threadId) };
  }
  if (e.type === "message") {
    const m = e.message;
    if (m.author.kind !== "agent" || !m.body.trim()) return null;
    const channel = state.channels.find((c) => c.id === m.channelId);
    if (!channel || (!ignoreMute && channel.notify === "mute")) return null;
    const root = m.threadId ? state.roots?.[m.threadId] ?? state.messages[m.channelId]?.find((x) => x.id === m.threadId) : null;
    const toMe = channel?.kind === "dm" || (root?.author.kind === "user" && root.author.id === state.me.user.id);
    if (!toMe && !(m.author.id === selectedId && channel?.joined)) return null;
    // The approval event supplies the actionable bubble for this message.
    if (m.parts.some((p) => p.type === "approval")) return null;
    return { id: `message:${m.id}`, agentId: m.author.id, text: firstLine(m.body), mood: "done", route: chat(m.channelId, m.threadId) };
  }
  return null;
}

/** Buddy windows don't load channel history. Fetch just the thread when its root is missing. */
export async function buddyNoticeWithRoot(e: ClientEvent, state: State, selectedId?: string, opts: { ignoreMute?: boolean } = {}): Promise<BuddyNotice | null> {
  const immediate = buddyNotice(e, state, selectedId, opts);
  if (immediate || e.type !== "message" || e.message.author.kind !== "agent" || !e.message.threadId) return immediate;
  const m = e.message;
  const channel = state.channels.find((c) => c.id === m.channelId);
  if (!channel || (!opts.ignoreMute && channel.notify === "mute") || state.roots?.[m.threadId!] || state.messages[m.channelId]?.some((x) => x.id === m.threadId)) return null;
  try {
    let before = "";
    for (;;) {
      const { messages } = await api<{ messages: Message[] }>("GET", `/api/channels/${encodeURIComponent(m.channelId)}/messages?thread=${encodeURIComponent(m.threadId!)}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      const root = messages.find((x) => x.id === m.threadId);
      if (root) return buddyNotice(e, { ...state, roots: { ...state.roots, [root.id]: root } }, selectedId, opts);
      const oldest = messages[0]?.createdAt;
      if (messages.length < 200 || !oldest || oldest === before) return null;
      before = oldest;
    }
  } catch {
    return null;
  }
}

/**
 * Muting a channel isn't announced to other windows, and the buddy is a window of its own: before
 * a message bubble, read the person's channels again, so muting or unmuting after the buddy
 * started counts. Pair it with `ignoreMute`, so a stale mute can't stop the check from happening.
 */
export async function unlessMuted(n: BuddyNotice | null, e: ClientEvent, channels: () => Promise<{ id: string; notify?: string }[]>): Promise<BuddyNotice | null> {
  if (!n || e.type !== "message") return n;
  try {
    return (await channels()).find((c) => c.id === e.message.channelId)?.notify === "mute" ? null : n;
  } catch {
    return n; // the hub is unreachable for a moment: the bubble still says something new arrived
  }
}

export interface BuddyTask {
  id: string;
  title: string;
  status: string;
  from: { kind: string; id: string };
  toAgentId: string;
  channelId: string | null;
  threadId: string | null;
  result: string | null;
}

/** A baseline prevents old completions from appearing on launch or reconnection. */
export function completedTasks(tasks: BuddyTask[], previous: Map<string, string>, userId: string): BuddyNotice[] {
  const notices: BuddyNotice[] = [];
  for (const t of tasks) {
    const was = previous.get(t.id);
    if (t.status === "done" && was && was !== "done" && t.from.kind === "user" && t.from.id === userId)
      notices.push({ id: `task:${t.id}`, agentId: t.toAgentId, text: firstLine(t.result || `Finished: ${t.title}`), mood: "done", route: t.channelId ? chat(t.channelId, t.threadId) : href({ view: "tasks" }) });
    previous.set(t.id, t.status);
  }
  return notices;
}
