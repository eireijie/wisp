import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TEAM_TEMPLATES, stepsProblem, teamFromTemplate, type TeamFlow } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
const agents: Record<string, any> = {};
const tokens: Record<string, string> = {};

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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-team-flows-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  for (const h of ["atlas", "sol", "forge", "pixel"]) {
    agents[h] = (await api("POST", "/api/agents", { handle: h, name: h[0].toUpperCase() + h.slice(1), harness: "custom" })).data;
    tokens[h] = (await api("POST", `/api/agents/${agents[h].id}/token`)).data.token;
  }
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** The "Plan and challenge" template, filled: Atlas leads and reviews, Sol challenges, Forge and Pixel build. */
function planTeam() {
  const t = teamFromTemplate(TEAM_TEMPLATES.find((x) => x.id === "plan-challenge")!);
  const fill: Record<string, string> = { lead: "atlas", challenger: "sol", backend: "forge", frontend: "pixel", reviewer: "atlas" };
  return { nodes: [], edges: [], roles: t.roles.map((r) => ({ ...r, agentId: agents[fill[r.id]].id })), steps: t.steps };
}

const flowsOf = async (channelId: string) => (await api<TeamFlow[]>("GET", `/api/channels/${channelId}/flows`)).data;
const openTaskFor = (handle: string) => hub.store.tasks(agents[handle].workspaceId, { agentId: agents[handle].id }).find((t) => t.toAgentId === agents[handle].id && t.status === "open")!;
const finish = (handle: string, taskId: string, result: string, verdict?: "approved" | "changes") => api("PATCH", `/api/tasks/${taskId}`, { status: "done", result, ...(verdict ? { verdict } : {}) }, tokens[handle]);

describe("roles and steps", () => {
  it("say what's missing in plain words", () => {
    const t = teamFromTemplate(TEAM_TEMPLATES[0]);
    expect(stepsProblem(t)).toMatch(/Pick an agent for Lead/);
    expect(stepsProblem({ roles: t.roles.map((r) => ({ ...r, agentId: "x" })), steps: t.steps })).toBeNull();
    const circle = t.steps.map((s) => (s.id === "report" ? { ...s, next: "plan" } : s));
    expect(stepsProblem({ roles: t.roles.map((r) => ({ ...r, agentId: "x" })), steps: circle })).toMatch(/circle/);
    for (const tpl of TEAM_TEMPLATES) {
      const filled = teamFromTemplate(tpl);
      expect(stepsProblem({ roles: filled.roles.map((r) => ({ ...r, agentId: "x" })), steps: filled.steps }), tpl.id).toBeNull();
    }
  });

  it("keep a plain chart for older apps: the first step's agent leads", async () => {
    const ch = (await api("POST", "/api/channels", { name: "chart", settings: { team: planTeam() } })).data;
    const lead = ch.settings.team.nodes.find((n: any) => n.lead);
    expect(lead.agentId).toBe(agents.atlas.id);
    expect(ch.settings.team.nodes).toHaveLength(4);
    // an app that only knows the chart saves it without wiping the roles
    const saved = await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { nodes: ch.settings.team.nodes, edges: ch.settings.team.edges } } });
    expect(saved.data.settings.team.roles).toHaveLength(5);
  });
});

