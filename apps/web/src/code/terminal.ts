import type { Actor, AgentEvent, Message } from "@wisp/core";
import { EDITS, READS, RUNS, argOf, outputLines, shortTool } from "./data.ts";

/**
 * An agent's work drawn as its own CLI's terminal: the prompts it got, the steps it took and what
 * it said, in that harness's own marks (Codex's • and ›, Claude Code's ⏺ ⎿ ❯ ✻, Gemini's ✦ >).
 * Built from the agent's messages (and the messages for it) plus the live run events.
 */

export type TermKind = "prompt" | "step" | "edit" | "run" | "out" | "text" | "working" | "error" | "dim";
export interface TermLine {
  key: string;
  kind: TermKind;
  text: string;
  /** the agent this line is about (a prompt from another agent), for jumping to it */
  from?: string;
}

export interface HarnessStyle {
  /** before a prompt it was given */
  prompt: string;
  /** before a step it took */
  step: (verb: string, arg: string, kind: "read" | "edit" | "run") => string;
  /** before a line a step printed */
  out: string;
  /** before the line it's working on */
  working: string;
  /** before what it said */
  said: string;
}

const CODEX: HarnessStyle = {
  prompt: "›",
  step: (verb, arg, kind) => `• ${kind === "run" ? "Ran" : kind === "edit" ? "Edited" : verb === "Read" || /^read/i.test(verb) ? "Read" : verb}${arg ? ` ${arg}` : ""}`,
  out: "  └ ",
  working: "◦",
  said: "",
};

const CLAUDE: HarnessStyle = {
  prompt: "❯",
  step: (verb, arg) => `⏺ ${verb}${arg ? `(${arg})` : ""}`,
  out: "  ⎿  ",
  working: "✻",
  said: "⏺ ",
};

const GEMINI: HarnessStyle = {
  prompt: ">",
  step: (verb, arg) => `✦ ${verb}${arg ? ` ${arg}` : ""}`,
  out: "  ",
  working: "⠋",
  said: "✦ ",
};

const PLAIN: HarnessStyle = {
  prompt: "›",
  step: (verb, arg) => `● ${verb}${arg ? `  ${arg}` : ""}`,
  out: "  ",
  working: "◦",
  said: "",
};

export function harnessStyle(harness: string): HarnessStyle {
  if (harness === "codex") return CODEX;
  if (harness === "claude-code") return CLAUDE;
  if (harness === "gemini" || harness === "qwen") return GEMINI;
  return PLAIN;
}

/** Tool names as the CLI shows them: Bash, Read, Update, apply_patch… */
function verbOf(name: string): string {
  const tool = shortTool(name);
  return (tool.charAt(0).toUpperCase() + tool.slice(1)).replace(/_/g, " ");
}

function stepKind(name: string): "read" | "edit" | "run" {
  const tool = shortTool(name);
  return EDITS.test(tool) ? "edit" : RUNS.test(tool) ? "run" : READS.test(tool) ? "read" : "read";
}

/** One step as a line, in the harness's own words. */
export function stepLine(style: HarnessStyle, name: string, input: unknown): { kind: TermKind; text: string } {
  const kind = stepKind(name);
  const arg = argOf(input).split("\n")[0].slice(0, 200);
  return { kind: kind === "edit" ? "edit" : kind === "run" ? "run" : "step", text: style.step(verbOf(name), arg, kind) };
}

/** Markdown marks and the @mentions that woke someone, gone; one line of what it said. */
function plain(body: string): string[] {
  return body
    .replace(/\*\*|__|`/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

const isFor = (to: Actor[] | undefined, agentId: string) => !!to?.some((a) => a.kind === "agent" && a.id === agentId);

/**
 * The agent's terminal history: each message for it as a prompt ("› [from Atlas] …"), then the
 * steps and words of each message it wrote. `nameOf` names an actor ("you" for the viewer).
 */
export function termFromMessages(messages: Message[], agentId: string, style: HarnessStyle, nameOf: (a: Actor) => string): TermLine[] {
  const out: TermLine[] = [];
  for (const m of messages) {
    if (m.deletedAt) continue;
    const mine = m.author.kind === "agent" && m.author.id === agentId;
    if (!mine) {
      if (!isFor(m.to, agentId)) continue;
      const said = plain(m.body.replace(/^(@[\w-]+\s*)+/, ""));
      if (!said.length) continue;
      const head = said[0].replace(/^New task\s+/, "");
      out.push({ key: `${m.id}:p`, kind: "prompt", text: `${style.prompt} [from ${nameOf(m.author)}] ${head}`, ...(m.author.kind === "agent" ? { from: m.author.id } : {}) });
      continue;
    }
    m.parts.forEach((p, i) => {
      if (p.type === "status") return out.push({ key: `${m.id}:${i}`, kind: /fail|error|could not|couldn't/i.test(p.text) ? "error" : "dim", text: p.text });
      if (p.type !== "tool_call") return;
      const l = stepLine(style, p.name, p.input);
      out.push({ key: `${m.id}:${i}`, ...l });
      if (l.kind === "run" && p.output !== undefined) outputLines(p.output).forEach((t, j) => out.push({ key: `${m.id}:${i}:${j}`, kind: "out", text: `${style.out}${t}` }));
    });
    const said = plain(m.body);
    if (said.length) {
      // who it's for, when that's another agent: a hand-off reads "→ Ivy"
      const to = (m.to ?? []).filter((a) => a.kind === "agent");
      const lead = to.length ? `→ ${to.map(nameOf).join(", ")}: ` : "";
      const first = said[0].replace(/^(@[\w-]+\s*)+/, "");
      out.push({ key: `${m.id}:said`, kind: "text", text: `${style.said}${lead}${first}${said.length > 1 ? " …" : ""}` });
    }
  }
  return out;
}

/** A live step as it happens. Text being written shows separately, as the working line. */
export function termFromEvent(style: HarnessStyle, runId: string, n: number, e: AgentEvent): TermLine[] {
  const key = `${runId}:${n}`;
  switch (e.type) {
    case "tool_call":
      return [{ key, ...stepLine(style, e.name, e.input) }];
    case "tool_result":
      return stepKind(e.name) === "run" ? outputLines(e.output).map((t, j) => ({ key: `${key}:${j}`, kind: "out" as const, text: `${style.out}${t}` })) : [];
    case "status":
      return e.text === "started" ? [] : [{ key, kind: "dim", text: e.text }];
    case "error":
      return [{ key, kind: "error", text: `✕ ${e.message}` }];
    case "notice":
      return [{ key, kind: "dim", text: e.text }];
    default:
      return [];
  }
}

/** The line it's working on, as its CLI shows it: "◦ Working (12s • esc to interrupt)". */
export function workingText(style: HarnessStyle, what: string, seconds: number): string {
  return `${style.working} ${what} (${seconds}s • esc to interrupt)`;
}
