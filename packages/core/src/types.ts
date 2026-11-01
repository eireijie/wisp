import { stepsProblem, type TeamRole, type TeamStep } from "./team-flow.ts";


export type Role = "owner" | "member" | "guest";
/** One of HARNESSES (harnesses.ts), or "acp:<name>" for an ACP agent a device declared. */
export type HarnessId = string;

/** Who did something: a human user or an agent. */
export type Actor = { kind: "user"; id: string } | { kind: "agent"; id: string };

export interface User {
  id: string;
  email: string;
  name: string;
  /** what agents call them ("Alex"); null = their name */
  preferredName: string | null;
  /** IANA time zone, e.g. "America/New_York"; agents see their local time, routines run in it */
  timezone: string | null;
  createdAt: string;
}

/** How Wisp behaves for one person, on every device they use. */
export interface UserPrefs {
  /** Enter sends (Shift+Enter for a new line), or ⌘/Ctrl+Enter sends */
  sendWith?: "enter" | "mod-enter";
  /** "auto" follows the language's usual clock */
  clock?: "auto" | "12h" | "24h";
  /** the tools an agent used for a reply: a collapsed line, open, or not shown */
  toolCalls?: "collapsed" | "expanded" | "hidden";
  /**
   * How much of Wisp to show. "simple" keeps advanced setup (teams, harness details, VM sizing,
   * tokens, raw files) behind "Advanced" disclosures or out of the way; "advanced" shows everything.
   * Chosen during onboarding; unset means advanced, so existing accounts see no change.
   */
  experience?: "simple" | "advanced";
}

/**
 * What a device does for agents, picked by its owner: run their computers (VMs), let agents that
 * run on it use its own screen, or neither (agents there run headless). Null until someone picks.
 */
export type DeviceRole = "vms" | "screen" | "headless";

/** How much an agent may do on its device. "full" also needs `allowFullAccess` in that device's config. */
export type AccessLevel = "read-only" | "edit" | "full";

/** Per-agent knobs the owner can change. Instructions live on the agent; the soul lives in the vault. */
export interface AgentSettings {
  /** reasoning effort, e.g. "low" | "medium" | "high"; null = the harness default */
  effort?: string | null;
  /**
   * The model connection (models.ts) it runs on: a sign-in or API key kept on the hub and handed to
   * its device or VM with each run. Unset (or null) = the harness's own login where it runs, as before.
   */
  connectionId?: string | null;
  access?: AccessLevel;
  /** when true the agent can't rewrite its own SOUL.md */
  soulLocked?: boolean;
  /** use the model's faster (pricier) tier where the harness offers one */
  fast?: boolean;
  /** how its ghost looks; unset = a default derived from its handle */
  appearance?: import("./appearance.ts").GhostAppearance;
  /** Voice IDs per speech engine; unset voices are derived from the agent handle. */
  voice?: { device?: string; openai?: string; elevenlabs?: string };
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
  /** its job title, e.g. "Engineer" or "Researcher"; the lead hands work out by it */
  role?: string;
  /** what the role means for how it works: what it owns, what to send its way */
  roleNotes?: string;
  /**
   * Whose messages wake it: only its creator ("me"; the organization's owners when it has no
   * creator), anyone in the organization, or the people in `respondPeople` (plus its creator).
   * Unset means anyone, as agents did before this existed; new agents start at "me".
   */
  respondTo?: "me" | "anyone" | "people";
  /** user ids it answers when respondTo is "people" */
  respondPeople?: string[];
  /** the person who made it (set by the hub when it's created; older agents don't have one) */
  createdBy?: string;
  /** the agent that made it, when a lead or another agent created it (Settings → Agents allows that) */
  parentAgentId?: string;
  /** how many agents up the chain it was made: 1 = by a lead, 2 = a sub-agent of that one, … */
  madeDepth?: number;
}

/**
 * Who takes a task nobody assigned: the workspace's lead. `leadId` is what an owner picked (null =
 * not picked); `lead` is who actually gets the work, which falls back to a team's lead.
 */
export interface LeadStatus {
  leadId: string | null;
  lead: string | null;
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
  /** what can follow a "/" in chat for this harness on this device */
  commands?: CommandOption[];
}

