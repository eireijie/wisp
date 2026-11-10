import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { harnessLabel, type Agent, type Approval } from "@wisp/core";
import { api } from "../api.ts";
import { agentColor, cx } from "../components/ui.tsx";
import { useStore } from "../store.ts";
import { paneState, useAgentLines, type CodeTask, type LineKind, type PaneState } from "./data.ts";

/**
 * One agent's pane: its steps on this task drawn like its own terminal (Watch), a line to talk
 * to it (Talk, ⌘I), and its requests for your OK right where it asked.
 */

export const STATE_COLOR: Record<PaneState, string> = { working: "#4c9dff", needs: "#ffb340", done: "#3fb950", idle: "#8e8e96" };
export const STATE_LABEL: Record<PaneState, string> = { working: "Working", needs: "Needs you", done: "Done", idle: "Idle" };

const LINE: Record<LineKind, string> = {
  ask: "text-[#f2f2f4]",
  read: "text-[#8e8e96]",
  edit: "text-[#3fb950]",
  run: "text-[#c9d1d9]",
  out: "text-[#8e8e96]",
  text: "text-[#d4d4d8]",
  status: "text-[var(--agent)]",
  error: "text-[#ff6b6b]",
  ok: "text-[#3fb950]",
};

export function GhostIcon({ color, size = 15 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path d="M2 14.5V7a6 6 0 0 1 12 0v7.5l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3z" fill={color} />
      <circle cx="6" cy="7" r="1" fill="#0c0c0e" />
      <circle cx="10" cy="7" r="1" fill="#0c0c0e" />
    </svg>
  );
}

export function AgentPane({
  task,
  agent,
  focused,
  onFocus,
  talking,
  setTalking,
  style,
}: {
  task: CodeTask;
  agent: Agent;
  focused: boolean;
  onFocus: () => void;
  talking: boolean;
  setTalking: (on: boolean) => void;
  style?: CSSProperties;
}) {
  const { lines, writing, runId } = useAgentLines(task, agent);
  const approvals = useStore((s) => s.approvals);
  const state = paneState(task, agent.id, approvals, !!runId);
  const color = agentColor(agent);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inThreads = new Set(task.threads.map((t) => t.threadId));
  const asks = Object.values(approvals).filter((a) => a.status === "pending" && a.agentId === agent.id && !!a.threadId && inThreads.has(a.threadId));

  // stay at the bottom while new steps arrive, unless you scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, writing, asks.length, talking]);

  return (
    <section
      onMouseDown={onFocus}
      aria-label={agent.name}
      style={{ ...style, "--agent": color, borderColor: focused ? color : state === "needs" ? "rgba(255,179,64,.5)" : undefined, boxShadow: focused ? `0 0 0 3px ${color}22` : undefined } as CSSProperties}
      className="m-pane flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[9px] border border-white/[.07] bg-[#111114] transition-[border-color,box-shadow] duration-200"
    >
      <header className={cx("flex h-8 shrink-0 items-center gap-2 border-b border-white/[.06] px-2.5", focused && "bg-white/[.035]")}>
        <GhostIcon color={color} />
        <span className="text-[12.5px] font-semibold text-[#f2f2f4]">{agent.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#8e8e96]">
          {harnessLabel(agent.harness)}
          {agent.model ? ` · ${agent.model}` : ""}
        </span>
        <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[11px]", state === "needs" ? "text-[#ffb340]" : "text-[#a1a1aa]")}>
          <span className={cx("h-[7px] w-[7px] rounded-full", state === "working" && "m-code-pulse")} style={{ background: STATE_COLOR[state] }} />
          {STATE_LABEL[state]}
        </span>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5 font-mono text-[12px] leading-[1.6]"
      >
        <div className="flex-1" />
        {lines.length === 0 && !writing && <div className="text-[#6b6b75]">Nothing yet.</div>}
        {lines.map((l) => (
          <div key={l.key} className={cx("m-code-line shrink-0 truncate whitespace-pre", LINE[l.kind])} title={l.text}>
            {l.text}
          </div>
        ))}
        {writing && <div className="m-code-line shrink-0 truncate whitespace-pre text-[var(--agent)]">✻ {writing.split("\n").filter(Boolean).at(-1)?.slice(-160)}</div>}
        {asks.map((a) => (
          <Ask key={a.id} approval={a} agent={agent} />
        ))}
      </div>
      {talking && focused && <Talk task={task} agent={agent} runId={runId} onDone={() => setTalking(false)} />}
    </section>
  );
}

/** The agent's request for your OK, inside its pane. */
function Ask({ approval, agent }: { approval: Approval; agent: Agent }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<Approval>("POST", `/api/approvals/${approval.id}/decide`, { approve });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="m-fade-in mt-2 rounded-lg border border-[#ffb340]/45 bg-[#ffb340]/[.07] px-3 py-2.5 font-sans">
      <div className="mb-2 text-[12.5px] text-[#f2f2f4]">
        <b>{agent.name} wants to</b> {approval.summary}
        {approval.details && <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12px] text-[#a1a1aa]">{approval.details}</div>}
      </div>
      <div className="flex gap-1.5">
        <button type="button" disabled={busy} onClick={() => decide(true)} className="inline-flex h-7 items-center rounded-[7px] border border-[#f2f2f4] bg-[#f2f2f4] px-2.5 text-[12.5px] font-semibold text-[#0c0c0e] transition-[background-color,transform] hover:bg-white active:scale-[.96] disabled:opacity-50">
          Allow
        </button>
        <button type="button" disabled={busy} onClick={() => decide(false)} className="inline-flex h-7 items-center rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96] disabled:opacity-50">
          Deny
        </button>
      </div>
      {error && <div className="mt-1.5 text-[12px] text-[#ff6b6b]">{error}</div>}
    </div>
  );
}

/** Talk: a message to the agent in its task's thread. Esc twice stops its current step. */
function Talk({ task, agent, runId, onDone }: { task: CodeTask; agent: Agent; runId: string | null; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastEsc = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // the agent's own piece of the task, else the whole task's thread
  const mine = [...task.family].reverse().find((t) => t.toAgentId === agent.id && t.threadId && t.channelId) ?? task.root;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || !mine.threadId || !mine.channelId) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/channels/${mine.channelId}/messages`, { body: `@${agent.handle} ${body}`, threadId: mine.threadId });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className="m-fade-in flex shrink-0 items-center gap-2 border-t border-white/[.06] px-3 py-2">
      <span className="font-mono text-[12px] text-[var(--agent)]">›</span>
      <input
        ref={input}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          const now = Date.now();
          if (runId && now - lastEsc.current < 600) void api("POST", `/api/runs/${runId}/cancel`).catch(() => {});
          else if (!text) onDone();
          lastEsc.current = now;
        }}
        placeholder={`Talk to ${agent.name}`}
        aria-label={`Talk to ${agent.name}`}
        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[#f2f2f4] outline-none placeholder:text-[#6b6b75]"
      />
      {error && <span className="truncate text-[11.5px] text-[#ff6b6b]">{error}</span>}
    </form>
  );
}
