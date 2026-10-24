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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-cancel-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" });
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("cancelling a task", () => {
  it("cancels the queued run, fails the task and refuses a second cancel", async () => {
    const ch = (await api("POST", "/api/channels", { name: "work" })).data;
    const task = (await api("POST", "/api/tasks", { to: "atlas", title: "Tidy up", brief: "now", channelId: ch.id })).data;
    const before = hub.store.db.prepare("SELECT status FROM runs WHERE trigger_message_id = ?").get(task.threadId) as { status: string } | undefined;
    expect(before?.status).toBe("queued");

    const res = await api("POST", `/api/tasks/${task.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("failed");
    expect(res.data.result).toMatch(/^Cancelled by /);
    const run = hub.store.db.prepare("SELECT status FROM runs WHERE trigger_message_id = ?").get(task.threadId) as { status: string };
    expect(run.status).toBe("cancelled");
    const listed = (await api<any[]>("GET", "/api/tasks")).data.find((t) => t.id === task.id);
    expect(listed.status).toBe("failed");

    const again = await api("POST", `/api/tasks/${task.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.data.error).toBe("task already finished");
  });

  it("404s for an unknown task", async () => {
    expect((await api("POST", "/api/tasks/tsk_nope/cancel")).status).toBe(404);
  });
});