/**
 * Something a person can run with "/" for an agent: one of its harness's own commands, or a skill.
 * "raw" ones go to the harness exactly as typed ("/compact"); "prompt" ones (a skill the harness
 * can't run by name) become a request to use that skill.
 */
export interface CommandOption {
  name: string;
  description?: string;
  /** what goes after it, e.g. "topic" */
  hint?: string;
  kind: "command" | "skill";
  via: "raw" | "prompt";
  /** the harness ships it (not a file the person added) */
  builtIn?: boolean;
}

/** The latest usage report for an agent in one conversation. */
export interface ContextUsage {
  model?: string;
  effort?: string | null;
  contextUsed?: number;
  contextWindow?: number;
  /** tokens the whole run used, where the harness reports it */
  inputTokens?: number;
  outputTokens?: number;
  /** the part of `inputTokens` served from the harness's cache */
  cachedInputTokens?: number;
  /** how much of the subscription's limit was used, where the harness reports it */
  plan?: import("./models.ts").PlanUsage;
  /** the harness and model connection the run used (null: the device's own login); missing on older runs */
  harness?: string;
  connectionId?: string | null;
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
  settings: AgentSettings;
  status: "online" | "busy" | "offline";
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
  /** only its members (and the workspace owner) can see a private channel */
  private: boolean;
  /** set while archived: read-only, out of the sidebar, can be brought back */
  archivedAt: string | null;
  settings: ChannelSettings;
  createdAt: string;
}

/** How agents behave in one channel. */
export interface ChannelSettings {
  /** the agent that answers messages nobody @mentions; null = only @mentioned agents answer */
  defaultAgentId: string | null;
  /** agents answer a top-level message in a thread under it, keeping the channel tidy */
  replyInThread: boolean;
  /** standing notes every agent reads when it works here ("use the web repo", "keep replies short") */
  instructions: string;
  /** the channel's agent team, drawn as a flow chart; null = no team (the older rules above apply) */
  team: ChannelTeam | null;
}

/**
 * A channel's agent team. Leads read every new message in the channel; when there's more than one
 * they talk it over and agree on a plan before handing out work. An arrow means "hands work to".
 */
export interface ChannelTeam {
  nodes: ChannelTeamNode[];
  edges: { from: string; to: string }[];
  /** a memory folder the whole team reads and writes, e.g. teams/web; missing or "" = none */
  folder?: string;
  /** git repository the team codes in (URL or a path on the agents' device); missing or null = none */
  repo?: string | null;
  /** the branch its work merges into; "main" when missing */
  baseBranch?: string;
  /** an agent outside the team that it reports to (its boss), who can see and steer its work */
  reportsTo?: string | null;
  /**
   * Roles and the steps they take (team-flow.ts). With these the team runs step by step and
   * `nodes`/`edges` are kept in step with them for older apps.
   */
  roles?: TeamRole[];
  steps?: TeamStep[];
}

export interface ChannelTeamNode {
  agentId: string;
  lead: boolean;
  /** where it sits on the flow chart */
  x: number;
  y: number;
  /** its role on this team, e.g. "Reviewer", and what that role means for how it works */
  role?: string;
  roleNotes?: string;
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { defaultAgentId: null, replyInThread: false, instructions: "", team: null };

/** What's wrong with a team's chart, in plain words, or null when it's fine. */
export function teamProblem(team: ChannelTeam): string | null {
  const steps = stepsProblem(team);
  if (steps) return steps;
  if (!team.nodes.length) return "Add at least one agent to the team.";
  if (!team.nodes.some((n) => n.lead)) return "Make at least one agent a lead.";
  const ids = new Set(team.nodes.map((n) => n.agentId));
  if (ids.size !== team.nodes.length) return "An agent is on the chart twice.";
  for (const e of team.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) return "An arrow points at an agent that isn't on the chart.";
    if (e.from === e.to) return "An agent can't hand work to itself.";
  }
  const lead = new Set(team.nodes.filter((n) => n.lead).map((n) => n.agentId));
  if (team.edges.some((e) => lead.has(e.to))) return "Leads hear every message already; arrows can't point at a lead.";
  // every agent that isn't a lead gets work from someone
  if (team.nodes.some((n) => !n.lead && !team.edges.some((e) => e.to === n.agentId))) return "Connect every agent that isn't a lead to whoever hands it work.";
  // and no loops
  const next = (id: string) => team.edges.filter((e) => e.from === id).map((e) => e.to);
  const seen = new Set<string>();
  const walk = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    path.add(id);
    const loop = next(id).some((n) => walk(n, path));
    path.delete(id);
    return loop;
  };
  if (team.nodes.some((n) => walk(n.agentId, new Set()))) return "The arrows go round in a loop.";
  if (team.reportsTo && ids.has(team.reportsTo)) return "The team can't report to an agent on it.";
  return null;
}

