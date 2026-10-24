import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { HubToNode, NodeToHub } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let token: string;
let nodeId: string;
let nodeToken: string;

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
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

/** A device that reports `commit` and answers update requests with `answer`. */
async function device(commit: string, answer: (requestId: string) => NodeToHub) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${nodeToken}` } });
  const send = (m: NodeToHub) => ws.send(JSON.stringify(m));
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as HubToNode;
      if (msg.type === "welcome") {
        send({ type: "hello", nodeName: "box", agents: [], version: { commit, date: "2026-10-11T12:00:00Z" } });
        resolve();
      }
      if (msg.type === "update") send(answer(msg.requestId));
    });
    ws.on("error", reject);
  });
  return ws;
}

const nodeInfo = async () => (await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === nodeId);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-updates-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  // not a git checkout, so the hub's own update is explained rather than run
  hub.updates.root = await fs.mkdtemp(path.join(dir, "install-"));
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  token = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Test" })).data.token;
  const n = await api("POST", "/api/nodes", { name: "box" });
  nodeId = n.data.node.id;
  nodeToken = n.data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("updates", () => {
  it("explains when the hub can't update itself", async () => {
    const r = await api("POST", "/api/updates/check");
    expect(r.data.version).toEqual({ commit: null, date: null });
    expect(r.data.check).toMatchObject({ canUpdate: false });
    expect(r.data.check.reason).toMatch(/git/);
    expect(r.data.update.state).toBe("idle");
  });

  it("updates a device and sees it come back on the new version", async () => {
    const ws = await device("aaa1111", (requestId) => ({ type: "result", requestId, ok: true, result: { from: "aaa1111", to: "bbb2222", changes: ["bbb2222 New"], installed: false, built: false } }));
    expect((await waitFor(nodeInfo)).version).toEqual({ commit: "aaa1111", date: "2026-10-11T12:00:00Z" });

    const r = await api("POST", `/api/nodes/${nodeId}/update`);
    expect(r.data.update.state).toBe("updating");
    const restarting = await waitFor(async () => ((await nodeInfo()).update?.state === "restarting" ? nodeInfo() : undefined));
    expect(restarting.update.message).toContain("bbb2222");

    // the device restarts and says hello with the new version
    ws.close();
    const again = await device("bbb2222", () => ({ type: "result", requestId: "", ok: true }));
    const done = await waitFor(async () => {
      const n = await nodeInfo();
      return n.version?.commit === "bbb2222" ? n : undefined;
    });
    expect(done.update).toBeNull();
    again.close();
  });

  it("shows why a device update failed", async () => {
    const ws = await device("bbb2222", (requestId) => ({ type: "result", requestId, ok: false, error: "Files here were changed by hand (README.md)." }));
    await api("POST", `/api/nodes/${nodeId}/update`);
    const failed = await waitFor(async () => ((await nodeInfo()).update?.state === "failed" ? nodeInfo() : undefined));
    expect(failed.update.message).toContain("changed by hand");
    ws.close();
  });

  it("can't update a device that's offline", async () => {
    await waitFor(async () => ((await nodeInfo()).online ? undefined : true));
    const r = await api("POST", `/api/nodes/${nodeId}/update`);
    expect(r.status).toBe(503);
  });
});
