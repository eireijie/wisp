import { ChevronRight } from "lucide-react";
import type { Agent } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { go } from "../router.ts";
import { Ghost, type GhostMood } from "./Ghost.tsx";
import { cx } from "./ui.tsx";

/**
 * Where an agent lives in its DM: a pill at the top of the conversation with its ghost, which
 * watches your cursor, glances around when left alone, gets busy while it works and dozes while
 * its device is off. Hover it to say hi; click to open the agent.
 */
export function AgentPill({ agent }: { agent: Agent }) {
  const mood: GhostMood = agent.status === "offline" ? "asleep" : agent.status === "busy" ? "thinking" : "awake";
  const look = agent.settings?.appearance ?? defaultAppearance(agent.handle);
  return (
    <button
      onClick={() => go({ view: "agents", agentId: agent.id, tab: "overview" })}
      className="agent-pill inline-flex items-center gap-2 h-12 pl-2 pr-4 rounded-full bg-panel/95 backdrop-blur border border-line shadow-panel hover:bg-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${agent.name}${mood === "thinking" ? ", working" : mood === "asleep" ? ", offline" : ""}. Open its page`}
    >
      <Ghost look={look} size={38} mood={mood} animate trackPointer label={agent.name} />
      <span className="flex flex-col items-start leading-tight">
        <span className={cx("font-semibold text-[15px]", mood === "asleep" && "text-muted")}>{agent.name}</span>
        {mood !== "awake" && <span className="text-[11px] text-muted">{mood === "thinking" ? "working…" : "offline"}</span>}
      </span>
      <span className="agent-pill-arrow text-muted">
        <ChevronRight size={18} />
      </span>
    </button>
  );
}