/** One person's own setting for a channel: how loud it is. */
export type ChannelNotify = "all" | "default" | "mute";

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

/** The message a reply quotes, as it reads now. Filled in by the hub when messages are sent out. */
export interface ReplyQuote {
  id: string;
  author: Actor;
  /** the start of its text (or the file it carried); empty when it was deleted */
  snippet: string;
  deleted?: boolean;
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
  /** set when this message replies to another one in the same channel: a quote, not a thread */
  replyToId?: string;
  replyTo?: ReplyQuote;
  createdAt: string;
  /** set when its author changed the text */
  editedAt?: string;
  /** set when it was deleted but kept so its thread's replies stay reachable; body and parts are empty */
  deletedAt?: string;
}

export type MessagePart =
  | { type: "tool_call"; name: string; input: unknown; output?: unknown }
  | { type: "file"; fileId: string; name: string }
  | { type: "status"; text: string }
  /** a quiet line from Wisp, e.g. "Round 2 of 3" */
  | { type: "notice"; text: string }
  /** the agent saved a new skill during this reply, or followed one */
  | { type: "skill"; action: "learned" | "used"; skillId: string; slug: string }
  /** this message starts a discussion; its thread is where it happens */
  | { type: "discussion"; discussionId: string }
  /** an agent's computer: a live view, and what it asked a person to do there ("Sign in to Zendesk") */
  | { type: "computer"; computerId: string; request?: string }
  /** an agent wants a person's OK before it does something */
  | { type: "approval"; approvalId: string }
  /** a routine was taught, changed or run */
  | { type: "routine"; routineId: string }
  /** this message hands out a task: people see a task card; the assignee gets its id and how to report back */
  | { type: "task"; taskId: string }
  /** an agent's answer to /context: how full its conversation is */
  | { type: "context"; usage: ContextUsage | null }
  /** an agent changed a setting or a mod for the person it works for; they see what changed and can undo it */
  | { type: "change"; changeId: string }
  /** something the agent will come back to, shown under its reply ("Check the build · 4:35 PM"); kept up to date */
  | { type: "followup"; followupId: string; label: string; dueAt: string; waitingOn: "agent" | "person"; status: "pending" | "done" | "cancelled" }
  /** the agent came back to something on its own; `replies` are quick answers the person can tap */
  | { type: "checkback"; replies: string[] }
  /** the agent finished what this chat was about */
  | { type: "wrapup"; did: string; saved: string; next: string }
  /** the agent dropped what this chat was about after the person didn't answer */
  | { type: "closed" };

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
  /** set when the agent is asking to use a login from the password manager: only whoever connected it can decide */
  login?: import("./logins.ts").LoginRequest | null;
  /** set when it's an ask-me step of a team's flow: deciding it moves that request on */
  flow?: { flowId: string; stepId: string } | null;
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
  /** when it was last asked to run (by a person or the schedule); the run may still be queued */
  lastRunAt: string | null;
  /** when a run it asked for last finished with a result; null until one has */
  lastCompletedAt: string | null;
  createdAt: string;
}

/**
 * An agent working in the background for one person: it wakes on its own, looks at what it can
 * reach (connected apps, memory, tasks, conversations) and messages them only when something
 * needs them. It decides when to look again; `everyMinutes` is the pace when it doesn't say.
 */
