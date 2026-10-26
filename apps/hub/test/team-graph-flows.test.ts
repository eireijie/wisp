import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Approval, TeamDraft, TeamFlow, TeamStep } from "@wisp/core";
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-team-graph-"));
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
}, 90_000);

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 60_000);

/** A step as the builder writes it: its own agent, prompt and inputs. */
const step = (id: string, handle: string | null, extra: Partial<TeamStep> = {}): Partial<TeamStep> => ({ id, roleId: "", kind: "do", action: id, agentId: handle ? agents[handle].id : null, next: null, ...extra });
const team = (steps: Partial<TeamStep>[]) => ({ nodes: [], edges: [], roles: [], steps });
const channel = async (name: string, steps: Partial<TeamStep>[]) => (await api("POST", "/api/channels", { name, settings: { team: team(steps) } })).data;
const say = (ch: { id: string }, body = "Ship dark mode") => api("POST", `/api/channels/${ch.id}/messages`, { body });
const flowsOf = async (channelId: string) => (await api<TeamFlow[]>("GET", `/api/channels/${channelId}/flows`)).data;
const flowIn = async (channelId: string) => (await flowsOf(channelId))[0];
const tasksIn = (handle: string, channelId: string) => hub.store.tasks(agents[handle].workspaceId, { agentId: agents[handle].id }).filter((t) => t.toAgentId === agents[handle].id && t.channelId === channelId);
const openIn = (handle: string, channelId: string) => tasksIn(handle, channelId).filter((t) => t.status === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
const finish = (handle: string, taskId: string, result: string, verdict?: "approved" | "changes") => api("PATCH", `/api/tasks/${taskId}`, { status: "done", result, ...(verdict ? { verdict } : {}) }, tokens[handle]);
const pending = async () => (await api<Approval[]>("GET", "/api/approvals?status=pending")).data;
const decide = (flowId: string, action: "approve" | "retry" | "stop" | "changes", extra: Record<string, unknown> = {}) => api<TeamFlow>("POST", `/api/flows/${flowId}/decide`, { action, ...extra });

describe("steps that run at the same time", () => {
  it("starts every step nothing leads to together, waits for all of a step's inputs, and hands it their results", async () => {
    const ch = await channel("crew", [
      step("plan", "atlas", { action: "Plan the work", prompt: "Write a short plan." }),
      step("research", "sol", { action: "Research the options" }),
      step("build", "forge", { action: "Build it", inputs: ["plan", "research"], prompt: "Build from the plan and the research." }),
    ]);
    expect(ch.settings.team.steps.find((s: any) => s.id === "build")).toMatchObject({ inputs: ["plan", "research"], nexts: [], next: null });
    expect(ch.settings.team.steps.find((s: any) => s.id === "plan")).toMatchObject({ nexts: ["build"], next: "build" });
    await say(ch);
    // both start right away
    const plan = openIn("atlas", ch.id)!;
    const research = openIn("sol", ch.id)!;
    expect(plan.brief).toMatch(/Write a short plan/);
    expect(openIn("forge", ch.id)).toBeUndefined();
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("running");
    expect(Object.values(flow.lanes!).map((l) => `${l.stepId}:${l.status}`).sort()).toEqual(["plan:running", "research:running"]);

    // one finished: the join still waits
    await finish("atlas", plan.id, "Plan v1");
    expect(openIn("forge", ch.id)).toBeUndefined();
    flow = await flowIn(ch.id);
    expect(flow.lanes!.plan.status).toBe("done");
    expect(flow.status).toBe("running");

    // both finished: the join runs with both results
    await finish("sol", research.id, "Use library B");
    const build = openIn("forge", ch.id)!;
    expect(build.title).toBe("Build it");
    expect(build.brief).toMatch(/Plan v1/);
    expect(build.brief).toMatch(/Use library B/);
    expect(build.brief).toMatch(/Build from the plan and the research/);
    await finish("forge", build.id, "Built");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.result).toBe("Built");
    expect(flow.history.map((h) => h.stepId).sort()).toEqual(["build", "plan", "research"]);
  });

  it("a step failing in one branch waits for a person without stopping the other, and retry runs just that step", async () => {
    const ch = await channel("one-fails", [step("a", "atlas"), step("b", "sol"), step("c", "forge", { inputs: ["a", "b"] })]);
    await say(ch);
    await api("PATCH", `/api/tasks/${openIn("sol", ch.id)!.id}`, { status: "failed", result: "Out of disk" }, tokens.sol);
    let flow = await flowIn(ch.id);
    // atlas is still working, so it's running; only b needs a person
    expect(flow.status).toBe("running");
    expect(flow.lanes!.b.status).toBe("waiting");
    expect(flow.lanes!.a.status).toBe("running");
    await finish("atlas", openIn("atlas", ch.id)!.id, "A done");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.stepId).toBe("b");
    expect(flow.waitingFor?.why).toMatch(/didn't finish: Out of disk/);
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.status).toBe("running");
    await finish("sol", openIn("sol", ch.id)!.id, "B done");
    expect(openIn("forge", ch.id)!.brief).toMatch(/A done/);
    expect(tasksIn("atlas", ch.id)).toHaveLength(1);
  });

  it("Stop cancels every branch that's still open", async () => {
    const ch = await channel("stop-all", [step("a", "atlas"), step("b", "sol")]);
    await say(ch);
    const a = openIn("atlas", ch.id)!;
    const b = openIn("sol", ch.id)!;
    const flow = await flowIn(ch.id);
    expect((await decide(flow.id, "approve")).status).toBe(409);
    expect((await decide(flow.id, "stop")).data.status).toBe("failed");
    expect(hub.store.task(a.id)?.status).toBe("failed");
    expect(hub.store.task(b.id)?.status).toBe("failed");
  });

  it("is done when the last parallel branch finishes", async () => {
    const ch = await channel("two-ends", [step("a", "atlas"), step("b", "sol")]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "A");
    expect((await flowIn(ch.id)).status).toBe("running");
    await finish("sol", openIn("sol", ch.id)!.id, "B");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.result).toBe("A\n\nB");
  });
});

