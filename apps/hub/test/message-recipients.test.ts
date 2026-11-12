import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import { migrateRecipients } from "../src/db.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let hub: Hub;
let app: Awaited<ReturnType<typeof buildHub>>["app"];
let owner: string;

async function api(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, token = owner) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
  return res.json();
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-to-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  app = built.app;
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" }, "")).token;
});

afterAll(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const teamOf = (lead: string, other: string) => ({ nodes: [{ agentId: lead, lead: true, x: 0, y: 0 }, { agentId: other, lead: false, x: 0, y: 0 }], edges: [{ from: lead, to: other }] });

describe("who a message is for", () => {
  it("records the agents a message wakes, hand-offs between agents, and the reply back", async () => {
    const atlas = await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" });
    const ivy = await api("POST", "/api/agents", { handle: "ivy", name: "Ivy", harness: "custom" });
    const channel = await api("POST", "/api/channels", { name: "launch", settings: { team: teamOf(atlas.id, ivy.id) } });

    const asked = await api("POST", `/api/channels/${channel.id}/messages`, { body: "@atlas plan the launch" });
    expect(asked.to).toEqual([{ kind: "agent", id: atlas.id }]);

    // Atlas hands a piece to Ivy: the hand-off is from Atlas, for Ivy
    const atlasToken = (await api("POST", `/api/agents/${atlas.id}/token`)).token;
    const task = await api("POST", "/api/tasks", { to: "ivy", title: "Payments endpoint", brief: "Stripe intents", channelId: channel.id }, atlasToken);
    const handoff = hub.store.message(task.threadId)!;
    expect(handoff.author).toEqual({ kind: "agent", id: atlas.id });
    expect(handoff.to).toEqual([{ kind: "agent", id: ivy.id }]);

    // Ivy finishes: the report is for Atlas
    const ivyToken = (await api("POST", `/api/agents/${ivy.id}/token`)).token;
    await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "Endpoint is in." }, ivyToken);

    const between = (await api("GET", `/api/channels/${channel.id}/between`)).messages as { author: { id: string }; to?: { id: string }[]; body: string }[];
    const lines = between.map((m) => `${m.author.id}>${(m.to ?? []).map((t) => t.id).join(",")}`);
    expect(lines).toContain(`${atlas.id}>${ivy.id}`);
    expect(lines).toContain(`${ivy.id}>${atlas.id}`);

    const log = (await api("GET", `/api/agents/${ivy.id}/log`)).messages as { id: string }[];
    expect(log.map((m) => m.id)).toContain(handoff.id);
  });

  it("backfills older messages from their @mentions", async () => {
    const ws = (await api("GET", "/api/me")).workspace.id;
    const atlas = hub.store.agentByHandle(ws, "atlas")!;
    const ivy = hub.store.agentByHandle(ws, "ivy")!;
    const channel = await api("POST", "/api/channels", { name: "old-days", settings: { team: teamOf(atlas.id, ivy.id) } });
    const old = hub.store.insertMessage({ channelId: channel.id, author: { kind: "agent", id: atlas.id }, body: "@ivy @atlas please check this" });
    expect(hub.store.message(old.id)!.to).toBeUndefined();
    migrateRecipients(hub.store.db);
    expect(hub.store.message(old.id)!.to).toEqual([{ kind: "agent", id: ivy.id }]);
  });
});
