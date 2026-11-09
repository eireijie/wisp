import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentEvent, Approval, Message, Team } from "@wisp/core";
import { api } from "../api.ts";
import { runTaps, useStore, useTeams, type RunEvent } from "../store.ts";
import type { TaskRow } from "../views/TasksView.tsx";

/**
 * Code's data, built from what Wisp already has: a coding task is a task handed to a team that
 * works in a repo. Its agents are whoever holds a piece of it (the lead, the builders it split the
 * work to, the reviewer), and each agent's pane is drawn from its steps in those tasks' threads.
 */

export type PaneState = "working" | "needs" | "done" | "idle";

export interface CodeTask {
  root: TaskRow;
  team: Team;
  /** the root and every piece of it, reviews included */
  family: TaskRow[];
  /** agents in the order they joined the work: the lead first */
  agentIds: string[];
  state: PaneState;
  /** the threads where its agents work, with the channel each is in */
  threads: { threadId: string; channelId: string }[];
}

const DAY = 24 * 60 * 60_000;

export function useCodeTasks(): { tasks: CodeTask[] | null; error: string | null } {
  const version = useStore((s) => s.tasksVersion);
  const approvals = useStore((s) => s.approvals);
  const live = useStore((s) => s.live);
  const teams = useTeams();
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    api<TaskRow[]>("GET", "/api/tasks").then(
      (t) => !gone && (setRows(t), setError(null)),
      (err) => !gone && setError((err as Error).message),
    );
    return () => {
      gone = true;
    };
  }, [version]);

  const tasks = useMemo(() => {
    if (!rows) return null;
    const byId = new Map(rows.map((t) => [t.id, t]));
    const rootOf = (t: TaskRow): TaskRow => {
      let cur = t;
      for (let i = 0; i < 20; i++) {
        const up = cur.reviewOf ? byId.get(cur.reviewOf) : cur.parentId ? byId.get(cur.parentId) : undefined;
        if (!up) return cur;
        cur = up;
      }
      return cur;
    };
    const families = new Map<string, TaskRow[]>();
    for (const t of rows) {
      const r = rootOf(t);
      families.set(r.id, [...(families.get(r.id) ?? []), t]);
    }
    const out: CodeTask[] = [];
    for (const [rootId, family] of families) {
      const root = byId.get(rootId)!;
      const team = teams.find((x) => x.id === root.teamId);
      if (!team?.repo) continue;
      family.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const agentIds = [...new Set(family.map((t) => t.toAgentId).filter((x): x is string => !!x))];
      const threads = family.filter((t) => t.threadId && t.channelId).map((t) => ({ threadId: t.threadId!, channelId: t.channelId! }));
      const inThreads = new Set(threads.map((t) => t.threadId));
      const asking = Object.values(approvals).some((a) => a.status === "pending" && !!a.threadId && inThreads.has(a.threadId));
      const running = Object.values(live).some((r) => (r.threadId && inThreads.has(r.threadId)) || r.threadPath.some((p) => inThreads.has(p)));
      const open = family.some((t) => t.status === "open" || t.status === "in_progress");
      out.push({ root, team, family, agentIds, threads, state: asking ? "needs" : running || open ? "working" : root.status === "done" ? "done" : "idle" });
    }
    return out.sort((a, b) => b.root.updatedAt.localeCompare(a.root.updatedAt));
  }, [rows, teams, approvals, live]);

  return { tasks, error };
}

/** The task list's groups, like the design: what needs you, what's working, what finished today. */
export function groupTasks(tasks: CodeTask[]) {
  const now = Date.now();
  return [
    { label: "Needs you", tasks: tasks.filter((t) => t.state === "needs") },
    { label: "Working", tasks: tasks.filter((t) => t.state === "working") },
    { label: "Done today", tasks: tasks.filter((t) => (t.state === "done" || t.state === "idle") && now - Date.parse(t.root.updatedAt) < DAY) },
    { label: "Earlier", tasks: tasks.filter((t) => (t.state === "done" || t.state === "idle") && now - Date.parse(t.root.updatedAt) >= DAY) },
  ].filter((g) => g.tasks.length > 0);
}

/** "eireijie/shop" from a git URL or a path on the device. */
export function repoName(repo: string | null) {
  if (!repo) return "";
  const clean = repo.replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /[:/]([^/:]+\/[^/:]+)$/.exec(clean);
  return m ? m[1] : clean.split("/").pop() ?? clean;
}

