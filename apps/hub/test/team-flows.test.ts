import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TEAM_TEMPLATES, stepsProblem, teamFromTemplate, type TeamFlow } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import { makeRoomAs } from "./room.ts";
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
  // the vault's git can still be writing as the hub closes: retry instead of failing on ENOTEMPTY
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    // a plain chat for the agent to turn into a team (the API only makes teams of two or more)
    const ch = (await makeRoomAs(hub, base, owner, { name: "described" })).data;
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

/** A Plan and challenge team with some roles filled differently. */
function teamWith(fill: Record<string, string>, maxRounds?: number) {
  const t = planTeam();
  return { ...t, roles: t.roles.map((r) => (fill[r.id] ? { ...r, agentId: agents[fill[r.id]].id } : r)), steps: maxRounds ? t.steps.map((s) => (s.kind === "review" || s.kind === "hand_out" ? { ...s, maxRounds } : s)) : t.steps };
}
const tasksIn = (handle: string, channelId: string) => hub.store.tasks(agents[handle].workspaceId, { agentId: agents[handle].id }).filter((t) => t.toAgentId === agents[handle].id && t.channelId === channelId);
const openIn = (handle: string, channelId: string) => tasksIn(handle, channelId).filter((t) => t.status === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
const flowIn = async (channelId: string) => (await flowsOf(channelId))[0];
const decide = (flowId: string, action: "approve" | "retry" | "stop" | "allow") => api<TeamFlow>("POST", `/api/flows/${flowId}/decide`, { action });
/** A new channel for the team, with a request already planned and approved: the hand-out is open. */
async function atHandOut(name: string, team: ReturnType<typeof planTeam>) {
  const ch = (await api("POST", "/api/channels", { name, settings: { team } })).data;
  await api("POST", `/api/channels/${ch.id}/messages`, { body: `Do ${name}` });
  await finish("atlas", openIn("atlas", ch.id).id, "Plan");
  await finish("sol", openIn("sol", ch.id).id, "Fine", "approved");
  return { ch, handOut: openIn("atlas", ch.id) };
}
const piece = async (handOut: { id: string }, to: string, title: string) => (await api("POST", "/api/tasks", { to: `@${to}`, title, brief: title, parentTaskId: handOut.id }, tokens.atlas)).data;

describe("a stepped team when things go wrong", () => {
  it("waits for a person when a step's task is cancelled, instead of hanging", async () => {
    const ch = (await api("POST", "/api/channels", { name: "cancelled", settings: { team: planTeam() } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    await api("POST", `/api/tasks/${openIn("atlas", ch.id).id}/cancel`);
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.why).toMatch(/couldn't finish .*: Cancelled\./);
    // a run that failed offers Try again or Skip (the app hides Approve), never "approve anyway"
    expect(flow.waitingFor?.failed).toBe(true);
    expect(flow.waitingFor?.why).not.toMatch(/approve/i);
  });

  it("waits for a person when a role's agent is removed mid-step, then says the role needs someone", async () => {
    const temp = (await api("POST", "/api/agents", { handle: "temp", name: "Temp", harness: "custom" })).data;
    agents.temp = temp;
    const ch = (await api("POST", "/api/channels", { name: "removed", settings: { team: teamWith({ lead: "temp", reviewer: "atlas" }) } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    await api("DELETE", `/api/agents/${temp.id}`);
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    // the team keeps its roles and steps; the Lead role is just empty now
    const team = hub.store.channel(ch.id)!.settings.team!;
    expect(team.steps).toHaveLength(4);
    expect(team.roles!.find((r) => r.id === "lead")?.agentId).toBeNull();
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.why).toMatch(/Lead has nobody/);
    // not a run failure: no "failed" flag
    expect(flow.waitingFor?.failed).toBeUndefined();
  });

  it("asks about a failed piece, and trying again hands it back to its builder", async () => {
    const { ch, handOut } = await atHandOut("failed-piece", planTeam());
    const p = await piece(handOut, "forge", "API");
    await api("PATCH", `/api/tasks/${p.id}`, { status: "failed", result: "Out of disk" }, tokens.forge);
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.piece).toBe(p.id);
    expect(flow.waitingFor?.why).toMatch(/API\*\* didn't finish: Out of disk/);
    expect(flow.waitingFor?.failed).toBe(true);
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.status).toBe("running");
    const again = openIn("forge", ch.id);
    expect(again.title).toBe("Try again: API");
    await finish("forge", again.id, "Done now");
    expect(openIn("atlas", ch.id).title).toBe("Review: Try again: API");
  });

  it("gives a piece that ran out of rounds another round with its builder, instead of approving it", async () => {
    const { ch, handOut } = await atHandOut("piece-rounds", teamWith({}, 1));
    const p = await piece(handOut, "forge", "API");
    await finish("forge", p.id, "API v1");
    await finish("atlas", openIn("atlas", ch.id).id, "1. Validate input", "changes");
    let flow = await flowIn(ch.id);
    expect(flow.waitingFor).toMatchObject({ options: "rounds", piece: p.id });
    await finish("atlas", handOut.id, "Handed out");
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.stepId).toBe("hand-out");
    expect(flow.pieces[p.id].status).toBe("building");
    const changes = openIn("forge", ch.id);
    expect(changes.title).toBe("Changes: API");
    expect(changes.brief).toMatch(/Validate input/);
    // approved this time: the flow moves on to the report
    await finish("forge", changes.id, "API v2");
    await finish("atlas", openIn("atlas", ch.id).id, "Good", "approved");
    expect((await flowIn(ch.id)).stepId).toBe("report");
  });

  it("stops a request whose step was edited away, and cancels its open task", async () => {
    const ch = (await api("POST", "/api/channels", { name: "edited", settings: { team: planTeam() } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    const plan = openIn("atlas", ch.id);
    const team = ch.settings.team;
    const swap = (xs: string[]) => xs.map((x) => (x === "plan" ? "plan-2" : x));
    const renamed = team.steps.map((s: any) => ({ ...s, id: s.id === "plan" ? "plan-2" : s.id, next: s.next === "plan" ? "plan-2" : s.next, nexts: swap(s.nexts ?? []), inputs: swap(s.inputs ?? []), sendBackTo: s.sendBackTo === "plan" ? "plan-2" : s.sendBackTo }));
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { ...team, steps: renamed } } })).status).toBe(200);
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("failed");
    expect(hub.store.task(plan.id)?.status).toBe("failed");
  });

  it("starts one review when a piece is finished twice", async () => {
    const { ch, handOut } = await atHandOut("twice", planTeam());
    const p = await piece(handOut, "forge", "API");
    await finish("forge", p.id, "Done");
    await finish("forge", p.id, "Done again");
    expect(tasksIn("atlas", ch.id).filter((t) => t.title === "Review: API")).toHaveLength(1);
  });

  it("doesn't let a piece's builder be its only reviewer", async () => {
    const { ch, handOut } = await atHandOut("self-review", teamWith({ reviewer: "forge" }));
    const p = await piece(handOut, "forge", "API");
    await finish("forge", p.id, "Done");
    const flow = await flowIn(ch.id);
    expect(flow.pieces[p.id].status).toBe("failed");
    expect(flow.waitingFor?.why).toMatch(/built by Forge, who is also the Reviewer/);
  });

  it("says a failed step once, without the run's own lead-in", async () => {
    const { failureReason } = await import("../src/team-flows.ts");
    expect(failureReason("Bea's run failed: Claude Code on This Mac isn't signed in")).toBe("Claude Code on This Mac isn't signed in.");
    expect(failureReason(null)).toBe("no reason given.");
  });

  it("doesn't let an agent review its own step", async () => {
    const ch = (await api("POST", "/api/channels", { name: "own-step", settings: { team: teamWith({ challenger: "atlas" }) } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    await finish("atlas", openIn("atlas", ch.id).id, "Plan");
    const flow = await flowIn(ch.id);
    expect(flow).toMatchObject({ status: "waiting", stepId: "challenge" });
    expect(flow.waitingFor?.why).toMatch(/reviewing its own work/);
    // plain choices, not "approve anyway": pick another agent, or let Atlas do it
    expect(flow.waitingFor?.selfReview).toEqual({ agent: "Atlas" });
    expect(flow.waitingFor?.why).not.toMatch(/approve/i);
    const after = (await decide(flow.id, "allow")).data;
    expect(after.status).toBe("running");
    expect(openIn("atlas", ch.id).title).toMatch(/challenge/i);
  });

  it("asks a person when a review says neither approved nor changes", async () => {
    const ch = (await api("POST", "/api/channels", { name: "no-verdict", settings: { team: planTeam() } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    await finish("atlas", openIn("atlas", ch.id).id, "Plan");
    await finish("sol", openIn("sol", ch.id).id, "Hmm");
    let flow = await flowIn(ch.id);
    expect(flow).toMatchObject({ status: "waiting", stepId: "challenge" });
    // trying again asks the challenger again
    flow = (await decide(flow.id, "retry")).data;
    expect(openIn("sol", ch.id).title).toMatch(/challenge the plan/i);
    // a piece's review without a verdict waits too
    const { ch: ch2, handOut } = await atHandOut("piece-no-verdict", planTeam());
    const p = await piece(handOut, "forge", "API");
    await finish("forge", p.id, "Done");
    await finish("atlas", openIn("atlas", ch2.id).id, "Looks ok?");
    expect((await flowIn(ch2.id)).pieces[p.id].status).toBe("failed");
  });

  it("Stop cancels the work still open, and only Stop works on a running request", async () => {
    const { ch, handOut } = await atHandOut("stop", planTeam());
    const p = await piece(handOut, "forge", "API");
    const flow = await flowIn(ch.id);
    expect((await decide(flow.id, "approve")).status).toBe(409);
    expect((await decide(flow.id, "stop")).data.status).toBe("failed");
    expect(hub.store.task(handOut.id)?.status).toBe("failed");
    expect(hub.store.task(p.id)?.status).toBe("failed");
  });

  it("tries again the step that had nobody, not the one before it", async () => {
    const temp2 = (await api("POST", "/api/agents", { handle: "temp2", name: "Temp2", harness: "custom" })).data;
    agents.temp2 = temp2;
    const ch = (await api("POST", "/api/channels", { name: "nobody", settings: { team: teamWith({ challenger: "temp2" }) } })).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Plan a thing" });
    // the challenger leaves mid-request, so the challenge step has nobody when the plan is done
    await api("DELETE", `/api/agents/${temp2.id}`);
    await finish("atlas", openIn("atlas", ch.id).id, "Plan");
    let flow = await flowIn(ch.id);
    expect(flow).toMatchObject({ status: "waiting", stepId: "challenge" });
    // someone fills the role, then tries again: the challenge runs, not a new plan
    const team = hub.store.channel(ch.id)!.settings.team!;
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { ...team, roles: team.roles!.map((r) => (r.id === "challenger" ? { ...r, agentId: agents.sol.id } : r)) } } })).status).toBe(200);
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.stepId).toBe("challenge");
    expect(openIn("sol", ch.id).brief).toMatch(/Plan/);
    expect(tasksIn("atlas", ch.id).filter((t) => t.title === "Draft a thorough plan")).toHaveLength(1);
  });

  it("tells an app that only draws the chart it can't change who's on a stepped team", async () => {
    const ch = (await api("POST", "/api/channels", { name: "old-app", settings: { team: planTeam() } })).data;
    const { nodes, edges } = ch.settings.team;
    const r = await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { nodes: nodes.filter((n: any) => n.agentId !== agents.pixel.id), edges } } });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Team tab in the web app/);
  });
});
