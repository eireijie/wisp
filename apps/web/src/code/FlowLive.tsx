import { Fragment } from "react";
import { stepAgentId, workSteps, type Agent, type ChannelTeam } from "@wisp/core";
import { stepRows, titleOf } from "../team/flow.ts";
import { Mini, STATE_COLOR, STATE_LABEL } from "./parts.tsx";
import type { AgentState } from "./useTerminal.ts";

/**
 * A team's flow chart with each agent's live status: its steps left to right (steps that run
 * together stacked), or for a team without steps, its leads and then everyone they hand work to.
 * Clicking a box opens that agent's terminal.
 */
export function FlowLive({ team, agents, states, onOpen }: { team: ChannelTeam; agents: Agent[]; states: Record<string, AgentState>; onOpen: (agentId: string) => void }) {
  const steps = workSteps(team.steps ?? []).filter((s) => s.kind !== "handoff" || stepAgentId(team, s));
  const columns: { key: string; agentId: string | null; label: string }[][] = steps.length
    ? stepRows(steps).map((row) => row.map((s) => ({ key: s.id, agentId: stepAgentId(team, s), label: titleOf(s) })))
    : [
        team.nodes.filter((n) => n.lead).map((n) => ({ key: n.agentId, agentId: n.agentId, label: n.role || "Leads" })),
        team.nodes.filter((n) => !n.lead).map((n) => ({ key: n.agentId, agentId: n.agentId, label: n.role || "Works" })),
      ].filter((c) => c.length);

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-7">
      <div className="flex items-center">
        {columns.map((col, i) => (
          <Fragment key={col.map((c) => c.key).join(",")}>
            {i > 0 && (
              <svg width="48" height="12" viewBox="0 0 48 12" aria-hidden="true" className="shrink-0">
                <path d="M2 6h40M37 1l6 5-6 5" fill="none" stroke="#55555c" strokeWidth="1.5" />
              </svg>
            )}
            <div className="flex flex-col gap-2.5">
              {col.map((c) => {
                const agent = agents.find((a) => a.id === c.agentId);
                const state: AgentState = agent ? (states[agent.id] ?? "idle") : "idle";
                return (
                  <button
                    key={c.key}
                    type="button"
                    disabled={!agent}
                    onClick={() => agent && onOpen(agent.id)}
                    className="m-pane flex w-[150px] flex-col gap-1 rounded-[10px] border bg-[#141417] px-3.5 py-3 text-left transition-[border-color,transform] hover:border-white/20 active:scale-[.98] disabled:cursor-default"
                    style={{ borderColor: state === "needs" ? "rgba(255,179,64,.55)" : "rgba(255,255,255,.09)" }}
                  >
                    <span className="flex items-center gap-[7px]">
                      <Mini agent={agent} size={20} />
                      <span className="truncate text-[13px] font-semibold">{agent?.name ?? "Nobody yet"}</span>
                    </span>
                    <span className="truncate text-[12px] text-[#a1a1aa]">{c.label}</span>
                    <span className="mt-1 text-[11px]" style={{ color: STATE_COLOR[state] }}>
                      {STATE_LABEL[state]}
                    </span>
                  </button>
                );
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