export type LineKind = "ask" | "read" | "edit" | "run" | "out" | "text" | "status" | "error" | "ok";
export interface Line {
  key: string;
  kind: LineKind;
  text: string;
}

const READS = /^(read|view|open|glob|grep|search|ls|list|find|cat|web_?fetch|web_?search|fetch)/i;
const EDITS = /^(edit|write|multi_?edit|apply_?patch|patch|create|str_replace|notebook)/i;
const RUNS = /^(bash|shell|exec|run|terminal|command|local_shell|computer_run)/i;

/** The few words that say what a step touched: the file, the command, the search. */
function argOf(input: unknown): string {
  if (typeof input === "string") return input;
  const i = (input ?? {}) as Record<string, unknown>;
  const cmd = i.command ?? i.cmd;
  if (Array.isArray(cmd)) return cmd.length === 3 && /(^|\/)(ba|z)?sh$/.test(String(cmd[0])) && /^-l?c$/.test(String(cmd[1])) ? String(cmd[2]) : cmd.join(" ");
  if (typeof cmd === "string" && cmd) return unwrapShell(cmd);
  for (const v of [ i.file_path, i.path, i.filePath, i.pattern, i.query, i.url, i.description]) if (typeof v === "string" && v) return v;
  return "";
}

/** `/bin/zsh -lc "npm test"` → `npm test`: harnesses wrap commands in a login shell. */
function unwrapShell(cmd: string) {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd.trim());
  return m ? m[2].replace(m[1] === '"' ? /\\"/g : /'\\''/g, m[1]) : cmd;
}

function shortTool(name: string) {
  return name.replace(/^mcp__[^_]+__/, "").replace(/^[\w-]+\./, "").replace(/^wisp_/, "");
}

/** One step as a terminal line, in the agent's own harness's words. */
export function toolLine(name: string, input: unknown): { kind: LineKind; text: string } {
  const tool = shortTool(name);
  const arg = argOf(input).split("\n")[0].slice(0, 200);
  const kind: LineKind = EDITS.test(tool) ? "edit" : RUNS.test(tool) ? "run" : READS.test(tool) ? "read" : "read";
  const verb = (tool.charAt(0).toUpperCase() + tool.slice(1)).replace(/_/g, " ");
  return { kind, text: `● ${verb}${arg ? `  ${arg}` : ""}` };
}

function outputLines(output: unknown): string[] {
  // a command's result: what it printed, and how it ended when it failed
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  const printed = o ? [o.output, o.stdout, o.formatted_output, o.aggregated_output].find((v) => typeof v === "string") : output;
  const code = o && typeof o.exit_code === "number" && o.exit_code !== 0 ? `exit ${o.exit_code}` : null;
  if (o && printed === undefined && !code) return [];
  const text = [typeof printed === "string" ? printed : printed == null ? "" : JSON.stringify(printed), code].filter(Boolean).join("\n");
  const lines = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length <= 3) return lines.map((l) => l.slice(0, 200));
  return [...lines.slice(0, 2), `… ${lines.length - 2} more lines`].map((l) => l.slice(0, 200));
}

