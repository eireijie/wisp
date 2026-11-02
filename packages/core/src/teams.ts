import type { Channel, ChannelTeam } from "./types.ts";

/**
 * A channel's team as the rest of Wisp reads it: who's on it and in what role, who leads, its
 * shared memory folder and repo, and who it reports to. A channel is the only kind of team, so a
 * team's id is its channel's id and its name is the channel's name.
 */
export interface Team {
  id: string;
  channelId: string;
  workspaceId: string;
  name: string;
  /** the leads, in chart order; `leadId` is the first one */
  leads: string[];
  leadId: string | null;
  reportsTo: string | null;
  /** the shared memory folder; "" = none */
  folder: string;
  repo: string | null;
  baseBranch: string;
  members: TeamMember[];
}

export interface TeamMember {
  agentId: string;
  role: string;
  roleNotes: string;
  lead: boolean;
  /** the first agent on the chart that hands it work; null for a lead */
  managerId: string | null;
}

/** A channel's team, or null when it has none (or is a DM or archived). */
export function teamOf(channel: Pick<Channel, "id" | "workspaceId" | "name" | "kind" | "archivedAt" | "settings">): Team | null {
  const t = channel.settings.team;
  if (!t?.nodes.length || channel.kind !== "channel" || channel.archivedAt) return null;
  const leads = t.nodes.filter((n) => n.lead).map((n) => n.agentId);
  return {
    id: channel.id,
    channelId: channel.id,
    workspaceId: channel.workspaceId,
    name: channel.name,
    leads,
    leadId: leads[0] ?? null,
    reportsTo: t.reportsTo ?? null,
    folder: cleanFolder(t.folder ?? ""),
    repo: t.repo?.trim() || null,
    baseBranch: t.baseBranch?.trim() || "main",
    members: t.nodes.map((n) => ({ agentId: n.agentId, role: n.role?.trim() ?? "", roleNotes: n.roleNotes?.trim() ?? "", lead: n.lead, managerId: n.lead ? null : (t.edges.find((e) => e.to === n.agentId)?.from ?? null) })),
  };
}

/**
 * The agents a team's icon shows, in order: the chart's agents (leads first), then any other agent
 * in the channel. Empty only when no agent is in it at all.
 */
export function teamIconAgentIds(channel: Pick<Channel, "settings"> & { agentIds?: string[] }): string[] {
  const nodes = channel.settings?.team?.nodes ?? [];
  const charted = [...nodes.filter((n) => n.lead), ...nodes.filter((n) => !n.lead)].map((n) => n.agentId);
  return [...new Set([...charted, ...(channel.agentIds ?? [])])];
}

/** Every channel's team. */
export function channelTeams(channels: Parameters<typeof teamOf>[0][]): Team[] {
  return channels.map(teamOf).filter((t): t is Team => !!t);
}

/** A memory folder as a team stores it: forward slashes, no slashes at either end. */
export function cleanFolder(folder: string): string {
  return folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Everyone a team reports to, nearest first: its boss, then whoever a team the boss leads
 * reports to, and so on. Stops at the top or at a loop.
 */
export function teamChain(team: Pick<Team, "reportsTo">, teams: Pick<Team, "leads" | "reportsTo">[]): string[] {
  const out: string[] = [];
  let boss = team.reportsTo;
  while (boss && !out.includes(boss)) {
    out.push(boss);
    const b = boss;
    boss = teams.find((t) => t.leads.includes(b) && t.reportsTo)?.reportsTo ?? null;
  }
  return out;
}

/** Teams that report to this agent, directly or further down the chain. */
export function teamsBelow(agentId: string, teams: Team[]): Team[] {
  return teams.filter((t) => teamChain(t, teams).includes(agentId));
}

/** Someone who could review a piece of work: where they run, what the team calls them. */
export interface ReviewerCandidate {
  agentId: string;
  harness: string;
  /** their role on the team, if any */
  role: string;
  /** the team's lead (or the workspace's) */
  lead: boolean;
}

/**
 * Who reviews a builder's work. Never the builder. A teammate whose role is reviewing comes first,
 * then anyone on a different harness (a different lab sees different things), then the lead.
 * Null when nobody but the builder is around.
 */
export function pickReviewer(builder: { agentId: string; harness: string }, candidates: ReviewerCandidate[]): string | null {
  const score = (c: ReviewerCandidate) => (/review/i.test(c.role) ? 4 : 0) + (c.harness !== builder.harness ? 2 : 0) + (c.lead ? 1 : 0);
  const others = candidates.filter((c) => c.agentId !== builder.agentId);
  let best: ReviewerCandidate | undefined;
  for (const c of others) if (!best || score(c) > score(best)) best = c;
  return best?.agentId ?? null;
}