describe("repeat until approved", () => {
  it("sends the work back to the step it names, only the steps after it start over, and asks a person at the limit", async () => {
    const ch = await channel("repeat", [
      step("plan", "atlas"),
      step("research", "pixel"),
      step("draft", "forge", { inputs: ["plan"] }),
      step("check", "sol", { kind: "review", action: "Check the draft", inputs: ["draft"], sendBackTo: "draft", maxRounds: 2 }),
    ]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Plan");
    await finish("pixel", openIn("pixel", ch.id)!.id, "Research");
    await finish("forge", openIn("forge", ch.id)!.id, "Draft 1");
    await finish("sol", openIn("sol", ch.id)!.id, "1. Too short", "changes");
    // the draft goes round again; the independent research branch isn't redone
    let draft = openIn("forge", ch.id)!;
    expect(draft.brief).toMatch(/Sent back by/);
    expect(draft.brief).toMatch(/Too short/);
    expect(draft.brief).toMatch(/round 2/);
    expect(tasksIn("pixel", ch.id)).toHaveLength(1);
    await finish("forge", draft.id, "Draft 2");
    // round limit reached: a person decides
    await finish("sol", openIn("sol", ch.id)!.id, "2. Still short", "changes");
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.options).toBe("rounds");
    expect(flow.waitingFor?.why).toMatch(/sent it back 2 times/);
    // another round starts the draft again
    flow = (await decide(flow.id, "retry")).data;
    expect(flow.status).toBe("running");
    draft = openIn("forge", ch.id)!;
    expect(draft.brief).toMatch(/Still short/);
    await finish("forge", draft.id, "Draft 3");
    await finish("sol", openIn("sol", ch.id)!.id, "Good", "approved");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.result).toContain("Draft 3");
  });

  it("approving at the limit goes on as if it passed", async () => {
    const ch = await channel("repeat-approve", [step("a", "atlas"), step("r", "sol", { kind: "review", inputs: ["a"], sendBackTo: "a", maxRounds: 1 }), step("z", "forge", { inputs: ["r"] })]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Work");
    await finish("sol", openIn("sol", ch.id)!.id, "Nope", "changes");
    const flow = await flowIn(ch.id);
    expect(flow.waitingFor?.options).toBe("rounds");
    await decide(flow.id, "approve");
    expect(openIn("forge", ch.id)!.brief).toMatch(/Work/);
  });
});

describe("ask me", () => {
  it("keeps the Inbox card but sends no notification when 'Tell me on my phone' is off", async () => {
    for (const [name, notifyPhone] of [["quiet", false], ["loud", true]] as const) {
      const ch = await channel(name, [step("build", "forge"), step("approve", null, { kind: "ask", action: "Approve", inputs: ["build"], notifyPhone })]);
      await say(ch);
      await finish("forge", openIn("forge", ch.id)!.id, "Done");
      const card = (await pending()).find((a) => a.channelId === ch.id)!;
      expect(card).toBeTruthy();
      expect(hub.flows.silentApproval(card)).toBe(!notifyPhone);
    }
    expect(hub.flows.silentApproval({ flow: null })).toBe(false);
  });

  it("shows up in the Inbox, goes on when approved, and goes back with a note when you ask for changes", async () => {
    const ch = await channel("ask", [
      step("build", "forge", { action: "Build it" }),
      step("approve", null, { kind: "ask", action: "Approve before it ships", inputs: ["build"], sendBackTo: "build", show: "The finished build." }),
      step("ship", "atlas", { action: "Ship it", inputs: ["approve"] }),
    ]);
    await say(ch);
    await finish("forge", openIn("forge", ch.id)!.id, "Build v1");
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.options).toBe("ask");
    const cards = (await pending()).filter((a) => a.channelId === ch.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ summary: "Approve before it ships", flow: { flowId: flow.id, stepId: "approve" } });
    expect(cards[0].details).toMatch(/The finished build\./);
    expect(cards[0].details).toMatch(/Build v1/);

    // "no" with a note sends it back to the build
    const denied = await api("POST", `/api/approvals/${cards[0].id}/decide`, { approve: false, note: "Add a loading state" });
    expect(denied.status).toBe(200);
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("running");
    const rebuild = openIn("forge", ch.id)!;
    expect(rebuild.brief).toMatch(/Add a loading state/);
    expect(rebuild.brief).toMatch(/Sent back by You/);
    // the old card is closed and a fresh one comes with the new build
    await finish("forge", rebuild.id, "Build v2");
    const again = (await pending()).filter((a) => a.channelId === ch.id);
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(cards[0].id);
    // yes goes on, and the next step gets the work
    await api("POST", `/api/approvals/${again[0].id}/decide`, { approve: true });
    const ship = openIn("atlas", ch.id)!;
    expect(ship.brief).toMatch(/Build v2/);
    await finish("atlas", ship.id, "Shipped");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.history.filter((h) => h.stepId === "build")).toHaveLength(2);
  });

  it("can be answered from the request too, and asking again makes a new card", async () => {
    const ch = await channel("ask-flow", [step("a", "atlas"), step("ok", null, { kind: "ask", action: "Look this over", inputs: ["a"] })]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Result");
    let flow = await flowIn(ch.id);
    const first = (await pending()).find((a) => a.flow?.flowId === flow.id)!;
    flow = (await decide(flow.id, "retry")).data;
    expect(hub.store.approval(first.id)?.status).toBe("denied");
    const second = (await pending()).find((a) => a.flow?.flowId === flow.id)!;
    expect(second.id).not.toBe(first.id);
    // approve from the flow: the card closes too
    flow = (await decide(flow.id, "approve")).data;
    expect(flow.status).toBe("done");
    expect(hub.store.approval(second.id)?.status).toBe("approved");
  });

  it("only a step that asks can be sent back with changes, and no way back stops the request", async () => {
    const ch = await channel("ask-stop", [step("a", "atlas"), step("ok", null, { kind: "ask", inputs: ["a"] })]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Result");
    const card = (await pending()).find((a) => a.channelId === ch.id)!;
    await api("POST", `/api/approvals/${card.id}/decide`, { approve: false, note: "No" });
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("failed");
    const ch2 = await channel("review-changes", [step("a", "atlas"), step("r", "sol", { kind: "review", inputs: ["a"], sendBackTo: "a" })]);
    await say(ch2);
    await finish("atlas", openIn("atlas", ch2.id)!.id, "x");
    await finish("sol", openIn("sol", ch2.id)!.id, "no verdict");
    const waiting = await flowIn(ch2.id);
    expect((await decide(waiting.id, "changes")).status).toBe(409);
  });
});

