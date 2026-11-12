import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { harnessLabel, type Agent, type Approval } from "@wisp/core";
import { api } from "../api.ts";
import { TerminalPane, type ShellTarget } from "../components/TerminalPane.tsx";
import { agentColor, cx } from "../components/ui.tsx";
import { href } from "../router.ts";
import { useStore } from "../store.ts";
import { Mini, MOD, STATE_LABEL } from "./parts.tsx";
import { harnessStyle, workingText, type TermKind } from "./terminal.ts";
import { runStartedAt } from "../components/agentActivity.ts";
import { useAgentTerminal, type AgentState } from "./useTerminal.ts";

/**
 * One agent as its own terminal: what it was asked, the steps it took and what it said, drawn in
 * its CLI's style from the runs Wisp already streams. Its requests for your OK are answered right
 * there. Typing underneath is a chat message to it (it shows in your chat with it too), and ⌘⇧K
 * takes its real CLI session, for Claude Code and Codex agents on a device you can open.
 */

/** The harnesses whose session can be taken over (the device resumes it in a terminal). */
const TAKEOVER = new Set(["claude-code", "codex"]);

const KIND: Record<TermKind, string> = {
  prompt: "text-[#c58cf0]",
  step: "text-[#8e8e96]",
  edit: "text-[#3fb950]",
  run: "text-[#c9d1d9]",
  out: "text-[#8e8e96]",
  text: "text-[#f2f2f4]",
  working: "text-[var(--agent)]",
  error: "text-[#ff6b6b]",
  dim: "text-[#8e8e96]",
};

export function AgentTerminal({
  agent,
  state,
  role,
  where,
  focused,
  onFocus,
  onJump,
  shell,
  style,
}: {
  agent: Agent;
  state: AgentState;
  /** its part in the team being shown ("lead", "builds") */
  role?: string;
  /** the computer and folder it works in */
  where: string;
  focused: boolean;
  onFocus: () => void;
  /** open another agent (a prompt line from it was clicked) */
  onJump: (agentId: string) => void;
  /** its device, when you may open shells there (so you can take its keyboard) */
  shell?: ShellTarget;
  style?: CSSProperties;
}) {
  const { lines, working, runId } = useAgentTerminal(agent);
  const termStyle = harnessStyle(agent.harness);
  const color = agentColor(agent);
  const meId = useStore((s) => s.me?.user.id);
  const holder = useStore((s) => s.keyboard[agent.id]);
  const holderName = useStore((s) => (!holder ? null : holder === meId ? "You" : (s.members.find((m) => m.id === holder)?.name ?? "Someone")));
  const approvals = useStore((s) => s.approvals);
  const asks = Object.values(approvals).filter((a) => a.status === "pending" && a.agentId === agent.id);
  const [taking, setTaking] = useState(false);
  const canTake = !!shell && TAKEOVER.has(agent.harness) && (!holder || holder === meId);
  const mineNow = taking || (!!holder && holder === meId);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  // handed back somewhere else (another tab, or the hub after you left): back to watching
  const had = useRef(holder);
  useEffect(() => {
    if (had.current === meId && !holder) setTaking(false);
    had.current = holder;
  }, [holder, meId]);
  const handBack = () => {
    setTaking(false);
    void api("DELETE", `/api/agents/${agent.id}/keyboard`).catch(() => {});
  };
  // ⌘⇧K / ⌘⇧H and "talk" from the view, for the focused pane
  useEffect(() => {
    if (!focused) return;
    const on = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "take" && canTake && !mineNow) setTaking(true);
      else if (what === "back" && mineNow) handBack();
      else if (what === "talk") input.current?.focus();
    };
    window.addEventListener("wisp-code-keyboard", on);
    return () => window.removeEventListener("wisp-code-keyboard", on);
  });

  // stay at the bottom while new steps arrive, unless you scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, working, asks.length]);

  if (mineNow && shell)
    return (
      <div style={style} className="grid min-h-0 min-w-0">
        <TerminalPane
          target={shell}
          session={`${agent.handle}, your keyboard`}
          title={agent.name}
          closeLabel="Hand back"
          focused={focused}
          onFocus={onFocus}
          onClose={handBack}
          open={(code) => api<{ url: string }>("POST", `/api/agents/${agent.id}/keyboard`, { code })}
        />
      </div>
    );

  const needs = state === "needs";
  return (
    <section
      onMouseDown={onFocus}
      aria-label={agent.name}
      style={{ ...style, "--agent": color, borderColor: needs ? "rgba(255,179,64,.55)" : focused ? `${color}99` : undefined } as CSSProperties}
      className="m-pane flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-white/[.08] bg-[#111114] transition-[border-color] duration-200"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[.06] px-2.5">
        <Mini agent={agent} size={16} />
        <span className="text-[12.5px] font-semibold text-[#f2f2f4]">{agent.name}</span>
        {role && <span className="text-[11.5px] text-[#8e8e96]">· {role}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#71717a]">
          {harnessLabel(agent.harness)}
          {where ? ` · ${where}` : ""}
        </span>
        <span className={cx("whitespace-nowrap text-[11px]", needs ? "text-[#ffb340]" : holder ? "text-[#c08cff]" : "text-[#8e8e96]")}>{holder ? `${holderName} has the keyboard` : STATE_LABEL[state]}</span>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-2.5 font-mono text-[12px] leading-[1.62]"
      >
        <div className="flex-1" />
        {lines.length === 0 && !working && <div className="text-[#6b6b75]">Nothing yet.</div>}
        {lines.map((l) =>
          l.from ? (
            <button key={l.key} type="button" onClick={() => onJump(l.from!)} title={l.text} className={cx("m-code-line shrink-0 truncate whitespace-pre text-left hover:underline", KIND[l.kind])}>
              {l.text}
            </button>
          ) : (
            <div key={l.key} title={l.text} className={cx("m-code-line shrink-0 truncate whitespace-pre", KIND[l.kind])}>
              {l.text}
            </div>
          ),
        )}
        {working && <Working style={termStyle} text={working.text} writing={working.writing} runId={runId} />}
        {asks.map((a) => (
          <Ask key={a.id} approval={a} agent={agent} />
        ))}
      </div>
      <Talk agent={agent} runId={runId} mark={termStyle.prompt} input={input} keysHint={canTake ? `${MOD}⇧K keyboard` : ""} />
    </section>
  );
}

