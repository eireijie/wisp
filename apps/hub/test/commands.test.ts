import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

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

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-commands-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", workspaceName: "Lab" }, "")).data.token;
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
  it("lists Wisp's own first, then the harness's", async () => {
    const { data } = await api<{ commands: any[] }>("GET", `/api/agents/${atlas.id}/commands`);
    expect(data.commands.map((c) => `${c.name}:${c.kind}`)).toEqual(["context:wisp", "model:wisp", "compress:command", "humanizer:skill"]);
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
});
