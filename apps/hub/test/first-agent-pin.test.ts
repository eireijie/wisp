import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { MAX_PINS } from "@bubble-ai/core";
import { buildHub } from "../src/app.ts";

/** Round 16 (board 16c): the tile row is only pins, so the person's first agent is pinned for them, once. */

let dir: string;
let base: string;
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
const sidebar = async (token = owner) => (await api("GET", "/api/me", undefined, token)).data.prefs.sidebar;
const newAgent = async (handle: string, token = owner) => (await api("POST", "/api/agents", { handle, name: handle, harness: "custom", greet: "later" }, token)).data;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bubble-firstpin-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = "";
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" })).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the first agent's pin", () => {
  it("pins the first agent, tells the person's apps, and leaves later agents unpinned", async () => {
    expect(await sidebar()).toBeUndefined();
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const events: string[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(String(raw)).type));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ token: owner }));
    await expect.poll(() => events.includes("ready")).toBe(true);

    const juno = await newAgent("juno");
    expect((await sidebar()).pins).toEqual([`a:${juno.id}`]);
    await expect.poll(() => events.includes("prefs_changed")).toBe(true);
    ws.close();

    const nova = await newAgent("nova");
    expect((await sidebar()).pins).toEqual([`a:${juno.id}`]);
    expect((await sidebar()).pins).not.toContain(`a:${nova.id}`);
  });

  it("never pins again after an unpin", async () => {
    const before = await sidebar();
    expect((await api("PUT", "/api/me/prefs", { sidebar: { ...before, pins: [] } })).status).toBe(200);
    await newAgent("milo");
    expect((await sidebar()).pins).toEqual([]);
  });

  it("pins a new member's first agent and keeps the workspace's folders", async () => {
    const sec = (await api("POST", "/api/sections", { name: "Work" })).data;
    const sam = (await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" })).data;
    expect(sam).toBeTruthy();
    const login = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data;
    const token = login.token as string;
    expect(token).toBeTruthy();
    const ivy = await newAgent("ivy", token);
    const s = await sidebar(token);
    expect(s.pins).toEqual([`a:${ivy.id}`]);
    expect(s.pins.length).toBeLessThanOrEqual(MAX_PINS);
    expect(s.sections.map((x: { id: string; name: string }) => [x.id, x.name])).toEqual([[sec.id, "Work"]]);
    // the owner's own sidebar didn't change
    expect((await sidebar()).pins).toEqual([]);
  });
});
