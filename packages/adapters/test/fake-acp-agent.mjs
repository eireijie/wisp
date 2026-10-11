#!/usr/bin/env node
// A tiny ACP agent for tests. FAKE_ACP_LOG: file to append received messages to.
// FAKE_ACP_MODE: "reject-mcp" refuses per-session MCP servers.
import fs from "node:fs";
import readline from "node:readline";

const log = (m) => process.env.FAKE_ACP_LOG && fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const pending = new Map();
let nextId = 100;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

process.stdout.write("fake agent banner, not json\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.id !== undefined && !m.method) return pending.get(m.id)?.(m.result);
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (message) => send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message } });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    case "session/new":
      if (process.env.FAKE_ACP_MODE === "reject-mcp" && m.params.mcpServers.length) return fail("per-session mcpServers are not supported");
      return reply({ sessionId: "sess-1", models: { availableModels: [{ modelId: "m1", name: "Model One" }, { modelId: "m2", name: "Model Two" }], currentModelId: "m1" }, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] } });
    case "session/load":
      if (m.params.sessionId !== "sess-1") return fail("no such session");
      update("sess-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
      return reply(null);
    case "session/set_model":
    case "session/set_mode":
      return reply({});
    case "session/prompt": {
      const sid = m.params.sessionId;
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "warren/memory_search", kind: "other", status: "pending", rawInput: { query: "launch" } });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "found 2 notes" } }] });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t2", title: "rm -rf build", kind: "execute", status: "pending" });
      const perm = await ask("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t2", kind: "execute", title: "rm -rf build" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: perm.outcome.optionId === "yes" ? "completed" : "failed", rawOutput: perm.outcome.optionId === "yes" ? "removed" : "denied" });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `world (${m.params.prompt[0].text.length} chars)` } });
      return reply({ stopReason: "end_turn" });
    }
    default:
      if (m.id !== undefined) fail(`unknown method ${m.method}`);
  }
});
