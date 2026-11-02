import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { PASSES_PER_DAY } from "../src/auto-memory.ts";
import type { Hub } from "../src/hub.ts";

// vault writes go through git, which is slow when the whole suite runs at once
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let hub: Hub;
let agentId: string;
let me: string;
let wsId: string;
/** tools the fake harness reports calling in a chat run */
let calls: string[] = [];
/** what the fake harness does in a chat run */
let onChat: (agent: WispClient, input: RunInput) => Promise<string> = async () => "ok";
/** what it does in a memory pass */
let onPass: (agent: WispClient, input: RunInput) => Promise<string> = async () => "nothing";
const prompts: string[] = [];

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    const env = input.mcp!.env;
    const agent = new WispClient({ url: env.WISP_URL, token: env.WISP_TOKEN, runId: env.WISP_RUN });
    if (input.prompt.includes("short memory pass")) {
      prompts.push(input.prompt);
      return { finalText: await onPass(agent, input), sessionId: null };
    }
    for (const name of calls) onEvent({ type: "tool_call", name, input: {} });
    return { finalText: await onChat(agent, input), sessionId: null };
  },
};

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

const idle = () => waitFor(() => !hub.store.db.prepare("SELECT 1 FROM runs WHERE status IN ('queued','running')").get() || undefined);
const dm = () => hub.store.dmChannel(wsId, me, agentId);
const say = async (text: string) => {
  await owner.send(dm().id, text);
  await idle();
};
/** Time passes: the chat has been quiet long enough for its pass. */
const later = async () => {
  await hub.autoMemory.tick(new Date(Date.now() + 4 * 60_000));
  await idle();
};
const passes = () => hub.store.db.prepare("SELECT id, status, thread_id AS threadId FROM runs WHERE agent_id = ? AND kind = 'memory' ORDER BY created_at").all(agentId) as { id: string; status: string; threadId: string | null }[];
const vault = () => hub.vaults.primary;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-automem-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.push.send = async () => {};
  // the test moves time itself
  hub.autoMemory.stop();
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Sam", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentId = (await owner.request("POST", "/api/agents", { handle: "ghosty", name: "Ghosty", harness: "custom", nodeId: node.id })).id;
  wsId = hub.store.agent(agentId)!.workspaceId;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
  // the first tick tidies; get it out of the way
  await hub.autoMemory.tick();
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  onChat = async () => "ok";
  onPass = async () => "nothing";
  prompts.length = 0;
  // nothing left over from the test before
  await later();
});

