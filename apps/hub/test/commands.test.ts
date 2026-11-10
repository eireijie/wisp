import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { SUMMARY_REQUEST } from "@wisp/core";
import { makeRoomAs } from "./room.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let atlas: any;
let codexer: any;
let general: any;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** A plain chat room: the API only makes teams of two or more agents. */
const room = (body: Parameters<typeof makeRoomAs>[3], token = owner) => makeRoomAs(hub, base, token, body);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-commands-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", workspaceName: "Lab" }, "")).data.token;
  await room({ name: "general" });
  const node = (await api("POST", "/api/nodes", { name: "box" })).data.node;
  atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "hermes", nodeId: node.id })).data;
  general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
  const box2 = (await api("POST", "/api/nodes", { name: "box2" })).data.node;
  codexer = (await api("POST", "/api/agents", { handle: "codexer", name: "Codexer", harness: "codex", nodeId: box2.id, settings: { effort: "max" } })).data;
  hub.store.setNodeCatalog(box2.id, [
    {
      harness: "codex",
      version: "1",
      defaultModel: "gpt-6-astra",
      efforts: ["low", "medium", "high"],
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high"] },
      ],
    },
  ]);
  hub.store.setNodeCatalog(node.id, [
    {
      harness: "hermes",
      version: "1",
      models: [],
      efforts: [],
      commands: [
        { name: "compress", description: "Compress conversation context", kind: "command", via: "raw" },
        { name: "context", description: "Hermes's own", kind: "command", via: "raw" },
        { name: "humanizer", description: "Make text sound human", kind: "skill", via: "prompt" },
      ],
    },
  ]);
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

const post = async (body: string) => (await api("POST", `/api/channels/${general.id}/messages`, { body })).data;

