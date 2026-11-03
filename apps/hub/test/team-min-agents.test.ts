import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { teamShrinkProblem, teamSize, teamSizeProblem } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let ada: any;
let bo: any;
let cy: any;

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${owner}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const node = (agentId: string, lead = false) => ({ agentId, lead, x: 0, y: 0 });
const chart = (...ids: string[]) => ({ nodes: ids.map((id, i) => node(id, i === 0)), edges: ids.slice(1).map((to) => ({ from: ids[0]!, to })) });
const create = (name: string, team?: unknown) => api("POST", "/api/channels", { name, settings: team === undefined ? {} : { team } });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-team-min-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await fetch(base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }) });
  owner = ((await setup.json()) as { token: string }).token;
  for (const [h, set] of [["ada", (a: any) => (ada = a)], ["bo", (a: any) => (bo = a)], ["cy", (a: any) => (cy = a)]] as const) set((await api("POST", "/api/agents", { handle: h, name: h, harness: "custom" })).data);
});
afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a team needs at least 2 agents", () => {
  it("counts each agent once, from chart, roles and steps", () => {
    expect(teamSize(null)).toBe(0);
    expect(teamSize({ nodes: [node("a"), node("a")], roles: [{ id: "r", name: "R", description: "", agentId: "b" }], steps: [] })).toBe(2);
    expect(teamSizeProblem({ nodes: [node("a")] } as any)).toMatch(/at least 2 agents/);
    expect(teamSizeProblem(chart("a", "b") as any)).toBeNull();
  });

  it("only refuses to shrink a team, never one that was already small", () => {
    expect(teamShrinkProblem(chart("a", "b") as any, chart("a") as any)).toMatch(/can't go down to 1/);
    expect(teamShrinkProblem(chart("a", "b", "c") as any, chart("a", "b") as any)).toBeNull();
    expect(teamShrinkProblem(chart("a") as any, chart("a") as any)).toBeNull();
    expect(teamShrinkProblem(chart("a") as any, { nodes: [] } as any)).toMatch(/go down to 0/);
  });

  it("the hub rejects a team with no agents, with one, or with none given", async () => {
    for (const [name, team] of [["none-at-all", undefined], ["empty-team", chart()], ["one-agent", chart(ada.id)]] as const) {
      const r = await create(name, team);
      expect(r.status, name).toBe(400);
      expect(r.data.error, name).toMatch(/at least 2 agents/);
    }
    expect((await api("GET", "/api/channels")).data.some((c: any) => /^(none-at-all|empty-team|one-agent)$/.test(c.name))).toBe(false);
  });

  it("the hub rejects a one-agent team made of steps", async () => {
    const steps = [{ id: "s1", roleId: "", kind: "do", action: "Plan", agentId: ada.id, next: "s2", x: 0, y: 0 }, { id: "s2", roleId: "", kind: "do", action: "Build", agentId: ada.id, next: null, x: 0, y: 0 }];
    const r = await create("one-agent-steps", { nodes: [], edges: [], roles: [], steps });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/at least 2 agents/);
  });

  it("accepts a team of two, as a chart and as steps", async () => {
    expect((await create("two-chart", chart(ada.id, bo.id))).status).toBe(200);
    const steps = [{ id: "s1", roleId: "", kind: "do", action: "Plan", agentId: ada.id, next: "s2", x: 0, y: 0 }, { id: "s2", roleId: "", kind: "do", action: "Build", agentId: bo.id, next: null, x: 0, y: 0 }];
    const r = await create("two-steps", { nodes: [], edges: [], roles: [], steps });
    expect(r.status).toBe(200);
    expect(r.data.settings.team.nodes).toHaveLength(2);
  });

  it("refuses to shrink a team below 2 by settings or by removing an agent", async () => {
    const id = (await create("shrink-me", chart(ada.id, bo.id, cy.id))).data.id;
    // 3 -> 1 refused, 3 -> 2 fine
    const down = await api("PATCH", `/api/channels/${id}`, { settings: { team: chart(ada.id) } });
    expect(down.status).toBe(400);
    expect(down.data.error).toMatch(/at least 2 agents/);
    expect((await api("PATCH", `/api/channels/${id}`, { settings: { team: chart(ada.id, bo.id) } })).status).toBe(200);
    const gone = await api("DELETE", `/api/channels/${id}/members/agent/${bo.id}`);
    expect(gone.status).toBe(409);
    expect(gone.data.error).toMatch(/at least 2 agents/);
    const members = (await api("GET", `/api/channels/${id}/members`)).data;
    expect(members.some((m: any) => m.id === bo.id)).toBe(true);
  });

  it("leaves a team that already has fewer than 2 working and editable", async () => {
    // made before the rule, straight into the store
    const created = hub.store.createChannel(hub.store.agent(ada.id)!.workspaceId, "old-small", "channel");
    hub.store.updateChannel(created.id, { settings: { team: chart(ada.id) } });
    hub.store.addChannelMember(created.id, { kind: "agent", id: ada.id });
    // it can still be renamed and re-saved at its size, and its member list loads
    expect((await api("PATCH", `/api/channels/${created.id}`, { topic: "still fine", settings: { team: chart(ada.id) } })).status).toBe(200);
    expect((await api("GET", `/api/channels/${created.id}/members`)).status).toBe(200);
    // and grows
    expect((await api("PATCH", `/api/channels/${created.id}`, { settings: { team: chart(ada.id, bo.id) } })).status).toBe(200);
  });
});
