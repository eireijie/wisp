import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@warren/adapters";
import type { AgentEvent } from "@warren/core";
import { WarrenClient } from "@warren/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { afterQuietHours, inQuietHours, parseWhen, startOfDay } from "../src/background.ts";
import type { Hub } from "../src/hub.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WarrenClient;
let hub: Hub;
let agentId: string;
let me: string;
const calls: RunInput[] = [];
const pushed: { endpoint: string; payload: any }[] = [];
/** what the fake harness does on a background check */
let reportUsage: Extract<AgentEvent, { type: "usage" }> | null = null;
let onCheck: (agent: WarrenClient, input: RunInput) => Promise<string> = async () => "nothing new";

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    const agent = new WarrenClient({ url: input.mcp!.env.WARREN_URL, token: input.mcp!.env.WARREN_TOKEN });
    const finalText = input.prompt.includes("## Working in the background") ? await onCheck(agent, input) : "hi";
    if (reportUsage && input.prompt.includes("## Working in the background")) onEvent(reportUsage);
    return { finalText, sessionId: `sess-${calls.length}` };
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

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-background-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.push.send = async (sub, payload) => void pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload as string) });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WarrenClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentId = (await owner.request("POST", "/api/agents", { handle: "dot", name: "Dot", harness: "custom", nodeId: node.id })).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("background work", () => {
  it("checks right away when turned on, quietly, in its own session, and keeps its note", async () => {
    await owner.send(dm().id, "hello");
    await waitFor(() => hub.store.messages(dm().id).find((m) => m.body === "hi"));
    await idle();
    const before = hub.store.messages(dm().id).length;
    onCheck = async (agent) => {
      await agent.nextCheck(45, "waiting on Sam");
      return "Inbox quiet; essay due Friday.";
    };
    await owner.request("PUT", `/api/agents/${agentId}/background`, { enabled: true });
    const b = await waitFor(() => {
      const x = hub.store.background(agentId, me);
      return x?.lastNote ? x : undefined;
    });
    const check = calls.at(-1)!;
    expect(check.prompt).toContain("## Working in the background");
    expect(check.prompt).not.toContain("New message from");
    // a fresh session, not the DM's
    expect(check.sessionId).toBeNull();
    expect(b.lastNote).toBe("Inbox quiet; essay due Friday.");
    expect(b.nextReason).toBe("waiting on Sam");
    const inMinutes = (new Date(b.nextAt!).getTime() - Date.now()) / 60_000;
    expect(inMinutes).toBeGreaterThan(43);
    expect(inMinutes).toBeLessThan(46);
    // nothing was posted
    expect(hub.store.messages(dm().id).length).toBe(before);
    await idle();
  });

  it("names everything it can look at, what the person cares about, and its watch notes", async () => {
    const ws = hub.store.agent(agentId)!.workspaceId;
    const notion = hub.connectors.create(ws, me, { kind: "mcp-http", name: "Notion", catalogId: "notion", url: "https://mcp.notion.com/mcp", headers: {}, env: {} });
    hub.connectors.attach(notion.id, agentId, true);
    await hub.vaults.primary.write("Projects/launch.md", "# Launch", { name: "t", email: "t@example.com" }, "add");
    await hub.vaults.primary.write(`agents/${agentId}/background/${me}.md`, "Notion: last saw page 'Q4 plan' edited 9am", { name: "t", email: "t@example.com" }, "add");
    await owner.request("PUT", `/api/agents/${agentId}/background`, { focus: "the launch project and anything from my landlord" });
    const sources = (await owner.request("GET", `/api/agents/${agentId}/background`)).sources;
    expect(sources.map((x: { kind: string; name: string }) => `${x.kind}:${x.name}`)).toEqual(expect.arrayContaining(["app:Notion", "memory:shared/"]));
    let prompt = "";
    onCheck = async (_agent, input) => {
      prompt = input.prompt;
      return "checked Notion";
    };
    await owner.request("POST", `/api/agents/${agentId}/background/check`);
    await waitFor(() => prompt || undefined);
    expect(prompt).toContain("- Notion (connected app:");
    expect(prompt).toContain("asked you to keep an eye on: the launch project and anything from my landlord");
    expect(prompt).toContain(`me/background/${me}.md`);
    expect(prompt).toContain("Notion: last saw page 'Q4 plan' edited 9am");
    expect(prompt).not.toContain("You aren't connected to any apps yet");
    await idle();
  });

  it("writes first with message_person, and that reaches the person's devices by push", async () => {
    await owner.request("POST", "/api/push/subscribe", { endpoint: "https://push.example.com/abc", keys: { p256dh: "BNcR", auth: "tBHI" } });
    onCheck = async (agent, input) => {
      expect(input.prompt).toContain("Your note to yourself from last time: checked Notion");
      await agent.messagePerson("Your essay is due tomorrow at noon.");
      return "told them about the essay";
    };
    await owner.request("POST", `/api/agents/${agentId}/background/check`);
    const msg = await waitFor(() => hub.store.messages(dm().id).find((m) => m.body === "Your essay is due tomorrow at noon."));
    expect(msg.author).toEqual({ kind: "agent", id: agentId });
    await waitFor(() => pushed.length || undefined);
    expect(pushed[0].endpoint).toBe("https://push.example.com/abc");
    expect(pushed[0].payload).toMatchObject({ title: "Dot", body: "Your essay is due tomorrow at noon.", url: `/#/c/${dm().id}` });
    await idle();
  });

  it("wakes for a follow-up the agent set, with its note, once", async () => {
    onCheck = async () => "ok";
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    const f = await agent.setFollowup({ inMinutes: 90, note: "remind them about the essay" });
    expect(hub.store.pendingFollowups(agentId).map((x) => x.id)).toContain(f.id);
    const n = calls.length;
    hub.background.tick(new Date(Date.now() + 91 * 60_000));
    await waitFor(() => calls.length > n || undefined);
    expect(calls.at(-1)!.prompt).toContain("remind them about the essay");
    expect(hub.store.followup(f.id)!.status).toBe("done");
    await idle();
  });

  it("doesn't count, list or date a check until its device starts it, and drops one that's turned off while waiting", async () => {
    // a started check shows in Runs under a readable name
    const runs = await owner.request("GET", `/api/agents/${agentId}/runs?limit=50`);
    expect(runs.some((r: { trigger: string | null; status: string }) => r.trigger === "Background check · Dot" && r.status === "done")).toBe(true);
    expect(runs.some((r: { trigger: string | null }) => r.trigger === null)).toBe(false);

    // an agent whose device isn't connected
    const { node } = await owner.request("POST", "/api/nodes", { name: "laptop" });
    const sleepyId = (await owner.request("POST", "/api/agents", { handle: "ivy", name: "Ivy", harness: "custom", nodeId: node.id })).id;
    await owner.request("PUT", `/api/agents/${sleepyId}/background`, { enabled: true });
    const state = await owner.request("GET", `/api/agents/${sleepyId}/background`);
    // the check is waiting, but it hasn't happened yet
    expect(state.background.checking).toBe(true);
    expect(state.background.lastAt).toBeNull();
    expect(state.usage.checksToday).toBe(0);
    expect(await owner.request("GET", `/api/agents/${sleepyId}/runs`)).toEqual([]);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'queued'").get(sleepyId)).toEqual({ n: 1 });

    // turned off before the device ever took it: as if it never was
    await owner.request("PUT", `/api/agents/${sleepyId}/background`, { enabled: false });
    const off = await owner.request("GET", `/api/agents/${sleepyId}/background`);
    expect(off.background.checking).toBe(false);
    expect(off.background.lastAt).toBeNull();
    expect(off.usage.checksToday).toBe(0);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?").get(sleepyId)).toEqual({ n: 0 });
  });

  it("waits out quiet hours instead of checking", () => {
    const b = hub.store.setBackground(agentId, me, { quietStart: "00:00", quietEnd: "23:59", nextAt: null });
    const n = calls.length;
    hub.background.tick(new Date("2026-10-14T12:00:00Z"));
    expect(calls.length).toBe(n);
    expect(hub.store.background(agentId, me)!.nextReason).toBe("after quiet hours");
    expect(b.quietStart).toBe("00:00");
    hub.store.setBackground(agentId, me, { enabled: false, quietStart: "22:00", quietEnd: "07:00" });
  });

  it("shows agents the draft behind an approval card, and the answer", async () => {
    const approval = hub.store.createApproval({ workspaceId: hub.store.agent(agentId)!.workspaceId, agentId, channelId: dm().id, threadId: null, summary: "Reply to Sam", details: "Hi Sam, Friday works." });
    const m = hub.postMessage({ channelId: dm().id, author: { kind: "agent", id: agentId }, body: "Can I go ahead? Reply to Sam", parts: [{ type: "approval", approvalId: approval.id }], route: false });
    expect(hub.historyLine(m)).toBe("Can I go ahead? Reply to Sam\nHi Sam, Friday works.\n(not answered yet)");
  });
});

