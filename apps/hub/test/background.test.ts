import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@warren/adapters";
import { WarrenClient } from "@warren/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { afterQuietHours, inQuietHours, parseWhen } from "../src/background.ts";
import type { Hub } from "../src/hub.ts";

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
let onCheck: (agent: WarrenClient, input: RunInput) => Promise<string> = async () => "nothing new";

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input) {
    calls.push(input);
    const agent = new WarrenClient({ url: input.mcp!.env.WARREN_URL, token: input.mcp!.env.WARREN_TOKEN });
    const finalText = input.prompt.includes("## Working in the background") ? await onCheck(agent, input) : "hi";
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
  const built = await buildHub({ dataDir: path.join(dir, "hub") });
  hub = built.hub;
  hub.push.send = async (sub, payload) => void pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload as string) });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123" }) })).json();
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

  it("writes first with message_person, and that reaches the person's devices by push", async () => {
    await owner.request("POST", "/api/push/subscribe", { endpoint: "https://push.example.com/abc", keys: { p256dh: "BNcR", auth: "tBHI" } });
    onCheck = async (agent, input) => {
      expect(input.prompt).toContain("Your note to yourself from last time: Inbox quiet");
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

describe("times", () => {
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