describe("if / else", () => {
  it("an agent answers yes or no; the other way's steps are skipped and a join after them still runs", async () => {
    const ch = await channel("branch", [
      step("build", "forge"),
      step("check", "sol", { kind: "branch", action: "Did the tests pass", inputs: ["build"], condition: "every test passed", ifTrue: "ship", ifFalse: "fix" }),
      step("ship", "atlas", { action: "Ship it" }),
      step("fix", "pixel", { action: "Fix it" }),
      step("report", "atlas", { action: "Report", inputs: ["ship", "fix"] }),
    ]);
    // an arrow from the if/else to each branch
    const t = ch.settings.team.steps;
    expect(t.find((s: any) => s.id === "ship").inputs).toEqual(["check"]);
    await say(ch);
    await finish("forge", openIn("forge", ch.id)!.id, "Build output");
    const ask = openIn("sol", ch.id)!;
    expect(ask.brief).toMatch(/every test passed/);
    expect(ask.brief).toMatch(/Build output/);
    await finish("sol", ask.id, "All green", "approved");
    // only the yes way runs
    expect(openIn("pixel", ch.id)).toBeUndefined();
    const ship = openIn("atlas", ch.id)!;
    expect(ship.title).toBe("Ship it");
    expect(ship.brief).toMatch(/Build output/);
    let flow = await flowIn(ch.id);
    expect(flow.lanes!.fix.status).toBe("skipped");
    await finish("atlas", ship.id, "Shipped");
    const report = openIn("atlas", ch.id)!;
    expect(report.title).toBe("Report");
    expect(report.brief).toMatch(/Shipped/);
    await finish("atlas", report.id, "Reported");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
  });

  it("a rule decides without an agent, and going back is limited to its rounds", async () => {
    const ch = await channel("rule", [
      step("build", "forge"),
      step("gate", null, { kind: "branch", action: "Passed?", inputs: ["build"], rule: { op: "contains", value: "PASS" }, ifTrue: "ship", ifFalse: "build", maxRounds: 2 }),
      step("ship", "atlas", { action: "Ship it" }),
    ]);
    await say(ch);
    // no: back to the build with the output as notes
    await finish("forge", openIn("forge", ch.id)!.id, "FAIL 3 tests");
    let build = openIn("forge", ch.id)!;
    expect(build.brief).toMatch(/Sent back/);
    expect(build.brief).toMatch(/FAIL 3 tests/);
    // no again: the second round is the last, so a person decides
    await finish("forge", build.id, "FAIL 1 test");
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.options).toBe("rounds");
    flow = (await decide(flow.id, "retry")).data;
    build = openIn("forge", ch.id)!;
    await finish("forge", build.id, "PASS all");
    const ship = openIn("atlas", ch.id)!;
    expect(ship.brief).toMatch(/PASS all/);
    await finish("atlas", ship.id, "Done");
    expect((await flowIn(ch.id)).status).toBe("done");
  });

  it("a rule with nothing after the no side simply ends that way", async () => {
    const ch = await channel("rule-end", [step("a", "atlas"), step("gate", null, { kind: "branch", inputs: ["a"], rule: { op: "starts_with", value: "yes" }, ifTrue: "b", ifFalse: null }), step("b", "sol")]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "no thanks");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(openIn("sol", ch.id)).toBeUndefined();
    expect(flow.lanes!.b.status).toBe("skipped");
  });

  it("asks a person when the agent answers neither yes nor no", async () => {
    const ch = await channel("branch-unclear", [step("a", "atlas"), step("q", "sol", { kind: "branch", inputs: ["a"], condition: "is it good", ifTrue: "b", ifFalse: null }), step("b", "forge")]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "x");
    await finish("sol", openIn("sol", ch.id)!.id, "maybe");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.why).toMatch(/didn't say yes or no/);
  });
});

