import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acpAdapter, acpModels, deviceAdapters, parseAcpUpdate, permissionOutcome, type AdapterEvent } from "../src/index.ts";

const FAKE = fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url));

function setup(mode?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warren-acp-test-"));
  const logFile = path.join(dir, "log.jsonl");
  const adapter = acpAdapter({ id: "fake", label: "Fake", binary: process.execPath, args: [FAKE] });
  const env = { FAKE_ACP_LOG: logFile, ...(mode ? { FAKE_ACP_MODE: mode } : {}) };
  const received = () =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { dir, adapter, env, received };
}

const mcp = { command: "node", args: ["warren-mcp.mjs"], env: { WARREN_URL: "http://hub", WARREN_TOKEN: "t", WARREN_AGENT: "a1" } };

describe("ACP adapter", () => {
  it("runs a prompt: starts a session with Warren's tools, streams tool calls and text, answers permissions", async () => {
    const { dir, adapter, env, received } = setup();
    const events: AdapterEvent[] = [];
    const res = await adapter.run({ prompt: "hi there", cwd: dir, env, mcp, model: "m2", access: "full" }, (e) => events.push(e));
    expect(res).toEqual({ finalText: "Hello world (8 chars)", sessionId: "sess-1" });
    expect(events).toContainEqual({ type: "session", id: "sess-1" });
    expect(events).toContainEqual({ type: "tool_call", name: "warren.memory_search", input: { query: "launch" } });
    expect(events).toContainEqual({ type: "tool_result", name: "warren.memory_search", output: "found 2 notes" });
    expect(events).toContainEqual({ type: "tool_result", name: "execute: rm -rf build", output: "removed" });

    const msgs = received();
    const newSession = msgs.find((m) => m.method === "session/new");
    expect(newSession.params.cwd).toBe(dir);
    expect(newSession.params.mcpServers).toEqual([{ name: "warren", command: "node", args: ["warren-mcp.mjs"], env: [{ name: "WARREN_URL", value: "http://hub" }, { name: "WARREN_TOKEN", value: "t" }, { name: "WARREN_AGENT", value: "a1" }] }]);
    expect(msgs.find((m) => m.method === "session/set_model").params).toEqual({ sessionId: "sess-1", modelId: "m2" });
    // full access switches the agent to its no-approvals mode
    expect(msgs.find((m) => m.method === "session/set_mode").params).toEqual({ sessionId: "sess-1", modeId: "yolo" });
    expect(msgs.find((m) => m.id !== undefined && !m.method)?.result).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
  });

  it("resumes a session without replaying its history into the reply", async () => {
    const { dir, adapter, env, received } = setup();
    const res = await adapter.run({ prompt: "again", cwd: dir, env, sessionId: "sess-1", access: "read-only" }, () => {});
    expect(res.finalText).toBe("Hello world (5 chars)");
    expect(res.finalText).not.toContain("OLD HISTORY");
    expect(received().some((m) => m.method === "session/new")).toBe(false);
    // read-only agents don't get to run commands
    expect(received().find((m) => m.id !== undefined && !m.method)?.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  it("starts fresh when the old session is gone", async () => {
    const { dir, adapter, env, received } = setup();
    const res = await adapter.run({ prompt: "x", cwd: dir, env, sessionId: "expired" }, () => {});
    expect(res.sessionId).toBe("sess-1");
    expect(received().some((m) => m.method === "session/new")).toBe(true);
  });

  it("still runs when the agent refuses per-session MCP servers, and says so", async () => {
    const { dir, adapter, env } = setup("reject-mcp");
    const events: AdapterEvent[] = [];
    const res = await adapter.run({ prompt: "x", cwd: dir, env, mcp }, (e) => events.push(e));
    expect(res.finalText).toMatch(/^Hello world/);
    expect(events.some((e) => e.type === "status" && /warren-mcp/.test(e.text))).toBe(true);
  });

  it("reports a missing binary as an error", async () => {
    const adapter = acpAdapter({ id: "nope", label: "Nope", binary: "warren-no-such-binary", args: [] });
    await expect(adapter.run({ prompt: "x", cwd: os.tmpdir() }, () => {})).rejects.toThrow();
  });
});

describe("ACP pieces", () => {
  it("maps updates", () => {
    const tools = new Map<string, string>();
    expect(parseAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, tools)).toEqual([{ type: "text", text: "hi" }]);
    expect(parseAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "a", title: "mcp__warren__chat_send", kind: "other", rawInput: { channel: "general" } }, tools)).toEqual([
      { type: "tool_call", name: "warren.chat_send", input: { channel: "general" } },
    ]);
    expect(parseAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed", rawOutput: "nope" }, tools)).toEqual([{ type: "tool_result", name: "warren.chat_send", output: { error: "nope" } }]);
    expect(parseAcpUpdate({ sessionUpdate: "plan", entries: [{ content: "Read the docs", status: "completed" }, { content: "Write the summary", status: "in_progress" }] })).toEqual([{ type: "status", text: "Write the summary" }]);
    expect(parseAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })).toEqual([]);
  });

  it("answers permissions by access level", () => {
    const req = (kind: string) => ({ toolCall: { kind }, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] });
    expect(permissionOutcome(req("execute"), "read-only")).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(permissionOutcome(req("read"), "read-only")).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(permissionOutcome(req("edit"), "edit")).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(permissionOutcome({ toolCall: { kind: "edit" }, options: [] }, "edit")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("reads models from config options or the models list", () => {
    expect(acpModels({ models: { availableModels: [{ modelId: "a", name: "A" }], currentModelId: "a" } })).toMatchObject({ models: [{ id: "a", label: "A" }], defaultModel: "a" });
    expect(
      acpModels({
        configOptions: [
          { id: "model", category: "model", currentValue: "x", options: [{ value: "x", name: "X" }, { group: "More", options: [{ value: "y", name: "Y" }] }] },
          { id: "effort", category: "thought_level", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
        ],
      }),
    ).toEqual({ models: [{ id: "x", label: "X", description: undefined }, { id: "y", label: "Y", description: undefined }], defaultModel: "x", efforts: ["low", "high"], defaultEffort: "low" });
  });

  it("lets a device add its own ACP agents and change how known ones start", () => {
    const list = deviceAdapters({ "acp:my-bot": { label: "My bot", command: "my-bot", args: ["--acp"] }, qwen: { args: ["--experimental-acp"] }, "claude-code": { command: "evil" }, junk: { command: "x" } });
    expect(list["acp:my-bot"]).toMatchObject({ id: "acp:my-bot", label: "My bot", binary: "my-bot" });
    expect(list.qwen.binary).toBe("qwen");
    expect(list["claude-code"].binary).toBe("claude");
    expect(list.junk).toBeUndefined();
    expect(list.hermes.label).toBe("Hermes");
  });
});