describe("web push preferences", () => {
  it("stores optional boolean preferences and filters each subscription by the message category", async () => {
    const workspaceId = hub.store.agent(agentId)!.workspaceId;
    const endpoint = "https://push.example.com/quiet";
    const keys = { p256dh: "BNcR", auth: "tBHI" };
    const prefs = { dms: false, replies: false, approvals: false, help: false, tasks: false };
    expect(hub.store.pushSubscriptions(me)[0].prefs).toEqual({});
    await expect(owner.request("POST", "/api/push/subscribe", { endpoint, keys, prefs: { dms: "no" } })).rejects.toThrow();
    await owner.request("POST", "/api/push/subscribe", { endpoint, keys, prefs });
    expect(hub.store.pushSubscriptions(me).find((s) => s.endpoint === endpoint)?.prefs).toEqual(prefs);
    const note = { title: "Warren", body: "Hello" };
    const sentTo = () => pushed.splice(0).map((p) => p.endpoint).sort();
    pushed.length = 0;
    try {
      for (const category of ["dm", "reply", "approval"] as const) {
        expect(await hub.push.notify(workspaceId, [me], note, category)).toBe(1);
        expect(sentTo()).toEqual(["https://push.example.com/abc"]);
      }
      expect(await hub.push.notify(workspaceId, [me], note, "channel")).toBe(2);
      expect(sentTo()).toEqual(["https://push.example.com/abc", endpoint].sort());
      expect(await owner.request("POST", "/api/push/test")).toEqual({ sent: 2 });
      expect(sentTo()).toEqual(["https://push.example.com/abc", endpoint].sort());

      // Re-subscribing updates this device's preferences, including partial and omitted prefs.
      await owner.request("POST", "/api/push/subscribe", { endpoint, keys, prefs: { dms: true } });
      expect(await hub.push.notify(workspaceId, [me], note, "reply")).toBe(2);
      sentTo();
      await owner.request("POST", "/api/push/subscribe", { endpoint, keys });
      expect(hub.store.pushSubscriptions(me).find((s) => s.endpoint === endpoint)?.prefs).toEqual({});
    } finally {
      hub.store.deletePushSubscription(endpoint);
    }
  });

  it("classifies approvals before DMs and replies, and notify-all recipients as channel messages", () => {
    const workspaceId = hub.store.agent(agentId)!.workspaceId;
    const general = hub.store.channelByName(workspaceId, "general")!;
    const watcher = hub.store.createUser("watcher@example.com", "Watcher", "");
    hub.store.addMember(workspaceId, watcher.id, "member");
    hub.store.addChannelMember(general.id, { kind: "user", id: watcher.id });
    hub.store.setChannelPrefs(watcher.id, general.id, { notify: "all" });
    const keys = { p256dh: "BNcR", auth: "tBHI" };
    const quiet = "https://push.example.com/quiet";
    const watching = "https://push.example.com/watching";
    hub.store.savePushSubscription(me, quiet, keys, { dms: false, replies: false, approvals: true });
    hub.store.savePushSubscription(watcher.id, watching, keys, { replies: false, approvals: false });
    const send = (channel: ReturnType<typeof dm>, approval = false) => {
      const msg = hub.store.insertMessage({ channelId: channel.id, author: { kind: "agent", id: agentId }, body: "An update", parts: approval ? [{ type: "approval", approvalId: "apv_test" }] : [] });
      pushed.length = 0;
      hub.push.onMessage(msg, channel, me);
      return pushed.map((p) => p.endpoint).sort();
    };
    try {
      expect(send(dm())).toEqual(["https://push.example.com/abc"]);
      expect(send(dm(), true)).toEqual(["https://push.example.com/abc", quiet].sort());
      expect(send(general)).toEqual(["https://push.example.com/abc", watching].sort());
      expect(send(general, true)).toEqual(["https://push.example.com/abc", quiet].sort());
    } finally {
      hub.store.deletePushSubscription(quiet);
      hub.store.deletePushSubscription(watching);
      hub.store.setChannelPrefs(watcher.id, general.id, { notify: "default" });
    }
  });

  it("migrates existing subscriptions with allowed preferences by default", () => {
    const file = path.join(dir, "old-push.sqlite");
    let db = openDb(file);
    try {
      const store = new Store(db);
      const user = store.createUser("old@example.com", "Old", "");
      store.savePushSubscription(user.id, "https://push.example.com/old", { p256dh: "key", auth: "auth" });
      db.exec("ALTER TABLE push_subscriptions DROP COLUMN prefs_json");
      db.close();
      db = openDb(file);
      expect(new Store(db).pushSubscriptions(user.id)).toEqual([{ endpoint: "https://push.example.com/old", keys: { p256dh: "key", auth: "auth" }, prefs: {} }]);
      db.close();
      db = openDb(file);
      expect(new Store(db).pushSubscriptions(user.id)[0].prefs).toEqual({});
    } finally {
      db.close();
    }
  });
});

