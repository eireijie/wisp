import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import type { MessagePart } from "@wisp/core";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { makeRoomFor } from "./room.ts";
import type { Hub } from "../src/hub.ts";
import { FIRST_CHECKBACK_MINUTES, LAST_CHECKBACK_MINUTES } from "../src/loops.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let agentId: string;
let me: string;
const calls: RunInput[] = [];
/** what the fake harness does when someone writes to it, and on a background check */
let onReply: (agent: WispClient, input: RunInput) => Promise<string> = async () => "hi";
let onCheck: (agent: WispClient, input: RunInput) => Promise<string> = async () => "nothing new";

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    const agent = new WispClient({ url: input.mcp!.env.WISP_URL, token: input.mcp!.env.WISP_TOKEN });
    const finalText = input.prompt.includes("## Working in the background") ? await onCheck(agent, input) : await onReply(agent, input);
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
const replyTo = async (text: string) => {
  const sent = await owner.send(dm().id, text);
  await idle();
  return hub.store.messages(dm().id).filter((m) => m.author.kind === "agent" && m.createdAt >= sent.createdAt).at(-1)!;
};
const partsOf = <T extends MessagePart["type"]>(m: { parts: MessagePart[] }, type: T) => m.parts.filter((p): p is Extract<MessagePart, { type: T }> => p.type === type);
const pendingCheckbacks = () => hub.store.pendingFollowups(agentId).filter((f) => f.kind === "checkback");

/** A plain chat room: the API only makes teams of two or more agents. */
const room = async (body: Parameters<typeof makeRoomFor>[2]) => (await makeRoomFor(hub, owner, body)).data;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-loops-"));
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
  // UTC with no quiet hours in the way of check-back times
  hub.store.db.prepare("UPDATE users SET timezone = 'UTC'").run();
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

describe("promises under a reply", () => {
  it("tells the agent how to keep track in a DM", async () => {
    onReply = async () => "hi";
    await replyTo("hello");
    expect(calls.at(-1)!.prompt).toContain("## Keeping track");
    expect(calls.at(-1)!.prompt).toContain("chat_status");
  });

  it("shows a follow-up set while answering under that answer, and keeps it current", async () => {
    onReply = async (agent) => {
      await agent.setFollowup({ inMinutes: 20, note: "see if the iPhone build passed", label: "Check the build" });
      await agent.setFollowup({ inMinutes: 200, note: "remind them to send Sam the deck", label: "Nudge you about the deck", waitingOn: "person", condition: "only if it hasn't gone out" });
      return "Still running. I'll look again when it finishes.";
    };
    const reply = await replyTo("Is the build done? Also I'll send Sam the deck tonight");
    const pills = partsOf(reply, "followup");
    expect(pills.map((p) => [p.label, p.waitingOn, p.status])).toEqual([
      ["Check the build", "agent", "pending"],
      ["Nudge you about the deck", "person", "pending"],
    ]);
    const build = hub.store.followup(pills[0].followupId)!;
    expect(build.messageId).toBe(reply.id);
    expect(build.channelId).toBe(dm().id);
    // the chat list shows what the agent will be back with, not the person's own promise
    const chats = await owner.request<{ id: string; next: { label: string } | null }[]>("GET", "/api/channels");
    expect(chats.find((c) => c.id === dm().id)!.next).toMatchObject({ label: "Check the build" });

    // the person moves it, then says it's done
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    await owner.request("PATCH", `/api/followups/${build.id}`, { dueAt: later });
    expect(partsOf(hub.store.message(reply.id)!, "followup")[0].dueAt).toBe(later);
    await owner.request("PATCH", `/api/followups/${build.id}`, { status: "done" });
    expect(partsOf(hub.store.message(reply.id)!, "followup")[0].status).toBe("done");
    await expect(owner.request("PATCH", `/api/followups/${build.id}`, { status: "cancelled" })).rejects.toThrow("already happened");
  });

  it("lists what's tracked for the person", async () => {
    const bg = await owner.request<{ followups: { label: string | null }[]; checkback: boolean }>("GET", `/api/agents/${agentId}/background`);
    expect(bg.followups.map((f) => f.label)).toContain("Nudge you about the deck");
    expect(bg.checkback).toBe(true);
    // once the build check is done, nothing of the agent's is left to show in the chat list
    const chats = await owner.request<{ id: string; next: { label: string } | null }[]>("GET", "/api/channels");
    expect(chats.find((c) => c.id === dm().id)!.next).toBeNull();
  });

  it("describes the person's own promise when it comes due", async () => {
    onCheck = async () => "ok";
    const n = calls.length;
    hub.background.tick(new Date(Date.now() + 4 * 3600_000));
    await waitFor(() => calls.length > n || undefined);
    expect(calls.at(-1)!.prompt).toContain("Me said they'd do this: Nudge you about the deck");
    expect(calls.at(-1)!.prompt).toContain("Only if it hasn't gone out");
    await idle();
    const pill = hub.store.messages(dm().id).flatMap((m) => partsOf(m, "followup")).find((p) => p.label === "Nudge you about the deck")!;
    expect(pill.status).toBe("done");
  });
});

