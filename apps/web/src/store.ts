import { useMemo } from "react";
import { create } from "zustand";
import { channelTeams, type Agent, type AgentEvent, type Approval, type Channel, type ChannelNotify, type ClientEvent, type Computer, type Discussion, type Features, type Message, type LeadStatus, type ModelLogin, type Reaction, type Section, type Team, type User, type UserPrefs } from "@wisp/core";
import { api } from "./api.ts";
import { notifyOn } from "./notifications.ts";
import { agentColor } from "./components/ui.tsx";
import { listOrgs, type Org } from "./orgs.ts";

export interface Me {
  kind: "user";
  user: User;
  /** how Wisp behaves for this person, on every device (Settings → Preferences) */
  prefs: UserPrefs;
  role: "owner" | "member" | "guest";
  workspace: { id: string; name: string };
  /** the organization's optional features (features.ts); missing from older hubs, which means all on */
  features?: Features;
}

/** A discussion plus who has answered in its current round. */
export type DiscussionInfo = Discussion & { progress: { agentId: string; status: string }[] };

/** Every channel's team: a channel is the only kind of team. */
export function useTeams(): Team[] {
  const channels = useStore((s) => s.channels);
  return useMemo(() => channelTeams(channels), [channels]);
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
}

/** A channel as the sidebar sees it: membership, size and your read state. */
export interface ChannelInfo extends Channel {
  joined: boolean;
  memberCount: number;
  /** the agents in it, in the order they joined (the first few); missing from older hubs */
  agentIds?: string[];
  /** new top-level messages since you last read; always 0 for a channel you muted */
  unread: number;
  lastReadAt: string | null;
  /** your own settings for it */
  notify: ChannelNotify;
  starred: boolean;
  /** the newest top-level message: the chats list's preview and what it sorts by (missing from older hubs) */
  last?: { at: string; body: string; author: { kind: string; id: string } } | null;
  /** pinned messages, newest pin first */
  pinnedIds: string[];
  /** a DM: whether it waits on you (or was finished or dropped), as its agent last said */
  loop?: { status: "waiting" | "done" | "closed"; summary: string } | null;
  /** a DM: the next thing its agent said it'd come back to */
  next?: { label: string; dueAt: string; waitingOn: "agent" | "person" } | null;
}

/** What an agent is doing right now, built from streamed run events. */
export interface LiveRun {
  runId: string;
  agentId: string;
  channelId: string;
  /** the thread it works in (null at the top of the channel), and the threads above that one, outermost first */
  threadId: string | null;
  threadPath: string[];
  text: string;
  tools: string[];
  /** the latest tool call with its input, for "Sending to @chief…" */
  last: { name: string; input: unknown } | null;
  /** the run has used its computer */
  usedComputer: boolean;
}

/** A computer as the API returns it: who's on it, whether its device is online, how to watch it. */
export type ComputerInfo = Computer & {
  online: boolean;
  /** a device's own screen: whose it is (nobody else sees it) */
  ownerId: string | null;
  /** its device was paused there */
  paused: boolean;
  /** a device's own screen that opens with the code picked at the device */
  code: "pin" | "password" | null;
  transport: "vnc" | "frames";
  agents: string[];
  activity: { agentId: string; text: string; at: string } | null;
};

