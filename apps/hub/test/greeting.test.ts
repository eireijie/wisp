import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { SETUP_REPLIES, greetNewAgent, recordSetupStep, setupNotePath } from "../src/greeting.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let url: string;
let nodeId: string;
let me: string;
const calls: RunInput[] = [];
/** what the fake harness does with a message; throwing makes the run fail */
let onReply: (agent: WispClient, input: RunInput) => Promise<string> = async () => "Got it. Next question?";

const fake: HarnessAdapter = {
  id: "claude-code",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    const agent = new WispClient({ url: input.mcp!.env.WISP_URL, token: input.mcp!.env.WISP_TOKEN });
    return { finalText: await onReply(agent, input), sessionId: `sess-${calls.length}` };
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

const idle = () => waitFor(() => !hub.store.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get() || undefined);
const dmOf = (agentId: string) => hub.store.dmChannel(hub.store.agent(agentId)!.workspaceId, me, agentId);
const said = (agentId: string) => hub.store.messages(dmOf(agentId).id).filter((m) => m.body);
const setupOf = (agentId: string) => hub.store.agent(agentId)!.settings.setup!;
const make = async (handle: string, extra: Record<string, unknown> = {}) => (await owner.request<{ id: string }>("POST", "/api/agents", { handle, name: handle[0].toUpperCase() + handle.slice(1), harness: "claude-code", nodeId, ...extra })).id;
/** Send a reply and wait for the agent's run on it, never mistaking the last run for this one. */
const answer = async (agentId: string, text: string) => {
  const before = calls.length;
  await owner.send(dmOf(agentId).id, text);
  await waitFor(() => calls.length > before || undefined);
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
  it("says hello in its own name in the DM without running the model", async () => {
    const before = calls.length;
    const id = await make("ada");
    const msgs = said(id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].author).toEqual({ kind: "agent", id });
    expect(msgs[0].body).toMatch(/^Hey, I'm Ada! What would you like me to do\?/);
    expect(calls.length).toBe(before);
    const chats = await owner.request<{ id: string }[]>("GET", "/api/channels");
    expect(chats.some((c) => c.id === dmOf(id).id)).toBe(true);
    // what the person says at setup stays between them and the agent
    const listed = (await owner.agents()).find((a) => a.id === id)!;
    expect(listed.settings).not.toHaveProperty("setup");
  });

  it("never says hello twice", async () => {
    const id = await make("bo");
    expect(greetNewAgent(hub, hub.store.agent(id)!, me)).toBeNull();
    expect(said(id)).toHaveLength(1);
  });

  it("lets the agent lead: narrow the goal, take a role, list accounts, then wrap up with what it learned kept", async () => {
    const id = await make("cy");
    onReply = async (agent, input) => {
      const msg = input.prompt.slice(input.prompt.lastIndexOf("New message from"));
      if (msg.includes("\nAds")) return "Managing ads, social media posts, or both?";
      if (msg.includes("\nBoth")) {
        await agent.setupStep({ step: "goal", summary: "Manage ads and social posts" });
        return "I can be your business manager. Sound good?";
      }
      if (msg.includes("\nYes")) {
        await agent.setupStep({ step: "role", role: "Business manager" });
        return "Which accounts do you have: Google, Meta, Instagram?";
      }
      if (msg.includes("\nGoogle Ads and Instagram")) {
        await agent.setupStep({ step: "accounts", accounts: ["Google Ads", "Instagram"] });
        await agent.setupStep({ step: "signins", summary: "no computer yet" });
        await agent.setupStep({ step: "checkins", summary: "skipped" });
        await agent.setupStep({ step: "boundaries", summary: "Never post without asking" });
        await agent.setupStep({ step: "style", summary: "Short", done: true });
        return "Thanks. I can draft this week's posts now.";
      }
      return "ok";
    };
    let prompt = await answer(id, "Ads");
    expect(prompt).toContain("## Getting to know Me");
    expect(prompt).toContain("Still to do, in this order:");
    expect(prompt).toContain("narrow it");
    expect(prompt).toContain("Offer the role that fits");
    // no computer: it says so and offers to get one, instead of trying to open sites
    expect(prompt).toContain("You don't have a computer");
    expect(prompt).toContain("Agents → you → Computer");
    // watches only after a yes
    expect(prompt).toContain("Only after they say yes to watching, in the reply to that yes, list the accounts in setup_step watch");
    expect(said(id).at(-1)!.body).toBe("Managing ads, social media posts, or both?");

    await answer(id, "Both");
    expect(setupOf(id).steps.goal).toBe("Manage ads and social posts");
    prompt = await answer(id, "Yes");
    expect(prompt).toContain("- What they want: Manage ads and social posts");
    expect(hub.store.agent(id)!.settings.role).toBe("Business manager");

    await answer(id, "Google Ads and Instagram");
    const s = setupOf(id);
    expect(s).toMatchObject({ done: true, accounts: ["Google Ads", "Instagram"], replies: ["Ads", "Both", "Yes", "Google Ads and Instagram"] });
    expect(said(id).at(-1)!.body).toBe("Thanks. I can draft this week's posts now.");

    const note = await waitFor(async () => {
      const n = await hub.vault(hub.store.agent(id)!.workspaceId).read(setupNotePath(id)).catch(() => null);
      return n?.content.includes("Never post") ? n.content : undefined;
    });
    expect(note).toContain("- **My role:** Business manager");
    expect(note).toContain("- **Accounts:** Google Ads, Instagram");
    expect(note).toContain("- Google Ads and Instagram");

    // after setup: no more steps, but what came out of it stays with the agent
    onReply = async () => "On it.";
    prompt = await answer(id, "Ok go");
    expect(prompt).not.toContain("## Getting to know");
    expect(prompt).toContain("## What Me told you when you met");
    expect(prompt).toContain("- Ask first: Never post without asking");
    expect(prompt).toContain("You are the workspace's Business manager.");
    // and the tool says so if it's called again
    const { token } = await owner.request<{ token: string }>("POST", `/api/agents/${id}/token`);
    await expect(new WispClient({ url, token }).setupStep({ step: "style", summary: "x" })).rejects.toThrow(/already over/);
  });

  it("checks sign-ins in its computer's browser, asking first and using only the password manager", async () => {
    const id = await make("dee");
    const comp = hub.store.createComputer({ workspaceId: hub.store.agent(id)!.workspaceId, name: "Dee's desk", kind: "vm", nodeId, config: { cpus: 2, memoryGb: 4 }, status: "ready" });
    hub.store.updateAgent(id, { computerId: comp.id });
    // the computer isn't real, so look at the prompt the reply would get instead of running it
    const msg = hub.postMessage({ channelId: dmOf(id).id, author: { kind: "user", id: me }, body: "Help with my store", route: false });
    const prompt = await hub.buildPrompt(id, dmOf(id).id, null, msg.id);
    hub.store.updateAgent(id, { computerId: null });
    expect(prompt).toContain("open each account's site in your computer's browser");
    expect(prompt).toContain("ask first; change nothing until they say yes");
    expect(prompt).toContain("Sign in only with login_fill");
    expect(prompt).toContain("Settings → Logins");
    expect(prompt).toContain("Never ask for a password in chat");
    expect(prompt).not.toContain("You don't have a computer");
  });

  it("starts watches for the accounts only in its reply to the person's yes", async () => {
    const id = await make("kit");
    const ws = hub.store.agent(id)!.workspaceId;
    const ads = { service: "browser" as const, label: "Google Ads", url: "https://ads.google.com", lookFor: "campaigns paused or over budget" };
    // not answering anyone (a background check, a stray call): refused
    const { token } = await owner.request<{ token: string }>("POST", `/api/agents/${id}/token`);
    await expect(new WispClient({ url, token }).setupStep({ watch: [ads] })).rejects.toThrow(/reply to their yes/);
    // answering another agent's message: refused too
    const bot = hub.postMessage({ channelId: dmOf(id).id, author: { kind: "agent", id }, body: "Want me to keep an eye on Google Ads?", route: false });
    expect(await recordSetupStep(hub, hub.store.agent(id)!, { watch: [ads] }, bot)).toEqual({ error: expect.stringMatching(/ask them first/) });
    expect(hub.watches.list(ws, { agentId: id })).toEqual([]);

    // a browser watch needs a computer: Wisp says why instead of pretending
    const yes = hub.postMessage({ channelId: dmOf(id).id, author: { kind: "user", id: me }, body: "Yes, watch them", route: false });
    let r = await recordSetupStep(hub, hub.store.agent(id)!, { watch: [ads] }, yes);
    expect(r).toMatchObject({ watched: [{ label: "Google Ads", watching: false, why: expect.stringMatching(/needs its own computer/) }] });

    // with one, the yes starts the watch, once
    hub.watches.stop();
    const comp = hub.store.createComputer({ workspaceId: ws, name: "Kit's desk", kind: "vm", nodeId, config: { cpus: 2, memoryGb: 4 }, status: "ready" });
    hub.store.updateAgent(id, { computerId: comp.id });
    r = await recordSetupStep(hub, hub.store.agent(id)!, { step: "checkins", summary: "Mornings", watch: [ads] }, yes);
    expect(r).toMatchObject({ watched: [{ label: "Google Ads", watching: true }] });
    await recordSetupStep(hub, hub.store.agent(id)!, { watch: [ads] }, yes);
    const all = hub.watches.list(ws, { agentId: id });
    hub.store.updateAgent(id, { computerId: null });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ service: "browser", userId: me, agentIds: [id], config: { url: "https://ads.google.com", lookFor: "campaigns paused or over budget" } });
    expect(setupOf(id).steps.checkins).toBe("Mornings; Watching Google Ads");
    for (const w of all) hub.watches.remove(w.id);
  });

  it("doesn't offer a role to an agent made for one", async () => {
    const id = await make("eli", { settings: { role: "Researcher" } });
    expect(setupOf(id).steps.role).toBe("Researcher");
    onReply = async () => "Which topics?";
    const prompt = await answer(id, "Competitors in the POS market");
    expect(prompt).toContain("as their Researcher");
    expect(prompt).not.toContain("Offer the role that fits");
  });

  it("doesn't carry on with the scripted questions when the model fails; Try again then works and clears the failure", async () => {
    const id = await make("fin");
    onReply = async () => {
      throw new Error("model overloaded");
    };
    await answer(id, "Plan my week");
    const dm = dmOf(id).id;
    const failure = () => hub.store.messages(dm).filter((m) => m.parts.some((p) => p.type === "run_failed"));
    await waitFor(() => (failure().length ? true : undefined));
    // no "Which accounts…" from Wisp on the agent's behalf, and the step isn't marked answered
    expect(said(id).map((m) => m.body)).not.toContain("Which accounts should I work with? For example Google, Meta or Instagram.");
    expect(setupOf(id).steps.goal).toBeUndefined();
    // Try again works: the old failure line and its button go away
    onReply = async () => "Got it.";
    const run = hub.store.messages(dm).flatMap((m) => m.parts).find((p) => p.type === "run_failed");
    const before = calls.length;
    await owner.request("POST", `/api/runs/${(run as { runId: string }).runId}/retry`);
    await waitFor(() => calls.length > before || undefined);
    await idle();
    await waitFor(() => (failure().length === 0 ? true : undefined));
    expect(said(id).at(-1)!.body).toBe("Got it.");
  });

  it("ends after a fixed number of the person's messages even if the agent never finishes it", async () => {
    const id = await make("gil");
    const s = setupOf(id);
    hub.store.updateAgent(id, { settings: { setup: { ...s, replies: Array.from({ length: SETUP_REPLIES }, (_, i) => `reply ${i}`) } } });
    onReply = async () => "ok";
    const prompt = await answer(id, "one more");
    expect(setupOf(id).done).toBe(true);
    expect(prompt).not.toContain("## Getting to know");
    expect(prompt).toContain('- "one more"');
  });

  it("keeps the setup in one chat across a quiet break", async () => {
    const id = await make("ike");
    const hello = said(id)[0];
    // the hello was three hours ago: long enough that a reply would normally start a fresh chat
    const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
    hub.store.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(earlier, hello.id);
    onReply = async () => "Got it. Which accounts?";
    const prompt = await answer(id, "Book my travel");
    const [, mine, reply] = said(id);
    expect(mine.conversationId).toBe(hello.conversationId);
    expect(reply.conversationId).toBe(hello.conversationId);
    expect(prompt).not.toContain("after a quiet break");
    expect(prompt).toContain("Hey, I'm Ike!");
    expect(prompt).toContain("## Getting to know Me");
  });

  it("asks for a sign-in first when Wisp knows the harness isn't signed in, with no error", async () => {
    const catalog = hub.store.nodeCatalog(nodeId);
    hub.store.db.prepare("UPDATE nodes SET catalog_json = ? WHERE id = ?").run(JSON.stringify([...catalog.filter((h) => h.harness !== "claude-code"), { ...(catalog.find((h) => h.harness === "claude-code") ?? { harness: "claude-code", models: [] }), accounts: { default: false } }]), nodeId);
    const id = await make("hal");
    const [hello] = said(id);
    expect(hello.body).toMatch(/^Hey, I'm Hal!/);
    expect(hello.body).toContain("needs to be signed in on box");
    expect(hello.body).toContain("Settings → Harnesses");
    expect(hello.parts).toEqual([]);
  });

  it("greets whoever its maker works for when an agent makes one", async () => {
    const lead = await make("ian");
    const mate = await make("jo");
    const node = (agentId: string, isLead = false, x = 0) => ({ agentId, lead: isLead, x, y: 0 });
    await owner.request("POST", "/api/channels", { name: "crew", settings: { team: { nodes: [node(lead, true), node(mate, false, 240)], edges: [{ from: lead, to: mate }] } } });
    await owner.request("PUT", "/api/settings/agents", { leadsCreateAgents: true });
    const { token } = await owner.request<{ token: string }>("POST", `/api/agents/${lead}/token`);
    const made = await new WispClient({ url, token }).request<{ id: string }>("POST", "/api/agents/spawn", { name: "Scout", role: "Researcher" });
    const [hello] = said(made.id);
    expect(hello.body).toMatch(/^Hey, I'm Scout!/);
    expect(setupOf(made.id).steps.role).toBe("Researcher");
  });

  it("leaves agents another app runs to speak for themselves", async () => {
    const id = await make("ivy", { harness: "grok", nodeId: null });
    expect(said(id)).toEqual([]);
  });
});