describe("what a check costs", () => {
  const settle = async (run: () => string | null) => {
    const n = calls.length;
    expect(run()).toBeTruthy();
    await waitFor(() => calls.length > n || undefined);
    await idle();
    return calls.at(-1)!;
  };
  const wake = () => hub.background.wake(agentId, me);

  it("starts every check in a new session and leaves the conversation's alone", async () => {
    onCheck = async () => "ok";
    await owner.send(dm().id, "what's up?");
    await waitFor(() => calls.filter((c) => !c.prompt.includes("## Working in the background")).length > 1 || undefined);
    await idle();
    const dmRun = [...calls].reverse().find((c) => !c.prompt.includes("## Working in the background"))!;
    const dmSession = `sess-${calls.indexOf(dmRun) + 1}`;
    const first = await settle(wake);
    const second = await settle(wake);
    expect(first.sessionId).toBeNull();
    expect(second.sessionId).toBeNull();
    // the next message in the DM carries on from where the DM was, not from a check
    await owner.send(dm().id, "thanks");
    const n = calls.length;
    await waitFor(() => calls.length > n || undefined);
    expect(calls.at(-1)!.prompt).not.toContain("## Working in the background");
    expect(calls.at(-1)!.sessionId).toBe(dmSession);
    await idle();
  });

  it("runs checks on the model picked for them, and everything else on the agent's own", async () => {
    onCheck = async () => "ok";
    await owner.request("PUT", `/api/agents/${agentId}/background`, { model: "haiku", effort: "low" });
    expect((await owner.request("GET", `/api/agents/${agentId}/background`)).background).toMatchObject({ model: "haiku", effort: "low" });
    const check = await settle(wake);
    expect(check.model).toBe("haiku");
    expect(check.effort).toBe("low");
    expect(check.fast).toBe(false);
    await owner.send(dm().id, "and now?");
    const n = calls.length;
    await waitFor(() => calls.length > n || undefined);
    expect(calls.at(-1)!.model ?? null).toBeNull();
    await idle();
    // blank = the agent's own again
    await owner.request("PUT", `/api/agents/${agentId}/background`, { model: "", effort: null });
    expect((await settle(wake)).model ?? null).toBeNull();
  });

  it("records the tokens a check used and totals them for the day and week", async () => {
    onCheck = async () => "ok";
    reportUsage = { type: "usage", model: "haiku", contextUsed: 9000, contextWindow: 200000, inputTokens: 30_000, outputTokens: 8_000, cachedInputTokens: 25_000 };
    await settle(wake);
    const { usage } = await owner.request("GET", `/api/agents/${agentId}/background`);
    expect(usage.lastTokens).toBe(38_000);
    expect(usage.todayTokens).toBeGreaterThanOrEqual(38_000);
    expect(usage.weekTokens).toBeGreaterThanOrEqual(usage.todayTokens);
    // the context-window numbers still land beside the token counts
    const run = hub.store.db.prepare("SELECT usage_json FROM runs WHERE kind = 'background' ORDER BY created_at DESC LIMIT 1").get() as { usage_json: string };
    expect(JSON.parse(run.usage_json)).toMatchObject({ contextUsed: 9000, contextWindow: 200000, inputTokens: 30_000 });
    // a harness that reports no tokens leaves the last check unknown, not zero
    reportUsage = { type: "usage", model: "haiku", contextUsed: 500 };
    await settle(wake);
    expect((await owner.request("GET", `/api/agents/${agentId}/background`)).usage.lastTokens).toBeNull();
    reportUsage = null;
  });

  it("holds regular checks once the day's are used up, but still does follow-ups", async () => {
    onCheck = async () => "ok";
    const today = hub.store.backgroundRuns(agentId, me, startOfDay(new Date(), "UTC").toISOString()).length;
    hub.store.setBackground(agentId, me, { enabled: true, quietStart: "00:00", quietEnd: "00:00", nextAt: null, nextReason: "", dailyCap: today });
    const n = calls.length;
    hub.background.tick(new Date());
    expect(calls.length).toBe(n);
    const held = hub.store.background(agentId, me)!;
    expect(held.nextReason).toBe("daily limit reached");
    expect(held.nextAt).toBe(startOfDay(new Date(), "UTC", 1).toISOString());
    expect((await owner.request("GET", `/api/agents/${agentId}/background`)).usage).toMatchObject({ capReached: true, checksToday: today });

    // raising the limit lets the waiting check go
    await owner.request("PUT", `/api/agents/${agentId}/background`, { dailyCap: today + 10 });
    expect(hub.store.background(agentId, me)!.nextAt).toBeNull();
    hub.background.tick(new Date());
    await waitFor(() => calls.length > n || undefined);
    await idle();

    // a follow-up the agent set is not a regular check, so it runs with the limit reached
    hub.store.setBackground(agentId, me, { dailyCap: hub.store.backgroundRuns(agentId, me, startOfDay(new Date(), "UTC").toISOString()).length });
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    await agent.setFollowup({ inMinutes: 20, note: "tell Sam the essay is due" });
    const m = calls.length;
    hub.background.tick(new Date(Date.now() + 21 * 60_000));
    await waitFor(() => calls.length > m || undefined);
    expect(calls.at(-1)!.prompt).toContain("tell Sam the essay is due");
    await idle();

    // no limit at all
    await owner.request("PUT", `/api/agents/${agentId}/background`, { dailyCap: null });
    expect(hub.store.background(agentId, me)!.dailyCap).toBeNull();
    expect((await owner.request("GET", `/api/agents/${agentId}/background`)).usage.capReached).toBe(false);
    hub.store.setBackground(agentId, me, { enabled: false, quietStart: "22:00", quietEnd: "07:00" });
  });
});