describe("handing work to another team", () => {
  it("posts to the other team and waits for its answer when asked to", async () => {
    const support = await channel("support", [step("answer", "pixel", { action: "Answer customers" })]);
    const ch = await channel("hand-off", [step("build", "forge"), step("tell", null, { kind: "handoff", action: "Tell customers", inputs: ["build"], handoffTo: support.id, waitForReply: true, prompt: "Tell customers what changed." }), step("wrap", "atlas", { inputs: ["tell"] })]);
    await say(ch);
    await finish("forge", openIn("forge", ch.id)!.id, "Release notes v1");
    let flow = await flowIn(ch.id);
    expect(flow.status).toBe("running");
    expect(flow.lanes!.tell.status).toBe("running");
    // the other team started its own request, with the work in it
    const theirs = await flowIn(support.id);
    expect(theirs.status).toBe("running");
    expect(theirs.request).toMatch(/Tell customers what changed/);
    expect(theirs.request).toMatch(/Release notes v1/);
    expect(flow.lanes!.tell.handoff).toMatchObject({ channelId: support.id, flowId: theirs.id });
    expect(openIn("atlas", ch.id)).toBeUndefined();
    await finish("pixel", openIn("pixel", support.id)!.id, "Customers told");
    expect((await flowIn(support.id)).status).toBe("done");
    // their answer goes to the next step
    flow = await flowIn(ch.id);
    expect(flow.lanes!.tell.status).toBe("done");
    expect(openIn("atlas", ch.id)!.brief).toMatch(/Customers told/);
  });

  it("goes straight on when it doesn't wait", async () => {
    const other = await channel("fire-and-forget", [step("x", "pixel")]);
    const ch = await channel("hand-off-nowait", [step("a", "atlas"), step("tell", null, { kind: "handoff", inputs: ["a"], handoffTo: other.id, waitForReply: false }), step("z", "sol", { inputs: ["tell"] })]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Done");
    expect((await flowIn(other.id)).status).toBe("running");
    expect(openIn("sol", ch.id)!.brief).toMatch(/Handed to #fire-and-forget/);
  });

  it("wakes the lead of a team that has no steps", async () => {
    const plain = (await api("POST", "/api/channels", { name: "plain-team", settings: { team: { nodes: [{ agentId: agents.pixel.id, lead: true, x: 0, y: 0 }], edges: [] } } })).data;
    const ch = await channel("hand-off-plain", [step("a", "atlas"), step("tell", null, { kind: "handoff", inputs: ["a"], handoffTo: plain.id, waitForReply: true })]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Please look");
    const posted = hub.store.messages(plain.id, {}).find((m) => m.body.includes("Please look"));
    expect(posted?.body).toMatch(/^@pixel /);
    // a team without steps has no request to wait for, so this goes on
    expect((await flowIn(ch.id)).status).toBe("done");
  });

  it("waits for a person when the other team is gone, and stops teams handing work round in circles", async () => {
    const ch = await channel("hand-off-gone", [step("a", "atlas"), step("tell", null, { kind: "handoff", inputs: ["a"], handoffTo: "ch_nope" })]);
    expect(ch.error).toBeDefined();
    const a = await channel("loop-a", [step("a", "atlas")]);
    const b = await channel("loop-b", [step("b", "sol"), step("back", null, { kind: "handoff", inputs: ["b"], handoffTo: a.id, waitForReply: true })]);
    // a -> b -> a -> b ...: each hop is one deeper
    const a2 = await api("PATCH", `/api/channels/${a.id}`, { settings: { team: team([step("a", "atlas"), step("go", null, { kind: "handoff", inputs: ["a"], handoffTo: b.id, waitForReply: true })]) } });
    expect(a2.status).toBe(200);
    await say(a);
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const t = openIn("atlas", a.id) ?? openIn("sol", b.id);
      if (!t) break;
      await finish(t.toAgentId === agents.atlas.id ? "atlas" : "sol", t.id, `hop ${++n}`);
    }
    const flows = [...(await flowsOf(a.id)), ...(await flowsOf(b.id))];
    expect(flows.some((f) => f.status === "waiting" && /handed this work on 3 times/.test(f.waitingFor?.why ?? ""))).toBe(true);
    expect(flows.length).toBeLessThanOrEqual(4);
  });
});

describe("a team saved before flow charts", () => {
  const legacy = () => ({
    nodes: [],
    edges: [],
    roles: [
      { id: "lead", name: "Lead", description: "Plans it.", agentId: agents.atlas.id },
      { id: "rev", name: "Reviewer", description: "Checks it.", agentId: agents.sol.id },
    ],
    steps: [
      { id: "plan", roleId: "lead", kind: "do", action: "Plan it", next: "check", x: 0, y: 0 },
      { id: "check", roleId: "rev", kind: "review", action: "Check it", next: "ship", sendBackTo: "plan", maxRounds: 2, x: 0, y: 150 },
      { id: "ship", roleId: "lead", kind: "do", action: "Ship it", next: null, x: 0, y: 300 },
    ],
  });

  it("becomes a flow chart when it's saved, with the same roles and a prompt on every step", async () => {
    const ch = (await api("POST", "/api/channels", { name: "legacy-save", settings: { team: legacy() } })).data;
    const t = ch.settings.team;
    expect(t.roles).toHaveLength(2);
    expect(t.steps.map((s: any) => [s.id, s.inputs, s.nexts, s.prompt])).toEqual([
      ["plan", [], ["check"], "Plans it."],
      ["check", ["plan"], ["ship"], "Checks it."],
      ["ship", ["check"], [], "Plans it."],
    ]);
  });

  it("is migrated in place on start up, and a request that was mid-way carries on", async () => {
    const ch = (await api("POST", "/api/channels", { name: "legacy-run", settings: { team: legacy() } })).data;
    await say(ch);
    const plan = openIn("atlas", ch.id)!;
    // put the team back the way old data looked, and the request back as it was stored before lanes
    hub.store.db.prepare("UPDATE channels SET settings_json = ? WHERE id = ?").run(JSON.stringify({ ...ch.settings, team: legacy() }), ch.id);
    const row = hub.store.db.prepare("SELECT id, state_json FROM team_flows WHERE channel_id = ?").get(ch.id) as { id: string; state_json: string };
    const state = JSON.parse(row.state_json);
    delete state.lanes;
    hub.store.db.prepare("UPDATE team_flows SET state_json = ? WHERE id = ?").run(JSON.stringify(state), row.id);
    expect(hub.store.channel(ch.id)!.settings.team!.steps![0].inputs).toBeUndefined();
    expect(hub.store.migrateTeamSteps()).toBeGreaterThanOrEqual(1);
    const migrated = hub.store.channel(ch.id)!.settings.team!;
    expect(migrated.steps!.map((s) => s.inputs)).toEqual([[], ["plan"], ["check"]]);
    expect(migrated.roles).toHaveLength(2);
    expect(hub.store.migrateTeamSteps()).toBe(0);
    // the request goes on from where it was
    await finish("atlas", plan.id, "The plan");
    expect(openIn("sol", ch.id)!.brief).toMatch(/The plan/);
    await finish("sol", openIn("sol", ch.id)!.id, "ok", "approved");
    await finish("atlas", openIn("atlas", ch.id)!.id, "Shipped");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.history.map((h) => `${h.stepId}:${h.verdict}`)).toEqual(["plan:done", "check:approved", "ship:done"]);
  });

  it("a request the review had sent back keeps its review ahead of it after the upgrade", async () => {
    const ch = (await api("POST", "/api/channels", { name: "legacy-sent-back", settings: { team: legacy() } })).data;
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Plan v1");
    await finish("sol", openIn("sol", ch.id)!.id, "Needs more", "changes");
    const again = openIn("atlas", ch.id)!;
    // stored the old way: no lanes, and the history already holds plan, check
    const row = hub.store.db.prepare("SELECT id, state_json FROM team_flows WHERE channel_id = ?").get(ch.id) as { id: string; state_json: string };
    const state = JSON.parse(row.state_json);
    delete state.lanes;
    hub.store.db.prepare("UPDATE team_flows SET state_json = ? WHERE id = ?").run(JSON.stringify(state), row.id);
    expect((await flowIn(ch.id)).lanes!.check).toBeUndefined();
    await finish("atlas", again.id, "Plan v2");
    // the review runs again, with the plan, not the old notes
    const review = openIn("sol", ch.id)!;
    expect(review.brief).toMatch(/Plan v2/);
    expect(openIn("atlas", ch.id)).toBeUndefined();
  });

  it("keeps the plain chart for older apps, and takes a step with only `next` from an older app", async () => {
    const ch = (await api("POST", "/api/channels", { name: "old-client", settings: { team: legacy() } })).data;
    expect(ch.settings.team.nodes.map((n: any) => n.agentId).sort()).toEqual([agents.atlas.id, agents.sol.id].sort());
    expect(ch.settings.team.nodes.find((n: any) => n.lead).agentId).toBe(agents.atlas.id);
    // an app that only draws the chart leaves the steps alone
    const saved = await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { nodes: ch.settings.team.nodes, edges: ch.settings.team.edges } } });
    expect(saved.data.settings.team.steps).toHaveLength(3);
  });
});

