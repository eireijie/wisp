import type { Agent } from "@wisp/core";
import type { Hub } from "./hub.ts";
import { pickedLead } from "./lead.ts";
import { MAX_MADE_DEPTH, agentPolicy } from "./policy.ts";

/**
 * Agents making agents (Settings → Agents, both off by default): a lead may create agents when
 * its team needs someone, and an agent a lead made may make sub-agents for pieces of its own work,
 * down to MAX_MADE_DEPTH. The organization caps how many agent-made agents exist at once.
 */

/** Does this agent lead anything: a channel's team, or the organization (when an owner picked it)? */
export function isLead(hub: Hub, agent: Pick<Agent, "id" | "workspaceId">): boolean {
  const { store } = hub;
  if (store.channels(agent.workspaceId).some((ch) => ch.settings.team?.nodes.some((n) => n.lead && n.agentId === agent.id))) return true;
  return pickedLead(store, agent.workspaceId) === agent.id;
}

/** How many agents agents have made in the organization so far. */
export function agentMadeCount(hub: Hub, workspaceId: string): number {
  return hub.store.agents(workspaceId).filter((a) => a.settings.parentAgentId).length;
}

/** May this agent make an agent right now, and what kind? Or why not, in plain words. */
export function spawnRight(hub: Hub, agent: Agent): { kind: "agent" | "sub-agent"; depth: number } | { why: string } {
  const policy = agentPolicy(hub, agent.workspaceId);
  const depth = agent.settings.madeDepth ?? 0;
  let kind: "agent" | "sub-agent" | null = null;
  if (policy.leadsCreateAgents && isLead(hub, agent)) kind = "agent";
  else if (policy.subAgents && agent.settings.parentAgentId) kind = "sub-agent";
  if (!kind) {
    if (agent.settings.parentAgentId) return { why: "making sub-agents is switched off for this organization (Settings → Agents)" };
    return { why: policy.leadsCreateAgents ? "only leads can create agents" : "agents creating agents is switched off for this organization (Settings → Agents)" };
  }
  if (depth + 1 > MAX_MADE_DEPTH) return { why: `agents can only be made ${MAX_MADE_DEPTH} levels down, and you're at the bottom` };
  if (agentMadeCount(hub, agent.workspaceId) >= policy.maxAgentMade) return { why: `the organization already has ${policy.maxAgentMade} agents made by agents, its limit (Settings → Agents)` };
  return { kind, depth: depth + 1 };
}

/** The line in an agent's prompt about making agents, or "" when it can't. */
export function spawnSection(hub: Hub, agent: Agent): string {
  const right = spawnRight(hub, agent);
  if (!("kind" in right)) return "";
  return right.kind === "agent"
    ? "## Making agents\nAs a lead you may create an agent with agent_create when the work needs someone nobody on your team covers (give it a name, a role and instructions). It joins your channel's chart under you, so you can hand it work. Prefer the agents you already have; don't create one for a single small task."
    : "## Making sub-agents\nYou may make a sub-agent with agent_create for a piece of your work that's big enough to hand off (give it a name, a role and instructions). It works under you; hand it the piece with task_delegate and check what comes back.";
}
