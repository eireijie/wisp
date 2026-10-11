import { accessChecker, builtinRules, teamChain, type AccessRule, type Agent, type Decision, type Team, type Viewer } from "@warren/core";
import type { Store } from "./store.ts";

/** Memory permissions: stored rules plus defaults that follow each workspace's agents, teams and people. */
export class MemoryAccess {
  constructor(private store: Store) {}

  rules(workspaceId: string): AccessRule[] {
    const teams = this.store.teams(workspaceId);
    const shape = {
      agents: this.store.agents(workspaceId),
      teams: teams.map((t) => ({ name: t.name, folder: t.folder, above: teamChain(t, teams) })),
      people: this.store.members(workspaceId),
    };
    return [...builtinRules(shape), ...this.store.accessRules(workspaceId)];
  }

  checker(workspaceId: string, viewer: Viewer): (path: string) => Decision {
    return accessChecker(viewer, this.rules(workspaceId));
  }

  /** An agent as access rules see it: its teams and its role on each. */
  agentViewer(agent: Pick<Agent, "id" | "workspaceId" | "settings">, teams: Team[] = this.store.teams(agent.workspaceId)): Viewer {
    const mine = teams.filter((t) => t.members.some((m) => m.agentId === agent.id));
    return {
      actor: { kind: "agent", id: agent.id },
      teams: mine.map((t) => t.name),
      teamRoles: mine.flatMap((t) => {
        const role = t.members.find((m) => m.agentId === agent.id)!.role;
        return role ? [{ team: t.name, role }] : [];
      }),
      soulLocked: !!agent.settings.soulLocked,
    };
  }
}
