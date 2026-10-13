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
let guest: string;
let me: any;
let sam: any;
let atlas: any;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const channelNamed = async (name: string) => (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === name);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-channels-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yug", password: "password123", workspaceName: "Lab" }, "")).data.token;
  me = (await api("GET", "/api/me")).data.user;
  sam = (await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" })).data;
  await api("POST", "/api/members", { email: "gus@example.com", name: "Gus", password: "password123", role: "guest" });
  guest = (await api("POST", "/api/auth/login", { email: "gus@example.com", password: "password123" }, "")).data.token;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("channel members", () => {
  it("lists, adds and removes people and agents", async () => {
    const ch = (await api("POST", "/api/channels", { name: "launch" })).data;
    expect((await api("GET", `/api/channels/${ch.id}/members`)).data).toEqual([{ kind: "user", id: me.id, name: "Yug", handle: null, role: "owner" }]);

    await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    const added = await api<any[]>("PUT", `/api/channels/${ch.id}/members/user/${sam.id}`);
    expect(added.status).toBe(200);
    expect(added.data.map((m) => `${m.kind}:${m.name}`)).toEqual(["user:Sam", "user:Yug", "agent:Atlas"]);
    // adding twice is fine
    expect((await api<any[]>("PUT", `/api/channels/${ch.id}/members/user/${sam.id}`)).data).toHaveLength(3);
    expect((await channelNamed("launch")).memberCount).toBe(3);

    // guests can look, not change
    expect((await api("GET", `/api/channels/${ch.id}/members`, undefined, guest)).data).toHaveLength(3);
    expect((await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`, undefined, guest)).status).toBe(403);
    expect((await api("DELETE", `/api/channels/${ch.id}/members/user/${sam.id}`, undefined, guest)).status).toBe(403);

    // only people and agents of this workspace
    expect((await api("PUT", `/api/channels/${ch.id}/members/agent/agt_nope`)).status).toBe(404);
    expect((await api("PUT", `/api/channels/${ch.id}/members/user/usr_nope`)).status).toBe(404);
    expect((await api("PUT", `/api/channels/${ch.id}/members/bot/${atlas.id}`)).status).toBe(400);

    await api("DELETE", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    await api("DELETE", `/api/channels/${ch.id}/members/user/${sam.id}`);
    // removing the last member leaves an empty channel, not a missing one
    const empty = await api<any[]>("DELETE", `/api/channels/${ch.id}/members/user/${me.id}`);
    expect(empty.data).toEqual([]);
    expect((await channelNamed("launch")).memberCount).toBe(0);
  });

  it("doesn't change who's in a DM", async () => {
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    expect((await api("GET", `/api/channels/${dm.id}/members`)).data).toHaveLength(2);
    expect((await api("PUT", `/api/channels/${dm.id}/members/user/${sam.id}`)).status).toBe(404);
  });

  it("wakes an agent added to a channel when it's mentioned there", async () => {
    const ch = (await api("POST", "/api/channels", { name: "ops" })).data;
    await api("PUT", `/api/channels/${ch.id}/members/agent/${atlas.id}`);
    const msg = (await api("POST", `/api/channels/${ch.id}/messages`, { body: "@atlas status?" })).data;
    const run = hub.store.db.prepare("SELECT status FROM runs WHERE trigger_message_id = ?").get(msg.id) as { status: string } | undefined;
    expect(run?.status).toBe("queued");
  });
});

describe("deleting channels", () => {
  it("deletes a channel with its messages, stops its work and lets go of its tasks", async () => {
    const ch = (await api("POST", "/api/channels", { name: "scratch" })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "hello" });
    const task = (await api("POST", "/api/tasks", { to: "atlas", title: "Tidy up", brief: "now", channelId: ch.id })).data;
    expect(task.channelId).toBe(ch.id);

    expect((await api("DELETE", `/api/channels/${ch.id}`, undefined, guest)).status).toBe(403);
    expect((await api("DELETE", `/api/channels/${ch.id}`)).data).toEqual({ ok: true });
    expect(await channelNamed("scratch")).toBeUndefined();
    expect((await api("GET", `/api/channels/${ch.id}/messages`)).status).toBe(404);
    expect((hub.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(ch.id) as { n: number }).n).toBe(0);
    expect((hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE channel_id = ? AND status IN ('queued', 'running')").get(ch.id) as { n: number }).n).toBe(0);
    const after = (await api<any[]>("GET", "/api/tasks")).data.find((t) => t.id === task.id);
    expect(after.channelId).toBeNull();
    // the name is free again
    expect((await api("POST", "/api/channels", { name: "scratch" })).status).toBe(200);
  });

  it("keeps #general, DMs and team channels", async () => {
    expect((await api("DELETE", `/api/channels/${(await channelNamed("general")).id}`)).status).toBe(409);
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    expect((await api("DELETE", `/api/channels/${dm.id}`)).status).toBe(404);
    const team = (await api("POST", "/api/teams", { name: "web" })).data;
    const res = await api("DELETE", `/api/channels/${team.channelId}`);
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/team web/);
  });
});