describe("one allowance for all background work", () => {
  it("adds up every agent's checks today, guessing for ones that didn't report", async () => {
    const ws = hub.store.agent(agentId)!.workspaceId;
    const a = await owner.request("GET", "/api/background/allowance");
    expect(a.dailyTokens).toBe(1_000_000);
    expect(a.todayTokens).toBeGreaterThan(0);
    expect(a.estimated).toBe(true);
    expect(a.agents[0]).toMatchObject({ agentId });
    expect(a.todayTokens).toBe(hub.background.allowance(ws, me).todayTokens);
  });

  it("holds regular checks once it's used up, and lets them go when it's raised", async () => {
    onCheck = async () => "ok";
    const used = (await owner.request("GET", "/api/background/allowance")).todayTokens;
    await owner.request("PUT", "/api/background/allowance", { dailyTokens: Math.max(10_000, used) });
    hub.store.setBackground(agentId, me, { enabled: true, quietStart: "00:00", quietEnd: "00:00", nextAt: null, nextReason: "", dailyCap: null });
    const n = calls.length;
    hub.background.tick(new Date());
    expect(calls.length).toBe(n);
    expect(hub.store.background(agentId, me)!.nextReason).toBe("allowance used up");

    await owner.request("PUT", "/api/background/allowance", { dailyTokens: null });
    expect((await owner.request("GET", "/api/background/allowance")).dailyTokens).toBeNull();
    expect(hub.store.background(agentId, me)!.nextAt).toBeNull();
    hub.store.setBackground(agentId, me, { enabled: false, quietStart: "22:00", quietEnd: "07:00" });
  });

  it("checks half as often once most of it is used", async () => {
    const used = (await owner.request("GET", "/api/background/allowance")).todayTokens;
    // used is 90% of this amount
    await owner.request("PUT", "/api/background/allowance", { dailyTokens: Math.max(10_000, Math.round(used / 0.9)) });
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    hub.store.setBackground(agentId, me, { enabled: true });
    const r = await agent.nextCheck(30, "calm");
    expect(r.minutes).toBe(60);
    await owner.request("PUT", "/api/background/allowance", { dailyTokens: null });
    hub.store.setBackground(agentId, me, { enabled: false });
  });
});