/** An agent's earlier work in a thread, from the messages it posted there. */
export function linesFromMessages(messages: Message[], agentId: string): Line[] {
  const out: Line[] = [];
  for (const m of messages) {
    if (m.author.kind !== "agent" || m.author.id !== agentId || m.deletedAt) continue;
    m.parts.forEach((p, i) => {
      if (p.type === "status") return out.push({ key: `${m.id}:${i}`, kind: /fail|error|could not|couldn't/i.test(p.text) ? "error" : "status", text: p.text });
      if (p.type !== "tool_call") return;
      const l = toolLine(p.name, p.input);
      out.push({ key: `${m.id}:${i}`, ...l });
      if (l.kind === "run" && p.output !== undefined) outputLines(p.output).forEach((t, j) => out.push({ key: `${m.id}:${i}:${j}`, kind: "out", text: `  ${t}` }));
    });
    // markdown marks and the @mention that wakes someone aren't part of what it said
    const said = m.body.replace(/\*\*|__|`/g, "").trim().split("\n").filter(Boolean);
    if (said.length) out.push({ key: `${m.id}:said`, kind: "text", text: said.length > 2 ? `${said[0]} …` : said.join(" ") });
  }
  return out;
}

/** A live step, as it happens. */
export function linesFromEvent(runId: string, n: number, e: AgentEvent): Line[] {
  const key = `${runId}:${n}`;
  switch (e.type) {
    case "tool_call":
      return [{ key, ...toolLine(e.name, e.input) }];
    case "tool_result":
      return RUNS.test(shortTool(e.name)) ? outputLines(e.output).map((t, j) => ({ key: `${key}:${j}`, kind: "out" as const, text: `  ${t}` })) : [];
    case "status":
      return e.text === "started" ? [] : [{ key, kind: "status", text: `✻ ${e.text}` }];
    case "error":
      return [{ key, kind: "error", text: `✕ ${e.message}` }];
    case "notice":
      return [{ key, kind: "status", text: e.text }];
    default:
      return [];
  }
}

/**
 * Everything one agent did on a task: its earlier steps from the threads, then live ones as the
 * hub streams them. Text an agent is writing shows as one line that grows.
 */
export function useAgentLines(task: CodeTask, agent: Agent | undefined): { lines: Line[]; writing: string; runId: string | null } {
  const [history, setHistory] = useState<Line[]>([]);
  const [liveLines, setLive] = useState<Line[]>([]);
  const [writing, setWriting] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const counter = useRef(0);
  const threadKey = task.threads.map((t) => t.threadId).join(",");
  const version = useStore((s) => s.tasksVersion);

  useEffect(() => {
    if (!agent) return;
    let gone = false;
    Promise.all(
      task.threads.map((t) =>
        api<{ messages: Message[] }>("GET", `/api/channels/${t.channelId}/messages?thread=${t.threadId}&limit=200`).then(
          (r) => r.messages,
          () => [] as Message[],
        ),
      ),
    ).then((all) => {
      if (gone) return;
      const messages = all.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setHistory(linesFromMessages(messages, agent.id));
      // finished steps are now in the history; what's still running stays live
      setLive([]);
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, threadKey, version]);

  useEffect(() => {
    if (!agent) return;
    const threads = new Set(task.threads.map((t) => t.threadId));
    const tap = (e: RunEvent) => {
      if (e.agentId !== agent.id) return;
      if (!(e.threadId && threads.has(e.threadId)) && !(e.threadPath ?? []).some((p) => threads.has(p))) return;
      setRunId(e.runId);
      const ev = e.event;
      if (ev.type === "text") return setWriting((w) => (w + ev.text).slice(-400));
      const add = linesFromEvent(e.runId, counter.current++, ev);
      if (add.length) {
        setWriting("");
        setLive((l) => [...l, ...add].slice(-400));
      }
    };
    runTaps.add(tap);
    return () => void runTaps.delete(tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, threadKey]);

  // a run that ended clears what it was writing; its reply comes back through the history
  const running = useStore((s) => (runId ? !!s.live[runId] : false));
  useEffect(() => {
    if (!running) setWriting("");
  }, [running]);

  const header: Line[] = useMemo(() => {
    const mine = task.family.filter((t) => t.toAgentId === agent?.id);
    return mine.map((t) => ({ key: `task:${t.id}`, kind: "ask" as const, text: `> ${t.reviewOf ? "Review: " : ""}${t.title.replace(/^Review: /, "")}` }));
  }, [task.family, agent?.id]);

  return { lines: [...header, ...history, ...liveLines], writing: running ? writing : "", runId: running ? runId : null };
}

/** How an agent stands on this task, for its pane's chip and the status line. */
export function paneState(task: CodeTask, agentId: string, approvals: Record<string, Approval>, liveAgentRuns: boolean): PaneState {
  const inThreads = new Set(task.threads.map((t) => t.threadId));
  if (Object.values(approvals).some((a) => a.status === "pending" && a.agentId === agentId && !!a.threadId && inThreads.has(a.threadId))) return "needs";
  if (liveAgentRuns) return "working";
  const mine = task.family.filter((t) => t.toAgentId === agentId);
  if (mine.some((t) => t.status === "open" || t.status === "in_progress")) return "working";
  return mine.length && mine.every((t) => t.status === "done") ? "done" : "idle";
}
