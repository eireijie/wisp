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
