import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import type { CommandOption, MessagePart } from "@wisp/core";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { holdsSecret } from "../src/connectors.ts";
import { openDb } from "../src/db.ts";
import type { Hub } from "../src/hub.ts";

// vault writes go through git, which is slow when the whole suite runs at once
vi.setConfig({ testTimeout: 20_000 });

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let agentId: string;
let otherId: string;
let me: string;
/** what the fake harness does when someone writes to it */
let onReply: (agent: WispClient, input: RunInput) => Promise<string> = async () => "hi";
/** the "/" list the fake harness reports at the start of a run, if any */
let reports: CommandOption[] | null = null;

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    if (reports) onEvent({ type: "commands", commands: reports });
    const env = input.mcp!.env;
    const agent = new WispClient({ url: env.WISP_URL, token: env.WISP_TOKEN, runId: env.WISP_RUN });
    return { finalText: await onReply(agent, input), sessionId: null };
  },
};

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

const idle = () => waitFor(() => !hub.store.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get() || undefined);
const dm = () => hub.store.dmChannel(hub.store.agent(agentId)!.workspaceId, me, agentId);
const replyTo = async (text: string) => {
  const sent = await owner.send(dm().id, text);
  await idle();
  return hub.store.messages(dm().id).filter((m) => m.author.kind === "agent" && m.createdAt >= sent.createdAt).at(-1)!;
};
const skillParts = (m: { parts: MessagePart[] }) => m.parts.filter((p) => p.type === "skill");
const fileOf = (agent: string, slug: string) => hub.vaults.primary.read(`agents/${agent}/skills/${slug}/SKILL.md`).then((n) => n.content, () => null);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-learned-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.push.send = async () => {};
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentId = (await owner.request("POST", "/api/agents", { handle: "ghosty", name: "Ghosty", harness: "custom", nodeId: node.id })).id;
  otherId = (await owner.request("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom" })).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the skills table", () => {
  it("is rebuilt to allow learned skills, keeping skills and who has them", async () => {
    const file = path.join(dir, "old.db");
    let db = openDb(file);
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'Lab', 'now')").run();
    db.prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, created_at) VALUES ('a1', 'ws', 'a', 'A', 'custom', 'now')").run();
    // the table as it first shipped: no 'learned', none of the new columns
    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TABLE skills; CREATE TABLE skills (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('catalog','custom','taught')), catalog_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, slug)
    )`);
    db.pragma("foreign_keys = ON");
    db.prepare("INSERT INTO skills (id, workspace_id, name, slug, source, content, created_at, updated_at) VALUES ('s1', 'ws', 'Pdf', 'pdf', 'custom', 'x', 'now', 'now')").run();
    db.prepare("INSERT INTO agent_skills (agent_id, skill_id) VALUES ('a1', 's1')").run();
    expect(() => db.prepare("INSERT INTO skills (id, workspace_id, name, slug, source, content, created_at, updated_at) VALUES ('s2', 'ws', 'B', 'b', 'learned', 'x', 'now', 'now')").run()).toThrow();
    db.close();

    db = openDb(file);
    expect(db.prepare("SELECT id, slug, all_agents, uses, learned_by FROM skills").all()).toEqual([{ id: "s1", slug: "pdf", all_agents: 0, uses: 0, learned_by: null }]);
    expect(db.prepare("SELECT * FROM agent_skills").all()).toEqual([{ agent_id: "a1", skill_id: "s1" }]);
    db.prepare("INSERT INTO skills (id, workspace_id, name, slug, source, content, created_at, updated_at, learned_by) VALUES ('s2', 'ws', 'B', 'b', 'learned', 'x', 'now', 'now', 'a1')").run();
    // agent_skills still points at the new table
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("DELETE FROM skills WHERE id = 's1'").run();
    expect(db.prepare("SELECT * FROM agent_skills").all()).toEqual([]);
    db.close();
    // opening again leaves it alone
    db = openDb(file);
    expect(db.prepare("SELECT id FROM skills").all()).toEqual([{ id: "s2" }]);
    db.close();
  });
});

describe("all agents", () => {
  it("gives a skill to every agent, including ones made later, and takes the files back when switched off", async () => {
    const s = await owner.request("POST", "/api/skills", { name: "Meeting notes", content: "1. Listen", allAgents: true });
    expect(s).toMatchObject({ allAgents: true, agentIds: [], learnedBy: null, uses: 0, lastUsedAt: null });
    expect(await fileOf(agentId, s.slug)).toContain("1. Listen");
    expect(await fileOf(otherId, s.slug)).toContain("1. Listen");
    expect(hub.skills.forAgent(otherId).map((x) => x.id)).toContain(s.id);

    // an agent made later has it in its prompt, and its file appears with its first prompt
    const later = (await owner.request("POST", "/api/agents", { handle: "late", name: "Late", harness: "custom" })).id;
    expect(await fileOf(later, s.slug)).toBeNull();
    const general = (await owner.request<any[]>("GET", "/api/channels")).find((c) => c.name === "general");
    const msg = await owner.send(general.id, "hello");
    expect(await hub.buildPrompt(later, general.id, null, msg.id)).toContain(`me/skills/${s.slug}/SKILL.md`);
    expect(await fileOf(later, s.slug)).toContain("1. Listen");

    // switched off: only the agents given it keep it
    await owner.request("PATCH", `/api/skills/${s.id}`, { allAgents: false, agentIds: [agentId] });
    expect(await fileOf(agentId, s.slug)).toContain("1. Listen");
    expect(await fileOf(otherId, s.slug)).toBeNull();
    expect(await fileOf(later, s.slug)).toBeNull();
    expect(hub.skills.forAgent(otherId).map((x) => x.id)).not.toContain(s.id);
    await owner.request("DELETE", `/api/skills/${s.id}`);
  });

  it("gives a connector to every agent", async () => {
    const conn = await owner.request("POST", "/api/connectors", { kind: "secret", name: "Weather", env: { WEATHER_KEY: "abc123" }, allAgents: true });
    expect(conn).toMatchObject({ allAgents: true, agentIds: [] });
    expect(hub.connectors.specsFor(otherId).map((x) => x.name)).toEqual(["weather"]);
    expect((await owner.request("PATCH", `/api/connectors/${conn.id}`, { allAgents: false })).allAgents).toBe(false);
    expect(hub.connectors.specsFor(otherId)).toEqual([]);
    await owner.request("DELETE", `/api/connectors/${conn.id}`);
  });
});

describe("learning skills", () => {
  let agent: WispClient;
  beforeAll(async () => {
    const { token } = await owner.request("POST", `/api/agents/${agentId}/token`, {});
    agent = new WispClient({ url: owner.url, token });
  });

  it("spots secrets", () => {
    expect(holdsSecret("use sk-abcdefghijklmnop1234 for the API")).toBe(true);
    expect(holdsSecret("token ghp_abcdefghijklmnopqrstuvwxyz12")).toBe(true);
    expect(holdsSecret("Card: 4242 4242 4242 4242")).toBe(true);
    expect(holdsSecret("1. Log in\n- password: hunter2")).toBe(true);
    expect(holdsSecret("1. Order #1234567890123 is not a card\n2. Ask for the password if it's needed")).toBe(false);
  });

  it("is for agents only, turns down secrets, and updates a skill it learned before", async () => {
    await expect(owner.request("POST", "/api/skills/learn", { name: "x", content: "y" })).rejects.toMatchObject({ status: 403 });
    await expect(agent.saveSkill({ name: "Pay rent", content: "1. Enter card 4242 4242 4242 4242" })).rejects.toMatchObject({ status: 400, message: "Skills can't hold passwords, keys or card numbers" });

    const { skill } = await agent.saveSkill({ name: "Order pizza", description: "The usual from Tony's", content: "1. Open tonys.com\n2. Large margherita" });
    expect(skill).toMatchObject({ slug: "order-pizza", source: "learned", learnedBy: agentId, agentIds: [agentId], allAgents: false, createdBy: agentId });
    expect(await fileOf(agentId, "order-pizza")).toContain("Large margherita");

    // the same name again changes that skill, not a new one
    const again = (await agent.saveSkill({ name: "Order pizza", description: "The usual", content: "1. Open tonys.com\n2. Large pepperoni" })).skill;
    expect(again.id).toBe(skill.id);
    expect(again.content).toContain("pepperoni");
    expect(await fileOf(agentId, "order-pizza")).toContain("pepperoni");
    // by slug too
    expect((await agent.saveSkill({ name: "Pizza order", slug: "order-pizza", content: "1. Call Tony" })).skill.id).toBe(skill.id);

    // a skill someone else made with that name isn't overwritten
    const other = await owner.request("POST", "/api/skills", { name: "Book flight", content: "1. Ask" });
    const mine = (await agent.saveSkill({ name: "Book flight", content: "1. Use the airline site" })).skill;
    expect(mine.id).not.toBe(other.id);
    expect(mine.slug).toBe("book-flight-2");

    // owners can turn learning off
    await owner.request("PUT", "/api/settings/agents", { learnSkills: false });
    await expect(agent.saveSkill({ name: "Nope", content: "1. x" })).rejects.toMatchObject({ status: 403, message: "Learning skills is off in Settings → Skills" });
    await owner.request("PUT", "/api/settings/agents", { learnSkills: true });
    for (const s of [skill, other, mine]) await owner.request("DELETE", `/api/skills/${s.id}`);
  });

  it("counts reading a skill during a run and shows what it learned and used under the reply", async () => {
    const shared = await owner.request("POST", "/api/skills", { name: "Weekly report", content: "1. Gather", agentIds: [agentId] });
    onReply = async (a) => {
      await a.readNote(`agents/${agentId}/skills/${shared.slug}/SKILL.md`);
      await a.readNote(`agents/${agentId}/skills/${shared.slug}/SKILL.md`);
      // the built-in memory skill isn't counted
      await a.readNote(`agents/${agentId}/skills/memory/SKILL.md`);
      await a.saveSkill({ name: "Send report", content: "1. Email it" });
      return "Done.";
    };
    const reply = await replyTo("send the weekly report");
    const learned = hub.skills.bySlug(hub.store.agent(agentId)!.workspaceId, "send-report")!;
    expect(skillParts(reply)).toEqual([
      { type: "skill", action: "learned", skillId: learned.id, slug: "send-report" },
      { type: "skill", action: "used", skillId: shared.id, slug: shared.slug },
    ]);
    expect(hub.skills.get(shared.id)).toMatchObject({ uses: 1 });
    expect(hub.skills.get(shared.id)!.lastUsedAt).toBeTruthy();

    // a read outside a run isn't counted
    const { token } = await owner.request("POST", `/api/agents/${agentId}/token`, {});
    await new WispClient({ url: owner.url, token }).readNote(`agents/${agentId}/skills/${shared.slug}/SKILL.md`);
    expect(hub.skills.get(shared.id)!.uses).toBe(1);

    // a run that reads nothing has no skill lines
    onReply = async () => "hi";
    expect(skillParts(await replyTo("hello"))).toEqual([]);
    onReply = async () => "hi";
  });
});

describe("built-in skills", () => {
  it("lists the harnesses' own skills and commands where the workspace's agents run", async () => {
    const node = hub.store.agent(agentId)!.nodeId!;
    hub.store.setNodeCatalog(node, [
      {
        harness: "custom",
        version: "1",
        models: [],
        efforts: [],
        commands: [
          { name: "compact", description: "Summarize this chat", kind: "command", via: "raw", builtIn: true },
          { name: "mine", kind: "command", via: "raw" },
          { name: "skill-creator", description: "Make skills", kind: "skill", via: "prompt", builtIn: true },
        ],
      },
    ]);
    const { skills } = await owner.request("GET", "/api/skills/built-in");
    expect(skills).toEqual([
      { name: "compact", description: "Summarize this chat", harness: "custom", harnessLabel: expect.any(String), agentIds: [agentId] },
      { name: "skill-creator", description: "Make skills", harness: "custom", harnessLabel: expect.any(String), agentIds: [agentId] },
    ]);
  });
});

describe("a harness's own list from its runs", () => {
  it("replaces the device's listing for that harness, and is sent again only when it changes", async () => {
    const node = hub.store.agent(agentId)!.nodeId!;
    let sent = 0;
    const set = hub.store.setNodeCatalog.bind(hub.store);
    hub.store.setNodeCatalog = (id, catalog) => {
      sent++;
      return set(id, catalog);
    };
    // the fake adapter has no catalog of its own here, so seed what the device would list
    (daemon as any).catalog = Promise.resolve([{ harness: "custom", version: "1", models: [], efforts: [], commands: [{ name: "compact", kind: "command", via: "raw", builtIn: true }] }]);
    reports = [
      { name: "compact", description: "Summarize this chat to free up space", kind: "command", via: "raw", builtIn: true },
      { name: "simplify", kind: "skill", via: "raw" },
    ];
    await replyTo("hi");
    await waitFor(() => hub.store.nodeCatalog(node).find((c) => c.harness === "custom")?.commands?.some((c) => c.name === "simplify"));
    expect(sent).toBe(1);
    // the same list again isn't sent again
    await replyTo("hi again");
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toBe(1);
    const { commands } = await owner.request("GET", `/api/agents/${agentId}/commands`);
    expect(commands.filter((c: any) => c.group === "harness").map((c: any) => c.name)).toEqual(["compact", "simplify"]);
    reports = null;
    hub.store.setNodeCatalog = set;
  });
});