describe("agents changing Warren for their person", () => {
  it("changes its own background work, shows what changed in the DM, and the person can undo it", async () => {
    hub.store.setBackground(agentId, me, { enabled: false, everyMinutes: 30, quietStart: "23:00", quietEnd: "07:00" });
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    expect((await agent.mySettings()).background).toMatchObject({ enabled: false, everyMinutes: 30 });
    const r = await agent.changeSettings({ background: { everyMinutes: 120, quietStart: "22:00" } });
    expect(r.changed).toEqual(["Checks: every 30 min → every 2 hours", "Quiet hours: 10pm – 7am"]);
    expect(hub.store.background(agentId, me)).toMatchObject({ everyMinutes: 120, quietStart: "22:00" });
    const card = hub.store.messages(dm().id).find((m) => m.parts.some((p) => p.type === "change" && p.changeId === r.changeId));
    expect(card?.body).toBe("Checks: every 30 min → every 2 hours\nQuiet hours: 10pm – 7am");

    const list = await owner.request("GET", "/api/changes");
    expect(list[0]).toMatchObject({ id: r.changeId, agentId, lines: r.changed, undoneAt: null });
    expect(list[0].undo).toBeUndefined();
    await owner.request("POST", `/api/changes/${r.changeId}/undo`);
    expect(hub.store.background(agentId, me)).toMatchObject({ everyMinutes: 30, quietStart: "23:00" });
    expect((await owner.request("GET", "/api/changes"))[0].undoneAt).not.toBeNull();
    await expect(owner.request("POST", `/api/changes/${r.changeId}/undo`)).rejects.toThrow();
    // undo leaves alone what was changed again since
    const again = await agent.changeSettings({ background: { everyMinutes: 240 } });
    hub.store.setBackground(agentId, me, { everyMinutes: 60 });
    await owner.request("POST", `/api/changes/${again.changeId}/undo`);
    expect(hub.store.background(agentId, me)!.everyMinutes).toBe(60);
    hub.store.setBackground(agentId, me, { everyMinutes: 30 });
    // asking for what's already set changes nothing
    expect((await agent.changeSettings({ background: { everyMinutes: 30 } })).changed).toEqual([]);
  });

  it("keeps background work off when changing it for someone who never turned it on", async () => {
    const saved = hub.store.background(agentId, me)!;
    hub.store.db.prepare("DELETE FROM background WHERE agent_id = ? AND user_id = ?").run(agentId, me);
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    const r = await agent.changeSettings({ background: { everyMinutes: 120 } });
    expect(hub.store.background(agentId, me)).toMatchObject({ enabled: false, everyMinutes: 120 });
    expect(r.changed).toEqual(["Checks: every 2 hours"]);
    hub.store.setBackground(agentId, me, { enabled: saved.enabled, everyMinutes: saved.everyMinutes });
  });

  it("turns mods on and off for an owner, and back", async () => {
    const agent = new WarrenClient({ url: calls[0].mcp!.env.WARREN_URL, token: calls[0].mcp!.env.WARREN_TOKEN });
    const s = await agent.mySettings();
    expect(s.canChangeMods).toBe(true);
    expect(s.mods.find((m) => m.key === "voice")?.on).toBe(true);
    const r = await agent.changeSettings({ mods: { voice: false } });
    expect(r.changed).toEqual(["Mod Voice calls: off"]);
    expect((await owner.request("GET", "/api/features")).features.voice).toBe(false);
    await owner.request("POST", `/api/changes/${r.changeId}/undo`);
    expect((await owner.request("GET", "/api/features")).features.voice).toBe(true);
  });
});

