import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { teamProblem, type ChannelTeam } from "@warren/core";
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

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const node = (agentId: string, lead = false) => ({ agentId, lead, x: 0, y: 0 });
const runsFor = (messageId: string) => hub.store.db.prepare("SELECT agent_id AS agentId, thread_id AS threadId, discussion_id AS discussionId FROM runs WHERE trigger_message_id = ? ORDER BY created_at").all(messageId) as { agentId: string; threadId: string | null; discussionId: string | null }[];
const post = async (channelId: string, body: string, threadId?: string) => (await api("POST", `/api/channels/${channelId}/messages`, { body, ...(threadId ? { threadId } : {}) })).data;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-channel-teams-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yug", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  ada = (await api("POST", "/api/agents", { handle: "ada", name: "Ada", harness: "custom" })).data;
  bo = (await api("POST", "/api/agents", { handle: "bo", name: "Bo", harness: "custom" })).data;
  cy = (await api("POST", "/api/agents", { handle: "cy", name: "Cy", harness: "custom" })).data;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("team charts", () => {
  it("say what's wrong with a chart in plain words", () => {
    const t = (nodes: ChannelTeam["nodes"], edges: ChannelTeam["edges"] = []) => teamProblem({ nodes, edges });
    expect(t([])).toMatch(/at least one agent/);
    expect(t([node("a")])).toMatch(/a lead/);
    expect(t([node("a", true), node("b")])).toMatch(/Connect every agent/);
    expect(t([node("a", true), node("b")], [{ from: "a", to: "b" }])).toBeNull();
    expect(t([node("a", true), node("b", true)], [{ from: "a", to: "b" }])).toMatch(/can't point at a lead/);
    expect(t([node("a", true), node("b"), node("c")], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "b" }])).toMatch(/loop/);
    expect(t([node("a", true)], [{ from: "a", to: "a" }])).toMatch(/itself/);
  });

  it("are checked when a channel is created, and everyone on one joins the channel", async () => {
    const bad = await api("POST", "/api/channels", { name: "nolead", settings: { team: { nodes: [node(ada.id)], edges: [] } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/lead/);
    const ch = (await api("POST", "/api/channels", { name: "build", topic: "Ship the app", settings: { team: { nodes: [node(ada.id, true), node(bo.id)], edges: [{ from: ada.id, to: bo.id }] } } })).data;
    expect(ch.settings.team.nodes).toHaveLength(2);
    const members = (await api<any[]>("GET", `/api/channels/${ch.id}/members`)).data.filter((m) => m.kind === "agent").map((m) => m.handle);
    expect(members.sort()).toEqual(["ada", "bo"]);
  });
});

describe("a channel with one lead", () => {
  it("sends a new message only to the lead, which answers in a thread", async () => {
    const ch = (await api("POST", "/api/channels", { name: "solo-lead", settings: { team: { nodes: [node(ada.id, true), node(bo.id)], edges: [{ from: ada.id, to: bo.id }] } } })).data;
    const msg = await post(ch.id, "make me a landing page");
    expect(runsFor(msg.id)).toEqual([{ agentId: ada.id, threadId: msg.id, discussionId: null }]);
    // an @mention still reaches whoever it names
    const direct = await post(ch.id, "@bo what's the font?");
    expect(runsFor(direct.id).map((r) => r.agentId)).toEqual([bo.id]);
  });

  it("tells each agent who's on the team and what that means for it", async () => {
    const ch = hub.store.channelByName(hub.store.agent(ada.id)!.workspaceId, "solo-lead")!;
    const lead = hub.teamSection(ch, ada.id);
    expect(lead).toMatch(/You lead #solo-lead/);
    expect(lead).toMatch(/task_delegate/);
    expect(lead).toMatch(/@bo \(Bo\)/);
    const member = hub.teamSection(ch, bo.id);
    expect(member).toMatch(/You get work in #solo-lead from @ada/);
    expect(member).toMatch(/@ada \(Bo|@ada \(Ada\), lead/);
    expect(hub.teamSection(ch, cy.id)).toBe("");
  });
});

describe("a channel with several leads", () => {
  it("has the leads plan together in the thread before anyone starts", async () => {
    const ch = (await api("POST", "/api/channels", { name: "co-leads", settings: { team: { nodes: [node(ada.id, true), node(bo.id, true), node(cy.id)], edges: [{ from: ada.id, to: cy.id }, { from: bo.id, to: cy.id }] } } })).data;
    const available = hub.agentAvailable;
    hub.agentAvailable = () => true;
    try {
      const msg = await post(ch.id, "plan the launch");
      const runs = runsFor(msg.id);
      expect(runs.map((r) => r.agentId).sort()).toEqual([ada.id, bo.id].sort());
      expect(runs.every((r) => r.threadId === msg.id && r.discussionId)).toBe(true);
      const d = hub.store.discussion(runs[0].discussionId!)!;
      expect(d).toMatchObject({ kind: "plan", threadId: msg.id, moderatorId: ada.id });
      const prompt = await hub.buildPrompt(ada.id, ch.id, msg.id, msg.id, { id: "x", discussionId: d.id, phase: "round:1" });
      expect(prompt).toMatch(/Plan this with the other leads first/);
      expect(prompt).toMatch(/Your team in #co-leads/);
    } finally {
      hub.agentAvailable = available;
    }
  });

  it("lets one lead plan alone when the others are away", async () => {
    const ch = hub.store.channelByName(hub.store.agent(ada.id)!.workspaceId, "co-leads")!;
    const msg = await post(ch.id, "and the docs?");
    expect(runsFor(msg.id)).toEqual([{ agentId: ada.id, threadId: msg.id, discussionId: null }]);
  });
});

describe("sub-threads", () => {
  it("lets a reply in a thread start a thread of its own, with the parent's talk in the prompt", async () => {
    const ch = (await api("POST", "/api/channels", { name: "nested", settings: { team: { nodes: [node(ada.id, true)], edges: [] } } })).data;
    const root = await post(ch.id, "build the login page");
    const reply = await post(ch.id, "use passkeys", root.id);
    expect(reply.threadId).toBe(root.id);
    const sub = await post(ch.id, "@ada which library?", reply.id);
    expect(sub.threadId).toBe(reply.id);
    expect(hub.threadPath(reply.id)).toEqual([root.id]);
    const counts = (await api("GET", `/api/channels/${ch.id}/messages?thread=${root.id}`)).data.replyCounts;
    // the reply, and the "isn't connected yet" notice
    expect(counts[reply.id]).toBeGreaterThan(0);
    const prompt = await hub.buildPrompt(ada.id, ch.id, reply.id, sub.id);
    expect(prompt).toMatch(/This is a sub-thread/);
    expect(prompt).toMatch(/build the login page/);
  });

  it("puts a lead's hand-off in a sub-thread of the thread it's working in", async () => {
    const ch = (await api("POST", "/api/channels", { name: "handoff", settings: { team: { nodes: [node(ada.id, true), node(bo.id)], edges: [{ from: ada.id, to: bo.id }] } } })).data;
    const msg = await post(ch.id, "write the release notes");
    // the lead is working on it
    const run = hub.store.db.prepare("SELECT id FROM runs WHERE trigger_message_id = ?").get(msg.id) as { id: string };
    hub.store.setRunStatus(run.id, "running");
    const token = (await api("POST", `/api/agents/${ada.id}/token`)).data.token;
    const task = (await api("POST", "/api/tasks", { to: "@bo", title: "Draft notes", brief: "From the changelog" }, token)).data;
    const handoff = hub.store.message(task.threadId)!;
    expect(handoff.channelId).toBe(ch.id);
    expect(handoff.threadId).toBe(msg.id);
    // bo works in the hand-off's own thread
    expect(runsFor(handoff.id)).toEqual([{ agentId: bo.id, threadId: handoff.id, discussionId: null }]);
    // and reports back in the thread it came from
    const boToken = (await api("POST", `/api/agents/${bo.id}/token`)).data.token;
    await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "Drafted" }, boToken);
    const back = hub.store.messages(ch.id, { threadId: msg.id, limit: 50 }).find((m) => m.body.includes("is done"));
    expect(back?.body).toMatch(/@ada Task \*\*Draft notes\*\* is done/);
    expect(back?.parts).toEqual([{ type: "task", taskId: task.id }]);
  });
});

describe("agents making agents", () => {
  const tokenOf = async (id: string) => (await api("POST", `/api/agents/${id}/token`)).data.token as string;
  const working = (agentId: string, channelId: string, threadId: string | null = null) => {
    const runId = hub.store.createRun({ agentId, channelId, threadId, triggerMessageId: threadId ?? "x", hop: 0, requestedBy: null });
    hub.store.setRunStatus(runId, "running");
    return () => hub.store.setRunStatus(runId, "done");
  };

  it("is off until an owner turns it on, and then only for leads", async () => {
    const ch = (await api("POST", "/api/channels", { name: "spawning", settings: { team: { nodes: [node(ada.id, true), node(bo.id)], edges: [{ from: ada.id, to: bo.id }] } } })).data;
    const adaToken = await tokenOf(ada.id);
    const off = await api("POST", "/api/agents/spawn", { name: "Scout", role: "Researcher" }, adaToken);
    expect(off.status).toBe(403);
    expect(off.data.error).toMatch(/switched off/);

    expect((await api("PUT", "/api/settings/agents", { leadsCreateAgents: true })).data).toMatchObject({ leadsCreateAgents: true, subAgents: false });
    const notLead = await api("POST", "/api/agents/spawn", { name: "Helper" }, await tokenOf(cy.id));
    expect(notLead.status).toBe(403);
    expect(notLead.data.error).toMatch(/only leads/);

    const msg = await post(ch.id, "research the competition");
    const done = working(ada.id, ch.id, msg.id);
    const made = await api("POST", "/api/agents/spawn", { name: "Scout", role: "Researcher", instructions: "Find sources." }, adaToken);
    done();
    expect(made.status).toBe(200);
    expect(made.data).toMatchObject({ handle: "scout", name: "Scout", instructions: "Find sources.", settings: { parentAgentId: ada.id, madeDepth: 1, role: "Researcher" } });
    // it joins the chart under its maker, and the thread says so
    const team = hub.store.channel(ch.id)!.settings.team!;
    expect(team.nodes.some((n) => n.agentId === made.data.id && !n.lead)).toBe(true);
    expect(team.edges).toContainEqual({ from: ada.id, to: made.data.id });
    expect(hub.store.messages(ch.id, { threadId: msg.id }).some((m) => m.parts.some((p) => p.type === "notice" && /@ada made a new agent: @scout \(Researcher\)/.test(p.text)))).toBe(true);
    // and the lead's prompt mentions it can do this
    expect(await hub.buildPrompt(ada.id, ch.id, msg.id, msg.id)).toMatch(/## Making agents/);
  });

  it("lets an agent a lead made make sub-agents only when that's on too, and stops at the limits", async () => {
    const scout = hub.store.agentByHandle(hub.store.agent(ada.id)!.workspaceId, "scout")!;
    const scoutToken = await tokenOf(scout.id);
    const off = await api("POST", "/api/agents/spawn", { name: "Digger" }, scoutToken);
    expect(off.status).toBe(403);
    expect(off.data.error).toMatch(/sub-agents is switched off/);

    await api("PUT", "/api/settings/agents", { subAgents: true });
    const sub = await api("POST", "/api/agents/spawn", { name: "Digger" }, scoutToken);
    expect(sub.status).toBe(200);
    expect(sub.data.settings).toMatchObject({ parentAgentId: scout.id, madeDepth: 2 });

    // three levels down at most
    const third = await api("POST", "/api/agents/spawn", { name: "Third" }, await tokenOf(sub.data.id));
    expect(third.status).toBe(200);
    const fourth = await api("POST", "/api/agents/spawn", { name: "Fourth" }, await tokenOf(third.data.id));
    expect(fourth.status).toBe(403);
    expect(fourth.data.error).toMatch(/3 levels/);

    // and no more than the organization's cap
    await api("PUT", "/api/settings/agents", { maxAgentMade: 3 });
    const capped = await api("POST", "/api/agents/spawn", { name: "Extra" }, await tokenOf(ada.id));
    expect(capped.status).toBe(403);
    expect(capped.data.error).toMatch(/limit/);
    await api("PUT", "/api/settings/agents", { leadsCreateAgents: false, subAgents: false, maxAgentMade: 10 });
  });
});
