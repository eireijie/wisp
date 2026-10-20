import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-taskmsg-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("task messages", () => {
  it("shows people only the title and brief, and gives the assignee the instructions", async () => {
    const atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
    const other = (await api("POST", "/api/agents", { handle: "orion", name: "Orion", harness: "custom" })).data;
    const task = (await api("POST", "/api/tasks", { to: "atlas", title: "Tidy the docs", brief: "Fix the typos in the README" })).data;
    const msg = hub.store.message(task.threadId)!;

    expect(msg.body).toContain("Tidy the docs");
    expect(msg.body).toContain("Fix the typos in the README");
    expect(msg.body).not.toContain("task_update");
    expect(msg.body).not.toContain(task.id);
    expect(msg.parts).toContainEqual({ type: "task", taskId: task.id });

    const prompt = await hub.buildPrompt(atlas.id, msg.channelId, task.threadId, msg.id);
    expect(prompt).toContain(task.id);
    expect(prompt).toContain("task_update");
    expect(prompt).toContain("Fix the typos in the README");

    // someone the task isn't assigned to does not get the instructions
    const otherPrompt = await hub.buildPrompt(other.id, msg.channelId, task.threadId, msg.id);
    expect(otherPrompt).not.toContain("task_update");
  });
});
