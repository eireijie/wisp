import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codex, parseAcpUpdate, parseClaudeLine, type AdapterEvent } from "../src/index.ts";

/**
 * Recorded harness output, shaped like the 2026-11-08 feature test's Codex run: the agent says a
 * line, searches memory and runs a command, then answers. Only its own words may reach the reply
 * text; every tool call and its output comes through as tool events.
 */
const MEMORY_HIT = { content: [{ type: "text", text: "agents/agt_1/First chat.md — Getting to know Sam" }], structured_content: null };
const leaked = (events: AdapterEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");

function expectClean(events: AdapterEvent[], reply: string) {
  const text = leaked(events);
  expect(text).toContain(reply);
  expect(text).not.toMatch(/memory_search|structured_content|First chat\.md|"content"|\bls -la\b|total 8/);
  expect(events.some((e) => e.type === "tool_call")).toBe(true);
  expect(events.some((e) => e.type === "tool_result")).toBe(true);
}

describe("reply text holds only the agent's words", () => {
  it("Codex (codex exec --json), run end to end", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-codex-reply-"));
    const lines = [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "1", type: "agent_message", text: "I'm using the memory skill." } },
      { type: "item.started", item: { id: "2", type: "mcp_tool_call", server: "wisp", tool: "memory_search", arguments: { query: "Sam" }, status: "in_progress" } },
      { type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "wisp", tool: "memory_search", arguments: { query: "Sam" }, result: MEMORY_HIT, status: "completed" } },
      { type: "item.started", item: { id: "3", type: "command_execution", command: "ls -la", status: "in_progress" } },
      { type: "item.completed", item: { id: "3", type: "command_execution", command: "ls -la", aggregated_output: "total 8\nnotes.md", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "4", type: "agent_message", text: "I can be your GitHub issue coordinator." } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ];
    const bin = path.join(dir, "codex");
    await fs.writeFile(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' ${lines.map((l) => `'${JSON.stringify(l).replace(/'/g, "'\\''")}'`).join(" ")}\n`, { mode: 0o755 });
    const events: AdapterEvent[] = [];
    const res = await { ...codex, binary: bin }.run({ prompt: "hi", cwd: dir }, (e) => events.push(e));
    expectClean(events, "I can be your GitHub issue coordinator.");
    // messages before the answer stay apart from it while streaming; the reply is the answer
    expect(leaked(events)).toBe("I'm using the memory skill.\n\nI can be your GitHub issue coordinator.");
    expect(res.finalText).toBe("I can be your GitHub issue coordinator.");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("Claude Code (stream-json)", () => {
    const tools = new Map<string, string>();
    const streamed = new Set<string>();
    const lines = [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "mcp__wisp__memory_search", input: { query: "Sam" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify(MEMORY_HIT) }] }] } },
      { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls -la" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "total 8\nnotes.md" }] } },
      { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Here's what I found." }] } },
    ];
    expectClean(lines.flatMap((l) => parseClaudeLine(l, tools, streamed)), "Here's what I found.");
  });

  it("ACP harnesses (Hermes, Gemini, OpenCode and the rest)", () => {
    const tools = new Map<string, string>();
    const updates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking now. " } },
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "memory_search", kind: "other", status: "pending", rawInput: { query: "Sam" }, _meta: { toolName: "mcp__wisp__memory_search" } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: JSON.stringify(MEMORY_HIT) } }] },
      { sessionUpdate: "tool_call", toolCallId: "c2", title: "ls -la", kind: "execute", status: "completed", rawInput: { command: "ls -la" }, rawOutput: "total 8\nnotes.md" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    ];
    expectClean(updates.flatMap((u) => parseAcpUpdate(u, tools)), "Looking now. Done.");
  });
});