describe("open loops", () => {
  it("checks back when the person goes quiet, with quick replies, then lets it go", async () => {
    onReply = async (agent) => {
      await agent.chatStatus({ status: "waiting", summary: "pick a venue for the offsite" });
      return "Want the lake house or the city loft?";
    };
    await replyTo("help me plan the offsite");
    expect(hub.store.chatLoop(dm().id)).toMatchObject({ status: "waiting", summary: "pick a venue for the offsite", nudges: 0 });
    const first = pendingCheckbacks();
    expect(first).toHaveLength(1);
    const minutes = (new Date(first[0].dueAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(FIRST_CHECKBACK_MINUTES - 2);
    let chats = await owner.request<{ id: string; loop: { status: string; summary: string } | null }[]>("GET", "/api/channels");
    expect(chats.find((c) => c.id === dm().id)!.loop).toEqual({ status: "waiting", summary: "pick a venue for the offsite" });

    // the first check-back asks again
    onCheck = async (agent, input) => {
      expect(input.prompt).toContain(`Check back on "pick a venue for the offsite"`);
      await agent.messagePerson("Still want to pick a venue? I narrowed it to two.", [], ["Lake house", "City loft", "Later"]);
      return "asked again";
    };
    let n = calls.length;
    hub.background.tick(new Date(first[0].dueAt));
    await waitFor(() => calls.length > n || undefined);
    await idle();
    const ask = hub.store.messages(dm().id).at(-1)!;
    expect(partsOf(ask, "checkback")).toEqual([{ type: "checkback", replies: ["Lake house", "City loft", "Later"] }]);
    expect(hub.store.chatLoop(dm().id)!.nudges).toBe(1);
    const second = pendingCheckbacks();
    expect(second).toHaveLength(1);
    // a day after the first one fired (the test's clock is the real one)
    expect(new Date(second[0].dueAt).getTime() - Date.now()).toBeGreaterThan((LAST_CHECKBACK_MINUTES - 5) * 60_000);

    // the second drops it, and the chat shows it closed
    onCheck = async (agent, input) => {
      expect(input.prompt).toContain("went unanswered");
      await agent.messagePerson("No answer, so I'll drop the venue for now. Say the word and I'll pick it back up.");
      return "dropped it";
    };
    n = calls.length;
    hub.background.tick(new Date(second[0].dueAt));
    await waitFor(() => calls.length > n || undefined);
    await idle();
    const drop = hub.store.messages(dm().id).at(-1)!;
    // the goodbye isn't another check-back: no label, no quick replies, no Reply on the phone
    expect(drop.parts.map((p) => p.type)).toEqual(["closed"]);
    expect(hub.store.chatLoop(dm().id)!.status).toBe("closed");
    expect(pendingCheckbacks()).toHaveLength(0);
    chats = await owner.request("GET", "/api/channels");
    expect(chats.find((c) => c.id === dm().id)!.loop).toMatchObject({ status: "closed" });
  });

  it("keeps the check-back that's coming when the agent says it's still waiting, and starts over after a close", async () => {
    onReply = async (agent) => {
      await agent.chatStatus({ status: "waiting", summary: "choose a caterer" });
      return "Which caterer?";
    };
    await replyTo("we need food for the offsite");
    const [first] = pendingCheckbacks();
    // woken again by something else, it says the same thing: the check-back stays put
    const run = hub.store.createRun({ agentId, channelId: dm().id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: me });
    hub.store.setRunStatus(run, "running");
    hub.loops.setStatus(hub.store.run(run)!, { status: "waiting", summary: "choose a caterer" });
    expect(pendingCheckbacks().map((f) => f.id)).toEqual([first.id]);
    // after it was dropped, a new "waiting" counts from zero and gets a check-back again
    hub.store.setChatLoop({ channelId: dm().id, agentId, userId: me, status: "closed", nudges: 2 });
    hub.loops.setStatus(hub.store.run(run)!, { status: "waiting", summary: "choose a caterer" });
    expect(hub.store.chatLoop(dm().id)).toMatchObject({ status: "waiting", nudges: 0 });
    expect(pendingCheckbacks()).toHaveLength(1);
    hub.store.setRunStatus(run, "done");
    hub.loops.forget(run);
    onReply = async () => "ok";
    await replyTo("pick the cheaper one");
  });

  it("knows which chat a call is about when the agent answers several at once", async () => {
    const a = hub.store.createRun({ agentId, channelId: dm().id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: me });
    const b = hub.store.createRun({ agentId, channelId: dm().id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: me });
    hub.store.setRunStatus(a, "running");
    expect(hub.runFor(agentId)?.id).toBe(a);
    hub.store.setRunStatus(b, "running");
    // two at once and no run named: don't guess
    expect(hub.runFor(agentId)).toBeUndefined();
    expect(hub.runFor(agentId, b)?.id).toBe(b);
    expect(hub.runFor("agt_someone_else", b)).toBeUndefined();
    const token = calls.at(-1)!.mcp!.env.WISP_TOKEN;
    const agent = new WispClient({ url: owner.url, token });
    await expect(agent.chatStatus({ status: "open" })).rejects.toThrow("answering several");
    const named = new WispClient({ url: owner.url, token, runId: a });
    // over-long quick replies are cut to fit, not refused
    const sent = await named.messagePerson("Pick one?", [], ["a".repeat(60), " ", "Later"]);
    const parts = hub.store.message(sent.messageId)!.parts;
    expect(parts).toEqual([{ type: "checkback", replies: ["a".repeat(40), "Later"] }]);
    for (const r of [a, b]) hub.store.setRunStatus(r, "done");
  });

  it("stops checking back once the person writes", async () => {
    onReply = async (agent) => {
      await agent.chatStatus({ status: "waiting", summary: "send Sam the deck" });
      return "Did it go out?";
    };
    await replyTo("remind me about the deck");
    expect(pendingCheckbacks()).toHaveLength(1);
    onReply = async () => "ok";
    await replyTo("not yet");
    expect(pendingCheckbacks()).toHaveLength(0);
    expect(hub.store.chatLoop(dm().id)).toMatchObject({ status: "open", nudges: 0 });
  });

  it("wraps up a finished chat under the answer", async () => {
    onReply = async (agent) => {
      await agent.chatStatus({ status: "done", did: "Deck sent to Sam", saved: "Sam wants final numbers by Friday", next: "Look for Sam's reply · Wed" });
      return "Nice. I'll close this one.";
    };
    const reply = await replyTo("Sent it");
    expect(partsOf(reply, "wrapup")).toEqual([{ type: "wrapup", did: "Deck sent to Sam", saved: "Sam wants final numbers by Friday", next: "Look for Sam's reply · Wed" }]);
    expect(hub.store.chatLoop(dm().id)!.status).toBe("done");
  });

  it("doesn't check back for someone who turned it off", async () => {
    await owner.request("PUT", `/api/agents/${agentId}/checkback`, { enabled: false });
    onReply = async (agent) => {
      await agent.chatStatus({ status: "waiting", summary: "choose a date" });
      return "Which date works?";
    };
    await replyTo("let's meet");
    expect(hub.store.chatLoop(dm().id)!.status).toBe("waiting");
    expect(pendingCheckbacks()).toHaveLength(0);
    await owner.request("PUT", `/api/agents/${agentId}/checkback`, { enabled: true });
  });

  it("is only for DMs", async () => {
    const ch = await room({ name: "general-loops" });
    await owner.request("POST", `/api/channels/${ch.id}/members`, { kind: "agent", id: agentId }).catch(() => {});
    let error = "";
    onReply = async (agent) => {
      error = await agent.chatStatus({ status: "waiting", summary: "x" }).then(() => "", (e: Error) => e.message);
      return "ok";
    };
    await owner.send(ch.id, "@dot hi");
    await idle();
    expect(error).toContain("for your DM");
  });
});