describe("what agents save", () => {
  it("can't hold secrets", async () => {
    onChat = async (agent) => {
      const errors: string[] = [];
      for (const save of [
        () => agent.writeNote(`agents/${agentId}/stripe.md`, "# Stripe\n\nThe key is sk_live_abcdefghijklmnop1234"),
        () => agent.appendNote(`agents/${agentId}/log.md`, "password: hunter2hunter2"),
        () => agent.request("POST", "/api/memory/remember", { kind: "detail", text: "Their GitHub token is ghp_abcdefghijklmnopqrstuvwxyz0123" }),
      ])
        await save().catch((e: Error) => errors.push(e.message));
      // saying where it lives is fine
      await agent.writeNote(`agents/${agentId}/stripe.md`, "# Stripe\n\nThe API key lives in the Stripe connected app; Sam keeps billing there.");
      return errors.join("\n");
    };
    await say("set up stripe notes");
    const reply = hub.store.messages(dm().id).filter((m) => m.author.kind === "agent").at(-1)!.body;
    expect(reply.split("\n")).toHaveLength(3);
    expect(reply).toMatch(/can't hold passwords/);
    expect((await vault().read(`agents/${agentId}/stripe.md`)).content).toMatch(/Stripe connected app/);
    await expect(vault().read(`agents/${agentId}/log.md`)).rejects.toThrow();
  });

  it("refuses a new note that repeats one, and links a note that links nothing", async () => {
    await vault().write("shared/acme.md", "# Acme\n\nOur biggest customer, a bakery chain in Ohio.\n", { name: "Sam", email: "me@example.com" });
    await vault().write("shared/acme-pricing.md", "# Acme pricing\n\nAcme pays the yearly plan at 20 percent off, renewed every March by the finance team.\n", { name: "Sam", email: "me@example.com" });
    let out: unknown[] = [];
    onChat = async (agent) => {
      out = [];
      await agent.writeNote("shared/acme-pricing-copy.md", "# Acme pricing\n\nAcme pays the yearly plan at 20 percent off, renewed every March by the finance team.").catch((e: Error) => out.push(e.message));
      out.push(await agent.writeNote("shared/acme-renewal.md", "# Renewal call\n\nAcme wants the renewal call moved to April; finance agreed."));
      // a note that already links something is left as written
      out.push(await agent.writeNote("shared/ohio.md", "# Ohio stores\n\nThe [[acme]] stores in Ohio open at 7."));
      return "saved";
    };
    await say("note the acme renewal");
    expect(out[0]).toMatch(/shared\/acme-pricing\.md .* already says this/);
    await expect(vault().read("shared/acme-pricing-copy.md")).rejects.toThrow();
    expect(out[1]).toMatchObject({ path: "shared/acme-renewal.md", linked: ["[[acme]]"] });
    expect((await vault().read("shared/acme-renewal.md")).content).toMatch(/\n\nRelated: \[\[acme\]\]\n$/);
    expect(out[2]).not.toHaveProperty("linked");
    expect((await vault().read("shared/ohio.md")).content).not.toMatch(/Related:/);
    expect(vault().backlinks("shared/acme.md")).toEqual(expect.arrayContaining(["shared/acme-renewal.md", "shared/ohio.md"]));
  });
});

describe("memory passes", () => {
  it("follow real work the agent didn't save, once the chat is quiet, and post nothing", async () => {
    // Claude Code names MCP tools mcp__server__tool, Codex server.tool; Wisp's own chat_status isn't work
    calls = ["mcp__gmail__search", "gmail.read", "mcp__gmail__draft", "wisp.chat_status"];
    onChat = async () => "Drafted the reply to Dana about the March invoice.";
    await say("answer Dana's email about the invoice");
    // not yet: the chat may go on
    await hub.autoMemory.tick(new Date(Date.now() + 60_000));
    expect(passes()).toHaveLength(0);

    onPass = async (agent) => {
      await agent.writeNote("shared/dana.md", "# Dana\n\nDana handles invoices at the supplier; replies by email within a day.", "Note on Dana");
      return "Saved a note on Dana.";
    };
    const before = hub.store.messages(dm().id).length;
    await later();
    expect(passes()).toMatchObject([{ status: "done" }]);
    expect(prompts[0]).toMatch(/Sam wrote: "answer Dana's email about the invoice"/);
    expect(prompts[0]).toMatch(/You used: search, read, draft\n/);
    expect(prompts[0]).toMatch(/you did several steps of work/);
    // the pass is its own conversation and says nothing in the chat
    expect(hub.store.messages(dm().id)).toHaveLength(before);
    const [change] = await vault().changes(1);
    expect(change).toMatchObject({ author: "@ghosty", message: "Note on Dana (memory pass after work in a direct message)" });
    // only once
    await later();
    expect(passes()).toHaveLength(1);
  });

  it("aren't needed when the agent saved on its own, or it was a quick answer", async () => {
    const start = passes().length;
    calls = ["a", "b", "c"];
    onChat = async (agent) => {
      await agent.writeNote(`agents/${agentId}/report.md`, "# Weekly report\n\nSent the weekly report to the whole team on Friday.");
      return "Done.";
    };
    await say("send the weekly report");
    calls = [];
    onChat = async () => "It's 4pm.";
    await say("what time is it");
    await later();
    expect(passes()).toHaveLength(start);
  });

  it("follow something lasting the person said, even without tools", async () => {
    const start = passes().length;
    await say("I prefer short answers, and call me Sam");
    await later();
    expect(passes()).toHaveLength(start + 1);
    expect(prompts[0]).toMatch(/they said something that may be lasting/);
  });

  it("ask for a skill when the agent does the same kind of task again", async () => {
    calls = ["mcp__shop__search", "mcp__shop__cart", "mcp__shop__checkout"];
    await say("order the usual pizza from Tony's");
    await later();
    expect(prompts.at(-1)).not.toMatch(/skill_save/);
    prompts.length = 0;
    await say("order pizza again from Tony's please");
    await later();
    expect(prompts[0]).toMatch(/you've done this kind of task before/);
    expect(prompts[0]).toMatch(/Item 1: save how to do it with skill_save/);
  });

  it("ask for a skill when the person shows how", async () => {
    await say("Next time you book a room, always pick one with a window and ask before paying");
    await later();
    expect(prompts[0]).toMatch(/they showed you how they want it done/);
    expect(prompts[0]).toMatch(/skill_save/);
  });

  it("gather a busy chat into one pass", async () => {
    const start = passes().length;
    calls = ["x1", "x2", "x3"];
    await say("look into the flaky deploy");
    await say("now the staging logs too");
    await later();
    expect(passes()).toHaveLength(start + 1);
    expect(prompts[0]).toMatch(/1\. .*flaky deploy[\s\S]*2\. .*staging logs/);
  });

  it("count against the background allowance, and stop when most of it is used", async () => {
    const usedBefore = hub.background.allowance(wsId, me).todayTokens;
    calls = ["y1", "y2", "y3"];
    await say("clean up the shared drive");
    await later();
    expect(hub.background.allowance(wsId, me).todayTokens).toBeGreaterThan(usedBefore);

    const start = passes().length;
    hub.background.setDailyTokens(wsId, me, 1000);
    await say("clean up the photos folder too");
    await later();
    expect(passes()).toHaveLength(start);
    hub.background.setDailyTokens(wsId, me, null);
  });

  it("are capped per day", async () => {
    // fill today's passes
    for (let i = passes().length; i < PASSES_PER_DAY; i++) hub.store.db.prepare("INSERT INTO runs (id, agent_id, channel_id, thread_id, trigger_message_id, status, hop, requested_by, kind, created_at) VALUES (?, ?, ?, NULL, '', 'done', 0, ?, 'memory', ?)").run(`run_cap${i}`, agentId, dm().id, me, new Date().toISOString());
    const start = passes().length;
    calls = ["z1", "z2", "z3"];
    await say("archive last year's invoices");
    await later();
    expect(passes()).toHaveLength(start);
    hub.store.db.prepare("DELETE FROM runs WHERE id LIKE 'run_cap%'").run();
  });

  it("are off when an owner turns them off", async () => {
    expect((await owner.request("PUT", "/api/settings/agents", { autoMemory: false })).autoMemory).toBe(false);
    const start = passes().length;
    await say("I prefer tea over coffee");
    await later();
    expect(passes()).toHaveLength(start);
    hub.store.setSetting(wsId, "agents.autoMemory", null);
  });
});

describe("the daily tidy", () => {
  it("links recent notes nothing links to, and hands near-duplicates to their agent", async () => {
    const who = { name: "@ghosty", email: "ghosty@agents.wisp" };
    await vault().write("shared/espresso.md", "# Espresso machine\n\nThe office espresso machine needs descaling monthly.\n", who);
    await vault().write("shared/coffee.md", "# Coffee\n\nWe buy beans from the roaster on Main Street. The espresso machine is in the kitchen.\n", who);
    await vault().write(`agents/${agentId}/standup.md`, "# Standup notes\n\nStandup moved to 9:30 every weekday for the platform team members.\n", who);
    await vault().write(`agents/${agentId}/standup-time.md`, "# Standup time\n\nStandup moved to 9:30 every weekday for the platform team.\n", who);
    await hub.autoMemory.tidy(wsId);
    expect((await vault().read("shared/coffee.md")).content).toMatch(/Related: \[\[espresso\]\]/);
    const [change] = await vault().changes(1);
    expect(change.author).toBe("Wisp");

    // the agent's next pass is asked to merge them
    await say("I prefer standups short");
    await later();
    expect(prompts[0]).toMatch(/may say the same thing: agents\/[^ ]+\/standup-time\.md and agents\/[^ ]+\/standup\.md/);
  });
});
