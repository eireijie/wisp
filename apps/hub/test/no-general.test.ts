import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";

let dir: string;
let base: string;
let close: () => Promise<void>;
let owner: string;

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(owner ? { authorization: `Bearer ${owner}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}
const channelNamed = async (name: string) => (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === name);

async function start() {
  const built = await buildHub({ dataDir: dir, setupCode: false });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-nogeneral-"));
  await start();
  owner = "";
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" })).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("deleting #general", () => {
  it("stays public, but can be archived and deleted like any other channel", async () => {
    const general = await channelNamed("general");
    expect((await api("PATCH", `/api/channels/${general.id}`, { private: true })).status).toBe(409);
    expect((await api("POST", `/api/channels/${general.id}/archive`, {})).status).toBe(200);
    expect((await api("POST", `/api/channels/${general.id}/archive`, { archived: false })).status).toBe(200);
    expect((await api("DELETE", `/api/channels/${general.id}`)).status).toBe(200);
    expect(await channelNamed("general")).toBeUndefined();
  });

  it("leaves the app working without it", async () => {
    expect((await api("GET", "/api/channels")).status).toBe(200);
    expect((await api("GET", "/api/me")).status).toBe(200);
    // new agents and members just don't join anything
    expect((await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).status).toBe(200);
    expect((await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" })).status).toBe(200);
    // other channels still work
    expect((await api("POST", "/api/channels", { name: "launch" })).status).toBe(200);
  });

  it("isn't recreated when the hub restarts", async () => {
    await close();
    await start();
    expect((await api("GET", "/api/channels")).status).toBe(200);
    expect(await channelNamed("general")).toBeUndefined();
    expect(await channelNamed("launch")).toBeTruthy();
  });
});