export interface BackgroundWork {
  agentId: string;
  userId: string;
  enabled: boolean;
  everyMinutes: number;
  /** what the person most wants watched, in their words; empty = everything it can reach */
  focus: string;
  /** quiet hours in the person's timezone ("HH:MM"); no regular checks, and messages only if urgent */
  quietStart: string;
  quietEnd: string;
  nextAt: string | null;
  /** why the agent picked `nextAt` */
  nextReason: string;
  lastAt: string | null;
  /** the agent's note to itself from its last check */
  lastNote: string;
  /** a check is running or waiting for the device right now */
  checking: boolean;
  /** the model for checks (from the device's catalog); null = the agent's own */
  model: string | null;
  /** reasoning effort for checks; null = the harness default (or the agent's, when the model isn't changed) */
  effort: string | null;
  /** most regular checks a day on the person's clock; null = no limit */
  dailyCap: number | null;
  /** checks in a row that found nothing to say: each one doubles the wait, up to a day */
  quietStreak: number;
}

/** How much of a person's AI usage background checks may use each day, across all their agents. */
export interface Allowance {
  /** tokens a day; null = no limit */
  dailyTokens: number | null;
  /** used since midnight on the person's clock, across every agent */
  todayTokens: number;
  /** some checks didn't say what they used, so part of `todayTokens` is a guess */
  estimated: boolean;
  /** used, per agent, biggest first */
  agents: { agentId: string; tokens: number; checks: number }[];
}

/** A setting or mod an agent changed for someone, kept so they can see it and undo it. */
export interface Change {
  id: string;
  /** the person it was changed for */
  userId: string;
  /** the agent that changed it */
  agentId: string;
  /** one line per thing that changed, e.g. "Checks: every 30 min → every 2 hours" */
  lines: string[];
  createdAt: string;
  undoneAt: string | null;
}

/** What background checks used, from the token counts harnesses report. Null = no check reported any. */
export interface BackgroundUsage {
  /** tokens in the latest finished check */
  lastTokens: number | null;
  /** since midnight on the person's clock */
  todayTokens: number | null;
  /** over the last 7 days */
  weekTokens: number | null;
  /** checks started today, of any kind */
  checksToday: number;
  /** the daily cap is used up, so regular checks wait for tomorrow */
  capReached: boolean;
}

/** Something a background check can look at: an app the agent is connected to, its computer, or a memory folder. */
export interface BackgroundSource {
  kind: "app" | "computer" | "memory";
  name: string;
  detail: string;
}

/** Something an agent said it would come back to at a set time ("8am tomorrow: remind Sam about the essay"). */
export interface Followup {
  id: string;
  agentId: string;
  /** the person it's for */
  userId: string | null;
  dueAt: string;
  note: string;
  status: "pending" | "done" | "cancelled";
  createdAt: string;
  /** what the person sees under the agent's reply, 2–5 words ("Check the build"); null = not shown */
  label: string | null;
  /** who owes the next step: the agent ("I'll check the build") or the person ("I'll send it tonight") */
  waitingOn: "agent" | "person";
  /** when it only matters if something hasn't happened yet ("only if it hasn't gone out") */
  condition: string;
  /** "checkback" = Wisp set it because a chat stopped while waiting on the person; never shown as a pill */
  kind: "followup" | "checkback";
  /** the chat it came from, and the reply that shows it */
  channelId: string | null;
  messageId: string | null;
}

/**
 * Where a DM with an agent stands, as the agent last said with chat_status. "waiting" = on the
 * person (an answer, a next step); "working" = on the agent; "done" = finished; "closed" = dropped
 * after the person didn't answer its check-backs.
 */
export interface ChatLoop {
  channelId: string;
  agentId: string;
  userId: string;
  status: "open" | "waiting" | "done" | "closed";
  /** what's open, in the person's terms ("send Sam the deck") */
  summary: string;
  /** check-backs sent since the person last wrote */
  nudges: number;
  updatedAt: string;
}

/** A line of a chat's wrap-up card: what got done, what was saved, what's next. */
export interface WrapUp {
  did: string;
  saved: string;
  next: string;
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
  /** no longer set: a discussion's team is its channel's */
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
  /** "plan": a channel's leads agreeing on a plan for a request before they hand out the work */
  kind?: "plan" | null;
  createdAt: string;
  updatedAt: string;
}
