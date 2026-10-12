export type Role = "owner" | "member" | "guest";
/** One of HARNESSES (harnesses.ts), or "acp:<name>" for an ACP agent a device declared. */
export type HarnessId = string;

/** Who did something: a human user or an agent. */
export type Actor = { kind: "user"; id: string } | { kind: "agent"; id: string };

export interface User {
  id: string;
  email: string;
  name: string;
  /** what agents call them ("Yug"); null = their name */
  preferredName: string | null;
  /** IANA time zone, e.g. "America/New_York"; agents see their local time, routines run in it */
  timezone: string | null;
  createdAt: string;
}

/** How Warren behaves for one person, on every device they use. */
export interface UserPrefs {
  /** Enter sends (Shift+Enter for a new line), or ⌘/Ctrl+Enter sends */
  sendWith?: "enter" | "mod-enter";
  /** "auto" follows the language's usual clock */
  clock?: "auto" | "12h" | "24h";
  /** the tools an agent used for a reply: a collapsed line, open, or not shown */
  toolCalls?: "collapsed" | "expanded" | "hidden";
}

/** How much an agent may do on its device. "full" also needs `allowFullAccess` in that device's config. */
export type AccessLevel = "read-only" | "edit" | "full";

/** Per-agent knobs the owner can change. Instructions live on the agent; the soul lives in the vault. */
export interface AgentSettings {
  /** reasoning effort, e.g. "low" | "medium" | "high"; null = the harness default */
  effort?: string | null;
  access?: AccessLevel;
  /** when true the agent can't rewrite its own SOUL.md */
  soulLocked?: boolean;
  /** use the model's faster (pricier) tier where the harness offers one */
  fast?: boolean;
  /** how its ghost looks; unset = a default derived from its handle */
  appearance?: import("./appearance.ts").GhostAppearance;
  /** an owner chose to run it without a computer (it can't see or use a screen) */
  headless?: boolean;
  /**
   * Its harness runs directly on a person's device, so by default only that device's owner can
   * ask it for things. The device owner can open it up to everyone in the workspace.
   */
  anyoneCanAsk?: boolean;
  /**
   * Where its harness runs: inside its computer (a VM on its device; its shell, files and browser
   * all stay in there) or directly on the device. Unset means the device, as agents did before.
   */
  runIn?: "computer" | "device";
}

/** A model a device's harness can run, as reported by that device. */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  /** usable context window in tokens */
  contextWindow?: number;
  /** a faster tier this model offers, e.g. "1.5x speed, increased usage" */
  fast?: { description?: string };
}

export interface HarnessCatalog {
  harness: string;
  version: string | null;
  models: ModelOption[];
  /** effort levels the harness accepts when a model doesn't list its own */
  efforts: string[];
  /** what the harness uses when the agent doesn't pick (from the device's harness config) */
  defaultModel?: string;
  defaultEffort?: string;
}

/** The latest usage report for an agent in one conversation. */
export interface ContextUsage {
  model?: string;
  effort?: string | null;
  contextUsed?: number;
  contextWindow?: number;
  at: string;
}

export interface Agent {
  id: string;
  workspaceId: string;
  handle: string; // used in @mentions, unique per workspace
  name: string;
  harness: HarnessId;
  model: string | null;
  /** the device its harness runs on */
  nodeId: string | null;
  /** the computer it sees and uses (computers.ts); null = headless */
  computerId: string | null;
  /** names of the teams it's on */
  groups: string[];
  settings: AgentSettings;
  status: "online" | "busy" | "offline";
  createdAt: string;
}

/** An agent's place on a team: a role title plus what that role means for how it works. */
export interface TeamMember {
  agentId: string;
  role: string;
  roleNotes: string;
  /** the teammate this agent reports to (a line on the team chart); null at the top */
  managerId: string | null;
  /** where its card sits on the team chart; null = laid out automatically */
  x: number | null;
  y: number | null;
}

/**
 * Agents who work together: a shared memory pool (`folder`), a channel, a lead, and optionally
 * an agent they report to (their boss). Teams can report up a chain of bosses.
 */
