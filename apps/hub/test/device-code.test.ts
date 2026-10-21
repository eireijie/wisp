import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { HubToNode } from "@warren/core";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;
let owner: string;
let sam: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** Connect as a device with this code and say hello; resolves once the hub has welcomed it. */
async function connectDevice(token: string, name: string): Promise<WebSocket> {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as HubToNode;
      if (msg.type === "welcome") {
        ws.send(JSON.stringify({ type: "hello", nodeName: name, agents: [] }));
        resolve();
      }
    });
    ws.on("unexpected-response", (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    ws.on("close", (code) => reject(new Error(`refused: ${code}`)));
    ws.on("error", reject);
  });
  return ws;
}

const until = async (fn: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-device-code-"));
  const built = await buildHub({ dataDir: dir });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yug", password: "password123" }, "")).data.token;
  await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" });
  sam = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a new connection code for an existing device", () => {
  it("issues a code the device can connect with, keeping the device's name and id", async () => {
    const made = (await api("POST", "/api/nodes", { name: "my-mac" })).data;
    const again = await api("POST", `/api/nodes/${made.node.id}/token`);
    expect(again.status).toBe(200);
    expect(again.data.node).toMatchObject({ id: made.node.id, name: "my-mac" });
    expect(again.data.token).toMatch(/^wr_node_/);
    expect(again.data.token).not.toBe(made.token);

    const ws = await connectDevice(again.data.token, "my-mac");
    await until(async () => (await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === made.node.id)?.online === true);
    // the first code still works too: nothing already connected is cut off
    const first = await connectDevice(made.token, "my-mac");
    first.close();
    ws.close();
    await until(async () => (await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === made.node.id)?.online === false);
    expect((await api<any[]>("GET", "/api/nodes")).data.filter((n) => n.name === "my-mac")).toHaveLength(1);
  });

  it("is for the device's owner or a workspace owner, like adding one", async () => {
    const mine = (await api("POST", "/api/nodes", { name: "owner-box" })).data.node;
    const sams = (await api("POST", "/api/nodes", { name: "sam-box" }, sam)).data.node;
    expect((await api("POST", `/api/nodes/${mine.id}/token`, undefined, sam)).status).toBe(403);
    expect((await api("POST", `/api/nodes/${sams.id}/token`, undefined, sam)).status).toBe(200);
    expect((await api("POST", `/api/nodes/${sams.id}/token`)).status).toBe(200); // the workspace owner
    expect((await api("POST", `/api/nodes/nope/token`)).status).toBe(404);
    expect((await api("POST", `/api/nodes/${mine.id}/token`, undefined, "")).status).toBe(401);
  });

  it("stops working once the device is removed", async () => {
    const made = (await api("POST", "/api/nodes", { name: "gone" })).data;
    const code = (await api("POST", `/api/nodes/${made.node.id}/token`)).data.token;
    await api("DELETE", `/api/nodes/${made.node.id}`);
    await expect(connectDevice(code, "gone")).rejects.toThrow(/refused/);
  });
});
