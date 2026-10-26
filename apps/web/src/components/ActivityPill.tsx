import { useEffect, useRef, useState } from "react";
import { MessageSquare, PanelRight, Square, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type LiveRun } from "../store.ts";
import { describeTool } from "./AgentCards.tsx";
import { AgentAvatar, cx } from "./ui.tsx";
import { activityPhrase, minutesSince, runStartedAt, workKind } from "./agentActivity.ts";
import { useDevices, type DeviceInfo } from "../devices.ts";

/** What one live run is doing, in plain words: "searching memory", or "asking Chief" for a hand-off. */
export function runActivity(run: LiveRun, agents: Agent[]): string {
  if (run.last) {
    const handoff = describeTool(run.last.name, run.last.input, agents);
    if (handoff.with.length) return handoff.text.replace(/…$/, "").replace(/^./, (c) => c.toLowerCase());
  }
  return activityPhrase(run.last?.name, !!run.text);
}

/** "Editing files: notes/release.md", "Reading main.ts", or just "Thinking". */
function workDetail(run: LiveRun, agents: Agent[]): string {
  const base = runActivity(run, agents).replace(/^./, (c) => c.toUpperCase());
  const inp = (run.last?.input ?? {}) as Record<string, unknown>;
  const path = [inp.file_path, inp.path, inp.filename, inp.file].find((v) => typeof v === "string") as string | undefined;
  const kind = run.last ? workKind(run.last.name) : null;
  return path && (kind === "edit" || kind === "read") ? `${base}: ${path.split("/").slice(-2).join("/")}` : base;
}

const nodeName = (nodeId: string | null | undefined, devices: DeviceInfo[] | null) => (nodeId ? devices?.find((d) => d.id === nodeId)?.name : undefined);

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
  const devices = useDevices(15_000);
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
        className="glass max-w-full h-10 pl-2 pr-4 rounded-full inline-flex items-center gap-2.5 text-[14px] hover:bg-hover"
      >
        <span className="flex shrink-0">
          {working.slice(0, 2).map((w, i) => (
            <span key={w.agentId} className={cx("rounded-full ring-2 ring-control bg-control", i > 0 && "-ml-2")}>
              <AgentAvatar agent={w.agent} size={24} live interactive={false} />
            </span>
          ))}
          {working.length > 2 && <span className="-ml-2 size-5 rounded-full ring-2 ring-panel bg-chip text-[10px] font-medium text-muted grid place-items-center">+{working.length - 2}</span>}
        </span>
        <span className="work-dots scale-75" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="truncate">
          <span className="font-medium">{firstName}</span> is {runActivity(first.run, agents)}
        </span>
        {rest && <span className="shrink-0 text-muted">· {rest}</span>}
      </button>
      {open && (
        <div className="max-md:fixed max-md:inset-0 max-md:z-50 max-md:flex max-md:items-end max-md:bg-black/50 max-md:p-3 md:contents" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div role="dialog" aria-label="Working here" className="glass md:absolute md:bottom-full md:left-0 md:mb-2 z-50 w-full md:w-96 md:max-w-[calc(100vw-1.5rem)] rounded-xl p-2 pb-3">
            <div className="flex items-center px-3 pt-2 pb-1">
              <span className="flex-1 text-body font-medium">Working here</span>
              <button type="button" onClick={() => setOpen(false)} className="size-9 rounded-full grid place-items-center text-muted hover:bg-hover" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {working.map((w) => (
              <div key={w.agentId} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
                <AgentAvatar agent={w.agent} size={36} live />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium truncate">{w.agent?.name ?? "Agent"}</div>
                  <div className="text-[13px] text-muted truncate">{workDetail(w.run, agents)}</div>
                  <div className="text-xs text-faint truncate">
                    {nodeName(w.agent?.nodeId, devices) ? `On ${nodeName(w.agent?.nodeId, devices)} · ` : ""}
                    {minutesSince(Math.min(...w.runs.map((r) => runStartedAt(r.runId))))}
                    {/* where: which thread (or the channel itself) */}
                    {w.run.threadId && w.run.threadId !== hereThread ? ` · in ${w.run.threadPath.length ? "a sub-thread of " : ""}“${titles[w.run.threadPath[0] ?? w.run.threadId]}”` : ""}
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    {onThread && w.run.threadId && w.run.threadId !== hereThread && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          onThread(w.run.threadId!);
                        }}
                        className="h-7 px-2.5 rounded-full bg-chip hover:bg-hover text-xs font-medium inline-flex items-center gap-1.5"
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
                      className="h-7 px-2.5 rounded-full bg-chip hover:bg-hover text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <PanelRight size={13} /> Open details
                    </button>
                  </div>
                </div>
                <button type="button" onClick={() => void stopRuns(w.runs)} className="h-9 shrink-0 px-3.5 rounded-full border border-control-line bg-control text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-hover" title={`Stop ${w.agent?.name ?? "it"}`}>
                  <Square size={11} fill="currentColor" /> Stop
                </button>
              </div>
            ))}
            {working.length > 1 && (
              <div className="px-3 pt-1">
                <button type="button" onClick={() => void stopRuns(working.flatMap((w) => w.runs))} className="h-11 w-full rounded-full bg-bad text-body font-medium text-white inline-flex items-center justify-center gap-2">
                  <Square size={12} fill="currentColor" /> Stop all
                </button>
              </div>
            )}
            <p className="px-4 pt-2 text-xs text-muted">Stopping ends what it is doing right now. It keeps the chat.</p>
          </div>
        </div>
      )}
    </div>
  );
}
