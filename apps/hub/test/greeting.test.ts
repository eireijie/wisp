import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { setupNotePath, setupQuestions } from "../src/greeting.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let url: string;
let nodeId: string;
let me: string;
const calls: RunInput[] = [];
/** what the fake harness answers; throwing makes the run fail */
let onReply: (input: RunInput) => Promise<string> = async () => "Got it. Next question?";

const fake: HarnessAdapter = {
  id: "claude-code",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    return { finalText: await onReply(input), sessionId: `sess-${calls.length}` };
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
const dmOf = (agentId: string) => hub.store.dmChannel(hub.store.agent(agentId)!.workspaceId, me, agentId);
const said = (agentId: string) => hub.store.messages(dmOf(agentId).id).filter((m) => m.body);
const make = async (handle: string, extra: Record<string, unknown> = {}) => (await owner.request<{ id: string }>("POST", "/api/agents", { handle, name: handle[0].toUpperCase() + handle.slice(1), harness: "claude-code", nodeId, ...extra })).id;
const answer = async (agentId: string, text: string) => {
  await owner.send(dmOf(agentId).id, text);
  await idle();
  return calls.at(-1)!.prompt;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-greeting-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.push.send = async () => {};
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeId = node.id;
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { "claude-code": fake });
  daemon.start();
  await waitFor(async () => (await owner.request<{ id: string; online: boolean }[]>("GET", "/api/nodes")).find((n) => n.online));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a new agent speaks first", () => {
  it("says hello in its own name in the DM, without running the model, and asks the first question", async () => {
    const before = calls.length;
    const id = await make("ada");
    const msgs = said(id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].author).toEqual({ kind: "agent", id });
    expect(msgs[0].body).toMatch(/^Hey, I'm Ada! How can I help\? What do you need from me\?/);
    expect(msgs[0].body).toContain("What would you like help with first?");
    expect(calls.length).toBe(before);
    // the person sees it in their chat list
    const chats = await owner.request<{ id: string }[]>("GET", "/api/channels");
    expect(chats.some((c) => c.id === dmOf(id).id)).toBe(true);
  });

  it("never says hello twice", async () => {
    const id = await make("bo");
    const { greetNewAgent } = await import("../src/greeting.ts");
    expect(greetNewAgent(hub, hub.store.agent(id)!, me)).toBeNull();
    expect(said(id)).toHaveLength(1);
  });

  it("walks through the questions one at a time, keeps every answer, and wraps up with an offer", async () => {
    const id = await make("cy");
    const qs = setupQuestions("");
    let prompt = await answer(id, "Sort out my inbox before Friday");
    expect(prompt).toContain("## Getting to know Me");
    expect(prompt).toContain("Sort out my inbox before Friday");
    expect(prompt).toContain(qs[0].save);
    expect(prompt).toContain(`Ask next (your words): ${qs[1].ask}`);
    expect(prompt).toContain("Marketplace → Apps");

    prompt = await answer(id, "skip");
    expect(prompt).toContain("(skipped)");
    expect(prompt).not.toContain(qs[1].save);
    expect(prompt).toContain(qs[2].ask);

    prompt = await answer(id, "Mornings only, quiet after 9pm");
    expect(prompt).toContain("settings_change");
    prompt = await answer(id, "Never email anyone for me");
    expect(prompt).toContain("me/SOUL.md");
    prompt = await answer(id, "Short");
    expect(prompt).toContain("That was the last question");
    expect(prompt).toContain("concrete offer");
    expect(hub.store.agent(id)!.settings.setup).toMatchObject({ done: true, answers: ["Sort out my inbox before Friday", "skip", "Mornings only, quiet after 9pm", "Never email anyone for me", "Short"] });

    const note = await waitFor(async () => {
      const n = await hub.vault(hub.store.agent(id)!.workspaceId).read(setupNotePath(id)).catch(() => null);
      return n?.content.includes("Short") ? n.content : undefined;
    });
    expect(note).toContain("**Is there anything I should never do without asking you first?** Never email anyone for me");
    expect(note).toContain("_Skipped._");

    // after setup: no more questions, but what they said stays with the agent
    prompt = await answer(id, "Ok go");
    expect(prompt).not.toContain("## Getting to know");
    expect(prompt).toContain("## What Me told you when you met");
    expect(prompt).toContain("Never email anyone for me");
    expect(prompt).not.toContain("(skipped)");
  });

  it("asks the first question for its role", async () => {
    const id = await make("di", { settings: { role: "Researcher" } });
    expect(said(id)[0].body).toContain("What's the first thing you'd like me to take on?");
    const prompt = await answer(id, "Competitors in the POS market");
    expect(prompt).toContain("fitting your role (Researcher)");
  });

  it("keeps the chat going when the model fails", async () => {
    const id = await make("ed");
    onReply = async () => {
      throw new Error("model overloaded");
    };
    await answer(id, "Plan my week");
    onReply = async () => "Got it. Next question?";
    const last = said(id).at(-1)!;
    expect(last.author).toEqual({ kind: "agent", id });
    expect(last.body).toBe(setupQuestions("")[1].ask);
    expect(hub.store.agent(id)!.settings.setup!.answers).toEqual(["Plan my week"]);
  });

  it("asks for a sign-in first when Wisp knows the harness isn't signed in, with no error", async () => {
    const catalog = hub.store.nodeCatalog(nodeId);
    hub.store.db.prepare("UPDATE nodes SET catalog_json = ? WHERE id = ?").run(JSON.stringify([...catalog.filter((h) => h.harness !== "claude-code"), { ...(catalog.find((h) => h.harness === "claude-code") ?? { harness: "claude-code", models: [] }), accounts: { default: false } }]), nodeId);
    const id = await make("fay");
    const [hello] = said(id);
    expect(hello.body).toMatch(/^Hey, I'm Fay!/);
    expect(hello.body).toContain("needs to be signed in on box");
    expect(hello.body).toContain("Settings → Harnesses");
    expect(hello.parts).toEqual([]);
  });

  it("greets whoever its maker works for when an agent makes one, asking for its role", async () => {
    const lead = await make("hal");
    const node = (agentId: string, isLead = false) => ({ agentId, lead: isLead, x: 0, y: 0 });
    await owner.request("POST", "/api/channels", { name: "crew", settings: { team: { nodes: [node(lead, true)], edges: [] } } });
    await owner.request("PUT", "/api/settings/agents", { leadsCreateAgents: true });
    const { token } = await owner.request<{ token: string }>("POST", `/api/agents/${lead}/token`);
    const made = await new WispClient({ url, token }).request<{ id: string }>("POST", "/api/agents/spawn", { name: "Scout", role: "Researcher" });
    const [hello] = said(made.id);
    expect(hello.body).toMatch(/^Hey, I'm Scout!/);
    expect(hello.body).toContain("What's the first thing you'd like me to take on?");
  });

  it("leaves agents another app runs to speak for themselves", async () => {
    const id = await make("ivy", { harness: "grok", nodeId: null });
    expect(said(id)).toEqual([]);
  });
});