describe("stopped requests in background checks", () => {
  it.each(["queued", "running"] as const)("does not reconsider a request or task whose %s run was stopped", async (status) => {
    const agent = await owner.request("POST", "/api/agents", { handle: `stopped-${status}`, name: "Stopped", harness: "custom" });
    const channel = hub.store.dmChannel(agent.workspaceId, me, agent.id);
    const message = await owner.send(channel.id, "Write the cancelled announcement");
    const task = await owner.request("POST", "/api/tasks", { to: agent.handle, title: "Cancelled task title", brief: "Cancelled task brief" });
    const runs = hub.store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND status = 'queued'").all(agent.id) as { id: string }[];
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      if (status === "running") hub.store.setRunStatus(r.id, "running");
      await owner.request("POST", `/api/runs/${r.id}/cancel`);
      expect(hub.store.run(r.id)?.status).toBe("cancelled");
    }
    expect(hub.store.message(message.id)?.body).toBe("Write the cancelled announcement");
    expect(hub.store.task(task.id)?.status).toBe("open");
    const prompt = await hub.background.promptSection({ id: "check", agentId: agent.id, channelId: channel.id, requestedBy: me });
    expect(prompt).not.toContain("Write the cancelled announcement");
    expect(prompt).not.toContain("Cancelled task title");
    expect(prompt).not.toContain("Cancelled task brief");
    expect(prompt).toContain("Don't retry it, hand it to another agent, or do it yourself");
    await owner.send(channel.id, "A new request I still want answered");
    const next = await hub.background.promptSection({ id: "check", agentId: agent.id, channelId: channel.id, requestedBy: me });
    expect(next).toContain("A new request I still want answered");
    expect(next).not.toContain("Write the cancelled announcement");
  });
});

