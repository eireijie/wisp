import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WispClient } from "@wisp/sdk";
import { buildHub } from "../src/app.ts";
import { ESTIMATED_CHECK_TOKENS, startOfDay } from "../src/background.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let close: () => Promise<void>;
let owner: WispClient;
let hub: Hub;
let me: string;
let ws: string;
let agentA: string;
let agentB: string;

const TZ = "Asia/Kolkata"; // +5:30, so day edges fall mid-hour in UTC

/** a finished run at `at`, with the token counts a harness would report (or none) */
function run(agentId: string, at: Date, o: { input?: number; output?: number; model?: string; status?: string; background?: boolean; by?: string | null } = {}) {
  const id = hub.store.createRun({ agentId, channelId: "chn_x", threadId: null, triggerMessageId: "msg_x", hop: 0, requestedBy: o.by === undefined ? me : o.by, kind: o.background ? "background" : undefined });
  const usage = o.input === undefined && o.output === undefined ? null : JSON.stringify({ inputTokens: o.input, outputTokens: o.output, model: o.model });
  hub.store.db.prepare("UPDATE runs SET status = ?, created_at = ?, usage_json = ? WHERE id = ?").run(o.status ?? "done", at.toISOString(), usage, id);
  return id;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-usage-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentA = (await owner.request("POST", "/api/agents", { handle: "ann", name: "Ann", harness: "custom", nodeId: node.id })).id;
  agentB = (await owner.request("POST", "/api/agents", { handle: "bo", name: "Bo", harness: "custom", nodeId: node.id })).id;
  ws = hub.store.agent(agentA)!.workspaceId;
  hub.store.db.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(TZ, me);
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/usage", () => {
  it("rejects an unknown range", async () => {
    await expect(owner.request("GET", "/api/usage?range=year")).rejects.toThrow();
  });

  it("is empty but complete when nothing ran", async () => {
    const u = await owner.request("GET", "/api/usage?range=7d");
    expect(u.range).toBe("7d");
    expect(u.tz).toBe(TZ);
    expect(u.buckets).toHaveLength(7);
    expect(u.buckets.every((b: any) => b.chat === 0 && b.background === 0)).toBe(true);
    expect(u.totals).toEqual({ tokens: 0, runs: 0, failed: 0, estimated: false });
    expect(u.previousTokens).toBe(0);
    expect(u.agents).toEqual([]);
    expect(u.background.dailyTokens).toBe(1_000_000);
  });

  it("cuts buckets on the person's clock, splits chat from background, and estimates missing counts", async () => {
    const now = new Date();
    const today = startOfDay(now, TZ);
    const hour = (h: number) => new Date(today.getTime() + h * 3_600_000 + 10 * 60_000);
    const yesterday = new Date(today.getTime() - 3_600_000);
    run(agentA, hour(0), { input: 1000, output: 500, model: "opus" });
    run(agentA, hour(5), { input: 200, output: 100, model: "opus", background: true });
    run(agentB, hour(5), { input: 10, output: 5, model: "kimi", status: "failed" });
    run(agentB, hour(7), {}); // reported nothing: counted as a guess
    run(agentA, yesterday, { input: 4000, output: 0, model: "kimi" });
    run(agentA, new Date(today.getTime() - 3 * 86_400_000), { input: 50, output: 50, model: "opus" });
    run(agentA, hour(1), { input: 9999, output: 1, by: "someone-else" }); // another person's
    hub.store.createRun({ agentId: agentA, channelId: "chn_x", threadId: null, triggerMessageId: "m", hop: 0, requestedBy: me }); // queued: not counted

    const t = await owner.request("GET", "/api/usage?range=today");
    expect(t.buckets).toHaveLength(24);
    expect(t.buckets[0]).toMatchObject({ start: today.toISOString(), chat: 1500, background: 0 });
    expect(t.buckets[5]).toMatchObject({ chat: 15, background: 300 });
    expect(t.buckets[7].chat).toBe(ESTIMATED_CHECK_TOKENS);
    expect(t.totals).toEqual({ tokens: 1500 + 15 + 300 + ESTIMATED_CHECK_TOKENS, runs: 4, failed: 1, estimated: true });
    expect(t.previousTokens).toBe(4000);
    expect(t.agents).toEqual([
      { agentId: agentB, tokens: 15 + ESTIMATED_CHECK_TOKENS, runs: 2 },
      { agentId: agentA, tokens: 1800, runs: 2 },
    ]);
    expect(t.models.find((m: any) => m.model === "opus").tokens).toBe(1800);
    expect(t.models.find((m: any) => m.model === "Unknown").tokens).toBe(ESTIMATED_CHECK_TOKENS);
    expect(t.background.todayTokens).toBe(300);
    expect(new Date(t.background.resetsAt).getTime()).toBe(startOfDay(now, TZ, 1).getTime());

    const w = await owner.request("GET", "/api/usage?range=7d");
    expect(w.buckets).toHaveLength(7);
    expect(w.buckets[6].chat + w.buckets[6].background).toBe(1500 + 15 + 300 + ESTIMATED_CHECK_TOKENS);
    expect(w.buckets[5].chat).toBe(4000);
    expect(w.buckets[3].chat).toBe(100);
    expect(w.totals.runs).toBe(6);

    const m = await owner.request("GET", "/api/usage?range=30d");
    expect(m.buckets).toHaveLength(30);
    expect(m.totals.runs).toBe(6);
    expect(m.previousTokens).toBe(0);
  });

  it("keeps the allowance endpoints working", async () => {
    const a = await owner.request("GET", "/api/background/allowance");
    expect(a.todayTokens).toBe(300);
  });
});
