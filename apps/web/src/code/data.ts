import { useEffect, useMemo, useState } from "react";
import type { Team } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import type { TaskRow } from "../views/TasksView.tsx";

/**
 * Code's data about coding work, built from what Wisp already has: a coding task is a task handed
 * to a team that works in a repo, with a branch for each piece (shown in Changes and Files). Also
 * the helpers that read a step's tool call for the terminals (terminal.ts).
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

/** "eireijie/shop" from a git URL or a path on the device. */
export function repoName(repo: string | null) {
  if (!repo) return "";
  const clean = repo.replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /[:/]([^/:]+\/[^/:]+)$/.exec(clean);
  return m ? m[1] : clean.split("/").pop() ?? clean;
}

export const READS = /^(read|view|open|glob|grep|search|ls|list|find|cat|web_?fetch|web_?search|fetch)/i;
export const EDITS = /^(edit|write|multi_?edit|apply_?patch|patch|create|str_replace|notebook)/i;
export const RUNS = /^(bash|shell|exec|run|terminal|command|local_shell|computer_run)/i;

/** The few words that say what a step touched: the file, the command, the search. */
export function argOf(input: unknown): string {
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

export function shortTool(name: string) {
  return name.replace(/^mcp__[^_]+__/, "").replace(/^[\w-]+\./, "").replace(/^wisp_/, "");
}

export function outputLines(output: unknown): string[] {
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