interface State {
  me: Me | null;
  connected: boolean;
  channels: ChannelInfo[];
  sections: Section[];
  agents: Agent[];
  members: Member[];
  discussions: Record<string, DiscussionInfo>;
  messages: Record<string, Message[]>; // top-level by channel
  threads: Record<string, Message[]>; // replies by thread root id
  threadChannels: Record<string, string>; // channel for each loaded thread, even an empty one
  replyCounts: Record<string, number>;
  /** thread roots as loaded with their thread (a sub-thread's root is a reply in another thread) */
  roots: Record<string, Message>;
  hasEarlier: Record<string, boolean>;
  loadErrors: Record<string, { message: string; earlier: boolean } | null>;
  loadingMessages: Record<string, boolean>;
  removedRoots: Record<string, boolean>;
  live: Record<string, LiveRun>; // by runId
  computers: ComputerInfo[];
  approvals: Record<string, Approval>;
  /** bumps when routines change, so open lists refetch */
  routinesVersion: number;
  /** bumped when an agent's background work or follow-ups change */
  backgroundVersion: number;
  /** bumps when an agent changes a setting or mod for someone, or someone undoes one */
  changesVersion: number;
  /** bumps when tasks change, so the Tasks page refetches */
  tasksVersion: number;
  /** bumps when a stepped team's request moves on */
  flowsVersion: number;
  /** bumps when notes change outside Wisp, so Memory reloads */
  memoryVersion: number;
  /** bumps when the person's model connections change (added, renamed, removed, renewed, new plan usage) */
  modelsVersion: number;
  /** bumped when skills or connectors change on the hub (an agent learned one, someone switched who has it) */
  skillsVersion: number;
  /** model sign-ins this person started, as the hub reports them on the socket */
  modelLogins: Record<string, ModelLogin>;
  /** the New task dialog is open */
  newTaskOpen: boolean;
  /** the New chat picker (the + menu, ⌘K) is open */
  newChatOpen: boolean;
  /** who takes tasks nobody assigned, and the lead an owner picked (if any); null until loaded */
  lead: LeadStatus | null;
  activeChannel: string | null;
  paletteOpen: boolean;
  /** text to start the ⌘K search with (the chats list's search field hands its text over) */
  paletteSeed: string;
  /** every organization you're in; null until loaded. A hub without organizations gives just this one. */
  orgs: Org[] | null;
  /** the New agent screen should open (sidebar +, ⌘K); the Agents page picks it up */
  newAgentOpen: boolean;
  /** the channel browser is open, adding to this section (or none) */
  channelBrowser: { sectionId: string | null; create?: boolean } | null;

