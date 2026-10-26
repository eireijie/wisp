import type { Message } from "@wisp/core";
import { workKind } from "./components/agentActivity.ts";

/** Pure helpers for how a conversation reads: time labels, grouping, quotes and tool lines. */

const prettyTool = (n: string) => n.replace(/^mcp__(?:wisp|warren)__/, "").replace(/^mcp__/, "").replace(/^(?:wisp|warren)\./, "");

/** "Today 9:30 PM", "Yesterday 4:02 PM", "Oct 23, 9:30 AM". */
export function stampLabel(iso: string, time: (d: Date) => string): string {
  const d = new Date(iso);
  const now = new Date();
  const t = time(d);
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${t}`;
}

/** A new time label between messages: after 30 quiet minutes, or on a new day. */
export function needsStamp(prev: Message | undefined, m: Message) {
  if (!prev) return true;
  const a = new Date(prev.createdAt);
  const b = new Date(m.createdAt);
  return b.getTime() - a.getTime() > 30 * 60_000 || a.toDateString() !== b.toDateString();
}

export function isGrouped(prev: Message | undefined, m: Message) {
  return !!prev && prev.author.kind === m.author.kind && prev.author.id === m.author.id && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && m.author.id !== "system" && prev.author.id !== "system";
}

/** A few words of a message, for the quote in a reply and the "Replying to" bar. */
export function snippetOf(m: Message): string {
  const text = m.body.replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return m.parts.some((p) => p.type === "file") ? "Attachment" : "";
}

/** One line for a tool call: "Read RELEASE-CHECKLIST.md", "Searched the web", or its name. */
export function toolLine(name: string, input: unknown): string {
  const kind = workKind(name);
  const inp = (input ?? {}) as Record<string, unknown>;
  const path = [inp.file_path, inp.path, inp.filename, inp.file].find((v) => typeof v === "string") as string | undefined;
  const base = path?.split("/").pop();
  if (kind === "read" && base) return `Read ${base}`;
  if (kind === "edit" && base) return `Wrote ${base}`;
  const q = [inp.query, inp.q, inp.pattern].find((v) => typeof v === "string") as string | undefined;
  if ((kind === "web-search" || kind === "find") && q) return `Searched “${q.length > 48 ? `${q.slice(0, 46)}…` : q}”`;
  if (kind === "command" && typeof inp.command === "string") return `Ran ${inp.command.length > 56 ? `${inp.command.slice(0, 54)}…` : inp.command}`;
  return prettyTool(name);
}

