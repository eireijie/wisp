import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeFlow, stepsProblem, type TeamFlow, type TeamStep } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let hub: Hub;
let base: string;
let owner: string;
let close: () => Promise<unknown>;
const agents: Record<string, { id: string; handle: string }> = {};
const tokens: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-team-sched-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  for (const h of ["scout", "quill", "echo"]) {
    agents[h] = (await api("POST", "/api/agents", { handle: h, name: h, harness: "custom" })).data;
    tokens[h] = (await api("POST", `/api/agents/${agents[h].id}/token`)).data.token;
  }
}, 90_000);

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 60_000);

const work = (id: string, handle: string, extra: Partial<TeamStep> = {}): Partial<TeamStep> => ({ id, roleId: "", kind: "do", action: id, agentId: agents[handle].id, next: null, nexts: [], inputs: [], x: 0, y: 0, ...extra });
const sched = (id: string, nexts: string[], extra: Partial<TeamStep> = {}): Partial<TeamStep> => ({ id, roleId: "", kind: "schedule", action: "", next: nexts[0] ?? null, nexts, inputs: [], schedule: "0 9 * * 1", timezone: "UTC", prompt: "Write this week's report.", x: 0, y: 0, ...extra });
const make = async (name: string, steps: Partial<TeamStep>[]) => {
  const r = await api("POST", "/api/channels", { name, settings: { team: { nodes: [], edges: [], roles: [], steps } } });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data as { id: string };
};
const flowsOf = async (ch: { id: string }) => (await api<TeamFlow[]>("GET", `/api/channels/${ch.id}/flows`)).data;
const tasksFor = async (handle: string) => ((await api<{ id: string; toAgentId: string; status: string; channelId: string; title: string; brief: string }[]>("GET", "/api/tasks")).data).filter((t) => t.toAgentId === agents[handle].id);
const finish = async (taskId: string, handle: string, result: string) => expect((await api("PATCH", `/api/tasks/${taskId}`, { status: "done", result }, tokens[handle])).status).toBe(200);
const MONDAY_9 = new Date("2026-11-02T09:00:10Z");