  load(): Promise<void>;
  loadChannel(id: string): Promise<void>;
  loadThread(channelId: string, rootId: string): Promise<void>;
  loadEarlier(channelId: string, threadId?: string): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshComputers(): Promise<void>;
  refreshLead(): Promise<void>;
  refreshOrgs(): Promise<void>;
  loadApproval(id: string): Promise<void>;
  loadDiscussion(id: string): Promise<void>;
  setDiscussion(d: DiscussionInfo): void;
  refreshChannels(): Promise<void>;
  refreshSections(): Promise<void>;
  setActive(id: string | null): void;
  markRead(channelId: string): void;
  toggleReaction(messageId: string, emoji: string): Promise<void>;
  setPalette(open: boolean): void;
  /** change some of your preferences; saved on the hub */
  setPrefs(patch: Partial<UserPrefs>): Promise<void>;
  handle(e: ClientEvent, notify?: boolean): void;
  setConnected(c: boolean): void;
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Your preferences (Settings → Preferences), with defaults. */
export function usePrefs(): Required<UserPrefs> {
  const p = useStore((s) => s.me?.prefs);
  return { sendWith: p?.sendWith ?? "enter", clock: p?.clock ?? "auto", toolCalls: p?.toolCalls ?? "collapsed", experience: p?.experience ?? "advanced" };
}

export const useStore = create<State>((set, get) => ({
  me: null,
  connected: false,
  channels: [],
  sections: [],
  agents: [],
  members: [],
  discussions: {},
  messages: {},
  threads: {},
  threadChannels: {},
  replyCounts: {},
  roots: {},
  hasEarlier: {},
  loadErrors: {},
  loadingMessages: {},
  removedRoots: {},
  live: {},
  computers: [],
  approvals: {},
  routinesVersion: 0,
  backgroundVersion: 0,
  changesVersion: 0,
  tasksVersion: 0,
  flowsVersion: 0,
  memoryVersion: 0,
  modelsVersion: 0,
  skillsVersion: 0,
  modelLogins: {},
  newTaskOpen: false,
  newChatOpen: false,
  lead: null,
  activeChannel: null,
  paletteOpen: false,
  paletteSeed: "",
  orgs: null,
  newAgentOpen: false,
  channelBrowser: null,

  async load() {
    const [me, channels, sections, agents, members] = await Promise.all([
      api<Me>("GET", "/api/me"),
      api<ChannelInfo[]>("GET", "/api/channels"),
      api<Section[]>("GET", "/api/sections"),
      api<Agent[]>("GET", "/api/agents"),
      api<Member[]>("GET", "/api/members"),
    ]);
    set({ me, channels, sections, agents, members });
    get().refreshComputers();
    get().refreshLead();
    get().refreshOrgs();
    api<Approval[]>("GET", "/api/approvals?status=pending").then((list) => set((s) => ({ approvals: { ...s.approvals, ...Object.fromEntries(list.map((a) => [a.id, a])) } })), () => {});
  },

  async refreshOrgs() {
    const list = await listOrgs();
    const { me, members, agents } = get();
    if (list && list.length) return set({ orgs: list });
    // no organizations on this hub (or it couldn't say): just the one you're in
    if (me) set({ orgs: [{ id: me.workspace.id, name: me.workspace.name, role: me.role, members: Math.max(1, members.length), agents: agents.length, current: true, unread: false }] });
  },

  async refreshLead() {
    set({ lead: await api<LeadStatus>("GET", "/api/settings/lead").catch(() => get().lead) });
  },

  async refreshComputers() {
    // guests don't see computers; a hub older than this page has none
    if (get().me?.role === "guest") return set({ computers: [] });
    set({ computers: await api<ComputerInfo[]>("GET", "/api/computers").catch(() => get().computers) });
  },

  async loadApproval(id) {
    const a = await api<Approval>("GET", `/api/approvals/${id}`).catch(() => null);
    if (a) set((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
  },

  async loadChannel(id) {
    await loadMessages(id);
  },

  async loadThread(channelId, rootId) {
    set((s) => ({ threadChannels: { ...s.threadChannels, [rootId]: channelId } }));
    await loadMessages(channelId, rootId);
  },

  async loadEarlier(channelId, threadId) {
    await loadMessages(channelId, threadId, true);
  },

  async refreshAgents() {
    set({ agents: await api<Agent[]>("GET", "/api/agents") });
    // with no lead picked, the lead is worked out from the agents and teams
    get().refreshLead();
  },

  async loadDiscussion(id) {
    const d = await api<DiscussionInfo>("GET", `/api/discussions/${id}`).catch(() => null);
    if (d) get().setDiscussion(d);
  },

  setDiscussion(d) {
    set((s) => ({ discussions: { ...s.discussions, [d.id]: d } }));
  },

  async refreshChannels() {
    const list = await api<ChannelInfo[]>("GET", "/api/channels");
    // a read we haven't sent yet (debounced) or the open channel must not come back as unread
    const { activeChannel, channels } = get();
    set({
      channels: list.map((c) =>
        c.id === activeChannel || readTimers.has(c.id) ? { ...c, unread: 0, lastReadAt: channels.find((x) => x.id === c.id)?.lastReadAt ?? c.lastReadAt } : c.notify === "mute" ? { ...c, unread: 0 } : c,
      ),
    });
  },

  async refreshSections() {
    set({ sections: await api<Section[]>("GET", "/api/sections") });
  },

  setActive(id) {
    set({ activeChannel: id });
    if (id) get().markRead(id);
  },

  /** Clear the unread badge now; tell the hub shortly after (debounced), so it follows you to other devices. */
  markRead(channelId) {
    const at = new Date().toISOString();
    set((s) => ({ channels: s.channels.map((c) => (c.id === channelId ? { ...c, unread: 0, lastReadAt: at } : c)) }));
    clearTimeout(readTimers.get(channelId));
    readTimers.set(
      channelId,
      setTimeout(() => {
        readTimers.delete(channelId);
        api("POST", `/api/channels/${channelId}/read`, {}).catch(() => {});
      }, 800),
    );
  },

  async toggleReaction(messageId, emoji) {
    const r = await api<{ reactions: Reaction[] }>("POST", `/api/messages/${messageId}/reactions`, { emoji });
    set((s) => applyReactions(s, messageId, r.reactions));
  },

  setPalette(open) {
    set({ paletteOpen: open, ...(open ? {} : { paletteSeed: "" }) });
  },

  async setPrefs(patch) {
    const me = get().me;
    if (!me) return;
    const previous = me.prefs;
    set({ me: { ...me, prefs: { ...me.prefs, ...patch } } });
    try {
      const prefs = await api<UserPrefs>("PUT", "/api/me/prefs", patch);
      set((s) => (s.me ? { me: { ...s.me, prefs } } : {}));
    } catch (e) {
      // the hub didn't take it: show what's really saved
      set((s) => (s.me ? { me: { ...s.me, prefs: previous } } : {}));
      throw e;
    }
  },

  setConnected(connected) {
    const wasConnected = get().connected;
    set({ connected });
    // after a reconnect, catch up on anything missed
    if (connected && !wasConnected) {
      const { activeChannel, threadChannels } = get();
      set((s) => ({ live: {}, routinesVersion: s.routinesVersion + 1, backgroundVersion: s.backgroundVersion + 1, changesVersion: s.changesVersion + 1, tasksVersion: s.tasksVersion + 1, flowsVersion: s.flowsVersion + 1, memoryVersion: s.memoryVersion + 1, modelsVersion: s.modelsVersion + 1, skillsVersion: s.skillsVersion + 1 }));
      if (activeChannel) get().loadChannel(activeChannel).catch(() => {});
      for (const [rootId, channelId] of Object.entries(threadChannels)) get().loadThread(channelId, rootId).catch(() => {});
      get().refreshAgents().catch(() => {});
      get().refreshChannels().catch(() => {});
      get().refreshSections().catch(() => {});
      get().refreshComputers().catch(() => {});
      get().refreshOrgs().catch(() => {});
      api<Me>("GET", "/api/me").then((me) => set({ me }), () => {});
      api<Member[]>("GET", "/api/members").then((members) => set({ members }), () => {});
      api<Approval[]>("GET", "/api/approvals").then((list) => set({ approvals: Object.fromEntries(list.map((a) => [a.id, a])) }), () => {});
      api<DiscussionInfo[]>("GET", "/api/discussions").then((list) => set({ discussions: Object.fromEntries(list.map((d) => [d.id, d])) }), () => {});
    }
  },

  handle(e, notify = true) {
    const before = get();
    // features changed for this organization (an owner flipped one in Settings → General → Mods)
    if (e.type === "features") {
      set((s) => (s.me ? { me: { ...s.me, features: e.features } } : {}));
      return;
    }
    if (e.type === "message") {
      const m = e.message;
      // the agent's reply replaces its live preview
      if (m.author.kind === "agent") {
        set((s) => ({ live: Object.fromEntries(Object.entries(s.live).filter(([, r]) => !(r.agentId === m.author.id && r.channelId === m.channelId))) }));
      }
      const known = get().channels.find((c) => c.id === m.channelId);
      if (!known) get().refreshChannels();
      if (m.threadId) {
        set((s) => ({
          threads: s.threads[m.threadId!] ? { ...s.threads, [m.threadId!]: dedupe([...s.threads[m.threadId!], m]) } : s.threads,
          replyCounts: { ...s.replyCounts, [m.threadId!]: (s.replyCounts[m.threadId!] ?? 0) + 1 },
        }));
      } else {
        const mine = m.author.kind === "user" && (m.author.id === get().me?.user.id || m.author.id === "system");
        set((s) => ({
          messages: s.messages[m.channelId] ? { ...s.messages, [m.channelId]: dedupe([...s.messages[m.channelId], m]) } : s.messages,
          channels: s.channels.map((c) => {
            if (c.id !== m.channelId) return c;
            const last = { at: m.createdAt, body: m.body.slice(0, 400), author: m.author };
            return !mine && s.activeChannel !== m.channelId && c.notify !== "mute" ? { ...c, last, unread: c.unread + 1 } : { ...c, last };
          }),
        }));
        if (get().activeChannel === m.channelId && !mine) get().markRead(m.channelId);
      }
    } else if (e.type === "message_updated") {
      const m = e.message;
      // an edit also reaches the quotes of this message and the Chats preview when it is the latest
      const requote = (x: Message): Message => (x.replyTo?.id === m.id && m.body ? { ...x, replyTo: { ...x.replyTo, snippet: m.body.length > 140 ? `${m.body.slice(0, 140)}…` : m.body } } : x);
      const patch = (list: Message[]) => list.map((x) => (x.id === m.id ? m : requote(x)));
      set((s) => ({
        messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, patch(v)])),
        threads: Object.fromEntries(Object.entries(s.threads).map(([k, v]) => [k, patch(v)])),
        roots: s.roots[m.id] ? { ...s.roots, [m.id]: m } : s.roots,
        channels: s.channels.map((c) => (c.id === m.channelId && !m.threadId && c.last?.at === m.createdAt ? { ...c, last: { ...c.last, body: m.body.slice(0, 400) } } : c)),
      }));
    } else if (e.type === "message_removed") {
      const drop = (list: Message[] | undefined) => list?.filter((m) => m.id !== e.messageId);
      // quotes of the removed message say so, and the Chats preview moves on if it showed this one
      const unquote = (x: Message): Message => (x.replyTo?.id === e.messageId ? { ...x, replyTo: { ...x.replyTo, snippet: "", deleted: true } } : x);
      const gone = (get().messages[e.channelId] ?? []).find((m) => m.id === e.messageId);
      const wasPreview = !e.threadId && get().channels.some((c) => c.id === e.channelId && c.last && (!gone || c.last.at === gone.createdAt));
      set((s) => ({
        roots: Object.fromEntries(Object.entries(s.roots).filter(([id]) => id !== e.messageId)),
        removedRoots: { ...s.removedRoots, [e.messageId]: true },
        messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, (k === e.channelId ? drop(v)! : v).map(unquote)])),
        threads: Object.fromEntries(Object.entries(s.threads).map(([k, v]) => [k, (k === e.threadId ? drop(v)! : v).map(unquote)])),
        replyCounts: e.threadId && s.replyCounts[e.threadId] ? { ...s.replyCounts, [e.threadId]: Math.max(0, s.replyCounts[e.threadId] - 1) } : s.replyCounts,
      }));
      if (wasPreview) get().refreshChannels().catch(() => {});
    } else if (e.type === "reactions") {
      set((s) => applyReactions(s, e.messageId, e.reactions));
    } else if (e.type === "channels_changed") {
      get().refreshChannels();
      // with no lead picked, the lead can come from a channel's team
      get().refreshLead();
    } else if (e.type === "agents_changed") {
      get().refreshAgents();
    } else if (e.type === "sections_changed") {
      get().refreshSections();
    } else if (e.type === "lead_changed") {
      get().refreshLead();
    } else if (e.type === "discussion") {
      // the event has the discussion; who has answered comes with a fetch
      get().loadDiscussion(e.discussion.id);
    } else if (e.type === "agent_status") {
      // an agent created in another tab or through the API
      if (!get().agents.some((a) => a.id === e.agentId)) get().refreshAgents();
      set((s) => ({
        agents: s.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)),
        live: e.status === "busy" ? s.live : Object.fromEntries(Object.entries(s.live).filter(([, r]) => r.agentId !== e.agentId)),
      }));
    } else if (e.type === "computer") {
      const c = e.computer as ComputerInfo;
      set((s) => ({ computers: s.computers.some((x) => x.id === c.id) ? s.computers.map((x) => (x.id === c.id ? c : x)) : [...s.computers, c] }));
    } else if (e.type === "computer_removed") {
      set((s) => ({ computers: s.computers.filter((x) => x.id !== e.computerId) }));
      get().refreshAgents();
    } else if (e.type === "approval") {
      set((s) => ({ approvals: { ...s.approvals, [e.approval.id]: e.approval } }));
    } else if (e.type === "routines_changed") {
      set((s) => ({ routinesVersion: s.routinesVersion + 1 }));
    } else if (e.type === "background_changed") {
      set((s) => ({ backgroundVersion: s.backgroundVersion + 1 }));
    } else if (e.type === "changes_changed") {
      set((s) => ({ changesVersion: s.changesVersion + 1 }));
    } else if (e.type === "tasks_changed") {
      set((s) => ({ tasksVersion: s.tasksVersion + 1 }));
    } else if (e.type === "flows_changed") {
      set((s) => ({ flowsVersion: s.flowsVersion + 1 }));
    } else if (e.type === "memory_changed") {
      set((s) => ({ memoryVersion: s.memoryVersion + 1 }));
    } else if (e.type === "skills_changed") {
      set((s) => ({ skillsVersion: s.skillsVersion + 1 }));
    } else if (e.type === "model_connections_changed") {
      set((s) => ({ modelsVersion: s.modelsVersion + 1 }));
    } else if (e.type === "model_login") {
      set((s) => ({ modelLogins: { ...s.modelLogins, [e.login.id]: e.login } }));
    } else if (e.type === "run_event") {
      for (const tap of runTaps) tap(e);
      set((s) => {
        const cur = s.live[e.runId] ?? { runId: e.runId, agentId: e.agentId, channelId: e.channelId, threadId: e.threadId ?? null, threadPath: e.threadPath ?? [], text: "", tools: [], last: null, usedComputer: false };
        return { live: { ...s.live, [e.runId]: applyEvent(cur, e.event) } };
      });
    }
    if (notify) notifyOn(e, before, get());
  },
}));

