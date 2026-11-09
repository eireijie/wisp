import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { QUIET_LATELY } from "../src/background.ts";
import type { Hub } from "../src/hub.ts";

/**
 * What background work costs the person: website watches that read the page before waking a model,
 * one pace for check-ins and site looks, no blind check-ins when watches cover everything, quiet
 * sign-in sites backing off, and one plain heads-up when usage climbs fast.
 */

let dir: string;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let agent: WispClient;
let hub: Hub;
let agentId: string;
let me: string;
let ws: string;
const calls: RunInput[] = [];
let onCheck: (input: RunInput) => Promise<string> = async () => "nothing new";

const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: `sess-${calls.length}` });
    const finalText = input.prompt.includes("## Working in the background") ? await onCheck(input) : "hi";
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
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const checks = () => calls.filter((c) => c.prompt.includes("## Working in the background")).length;

const REPO = "https://github.com/octo/hello/issues";
let issues = ["Docs typo in README", "Add dark mode", "Login button broken on Safari"];
let ago = "3 hours ago";
const issuesPage = () => `<!doctype html><html><head><script>var t=${Date.now()}</script></head><body><main><h1>Issues · octo/hello</h1>
<p>Track bugs and feature requests for the hello project. Search all issues, filter by label, or open a new one.</p>
<ul>${issues.map((t, i) => `<li><a href="/octo/hello/issues/${i + 1}">${t}</a><span> #${i + 1} opened ${ago} by mona</span></li>`).reverse().join("")}</ul></main></body></html>`;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-usage-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  hub.watches.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === REPO) return new Response(issuesPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    // a school site: only a signed-in browser sees it
    if (url.startsWith("https://canvas.example.edu")) return new Response(`<form>Sign in<input type="password"></form>`, { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  const { node, token } = await owner.request("POST", "/api/nodes", { name: "box" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  agentId = (await owner.request("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom", nodeId: node.id })).id;
  ws = hub.store.agent(agentId)!.workspaceId;
  daemon = new NodeDaemon({ hub: url, token, name: "box", dir: path.join(dir, "node") }, () => {}, { custom: fake });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.id === agentId && a.status === "online"));
  await owner.send(hub.store.dmChannel(ws, me, agentId).id, "hello");
  await waitFor(() => calls.length || undefined);
  await idle();
  agent = new WispClient({ url, token: calls[0].mcp!.env.WISP_TOKEN });
  // its own computer, like an agent made in first-run setup
  hub.store.db.prepare("UPDATE agents SET computer_id = 'comp_test' WHERE id = ?").run(agentId);
}, 30_000);

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("what background work costs", () => {
  let site: string;

  it("a public page is read by Wisp at the agent's own pace, and only new lines wake the agent", async () => {
    await owner.request("PUT", `/api/agents/${agentId}/background`, { enabled: true, quietStart: "00:00", quietEnd: "00:00", dailyCap: null });
    await idle();
    await agent.changeSettings({ background: { everyMinutes: 180 } });
    const n = checks();
    const w = await agent.startWatch({ service: "browser", config: { url: REPO, lookFor: "new issues" }, label: "hello issues" });
    site = w.id;
    // the same number the agent tells the person: "checks every 3 hours"
    expect(w.everyMinutes).toBe(180);
    expect(w.estimate.note).toMatch(/reads the page itself every 3 hours, which costs nothing, and wakes the agent only when something on it changed/);
    expect(hub.watches.readsPage(w.id)).toBe(true);
    await idle();
    expect(checks()).toBe(n);

    // later: only "3 hours ago" became "6 hours ago", and the page's script changed
    ago = "6 hours ago";
    await hub.watches.tick(later(181));
    await idle();
    expect(checks()).toBe(n);
    expect(hub.store.db.prepare("SELECT COUNT(*) AS n FROM app_events WHERE watch_id = ?").get(w.id)).toEqual({ n: 0 });

    // a new issue: the agent is woken with the new line and doesn't have to open the site
    issues = [...issues, "Crash when saving a draft"];
    let prompt = "";
    onCheck = async (input) => {
      prompt = input.prompt;
      return "new issue, not urgent";
    };
    await hub.watches.tick(later(362));
    await waitFor(() => prompt || undefined);
    await idle();
    expect(prompt).toContain("hello issues changed. Wisp read https://github.com/octo/hello/issues and these lines are new");
    expect(prompt).toContain("Crash when saving a draft #4 opened by mona");
    expect(prompt).toContain("you don't need to open the site");
    expect(prompt).not.toContain("Login button broken");
    onCheck = async () => "nothing new";
  });

  it("a check-in doesn't wake the model when watches cover everything and nothing changed", async () => {
    const n = checks();
    hub.store.setBackground(agentId, me, { nextAt: null, nextReason: "" });
    hub.background.tick(later(1));
    await idle();
    expect(checks()).toBe(n);
    expect(hub.store.background(agentId, me)!.nextReason).toBe(QUIET_LATELY);
    expect(hub.background.blindSources(agentId, me)).toEqual([]);
    // an app Wisp can't watch for it brings timed checks back
    const app = hub.connectors.create(ws, me, { kind: "mcp-stdio", name: "Todo app", command: "npx", args: [], env: {} });
    hub.connectors.attach(app.id, agentId, true);
    expect(hub.background.blindSources(agentId, me)).toEqual(["Todo app"]);
    hub.connectors.attach(app.id, agentId, false);
    hub.store.db.prepare("DELETE FROM connectors WHERE id = ?").run(app.id);
    expect(hub.background.blindSources(agentId, me)).toEqual([]);
  });

  it("a site follows when the person changes how often the agent checks", async () => {
    await agent.changeSettings({ background: { everyMinutes: 240 } });
    expect(hub.watches.get(site)!.everyMinutes).toBe(240);
    // two hours is the least for a site
    await agent.changeSettings({ background: { everyMinutes: 30 } });
    expect(hub.watches.get(site)!.everyMinutes).toBe(120);
    expect(hub.store.background(agentId, me)!.everyMinutes).toBe(30);
  });

  it("a site behind a sign-in is looked at by the agent, less often after quiet looks", async () => {
    const n = checks();
    const w = await agent.startWatch({ service: "browser", config: { url: "https://canvas.example.edu/courses", lookFor: "new grades" }, everyMinutes: 120 });
    expect(hub.watches.readsPage(w.id)).toBe(false);
    expect(w.estimate.note).toMatch(/the site needs a sign-in/);
    const gap = () => {
      const r = hub.store.db.prepare("SELECT last_polled_at AS a, next_poll_at AS b FROM watches WHERE id = ?").get(w.id) as { a: string; b: string };
      return (new Date(r.b).getTime() - new Date(r.a).getTime()) / 60_000;
    };
    // first look right away, so it learns what the page looks like
    await hub.watches.tick(later(0));
    await waitFor(() => checks() > n || undefined);
    await idle();
    expect(gap()).toBe(120);
    // a second quiet look in a row doubles the wait, then again
    await hub.watches.tick(later(121));
    await waitFor(() => checks() > n + 1 || undefined);
    await idle();
    expect(gap()).toBe(240);
    await hub.watches.tick(later(400));
    await waitFor(() => checks() > n + 2 || undefined);
    await idle();
    expect(gap()).toBe(480);
    await agent.stopWatch(w.id);
  });

  it("tells the person once, in the chat, when usage is climbing fast", async () => {
    const dm = hub.store.dmChannel(ws, me, agentId);
    const notices = () => hub.store.messages(dm.id, { limit: 100 }).filter((m) => m.author.id === "system" && m.parts.some((p) => p.type === "status" && p.text.includes("of today's allowance")));
    hub.background.setDailyTokens(ws, me, 1_000_000);
    const burn = (tokens: number) => {
      const id = hub.store.createRun({ agentId, channelId: dm.id, threadId: null, triggerMessageId: "", hop: 0, requestedBy: me, kind: "background" });
      hub.store.setRunStatus(id, "running");
      hub.store.setRunUsage(id, { inputTokens: tokens, outputTokens: 0 } as never);
      hub.store.setRunStatus(id, "done");
    };
    hub.background.warnIfClimbing(ws, me);
    expect(notices()).toHaveLength(0);
    burn(300_000);
    hub.background.warnIfClimbing(ws, me);
    const [n] = notices();
    expect(n.parts[0]).toMatchObject({ type: "status" });
    expect((n.parts[0] as { text: string }).text).toMatch(/^Background work used \d+% of today's allowance already\. At this pace it runs out around .+, and then checks wait until tomorrow\. You can change it in Settings → Usage, or ask Atlas to check less often\.$/);
    burn(300_000);
    hub.background.warnIfClimbing(ws, me);
    expect(notices()).toHaveLength(1);
  });
});