describe("scheduled team runs", () => {
  it("starts at its time, once, and each result goes along the arrows", async () => {
    const ch = await make("sched-chain", [sched("s", ["a"]), work("a", "scout", { nexts: ["b"], next: "b" }), work("b", "quill", { inputs: ["a"] })]);
    hub.schedules.tick(new Date("2026-11-02T08:59:10Z"));
    expect(await flowsOf(ch)).toHaveLength(0);
    hub.schedules.tick(MONDAY_9);
    hub.schedules.tick(new Date("2026-11-02T09:00:40Z"));
    const [flow, ...more] = await flowsOf(ch);
    expect(more).toHaveLength(0);
    expect(flow).toMatchObject({ status: "running", scheduleId: "s", request: "Write this week's report.", requestedBy: expect.any(String) });
    const first = (await tasksFor("scout")).find((t) => t.channelId === ch.id)!;
    expect(first.brief).toContain("Step 1 of 2");
    expect((await tasksFor("quill")).some((t) => t.channelId === ch.id)).toBe(false);
    await finish(first.id, "scout", "Revenue went up.");
    const second = (await tasksFor("quill")).find((t) => t.channelId === ch.id)!;
    expect(second.brief).toContain("Revenue went up.");
    await finish(second.id, "quill", "Report done.");
    expect((await flowsOf(ch))[0]).toMatchObject({ status: "done", result: "Report done." });
  });

  it("only runs what its own arrows reach, and a shared step goes on with what it gets", async () => {
    const ch = await make("sched-two", [
      sched("daily", ["a"], { schedule: "0 9 * * *" }),
      sched("weekly", ["b"], { schedule: "0 10 * * 1" }),
      work("a", "scout", { nexts: ["c"], next: "c" }),
      work("b", "echo", { nexts: ["c"], next: "c" }),
      work("c", "quill", { inputs: ["a", "b"] }),
    ]);
    expect(hub.schedules.run(ch.id, "daily", null)).toBeTruthy();
    expect((await tasksFor("echo")).some((t) => t.channelId === ch.id)).toBe(false);
    await finish((await tasksFor("scout")).find((t) => t.channelId === ch.id)!.id, "scout", "Daily numbers.");
    const c = (await tasksFor("quill")).find((t) => t.channelId === ch.id)!;
    expect(c.brief).toContain("Daily numbers.");
    await finish(c.id, "quill", "Done.");
    expect((await flowsOf(ch))[0].status).toBe("done");
  });

  it("a person's message still starts the team, with every schedule's steps", async () => {
    const ch = await make("sched-msg", [sched("s", ["a"]), work("a", "scout"), work("b", "echo")]);
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Do it now" });
    expect((await flowsOf(ch))[0].request).toBe("Do it now");
    expect((await tasksFor("scout")).some((t) => t.channelId === ch.id)).toBe(true);
    expect((await tasksFor("echo")).some((t) => t.channelId === ch.id)).toBe(true);
  });

  it("leaves out steps that only a message starts", async () => {
    const ch = await make("sched-other", [sched("s", ["a"]), work("a", "scout"), work("b", "echo")]);
    hub.schedules.run(ch.id, "s", null);
    expect((await tasksFor("scout")).some((t) => t.channelId === ch.id)).toBe(true);
    expect((await tasksFor("echo")).some((t) => t.channelId === ch.id)).toBe(false);
  });

  it("rests when off, and won't pile up on a run still going", async () => {
    const off = await make("sched-off", [sched("s", ["a"], { enabled: false }), work("a", "scout")]);
    hub.schedules.tick(MONDAY_9);
    expect(await flowsOf(off)).toHaveLength(0);
    const ch = await make("sched-busy", [sched("s", ["a"]), work("a", "scout")]);
    expect((await api("POST", `/api/channels/${ch.id}/schedules/s/run`)).status).toBe(200);
    const again = await api("POST", `/api/channels/${ch.id}/schedules/s/run`);
    expect(again.status).toBe(409);
    expect((await api("POST", `/api/channels/${ch.id}/schedules/nope/run`)).status).toBe(404);
    expect(await flowsOf(ch)).toHaveLength(1);
  });

  it("runs for whoever set it up, and the client can't say otherwise", async () => {
    const ch = await make("sched-owner", [sched("s", ["a"], { scheduledBy: "someone-else" }), work("a", "scout")]);
    const flow = hub.schedules.run(ch.id, "s", null)!;
    const me = (await api("GET", "/api/me")).data;
    expect(flow.requestedBy).toBe(me.user?.id ?? me.id);
  });

  it("checks the chart", () => {
    const base = { roles: [] };
    const a = { id: "a", roleId: "", kind: "do", action: "a", agentId: "x", next: null, nexts: [], inputs: [], x: 0, y: 0 } as TeamStep;
    const s = sched("s", ["a"]) as TeamStep;
    expect(stepsProblem({ ...base, steps: [s, { ...a, inputs: ["s"] }] })).toBeNull();
    expect(stepsProblem({ ...base, steps: [{ ...s, nexts: [], next: null }, a] })).toMatch(/Point the schedule/);
    expect(stepsProblem({ ...base, steps: [{ ...s, schedule: "nope" }, a] })).toMatch(/when the schedule runs/);
    expect(stepsProblem({ ...base, steps: [{ ...s, prompt: " " }, a] })).toMatch(/asks the team/);
    expect(stepsProblem({ ...base, steps: [{ ...s, timezone: "Mars/Base" }, a] })).toMatch(/time zone/);
    expect(stepsProblem({ ...base, steps: [{ ...s, inputs: ["a"] }, { ...a, nexts: ["s"] }] })).toMatch(/lead to a schedule/);
    const lines = describeFlow({ ...base, steps: [s, { ...a, inputs: ["s"] }] }, () => "Scout");
    expect(lines[0]).toMatchObject({ n: 0, who: "Schedule" });
    expect(lines[0].text).toContain("step 1");
    expect(lines[1]).toMatchObject({ n: 1, who: "Scout" });
  });
});