describe("times", () => {
  it("finds the start of the day on the person's clock", () => {
    expect(startOfDay(new Date("2026-10-15T03:00:00Z"), "America/New_York").toISOString()).toBe("2026-10-14T04:00:00.000Z");
    expect(startOfDay(new Date("2026-10-15T03:00:00Z"), "America/New_York", 1).toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(startOfDay(new Date("2026-10-15T12:00:00Z"), "UTC", 1).toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });


  it("reads a follow-up time on the person's clock", () => {
    expect(parseWhen("2026-10-15 08:00", "America/New_York")!.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(parseWhen("2026-01-15T08:30", "America/New_York")!.toISOString()).toBe("2026-01-15T13:30:00.000Z");
    expect(parseWhen("2026-10-15T08:00:00-07:00", "America/New_York")!.toISOString()).toBe("2026-10-15T15:00:00.000Z");
    expect(parseWhen("tomorrow", "UTC")).toBeNull();
  });

  it("knows quiet hours that wrap past midnight", () => {
    expect(inQuietHours(new Date("2026-10-15T03:00:00Z"), "UTC", "22:00", "07:00")).toBe(true);
    expect(inQuietHours(new Date("2026-10-15T12:00:00Z"), "UTC", "22:00", "07:00")).toBe(false);
    expect(afterQuietHours(new Date("2026-10-15T03:00:00Z"), "UTC", "22:00", "07:00").toISOString()).toBe("2026-10-15T07:00:00.000Z");
  });
});