describe("saving a flow chart", () => {
  it("says what's wrong in plain words", async () => {
    const bad = async (steps: Partial<TeamStep>[]) => (await api("POST", "/api/channels", { name: `bad-${Math.random().toString(36).slice(2, 8)}`, settings: { team: team(steps) } })).data.error as string;
    expect(await bad([step("a", "atlas", { inputs: ["b"] }), step("b", "sol", { inputs: ["a"] })])).toMatch(/circle/);
    expect(await bad([step("a", null)])).toMatch(/Pick an agent/);
    expect(await bad([step("a", "atlas"), step("r", "sol", { kind: "review", inputs: ["a"] })])).toMatch(/sends work back/);
    expect(await bad([step("a", "atlas"), step("h", null, { kind: "handoff", inputs: ["a"], handoffTo: "nope" })])).toMatch(/team that isn't here/);
    expect(await bad([step("a", "atlas", { inputs: ["zzz"] })])).toMatch(/isn't there/);
    expect(await bad([step("a", "atlas"), step("c", "sol", { kind: "branch", inputs: ["a"], ifTrue: "a" })])).toMatch(/checks for/);
  });

  it("refuses an agent from another workspace", async () => {
    const r = await api("POST", "/api/channels", { name: "alien", settings: { team: team([{ ...step("a", null), agentId: "agent_nobody" }]) } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/agent not found/);
  });

  it("a prompt change doesn't stop a running request, but a step that means something else does", async () => {
    const ch = await channel("edit-running", [step("a", "atlas", { action: "Draft", prompt: "v1" })]);
    await say(ch);
    const task = openIn("atlas", ch.id)!;
    const steps = ch.settings.team.steps;
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { ...ch.settings.team, steps: steps.map((s: any) => ({ ...s, prompt: "v2", x: 99 })) } } })).status).toBe(200);
    expect((await flowIn(ch.id)).status).toBe("running");
    expect((await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: { ...ch.settings.team, steps: steps.map((s: any) => ({ ...s, action: "Write" })) } } })).status).toBe(200);
    expect((await flowIn(ch.id)).status).toBe("failed");
    expect(hub.store.task(task.id)?.status).toBe("failed");
  });

  it("removing an agent leaves its steps empty instead of removing them", async () => {
    const temp = (await api("POST", "/api/agents", { handle: "tempo", name: "Tempo", harness: "custom" })).data;
    const ch = await channel("agent-leaves", [step("a", "atlas"), { ...step("b", null), agentId: temp.id, inputs: ["a"] }]);
    await api("DELETE", `/api/agents/${temp.id}`);
    const t = hub.store.channel(ch.id)!.settings.team!;
    expect(t.steps).toHaveLength(2);
    expect(t.steps!.find((s) => s.id === "b")?.agentId).toBeNull();
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "x");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(flow.waitingFor?.why).toMatch(/has nobody to do it/);
  });
});

