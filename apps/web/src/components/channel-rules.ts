import type { ChannelSettings } from "@wisp/core";

/** The part of a channel's settings the Agents form owns. The team's flow is saved by the builder, so this form never sends it back. */
export type AgentRules = Pick<ChannelSettings, "defaultAgentId" | "replyInThread" | "instructions">;

export const agentRulesOf = (s: AgentRules): AgentRules => ({ defaultAgentId: s.defaultAgentId, replyInThread: s.replyInThread, instructions: s.instructions });
