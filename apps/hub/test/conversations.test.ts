import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { CONVERSATION_GAP_MS } from "@wisp/core";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let agentId: string;
let me: string;
const calls: RunInput[] = [];
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
const say = async (text: string, replyToId?: string) => {
  const sent = await owner.request<{ id: string; createdAt: string }>("POST", `/api/channels/${dm().id}/messages`, { body: text, ...(replyToId ? { replyToId } : {}) });
  await idle();
  const sentMsg = hub.store.message(sent.id)!;
  const reply = hub.store.messages(dm().id).filter((m) => m.author.kind === "agent" && m.createdAt >= sent.createdAt).at(-1)!;
  return { sent: sentMsg, reply };
};
/** Everything said so far happened this long ago: the quiet break, without waiting it out. */
const age = (ms: number) => {
  const rows = hub.store.db.prepare("SELECT id, created_at FROM messages").all() as { id: string; created_at: string }[];
  const set = hub.store.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?");
  for (const r of rows) set.run(new Date(Date.parse(r.created_at) - ms).toISOString(), r.id);
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-chats-"));
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
  hub.store.db.prepare("UPDATE users SET timezone = 'UTC'").run();
  agentId = (await owner.request("POST", "/api/agents", { handle: "harry", name: "Harry", harness: "custom", nodeId: node.id })).id;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("chats split after a quiet break", () => {
  let hotel: { sent: { id: string; conversationId?: string }; reply: { id: string; conversationId?: string } };

  it("keeps one chat, and one harness session, while it isn't quiet", async () => {
    onReply = async () => "Three under £200. The Hoxton is closest.";
    hotel = await say("Find a hotel near Shoreditch for the 14th");
    expect(hotel.sent.conversationId).toBe(hotel.sent.id);
    expect(hotel.reply.conversationId).toBe(hotel.sent.id);
    onReply = async () => "Booked the Hoxton.";
    const n = calls.length;
    const booked = await say("Book the Hoxton");
    expect(booked.sent.conversationId).toBe(hotel.sent.id);
    // the same chat continues the harness session it started
    expect(calls[n].sessionId).toBe(`sess-${n}`);
    expect(calls[n].prompt).toContain("Find a hotel near Shoreditch");
  });

  it("starts a fresh chat after the break: new session, only this chat in the prompt", async () => {
    age(CONVERSATION_GAP_MS + 60_000);
    onReply = async () => "Hi. What can I do for you?";
    const n = calls.length;
    const hi = await say("Hi Harry");
    expect(hi.sent.conversationId).toBe(hi.sent.id);
    expect(hi.reply.conversationId).toBe(hi.sent.id);
    expect(calls[n].sessionId).toBeNull();
    expect(calls[n].prompt).not.toContain("Find a hotel near Shoreditch");
    expect(calls[n].prompt).toContain("earlier chats here aren't shown");
    expect(calls[n].prompt).toContain(`chat_read (before: "${hi.sent.createdAt}")`);
  });

  it("brings an earlier chat back when the person replies to one of its messages", async () => {
    onReply = async () => "Yes, late check-in is fine.";
    const n = calls.length;
    const back = await say("Did they say anything about late check-in?", hotel.reply.id);
    const msg = hub.store.withReactions([hub.store.message(back.sent.id)!])[0];
    expect(msg.context?.conversationId).toBe(hotel.sent.id);
    expect(msg.replyTo).toMatchObject({ id: hotel.reply.id, conversationId: hotel.sent.id });
    expect(calls[n].prompt).toContain("An earlier chat they're picking back up");
    expect(calls[n].prompt).toContain("Find a hotel near Shoreditch");
    // and still continues this chat's own session
    expect(calls[n].sessionId).toBe(`sess-${n}`);
  });

  it("keeps a reply that took longer than the break in the chat it answers", async () => {
    onReply = async () => {
      // the work took hours: everything so far is now long ago
      age(CONVERSATION_GAP_MS + 60_000);
      return "Done, all 40 invoices are filed.";
    };
    const slow = await say("File all the invoices");
    expect(slow.reply.conversationId).toBe(slow.sent.conversationId);
  });

  it("puts a late reply in the chat going on now when the person already moved on, bringing its own chat back", async () => {
    let posted: { id: string; conversationId?: string } | undefined;
    onReply = async (_agent, input) => {
      if (!input.prompt.includes("Summarize the quarter")) return "ok";
      // hours of work, and meanwhile the person started a new chat
      age(CONVERSATION_GAP_MS + 60_000);
      posted = hub.store.insertMessage({ channelId: dm().id, author: { kind: "user", id: me }, body: "Also, what's for lunch?" });
      return "Here's the quarter summary.";
    };
    const slow = await say("Summarize the quarter");
    const reply = hub.store.withReactions([slow.reply])[0];
    expect(posted!.conversationId).toBe(posted!.id);
    expect(reply.conversationId).toBe(posted!.id);
    expect(reply.context?.conversationId).toBe(slow.sent.conversationId);
    // and the chat going on now keeps going
    const next = hub.store.insertMessage({ channelId: dm().id, author: { kind: "user", id: me }, body: "thanks" });
    expect(next.conversationId).toBe(posted!.id);
  });

  it("dates an earlier chat by its first message that's left", async () => {
    const first = hub.store.insertMessage({ channelId: dm().id, author: { kind: "user", id: me }, body: "x" });
    age(CONVERSATION_GAP_MS + 60_000);
    const second = hub.store.insertMessage({ channelId: dm().id, author: { kind: "user", id: me }, body: "y" });
    const third = hub.store.insertMessage({ channelId: dm().id, author: { kind: "user", id: me }, body: "z", contextId: first.conversationId });
    hub.store.deleteMessage(first.conversationId!);
    const startedAt = hub.store.chatStart(first.conversationId!);
    expect(startedAt === undefined || startedAt < second.createdAt).toBe(true);
    expect(third.conversationId).toBe(second.id);
  });

  it("links a check-back after a quiet break to the chat it came from", async () => {
    onReply = async (agent) => {
      await agent.chatStatus({ status: "waiting", summary: "tell the hotel the arrival time" });
      return "Should I tell them you'll arrive after 11 PM?";
    };
    const ask = await say("The hotel wants my arrival time");
    const [checkback] = hub.store.pendingFollowups(agentId).filter((f) => f.kind === "checkback");
    expect(checkback).toBeTruthy();
    age(CONVERSATION_GAP_MS + 60_000);
    onCheck = async (agent) => {
      await agent.messagePerson("Still want me to tell the hotel you're arriving late?", [], ["Yes", "No"]);
      return "asked";
    };
    const n = calls.length;
    hub.background.tick(new Date(checkback.dueAt));
    await waitFor(() => calls.length > n || undefined);
    await idle();
    const nudge = hub.store.withReactions([hub.store.messages(dm().id).at(-1)!])[0];
    expect(nudge.conversationId).toBe(nudge.id);
    expect(nudge.context?.conversationId).toBe(ask.sent.conversationId);

    // answering it, the agent has the original chat back
    onReply = async () => "Done, they know.";
    const m = calls.length;
    await say("Yes");
    expect(calls[m].prompt).toContain("An earlier chat they're picking back up");
    expect(calls[m].prompt).toContain("The hotel wants my arrival time");
  });

  it("never splits a thread", async () => {
    const root = hub.store.messages(dm().id).at(-1)!;
    const inThread = hub.store.insertMessage({ channelId: dm().id, threadId: root.id, author: { kind: "user", id: me }, body: "in a thread" });
    expect(inThread.conversationId).toBeUndefined();
  });
});

describe("messages from before chats split", () => {
  it("are split the same way when the hub upgrades", async () => {
    const file = path.join(dir, "old.db");
    let db = openDb(file);
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'W', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO channels (id, workspace_id, name, kind, created_at) VALUES ('c', 'w', 'x', 'dm', '2026-01-01T00:00:00Z')").run();
    db.exec("DROP INDEX messages_conversation; ALTER TABLE messages DROP COLUMN conversation_id; ALTER TABLE messages DROP COLUMN context_id");
    const add = db.prepare("INSERT INTO messages (id, channel_id, thread_id, author_kind, author_id, body, created_at) VALUES (?, 'c', ?, 'user', 'u', '', ?)");
    add.run("a", null, "2026-11-01T09:00:00.000Z");
    add.run("b", null, "2026-11-01T09:30:00.000Z");
    add.run("t", "b", "2026-11-01T20:00:00.000Z");
    add.run("c", null, "2026-11-01T17:00:00.000Z");
    db.close();
    db = openDb(file);
    // a new message after an upgrade cut short: the rest are still filled in on the next start
    db.prepare("UPDATE messages SET conversation_id = NULL WHERE id = 'c'").run();
    db.close();
    db = openDb(file);
    const rows = Object.fromEntries((db.prepare("SELECT id, conversation_id FROM messages").all() as { id: string; conversation_id: string | null }[]).map((r) => [r.id, r.conversation_id]));
    expect(rows).toEqual({ a: "a", b: "a", t: null, c: "c" });
    db.close();
  });
});
