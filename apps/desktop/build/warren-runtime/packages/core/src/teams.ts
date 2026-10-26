import type { Team } from "./types.ts";

/**
 * Everyone a team reports to, nearest first: its boss, then whoever the team the boss leads
 * reports to, and so on. Stops at the top or at a loop.
 */
export function teamChain(team: Pick<Team, "reportsTo">, teams: Pick<Team, "leadId" | "reportsTo">[]): string[] {
  const out: string[] = [];
  let boss = team.reportsTo;
  while (boss && !out.includes(boss)) {
    out.push(boss);
    boss = teams.find((t) => t.leadId === boss && t.reportsTo)?.reportsTo ?? null;
  }
  return out;
}

/** Teams that report to this agent, directly or further down the chain. */
export function teamsBelow(agentId: string, teams: Team[]): Team[] {
  return teams.filter((t) => teamChain(t, teams).includes(agentId));
}

/** Members at the top of the team chart: nobody on the team above them. */
export function teamRoots(team: Pick<Team, "members">): Team["members"] {
  const ids = new Set(team.members.map((m) => m.agentId));
  return team.members.filter((m) => !m.managerId || !ids.has(m.managerId));
}

/** Would making `managerId` this agent's manager put it above itself? */
export function wouldLoop(team: Pick<Team, "members">, agentId: string, managerId: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null = managerId; cur && !seen.has(cur); cur = team.members.find((m) => m.agentId === cur)?.managerId ?? null) {
    if (cur === agentId) return true;
    seen.add(cur);
  }
  return false;
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