describe("an agent drawing a team from a sentence", () => {
  it("is a task for an agent; the draft is previewed from its answer and nothing is created", async () => {
    const teamsNow = () => hub.store.channels(agents.atlas.workspaceId).filter((c) => c.kind === "channel").length;
    const before = teamsNow();
    const started = await api<TeamDraft>("POST", "/api/team-drafts", { description: "Atlas plans while Sol researches, Forge builds from both, then I approve", agentId: agents.atlas.id });
    expect(started.status).toBe(200);
    expect(started.data.status).toBe("working");
    const task = hub.store.task(started.data.id)!;
    expect(task.toAgentId).toBe(agents.atlas.id);
    expect(task.brief).toMatch(/@forge/);
    expect(task.brief).toMatch(/Atlas plans while Sol researches/);
    await finish("atlas", task.id, JSON.stringify({
      name: "Release crew",
      steps: [
        { id: "s1", title: "Plan the work", agent: "@atlas", prompt: "Plan it." },
        { id: "s2", title: "Research the options", agent: "sol", prompt: "Compare." },
        { id: "s3", title: "Build it", agent: "forge", inputs: ["s1", "s2"], prompt: "Build." },
        { id: "s4", title: "Approve before it ships", kind: "ask", inputs: ["s3"], sendBackTo: "s3", show: "The build." },
      ],
    }));
    const draft = (await api<TeamDraft>("GET", `/api/team-drafts/${started.data.id}`)).data;
    expect(draft.status).toBe("ready");
    expect(draft.name).toBe("Release crew");
    expect(draft.problem).toBeUndefined();
    expect(draft.steps!.map((s) => [s.id, s.kind, s.agentId ? hub.store.agent(s.agentId)?.handle : null])).toEqual([
      ["s1", "do", "atlas"],
      ["s2", "do", "sol"],
      ["s3", "do", "forge"],
      ["s4", "ask", null],
    ]);
    expect(draft.steps![2].inputs).toEqual(["s1", "s2"]);
    expect(draft.lines!.map((l) => l.text)).toEqual([
      "Atlas plans the work.",
      "At the same time, Sol researches the options.",
      "Forge uses the results of steps 1 and 2 to build it.",
      "You approve before it ships. If you ask for changes it goes back to step 3.",
    ]);
    expect(teamsNow()).toBe(before);
  });

  it("fails clearly when the answer isn't a flowchart, or the agent can't do it, and points out a problem in a draft", async () => {
    const a = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Do something clever", agentId: agents.sol.id })).data;
    await finish("sol", a.id, "Sure, I think you should hire more people.");
    expect((await api<TeamDraft>("GET", `/api/team-drafts/${a.id}`)).data).toMatchObject({ status: "failed", problem: expect.stringMatching(/couldn't read|could not read|wasn't a flowchart/) });
    const b = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Another one", agentId: agents.sol.id })).data;
    await api("PATCH", `/api/tasks/${b.id}`, { status: "failed", result: "Out of credit" }, tokens.sol);
    expect((await api<TeamDraft>("GET", `/api/team-drafts/${b.id}`)).data).toMatchObject({ status: "failed", problem: "Out of credit" });
    const c = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "A loop with no end", agentId: agents.sol.id })).data;
    await finish("sol", c.id, `{"steps":[{"id":"a","title":"One","inputs":["b"]},{"id":"b","title":"Two","inputs":["a"]}]}`);
    const draft = (await api<TeamDraft>("GET", `/api/team-drafts/${c.id}`)).data;
    expect(draft.status).toBe("ready");
    expect(draft.problem).toMatch(/circle/);
  });

  it("is for people, not for other workspaces' tasks", async () => {
    expect((await api("POST", "/api/team-drafts", { description: "x" })).status).toBe(400);
    expect((await api("POST", "/api/team-drafts", { description: "A team", agentId: agents.atlas.id }, tokens.atlas)).status).toBe(403);
    expect((await api("GET", "/api/team-drafts/task_nope")).status).toBe(404);
  });
});

