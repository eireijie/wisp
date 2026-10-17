import { useMemo } from "react";
import { create } from "zustand";
import type { Agent, AgentEvent, Approval, Channel, ClientEvent, Computer, Discussion, Message, LeadStatus, Reaction, Section, Team, User, UserPrefs } from "@warren/core";
import { api } from "./api.ts";
import { notifyOn } from "./notifications.ts";
import { agentColor } from "./components/ui.tsx";

export interface Me {
  kind: "user";
  user: User;
  /** how Warren behaves for this person, on every device (Settings → Preferences) */
  prefs: UserPrefs;
  role: "owner" | "member" | "guest";
  workspace: { id: string; name: string };
}

/** A discussion plus who has answered in its current round. */
export type DiscussionInfo = Discussion & { progress: { agentId: string; status: string }[] };

/** A team as the API returns it: `above` is who it reports to, nearest first. */
export type TeamInfo = Team & { above: string[] };

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
  unread: number;
  lastReadAt: string | null;
}

/** What an agent is doing right now, built from streamed run events. */
export interface LiveRun {
  runId: string;
  agentId: string;
  channelId: string;
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
  teams: TeamInfo[];
  discussions: Record<string, DiscussionInfo>;
  messages: Record<string, Message[]>; // top-level by channel
  threads: Record<string, Message[]>; // replies by thread root id
  replyCounts: Record<string, number>;
  live: Record<string, LiveRun>; // by runId
  computers: ComputerInfo[];
  approvals: Record<string, Approval>;
  /** bumps when routines change, so open lists refetch */
  routinesVersion: number;
  /** bumped when an agent's background work or follow-ups change */
  backgroundVersion: number;
  /** bumps when tasks change, so the Tasks page refetches */
  tasksVersion: number;
  /** bumps when notes change outside Warren, so Memory reloads */
  memoryVersion: number;
  /** the New task dialog is open */
  newTaskOpen: boolean;
  /** who takes tasks nobody assigned, and the lead an owner picked (if any); null until loaded */
  lead: LeadStatus | null;
  activeChannel: string | null;
  paletteOpen: boolean;

  load(): Promise<void>;
  loadChannel(id: string): Promise<void>;
  loadThread(channelId: string, rootId: string): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshTeams(): Promise<void>;
  refreshComputers(): Promise<void>;
  refreshLead(): Promise<void>;
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
  teams: [],
  discussions: {},
  messages: {},
  threads: {},
  replyCounts: {},
  live: {},
  computers: [],
  approvals: {},
  routinesVersion: 0,
  backgroundVersion: 0,
  tasksVersion: 0,
  memoryVersion: 0,
  newTaskOpen: false,
  lead: null,
  activeChannel: null,
  paletteOpen: false,

  async load() {
    const [me, channels, sections, agents, members, teams] = await Promise.all([
      api<Me>("GET", "/api/me"),
      api<ChannelInfo[]>("GET", "/api/channels"),
      api<Section[]>("GET", "/api/sections"),
      api<Agent[]>("GET", "/api/agents"),
      api<Member[]>("GET", "/api/members"),
      // a hub older than this page has no teams; still load everything else
      api<TeamInfo[]>("GET", "/api/teams").catch(() => [] as TeamInfo[]),
    ]);
    set({ me, channels, sections, agents, members, teams });
    get().refreshComputers();
    get().refreshLead();
    api<Approval[]>("GET", "/api/approvals?status=pending").then((list) => set((s) => ({ approvals: { ...s.approvals, ...Object.fromEntries(list.map((a) => [a.id, a])) } })), () => {});
  },

  async refreshLead() {
    set({ lead: await api<LeadStatus>("GET", "/api/settings/lead").catch(() => get().lead) });
  },

  async refreshComputers() {
    // a hub older than this page has no computers
    set({ computers: await api<ComputerInfo[]>("GET", "/api/computers").catch(() => get().computers) });
  },

