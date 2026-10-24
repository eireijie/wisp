import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import type { ClientEvent } from "@wisp/core";
import { WarrenClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let url: string;
let close: () => Promise<void>;
let daemon: NodeDaemon | undefined;
let owner: WarrenClient;
let hub: Hub;
let agentId: string;
let nodeToken: string;
const calls: RunInput[] = [];
const events: ClientEvent[] = [];

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: "sess-1" });
    return { finalText: "here now", sessionId: "sess-1" };
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

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-waiting-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub") });
  hub = built.hub;
  const broadcast = hub.broadcast.bind(hub);
  hub.broadcast = (workspaceId, event, only) => {
    events.push(event);
    broadcast(workspaceId, event, only);
  };
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WarrenClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  nodeToken = token;
  agentId = (await owner.request("POST", "/api/agents", { handle: "dot", name: "Dot", harness: "custom", nodeId: node.id })).id;
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a request made while the device is offline", () => {
  it("loses its 'queued until its device reconnects' note once the device takes it", async () => {
    const dm = await owner.request("POST", `/api/dm/${agentId}`);
    expect((await owner.agents()).find((a) => a.id === agentId)?.status).toBe("offline");
    await owner.send(dm.id, "are you there?");
    const notice = await waitFor(() => hub.store.messages(dm.id).find((m) => m.author.id === "system" && m.parts.some((p) => p.type === "status" && p.text === "@dot is offline. The request is queued until its device reconnects.")));

    // the device connects: the queued run goes out and the note no longer applies
    daemon = new NodeDaemon({ hub: url, token: nodeToken, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
    daemon.start();
    await waitFor(() => hub.store.messages(dm.id).find((m) => m.body === "here now"));
    expect(calls).toHaveLength(1);
    expect(hub.store.message(notice.id)).toBeUndefined();
    expect(hub.store.messages(dm.id).some((m) => m.author.id === "system")).toBe(false);
    // browsers that already showed the note are told to take it down
    expect(events).toContainEqual({ type: "message_removed", messageId: notice.id, channelId: dm.id, threadId: null });
    expect(events.filter((e) => e.type === "agent_status" && e.agentId === agentId).map((e) => (e as { status: string }).status)).toContain("online");
  }, 20_000);

  it("takes down only the note for the message whose run started, not ones for later messages", async () => {
    const dm = await owner.request("POST", `/api/dm/${agentId}`);
    const agent = hub.store.agent(agentId)!;
    const me = (await owner.request("GET", "/api/me")).user.id as string;
    const internals = hub as unknown as {
      postSystem(near: unknown, text: string): { id: string };
      dropWaitingNotice(run: { channelId: string; threadId: string | null; triggerMessageId: string }, agent: unknown): void;
    };
    const say = (body: string) => hub.store.insertMessage({ channelId: dm.id, threadId: null, author: { kind: "user", id: me }, body, parts: [], hop: 0 });
    const first = say("first?");
    const firstNote = internals.postSystem(first, "@dot is offline. The request is queued until its device reconnects.");
    await new Promise((r) => setTimeout(r, 5));
    const second = say("second?");
    const secondNote = internals.postSystem(second, "@dot is offline. The request is queued until its device reconnects.");
    internals.dropWaitingNotice({ channelId: dm.id, threadId: null, triggerMessageId: first.id }, agent);
    expect(hub.store.message(firstNote.id)).toBeUndefined();
    expect(hub.store.message(secondNote.id)).toBeDefined();
    internals.dropWaitingNotice({ channelId: dm.id, threadId: null, triggerMessageId: second.id }, agent);
    expect(hub.store.message(secondNote.id)).toBeUndefined();
  });

  it("posts no note at all when the device is already there", async () => {
    const dm = await owner.request("POST", `/api/dm/${agentId}`);
    const before = hub.store.messages(dm.id).length;
    await owner.send(dm.id, "and now?");
    await waitFor(() => (calls.length === 2 ? true : undefined));
    await waitFor(() => hub.store.messages(dm.id).length === before + 2 || undefined);
    expect(hub.store.messages(dm.id).slice(before).map((m) => m.author.id)).toEqual(expect.not.arrayContaining(["system"]));
  }, 20_000);
});
