import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { HubToNode } from "@wisp/core";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;
let token: string;
let nodeToken: string;
let agentId: string;
let ws: WebSocket | null = null;
let outcome: "done" | "fail" = "done";

async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

/** Brings the agent's device online; it answers every run as `outcome` says. */
async function deviceOnline() {
  ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${nodeToken}` } });
  await new Promise<void>((resolve, reject) => {
    ws!.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as HubToNode;
      if (msg.type === "welcome") {
        ws!.send(JSON.stringify({ type: "hello", nodeName: "box", agents: [] }));
        resolve();
      }
      if (msg.type === "run") {
        const runId = msg.run.runId;
        ws!.send(JSON.stringify(outcome === "done" ? { type: "run_done", runId, finalText: "done" } : { type: "run_failed", runId, error: "crashed" }));
      }
    });
    ws!.on("error", reject);
  });
}

const routine = async (id: string) => (await api<any[]>("GET", "/api/routines")).find((r) => r.id === id);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-routine-done-"));
  const built = await buildHub({ dataDir: dir });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  token = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" })).token;
  const n = await api("POST", "/api/nodes", { name: "box" });
  nodeToken = n.token;
  agentId = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "claude-code", nodeId: n.node.id })).id;
});

afterAll(async () => {
  ws?.close();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("routine completion", () => {
  it("records when a run was requested and, separately, when it finished", async () => {
    const r = await api("POST", "/api/routines", { agentId, name: "Tidy desk", steps: "1. Tidy" });
    expect(r.lastCompletedAt).toBeNull();

    // the device is offline: the run is requested but can't finish
    await api("POST", `/api/routines/${r.id}/run`);
    const asked = await routine(r.id);
    expect(asked.lastRunAt).toBeTruthy();
    expect(asked.lastCompletedAt).toBeNull();

    await deviceOnline();
    const done = await waitFor(async () => {
      const x = await routine(r.id);
      return x.lastCompletedAt ? x : undefined;
    });
    expect(new Date(done.lastCompletedAt).getTime()).toBeGreaterThanOrEqual(new Date(done.lastRunAt).getTime());
  });

  it("does not count a failed run", async () => {
    outcome = "fail";
    const r = await api("POST", "/api/routines", { agentId, name: "Water plants", steps: "1. Water" });
    await api("POST", `/api/routines/${r.id}/run`);
    await waitFor(async () => ((await api<any[]>("GET", `/api/agents/${agentId}/runs`)).find((x) => x.status === "failed") ? true : undefined));
    expect((await routine(r.id)).lastCompletedAt).toBeNull();
  });
});
