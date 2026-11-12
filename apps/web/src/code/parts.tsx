import type { Agent } from "@wisp/core";
import { defaultAppearance } from "@wisp/core/src/appearance.ts";
import { MiniGhost } from "../components/Ghost.tsx";
import type { AgentState } from "./useTerminal.ts";

/** An agent's ghost at Code's sizes (always the mini ghost). */
export function Mini({ agent, size = 20, ring }: { agent: Pick<Agent, "name" | "handle" | "settings"> | undefined; size?: number; ring?: string }) {
  const look = agent?.settings?.appearance ?? defaultAppearance(agent?.handle ?? agent?.name ?? "agent");
  return <MiniGhost look={look} size={size} ring={ring} />;
}

/** A team: its first agents' mini ghosts, overlapped. */
export function TeamFaces({ agents, size = 17, ring = "#0f0f11" }: { agents: (Agent | undefined)[]; size?: number; ring?: string }) {
  const shown = agents.filter(Boolean).slice(0, 3);
  return (
    <span className="flex shrink-0" style={{ width: size + Math.max(0, shown.length - 1) * (size - 6) }}>
      {shown.map((a, i) => (
        <span key={a!.id} style={{ marginLeft: i ? -6 : 0, zIndex: 3 - i }} className="relative">
          <Mini agent={a} size={size} ring={ring} />
        </span>
      ))}
    </span>
  );
}

export const STATE_LABEL: Record<AgentState, string> = { working: "Working", needs: "Needs you", done: "Done", idle: "Idle" };
export const STATE_COLOR: Record<AgentState, string> = { working: "#4c9dff", needs: "#ffb340", done: "#3fb950", idle: "#71717a" };

/** Live status, as the sidebar shows it: a spinner, a green dot, a gray ring, or Needs you. */
export function StateMark({ state }: { state: AgentState }) {
  if (state === "needs") return <span className="shrink-0 rounded-[5px] bg-[#ffb340]/[.13] px-[7px] py-[2px] text-[11px] font-semibold text-[#ffb340]">Needs you</span>;
  if (state === "working")
    return (
      <svg className="m-code-spin shrink-0" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label="Working">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="rgba(76,157,255,.25)" strokeWidth="1.6" />
        <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="#4c9dff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  if (state === "done") return <span role="img" aria-label="Done" className="mx-0.5 h-2 w-2 shrink-0 rounded-full bg-[#3fb950]" />;
  return <span role="img" aria-label="Idle" className="mx-0.5 box-border h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[#71717a]" />;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl ";