/** The line it's on now: what it's writing, or "◦ Running a command (12s • esc to interrupt)". */
function Working({ style, text, writing, runId }: { style: ReturnType<typeof harnessStyle>; text: string; writing: boolean; runId: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = runId ? Math.max(0, Math.round((Date.now() - runStartedAt(runId)) / 1000)) : 0;
  return <div className="shrink-0 truncate whitespace-pre text-[var(--agent)]">{writing ? `${style.said}${text}` : workingText(style, text, seconds)}</div>;
}

/** Its request for your OK, as its CLI asks: answered right here or in Inbox. */
function Ask({ approval, agent }: { approval: Approval; agent: Agent }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a device's screen code, a login or a team step is answered with more than yes or no
  const elsewhere = !!(approval.device || approval.login || approval.flow);
  const decide = async (approve: boolean, note = "") => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<Approval>("POST", `/api/approvals/${approval.id}/decide`, { approve, note });
      useStore.setState((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="m-fade-in mt-2 shrink-0 rounded-md border border-[#ffb340]/50 px-3 py-2.5">
      <div className="text-[#ffb340]">
        Allow {agent.name} to {approval.summary.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/[.?]$/, "")}?
      </div>
      {approval.details && <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[#f2f2f4]">{approval.details}</div>}
      {elsewhere ? (
        <a href={href({ view: "dashboard" })} className="mt-2 inline-block text-[#6aa2ff] hover:text-[#9cc2ff]">
          Answer in Inbox
        </a>
      ) : why !== null ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void decide(false, why);
          }}
        >
          <span className="text-[#a1a1aa]">›</span>
          <input autoFocus value={why} disabled={busy} onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setWhy(null))} placeholder={`Tell ${agent.name} why`} aria-label={`Tell ${agent.name} why`} className="min-w-0 flex-1 bg-transparent text-[#f2f2f4] outline-none placeholder:text-[#6b6b75]" />
        </form>
      ) : (
        <div className="mt-2 flex flex-wrap gap-[18px]">
          <button type="button" disabled={busy} onClick={() => decide(true)} className="rounded-[4px] bg-[#f2f2f4] px-2 py-px text-[#0c0c0e] transition-transform active:scale-[.96] disabled:opacity-50">
            › 1. Yes
          </button>
          <button type="button" disabled={busy} onClick={() => setWhy("")} className="py-px text-[#a1a1aa] hover:text-[#f2f2f4] disabled:opacity-50">
            2. No, tell {agent.name} why
          </button>
        </div>
      )}
      {error && <div className="mt-1.5 text-[#ff6b6b]">{error}</div>}
    </div>
  );
}

/** A line under the terminal: what you type is a message in your chat with the agent. Esc twice stops its current step. */
function Talk({ agent, runId, mark, input, keysHint }: { agent: Agent; runId: string | null; mark: string; input: React.RefObject<HTMLInputElement | null>; keysHint: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastEsc = useRef(0);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const dm = await api<{ id: string }>("POST", `/api/dm/${agent.id}`);
      await api("POST", `/api/channels/${dm.id}/messages`, { body });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <form onSubmit={send} className="flex h-[34px] shrink-0 items-center gap-2 border-t border-white/[.07] px-2.5">
      <span className="font-mono text-[12px] text-[#8e8e96]">{mark}</span>
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
          else if (text) setText("");
          else input.current?.blur();
          lastEsc.current = now;
        }}
        placeholder={`Talk to ${agent.name}. It shows in your chat with ${agent.name} too`}
        aria-label={`Talk to ${agent.name}`}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#f2f2f4] outline-none placeholder:text-[#71717a]"
      />
      {error ? <span className="truncate text-[11.5px] text-[#ff6b6b]">{error}</span> : keysHint && <span className="hidden font-mono text-[10.5px] text-[#71717a] sm:inline">{keysHint}</span>}
    </form>
  );
}