/** Views that need every step of a run (Code's agent panes), not the store's short summary. */
export type RunEvent = Extract<ClientEvent, { type: "run_event" }>;
export const runTaps = new Set<(e: RunEvent) => void>();

/** A channel and each of its threads have independent history and load errors. */
export const conversationKey = (channelId: string, threadId?: string) => threadId ? `${channelId}/t/${threadId}` : channelId;

const messageLoads = new Map<string, { promise: Promise<void>; earlier: boolean }>();
async function loadMessages(channelId: string, threadId?: string, earlier = false): Promise<void> {
  const key = conversationKey(channelId, threadId);
  const pending = messageLoads.get(key);
  if (pending) {
    await pending.promise;
    if (!earlier && pending.earlier) await loadMessages(channelId, threadId);
    return;
  }
  const promise = fetchMessages(channelId, threadId, earlier);
  messageLoads.set(key, { promise, earlier });
  try { await promise; } finally { messageLoads.delete(key); }
}

async function fetchMessages(channelId: string, threadId?: string, earlier = false) {
  const key = conversationKey(channelId, threadId);
  const state = useStore.getState();
  if (earlier && !state.hasEarlier[key]) return;
  const previous = threadId ? state.threads[threadId] : state.messages[channelId];
  // the hub's cursor is a time: everything written before the oldest message loaded
  const before = earlier ? previous?.[0]?.createdAt : undefined;
  if (earlier && !before) return;
  const limit = threadId ? 200 : 100;
  useStore.setState((s) => ({ loadingMessages: { ...s.loadingMessages, [key]: true }, loadErrors: { ...s.loadErrors, [key]: null } }));
  try {
    const path = `/api/channels/${channelId}/messages?${threadId ? `thread=${encodeURIComponent(threadId)}&` : ""}limit=${limit}`;
    type Page = { messages: Message[]; replyCounts?: Record<string, number> };
    const r = await api<Page>("GET", `${path}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    const root = threadId ? r.messages.find((m) => m.id === threadId) : undefined;
    const page = r.messages.filter((m) => m.id !== threadId);
    useStore.setState((s) => {
      const current = (threadId ? s.threads[threadId] : s.messages[channelId]) ?? [];
      const merged = earlier ? dedupe([...page, ...current]) : [...new Map([...current, ...page].map((m) => [m.id, m])).values()].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      // Refreshing the latest page must not discard already loaded earlier history.
      const keptEarlier = !earlier && current.length > 0 && page.length > 0 && current[0].id !== page[0].id;
      return {
        ...(threadId ? { threads: { ...s.threads, [threadId]: merged } } : { messages: { ...s.messages, [channelId]: merged } }),
        replyCounts: { ...s.replyCounts, ...r.replyCounts },
        ...(root && !s.removedRoots[root.id] ? { roots: { ...s.roots, [root.id]: root } } : {}),
        hasEarlier: { ...s.hasEarlier, [key]: keptEarlier ? (s.hasEarlier[key] ?? r.messages.length === limit) : r.messages.length === limit },
      };
    });
  } catch (e) {
    useStore.setState((s) => ({ loadErrors: { ...s.loadErrors, [key]: { message: (e as Error).message, earlier } } }));
    throw e;
  } finally {
    useStore.setState((s) => ({ loadingMessages: { ...s.loadingMessages, [key]: false } }));
  }
}

function applyReactions(s: State, messageId: string, reactions: Reaction[]): Partial<State> {
  const patch = (list: Message[]) => (list.some((m) => m.id === messageId) ? list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) : list);
  return {
    messages: Object.fromEntries(Object.entries(s.messages).map(([k, v]) => [k, patch(v)])),
    threads: Object.fromEntries(Object.entries(s.threads).map(([k, v]) => [k, patch(v)])),
  };
}

function applyEvent(r: LiveRun, ev: AgentEvent): LiveRun {
  if (ev.type === "text") return { ...r, text: r.text + ev.text };
  if (ev.type === "tool_call") return { ...r, tools: [...r.tools, ev.name], last: { name: ev.name, input: ev.input }, usedComputer: r.usedComputer || /computer_/.test(ev.name) };
  // "started" only opens the live run (the working bubble shows it); it isn't a line of the reply
  if (ev.type === "status" && ev.text === "started") return r;
  // The existing streaming view renders text; give non-text events their own lines.
  let text: string;
  if (ev.type === "status" || ev.type === "notice") text = ev.text;
  else if (ev.type === "error") text = `Error: ${ev.message}`;
  else if (ev.type === "tool_result") {
    // tool output can be a whole file; the live view only needs a glimpse
    const out = typeof ev.output === "string" ? ev.output : (JSON.stringify(ev.output) ?? "");
    text = `${ev.name}: ${out.length > 300 ? out.slice(0, 300) + "…" : out}`;
  }
  else if (ev.type === "usage") {
    const { type: _, ...usage } = ev;
    text = `Usage: ${Object.entries(usage).map(([key, value]) => `${key}: ${value}`).join(", ")}`;
  } else return r;
  return { ...r, text: r.text + (r.text && !r.text.endsWith("\n") ? "\n" : "") + text + "\n" };
}

function dedupe(list: Message[]): Message[] {
  const seen = new Set<string>();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/** Lookups used across the UI. */
export function useNames() {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  return {
    agent: (id: string) => agents.find((a) => a.id === id),
    member: (id: string) => members.find((m) => m.id === id),
    actorName: (kind: "user" | "agent", id: string) => (kind === "agent" ? (agents.find((a) => a.id === id)?.name ?? "agent") : (members.find((m) => m.id === id)?.name ?? "someone")),
  };
}

/** Agent handle -> display name, for mention chips. */
export function useHandleNames(): Map<string, string> {
  const agents = useStore((s) => s.agents);
  return useMemo(() => new Map(agents.map((a) => [a.handle, a.name])), [agents]);
}

/** Each agent's own color by handle, for tinting its @mentions. */
export function useHandleColors(): Map<string, string> {
  const agents = useStore((s) => s.agents);
  return useMemo(() => new Map(agents.map((a) => [a.handle, agentColor(a)])), [agents]);
}

/** What agents are waiting on you for: approvals and help on their computers. Guests answer none. */
export function useWaitingOnYou(): { approvals: Approval[]; help: ComputerInfo[] } {
  const me = useStore((s) => s.me);
  const approvals = useStore((s) => s.approvals);
  const computers = useStore((s) => s.computers);
  return useMemo(() => {
    if (!me || me.role === "guest") return { approvals: [], help: [] };
    return {
      approvals: Object.values(approvals).filter((a) => a.status === "pending"),
      help: computers.filter((c) => c.help),
    };
  }, [me, approvals, computers]);
}

/** The Chats badge: unread messages in your channels and DMs, counted the same way as the Inbox badge. */
export function useChatsUnread(): number {
  return useStore((s) => s.channels.reduce((n, c) => n + (c.joined || c.kind === "dm" ? c.unread || 0 : 0), 0));
}

/** The Inbox badge: everything waiting on you plus unread messages in your channels and DMs. */
export function useInboxCount(): number {
  const waiting = useWaitingOnYou();
  const unread = useChatsUnread();
  return waiting.approvals.length + waiting.help.length + unread;
}
