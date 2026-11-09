import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

/**
 * A simulated day of the 2026-11-08 feature test's setup: Atlas has its own computer, checks in every
 * 3 hours, and watches a public GitHub repo's issues page in its browser. The page's relative times
 * move on all day and one new issue appears at hour 10; the agent finds nothing to say otherwise.
 * Prints the model runs it took and what they cost by Wisp's own estimates. Written against APIs that
 * main has too, so the same file measures before and after.
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


const BROWSER_CHECK_TOKENS = 60_000;
const CHECK_TOKENS = 25_000;

describe("a simulated day", () => {
  it("counts the model runs background work takes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-09T08:00:00Z").getTime();
    vi.setSystemTime(start);
    try {
      await agent.changeSettings({ background: { enabled: true, everyMinutes: 180, quietStart: "00:00", quietEnd: "00:00" } });
      await idle();
      const w = await agent.startWatch({ service: "browser", config: { url: REPO, lookFor: "new issues" } });
      const STEP = 5;
      for (let m = 0; m <= 24 * 60; m += STEP) {
        vi.setSystemTime(start + m * 60_000);
        ago = `${Math.floor(m / 60) + 1} hours ago`;
        if (m === 10 * 60) issues = [...issues, "Crash when saving a draft"];
        hub.background.tick();
        await hub.watches.tick();
        await new Promise((r) => setTimeout(r, 5));
        await idle();
      }
      const runs = hub.store.db.prepare("SELECT r.id, r.created_at AS at, EXISTS (SELECT 1 FROM app_events e WHERE e.run_id = r.id AND e.kind = 'browser_check') AS site FROM runs r WHERE r.kind = 'background' AND r.status != 'queued' ORDER BY r.created_at").all() as { id: string; at: string; site: number }[];
      const cost = (list: typeof runs) => list.reduce((n, r) => n + (r.site ? BROWSER_CHECK_TOKENS : CHECK_TOKENS), 0);
      const first35 = runs.filter((r) => new Date(r.at).getTime() < start + 35 * 60_000);
      const out = {
        watchEvery: hub.watches.get(w.id)?.everyMinutes,
        runs: runs.length,
        siteRuns: runs.filter((r) => r.site).length,
        checkIns: runs.filter((r) => !r.site).length,
        tokens: cost(runs),
        shareOfDefaultAllowance: Math.round((cost(runs) / 1_000_000) * 100) + "%",
        first35min: { runs: first35.length, tokens: cost(first35) },
        times: runs.map((r) => `${Math.round((new Date(r.at).getTime() - start) / 60_000)}m${r.site ? " (site)" : ""}`),
      };
      console.log("USAGE-SIM " + JSON.stringify(out));
      expect(runs.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});