describe("/ commands", () => {
  it("lists the harness's own, then Wisp's, keeping Wisp's names", async () => {
    const { data } = await api<{ commands: any[] }>("GET", `/api/agents/${atlas.id}/commands`);
    expect(data.commands.map((c) => `${c.name}:${c.kind}:${c.group}`)).toEqual(["compress:command:harness", "humanizer:skill:harness", "context:wisp:wisp", "compact:wisp:wisp", "new:wisp:wisp", "stop:wisp:wisp", "model:wisp:wisp", "effort:wisp:wisp", "harness:wisp:wisp"]);
  });

  it("puts skills agents learned first, with who learned them, and other Wisp skills last", async () => {
    const ws = atlas.workspaceId;
    const learned = hub.skills.create(ws, atlas.id, { name: "Humanizer", slug: "humanizer", description: "My own way", source: "learned", content: "1. Do it", learnedBy: atlas.id });
    hub.skills.attach(learned.id, atlas.id, true);
    const shared = hub.skills.create(ws, null, { name: "Notes", slug: "meeting-notes", description: "Take notes", source: "custom", content: "x", allAgents: true });
    const { data } = await api<{ commands: any[] }>("GET", `/api/agents/${atlas.id}/commands`);
    expect(data.commands.map((c) => `${c.name}:${c.group}`)).toEqual(["humanizer:learned", "compress:harness", "context:wisp", "compact:wisp", "new:wisp", "stop:wisp", "model:wisp", "effort:wisp", "harness:wisp", "meeting-notes:skill"]);
    expect(data.commands[0]).toMatchObject({ kind: "wisp-skill", via: "prompt", learnedBy: "Atlas", isNew: true });
    hub.skills.remove(learned.id);
    hub.skills.remove(shared.id);
  });

  it("passes a harness command through as typed, into the same conversation", async () => {
    const msg = await post("@atlas /compress keep the plan");
    expect(await hub.buildPrompt(atlas.id, general.id, null, msg.id)).toBe("/compress keep the plan");
  });

  it("turns a skill the harness can't run by name into a request to use it", async () => {
    const msg = await post("@atlas /humanizer this paragraph");
    const prompt = await hub.buildPrompt(atlas.id, general.id, null, msg.id);
    expect(prompt).toContain('Use your "humanizer" skill for this: this paragraph');
    expect(prompt).toContain("You are @atlas");
  });

  it("leaves a slash that isn't one of its commands alone", async () => {
    const msg = await post("@atlas /usr/bin is full");
    const prompt = await hub.buildPrompt(atlas.id, general.id, null, msg.id);
    expect(prompt).toContain("/usr/bin is full");
    expect(prompt).toContain("You are @atlas");
  });

  it("answers /context itself, without waking the agent", async () => {
    const msg = await post("@atlas /context");
    const reply = hub.store.messages(general.id, { limit: 20 }).find((m) => m.author.id === atlas.id && m.createdAt >= msg.createdAt && m.parts.some((p) => p.type === "context"));
    expect(reply?.parts).toEqual([{ type: "context", usage: null }]);
    expect(hub.store.messages(general.id, { limit: 20 }).some((m) => m.parts.some((p) => p.type === "status" && p.text.includes("queued")) && m.createdAt >= msg.createdAt)).toBe(false);
  });

  it("changes a Codex agent's model from the chat with /model, without waking it", async () => {
    const notes = () => hub.store.messages(general.id, { limit: 50 }).flatMap((m) => m.parts.flatMap((p) => (p.type === "status" ? [p.text] : [])));
    await post("@codexer /model");
    expect(notes().at(-1)).toContain("gpt-6-astra (the default)");
    // plain "gpt-6.1" or "sol 6.1" finds the one model it fits
    await post("@codexer /model sol 6.1");
    expect(hub.store.agent(codexer.id)?.model).toBe("gpt-6.1-sol");
    expect(notes().at(-1)).toContain("will use gpt-6.1-sol");
    expect(hub.store.agent(codexer.id)?.settings.effort).toBe("max");
    await post("@codexer /model gpt-6-astra");
    expect(hub.store.agent(codexer.id)).toMatchObject({ model: "gpt-6-astra", settings: { effort: null } });
    await post("@codexer /model nonsense");
    expect(hub.store.agent(codexer.id)?.model).toBe("gpt-6-astra");
    expect(notes().at(-1)).toContain("can't use");
    await post("@codexer /model default");
    expect(hub.store.agent(codexer.id)?.model).toBeNull();
    expect(hub.store.activeRuns(codexer.id)).toHaveLength(0);
  });
  it("drops an effort the harness's own default model doesn't offer when going back to default", async () => {
    hub.store.updateAgent(codexer.id, { model: "gpt-6.1-sol", settings: { effort: "max" } });
    expect(hub.store.agent(codexer.id)?.settings.effort).toBe("max");
    await post("@codexer /model default");
    expect(hub.store.agent(codexer.id)).toMatchObject({ model: null, settings: { effort: null } });
  });

  it("lets a guest ask which model an agent uses, but not change it", async () => {
    await api("POST", "/api/members", { email: "gus@example.com", name: "Gus", password: "password123", role: "guest" });
    const gus = (await api("POST", "/api/auth/login", { email: "gus@example.com", password: "password123" }, "")).data.token;
    const say = (body: string) => api("POST", `/api/channels/${general.id}/messages`, { body }, gus);
    const notes = () => hub.store.messages(general.id, { limit: 50 }).flatMap((m) => m.parts.flatMap((p) => (p.type === "status" ? [p.text] : [])));
    hub.store.updateAgent(codexer.id, { model: "gpt-6-astra", settings: { respondTo: "anyone" } });
    // on a device its owner shared with everyone, anyone may ask it things
    hub.store.db.prepare("UPDATE nodes SET shared = 1 WHERE id = ?").run(codexer.nodeId);
    expect((await say("@codexer /model gpt-6.1-sol")).status).toBe(200);
    expect(hub.store.agent(codexer.id)?.model).toBe("gpt-6-astra");
    expect(notes().at(-1)).toMatch(/Guests can't change/);
    await say("@codexer /model");
    expect(notes().at(-1)).toContain("gpt-6-astra");
    // a member still can
    await post("@codexer /model sol 6.1");
    expect(hub.store.agent(codexer.id)?.model).toBe("gpt-6.1-sol");
  });

  it("sends /compact to Hermes as its own /compress, and to Claude Code as /compact", async () => {
    const msg = await post("@atlas /compact keep the plan");
    expect(await hub.buildPrompt(atlas.id, general.id, null, msg.id)).toBe("/compress keep the plan");
    expect(hub.commandFor(atlas, "/compact")).toMatchObject({ via: "raw", name: "compress", compact: true });
    expect(hub.commandFor({ ...atlas, harness: "claude-code" }, "/compact")).toMatchObject({ via: "raw", name: "compact", compact: true });
  });

  it("asks a Codex agent for a summary on /compact, and starts the next chat with it", async () => {
    const msg = await post("@codexer /compact");
    expect(await hub.buildPrompt(codexer.id, general.id, null, msg.id)).toBe(SUMMARY_REQUEST);
    for (const r of hub.store.activeRuns(codexer.id)) hub.cancelRun(r.id);
  });

  it("starts a new chat on /new and says so", async () => {
    const before = await post("@atlas hello there");
    const msg = await post("@atlas /new");
    expect(hub.store.message(msg.id)?.conversationId).toBe(msg.id);
    expect(hub.store.message(msg.id)?.conversationId).not.toBe(hub.store.message(before.id)?.conversationId);
    const notes = hub.store.messages(general.id, { limit: 10 }).filter((m) => m.createdAt >= msg.createdAt).flatMap((m) => m.parts.flatMap((p) => (p.type === "status" ? [p.text] : [])));
    expect(notes.some((t) => t.startsWith("Started a new conversation"))).toBe(true);
    const next = await post("@atlas what now?");
    expect(hub.store.message(next.id)?.conversationId).toBe(msg.id);
  });

  it("stops what the agent is doing here on /stop", async () => {
    const msg = await post("@atlas do a long thing");
    const run = hub.store.activeRuns(atlas.id).find((r) => r.triggerMessageId === msg.id);
    expect(run).toBeTruthy();
    await post("@atlas /stop");
    expect(hub.store.run(run!.id)?.status).toBe("cancelled");
    const notes = hub.store.messages(general.id, { limit: 10 }).flatMap((m) => m.parts.flatMap((p) => (p.type === "status" ? [p.text] : [])));
    expect(notes.at(-1)).toContain("Stopped");
  });
});
