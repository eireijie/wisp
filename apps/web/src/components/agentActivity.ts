/**
 * Plain words for what an agent is doing, from the tools it calls: "searching memory", "editing
 * files", "using its computer". Used by the composer's activity pill, the agent pane's step list
 * and the one-line work summary under a finished message. No React here, so it's easy to test.
 */

/** A kind of work, with how to say it while it happens and once it's done. */
export type WorkKind = "memory-read" | "memory-write" | "computer" | "help" | "edit" | "read" | "find" | "command" | "web-search" | "browse" | "approval" | "routine" | "tasks" | "plan" | "post" | "delegate" | "discuss" | "other";

const WORDS: Record<WorkKind, { now: string; done: string; count?: (n: number) => string }> = {
  "memory-read": { now: "searching memory", done: "checked memory" },
  "memory-write": { now: "updating memory", done: "saved to memory" },
  computer: { now: "using its computer", done: "used its computer" },
  help: { now: "waiting for your help on its computer", done: "asked for help on its computer" },
  edit: { now: "editing files", done: "edited files", count: (n) => `edited ${n} ${n === 1 ? "file" : "files"}` },
  read: { now: "reading files", done: "read files", count: (n) => `read ${n} ${n === 1 ? "file" : "files"}` },
  find: { now: "looking through files", done: "looked through files" },
  command: { now: "running a command", done: "ran a command", count: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`) },
  "web-search": { now: "searching the web", done: "searched the web" },
  browse: { now: "browsing", done: "browsed the web", count: (n) => `read ${n} ${n === 1 ? "page" : "pages"}` },
  approval: { now: "waiting for your OK", done: "asked for your OK" },
  routine: { now: "saving a routine", done: "saved a routine" },
  tasks: { now: "updating tasks", done: "updated tasks" },
  plan: { now: "planning", done: "made a plan" },
  post: { now: "posting an update", done: "posted an update" },
  delegate: { now: "handing off a task", done: "handed off a task" },
  discuss: { now: "talking it through", done: "talked it through" },
  other: { now: "working", done: "used a tool", count: (n) => (n === 1 ? "used a tool" : `used ${n} tools`) },
};

/** "mcp__wisp__memory_search" → "memory_search"; "WebFetch" → "webfetch". */
export function toolKey(name: string): string {
  return name
    .replace(/^mcp__(?:wisp|warren)__/, "")
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^mcp__/, "")
    .replace(/^(?:wisp|warren)\./, "")
    .toLowerCase();
}

/** Which kind of work a tool call is. */
export function workKind(name: string): WorkKind {
  const t = toolKey(name);
  if (t === "computer_ask_human") return "help";
  if (t.startsWith("computer_") || t === "computer") return "computer";
  if (t === "memory_remember" || t === "memory_write" || t === "memory_append") return "memory-write";
  if (t.startsWith("memory_") || t.startsWith("vault_")) return "memory-read";
  if (t === "approval_request") return "approval";
  if (t === "routine_save" || t.startsWith("routine_")) return "routine";
  if (t === "task_delegate") return "delegate";
  if (t.startsWith("task_")) return "tasks";
  if (t === "chat_send") return "post";
  if (t === "discussion_start" || t.startsWith("discussion_")) return "discuss";
  if (/^(todowrite|todo_write|todo|update_plan|plan|think)$/.test(t)) return "plan";
  if (/^(edit|multiedit|write|apply_patch|str_replace|str_replace_editor|notebookedit|file_write|file_edit|create_file|write_file|edit_file|replace)$/.test(t)) return "edit";
  if (/^(read|file_view|view|cat|read_file|notebookread|open_file|view_image)$/.test(t)) return "read";
  if (/^(glob|grep|ls|list_dir|list_directory|find|search_files|codebase_search|file_search)$/.test(t)) return "find";
  if (/^(bash|shell|exec|exec_command|run|run_command|terminal|command|local_shell|powershell|killshell|bashoutput)$/.test(t)) return "command";
  if (/(web_?search|search_web|google)/.test(t)) return "web-search";
  if (/(web_?fetch|fetch|browse|browser|navigate|url|web)/.test(t)) return "browse";
  return "other";
}

/** "searching memory": what it's doing right now, in a few plain words. */
export function activityPhrase(name: string | null | undefined, writing = false): string {
  if (!name) return writing ? "writing a reply" : "thinking";
  return WORDS[workKind(name)].now;
}

export interface WorkStep {
  kind: WorkKind;
  text: string;
  count: number;
  /** the one happening right now */
  now: boolean;
}

/**
 * A run's tool calls as a short list of steps: repeats of the same kind of work fold into one,
 * the last step is happening now (while the run is live), the rest are done.
 */
export function workSteps(tools: string[], live: boolean): WorkStep[] {
  const steps: { kind: WorkKind; count: number }[] = [];
  for (const t of tools) {
    const kind = workKind(t);
    const last = steps.at(-1);
    if (last && last.kind === kind) last.count++;
    else steps.push({ kind, count: 1 });
  }
  return steps.map((s, i) => {
    const now = live && i === steps.length - 1;
    const words = WORDS[s.kind];
    const text = now ? words.now : s.count > 1 && words.count ? words.count(s.count) : words.done;
    return { kind: s.kind, count: s.count, now, text: capitalize(text) };
  });
}

/**
 * One line for a finished reply's tool calls, like "Searched the web · read 6 pages". Kinds are
 * listed in the order they first happened; at most three, then "+N more".
 */
export function workSummary(tools: { name: string; input?: unknown }[]): string {
  if (!tools.length) return "";
  const order: WorkKind[] = [];
  const counts = new Map<WorkKind, number>();
  const files = new Map<WorkKind, Set<string>>();
  for (const t of tools) {
    const kind = workKind(t.name);
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    // edits to the same file count once
    const inp = (t.input ?? {}) as Record<string, unknown>;
    const path = typeof inp.file_path === "string" ? inp.file_path : typeof inp.path === "string" ? inp.path : null;
    if (path && (kind === "edit" || kind === "read")) {
      const set = files.get(kind) ?? new Set<string>();
      set.add(path);
      files.set(kind, set);
    }
  }
  const parts = order.map((kind) => {
    const n = files.get(kind)?.size || counts.get(kind)!;
    const words = WORDS[kind];
    return words.count ? words.count(n) : words.done;
  });
  const shown = parts.slice(0, 3);
  if (parts.length > 3) shown.push(`+${parts.length - 3} more`);
  return capitalize(shown.join(" · "));
}

/** "Working · 12 min" style durations. */
export function minutesSince(startedAt: number, now = Date.now()): string {
  const min = Math.floor((now - startedAt) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

// when each live run was first seen in this tab; runs don't carry a start time
const firstSeen = new Map<string, number>();
export function runStartedAt(runId: string): number {
  let at = firstSeen.get(runId);
  if (at === undefined) firstSeen.set(runId, (at = Date.now()));
  return at;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
