import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let app: FastifyInstance;
let hub: Hub;
let owner: string;
let sequence = 0;

async function api(method: "GET" | "POST" | "PATCH", url: string, payload?: any, token = owner) {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-task-completion-"));
  ({ app, hub } = await buildHub({ dataDir: dir }));
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything" }, "")).token;
});
afterAll(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function taskRun() {
  const n = ++sequence;
  const { node } = await api("POST", "/api/nodes", { name: `box-${n}` });
  const agent = await api("POST", "/api/agents", { handle: `agent-${n}`, name: `Agent ${n}`, harness: "custom", nodeId: node.id });
  const task = await api("POST", "/api/tasks", { to: agent.handle, title: `Task ${n}`, brief: "Do the work" });
  const run = hub.store.db.prepare("SELECT id FROM runs WHERE trigger_message_id = ?").get(task.threadId) as { id: string };
  hub.store.setRunStatus(run.id, "running");
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: () => {}, terminate: () => {} }) as unknown as WebSocket;
  hub.addNode(socket, node.id, agent.workspaceId);
  const token = (await api("POST", `/api/agents/${agent.id}/token`)).token;
  return {
    task, run, socket,
    update: (result?: string, status = "done") => api("PATCH", `/api/tasks/${task.id}`, { status, ...(result === undefined ? {} : { result }) }, token),
    finish: (finalText: string) => socket.emit("message", Buffer.from(JSON.stringify({ type: "run_done", runId: run.id, finalText }))),
    replies: () => hub.store.messages(task.channelId, { threadId: task.threadId }).filter((m) => m.author.id === agent.id),
  };
}

describe("task completion replies", () => {
  it.each([
    ["The answer is 42.", "The answer is 42."],
    ["The answer is 42.\n\nChecked the calculation.", "The answer is 42."],
    ["The answer is 42.", "Done! The answer is 42."],
  ])("posts the task result once when the final reply repeats it", async (result, finalText) => {
    const t = await taskRun();
    await t.update(result);
    t.finish(`  ${finalText}\n`);
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0].body).toContain(result);
    expect(hub.store.run(t.run.id)?.status).toBe("done");
    t.socket.emit("close");
  });

  it("also deduplicates a final reply taken from streamed text", async () => {
    const t = await taskRun();
    t.socket.emit("message", Buffer.from(JSON.stringify({ type: "run_event", runId: t.run.id, event: { type: "text", text: "All fixed." } })));
    const tool = { type: "tool_call", name: "read_file", input: { path: "readme" } };
    t.socket.emit("message", Buffer.from(JSON.stringify({ type: "run_event", runId: t.run.id, event: tool })));
    t.socket.emit("message", Buffer.from(JSON.stringify({ type: "run_event", runId: t.run.id, event: { type: "tool_result", name: "read_file", output: "Read it." } })));
    await t.update("All fixed.");
    t.finish("");
    expect(t.replies()[0].parts).toContainEqual({ ...tool, output: "Read it." });
    expect(t.replies()).toHaveLength(1);
    t.socket.emit("close");
  });

  it("also posts a failed task's reported result once", async () => {
    const t = await taskRun();
    await t.update("The service is unavailable.", "failed");
    t.finish("The service is unavailable.");
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0].body).toContain("failed.");
    t.socket.emit("close");
  });

  it.each([undefined, "The answer is 42."])("keeps a distinct final reply (result: %s)", async (result) => {
    const t = await taskRun();
    await t.update(result);
    t.finish("One more thing to check tomorrow.");
    expect(t.replies()).toHaveLength(2);
    expect(t.replies().some((m) => m.body === "One more thing to check tomorrow.")).toBe(true);
    t.socket.emit("close");
  });

  it("does not suppress an answer whose task result message was deleted", async () => {
    const t = await taskRun();
    await t.update("All fixed.");
    hub.store.deleteMessage(t.replies()[0].id);
    t.finish("All fixed.");
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0].body).toBe("All fixed.");
    t.socket.emit("close");
  });
});
