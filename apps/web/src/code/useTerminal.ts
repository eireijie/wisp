import { useEffect, useMemo, useRef, useState } from "react";
import type { Actor, Agent, Approval, Message } from "@wisp/core";
import { api } from "../api.ts";
import { workingLine } from "../components/agentActivity.ts";
import { messageTaps, runTaps, useStore, type RunEvent } from "../store.ts";
import { harnessStyle, termFromEvent, termFromMessages, type TermLine } from "./terminal.ts";

export type AgentState = "working" | "needs" | "done" | "idle";

/** How an agent stands, for the sidebar, its pane and its team: needs you, working, done since you looked, or idle. */
export function agentState(agent: Agent, approvals: Record<string, Approval>, live: Record<string, { agentId: string }>, finished: Record<string, number>): AgentState {
  if (Object.values(approvals).some((a) => a.status === "pending" && a.agentId === agent.id)) return "needs";
  if (agent.status === "busy" || Object.values(live).some((r) => r.agentId === agent.id)) return "working";
  return finished[agent.id] ? "done" : "idle";
}

/** A team's state: needs you if anyone does, else working if anyone is, else done or idle. */
export function teamState(states: AgentState[]): AgentState {
  return states.includes("needs") ? "needs" : states.includes("working") ? "working" : states.includes("done") ? "done" : "idle";
}

export function useAgentStates(): Record<string, AgentState> {
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const live = useStore((s) => s.live);
  const finished = useStore((s) => s.finished);
  return useMemo(() => Object.fromEntries(agents.map((a) => [a.id, agentState(a, approvals, live, finished)])), [agents, approvals, live, finished]);
}

/** Names as the terminal and the between-agents list say them: "you" for whoever is looking. */
export function useNameOf(): (a: Actor) => string {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me?.user.id);
  return useMemo(
    () => (a: Actor) => (a.kind === "agent" ? (agents.find((x) => x.id === a.id)?.name ?? "an agent") : a.id === me ? "you" : a.id === "system" ? "Wisp" : (members.find((m) => m.id === a.id)?.name ?? "someone")),
    [agents, members, me],
  );
}

const concerns = (m: Message, agentId: string) => (m.author.kind === "agent" && m.author.id === agentId) || !!m.to?.some((t) => t.kind === "agent" && t.id === agentId);

/**
 * Everything an agent did, as its terminal: its history from the hub (its messages and the ones
 * for it, in every chat you can see), then live steps as its runs stream them. What it's writing
 * shows as one working line.
 */
export function useAgentTerminal(agent: Agent): { lines: TermLine[]; working: string | null; runId: string | null } {
  const style = harnessStyle(agent.harness);
  const nameOf = useNameOf();
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveLines, setLive] = useState<TermLine[]>([]);
  const [writing, setWriting] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const counter = useRef(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let gone = false;
    api<{ messages: Message[] }>("GET", `/api/agents/${agent.id}/log?limit=120`).then(
      (r) => {
        if (gone) return;
        setMessages(r.messages);
        // finished steps are in the history now
        setLive([]);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [agent.id, reload]);

  // a new message from or for it: add it, then catch up with the hub (a step's output lands in its reply)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tap = (m: Message) => {
      if (!concerns(m, agent.id)) return;
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      if (m.author.kind === "agent" && m.author.id === agent.id) {
        setLive([]);
        setWriting("");
      }
      clearTimeout(timer);
      timer = setTimeout(() => setReload((n) => n + 1), 1500);
    };
    messageTaps.add(tap);
    return () => {
      messageTaps.delete(tap);
      clearTimeout(timer);
    };
  }, [agent.id]);

  useEffect(() => {
    const tap = (e: RunEvent) => {
      if (e.agentId !== agent.id) return;
      setRunId(e.runId);
      const ev = e.event;
      if (ev.type === "text") return setWriting((w) => (w + ev.text).slice(-400));
      const add = termFromEvent(style, e.runId, counter.current++, ev);
      if (add.length) {
        setWriting("");
        setLive((l) => [...l, ...add].slice(-300));
      }
    };
    runTaps.add(tap);
    return () => void runTaps.delete(tap);
  }, [agent.id, style]);

  const run = useStore((s) => Object.values(s.live).find((r) => r.agentId === agent.id) ?? null);
  const running = !!run || agent.status === "busy";
  useEffect(() => {
    if (!running) setWriting("");
  }, [running]);

  const history = useMemo(() => termFromMessages(messages, agent.id, style, nameOf), [messages, agent.id, style, nameOf]);
  const said = writing.split("\n").filter(Boolean).at(-1)?.slice(-160);
  const working = running ? (said ? `${style.said}${said}` : workingLine(run?.last?.name ?? null, !!run?.text)) : null;
  return { lines: [...history, ...liveLines].slice(-400), working, runId: run?.runId ?? (running ? runId : null) };
}
