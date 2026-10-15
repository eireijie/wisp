import type { Agent, Approval, Computer } from "@warren/core";
import type { GhostMood } from "./components/Ghost.tsx";

export type MoodAgent = { id?: string; status?: Agent["status"]; computerId?: string | null };

/** Offline wins; requests and failures stay visible until their underlying state clears. */
export function agentMood(agent: MoodAgent | undefined, approvals: Record<string, Approval>, computers: (Computer & { paused?: boolean })[]): GhostMood {
  if (!agent) return "awake";
  const computer = agent.computerId ? computers.find((c) => c.id === agent.computerId) : undefined;
  if (agent.status === "offline" || computer?.paused) return "asleep";
  if (agent.id && Object.values(approvals).some((a) => a.agentId === agent.id && a.status === "pending")) return "waiting";
  if (computer?.status === "error") return "error";
  return agent.status === "busy" ? "working" : "awake";
}
