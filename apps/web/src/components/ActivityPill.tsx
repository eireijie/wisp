import { useEffect, useRef, useState } from "react";
import { MessageSquare, PanelRight, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type LiveRun } from "../store.ts";
import { describeTool } from "./AgentCards.tsx";
import { AgentAvatar, cx } from "./ui.tsx";
import { activityPhrase, minutesSince, runStartedAt } from "./agentActivity.ts";

/** What one live run is doing, in plain words: "searching memory", or "asking Chief" for a hand-off. */
export function runActivity(run: LiveRun, agents: Agent[]): string {
  if (run.last) {
    const handoff = describeTool(run.last.name, run.last.input, agents);
    if (handoff.with.length) return handoff.text.replace(/…$/, "").replace(/^./, (c) => c.toLowerCase());
  }
  return activityPhrase(run.last?.name, !!run.text);
}

/** Stop every run an agent has going here. */
export function stopRuns(runs: LiveRun[]) {
  return Promise.all(runs.map((r) => api("POST", `/api/runs/${r.runId}/cancel`).catch(() => {})));
}

/**
 * Buzz's bot activity bar, above the composer: the working agents' ghosts (two, then "+N"), a
 * green dot and "Nova is editing files". Hover or click lists each one with what it's doing,
 * how long it's been at it, Stop, and a way into its details.
 */
/** A thread's first words, to say where an agent is working: "in “Plan the launch…”". */
function useThreadTitles(runs: LiveRun[]): Record<string, string> {
  return useStore(
    useShallow((s) => {
      const out: Record<string, string> = {};
      for (const r of runs) {
        // a sub-thread is named after the thread at the top of it
        const id = r.threadPath[0] ?? r.threadId;
        if (!id || out[id]) continue;
        const m = s.messages[r.channelId]?.find((x) => x.id === id) ?? s.roots[id] ?? Object.values(s.threads).flat().find((x) => x.id === id);
        const text = m?.body.replace(/@[\w-]+\s*/g, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
        out[id] = text ? (text.length > 36 ? `${text.slice(0, 34)}…` : text) : "a thread";
      }
      return out;
    }),
  );
}

export function ActivityPill({ runs, onDetails, onThread, hereThread = null }: { runs: LiveRun[]; onDetails: (agentId: string) => void; onThread?: (threadId: string) => void; hereThread?: string | null }) {
  const agents = useStore((s) => s.agents);
  const titles = useThreadTitles(runs);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);

  // one row per agent; its newest run says what it's doing
  const byAgent = new Map<string, LiveRun[]>();
  for (const r of runs) {
    runStartedAt(r.runId); // start its clock the first time it shows up
    byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  }
  const working = [...byAgent.entries()].map(([agentId, list]) => ({ agentId, agent: agents.find((a) => a.id === agentId), runs: list, run: list.at(-1)! }));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", away);
    // the minutes count up while it's open
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", away);
      clearInterval(t);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(hover.current), []);
  useEffect(() => {
    if (!working.length) setOpen(false);
  }, [working.length]);

  if (!working.length) return null;
  const [first, ...others] = working;
  const firstName = first.agent?.name ?? "An agent";
  const rest = others.length ? (others.length === 1 ? (others[0].agent?.name ?? "1 more") : `${others[0].agent?.name ?? "someone"} +${others.length - 1}`) : null;
  const summary = `${firstName} is ${runActivity(first.run, agents)}${rest ? `, also ${rest}` : ""}`;

  return (
    <div
      ref={ref}
      className="relative self-start max-w-full"
      onMouseEnter={() => {
        clearTimeout(hover.current);
        hover.current = setTimeout(() => setOpen(true), 250);
      }}
      onMouseLeave={() => {
        clearTimeout(hover.current);
        hover.current = setTimeout(() => setOpen(false), 300);
      }}
    >
      <button
        type="button"
        onClick={() => (clearTimeout(hover.current), setOpen((o) => !o))}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={summary}
        className="max-w-full h-8 pl-1.5 pr-3 rounded-full border border-line bg-panel shadow-panel inline-flex items-center gap-2 text-[13px] hover:bg-hover"
      >
        <span className="flex shrink-0">
          {working.slice(0, 2).map((w, i) => (
            <span key={w.agentId} className={cx("rounded-full ring-2 ring-panel bg-panel", i > 0 && "-ml-2")}>
              <AgentAvatar agent={w.agent} size={20} live interactive={false} />
            </span>
          ))}
          {working.length > 2 && <span className="-ml-2 size-5 rounded-full ring-2 ring-panel bg-chip text-[10px] font-semibold text-muted grid place-items-center">+{working.length - 2}</span>}
        </span>
        <span className="size-1.5 shrink-0 rounded-full bg-ok animate-pulse" aria-hidden />
        <span className="truncate">
          <span className="font-semibold">{firstName}</span> is {runActivity(first.run, agents)}
        </span>
        {rest && <span className="shrink-0 text-muted">· {rest}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Agents working here" className="glass absolute bottom-full left-0 mb-2 z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-2xl p-1.5">
          {working.map((w) => (
            <div key={w.agentId} className="flex items-start gap-3 rounded-xl px-2.5 py-2">
              <AgentAvatar agent={w.agent} size={32} live />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{w.agent?.name ?? "Agent"}</div>
                <div className="text-xs text-muted">
                  {runActivity(w.run, agents).replace(/^./, (c) => c.toUpperCase())} · {minutesSince(Math.min(...w.runs.map((r) => runStartedAt(r.runId))))}
                </div>
                {/* where: which thread (or the channel itself) */}
                {w.run.threadId && w.run.threadId !== hereThread && (
                  <div className="text-xs text-muted truncate">
                    in {w.run.threadPath.length ? "a sub-thread of " : ""}“{titles[w.run.threadPath[0] ?? w.run.threadId]}”
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-1">
                  {onThread && w.run.threadId && w.run.threadId !== hereThread && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onThread(w.run.threadId!);
                      }}
                      className="h-7 px-2.5 rounded-lg bg-chip hover:bg-hover text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <MessageSquare size={13} /> Open thread
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onDetails(w.agentId);
                    }}
                    className="h-7 px-2.5 rounded-lg bg-chip hover:bg-hover text-xs font-medium inline-flex items-center gap-1.5"
                  >
                    <PanelRight size={13} /> Open details
                  </button>
                  <button type="button" onClick={() => void stopRuns(w.runs)} className="h-7 px-2.5 rounded-lg text-xs font-medium text-muted hover:text-bad hover:bg-hover inline-flex items-center gap-1.5" title={`Stop ${w.agent?.name ?? "it"}`}>
                    <Square size={11} /> Stop
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
