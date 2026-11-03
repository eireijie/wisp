import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let agent: WispClient;
let hub: Hub;
let agentId: string;
let otherId: string;
let me: string;
let ws: string;
const calls: RunInput[] = [];
let onCheck: (agent: WispClient, input: RunInput) => Promise<string> = async () => "nothing new";

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    const a = new WispClient({ url: input.mcp!.env.WISP_URL, token: input.mcp!.env.WISP_TOKEN });
    const finalText = input.prompt.includes("## Working in the background") ? await onCheck(a, input) : "hi";
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
const dm = () => hub.store.dmChannel(ws, me, agentId);
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** Notion as the watch sees it: whatever pages the test puts here. */
let pages: any[] = [];
const page = (id: string, title: string, edited: string, created = "2026-01-01T00:00:00.000Z") => ({ object: "page", id, url: `https://notion.so/${id}`, created_time: created, last_edited_time: edited, last_edited_by: { id: "u1" }, properties: { Name: { type: "title", title: [{ plain_text: title }] } } });
const asked: string[] = [];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-watches-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.watches.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("https://api.notion.com/v1/search")) {
      if ((init?.headers as Record<string, string>)?.authorization !== "Bearer ntn_good") return new Response("{}", { status: 401 });
      return Response.json({ results: pages });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentId = (await owner.request("POST", "/api/agents", { handle: "dot", name: "Dot", harness: "custom", nodeId: node.id })).id;
  otherId = (await owner.request("POST", "/api/agents", { handle: "max", name: "Max", harness: "custom", nodeId: node.id })).id;
  ws = hub.store.agent(agentId)!.workspaceId;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.id === agentId && a.status === "online"));
  // the agent connected to Notion, working in the background with no quiet hours
  const notion = hub.connectors.create(ws, me, { kind: "mcp-stdio", name: "Notion", catalogId: "notion", command: "npx", args: [], env: { NOTION_TOKEN: "ntn_good" } });
  hub.connectors.attach(notion.id, agentId, true);
  await owner.send(dm().id, "hello");
  await waitFor(() => calls.length || undefined);
  await idle();
  agent = new WispClient({ url, token: calls[0].mcp!.env.WISP_TOKEN });
  await owner.request("PUT", `/api/agents/${agentId}/background`, { enabled: true, quietStart: "00:00", quietEnd: "00:00", dailyCap: null });
  await waitFor(() => hub.store.background(agentId, me)?.lastNote || undefined);
  await idle();
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("watches", () => {
  let watchId: string;

  it("an agent starts one with its connector's key; a wrong key fails while someone is there to fix it", async () => {
    pages = [page("p1", "Q4 notes", "2026-11-02T09:00:00.000Z")];
    const lines = () => hub.watches.promptLines({ id: "none", agentId, requestedBy: me }, "Me", String).join("\n");
    // checks suggest watching apps it's connected to, once
    expect(lines()).toContain(`You're connected to Notion, but Wisp doesn't tell you when it changes`);
    const w = await agent.startWatch({ service: "notion" });
    expect(lines()).not.toContain("You're connected to");
    watchId = w.id;
    expect(w).toMatchObject({ service: "notion", label: "Notion", userId: me, agentIds: [agentId], hasOwnKey: false, backgroundOn: true });
    expect(w.estimate.note).toMatch(/costs nothing/);
    expect(hub.store.db.prepare("SELECT cursor FROM watches WHERE id = ?").get(w.id)).toEqual({ cursor: "2026-11-02T09:00:00.000Z" });
    await expect(agent.startWatch({ service: "notion", key: { NOTION_TOKEN: "ntn_bad" } })).rejects.toThrow(/refused the key/);
    // an agent without the app can't be put on it
    await expect(owner.request("PATCH", `/api/watches/${w.id}`, { agentIds: [agentId, otherId] })).rejects.toThrow(/isn't connected to that app/);
    const listed = await owner.request("GET", "/api/watches");
    expect(listed.watches.map((x: { id: string }) => x.id)).toEqual([w.id]);
    expect(listed.services.find((s: { service: string }) => s.service === "gdrive")).toMatchObject({ available: false });
    // the key itself is never sent back
    expect(JSON.stringify(listed)).not.toContain("ntn_good");
  });

  it("gathers a burst of edits into one check, with what changed and how to raise it once", async () => {
    const n = calls.length;
    pages = [page("p2", "Launch plan", "2026-11-02T10:01:00.000Z", "2026-11-02T10:00:00.000Z"), page("p1", "Q4 notes", "2026-11-02T10:00:00.000Z")];
    await hub.watches.tick(later(6));
    // nothing yet: edits are still coming in
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE run_id IS NULL").get()).toEqual({ n: 2 });
    hub.watches.deliver(later(6.5));
    expect(calls.length).toBe(n);
    let prompt = "";
    onCheck = async (_a, input) => {
      prompt = input.prompt;
      return "saw the launch plan";
    };
    hub.watches.deliver(later(9));
    await waitFor(() => prompt || undefined);
    await idle();
    expect(calls.length).toBe(n + 1);
    expect(prompt).toContain("This check is because something changed in Me's apps:");
    expect(prompt).toContain("[Notion] created: Launch plan");
    expect(prompt).toContain("[about: notion:p2]");
    expect(prompt).toContain("edited: Q4 notes");
    expect(prompt).toContain("Say each thing once");
    // the same edits seen again aren't news
    await hub.watches.tick(later(12));
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE run_id IS NULL").get()).toEqual({ n: 0 });
  });

  it("raises something once; ignored means dropped, an answer lets it come up again", async () => {
    await agent.messagePerson("I see you're working on the launch plan. Want a hand with it?", [], ["Yes please", "No thanks"], "notion:p2");
    await expect(agent.messagePerson("Still want help with the launch plan?", [], [], "notion:p2")).rejects.toThrow(/already raised/);
    expect(hub.store.messages(dm().id).filter((m) => m.body.includes("launch plan")).length).toBe(1);
    // and the next check is told what it already raised
    pages = [page("p3", "Budget", "2026-11-02T11:00:00.000Z")];
    let prompt = "";
    onCheck = async (_a, input) => {
      prompt = input.prompt;
      return "ok";
    };
    await hub.watches.tick(later(20));
    hub.watches.deliver(later(25));
    await waitFor(() => prompt || undefined);
    await idle();
    expect(prompt).toMatch(/- notion:p2: .*no answer, so dropped/);
    onCheck = async () => "ok";
    await owner.send(dm().id, "yes please");
    await waitFor(() => hub.watches.mention(agentId, me, "notion:p2")?.answeredAt || undefined);
    await idle();
    await agent.messagePerson("Here's a first pass at the launch plan.", [], [], "notion:p2");
  });

  it("doesn't keep previews once the agent has seen them", () => {
    const left = hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE run_id IS NOT NULL AND preview IS NOT NULL").get();
    expect(left).toEqual({ n: 0 });
  });

  it("holds changes during quiet hours and while background work is off", async () => {
    pages = [page("p4", "Trip", "2026-11-02T12:00:00.000Z")];
    await owner.request("PUT", `/api/agents/${agentId}/background`, { quietStart: "00:00", quietEnd: "23:59" });
    const n = calls.length;
    await hub.watches.tick(later(40));
    hub.watches.deliver(later(45));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.length).toBe(n);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE run_id IS NULL").get()).toEqual({ n: 1 });
    await owner.request("PUT", `/api/agents/${agentId}/background`, { quietStart: "00:00", quietEnd: "00:00" });
  });

  it("the person pauses or stops it, and everything it saw goes with it", async () => {
    const paused = await owner.request("PATCH", `/api/watches/${watchId}`, { paused: true });
    expect(paused.paused).toBe(true);
    // what was waiting isn't sent on
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE run_id IS NULL").get()).toEqual({ n: 0 });
    const before = asked.length;
    await hub.watches.tick(later(60));
    expect(asked.length).toBe(before);
    await owner.request("DELETE", `/api/watches/${watchId}`);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events").get()).toEqual({ n: 0 });
    expect((await owner.request("GET", "/api/watches")).watches).toEqual([]);
  });

  it("checks a site in the agent's browser on a slow schedule, saying what it costs", async () => {
    await expect(agent.startWatch({ service: "browser", config: { url: "https://canvas.example.edu", lookFor: "new assignments and grades" } })).rejects.toThrow(/needs its own computer/);
    hub.store.db.prepare("UPDATE agents SET computer_id = 'comp_test' WHERE id = ?").run(agentId);
    const w = await agent.startWatch({ service: "browser", config: { url: "https://canvas.example.edu", lookFor: "new assignments and grades" }, everyMinutes: 30 });
    expect(w).toMatchObject({ label: "canvas.example.edu (browser)", everyMinutes: 120 });
    expect(w.estimate.note).toMatch(/12 browser checks a day, 720k tokens \(72% of the daily allowance\)/);
    let prompt = "";
    onCheck = async (_a, input) => {
      prompt = input.prompt;
      return "looked at canvas";
    };
    await hub.watches.tick(later(61));
    await waitFor(() => prompt || undefined);
    await idle();
    expect(prompt).toContain("open https://canvas.example.edu in your computer's browser");
    expect(prompt).toContain("look for: new assignments and grades");
    // an agent stopping its only watch removes it
    await agent.stopWatch(w.id);
    expect(hub.watches.get(w.id)).toBeUndefined();
    hub.store.db.prepare("UPDATE agents SET computer_id = NULL WHERE id = ?").run(agentId);
  });
});
