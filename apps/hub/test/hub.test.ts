import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { MAX_MODEL_ID_LENGTH, type HubToNode, type Message, type NodeToHub } from "@warren/core";
import Database from "better-sqlite3";
import { fileName, limitParam } from "../src/api.ts";
import { buildHub } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Hub } from "../src/hub.ts";
import { Store } from "../src/store.ts";
import { workspaceLead } from "../src/lead.ts";
import { foldTeams } from "../src/fold-teams.ts";
import { teamProblem } from "@warren/core";

let dir: string;
let base: string;
let close: () => Promise<void>;
let hub: Hub;
let token: string;

async function api<T = any>(method: string, url: string, body?: unknown, auth = token, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

/** A browser's socket: collects every event the hub sends it. */
async function clientSocket(sessionToken: string): Promise<{ events: any[]; close: () => void }> {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ token: sessionToken })));
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === "ready") resolve();
      else events.push(e);
    });
    ws.on("error", reject);
  });
  return { events, close: () => ws.close() };
}

/** A scripted fake node: answers every run with `reply(prompt)`; a reply starting with "FAIL:" fails the run with the rest as the error, and "HOLD:" leaves the run open (`held`) for the test to finish. */
class FakeNode {
  ws!: WebSocket;
  runs: HubToNode[] = [];
  held: string[] = [];
  constructor(
    readonly token: string,
    readonly reply: (prompt: string, agentId: string) => string,
  ) {}
  async connect() {
    this.ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${this.token}` } });
    await new Promise<void>((resolve, reject) => {
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as HubToNode;
        if (msg.type === "welcome") {
          this.send({ type: "hello", nodeName: "test-node", agents: [] });
          resolve();
        }
        if (msg.type === "merge") {
          this.runs.push(msg);
          this.send({ type: "git_done", requestId: msg.requestId, ok: !msg.branch.includes("conflict"), output: msg.branch.includes("conflict") ? "doesn't merge cleanly" : `Merged ${msg.branch} into ${msg.base}.` });
        }
        if (msg.type === "run") {
          this.runs.push(msg);
          const text = this.reply(msg.run.prompt, msg.run.agentId);
          if (text.startsWith("HOLD:")) {
            this.held.push(msg.run.runId);
            return;
          }
          if (text.startsWith("FAIL:")) {
            this.send({ type: "run_failed", runId: msg.run.runId, error: text.slice(5) });
            return;
          }
          this.send({ type: "run_event", runId: msg.run.runId, event: { type: "tool_call", name: "memory_search", input: { q: "x" } } });
          this.send({ type: "run_event", runId: msg.run.runId, event: { type: "usage", model: "fake-1", effort: "medium", contextUsed: 4321, contextWindow: 200000 } });
          this.send({ type: "run_done", runId: msg.run.runId, finalText: text });
        }
      });
      this.ws.on("error", reject);
    });
  }
  send(m: NodeToHub) {
    this.ws.send(JSON.stringify(m));
  }
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

let general: string;
let atlas: any;
let nova: any;
let nodeToken: string;
let node: FakeNode;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-hub-"));
  const built = await buildHub({ dataDir: dir });
  const { app } = built;
  hub = built.hub;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  close = () => app.close();

  const setup = await api("POST", "/api/setup", { email: "me@example.com", name: "Yug", password: "password123", features: "everything", workspaceName: "Test" }, "");
  token = setup.data.token;
  general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general").id;

  const n = await api("POST", "/api/nodes", { name: "box" });
  nodeToken = n.data.token;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "claude-code", nodeId: n.data.node.id, settings: { respondTo: "anyone" } })).data;
  nova = (await api("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "codex", nodeId: n.data.node.id })).data;

  node = new FakeNode(nodeToken, (prompt, agentId) => {
    const last = prompt.split("\n").pop()!;
    if (last.includes("hold on")) return "HOLD:";
    if (agentId === atlas.id && last.includes("ask nova")) return "@nova can you check the build?";
    if (agentId === atlas.id && last.includes("loop")) return "@nova loop";
    if (agentId === nova.id && last.includes("loop")) return "@atlas loop";
    if (agentId === atlas.id && last.includes("expired token")) return "FAIL:Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";
    if (agentId === nova.id && prompt.includes("please crash")) return "FAIL:harness crashed";
    return `${agentId === atlas.id ? "atlas" : "nova"} heard: ${last}`;
  });
  await node.connect();
});

afterAll(async () => {
  node?.ws.close();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A channel with a team, as the API lists it: the lead leads, everyone else gets work from its manager (else the lead). */
async function makeTeam(t: { name: string; leadId: string; members?: { agentId: string; role?: string; roleNotes?: string; managerId?: string }[]; folder?: string; repo?: string; baseBranch?: string; reportsTo?: string; topic?: string }) {
  const members = t.members ?? [];
  const nodes = [{ agentId: t.leadId, lead: true, x: 24, y: 24 }, ...members.map((m, i) => ({ agentId: m.agentId, lead: false, x: 24 + i * 212, y: 156, role: m.role, roleNotes: m.roleNotes }))];
  const edges = members.map((m) => ({ from: m.managerId ?? t.leadId, to: m.agentId }));
  const r = await api<any>("POST", "/api/channels", { name: t.name, topic: t.topic ?? "", settings: { team: { nodes, edges, folder: t.folder, repo: t.repo, baseBranch: t.baseBranch, reportsTo: t.reportsTo } } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return (await api<any[]>("GET", "/api/teams")).data.find((x) => x.channelId === r.data.id);
}

const channelMessagesIn = async (channel: string, thread?: string) => (await api<{ messages: Message[] }>("GET", `/api/channels/${channel}/messages${thread ? `?thread=${thread}` : ""}`)).data.messages;
const channelMessages = async (thread?: string) => (await api<{ messages: Message[] }>("GET", `/api/channels/${general}/messages${thread ? `?thread=${thread}` : ""}`)).data.messages;

describe("hub", () => {
  it("reports onboarding progress from real state", async () => {
    const o = (await api("GET", "/api/onboarding")).data;
    expect(o.devices).toEqual([{ id: expect.any(String), name: "test-node", online: true, mine: true, role: null }]);
    expect(o.agents.map((a: any) => a.handle)).toEqual(["atlas", "nova"]);
    expect(o.computers).toEqual([]);
    expect(o.firstReply).toBeNull();
    expect(o.memoryNotes).toEqual([]);
    expect((await api("GET", "/api/onboarding", undefined, nodeToken, { "x-warren-agent": atlas.id })).status).toBe(403);
  });

  it("setup only works once and requires auth", async () => {
    expect((await api("POST", "/api/setup", { email: "x@example.com", name: "X", password: "password123", features: "everything" }, "")).status).toBe(409);
    expect((await api("GET", "/api/channels", undefined, "")).status).toBe(401);
    expect((await api("POST", "/api/auth/login", { email: "me@example.com", password: "password123" }, "")).status).toBe(200);
  });

  it("routes a mention to the agent and posts its reply with tool calls", async () => {
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas hello there" });
    const reply = await waitFor(async () => (await channelMessages()).find((m) => m.author.id === atlas.id));
    expect(reply.body).toBe("atlas heard: @atlas hello there");
    expect(reply.parts[0]).toMatchObject({ type: "tool_call", name: "memory_search" });
    expect(reply.hop).toBe(1);
    const run = node.runs.at(-1)!;
    expect(run.type === "run" && run.run.prompt).toContain("You are @atlas");
    expect((await api("GET", "/api/onboarding")).data.firstReply.agentId).toBe(atlas.id);
  });

  it("lets agents wake each other up", async () => {
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas please ask nova" });
    const fromNova = await waitFor(async () => (await channelMessages()).find((m) => m.author.id === nova.id));
    expect(fromNova.body).toBe("nova heard: @nova can you check the build?");
    expect(fromNova.hop).toBe(2);
  });

  it("stops agent ping-pong with the loop guard", async () => {
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas start a loop" });
    const stopped = await waitFor(async () => (await channelMessages()).find((m) => m.parts.some((p) => p.type === "status" && p.text.includes("hop limit"))));
    expect(stopped).toBeTruthy();
  });

  it("DMs route to the agent without a mention", async () => {
    const dm = (await api("POST", `/api/dm/${nova.id}`)).data;
    await api("POST", `/api/channels/${dm.id}/messages`, { body: "private question" });
    const reply = await waitFor(async () => (await api<{ messages: Message[] }>("GET", `/api/channels/${dm.id}/messages`)).data.messages.find((m) => m.author.id === nova.id));
    expect(reply.body).toBe("nova heard: private question");
  });

  it("enforces vault scopes for agents", async () => {
    const asAtlas = { "x-warren-agent": atlas.id };
    expect((await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/plan.md`, content: "# Plan\nsee [[Welcome]]" }, nodeToken, asAtlas)).status).toBe(200);
    expect((await api("PUT", "/api/vault/note", { path: `agents/${nova.id}/hack.md`, content: "x" }, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("GET", `/api/vault/note?path=agents/${nova.id}/SOUL.md`, undefined, nodeToken, asAtlas)).status).toBe(403);
    const visible = (await api<any[]>("GET", "/api/vault/notes", undefined, nodeToken, asAtlas)).data.map((n) => n.path);
    expect(visible).toContain("shared/Welcome.md");
    expect(visible).toContain(`agents/${atlas.id}/plan.md`);
    expect(visible).not.toContain(`agents/${nova.id}/SOUL.md`);

    // the owner can let atlas read nova's memory
    expect((await api("PUT", "/api/access", { path: `agents/${nova.id}`, subject: { kind: "agent", id: atlas.id }, level: "read" })).status).toBe(200);
    expect((await api("GET", `/api/vault/note?path=agents/${nova.id}/SOUL.md`, undefined, nodeToken, asAtlas)).status).toBe(200);

    // backlinks + history from the user's side
    const welcome = (await api("GET", "/api/vault/note?path=shared/Welcome.md")).data;
    expect(welcome.backlinks).toContain(`agents/${atlas.id}/plan.md`);
    const history = (await api<any[]>("GET", `/api/vault/history?path=agents/${atlas.id}/plan.md`)).data;
    expect(history[0].author).toBe("@atlas");
  });

  it("a node cannot act as an agent it doesn't host", async () => {
    const other = await api("POST", "/api/nodes", { name: "other" });
    expect((await api("GET", "/api/vault/notes", undefined, other.data.token, { "x-warren-agent": atlas.id })).status).toBe(401);
  });

  it("delegates tasks between agents and reports back", async () => {
    const asAtlas = { "x-warren-agent": atlas.id };
    const task = (await api("POST", "/api/tasks", { to: "nova", title: "Run tests", brief: "run the suite" }, nodeToken, asAtlas)).data;
    expect(task.status).toBe("open");
    await waitFor(async () => (await channelMessages(task.threadId)).find((m) => m.author.id === nova.id));
    const done = await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "all green" }, nodeToken, { "x-warren-agent": nova.id });
    expect(done.data.status).toBe("done");
    const report = await waitFor(async () => (await channelMessages(task.threadId)).find((m) => m.body.includes("all green")));
    expect(report.body).toContain("@atlas");
  });

  it("stores and serves files", async () => {
    const res = await fetch(base + "/api/files", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-filename": "notes.txt", "x-mime-type": "text/plain" }, body: "hello file" });
    const file = await res.json();
    const got = await fetch(base + `/api/files/${file.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await got.text()).toBe("hello file");
  });
});

describe("hub security", () => {
  it("rate-limits failed logins and hides member emails from agents", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await api("POST", "/api/auth/login", { email: "me@example.com", password: "nope-nope" }, "")).status;
    expect(last).toBe(429);
    expect((await api("GET", "/api/members", undefined, nodeToken, { "x-warren-agent": atlas.id })).status).toBe(403);
  });

  it("blocks vault path tricks", async () => {
    const asAtlas = { "x-warren-agent": atlas.id };
    expect((await api("PUT", "/api/vault/note", { path: `shared/../agents/${nova.id}/x.md`, content: "x" }, nodeToken, asAtlas)).status).toBe(400);
    expect((await api("PUT", "/api/vault/note", { path: ".obsidian/x.md", content: "x" }, nodeToken, asAtlas)).status).toBe(400);
    // case tricks still hit nova's folder rules (macOS and Windows ignore case)
    expect((await api("PUT", "/api/vault/note", { path: `AGENTS/${nova.id}/x.md`, content: "x" }, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("PUT", "/api/vault/note", { path: "notes.md", content: "x" }, nodeToken, asAtlas)).status).toBe(403);
  });
});

describe("memory access rules", () => {
  const as = (agent: any) => ({ "x-warren-agent": agent.id });
  const paths = async (agent: any) => (await api<any[]>("GET", "/api/vault/notes", undefined, nodeToken, as(agent))).data.map((n) => n.path);
  const rule = (path: string, subject: object, level: string, startup = false, auth = token) => api("PUT", "/api/access", { path, subject, level, startup }, auth);

  let member: string;
  beforeAll(async () => {
    await api("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" });
    member = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
  });

  it("lets people make their own folders that agents can't see until shared", async () => {
    await api("PUT", "/api/vault/note", { path: "Projects/launch.md", content: "# Launch\nship the zebra feature" });
    await api("PUT", "/api/vault/note", { path: "Projects/secret/keys.md", content: "zebra keys" });
    expect(await paths(atlas)).not.toContain("Projects/launch.md");
    expect((await api("GET", "/api/vault/note?path=Projects/launch.md", undefined, nodeToken, as(atlas))).status).toBe(403);

    expect((await rule("Projects", { kind: "all_agents" }, "read")).status).toBe(200);
    expect((await rule("Projects/secret", { kind: "all_agents" }, "none")).status).toBe(200);
    const seen = await paths(atlas);
    expect(seen).toContain("Projects/launch.md");
    expect(seen).not.toContain("Projects/secret/keys.md");
    // read, not edit
    expect((await api("PUT", "/api/vault/note", { path: "Projects/launch.md", content: "x" }, nodeToken, as(atlas))).status).toBe(403);
    // hidden notes stay out of search and ⌘K too
    const hits = (await api<any[]>("GET", "/api/vault/search?q=zebra", undefined, nodeToken, as(atlas))).data.map((h) => h.path);
    expect(hits).toEqual(["Projects/launch.md"]);
    expect((await api<any>("GET", "/api/search?q=zebra", undefined, nodeToken, as(atlas))).data.notes.map((h: any) => h.path)).toEqual(["Projects/launch.md"]);
    // one agent can be allowed back in
    await rule("Projects/secret", { kind: "agent", id: nova.id }, "edit");
    expect(await paths(nova)).toContain("Projects/secret/keys.md");
    expect(await paths(atlas)).not.toContain("Projects/secret/keys.md");
  });

  it("explains who has access and why", async () => {
    const info = (await api<any>("GET", "/api/access?path=Projects/secret/keys.md")).data;
    expect(info.level).toBe("manage");
    const byHandle = Object.fromEntries(info.agents.map((a: any) => [a.handle, a]));
    expect(byHandle.atlas.level).toBe("none");
    expect(byHandle.atlas.via.path).toBe("Projects/secret");
    expect(byHandle.nova.level).toBe("edit");
    expect(info.people.find((p: any) => p.name === "Sam").level).toBe("edit");
    expect(info.subjects.find((s: any) => s.subject.kind === "all_agents").level).toBe("none");
    const agentView = (await api<any>(`GET`, `/api/access/agents/${nova.id}`)).data;
    expect(agentView.rules.map((r: any) => r.path)).toContain("Projects/secret");
  });

  it("only owners and managers change access, and nobody locks themselves out", async () => {
    expect((await rule("Projects", { kind: "all_agents" }, "edit", false, member)).status).toBe(403);
    expect((await api("PUT", "/api/access", { path: "Projects", subject: { kind: "agent", id: atlas.id }, level: "read" }, nodeToken, as(atlas))).status).toBe(403);
    expect((await rule("Projects", { kind: "all_agents" }, "manage")).status).toBe(400);
    const sam = (await api<any[]>("GET", "/api/members")).data.find((m) => m.name === "Sam");
    await rule("Team", { kind: "user", id: sam.id }, "manage");
    // Sam hides Team/private from every member, including Sam, but keeps managing it
    expect((await rule("Team/private", { kind: "members" }, "none", false, member)).status).toBe(200);
    await api("PUT", "/api/vault/note", { path: "Team/private/plan.md", content: "x" }, member).then((r) => expect(r.status).toBe(200));
    expect((await api<any>("GET", "/api/access?path=Team/private", undefined, member)).data.level).toBe("manage");
  });

  it("only owners can view memory as an agent", async () => {
    const viewed = (await api<any[]>("GET", `/api/vault/notes?as=agent:${atlas.id}`)).data.map((n) => n.path);
    expect(viewed.sort()).toEqual((await paths(atlas)).sort());
    expect((await api("GET", `/api/vault/notes?as=agent:${atlas.id}`, undefined, member)).status).toBe(403);
  });

  it("lets agents share notes they can edit, read-only, without overriding people", async () => {
    await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/research.md`, content: "# Research\nfindings" }, nodeToken, as(atlas));
    expect((await api("GET", `/api/vault/note?path=agents/${atlas.id}/research.md`, undefined, nodeToken, as(nova))).status).toBe(403);
    const shared = await api<any>("POST", "/api/access/share", { path: `agents/${atlas.id}/research.md`, with: "@nova" }, nodeToken, as(atlas));
    expect(shared.status).toBe(200);
    expect((await api("GET", `/api/vault/note?path=agents/${atlas.id}/research.md`, undefined, nodeToken, as(nova))).status).toBe(200);
    expect((await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/research.md`, content: "x" }, nodeToken, as(nova))).status).toBe(403);
    // can't share what you can only read
    expect((await api("POST", "/api/access/share", { path: "Projects/launch.md", with: "@nova" }, nodeToken, as(atlas))).status).toBe(403);
    // a level a person set wins over an agent's share
    expect((await api("POST", "/api/access/share", { path: "Projects/secret", with: "all agents" }, nodeToken, as(nova))).status).toBe(409);
    expect((await api("POST", "/api/access/share", { path: "shared", with: "@nobody" }, nodeToken, as(atlas))).status).toBe(404);
    // shares are visible to people, and the sharing agent can undo them
    const listed = (await api<any[]>("GET", "/api/access/rules")).data.find((r) => r.id === shared.data.id);
    expect(listed.createdBy).toEqual({ kind: "agent", id: atlas.id });
    expect((await api("DELETE", `/api/access/${shared.data.id}`, undefined, nodeToken, as(nova))).status).toBe(403);
    expect((await api("DELETE", `/api/access/${shared.data.id}`, undefined, nodeToken, as(atlas))).status).toBe(200);
    expect((await api("GET", `/api/vault/note?path=agents/${atlas.id}/research.md`, undefined, nodeToken, as(nova))).status).toBe(403);
  });

  it("loads notes marked for startup into the agent's prompt", async () => {
    await api("PUT", "/api/vault/note", { path: "shared/house-rules.md", content: "---\ntags: [rules]\n---\nAlways write tests in vitest." });
    await rule("shared/house-rules.md", { kind: "agent", id: atlas.id }, "read", true);
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas startup check" });
    const run = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.prompt.includes("startup check")));
    const prompt = run.type === "run" ? run.run.prompt : "";
    expect(prompt).toContain("## Notes loaded for you");
    expect(prompt).toContain("### shared/house-rules.md\nAlways write tests in vitest.");
    // and not for agents it wasn't set for
    await api("POST", `/api/channels/${general}/messages`, { body: "@nova startup check two" });
    const other = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.prompt.includes("startup check two")));
    expect(other.type === "run" && other.run.prompt).not.toContain("house-rules");
  });

  it("forgets rules about an agent when it's deleted", async () => {
    const temp = (await api("POST", "/api/agents", { handle: "temp", name: "Temp", harness: "codex" })).data;
    await rule("Projects", { kind: "agent", id: temp.id }, "edit");
    await api("DELETE", `/api/agents/${temp.id}`);
    expect((await api<any[]>("GET", "/api/access/rules")).data.some((r) => r.subject.id === temp.id)).toBe(false);
  });
});

describe("teams and layered memory", () => {
  const as = (agent: any) => ({ "x-warren-agent": agent.id });
  let boss: any;
  let solo: any;
  let owner: any;
  let team: any;
  beforeAll(async () => {
    const nodeId = atlas.nodeId;
    boss = (await api("POST", "/api/agents", { handle: "boss", name: "Boss", harness: "claude-code", nodeId })).data;
    solo = (await api("POST", "/api/agents", { handle: "solo", name: "Solo", harness: "codex", nodeId })).data;
    owner = (await api<any>("GET", "/api/me")).data.user;
  });

  it("gives a channel's team a memory folder, roles and a boss", async () => {
    team = await makeTeam({ name: "web", leadId: atlas.id, reportsTo: boss.id, folder: "teams/web", members: [{ agentId: nova.id, role: "reviewer", roleNotes: "Review every change before it merges." }] });
    expect(team).toMatchObject({ name: "web", folder: "teams/web", leadId: atlas.id, leads: [atlas.id], reportsTo: boss.id, above: [boss.id] });
    expect(team.members.map((m: any) => [m.agentId, m.role]).sort()).toEqual([[atlas.id, ""], [nova.id, "reviewer"]].sort());
    expect((await api<any>("GET", "/api/vault/note?path=teams/web/README.md")).data.content).toContain("# Team #web");
    // the boss can't be on the team, and nobody from elsewhere can be its boss
    const bad = { nodes: [{ agentId: atlas.id, lead: true, x: 0, y: 0 }], edges: [] };
    expect((await api("PATCH", `/api/channels/${team.channelId}`, { settings: { team: { ...bad, reportsTo: atlas.id } } })).status).toBe(400);
    expect((await api("PATCH", `/api/channels/${team.channelId}`, { settings: { team: { ...bad, reportsTo: "agt_nope" } } })).status).toBe(400);
    expect((await api("PATCH", `/api/channels/${team.channelId}`, { settings: { team: { ...bad, folder: "../outside" } } })).status).toBe(400);
  });

  it("keeps the roles, folder, repo and boss when an app saves only the chart", async () => {
    const ch = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.id === team.channelId);
    const { nodes, edges } = ch.settings.team;
    const plain = { nodes: nodes.map(({ agentId, lead, x, y }: any) => ({ agentId, lead, x: x + 10, y })), edges };
    const saved = (await api<any>("PATCH", `/api/channels/${team.channelId}`, { settings: { team: plain } })).data.settings.team;
    expect(saved).toMatchObject({ folder: "teams/web", reportsTo: boss.id });
    expect(saved.nodes.find((n: any) => n.agentId === nova.id)).toMatchObject({ role: "reviewer", roleNotes: "Review every change before it merges." });
  });

  it("opens the pool to members and the boss, and lets rules target a role", async () => {
    const write = (agent: any, path: string) => api("PUT", "/api/vault/note", { path, content: "x" }, nodeToken, as(agent)).then((r) => r.status);
    expect(await write(nova, "teams/web/notes.md")).toBe(200);
    expect(await write(boss, "teams/web/boss.md")).toBe(200);
    expect(await write(solo, "teams/web/solo.md")).toBe(403);
    await api("PUT", "/api/access", { path: "teams/web/decisions", subject: { kind: "team", name: "#web" }, level: "read" });
    await api("PUT", "/api/access", { path: "teams/web/decisions", subject: { kind: "role", team: "web", role: "reviewer" }, level: "edit" });
    expect(await write(nova, "teams/web/decisions/ship.md")).toBe(200);
    expect(await write(atlas, "teams/web/decisions/ship.md")).toBe(403);
    expect((await api("PUT", "/api/access", { path: "x", subject: { kind: "team", name: "nope" }, level: "read" })).status).toBe(404);
  });

  it("lets agents remember things about a person, without duplicates", async () => {
    const remember = (body: object, agent = atlas) => api<any>("POST", "/api/memory/remember", body, nodeToken, as(agent));
    const first = await remember({ kind: "preference", text: "Prefers short, direct answers" });
    expect(first.data).toMatchObject({ saved: true, person: { id: owner.id } });
    expect(first.data.path).toBe(`people/${owner.id}/preferences/prefers-short-direct-answers.md`);
    const dup = await remember({ kind: "preference", text: "prefers short and direct answers" }, nova);
    expect(dup.data.saved).toBe(false);
    expect(dup.data.similar[0].path).toBe(first.data.path);
    expect((await remember({ kind: "preference", text: "Prefers short, direct answers with examples", replaces: first.data.path }, nova)).data.saved).toBe(true);
    await remember({ kind: "did", text: "Deployed the hub" });
    const plan = (await remember({ kind: "plan", text: "Rename the repo folder to warren", due: "2026-11-01" })).data;
    await remember({ kind: "detail", text: "Uses a Proxmox home lab" });

    const profile = (await api<any>("GET", "/api/memory/profile")).data;
    const pref = profile.items.find((i: any) => i.kind === "preference");
    expect(pref).toMatchObject({ text: "Prefers short, direct answers with examples", by: "@atlas" });
    expect(profile.items.find((i: any) => i.kind === "did")).toMatchObject({ text: "Deployed the hub", by: "@atlas" });
    expect(profile.items.find((i: any) => i.kind === "plan")).toMatchObject({ status: "active", due: "2026-11-01" });

    // finishing a plan takes it out of what agents load
    expect((await remember({ kind: "plan", replaces: plan.path, status: "done" })).data.saved).toBe(true);
    const ctx = (await api<any>("GET", "/api/memory/context?q=answers", undefined, nodeToken, as(atlas))).data.text;
    expect(ctx).toContain("## What you know about Yug");
    expect(ctx).toContain("Prefers short, direct answers with examples");
    expect(ctx).toContain("Deployed the hub");
    expect(ctx).not.toContain("Rename the repo folder");
  });

  it("keeps each person's memory away from other people", async () => {
    const sam = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
    expect((await api("GET", "/api/memory/profile", undefined, sam)).status).toBe(200);
    expect((await api("GET", `/api/memory/profile?user=${owner.id}`, undefined, sam)).status).toBe(403);
    expect((await api("GET", `/api/vault/note?path=people/${owner.id}/journal/${new Date().toISOString().slice(0, 10)}.md`, undefined, sam)).status).toBe(403);
  });

  it("starts every run with the person, the agent's teams, and for bosses the teams below", async () => {
    await api("POST", `/api/channels/${general}/messages`, { body: "@nova layered check about answers" });
    const run = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.prompt.includes("layered check")));
    const prompt = run.type === "run" ? run.run.prompt : "";
    expect(prompt).toContain("## What you know about Yug");
    expect(prompt).toContain("Prefers short, direct answers with examples");
    expect(prompt).toContain('### Team "web"; your role: reviewer');
    expect(prompt).toContain("Channel: #web · Team memory: teams/web/");
    expect(prompt).toContain("What your role means: Review every change before it merges.");
    expect(prompt).toContain("Reports to: @boss");
    await api("POST", `/api/channels/${general}/messages`, { body: "@boss boss check" });
    const bossRun = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.prompt.includes("boss check")));
    const bossPrompt = bossRun.type === "run" ? bossRun.run.prompt : "";
    expect(bossPrompt).toContain("## Teams that report to you");
    expect(bossPrompt).toContain('### Team "web" (lead @atlas; 2 agents)');
  });

  it("shows who wrote what", async () => {
    const changes = (await api<any[]>("GET", "/api/vault/changes?limit=20")).data;
    expect(changes.some((ch) => ch.author === "@atlas" && ch.files.some((f: any) => f.path.startsWith(`people/${owner.id}/journal/`)))).toBe(true);
    const sam = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
    const samSees = (await api<any[]>("GET", "/api/vault/changes?limit=50", undefined, sam)).data;
    expect(samSees.some((ch) => ch.files.some((f: any) => f.path.startsWith(`people/${owner.id}/`)))).toBe(false);
    const blame = (await api<any[]>("GET", "/api/vault/blame?path=teams/web/README.md")).data;
    expect(blame[0].author).toBe("Yug");
    const note = (await api<any>("GET", "/api/vault/note?path=teams/web/notes.md")).data;
    expect(note.editedBy).toBe("@nova");
  });

  it("renames rules with the channel, and removes them with it", async () => {
    const subjects = async () => (await api<any[]>("GET", "/api/access/rules")).data.filter((r) => r.subject.kind === "team" || r.subject.kind === "role").map((r) => r.subject);
    expect((await api("PATCH", `/api/channels/${team.channelId}`, { name: "site" })).status).toBe(200);
    expect(await subjects()).toEqual(expect.arrayContaining([{ kind: "team", name: "site" }, { kind: "role", team: "site", role: "reviewer" }]));
    const write = (agent: any, path: string) => api("PUT", "/api/vault/note", { path, content: "y" }, nodeToken, as(agent)).then((r) => r.status);
    expect(await write(nova, "teams/web/decisions/ship.md")).toBe(200);
    expect((await api("DELETE", `/api/channels/${team.channelId}`)).status).toBe(200);
    expect(await subjects()).toEqual([]);
  });
});

describe("team chart", () => {
  it("tells agents who hands them work and who they hand it to", async () => {
    const x = (await api("POST", "/api/agents", { handle: "xena", name: "Xena", harness: "codex" })).data;
    await makeTeam({ name: "chart", leadId: nova.id, folder: "teams/chart", members: [{ agentId: atlas.id, role: "builder" }, { agentId: x.id, managerId: atlas.id }] });
    const ctx = (await api<any>("GET", "/api/memory/context", undefined, nodeToken, { "x-warren-agent": atlas.id })).data.text;
    expect(ctx).toContain('### Team "chart"; your role: builder');
    expect(ctx).toContain("You report to @nova. @xena reports to you.");
    const lead = (await api<any>("GET", "/api/memory/context", undefined, nodeToken, { "x-warren-agent": nova.id })).data.text;
    expect(lead).toContain('### Team "chart", which you lead');
    expect(lead).toContain("@atlas reports to you.");
  });
});

describe("discussions", () => {
  const as = (agent: any) => ({ "x-warren-agent": agent.id });
  let team: any;
  beforeAll(async () => {
    team = await makeTeam({ name: "core", leadId: atlas.id, folder: "teams/core", members: [{ agentId: nova.id, role: "reviewer" }] });
  });
  const runsFor = (discussionId: string) => node.runs.filter((r) => r.type === "run" && r.run.threadId === discussionId);

  it("runs rounds, then has the moderator write a decision that's saved to the team's memory", async () => {
    const started = await api<any>("POST", "/api/discussions", { topic: "Which database?", goal: "Pick one for the beta", team: "#core", rounds: 2 }, nodeToken, as(atlas));
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ participants: [atlas.id, nova.id].sort((a, b) => (a === atlas.id ? -1 : 1)), moderatorId: atlas.id, rounds: 2 });
    const done = await waitFor(async () => {
      const d = (await api<any>("GET", `/api/discussions/${started.data.id}`)).data;
      return d.status === "done" ? d : undefined;
    }, 6000);
    expect(done.decisionPath).toMatch(/^teams\/core\/decisions\/\d{4}-\d{2}-\d{2}-which-database\.md$/);

    const runs = runsFor(started.data.threadId).map((r) => (r.type === "run" ? r.run : null)!);
    expect(runs.length).toBe(5); // 2 agents x 2 rounds + the write-up
    expect(runs[0].prompt).toContain("## You're in a discussion");
    expect(runs[0].prompt).toContain("This is round 1 of 2.");
    expect(runs.some((r) => r.prompt.includes("This is round 2 of 2."))).toBe(true);
    expect(runs[4].agentId).toBe(atlas.id);
    expect(runs[4].prompt).toContain("## Wrap up the discussion");

    const note = (await api<any>("GET", `/api/vault/note?path=${done.decisionPath}`)).data;
    expect(note.content).toContain("# Which database?");
    expect(note.content).toContain("atlas heard:");
    expect(note.editedBy).toBe("@atlas");
    const thread = await channelMessagesIn(started.data.channelId, started.data.threadId);
    const notices = thread.flatMap((m) => m.parts.filter((p) => p.type === "notice").map((p) => (p as { text: string }).text));
    expect(notices).toEqual(["Round 1 of 2", "Round 2 of 2", "@atlas is writing up the decision", `Decision saved to ${done.decisionPath}`]);
  });

  it("goes on without a participant whose device is offline, and stops when nobody is there", async () => {
    const notices = async (d: { channelId: string; threadId: string }) => (await channelMessagesIn(d.channelId, d.threadId)).flatMap((m) => m.parts.filter((p) => p.type === "notice").map((p) => (p as { text: string }).text));
    // no device at all: as offline as it gets
    const dozy = (await api("POST", "/api/agents", { handle: "dozy", name: "Dozy", harness: "codex" })).data;
    const d = (await api<any>("POST", "/api/discussions", { topic: "Lunch", participants: ["@nova", "@dozy"], moderator: "@dozy", rounds: 1 })).data;
    const done = await waitFor(async () => {
      const x = (await api<any>("GET", `/api/discussions/${d.id}`)).data;
      return x.status === "done" ? x : undefined;
    }, 6000);
    expect(done.moderatorId).toBe(nova.id);
    expect(await notices(d)).toEqual(["Round 1 of 1 (@dozy is offline and sits this round out)", "@nova is writing up the decision instead of @dozy, who is offline", `Decision saved to ${done.decisionPath}`]);
    expect(runsFor(d.threadId).every((r) => r.type === "run" && r.run.agentId === nova.id)).toBe(true);

    const dozier = (await api("POST", "/api/agents", { handle: "dozier", name: "Dozier", harness: "codex" })).data;
    const nobody = (await api<any>("POST", "/api/discussions", { topic: "Naps", participants: ["@dozy", "@dozier"] })).data;
    expect(nobody.status).toBe("cancelled");
    expect(await notices(nobody)).toEqual(["@dozy, @dozier are offline, so the discussion stopped before round 1. Start it again when they're back."]);
    await api("DELETE", `/api/agents/${dozy.id}`);
    await api("DELETE", `/api/agents/${dozier.id}`);
  });

  it("can be stopped, and needs two agents", async () => {
    const sleepy = (await api("POST", "/api/agents", { handle: "sleepy", name: "Sleepy", harness: "codex" })).data;
    const d = (await api<any>("POST", "/api/discussions", { topic: "Naps", participants: ["@sleepy", "@nova"] })).data;
    expect(d.status).toBe("running");
    const stopped = (await api<any>("POST", `/api/discussions/${d.id}/cancel`)).data;
    expect(stopped.status).toBe("cancelled");
    expect((await api("POST", "/api/discussions", { topic: "Solo", participants: ["@nova"] })).status).toBe(400);
    await api("DELETE", `/api/agents/${sleepy.id}`);
  });
});

describe("coding together", () => {
  const as = (agent: any) => ({ "x-warren-agent": agent.id });
  let team: any;
  beforeAll(async () => {
    team = await makeTeam({ name: "app", leadId: atlas.id, members: [{ agentId: nova.id }], repo: "/srv/app", baseBranch: "main" });
  });

  it("gives a coding task its own branch, then a review, then merges it", async () => {
    const task = (await api<any>("POST", "/api/tasks", { to: "nova", title: "Add login page", brief: "Build it", channelId: team.channelId }, nodeToken, as(atlas))).data;
    expect(task.branch).toMatch(/^warren\/nova\/add-login-page-[a-z0-9x]{5}$/);
    expect(task.teamId).toBe(team.id);
    const workRun = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.threadId === task.threadId && r.run.agentId === nova.id));
    expect(workRun.type === "run" && workRun.run.workspace).toEqual({ repo: "/srv/app", branch: task.branch, base: "main", mode: "work" });
    expect(workRun.type === "run" && workRun.run.prompt).toContain(`branch \`${task.branch}\``);

    // done: the lead gets a review task on the same branch, with a read-only checkout
    await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "built it" }, nodeToken, as(nova));
    const review = await waitFor(async () => (await api<any[]>(`GET`, `/api/tasks?team=${team.id}`)).data.find((t) => t.reviewOf === task.id));
    expect(review).toMatchObject({ toAgentId: atlas.id, branch: task.branch, title: "Review: Add login page" });
    const reviewRun = await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.threadId === review.threadId && r.run.agentId === atlas.id));
    expect(reviewRun.type === "run" && reviewRun.run.workspace?.mode).toBe("review");

    // only the lead, reviewers or the boss can merge; nova is just a member
    expect((await api("POST", `/api/tasks/${review.id}/merge`, undefined, nodeToken, as(nova))).status).toBe(403);
    const merged = await api<any>("POST", `/api/tasks/${review.id}/merge`, undefined, nodeToken, as(atlas));
    expect(merged.status).toBe(200);
    expect(merged.data.output).toBe(`Merged ${task.branch} into main.`);
    expect(merged.data.task.mergedAt).toBeTruthy();
    expect((await channelMessagesIn(team.channelId, task.threadId)).some((m) => m.body === `Merged \`${task.branch}\` into \`main\`.`)).toBe(true);
  });

  it("only team work gets a branch, and leads hand work out in the team's channel", async () => {
    const general = (await api<any>("POST", "/api/tasks", { to: "nova", title: "Write notes", brief: "x" })).data;
    expect(general.branch).toBeNull();
    const fromLead = (await api<any>("POST", "/api/tasks", { to: "nova", title: "Fix footer", brief: "x" }, nodeToken, as(atlas))).data;
    expect(fromLead.channelId).toBe(team.channelId);
    expect(fromLead.branch).toMatch(/^warren\/nova\/fix-footer-/);
  });
});