describe("an agent setting up a flow chart in words", () => {
  it("takes inputs for steps that run together and an ask-me step", async () => {
    const ch = (await api("POST", "/api/channels", { name: "described-graph" })).data;
    const r = await api("PUT", `/api/channels/${ch.id}/team-steps`, {
      roles: [
        { name: "Planner", description: "Plans.", agent: "atlas" },
        { name: "Researcher", description: "Researches.", agent: "sol" },
        { name: "Builder", description: "Builds.", agent: "forge" },
      ],
      steps: [
        { role: "Planner", action: "Plan" },
        { role: "Researcher", action: "Research", inputs: [] },
        { role: "Builder", action: "Build", inputs: [1, 2] },
        { kind: "ask", action: "Approve it", inputs: [3], send_back_to: 3 },
      ],
    }, tokens.atlas);
    expect(r.status).toBe(200);
    const steps = r.data.settings.team.steps;
    expect(steps.find((s: any) => s.id === "step-3").inputs).toEqual(["step-1", "step-2"]);
    expect(steps.find((s: any) => s.id === "step-4")).toMatchObject({ kind: "ask", inputs: ["step-3"], sendBackTo: "step-3" });
    await say(r.data);
    expect(openIn("atlas", ch.id)).toBeDefined();
    expect(openIn("sol", ch.id)).toBeDefined();
  });
});

describe("branches, loops and hand-offs in odd shapes", () => {
  it("an if/else keeps a step the chosen path still leads to, instead of skipping it", async () => {
    const ch = await channel("branch-rejoin", [
      step("a", "atlas"),
      step("gate", null, { kind: "branch", inputs: ["a"], rule: { op: "contains", value: "PASS" }, ifTrue: "build", ifFalse: "report" }),
      step("build", "forge"),
      step("report", "sol", { inputs: ["build"] }),
    ]);
    await say(ch);
    await finish("atlas", openIn("atlas", ch.id)!.id, "PASS");
    let flow = await flowIn(ch.id);
    expect(flow.lanes!.report).toBeUndefined();
    await finish("forge", openIn("forge", ch.id)!.id, "Built");
    expect(openIn("sol", ch.id)!.brief).toMatch(/Built/);
    await finish("sol", openIn("sol", ch.id)!.id, "Reported");
    flow = await flowIn(ch.id);
    expect(flow.status).toBe("done");
    expect(flow.lanes!.report.status).toBe("done");
  });

  it("an if/else going back round doesn't start a step that joins the path it just left", async () => {
    const ch = await channel("loop-join", [
      step("a", "atlas"),
      step("f", "pixel"),
      step("gate", null, { kind: "branch", inputs: ["a"], rule: { op: "contains", value: "PASS" }, ifTrue: "c", ifFalse: "a" }),
      step("c", "forge"),
      step("e", "sol", { inputs: ["c", "f"] }),
    ]);
    await say(ch);
    await finish("pixel", openIn("pixel", ch.id)!.id, "F done");
    await finish("atlas", openIn("atlas", ch.id)!.id, "FAIL");
    expect(tasksIn("sol", ch.id)).toHaveLength(0);
    expect(openIn("atlas", ch.id)).toBeDefined();
  });

  it("a step that only lists an if/else as its input isn't skipped forever", async () => {
    const ch = await channel("branch-plain-arrow", [
      step("a", "atlas"),
      step("gate", null, { kind: "branch", inputs: ["a"], rule: { op: "contains", value: "PASS" }, ifTrue: "c", ifFalse: null }),
      step("c", "forge"),
      step("d", "sol", { inputs: ["gate"] }),
    ]);
    expect(ch.settings.team.steps.find((s: any) => s.id === "d").inputs).toEqual([]);
    await say(ch);
    expect(openIn("sol", ch.id)).toBeDefined();
    expect((await flowIn(ch.id)).lanes!.d.status).toBe("running");
  });

  it("approving a loop that ran out of rounds leaves it, instead of asking the same question again", async () => {
    const ch = await channel("loop-approve", [
      step("build", "forge"),
      step("gate", null, { kind: "branch", inputs: ["build"], rule: { op: "contains", value: "PASS" }, ifTrue: "ship", ifFalse: "build", maxRounds: 1 }),
      step("ship", "atlas"),
    ]);
    await say(ch);
    await finish("forge", openIn("forge", ch.id)!.id, "FAIL");
    let flow = await flowIn(ch.id);
    expect(flow.waitingFor?.options).toBe("rounds");
    flow = (await decide(flow.id, "approve")).data;
    expect(flow.waitingFor ?? null).toBeNull();
    expect(openIn("atlas", ch.id)!.brief).toMatch(/FAIL/);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Shipped");
    expect((await flowIn(ch.id)).status).toBe("done");
  });

  it("goes on when the team it handed work to finished before the hand-off was saved", async () => {
    // an if/else that says no with nothing after it: this team's request ends as soon as it starts
    const quick = await channel("instant", [step("gate", null, { kind: "branch", rule: { op: "contains", value: "zzz-never" }, ifTrue: "w", ifFalse: null }), step("w", "pixel")]);
    const ch = await channel("hand-off-instant", [step("tell", null, { kind: "handoff", handoffTo: quick.id, waitForReply: true }), step("after", "atlas", { inputs: ["tell"] })]);
    await say(ch);
    expect((await flowIn(quick.id)).status).toBe("done");
    const flow = await flowIn(ch.id);
    expect(flow.lanes!.tell.status).toBe("done");
    expect(openIn("atlas", ch.id)).toBeDefined();
  });
});

