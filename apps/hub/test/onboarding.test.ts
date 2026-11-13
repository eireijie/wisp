import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { memoryPrompt } from "@wisp/core/src/memory-import.ts";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let home: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let member: WispClient;
let hub: Hub;
let url: string;
let nodeId: string;
let me: string;
const calls: RunInput[] = [];
/** what the fake harness answers; throwing makes the run fail */
let onRun: (input: RunInput) => Promise<string> = async () => "Hi!";

const fake: HarnessAdapter = {
  id: "claude-code",
  label: "Fake",
  binary: "true",
  async catalog() {
    return { harness: "claude-code", version: "1.0.0", models: [{ id: "sonnet", label: "Sonnet" }], efforts: [] };
  },
  async run(input) {
    calls.push(input);
    return { finalText: await onRun(input), sessionId: null };
  },
};

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

const raw = async (method: string, p: string, body?: unknown, token?: string, type = "application/json") => {
  const res = await fetch(url + p, { method, headers: { ...(body !== undefined ? { "content-type": type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
};
let ownerToken: string;
const dmOf = (agentId: string) => hub.store.dmChannel(hub.store.agent(agentId)!.workspaceId, me, agentId);
const said = (agentId: string) => hub.store.messages(dmOf(agentId).id).filter((m) => m.body);
const make = async (handle: string, extra: Record<string, unknown> = {}) => (await owner.request<{ id: string }>("POST", "/api/agents", { handle, name: handle[0].toUpperCase() + handle.slice(1), harness: "claude-code", nodeId, ...extra })).id;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-onboarding-"));
  home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.push.send = async () => {};
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  ownerToken = setup.token;
  owner = new WispClient({ url, token: setup.token });
  await owner.request("POST", "/api/members", { email: "sam@example.com", name: "Sam", password: "password123", role: "member" });
  const login = await raw("POST", "/api/auth/login", { email: "sam@example.com", password: "password123" });
  member = new WispClient({ url, token: login.data.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeId = node.id;
  me = (hub.store.db.prepare("SELECT id FROM users WHERE email = 'me@example.com'").get() as { id: string }).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node"), discoverHome: home, harnessHome: path.join(dir, "harness-home"), noPrepare: true }, () => {}, { "claude-code": fake });
  daemon.start();
  await waitFor(async () => (await owner.request<{ id: string; online: boolean }[]>("GET", "/api/nodes")).find((n) => n.online));
  await waitFor(() => hub.store.nodeCatalog(nodeId).some((h) => h.harness === "claude-code") || undefined, 45_000);
}, 90_000);

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("memory import", () => {
  it("saves ticked lines as linked notes, one per heading and one per project, dropping secrets", async () => {
    const id = await make("ivy", { greet: "later" });
    const r = await owner.request<{ saved: number; notes: string[] }>("POST", `/api/agents/${id}/memory-import`, {
      lines: [
        { heading: "About me", text: "Name is Yug, works in Toronto" },
        { heading: "About me", text: "Likes short answers" },
        { heading: "About me", text: "my api key is sk-ant-abcdefghijklmnop1234" },
        { heading: "Projects", text: "Wisp: open-source agents app, lives in ~/kodi" },
        { heading: "Projects", text: "Garden - planting plan for spring" },
        { heading: "Preferences and rules", text: "Never push to main" },
      ],
    });
    expect(r.saved).toBe(5);
    const base = `agents/${id}/memories`;
    expect(r.notes.sort()).toEqual([`${base}/About me.md`, `${base}/Preferences and rules.md`, `${base}/Project - Garden.md`, `${base}/Project - Wisp.md`, `${base}/What I know about you.md`].sort());
    const vault = hub.vault(hub.store.agent(id)!.workspaceId);
    const about = (await vault.read(`${base}/About me.md`)).content;
    expect(about).toContain("# About me");
    expect(about).toContain("- Likes short answers");
    expect(about).not.toContain("sk-ant");
    expect((await vault.read(`${base}/Project - Wisp.md`)).content).toContain("# Project: Wisp");
    // every note hangs off the hub note, which links them all
    const edges = vault.graph().edges.map((e) => `${e.source} -> ${e.target}`);
    expect(edges).toContain(`${base}/Project - Wisp.md -> ${base}/What I know about you.md`);
    expect(edges).toContain(`${base}/What I know about you.md -> ${base}/Project - Garden.md`);
    // committed as the person
    expect((await vault.history(`${base}/About me.md`))[0].author).toMatch(/Me/);
    // a second import adds only what's new
    const again = await owner.request<{ saved: number }>("POST", `/api/agents/${id}/memory-import`, { lines: [{ heading: "About me", text: "Likes short answers" }, { heading: "About me", text: "Has a dog" }] });
    expect(again.saved).toBe(1);
  });

  it("is only for the agent's creator or an owner", async () => {
    const id = await make("jo", { greet: "later" });
    await expect(member.request("POST", `/api/agents/${id}/memory-import`, { lines: [{ heading: "About me", text: "x" }] })).rejects.toThrow();
    await expect(owner.request("POST", `/api/agents/${id}/memory-import`, { lines: Array.from({ length: 301 }, () => ({ heading: "About me", text: "x" })) })).rejects.toThrow();
  });
});

describe("a hello written from what it knows", () => {
  it("waits with greet: later, then the agent writes its own hello from its notes", async () => {
    const id = await make("kai", { greet: "later" });
    expect(said(id)).toHaveLength(0);
    await owner.request("POST", `/api/agents/${id}/memory-import`, { lines: [{ heading: "Projects", text: "Lighthouse: a boat-tracking site" }] });
    onRun = async () => "Hey, I'm Kai! I see you're building Lighthouse. Want to start there?";
    const before = calls.length;
    const r = await owner.request<{ status: string }>("POST", `/api/agents/${id}/greet`, {});
    expect(r.status).toBe("writing");
    const msgs = await waitFor(() => (said(id).length ? said(id) : undefined));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].author).toEqual({ kind: "agent", id });
    expect(msgs[0].body).toMatch(/Lighthouse/);
    const prompt = calls[before].prompt;
    expect(prompt).toContain("Lighthouse: a boat-tracking site");
    expect(prompt).toContain("2 to 3 short sentences");
    // Wisp's prompt never shows as a message
    expect(hub.store.messages(dmOf(id).id).every((m) => m.author.kind === "agent" || m.author.id === "system")).toBe(true);
    const setup = hub.store.agent(id)!.settings.setup!;
    expect(setup.greetingId).toBe(msgs[0].id);
    // once only
    expect((await owner.request<{ status: string }>("POST", `/api/agents/${id}/greet`, {})).status).toBe("already");
    expect(said(id)).toHaveLength(1);
  });

  it("falls back to Wisp's own hello when the run fails", async () => {
    const id = await make("lu", { greet: "later" });
    onRun = async () => {
      throw new Error("boom");
    };
    await owner.request("POST", `/api/agents/${id}/greet`, {});
    const msgs = await waitFor(() => (said(id).length ? said(id) : undefined));
    expect(msgs[0].body).toMatch(/^Hey, I'm Lu!/);
    expect(hub.store.messages(dmOf(id).id).some((m) => m.parts.some((p) => p.type === "status" && /Run failed/.test(p.text)))).toBe(false);
  });

  it("only its creator can ask, and other agents still say hello right away", async () => {
    const id = await make("mo", { greet: "later" });
    await expect(member.request("POST", `/api/agents/${id}/greet`, {})).rejects.toThrow();
    const other = await make("ned");
    expect(said(other)[0].body).toMatch(/^Hey, I'm Ned!/);
  });
});

describe("asking the AI on a device", () => {
  it("runs the harness once, read-only, in the home folder, with the memory prompt", async () => {
    onRun = async () => "## About me\n- Name is Yug";
    const before = calls.length;
    const { id } = await owner.request<{ id: string }>("POST", "/api/memory-prompt/ask", { nodeId, harness: "claude-code" });
    const done = await waitFor(async () => {
      const r = await owner.request<{ status: string; answer?: string }>("GET", `/api/memory-prompt/ask/${id}`);
      return r.status !== "running" ? r : undefined;
    });
    expect(done).toEqual({ status: "done", answer: "## About me\n- Name is Yug" });
    const input = calls[before];
    expect(input.access).toBe("read-only");
    expect(input.cwd).toBe(home);
    expect(input.ownMemory).toBe(true);
    expect(input.ownPlugins).toBe(false);
    expect(input.mcp).toBeUndefined();
    expect(input.prompt).toBe(memoryPrompt());
  });

  it("says plainly when it fails, and is only for the device's owner", async () => {
    onRun = async () => {
      throw new Error("Invalid API key · Please run /login");
    };
    const { id } = await owner.request<{ id: string }>("POST", "/api/memory-prompt/ask", { nodeId, harness: "claude-code" });
    const done = await waitFor(async () => {
      const r = await owner.request<{ status: string; error?: string }>("GET", `/api/memory-prompt/ask/${id}`);
      return r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Claude Code isn't signed in on box");
    await expect(owner.request("POST", "/api/memory-prompt/ask", { nodeId, harness: "codex" })).rejects.toThrow(/isn't installed on box/);
    await expect(member.request("POST", "/api/memory-prompt/ask", { nodeId, harness: "claude-code" })).rejects.toThrow();
    await expect(member.request("GET", `/api/memory-prompt/ask/${id}`)).rejects.toThrow();
  });
});

describe("one-time answer link", () => {
  it("takes one answer, then 410; the creator reads it", async () => {
    const link = await owner.request<{ id: string; url: string }>("POST", "/api/memory-links", {});
    expect(link.url).toMatch(/\/m\/[A-Za-z0-9_-]{32}$/);
    const p = new URL(link.url).pathname;
    expect((await owner.request("GET", `/api/memory-links/${link.id}`))).toEqual({ answer: null, expired: false });
    expect((await raw("POST", p, "## About me\n- Hi", undefined, "text/plain")).status).toBe(200);
    expect((await raw("POST", p, "again", undefined, "text/plain")).status).toBe(410);
    expect((await owner.request("GET", `/api/memory-links/${link.id}`))).toEqual({ answer: "## About me\n- Hi", expired: false });
    await expect(member.request("GET", `/api/memory-links/${link.id}`)).rejects.toThrow();
  });

  it("takes JSON too, and wrong codes look the same as used ones", async () => {
    const link = await owner.request<{ id: string; url: string }>("POST", "/api/memory-links", {});
    expect((await raw("POST", "/m/" + "A".repeat(32), { answer: "x" })).status).toBe(410);
    expect((await raw("POST", "/m/short", { answer: "x" })).status).toBe(410);
    expect((await raw("POST", new URL(link.url).pathname, { answer: "x".repeat(60_001) })).status).toBe(413);
    expect((await raw("POST", new URL(link.url).pathname, { answer: "from json" })).data).toEqual({ ok: true });
    expect((await owner.request<{ answer: string }>("GET", `/api/memory-links/${link.id}`)).answer).toBe("from json");
  });
});