  async loadApproval(id) {
    const a = await api<Approval>("GET", `/api/approvals/${id}`).catch(() => null);
    if (a) set((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
  },

  async loadChannel(id) {
    const r = await api<{ messages: Message[]; replyCounts: Record<string, number> }>("GET", `/api/channels/${id}/messages?limit=100`);
    set((s) => ({ messages: { ...s.messages, [id]: r.messages }, replyCounts: { ...s.replyCounts, ...r.replyCounts } }));
  },

  async loadThread(channelId, rootId) {
    const r = await api<{ messages: Message[] }>("GET", `/api/channels/${channelId}/messages?thread=${rootId}&limit=200`);
    set((s) => ({ threads: { ...s.threads, [rootId]: r.messages.filter((m) => m.id !== rootId) } }));
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

  async refreshTeams() {
    const [teams, agents] = await Promise.all([api<TeamInfo[]>("GET", "/api/teams").catch(() => get().teams), api<Agent[]>("GET", "/api/agents")]);
    set({ teams, agents });
  },

  async refreshChannels() {
    const list = await api<ChannelInfo[]>("GET", "/api/channels");
    // a read we haven't sent yet (debounced) or the open channel must not come back as unread
    const { activeChannel, channels } = get();
    set({
      channels: list.map((c) =>
        c.id === activeChannel || readTimers.has(c.id) ? { ...c, unread: 0, lastReadAt: channels.find((x) => x.id === c.id)?.lastReadAt ?? c.lastReadAt } : c,
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
    set({ paletteOpen: open });
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
    set({ connected });
    // after a reconnect, catch up on anything missed
    if (connected) {
      const { activeChannel } = get();
      if (activeChannel) get().loadChannel(activeChannel);
      get().refreshTeams();
      get().refreshChannels();
      get().refreshComputers();
    }
  },

  handle(e, notify = true) {
    const before = get();
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
          channels: s.channels.map((c) => (c.id === m.channelId && !mine && s.activeChannel !== m.channelId ? { ...c, unread: c.unread + 1 } : c)),
        }));
        if (get().activeChannel === m.channelId && !mine) get().markRead(m.channelId);
      }
    } else if (e.type === "message_removed") {
      const drop = (list: Message[] | undefined) => list?.filter((m) => m.id !== e.messageId);
      set((s) => ({
        messages: s.messages[e.channelId] ? { ...s.messages, [e.channelId]: drop(s.messages[e.channelId])! } : s.messages,
        threads: e.threadId && s.threads[e.threadId] ? { ...s.threads, [e.threadId]: drop(s.threads[e.threadId])! } : s.threads,
        replyCounts: e.threadId && s.replyCounts[e.threadId] ? { ...s.replyCounts, [e.threadId]: Math.max(0, s.replyCounts[e.threadId] - 1) } : s.replyCounts,
      }));
    } else if (e.type === "reactions") {
      set((s) => applyReactions(s, e.messageId, e.reactions));
    } else if (e.type === "channels_changed") {
      get().refreshChannels();
    } else if (e.type === "sections_changed") {
      get().refreshSections();
    } else if (e.type === "teams_changed") {
      get().refreshTeams();
      get().refreshLead();
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
    } else if (e.type === "tasks_changed") {
      set((s) => ({ tasksVersion: s.tasksVersion + 1 }));
    } else if (e.type === "memory_changed") {
      set((s) => ({ memoryVersion: s.memoryVersion + 1 }));
    } else if (e.type === "run_event") {
      set((s) => {
        const cur = s.live[e.runId] ?? { runId: e.runId, agentId: e.agentId, channelId: e.channelId, text: "", tools: [], last: null, usedComputer: false };
        return { live: { ...s.live, [e.runId]: applyEvent(cur, e.event) } };
      });
    }
    if (notify) notifyOn(e, before, get());
  },
}));

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
  return r;
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