describe("what people can reach", () => {
  let alice: string;
  let bob: string;
  let guest: string;
  let privateTeam: { id: string };

  beforeAll(async () => {
    for (const [name, role] of [["alice", "member"], ["bob", "member"], ["gus", "guest"]] as const)
      await api("POST", "/api/members", { email: `${name}@example.com`, name, password: "password123", role });
    const login = async (name: string) => (await api("POST", "/api/auth/login", { email: `${name}@example.com`, password: "password123" }, "")).data.token;
    [alice, bob, guest] = await Promise.all([login("alice"), login("bob"), login("gus")]);
    privateTeam = (await api("POST", "/api/channels", { name: "alice-only", private: true, settings: { team: team([step("p", "pixel")]) } }, alice)).data;
  });

  it("a private team can't be handed work by someone who can't see it, when saving or when running", async () => {
    const mk = (name: string, token: string) => api("POST", "/api/channels", { name, settings: { team: team([step("a", "atlas"), step("tell", null, { kind: "handoff", inputs: ["a"], handoffTo: privateTeam.id, waitForReply: true })]) } }, token);
    expect((await mk("bob-hands-over", bob)).status).toBe(400);
    expect((await mk("alice-hands-over", alice)).status).toBe(200);
    // an owner sees everything, so they may save one; but a request from someone who can't see the team doesn't reach it
    const ch = (await mk("owner-hands-over", owner)).data;
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "Please do it" }, bob);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Done");
    const flow = await flowIn(ch.id);
    expect(flow.status).toBe("waiting");
    expect(await flowsOf(privateTeam.id)).toHaveLength(0);
    await api("POST", `/api/channels/${ch.id}/messages`, { body: "And me too" }, alice);
    await finish("atlas", openIn("atlas", ch.id)!.id, "Done");
    expect((await flowsOf(privateTeam.id)).length).toBe(1);
  });

  it("someone who can't see a team a step already hands to can still edit the rest of the chart", async () => {
    const steps = (prompt: string) => [step("a", "atlas", { prompt }), step("tell", null, { kind: "handoff", inputs: ["a"], handoffTo: privateTeam.id, waitForReply: true })];
    const ch = (await api("POST", "/api/channels", { name: "keeps-handoff", settings: { team: team(steps("one")) } }, alice)).data;
    const edit = await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: team(steps("two")) } }, bob);
    expect(edit.status).toBe(200);
    // pointing a different step at the private team is still refused
    const other = await api("PATCH", `/api/channels/${ch.id}`, { settings: { team: team([...steps("two"), step("t2", null, { kind: "handoff", inputs: ["tell"], handoffTo: privateTeam.id })]) } }, bob);
    expect(other.status).toBe(400);
  });

  it("refuses a draft by an agent that won't answer the person, instead of waiting for it forever", async () => {
    const quiet = (await api("POST", "/api/agents", { handle: "quiet", name: "Quiet", harness: "custom" })).data;
    await api("PATCH", `/api/agents/${quiet.id}`, { settings: { respondTo: "me" } });
    const r = await api("POST", "/api/team-drafts", { description: "Do a thing", agentId: quiet.id }, alice);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/only answers some people/);
  });

  it("a draft is only for people who can see the chat it was asked in, and the brief leaves out private teams", async () => {
    await api("PATCH", `/api/agents/${agents.pixel.id}`, { settings: { respondTo: "anyone" } });
    const started = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Pixel does a thing", agentId: agents.pixel.id }, alice)).data;
    expect(hub.store.task(started.id)!.brief).toMatch(/alice-only/);
    await finish("pixel", started.id, JSON.stringify({ name: "Thing", steps: [{ id: "s1", title: "Do it", agent: "pixel" }, { id: "s2", kind: "handoff", title: "Tell", team: "alice-only", inputs: ["s1"] }] }));
    expect((await api("GET", `/api/team-drafts/${started.id}`, undefined, bob)).status).toBe(404);
    expect((await api("GET", `/api/team-drafts/${started.id}`, undefined, guest)).status).toBe(403);
    const mine = await api<TeamDraft>("GET", `/api/team-drafts/${started.id}`, undefined, alice);
    expect(mine.data.status).toBe("ready");
    expect(mine.data.steps![1].handoffTo).toBe(privateTeam.id);
    expect((await api<TeamDraft>("GET", `/api/team-drafts/${started.id}`)).data.status).toBe("ready");
    const bobs = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Something else", agentId: agents.pixel.id }, bob)).data;
    expect(hub.store.task(bobs.id)!.brief).not.toMatch(/alice-only/);
    // a draft that names a team he can't see leaves it empty
    await finish("pixel", bobs.id, JSON.stringify({ steps: [{ id: "s1", kind: "handoff", title: "Tell", team: "alice-only" }] }));
    expect((await api<TeamDraft>("GET", `/api/team-drafts/${bobs.id}`, undefined, bob)).data.steps![0].handoffTo).toBeNull();
  });

  it("a draft that isn't well formed fails instead of breaking every poll", async () => {
    for (const answer of [`{"steps":{}}`, `{"steps":[{"id":"a","title":"One"},{"id":"a","title":"Two"}]}`, `{"steps":[{"id":"a","inputs":"b"},null,7]}`, `{"steps":"nope"}`]) {
      const d = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Something odd", agentId: agents.sol.id })).data;
      await finish("sol", d.id, answer);
      const got = await api<TeamDraft>("GET", `/api/team-drafts/${d.id}`);
      expect(got.status, answer).toBe(200);
      expect(["failed", "ready"], answer).toContain(got.data.status);
    }
    const dup = (await api<TeamDraft>("POST", "/api/team-drafts", { description: "Same ids", agentId: agents.sol.id })).data;
    await finish("sol", dup.id, `{"steps":[{"id":"a","title":"One"},{"id":"a","title":"Two"}]}`);
    expect((await api<TeamDraft>("GET", `/api/team-drafts/${dup.id}`)).data.status).toBe("failed");
  });
});
