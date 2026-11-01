import type { ChannelSettings } from "@wisp/core";

/** The part of a channel's settings the Agents form owns. The team's flow is saved by the builder, so this form never sends it back. */
export type AgentRules = Pick<ChannelSettings, "defaultAgentId" | "replyInThread" | "instructions">;

export const agentRulesOf = (s: AgentRules): AgentRules => ({ defaultAgentId: s.defaultAgentId, replyInThread: s.replyInThread, instructions: s.instructions });

/** How a team with no chart works: its agents answer when asked, and that's what it should say. */
export function noChartLine(agents: number): string {
  if (agents === 0) return "No agents here yet";
  return `No steps yet. ${agents === 1 ? "Its agent answers" : `Its ${agents} agents answer`} when someone @mentions them.`;
}