describe("a stepped team at work", () => {
  it("plans, gets challenged until approved, hands out, reviews each piece, and reports", async () => {
    const ch = (await api("POST", "/api/channels", { name: "launch-site", settings: { team: planTeam() } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Add a waitlist page" });

    // 1. the lead plans
    let plan = openTaskFor("atlas");
    expect(plan.title).toBe("Draft a thorough plan");
    expect(plan.brief).toMatch(/Add a waitlist page/);
    await finish("atlas", plan.id, "Plan v1");

    // 2. the challenger sends it back once, then approves
    let review = openTaskFor("sol");
    expect(review.brief).toMatch(/Plan v1/);
    await finish("sol", review.id, "1. No rate limit", "changes");
    plan = openTaskFor("atlas");
    expect(plan.brief).toMatch(/Sent back by Challenger/);
    expect(plan.brief).toMatch(/No rate limit/);
    expect(plan.brief).toMatch(/round 2/);
    await finish("atlas", plan.id, "Plan v2");
    review = openTaskFor("sol");
    await finish("sol", review.id, "Ready", "approved");

    // 3. the lead hands out pieces, which are reviewed one by one
    const handOut = openTaskFor("atlas");
    expect(handOut.title).toBe("Hand out the pieces");
    expect(handOut.brief).toMatch(/Plan v2/);
    expect(handOut.brief).toMatch(/`forge` \(Backend builder\)/);
    expect(handOut.brief).not.toMatch(/@forge/);
    const api1 = (await api("POST", "/api/tasks", { to: "@forge", title: "API", brief: "POST /api/waitlist", parentTaskId: handOut.id }, tokens.atlas)).data;
    const page = (await api("POST", "/api/tasks", { to: "@pixel", title: "Page", brief: "/waitlist", parentTaskId: handOut.id }, tokens.atlas)).data;
    await finish("forge", api1.id, "API done");
    const apiReview = openTaskFor("atlas");
    expect(apiReview.title).toBe("Review: API");
    await finish("atlas", apiReview.id, "1. Duplicate emails", "changes");
    const fix = openTaskFor("forge");
    expect(fix.title).toBe("Changes: API");
    await finish("forge", fix.id, "Fixed");
    await finish("atlas", openTaskFor("atlas").id, "Good", "approved");
    // the lead says it's handed out before the last piece is approved: the flow waits for it
    await finish("atlas", handOut.id, "Both pieces in");
    expect((await flowsOf(ch.id))[0].stepId).toBe("hand-out");
    await finish("pixel", page.id, "Page done");
    await finish("atlas", openTaskFor("atlas").id, "Good", "approved");

    // 4. the lead reports, and it's done
    const report = openTaskFor("atlas");
    expect(report.title).toBe("Report back");
    await finish("atlas", report.id, "Shipped");
    const [flow] = await flowsOf(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.history.map((h) => `${h.stepId}:${h.verdict}`)).toEqual(["plan:done", "challenge:changes", "plan:done", "challenge:approved", "hand-out:done", "report:done"]);
  });

  it("asks a person once a review runs out of rounds, and goes on when they approve", async () => {
    const team = planTeam();
    team.steps = team.steps.map((s) => (s.id === "challenge" ? { ...s, maxRounds: 1 } : s));
    const ch = (await api("POST", "/api/channels", { name: "strict", settings: { team } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Rewrite the docs" });
    await finish("atlas", openTaskFor("atlas").id, "Plan");
    await finish("sol", openTaskFor("sol").id, "1. Too vague", "changes");
    let [flow] = await flowsOf(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.options).toBe("rounds");
    flow = (await api("POST", `/api/flows/${flow.id}/decide`, { action: "approve" })).data;
    expect(flow.status).toBe("running");
    expect(flow.stepId).toBe("hand-out");
    expect(flow.history.find((h) => h.stepId === "challenge")?.verdict).toBe("approved");
    expect(openTaskFor("atlas").brief).toMatch(/Plan/);
  });

  it("still lets an @mention reach one agent directly", async () => {
    const ch = (await api("POST", "/api/channels", { name: "mentions", settings: { team: planTeam() } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "@sol quick question" });
    expect(await flowsOf(ch.id)).toEqual([]);
  });
});

describe("an agent setting up a team from a description", () => {
  it("names roles and steps in words and handles; Wisp turns them into a chart", async () => {
    const ch = (await api("POST", "/api/channels", { name: "described" })).data;
    // the first agent is the workspace's lead
    const body = {
      roles: [
        { name: "Lead", description: "Plans and hands out.", agent: "@atlas" },
        { name: "Challenger", description: "Pokes holes.", agent: "sol" },
        { name: "Builder", description: "Builds.", agent: "forge" },
      ],
      steps: [
        { role: "Lead", action: "Plan it" },
        { role: "Challenger", kind: "review", action: "Challenge the plan", send_back_to: 1, max_rounds: 2 },
        { role: "lead", kind: "hand_out", action: "Hand it out", hand_to: ["Builder"] },
      ],
    };
    const notLead = await api("PUT", `/api/channels/${ch.id}/team-steps`, body, tokens.forge);
    expect(notLead.status).toBe(403);
    const r = await api("PUT", "/api/channels/described/team-steps", body, tokens.atlas);
    expect(r.status).toBe(200);
    const team = r.data.settings.team;
    expect(team.steps.map((s: any) => s.kind)).toEqual(["do", "review", "hand_out"]);
    expect(team.steps[1].sendBackTo).toBe(team.steps[0].id);
    expect(team.nodes.find((n: any) => n.lead).agentId).toBe(agents.atlas.id);
    const bad = await api("PUT", `/api/channels/${ch.id}/team-steps`, { ...body, roles: [{ name: "Lead", description: "", agent: "nobody" }] }, tokens.atlas);
    expect(bad.data.error).toMatch(/no agent called nobody/);
  });
});