describe("upgrading from v0.1", () => {
  it("turns memory grants into access rules on the scope's folder", async () => {
    const file = path.join(dir, "old.db");
    const old = openDb(file);
    old.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Old', '2026-01-01')").run();
    old.prepare("INSERT INTO grants (id, workspace_id, scope_json, grantee_json, perms_json, created_at) VALUES ('grt_a', 'ws_1', ?, ?, ?, '2026-01-01')").run(JSON.stringify({ kind: "agent", id: "agt_b" }), JSON.stringify({ kind: "all_agents" }), JSON.stringify(["read", "write"]));
    old.prepare("INSERT INTO grants (id, workspace_id, scope_json, grantee_json, perms_json, created_at) VALUES ('grt_b', 'ws_1', ?, ?, ?, '2026-01-01')").run(JSON.stringify({ kind: "group", name: "ops" }), JSON.stringify({ kind: "agent", id: "agt_c" }), JSON.stringify(["read"]));
    old.close();
    const db = openDb(file);
    const rules = new Store(db).accessRules("ws_1");
    expect(rules.map((r) => [r.path, r.subject, r.level])).toEqual([
      ["agents/agt_b", { kind: "all_agents" }, "edit"],
      ["groups/ops", { kind: "agent", id: "agt_c" }, "read"],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM grants").get()).toEqual({ n: 0 });
    db.close();
  });

  it("turns agent groups into channel teams that keep their folder", async () => {
    const file = path.join(dir, "old-groups.db");
    const old = openDb(file);
    old.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Old', '2026-01-01')").run();
    old.prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, groups_json, created_at) VALUES ('agt_a', 'ws_1', 'a', 'A', 'codex', ?, '2026-01-01')").run(JSON.stringify(["Research"]));
    old.prepare("INSERT INTO access_rules (id, workspace_id, path, path_key, subject, level, created_at) VALUES ('r1', 'ws_1', 'x', 'x', 'group:Research', 'read', '2026-01-01')").run();
    old.close();
    const db = openDb(file);
    const store = new Store(db);
    foldTeams(store);
    expect(store.teams("ws_1").map((t) => [t.name, t.folder, t.members.map((m) => m.agentId), t.leadId])).toEqual([["team-research", "groups/Research", ["agt_a"], "agt_a"]]);
    expect(store.accessRules("ws_1")[0].subject).toEqual({ kind: "team", name: "team-research" });
    db.close();
  });

  it("folds each team into its channel: chart, roles, folder, repo, boss, rules and tasks", async () => {
    const file = path.join(dir, "old-teams.db");
    const old = openDb(file);
    const ins = (sql: string, ...args: unknown[]) => old.prepare(sql).run(...args);
    ins("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Old', '2026-01-01')");
    ins("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_o', 'o@x', 'O', 'x', '2026-01-01')");
    ins("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_1', 'usr_o', 'owner')");
    for (const h of ["lead", "dev", "qa", "boss", "solo"]) ins("INSERT INTO agents (id, workspace_id, handle, name, harness, created_at) VALUES (?, 'ws_1', ?, ?, 'codex', '2026-01-01')", `agt_${h}`, h, h);
    ins("INSERT INTO channels (id, workspace_id, name, kind, topic, created_at) VALUES ('ch_web', 'ws_1', 'team-web', 'channel', '', '2026-01-01')");
    ins("INSERT INTO teams (id, workspace_id, name, emoji, description, lead_id, reports_to, channel_id, folder, repo, base_branch, created_at) VALUES ('team_w', 'ws_1', 'web', '🛠️', 'Builds the site', 'agt_lead', 'agt_boss', 'ch_web', 'teams/web', '/srv/web', 'trunk', '2026-01-01')");
    ins("INSERT INTO team_members (team_id, agent_id, role, role_notes, manager_id, x, y) VALUES ('team_w', 'agt_lead', 'Lead', '', NULL, 300, 40)");
    ins("INSERT INTO team_members (team_id, agent_id, role, role_notes, manager_id, x, y) VALUES ('team_w', 'agt_dev', 'Builder', 'Builds it', 'agt_lead', NULL, NULL)");
    ins("INSERT INTO team_members (team_id, agent_id, role, role_notes, manager_id, x, y) VALUES ('team_w', 'agt_qa', 'Reviewer', '', 'agt_dev', NULL, NULL)");
    // a team with no channel yet, and one named like the other's channel
    ins("INSERT INTO teams (id, workspace_id, name, folder, created_at) VALUES ('team_s', 'ws_1', 'team-web', 'teams/team-web', '2026-01-02')");
    ins("INSERT INTO team_members (team_id, agent_id) VALUES ('team_s', 'agt_solo')");
    ins("INSERT INTO access_rules (id, workspace_id, path, path_key, subject, level, created_at) VALUES ('r1', 'ws_1', 'teams/web/x', 'teams/web/x', 'team:web', 'read', '2026-01-01')");
    ins("INSERT INTO access_rules (id, workspace_id, path, path_key, subject, level, created_at) VALUES ('r2', 'ws_1', 'teams/web/x', 'teams/web/x', 'role:web/Reviewer', 'edit', '2026-01-01')");
    ins("INSERT INTO access_rules (id, workspace_id, path, path_key, subject, level, created_at) VALUES ('r3', 'ws_1', 'y', 'y', 'team:team-web', 'read', '2026-01-01')");
    ins("INSERT INTO tasks (id, workspace_id, from_kind, from_id, to_agent_id, title, brief, status, channel_id, team_id, created_at, updated_at) VALUES ('task_1', 'ws_1', 'user', 'usr_o', 'agt_dev', 'Do it', '', 'open', 'ch_web', 'team_w', '2026-01-01', '2026-01-01')");
    old.close();

    const db = openDb(file);
    const store = new Store(db);
    expect(foldTeams(store).map((t) => [t.name, t.folder])).toEqual([
      ["team-web", "teams/web"],
      ["team-team-web", "teams/team-web"],
    ]);
    const web = store.channel("ch_web")!;
    expect(web.topic).toBe("🛠️ Builds the site");
    expect(web.settings.replyInThread).toBe(true);
    expect(web.settings.team).toMatchObject({ folder: "teams/web", repo: "/srv/web", baseBranch: "trunk", reportsTo: "agt_boss", edges: [{ from: "agt_lead", to: "agt_dev" }, { from: "agt_dev", to: "agt_qa" }] });
    expect(web.settings.team!.nodes).toEqual([
      { agentId: "agt_lead", lead: true, x: 300, y: 40, role: "Lead", roleNotes: "" },
      { agentId: "agt_dev", lead: false, x: 24, y: 156, role: "Builder", roleNotes: "Builds it" },
      { agentId: "agt_qa", lead: false, x: 24, y: 288, role: "Reviewer", roleNotes: "" },
    ]);
    expect(teamProblem(web.settings.team!)).toBeNull();
    const made = store.channelByName("ws_1", "team-team-web")!;
    expect(made.settings.team).toMatchObject({ folder: "teams/team-web", nodes: [{ agentId: "agt_solo", lead: true }], edges: [] });
    expect(store.channelMembers(made.id).map((m) => m.id).sort()).toEqual(["agt_solo", "usr_o"]);
    expect(store.accessRules("ws_1").map((r) => [r.id, r.subject])).toEqual(
      expect.arrayContaining([
        ["r1", { kind: "team", name: "team-web" }],
        ["r2", { kind: "role", team: "team-web", role: "Reviewer" }],
        ["r3", { kind: "team", name: "team-team-web" }],
      ]),
    );
    expect(store.task("task_1")!.teamId).toBe("ch_web");
    expect(store.team("ch_web")).toMatchObject({ name: "team-web", repo: "/srv/web", leads: ["agt_lead"] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM teams").get()).toEqual({ n: 0 });
    // running it again changes nothing
    expect(foldTeams(store)).toEqual([]);
    db.close();
  });
});

describe("agent settings", () => {
  let ch: string;
  beforeAll(async () => {
    ch = (await api("POST", "/api/channels", { name: "settings-test" })).data.id;
  });

  it("gives new agents a starter soul, and sends soul then instructions in every prompt", async () => {
    expect((await api("GET", `/api/vault/note?path=agents/${atlas.id}/SOUL.md`)).data.content).toContain("## Personality");
    await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/SOUL.md`, content: "---\ntags: [soul]\n---\n# Atlas\nAlways answers in haiku." });
    await api("PATCH", `/api/agents/${atlas.id}`, { instructions: "You own the research backlog." });
    const before = node.runs.length;
    await api("POST", `/api/channels/${ch}/messages`, { body: "@atlas status?" });
    await waitFor(async () => (node.runs.length > before ? true : undefined));
    const last = node.runs.at(-1)!;
    const prompt = last.type === "run" ? last.run.prompt : "";
    expect(prompt).toContain("Always answers in haiku.");
    expect(prompt).not.toContain("tags: [soul]"); // frontmatter stripped
    expect(prompt).toContain("You own the research backlog.");
    expect(prompt.indexOf("haiku")).toBeLessThan(prompt.indexOf("research backlog"));
    expect(prompt).toContain("You run in Claude Code with its default model");
  });

  it("validates settings and merges them key by key", async () => {
    await api("PATCH", `/api/agents/${nova.id}`, { settings: { effort: "high" } });
    const r = await api("PATCH", `/api/agents/${nova.id}`, { settings: { access: "read-only" }, model: "gpt-6-astra" });
    // new agents also record who made them and start out answering only them
    expect(r.data.settings).toEqual({ effort: "high", access: "read-only", respondTo: "me", createdBy: expect.any(String) });
    expect(r.data.model).toBe("gpt-6-astra");
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { access: "root" } })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { sudo: true } })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { fast: "yes" } })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { fast: true } })).data.settings.fast).toBe(true);
    await api("PATCH", `/api/agents/${nova.id}`, { settings: { fast: false } });
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { effort: "high; rm -rf /" } })).status).toBe(400);
  });

  it("lets an agent refine its own soul unless the owner locks it", async () => {
    const asAtlas = { "x-warren-agent": atlas.id };
    const soul = `agents/${atlas.id}/SOUL.md`;
    expect((await api("PUT", "/api/vault/note", { path: soul, content: "# Atlas\nCurious." }, nodeToken, asAtlas)).status).toBe(200);
    await api("PATCH", `/api/agents/${atlas.id}`, { settings: { soulLocked: true } });
    expect((await api("PUT", "/api/vault/note", { path: soul, content: "# Atlas\nEvil." }, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/soul`, content: "x" }, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("POST", "/api/vault/append", { path: soul, text: "x" }, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("DELETE", `/api/vault/note?path=${soul}`, undefined, nodeToken, asAtlas)).status).toBe(403);
    expect((await api("PUT", "/api/vault/note", { path: `agents/${atlas.id}/notes.md`, content: "still fine" }, nodeToken, asAtlas)).status).toBe(200);
    expect((await api("PUT", "/api/vault/note", { path: soul, content: "# Atlas\nOwner edit." })).status).toBe(200);
    await api("PATCH", `/api/agents/${atlas.id}`, { settings: { soulLocked: false } });
  });

  it("serves the models a device reported for the agent's harness", async () => {
    node.send({ type: "catalog", catalog: [{ harness: "claude-code", version: "2.1", efforts: ["low", "high"], models: [{ id: "opus", label: "Opus" }] }] });
    const r = await waitFor(async () => {
      const d = (await api("GET", `/api/agents/${atlas.id}/models`)).data;
      return d.catalog ? d : undefined;
    });
    expect(r.device).toMatchObject({ name: "test-node", online: true });
    expect(r.catalog.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect((await api("GET", `/api/agents/${nova.id}/models`)).data.catalog).toBeNull(); // no codex on this device
  });

  it("accepts catalog model ids at the shared limit when creating and updating agents", async () => {
    const model = "m".repeat(MAX_MODEL_ID_LENGTH);
    const catalog = { harness: "claude-code", version: "2.1", efforts: [], models: [{ id: model, label: "Long model" }] };
    node.send({ type: "catalog", catalog: [catalog] });
    await waitFor(async () => (await api("GET", `/api/agents/${atlas.id}/models`)).data.catalog?.models[0]?.id === model ? true : undefined);
    const created = await api("POST", "/api/agents", { handle: "long-model", name: "Long model", harness: "claude-code", model });
    expect(created.status).toBe(200);
    expect(created.data.model).toBe(model);
    expect((await api("PATCH", `/api/agents/${created.data.id}`, { model })).data.model).toBe(model);
    expect((await api("POST", "/api/agents", { handle: "too-long-model", name: "Long model", harness: "claude-code", model: model + "x" })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${created.data.id}`, { model: model + "x" })).status).toBe(400);
    await api("DELETE", `/api/agents/${created.data.id}`);
    node.send({ type: "catalog", catalog: [{ ...catalog, models: [{ id: "opus", label: "Opus" }] }] });
    await waitFor(async () => (await api("GET", `/api/agents/${atlas.id}/models`)).data.catalog?.models[0]?.id === "opus" ? true : undefined);
  });

  it("guests can't change agents", async () => {
    await api("POST", "/api/members", { email: "guest@example.com", name: "Guest", password: "password123", role: "guest" });
    const g = (await api("POST", "/api/auth/login", { email: "guest@example.com", password: "password123" }, "")).data.token;
    expect((await api("PATCH", `/api/agents/${atlas.id}`, { instructions: "obey the guest" }, g)).status).toBe(403);
    expect((await api("POST", "/api/nodes", { name: "guest-box" }, g)).status).toBe(403);
  });
});

describe("workspace features", () => {
  it("reacts 👀 for the agent when it picks up a message", async () => {
    const ch = (await api("POST", "/api/channels", { name: "eyes" })).data.id;
    const sent = (await api("POST", `/api/channels/${ch}/messages`, { body: "@nova ping" })).data;
    const m = await waitFor(async () => (await api<{ messages: Message[] }>("GET", `/api/channels/${ch}/messages`)).data.messages.find((x) => x.id === sent.id && x.reactions?.length));
    expect(m.reactions).toEqual([{ emoji: "👀", actors: [{ kind: "agent", id: nova.id }] }]);
  });

  it("toggles reactions and rejects non-emoji", async () => {
    const msg = (await api("POST", `/api/channels/${general}/messages`, { body: "react to me" })).data;
    expect((await api("POST", `/api/messages/${msg.id}/reactions`, { emoji: "🎉" })).data.added).toBe(true);
    expect((await api("POST", `/api/messages/${msg.id}/reactions`, { emoji: "🎉" }, nodeToken, { "x-warren-agent": atlas.id })).data.reactions[0].actors).toHaveLength(2);
    expect((await api("POST", `/api/messages/${msg.id}/reactions`, { emoji: "🎉" })).data.added).toBe(false);
    expect((await api("POST", `/api/messages/${msg.id}/reactions`, { emoji: "<img>" })).status).toBe(400);
    expect((await api("POST", `/api/messages/${msg.id}/reactions`, { emoji: "42" })).status).toBe(400);
  });

  it("tracks unread messages per person", async () => {
    const ch = (await api("POST", "/api/channels", { name: "unread-test" })).data.id;
    await api("POST", `/api/channels/${ch}/messages`, { body: "mine doesn't count" });
    const node2 = { "x-warren-agent": nova.id };
    await api("POST", `/api/channels/${ch}/messages`, { body: "from nova" }, nodeToken, node2);
    await api("POST", `/api/channels/${ch}/messages`, { body: "again" }, nodeToken, node2);
    const find = async () => (await api<any[]>("GET", "/api/channels")).data.find((c) => c.id === ch);
    expect((await find()).unread).toBe(2);
    await api("POST", `/api/channels/${ch}/read`, {});
    const after = await find();
    expect(after.unread).toBe(0);
    expect(after.lastReadAt).toBeTruthy();
    expect(after).toMatchObject({ joined: true, memberCount: 2 });
  });

  it("joins and leaves channels", async () => {
    const ch = (await api("POST", "/api/channels", { name: "join-test" })).data.id;
    await api("POST", `/api/channels/${ch}/leave`);
    expect((await api<any[]>("GET", "/api/channels")).data.find((c) => c.id === ch).joined).toBe(false);
    await api("POST", `/api/channels/${ch}/join`);
    expect((await api<any[]>("GET", "/api/channels")).data.find((c) => c.id === ch).joined).toBe(true);
  });

  it("groups channels into sections", async () => {
    const sec = (await api("POST", "/api/sections", { name: "Product", emoji: "🛠" })).data;
    const ch = (await api("POST", "/api/channels", { name: "design", sectionId: sec.id })).data;
    expect(ch.sectionId).toBe(sec.id);
    await api("PATCH", `/api/sections/${sec.id}`, { name: "Product team" });
    expect((await api<any[]>("GET", "/api/sections")).data.find((s) => s.id === sec.id).name).toBe("Product team");
    expect((await api("POST", "/api/sections", { name: "x", emoji: "nope" })).status).toBe(400);
    await api("DELETE", `/api/sections/${sec.id}`);
    expect((await api<any[]>("GET", "/api/channels")).data.find((c) => c.id === ch.id).sectionId).toBeNull();
  });

  it("searches channels, agents, messages and memory you can see", async () => {
    await api("POST", `/api/channels/${general}/messages`, { body: "the zebra launch plan" });
    const r = (await api("GET", "/api/search?q=zebra")).data;
    expect(r.messages.some((m: any) => m.body.includes("zebra") && m.channelName === "general")).toBe(true);
    expect((await api("GET", "/api/search?q=atl")).data.agents.map((a: any) => a.handle)).toContain("atlas");
    expect((await api("GET", "/api/search?q=%25")).data.messages).toEqual([]); // LIKE wildcards are escaped
    expect((await api("GET", "/api/search?q=Welcome")).data.notes.map((n: any) => n.path)).toContain("shared/Welcome.md");
  });

  it("lists an agent's recent runs", async () => {
    const runs = (await api<any[]>("GET", `/api/agents/${atlas.id}/runs`)).data;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toMatchObject({ status: expect.any(String), channelName: expect.any(String) });
  });
});

describe("ghost appearance", () => {
  const look = { shape: "sheet", color: "#d6c8ff", glow: true, eyes: "sparkle", mouth: "fangs", cheeks: true, hat: "witch", accessory: "scarf", motion: "sway" };
  it("saves a valid look and rejects anything off-menu", async () => {
    const r = await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: look } });
    expect(r.status).toBe(200);
    expect(r.data.settings.appearance).toEqual(look);
    expect(r.data.settings.effort).toBe("high"); // other settings untouched
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: { ...look, hat: "sombrero-of-doom" } } })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: { ...look, color: "red;background:url(x)" } } })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: { ...look, extra: 1 } } })).status).toBe(400);
  });
  it("takes a second color for a gradient body", async () => {
    const r = await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: { ...look, color2: "#ff51bf" } } });
    expect(r.status).toBe(200);
    expect(r.data.settings.appearance.color2).toBe("#ff51bf");
    expect((await api("PATCH", `/api/agents/${nova.id}`, { settings: { appearance: { ...look, color2: "url(x)" } } })).status).toBe(400);
  });
});

describe("agent context", () => {
  it("shows the model, effort, context window and permissions you're talking to", async () => {
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    await api("POST", `/api/channels/${dm.id}/messages`, { body: "hello" });
    await waitFor(async () => (await api<{ messages: Message[] }>("GET", `/api/channels/${dm.id}/messages`)).data.messages.find((m) => m.author.id === atlas.id));
    const ctx = (await api("GET", `/api/agents/${atlas.id}/context?channel=${dm.id}`)).data;
    expect(ctx).toMatchObject({ harness: "claude-code", model: "fake-1", modelIsDefault: true, effort: "medium", effortIsDefault: true, access: "edit", contextUsed: 4321, contextWindow: 200000 });
    expect(ctx.lastRunAt).toBeTruthy();
    // another conversation has its own context
    expect((await api("GET", `/api/agents/${atlas.id}/context?channel=${general}`)).data.contextUsed).toBe(4321);
    const other = (await api("POST", "/api/channels", { name: "ctx-empty" })).data.id;
    expect((await api("GET", `/api/agents/${atlas.id}/context?channel=${other}`)).data.contextUsed).toBeNull();
  });

  it("drops stale context numbers after you switch the agent to another model", async () => {
    await api("PATCH", `/api/agents/${atlas.id}`, { model: "opus", settings: { effort: "high", access: "read-only" } });
    const dm = (await api("POST", `/api/dm/${atlas.id}`)).data;
    const ctx = (await api("GET", `/api/agents/${atlas.id}/context?channel=${dm.id}`)).data;
    expect(ctx).toMatchObject({ model: "opus", modelIsDefault: false, effort: "high", effortIsDefault: false, access: "read-only", contextUsed: null });
    await api("PATCH", `/api/agents/${atlas.id}`, { model: null, settings: { effort: null, access: "edit" } });
  });
});

describe("agents inside their computers", () => {
  it("runs a harness that comes with the VM inside it, and then takes requests from anyone", async () => {
    const sam = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
    // running directly on Yug's device, Atlas only works for Yug
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas hi from sam" }, sam);
    await waitFor(async () => (await channelMessages()).find((m) => m.parts.some((p) => p.type === "status" && p.text.includes("only Yug can ask it"))));

    const vm = (await api("POST", "/api/computers", { kind: "vm", nodeId: atlas.nodeId, name: "Atlas desk" })).data;
    await api("PATCH", `/api/agents/${atlas.id}`, { computerId: vm.id, settings: { runIn: "computer" } });
    const before = node.runs.length;
    await api("POST", `/api/channels/${general}/messages`, { body: "@atlas hi again from sam" }, sam);
    const run = await waitFor(async () => node.runs.slice(before).find((r) => r.type === "run" && r.run.agentId === atlas.id));
    expect(run.type === "run" && run.run).toMatchObject({ inComputer: true, computer: { id: vm.id, kind: "vm" } });
    expect(run.type === "run" && run.run.prompt).toContain("You run inside this computer");

    // a member can't put it back onto Yug's device
    expect((await api("PATCH", `/api/agents/${atlas.id}`, { settings: { runIn: "device" } }, sam)).status).toBe(403);
    expect((await api("PATCH", `/api/agents/${atlas.id}`, { settings: { runIn: "device" } })).status).toBe(200);
  });

  it("hands a person's task to whoever should route it, and shows it being worked on", async () => {
    const t = (await api<any>("POST", "/api/tasks", { to: "auto", title: "Plan the offsite", brief: "Three venues under $5k." })).data;
    expect([atlas.id, nova.id]).toContain(t.toAgentId);
    const thread = await waitFor(async () => (await channelMessagesIn(t.channelId)).find((m) => m.id === t.threadId));
    expect(thread.body).toContain("You're the lead: plan this");
    // the agent picking it up moves it to in progress
    const working = await waitFor(async () => (await api<any[]>("GET", "/api/tasks")).data.find((x) => x.id === t.id && x.status === "in_progress"));
    expect(working).toBeTruthy();
    // a person can close it
    expect((await api<any>("PATCH", `/api/tasks/${t.id}`, { status: "done", result: "Booked." })).data.status).toBe("done");
  });
});

describe("the lead", () => {
  it("takes every unassigned task, knows who has which role, and hands out subtasks", async () => {
    // only owners pick the lead
    const sam = (await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" }, "")).data.token;
    expect((await api("PUT", "/api/settings/lead", { leadId: atlas.id }, sam)).status).toBe(403);
    expect((await api("PUT", "/api/settings/lead", { leadId: "agent_nope" })).status).toBe(404);
    const picked = (await api<any>("PUT", "/api/settings/lead", { leadId: atlas.id })).data;
    expect(picked).toEqual({ leadId: atlas.id, lead: atlas.id });
    expect((await api<any>("GET", "/api/settings/lead")).data).toEqual(picked);

    // roles live in the agent's settings, or on its team
    await api("PATCH", `/api/agents/${nova.id}`, { settings: { role: "Engineer", roleNotes: "Owns the build." } });
    const tess = (await api("POST", "/api/agents", { handle: "tess", name: "Tess", harness: "kimi", nodeId: atlas.nodeId })).data;
    await makeTeam({ name: "squad", leadId: atlas.id, members: [{ agentId: tess.id, role: "Frontend & design", roleNotes: "Owns how it looks." }] });

    // no add-on to turn on: an unassigned task goes to the lead, who's told to plan it
    const before = node.runs.length;
    const parent = (await api<any>("POST", "/api/tasks", { title: "Ship the release", brief: "Get 2.0 out." })).data;
    expect(parent.toAgentId).toBe(atlas.id);
    expect(parent.parentId).toBeNull();
    expect(parent.brief).toContain("You're the lead");
    const run = await waitFor(async () => node.runs.slice(before).find((r) => r.type === "run" && r.run.agentId === atlas.id));
    const prompt = run.type === "run" ? run.run.prompt : "";
    expect(prompt).toContain("## You're the lead");
    expect(prompt).toContain("@nova (Nova, codex): Engineer. Owns the build.");
    expect(prompt).toContain("@tess (Tess, kimi): Frontend & design. Owns how it looks.");

    // what the lead hands out while working the task becomes its subtask
    const file = path.join(dir, "warren.db");
    const db = openDb(file);
    const runId = run.type === "run" ? run.run.runId : "";
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    const asAtlas = { "x-warren-agent": atlas.id };
    const sub = (await api<any>("POST", "/api/tasks", { to: "nova", title: "Run the release build", brief: "build it" }, nodeToken, asAtlas)).data;
    db.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(runId);
    db.close();
    expect(sub.parentId).toBe(parent.id);
    // or names it outright
    const sub2 = (await api<any>("POST", "/api/tasks", { to: "nova", title: "Write the changelog", brief: "notes", parentTaskId: parent.id }, nodeToken, asAtlas)).data;
    expect(sub2.parentId).toBe(parent.id);
    expect((await api("POST", "/api/tasks", { to: "nova", title: "x", brief: "x", parentTaskId: "task_nope" }, nodeToken, asAtlas)).status).toBe(404);

    // a finished subtask tells the lead how far along the whole thing is
    await api("PATCH", `/api/tasks/${sub.id}`, { status: "done", result: "built" }, nodeToken, { "x-warren-agent": nova.id });
    const report = await waitFor(async () => (await channelMessagesIn(sub.channelId, sub.threadId)).find((m) => m.body.includes("subtasks done")));
    expect(report.body).toContain("1/2 subtasks done");
    expect(report.body).toContain("@atlas");
    // which wakes the lead up with it
    await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.agentId === atlas.id && r.run.prompt.includes("1/2 subtasks done")));
    await waitFor(async () => node.runs.find((r) => r.type === "run" && r.run.agentId === nova.id && r.run.prompt.includes("Write the changelog")));
    await new Promise((r) => setTimeout(r, 200));

    // unpicking falls back to a team lead
    await api("PUT", "/api/settings/lead", { leadId: null });
    const status = (await api<any>("GET", "/api/settings/lead")).data;
    expect(status.leadId).toBeNull();
    expect(status.lead).toBeTruthy();
  });

  it("keeps the dispatcher an old workspace picked as its lead", () => {
    const db = openDb(path.join(dir, "old-dispatcher.db"));
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Old', '2026-01-01')").run();
    for (const h of ["a", "b"]) db.prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, created_at) VALUES (?, 'ws_1', ?, ?, 'codex', '2026-01-01')").run(`agt_${h}`, h, h);
    const store = new Store(db);
    store.setSetting("ws_1", "orchestration", JSON.stringify({ enabled: false, dispatcherId: "agt_b" }));
    expect(workspaceLead(store, "ws_1")?.id).toBe("agt_b");
    // a lead picked now wins over the old setting
    store.setSetting("ws_1", "lead", JSON.stringify({ leadId: "agt_a" }));
    expect(workspaceLead(store, "ws_1")?.id).toBe("agt_a");
    db.close();
  });
});

describe("review by someone else", () => {
  const as = (agent: any) => ({ "x-warren-agent": agent.id });
  const mk = async (handle: string, harness: string) => (await api<any>("POST", "/api/agents", { handle, name: handle, harness, nodeId: atlas.nodeId })).data;
  const reviewFor = (teamId: string, taskId: string) => waitFor(async () => (await api<any[]>("GET", `/api/tasks?team=${teamId}`)).data.find((t) => t.reviewOf === taskId));

  it("goes to the team's reviewer, never the builder, and the builder can't merge its own work", async () => {
    const rune = await mk("rune", "claude-code");
    const kai = await mk("kai", "kimi");
    const team = await makeTeam({ name: "stack", leadId: nova.id, repo: "/srv/stack", members: [{ agentId: kai.id, role: "Frontend & design" }, { agentId: rune.id, role: "Reviewer" }] });
    const task = (await api<any>("POST", "/api/tasks", { to: "kai", title: "Restyle the header", brief: "Make it nicer", channelId: team.channelId }, nodeToken, as(nova))).data;
    await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "restyled" }, nodeToken, as(kai));
    const review = await reviewFor(team.id, task.id);
    expect(review.toAgentId).toBe(rune.id);
    expect((await api("POST", `/api/tasks/${review.id}/merge`, undefined, nodeToken, as(kai))).status).toBe(403);
    expect((await api("POST", `/api/tasks/${review.id}/merge`, undefined, nodeToken, as(rune))).status).toBe(200);
  });

  it("falls back to a teammate on another harness, who can then merge, and skips review when nobody else is there", async () => {
    const lia = await mk("lia", "codex");
    const kim = await mk("kim", "kimi");
    const team = await makeTeam({ name: "pair", leadId: lia.id, repo: "/srv/pair", members: [{ agentId: kim.id }] });
    // the lead builds, so the only other teammate reviews it
    const task = (await api<any>("POST", "/api/tasks", { to: "lia", title: "Add search", brief: "x", channelId: team.channelId })).data;
    await api("PATCH", `/api/tasks/${task.id}`, { status: "done", result: "done" }, nodeToken, as(lia));
    const review = await reviewFor(team.id, task.id);
    expect(review.toAgentId).toBe(kim.id);
    // kim isn't the lead or called a reviewer, but is reviewing this one
    expect((await api("POST", `/api/tasks/${review.id}/merge`, undefined, nodeToken, as(kim))).status).toBe(200);

    // alone on its team, the work goes to the workspace's lead, unless that's the builder
    const solo = await makeTeam({ name: "loner", leadId: lia.id, repo: "/srv/loner" });
    await api("PUT", "/api/settings/lead", { leadId: lia.id });
    const alone = (await api<any>("POST", "/api/tasks", { to: "lia", title: "Fix typo", brief: "x", channelId: solo.channelId })).data;
    await api("PATCH", `/api/tasks/${alone.id}`, { status: "done", result: "done" }, nodeToken, as(lia));
    await new Promise((r) => setTimeout(r, 200));
    expect((await api<any[]>("GET", `/api/tasks?team=${solo.id}`)).data.some((t) => t.reviewOf === alone.id)).toBe(false);
    await api("PUT", "/api/settings/lead", { leadId: atlas.id });
    const second = (await api<any>("POST", "/api/tasks", { to: "lia", title: "Fix another typo", brief: "x", channelId: solo.channelId })).data;
    await api("PATCH", `/api/tasks/${second.id}`, { status: "done", result: "done" }, nodeToken, as(lia));
    expect((await reviewFor(solo.id, second.id)).toAgentId).toBe(atlas.id);
    // let the review runs finish before the hub shuts down
    await new Promise((r) => setTimeout(r, 300));
  });
});

describe("privacy", () => {
  let eve: string;
  let dm: any;
  beforeAll(async () => {
    await api("POST", "/api/members", { email: "eve@example.com", name: "Eve", password: "password123", role: "member" });
    eve = (await api("POST", "/api/auth/login", { email: "eve@example.com", password: "password123" }, "")).data.token;
    dm = (await api("POST", `/api/dm/${nova.id}`)).data;
  });

  it("never sends a DM, its run events or its reactions to someone else's socket", async () => {
    const mine = await clientSocket(token);
    const hers = await clientSocket(eve);
    const sent = (await api("POST", `/api/channels/${dm.id}/messages`, { body: "my secret plan" })).data;
    await waitFor(async () => (await api<{ messages: Message[] }>("GET", `/api/channels/${dm.id}/messages`)).data.messages.find((m) => m.author.id === nova.id && m.body.includes("secret plan")));
    await api("POST", `/api/messages/${sent.id}/reactions`, { emoji: "🔒" });
    // something she may see, so we know her socket works
    await api("POST", `/api/channels/${general}/messages`, { body: "hello everyone" });
    await waitFor(async () => hers.events.find((e) => e.type === "message" && e.message.body === "hello everyone"));
    await new Promise((r) => setTimeout(r, 100));
    mine.close();
    hers.close();

    const about = (events: any[]) => events.filter((e) => e.channelId === dm.id || e.message?.channelId === dm.id);
    expect(about(mine.events).map((e) => e.type)).toEqual(expect.arrayContaining(["message", "run_event", "reactions"]));
    expect(about(hers.events)).toEqual([]);
    expect(JSON.stringify(hers.events)).not.toContain("secret plan");
  });

  it("hides what was said in a DM from an agent's run list, and the DM's files, for people outside it", async () => {
    const mineRuns = (await api<any[]>("GET", `/api/agents/${nova.id}/runs`)).data;
    const hersRuns = (await api<any[]>("GET", `/api/agents/${nova.id}/runs`, undefined, eve)).data;
    const inDm = (runs: any[]) => runs.filter((r) => r.channelId === dm.id);
    expect(inDm(mineRuns)[0].trigger).toContain("my secret plan");
    expect(inDm(hersRuns).length).toBe(inDm(mineRuns).length);
    for (const r of inDm(hersRuns)) expect([r.trigger, r.channelName]).toEqual([null, null]);

    const res = await fetch(base + "/api/files", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-filename": "plan.txt", "x-mime-type": "text/plain", "x-channel-id": dm.id }, body: "the plan" });
    const file = await res.json();
    expect((await api<any[]>("GET", "/api/files")).data.some((f) => f.id === file.id)).toBe(true);
    expect((await api<any[]>("GET", "/api/files", undefined, eve)).data.some((f) => f.id === file.id)).toBe(false);
    expect((await api("GET", `/api/files?channel=${dm.id}`, undefined, eve)).status).toBe(404);
    expect((await api("GET", `/api/files/${file.id}`, undefined, eve)).status).toBe(404);
  });

  it("lets guests look but not give agents work, make channels or stop runs", async () => {
    await api("POST", "/api/members", { email: "peek@example.com", name: "Peek", password: "password123", role: "guest" });
    const g = (await api("POST", "/api/auth/login", { email: "peek@example.com", password: "password123" }, "")).data.token;
    expect((await api("GET", "/api/tasks", undefined, g)).status).toBe(200);
    expect((await api("POST", "/api/tasks", { to: "nova", title: "x", brief: "x" }, g)).status).toBe(403);
    expect((await api("POST", "/api/channels", { name: "guest-made" }, g)).status).toBe(403);
    const task = (await api<any[]>("GET", "/api/tasks")).data[0];
    expect((await api("PATCH", `/api/tasks/${task.id}`, { status: "done" }, g)).status).toBe(403);
    const run = (await api<any[]>("GET", `/api/agents/${nova.id}/runs`)).data[0];
    expect((await api("POST", `/api/runs/${run.id}/cancel`, undefined, g)).status).toBe(403);
    // a run that isn't in the workspace doesn't exist to it
    expect((await api("POST", "/api/runs/run_nope/cancel")).status).toBe(404);
    expect((await api("POST", `/api/runs/${run.id}/cancel`)).data).toEqual({ ok: false });
  });

  it("only lets the agent's device owner remove an agent on that device", async () => {
    const temp = (await api("POST", "/api/agents", { handle: "temp", name: "Temp", harness: "codex", nodeId: atlas.nodeId })).data;
    expect((await api("DELETE", `/api/agents/${temp.id}`, undefined, eve)).status).toBe(403);
    expect((await api("DELETE", `/api/agents/${temp.id}`)).status).toBe(200);
  });
});

describe("runs that go wrong", () => {
  it("fails the task a failed run was working on and tells whoever handed it out", async () => {
    const asAtlas = { "x-warren-agent": atlas.id };
    const before = node.runs.length;
    const task = (await api("POST", "/api/tasks", { to: "nova", title: "Crash test", brief: "please crash" }, nodeToken, asAtlas)).data;
    const failed = await waitFor(async () => (await api<any[]>("GET", "/api/tasks")).data.find((t) => t.id === task.id && t.status === "failed"));
    expect(failed.result).toContain("harness crashed");
    const thread = await channelMessagesIn(task.channelId, task.threadId);
    expect(thread.some((m) => m.parts.some((p) => p.type === "status" && p.text === "Run failed: harness crashed"))).toBe(true);
    const note = thread.find((m) => m.body.includes("Task **Crash test** failed"));
    expect(note?.body).toContain("@atlas");
    // which wakes atlas, who handed it out
    await waitFor(async () => node.runs.slice(before).find((r) => r.type === "run" && r.run.agentId === atlas.id && r.run.prompt.includes("Crash test")));
    // and not nova, whose failure it reports (an @mention of nova would start it again)
    expect(note?.body).not.toContain("@nova");
    expect(node.runs.slice(before).filter((r) => r.type === "run" && r.run.agentId === nova.id)).toHaveLength(1);
  });

  it("explains a harness that needs signing in, in the channel and on the agent's page", async () => {
    const ch = (await api("POST", "/api/channels", { name: "signin" })).data.id;
    await api("POST", `/api/channels/${ch}/messages`, { body: "@atlas expired token" });
    const status = await waitFor(async () => (await channelMessagesIn(ch)).flatMap((m) => m.parts).find((p) => p.type === "status" && p.text.startsWith("Run failed")));
    expect(status.type === "status" && status.text).toBe("Run failed: Claude Code on test-node needs to be signed in again. In a terminal there, run `claude (then /login)`; then ask again.");
    const runs = (await api<any[]>("GET", `/api/agents/${atlas.id}/runs`)).data;
    expect(runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("401"), hint: expect.stringContaining("needs to be signed in again") });
  });

  it("says so when a prompt can't even be built", async () => {
    const ch = (await api("POST", "/api/channels", { name: "no-prompt" })).data.id;
    const original = hub.buildPrompt;
    hub.buildPrompt = async () => {
      throw new Error("vault exploded");
    };
    try {
      await api("POST", `/api/channels/${ch}/messages`, { body: "@nova hi" });
      const status = await waitFor(async () => (await channelMessagesIn(ch)).flatMap((m) => m.parts).find((p) => p.type === "status" && p.text.startsWith("Run failed")));
      expect(status.type === "status" && status.text).toBe("Run failed: couldn't prepare the request: vault exploded");
      expect((await api<any[]>("GET", "/api/agents")).data.find((a) => a.id === nova.id).status).toBe("online");
    } finally {
      hub.buildPrompt = original;
    }
  });

  it("ignores a device's late run_done after the run was cancelled", async () => {
    const ch = (await api("POST", "/api/channels", { name: "late" })).data.id;
    const n = node.held.length;
    await api("POST", `/api/channels/${ch}/messages`, { body: "@nova hold on" });
    const runId = await waitFor(async () => node.held[n]);
    const client = await clientSocket(token);
    expect((await api("POST", `/api/runs/${runId}/cancel`)).data).toEqual({ ok: true });
    // the web clears its "writing…" preview on this, since the device's own report comes too late to count
    await waitFor(async () => client.events.find((e) => e.type === "agent_status" && e.agentId === nova.id && e.status === "online"));
    client.close();
    node.send({ type: "run_done", runId, finalText: "too late" });
    node.send({ type: "run_failed", runId, error: "also too late" });
    await new Promise((r) => setTimeout(r, 200));
    expect((await api<any[]>("GET", `/api/agents/${nova.id}/runs`)).data.find((r) => r.id === runId)).toMatchObject({ status: "cancelled" });
    const texts = (await channelMessagesIn(ch)).flatMap((m) => [m.body, ...m.parts.map((p) => ("text" in p ? p.text : ""))]);
    expect(texts.join("\n")).not.toMatch(/too late/);
    expect((await api<any[]>("GET", "/api/agents")).data.find((a) => a.id === nova.id).status).toBe("online");
  });

  it("answers a bad limit or file name with the usual default, not a 500", async () => {
    expect(limitParam("abc", 20, 100)).toBe(20);
    expect(limitParam("-3", 20, 100)).toBe(20);
    expect(limitParam("7.9", 20, 100)).toBe(7);
    expect(limitParam("999", 20, 100)).toBe(100);
    expect((await api("GET", `/api/channels/${general}/messages?limit=abc`)).status).toBe(200);
    expect((await api("GET", "/api/vault/search?q=plan&limit=abc")).status).toBe(200);
    expect((await api("GET", "/api/vault/changes?limit=NaN")).status).toBe(200);
    expect((await api("GET", `/api/agents/${nova.id}/runs?limit=`)).status).toBe(200);
    expect(fileName("%E0%A4%A")).toBe("%E0%A4%A");
    expect(fileName("a%2Fb%20c.txt")).toBe("a_b c.txt");
    expect(fileName(undefined)).toBe("file");
    const res = await fetch(base + "/api/files", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-filename": "%E0%A4%A" }, body: "odd name" });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("%E0%A4%A");
  });

  it("keeps an agent's finished tasks when it's removed, and fails the unfinished ones", async () => {
    const gone = (await api("POST", "/api/agents", { handle: "gone", name: "Gone", harness: "codex", nodeId: atlas.nodeId })).data;
    const done = (await api("POST", "/api/tasks", { to: "gone", title: "Finished work", brief: "done already" })).data;
    await api("PATCH", `/api/tasks/${done.id}`, { status: "done", result: "yes" });
    const open = (await api("POST", "/api/tasks", { to: "gone", title: "Unfinished work", brief: "not yet" })).data;
    await waitFor(async () => (await api<any[]>("GET", "/api/tasks")).data.find((t) => t.id === open.id && t.status !== "open"));
    expect((await api("DELETE", `/api/agents/${gone.id}`)).status).toBe(200);
    const tasks = (await api<any[]>("GET", "/api/tasks")).data;
    expect(tasks.find((t) => t.id === done.id)).toMatchObject({ status: "done", toAgentId: null, result: "yes" });
    expect(tasks.find((t) => t.id === open.id)).toMatchObject({ status: "failed", toAgentId: null, result: expect.stringContaining("removed") });
  });

  it("rebuilds the tasks table so finished tasks outlive their agent", async () => {
    const file = path.join(dir, "old-tasks.db");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','in_progress','done','failed')),
      result TEXT, channel_id TEXT, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    raw.prepare("INSERT INTO tasks (id, workspace_id, from_kind, from_id, to_agent_id, title, brief, status, created_at, updated_at) VALUES ('task_1', 'ws_1', 'user', 'u1', 'agt_a', 'Old', 'x', 'done', '2026-01-01', '2026-01-01')").run();
    raw.close();
    const db = openDb(file);
    const fk = (db.prepare("PRAGMA foreign_key_list(tasks)").all() as any[]).find((f) => f.from === "to_agent_id");
    expect(fk.on_delete).toBe("SET NULL");
    expect(db.prepare("SELECT id, to_agent_id, status FROM tasks").all()).toEqual([{ id: "task_1", to_agent_id: "agt_a", status: "done" }]);
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'Old', '2026-01-01')").run();
    db.prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, created_at) VALUES ('agt_a', 'ws_1', 'a', 'A', 'codex', '2026-01-01')").run();
    db.prepare("DELETE FROM agents WHERE id = 'agt_a'").run();
    expect(db.prepare("SELECT to_agent_id FROM tasks WHERE id = 'task_1'").get()).toEqual({ to_agent_id: null });
    db.close();
  });
});

describe("connector prerequisites", () => {
  it("warns when an agent's device doesn't have the command a connector needs", async () => {
    node.send({ type: "capabilities", capabilities: { platform: "darwin", arch: "arm64", screen: { ok: false, detail: "" }, vm: { ok: false, detail: "" }, commands: { uvx: false, npx: true } } });
    await waitFor(async () => (await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === atlas.nodeId && n.capabilities?.commands?.npx === true));
    const git = (await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Git", command: "uvx", args: ["mcp-server-git"], agentIds: [nova.id] })).data;
    expect(git.warnings).toEqual([`@nova's device test-node doesn't have "uvx", so Git won't start there until it's installed.`]);
    const fetchServer = (await api("POST", "/api/connectors", { kind: "mcp-stdio", name: "Fetch", command: "npx", args: ["-y", "fetch-mcp"], agentIds: [nova.id] })).data;
    expect(fetchServer.warnings).toEqual([]);
    expect((await api("DELETE", `/api/connectors/${git.id}/agents/${nova.id}`)).data.warnings).toEqual([]);
  });
});