export interface Team {
  id: string;
  workspaceId: string;
  /** lowercase slug, used in @team mentions, rule subjects and the default folder */
  name: string;
  /** a label shown next to the name, e.g. "🛠️" */
  emoji: string;
  description: string;
  leadId: string | null;
  reportsTo: string | null;
  channelId: string | null;
  /** the team's memory pool, e.g. teams/web */
  folder: string;
  /** git repository the team codes in (URL or a path on the agents' device); null = no shared repo */
  repo: string | null;
  baseBranch: string;
  members: TeamMember[];
  createdAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  kind: "channel" | "dm";
  topic: string;
  /** sidebar section; null = the default "Channels" group */
  sectionId: string | null;
  createdAt: string;
}

/** A sidebar group of channels, shared by the whole workspace. */
export interface Section {
  id: string;
  name: string;
  emoji: string;
  position: number;
}

/** Everyone who reacted with one emoji. Viewer-independent so it can be broadcast as is. */
export interface Reaction {
  emoji: string;
  actors: Actor[];
}

export interface Message {
  id: string;
  channelId: string;
  threadId: string | null;
  author: Actor;
  body: string;
  /** structured parts such as tool calls; free-form for forward compatibility */
  parts: MessagePart[];
  hop: number; // how many agent-to-agent hops led to this message (loop guard)
  reactions?: Reaction[];
  createdAt: string;
}

export type MessagePart =
  | { type: "tool_call"; name: string; input: unknown; output?: unknown }
  | { type: "file"; fileId: string; name: string }
  | { type: "status"; text: string }
  /** a quiet line from Warren, e.g. "Round 2 of 3" */
  | { type: "notice"; text: string }
  /** this message starts a discussion; its thread is where it happens */
  | { type: "discussion"; discussionId: string }
  /** an agent's computer: a live view, and what it asked a person to do there ("Sign in to Zendesk") */
  | { type: "computer"; computerId: string; request?: string }
  /** an agent wants a person's OK before it does something */
  | { type: "approval"; approvalId: string }
  /** a routine was taught, changed or run */
  | { type: "routine"; routineId: string };

/** An agent asking a person's OK before it acts ("Send these 3 intros?"). */
export interface Approval {
  id: string;
  workspaceId: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  /** what it wants to do, in one line */
  summary: string;
  /** the draft, list or reasoning behind it */
  details: string;
  status: "pending" | "approved" | "denied";
  decidedBy: string | null;
  note: string;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * Something an agent knows how to do again: steps in a memory note (often learned by watching a
 * person do it once), optionally on a schedule.
 */
export interface Routine {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  /** the steps, in the agent's memory folder */
  notePath: string;
  /** five-field cron in `timezone`; null = only when someone runs it */
  schedule: string | null;
  timezone: string;
  /** where runs are posted; null = a DM with whoever made it */
  channelId: string | null;
  enabled: boolean;
  /** "learning" while the agent studies a recording; then "ready" */
  status: "learning" | "ready";
  createdBy: Actor;
  lastRunAt: string | null;
  createdAt: string;
}

/** A web page element, as a person would point at it: "the Export button on reports.example.com". */
export interface PageElement {
  url: string;
  title?: string;
  /** button, link, textbox, checkbox… */
  role: string;
  /** its visible text or label */
  name: string;
  /** a CSS selector when it has a stable one (id, name, data-testid) */
  selector?: string;
}

/** One thing a person did while teaching an agent a task. Coordinates are in the screenshot's pixels. */
export interface RecordedStep {
  /** ms since the recording started */
  at: number;
  kind: "click" | "double_click" | "right_click" | "drag" | "scroll" | "type" | "key" | "note";
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  keys?: string;
  direction?: "up" | "down" | "left" | "right";
  /** a screenshot right before this step (an uploaded file) */
  imageFileId?: string;
  /** what was clicked, when it was in a web page on a VM */
  element?: PageElement;
}

/**
 * Agents talking something through before doing it: every participant answers on its own in
 * round 1, then they respond to each other, then the moderator writes the decision and hands out tasks.
 */
export interface Discussion {
  id: string;
  workspaceId: string;
  channelId: string;
  /** the message that started it; the discussion happens in its thread */
  threadId: string;
  teamId: string | null;
  topic: string;
  goal: string;
  participants: string[];
  moderatorId: string;
  rounds: number;
  /** 0 before it starts; rounds + 1 while the moderator writes the decision */
  round: number;
  status: "running" | "summarizing" | "done" | "cancelled";
  decisionPath: string | null;
  startedBy: Actor;
  /** the person it's for (who started it, or who asked the agent that did) */
  requestedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}
