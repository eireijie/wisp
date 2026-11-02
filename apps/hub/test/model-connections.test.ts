import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { HarnessAdapter, RunInput } from "@wisp/adapters";
import type { HubToNode, NodeToHub } from "@wisp/core";
import { WispClient } from "@wisp/sdk";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { readSecret } from "../../node/src/model-login.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { renewalDue } from "../src/model-connections.ts";

// a busy machine runs many suites at once; nothing here waits on purpose
vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

let dir: string;
let url: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: WispClient;
let other: WispClient;
let me: string;
let ws: string;
let box: { id: string };
let phone: { id: string; token: string };
let daemon: NodeDaemon;
let nodeDir: string;
let harnessHome: string;
const calls: RunInput[] = [];

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const chatgpt = (refresh: string, at = new Date().toISOString()) => ({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }), access_token: `a-${refresh}`, refresh_token: refresh, account_id: "acct" }, last_refresh: at });

/** Codex as far as Wisp can tell: reads its sign-in where it was put, renews it when asked, reports plan usage. */
const fakeCodex: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  binary: "codex",
  async catalog() {
    return { harness: "codex", version: "codex-cli 0.162.1", models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high"], contextWindow: 258_000 }], efforts: ["low", "medium", "high"] };
  },
  async run(input, onEvent) {
    calls.push(input);
    const last = input.prompt.trim().split("\n").pop() ?? "";
    const file = input.env?.CODEX_HOME ? path.join(input.env.CODEX_HOME, "auth.json") : null;
    if (file && last.includes("renew")) {
      const auth = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...auth, tokens: { ...auth.tokens, access_token: "a-r2", refresh_token: "r2" }, last_refresh: new Date(Date.now() + 1000).toISOString() }));
    }
    onEvent({ type: "session", id: input.sessionId ?? "codex-sess" });
    onEvent({ type: "usage", model: "gpt-6.1-sol", contextUsed: 1000, contextWindow: 258_000, ...(input.connection?.kind === "oauth" ? { plan: { window: "weekly", usedFraction: 0.3, resetsAt: "2026-11-02T00:00:00.000Z", planType: "pro" } } : {}) });
    return { finalText: `codex ${calls.length}`, sessionId: "codex-sess" };
  },
};

const fakeClaude: HarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  binary: "claude",
  async catalog() {
    return { harness: "claude-code", version: "2.1.309 (Claude Code)", models: [{ id: "opus", label: "Opus" }], efforts: ["low", "medium", "high", "xhigh", "max"] };
  },
  async run(input, onEvent) {
    calls.push(input);
    onEvent({ type: "session", id: input.sessionId ?? "claude-sess" });
    return { finalText: `claude ${calls.length}`, sessionId: "claude-sess" };
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

/** A device scripted by the test: answers sign-ins and holds runs until told. */
class FakeDevice {
  ws!: WebSocket;
  got: HubToNode[] = [];
  onMessage: (m: HubToNode) => void = () => {};
  async connect(token: string) {
    this.ws = new WebSocket(url.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((resolve, reject) => {
      this.ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as HubToNode;
        this.got.push(m);
        if (m.type === "welcome") {
          this.send({ type: "hello", nodeName: "phone", agents: [] });
          this.send({ type: "catalog", catalog: [{ harness: "codex", version: "codex-cli 0.162.1", models: [], efforts: [] }] });
          resolve();
        }
        this.onMessage(m);
      });
      this.ws.on("error", reject);
    });
  }
  send(m: NodeToHub) {
    this.ws.send(JSON.stringify(m));
  }
}
let device: FakeDevice;

async function message(channel: string, text: string, from = "codex") {
  const before = calls.length;
  await owner.send(channel, text);
  await waitFor(() => (calls.length > before ? true : undefined));
  // its reply lands after the run returns
  await waitFor(async () => ((await owner.messages(channel)).messages.some((m) => m.body.startsWith(`${from} ${calls.length}`)) ? true : undefined));
  return calls.at(-1)!;
}

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-models-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  // providers' model lists without the network
  hub.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-api-key") ?? "";
    if (auth.includes("bad")) return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
    if (u.startsWith("https://openrouter.ai/api/v1/key")) return Response.json({ data: { label: "k" } });
    if (u.startsWith("https://openrouter.ai/api/v1/models")) return Response.json({ data: [{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", context_length: 1_000_000, supported_parameters: ["reasoning"] }, { id: "openai/gpt-6.1", name: "GPT-6.1" }] });
    if (u.startsWith("https://api.anthropic.com/v1/models")) return Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  await owner.request("POST", "/api/channels", { name: "general" });
  me = (hub.store.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  // a second person in the organization
  await owner.request("PUT", "/api/features", { invite: true });
  const invite = await owner.request<{ code: string }>("POST", "/api/invites", { role: "member", days: 1 });
  const joined = await (await fetch(url + "/api/invites/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, email: "you@example.com", name: "You", password: "password123" }) })).json();
  other = new WispClient({ url, token: joined.token });
  const made = await owner.request("POST", "/api/nodes", { name: "box" });
  box = made.node;
  ws = hub.store.node(box.id)!.workspaceId;
  nodeDir = path.join(dir, "node");
  harnessHome = path.join(dir, "home");
  await fsp.mkdir(path.join(harnessHome, ".codex"), { recursive: true });
  await fsp.writeFile(path.join(harnessHome, ".codex", "config.toml"), 'model = "gpt-6.1-sol"\n');
  daemon = new NodeDaemon({ hub: url, token: made.token, name: "box", dir: nodeDir, harnessHome, noPrepare: true }, () => {}, { codex: fakeCodex, "claude-code": fakeClaude });
  daemon.start();
  await waitFor(() => (hub.store.nodeCatalog(box.id).length === 2 ? true : undefined));
  const p = await owner.request("POST", "/api/nodes", { name: "phone" });
  phone = { id: p.node.id, token: p.token };
  device = new FakeDevice();
  await device.connect(phone.token);
});

afterAll(async () => {
  await daemon?.stop(1000);
  device?.ws.close();
  await close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("connecting keys", () => {
  it("checks a key with its provider, keeps it, and never gives it back", async () => {
    await expect(owner.request("POST", "/api/model-connections", { provider: "openrouter", kind: "key", key: "sk-or-bad-key-123" })).rejects.toThrow(/wasn't accepted/);
    await expect(owner.request("POST", "/api/model-connections", { provider: "anthropic", kind: "key", key: "sk-or-v1-looks-like-openrouter" })).rejects.toThrow(/looks like an OpenRouter key/);
    const c = await owner.request("POST", "/api/model-connections", { provider: "openrouter", kind: "key", key: "sk-or-v1-good-a91f" });
    expect(c).toMatchObject({ provider: "openrouter", kind: "key", label: "OpenRouter key", keyHint: "a91f", mine: true, harnesses: ["claude-code", "codex", "hermes"] });
    const { connections } = await owner.request("GET", "/api/model-connections");
    expect(JSON.stringify(connections)).not.toContain("good-a91f");
    // someone else's are theirs alone
    expect((await other.request("GET", "/api/model-connections")).connections).toEqual([]);
    await expect(other.request("PATCH", `/api/model-connections/${c.id}`, { label: "mine now" })).rejects.toThrow(/not found/);
    expect((await owner.request("PATCH", `/api/model-connections/${c.id}`, { label: "Router" })).label).toBe("Router");
  });

  it("lists a connection's models as a harness can run them", async () => {
    const c = (await owner.request("GET", "/api/model-connections")).connections[0];
    const all = await owner.request("GET", `/api/model-connections/${c.id}/models?harness=codex`);
    expect(all.models.map((m: any) => m.id)).toEqual(["anthropic/claude-opus-5.5", "openai/gpt-6.1"]);
    expect(all.models[0]).toMatchObject({ efforts: ["low", "medium", "high"], contextWindow: 1_000_000 });
    // Claude Code reaches OpenRouter through its Anthropic endpoint: Claude models only
    const claude = await owner.request("GET", `/api/model-connections/${c.id}/models?harness=claude-code`);
    expect(claude.models.map((m: any) => m.id)).toEqual(["anthropic/claude-opus-5.5"]);
    expect(claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("serves the providers and the support table", async () => {
    const r = await owner.request("GET", "/api/model-providers");
    expect(r.providers.map((p: any) => p.id)).toEqual(["anthropic", "openai", "openrouter", "google", "xai"]);
    expect(r.support.some((s: any) => s.harness === "codex" && s.provider === "openai" && s.kind === "oauth")).toBe(true);
  });
});

describe("running agents on a connection", () => {
  let nova: any;
  let general: any;
  let oauthId: string;

  beforeAll(async () => {
    general = (await owner.channels()).find((c) => c.name === "general")!;
    nova = await owner.request("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "codex", nodeId: box.id });
    oauthId = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "ChatGPT", secret: { auth: chatgpt("r1") }, account: "me@example.com", plan: "Pro" });
  });

  it("runs as before without one: the harness's own login, no folder of its own", async () => {
    const run = await message(general.id, "@nova hello");
    expect(run.env?.CODEX_HOME).toBeUndefined();
    expect(run.connection).toBeUndefined();
  });

  it("only lets the owner put an agent on their connection, and only one its harness can use", async () => {
    // even on a device that's shared with them, someone else can't put an agent on my connection
    await owner.request("PATCH", `/api/nodes/${box.id}`, { shared: true });
    await expect(other.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: oauthId } })).rejects.toThrow(/only its owner/);
    const key = hub.models.create({ workspaceId: ws, userId: me, provider: "anthropic", kind: "key", label: "Anthropic", secret: { key: "sk-ant-api-1" } });
    await expect(owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: key } })).rejects.toThrow(/Codex can't use a Claude key/);
    await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: oauthId } });
    // a harness that can't use the connection it keeps is refused
    await expect(owner.request("PATCH", `/api/agents/${nova.id}`, { harness: "claude-code" })).rejects.toThrow(/can't use @nova's ChatGPT sign-in/);
  });

  it("hands a ChatGPT sign-in to Codex in a CODEX_HOME of its own, with the agent's settings", async () => {
    const run = await message(general.id, "@nova with my sign-in");
    const home = path.join(nodeDir, "connections", oauthId, "codex");
    expect(run.env?.CODEX_HOME).toBe(home);
    expect(run.connection).toEqual({ provider: "openai", kind: "oauth" });
    expect(JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")).tokens.refresh_token).toBe("r1");
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain("gpt-6.1-sol");
  });

  it("keeps the sign-in Codex renewed, so the next run anywhere uses it", async () => {
    await message(general.id, "@nova renew please");
    await waitFor(() => ((hub.models.secret(oauthId)?.auth as any)?.tokens?.refresh_token === "r2" ? true : undefined));
    await message(general.id, "@nova after renewal");
    expect(JSON.parse(fs.readFileSync(path.join(nodeDir, "connections", oauthId, "codex", "auth.json"), "utf8")).tokens.refresh_token).toBe("r2");
  });

  it("tells the hub about a renewal before the run's outcome, which is what frees the sign-in for the next run", async () => {
    const sent: string[] = [];
    const real = (daemon as any).send.bind(daemon);
    const spy = vi.spyOn(daemon as any, "send").mockImplementation((m: any) => {
      sent.push(m.type);
      return real(m);
    });
    try {
      const fresh = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Order", secret: { auth: chatgpt("r1", new Date(Date.now() - 86_400_000).toISOString()) } });
      await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: fresh } });
      const own = await channelWith("renewal-order", [nova.id]);
      await message(own.id, "@nova renew please");
      await waitFor(() => (sent.includes("run_done") ? true : undefined));
      expect(sent.indexOf("credential_refreshed")).toBeGreaterThan(-1);
      expect(sent.indexOf("credential_refreshed")).toBeLessThan(sent.indexOf("run_done"));
    } finally {
      spy.mockRestore();
      await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: oauthId } });
    }
  });

  it("removes a connection's folder from the device when it's removed, and no other's", async () => {
    const goner = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Goner", secret: { auth: chatgpt("g1") } });
    await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: goner } });
    const own = await channelWith("renewal-gone", [nova.id]);
    await message(own.id, "@nova use it");
    const gone = path.join(nodeDir, "connections", goner);
    const kept = path.join(nodeDir, "connections", oauthId);
    expect(fs.existsSync(path.join(gone, "codex", "auth.json"))).toBe(true);
    await owner.request("DELETE", `/api/model-connections/${goner}`);
    await waitFor(() => (!fs.existsSync(gone) ? true : undefined));
    expect(fs.existsSync(path.join(kept, "codex", "auth.json"))).toBe(true);
    await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: oauthId } });
  });

  it("removes one removed while the device was away, when it's back", async () => {
    const left = path.join(nodeDir, "connections", "mc_removed_meanwhile", "codex", "auth.json");
    fs.mkdirSync(path.dirname(left), { recursive: true });
    fs.writeFileSync(left, "{}");
    await (daemon as any).onMessage({ type: "welcome", nodeId: box.id });
    await waitFor(() => (!fs.existsSync(left) ? true : undefined));
  });

  it("shows the plan's usage on the connection and in the agent's context", async () => {
    const c = (await owner.modelConnections()).find((x) => x.id === oauthId)!;
    expect(c).toMatchObject({ account: "me@example.com", plan: "Pro", usage: { window: "weekly", usedFraction: 0.3, planType: "pro" }, usedBy: [{ handle: "nova" }] });
    expect(c.lastUsedAt).toBeTruthy();
    const ctx = await owner.request("GET", `/api/agents/${nova.id}/context?channel=${general.id}`);
    expect(ctx).toMatchObject({ harness: "codex", model: "gpt-6.1-sol", connection: { id: oauthId, provider: "openai", kind: "oauth" }, plan: { usedFraction: 0.3 }, efforts: ["low", "medium", "high"], contextWindow: 258_000 });
    const models = await owner.request("GET", `/api/agents/${nova.id}/models`);
    expect(models.connection).toMatchObject({ id: oauthId, provider: "openai" });
    expect(models.models.map((m: any) => m.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("starts a fresh session when the harness changes, and keeps chats", async () => {
    const before = await message(general.id, "@nova again");
    expect(before.sessionId).toBe("codex-sess");
    await owner.request("PATCH", `/api/agents/${nova.id}`, { harness: "claude-code", settings: { connectionId: null } });
    const after = await message(general.id, "@nova in claude now", "claude");
    expect(after.sessionId).toBeNull();
    expect(after.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("hands a key to Claude Code in its environment", async () => {
    const key = hub.models.create({ workspaceId: ws, userId: me, provider: "anthropic", kind: "key", label: "Anthropic", secret: { key: "sk-ant-api-42" } });
    await owner.request("PATCH", `/api/agents/${nova.id}`, { settings: { connectionId: key } });
    const run = await message(general.id, "@nova with a key", "claude");
    expect(run.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api-42", CLAUDE_CODE_OAUTH_TOKEN: "" });
    // removing it puts the agent back on the device's own login
    const removed = await owner.request("DELETE", `/api/model-connections/${key}`);
    expect(removed.agents).toEqual([nova.id]);
    expect(hub.store.agent(nova.id)!.settings.connectionId).toBeNull();
  });
});

describe("/effort and /harness", () => {
  it("answers and changes them from chat", async () => {
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const answered = new Set<string>();
    const atlas = await owner.request("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "codex", nodeId: box.id, model: "gpt-6.1-sol" });
    const said = async (text: string) => {
      const sent = await owner.send(general.id, text);
      // the channel is long by now: look at what was posted after this message
      // (one posted in the same millisecond as this message, answering the one before, isn't it)
      const m = await waitFor(() => hub.store.systemNotices(general.id, null, sent.createdAt).find((m) => m.id !== sent.id && !answered.has(m.id) && m.parts.some((p) => p.type === "status" && p.text.startsWith("@atlas"))));
      answered.add(m.id);
      return m.parts.find((p) => p.type === "status") as any;
    };
    expect((await said("@atlas /effort")).text).toContain("It offers low, medium, high");
    expect((await said("@atlas /effort turbo")).text).toContain(`has no "turbo" effort`);
    expect((await said("@atlas /effort high")).text).toContain("will think at high");
    expect(hub.store.agent(atlas.id)!.settings.effort).toBe("high");
    expect((await said("@atlas /harness")).text).toContain("It could also run in Claude Code");
    expect((await said("@atlas /harness claude code")).text).toContain("on its default model");
    expect(hub.store.agent(atlas.id)).toMatchObject({ harness: "claude-code", model: null });
  });
});

describe("signing in once, on a device", () => {
  it("runs the sign-in on the person's device and keeps what it saved as a connection", async () => {
    device.onMessage = (m) => {
      if (m.type !== "model_login") return;
      if (m.op === "start") {
        device.send({ type: "result", requestId: m.requestId, ok: true, result: { id: m.loginId, provider: m.provider, harness: m.harness, status: "running", output: "" } });
        setTimeout(() => device.send({ type: "model_login", login: { id: m.loginId, provider: "openai", harness: "codex", status: "running", output: "", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" } }), 20);
        setTimeout(() => device.send({ type: "model_login_done", loginId: m.loginId, ok: true, secret: { auth: chatgpt("fresh") }, account: "me@example.com", plan: "Pro" }), 80);
      }
    };
    const started = await owner.request("POST", "/api/model-connections/login", { provider: "openai", nodeId: phone.id, label: "Work ChatGPT" });
    expect(started).toMatchObject({ provider: "openai", harness: "codex", status: "running", nodeId: phone.id });
    const seen = await waitFor(async () => {
      const s = await owner.request("GET", `/api/model-connections/login/${started.id}`);
      return s.code ? s : undefined;
    });
    expect(seen).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
    const done = await waitFor(async () => {
      const s = await owner.request("GET", `/api/model-connections/login/${started.id}`);
      return s.status === "done" ? s : undefined;
    });
    const c = (await owner.request("GET", "/api/model-connections")).connections.find((x: any) => x.id === done.connectionId);
    expect(c).toMatchObject({ provider: "openai", kind: "oauth", label: "Work ChatGPT", account: "me@example.com", plan: "Pro" });
    // someone else can't watch it
    await expect(other.request("GET", `/api/model-connections/login/${started.id}`)).rejects.toThrow(/isn't running/);
  });

  it("says when no device can sign in", async () => {
    await expect(owner.request("POST", "/api/model-connections/login", { provider: "openrouter" })).rejects.toThrow(/API key/);
    await expect(owner.request("POST", "/api/model-connections/login", { provider: "xai" })).rejects.toThrow(/has Hermes/);
  });

  it("reads what each sign-in saves", async () => {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-login-test-"));
    expect(readSecret("anthropic", d, "Your token\nsk-ant-oat01-0123456789abcdefghijKLMN\n")).toEqual({ secret: { token: "sk-ant-oat01-0123456789abcdefghijKLMN" } });
    expect(readSecret("openai", d, "")).toBeNull();
    await fsp.writeFile(path.join(d, "auth.json"), JSON.stringify(chatgpt("x")));
    expect(readSecret("openai", d, "")).toMatchObject({ secret: { auth: { tokens: { refresh_token: "x" } } }, account: "me@example.com", plan: "Pro" });
    await fsp.writeFile(path.join(d, "auth.json"), JSON.stringify({ credential_pool: { "xai-oauth": [{ label: "grok", access_token: "a", refresh_token: "r", base_url: "https://api.x.ai/v1", last_refresh: "t" }] } }));
    expect(readSecret("xai", d, "")).toEqual({ secret: { pool: { access_token: "a", refresh_token: "r", base_url: "https://api.x.ai/v1", last_refresh: "t" } }, account: "grok" });
    await fsp.rm(d, { recursive: true, force: true });
  });
});

describe("a sign-in due for renewal", () => {
  it("knows when one is due", () => {
    expect(renewalDue({ auth: chatgpt("r", new Date().toISOString()) })).toBe(false);
    expect(renewalDue({ auth: chatgpt("r", new Date(Date.now() - 7 * 86_400_000).toISOString()) })).toBe(true);
    expect(renewalDue({ auth: { tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }, last_refresh: new Date().toISOString() } })).toBe(true);
    expect(renewalDue({ key: "k" })).toBe(false);
  });

  it("runs one agent at a time on it, and only devices it was handed to can renew it", async () => {
    const stale = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Old", secret: { auth: chatgpt("s1", new Date(Date.now() - 10 * 86_400_000).toISOString()) } });
    const a = await owner.request("POST", "/api/agents", { handle: "ann", name: "Ann", harness: "codex", nodeId: phone.id, settings: { connectionId: stale } });
    const b = await owner.request("POST", "/api/agents", { handle: "bo", name: "Bo", harness: "codex", nodeId: phone.id, settings: { connectionId: stale } });
    // a device it was never handed to can't change it
    device.send({ type: "credential_refreshed", connectionId: stale, secret: { auth: chatgpt("stolen") } });
    await new Promise((r) => setTimeout(r, 100));
    expect((hub.models.secret(stale)?.auth as any).tokens.refresh_token).toBe("s1");
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    await owner.send(general.id, "@ann go");
    await owner.send(general.id, "@bo go");
    await waitFor(() => (runs.length >= 1 ? true : undefined));
    await new Promise((r) => setTimeout(r, 200));
    expect(runs).toHaveLength(1);
    expect(runs[0].run.credential).toMatchObject({ connectionId: stale, provider: "openai", kind: "oauth" });
    expect([a.id, b.id]).toContain(runs[0].run.agentId);
    // the device renews it and finishes: the next run gets the new one
    device.send({ type: "credential_refreshed", connectionId: stale, runId: runs[0].run.runId, secret: { auth: chatgpt("s2") } });
    device.send({ type: "run_done", runId: runs[0].run.runId, finalText: "done" });
    await waitFor(() => (runs.length === 2 ? true : undefined));
    expect((runs[1].run.credential?.secret.auth as any).tokens.refresh_token).toBe("s2");
    device.send({ type: "run_done", runId: runs[1].run.runId, finalText: "done" });
  });
});

describe("catalogs per computer", () => {
  it("keeps what a VM has and uses it for agents that run inside it", async () => {
    const vm = hub.store.createComputer({ workspaceId: ws, name: "Kit's computer", kind: "vm", nodeId: phone.id, config: {}, status: "ready" });
    const kit = await owner.request("POST", "/api/agents", { handle: "kit", name: "Kit", harness: "codex", nodeId: phone.id, computerId: vm.id, settings: { runIn: "computer" } });
    // not reported yet: the device is asked, and the device's own list stands in
    const first = await owner.request("GET", `/api/agents/${kit.id}/models`);
    expect(first.computer).toMatchObject({ id: vm.id, reported: false });
    await waitFor(() => (device.got.some((m) => m.type === "computer_catalog" && m.computer.id === vm.id) ? true : undefined));
    device.send({ type: "catalog", computerId: vm.id, catalog: [{ harness: "codex", version: "codex-cli 0.163.0", models: [{ id: "gpt-6.1-sol", label: "Sol", contextWindow: 258_000 }], efforts: ["low", "medium", "high"], defaultModel: "gpt-6.1-sol" }, { harness: "hermes", version: "Hermes Agent v0.20.0", models: [], efforts: [] }] });
    await waitFor(() => (hub.store.computerCatalog(phone.id, vm.id) ? true : undefined));
    const models = await owner.request("GET", `/api/agents/${kit.id}/models`);
    expect(models.catalog).toMatchObject({ harness: "codex", version: "codex-cli 0.163.0" });
    const ctx = await owner.request("GET", `/api/agents/${kit.id}/context`);
    expect(ctx).toMatchObject({ model: "gpt-6.1-sol", harnessVersion: "codex-cli 0.163.0", contextWindow: 258_000 });
    // a VM of another device can't be reported by this one
    device.send({ type: "catalog", computerId: "cmp_nope", catalog: [] });
    const { computers } = await owner.request("GET", "/api/harnesses");
    const inVm = computers.find((c: any) => c.id === vm.id);
    expect(inVm).toMatchObject({ kind: "vm", reported: true, nodeId: phone.id });
    expect(inVm.harnesses.map((h: any) => h.id)).toEqual(["codex", "hermes"]);
    expect(inVm.harnesses[0].agents.map((a: any) => a.handle)).toEqual(["kit"]);
    expect(computers.find((c: any) => c.id === box.id).harnesses.map((h: any) => h.id).sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("a connection stays with its owner's devices", () => {
  let theirs: { id: string; token: string };
  let theirDevice: FakeDevice;
  let key: string;
  let general: any;
  const runsOn = (d: FakeDevice) => d.got.filter((m): m is Extract<HubToNode, { type: "run" }> => m.type === "run");

  beforeAll(async () => {
    general = (await owner.channels()).find((c) => c.name === "general")!;
    const made = await other.request("POST", "/api/nodes", { name: "their laptop" });
    theirs = { id: made.node.id, token: made.token };
    theirDevice = new FakeDevice();
    await theirDevice.connect(theirs.token);
    key = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "key", label: "OpenAI", secret: { key: "sk-proj-mine-1234" } });
  });

  it("drops the owner's connection when someone else moves the agent to their device", async () => {
    const zed = await owner.request("POST", "/api/agents", { handle: "zed", name: "Zed", harness: "codex", nodeId: box.id, settings: { connectionId: key, respondTo: "anyone" } });
    // box is shared, so the other person may move it, but my key doesn't go along
    const moved = await other.request("PATCH", `/api/agents/${zed.id}`, { nodeId: theirs.id });
    expect(moved.settings.connectionId).toBeNull();
    await other.send(general.id, "@zed hello there");
    const run = await waitFor(() => runsOn(theirDevice).find((m) => m.run.agentId === zed.id));
    expect(run.run.credential).toBeUndefined();
    expect(JSON.stringify(theirDevice.got)).not.toContain("sk-proj-mine-1234");
    theirDevice.send({ type: "run_done", runId: run.run.runId, finalText: "ok" });
  });

  it("won't let the owner move it onto someone else's device with the connection, or put it on one", async () => {
    await other.request("PATCH", `/api/nodes/${theirs.id}`, { shared: true });
    const yan = await owner.request("POST", "/api/agents", { handle: "yan", name: "Yan", harness: "codex", nodeId: box.id, settings: { connectionId: key } });
    await expect(owner.request("PATCH", `/api/agents/${yan.id}`, { nodeId: theirs.id })).rejects.toThrow(/only goes to your own devices/);
    await expect(owner.request("POST", "/api/agents", { handle: "yon", name: "Yon", harness: "codex", nodeId: theirs.id, settings: { connectionId: key } })).rejects.toThrow(/only goes to your own devices/);
    // moving it back to the device's own login works
    expect((await owner.request("PATCH", `/api/agents/${yan.id}`, { nodeId: theirs.id, settings: { connectionId: null } })).nodeId).toBe(theirs.id);
  });

  it("fails a run, rather than handing the secret over, when an agent ended up elsewhere anyway", async () => {
    const xia = await owner.request("POST", "/api/agents", { handle: "xia", name: "Xia", harness: "codex", nodeId: box.id, settings: { connectionId: key } });
    // as it might be in an older database: on their device, still on my key
    hub.store.updateAgent(xia.id, { nodeId: theirs.id });
    const before = runsOn(theirDevice).length;
    const sent = await owner.send(general.id, "@xia go");
    const failed = await waitFor(() => (hub.store.db.prepare("SELECT status, error FROM runs WHERE trigger_message_id = ?").get(sent.id) as { status: string; error: string } | undefined)?.status === "failed" ? (hub.store.db.prepare("SELECT error FROM runs WHERE trigger_message_id = ?").get(sent.id) as { error: string }) : undefined);
    expect(failed.error).toMatch(/@xia is set to use Me's ChatGPT key, which only goes to Me's own devices, and .+ isn't one/);
    await new Promise((r) => setTimeout(r, 100));
    expect(runsOn(theirDevice).length).toBe(before);
    expect(JSON.stringify(theirDevice.got)).not.toContain("sk-proj-mine-1234");
  });
});

describe("renewed sign-ins come back only from the run they were handed to", () => {
  it("ignores a late renewal older than the one it has", async () => {
    const cid = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Late", secret: { auth: chatgpt("l1", "2026-10-30T00:00:00.000Z") } });
    const fay = await owner.request("POST", "/api/agents", { handle: "fay", name: "Fay", harness: "codex", nodeId: phone.id, settings: { connectionId: cid } });
    const general = await channelWith(`renew-${cid}`.toLowerCase().replace(/_/g, "-"), [fay.id]);
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    await owner.send(general.id, "@fay go");
    const run = await waitFor(() => runs.find((r) => r.run.agentId === fay.id));
    device.send({ type: "credential_refreshed", connectionId: cid, runId: run.run.runId, secret: { auth: chatgpt("l3", "2026-10-31T00:00:00.000Z") } });
    await waitFor(() => ((hub.models.secret(cid)?.auth as any).tokens.refresh_token === "l3" ? true : undefined));
    // l2 was sent by a device that was offline, and l3 was made from it: l2 is already dead
    device.send({ type: "credential_refreshed", connectionId: cid, runId: run.run.runId, secret: { auth: chatgpt("l2", "2026-10-30T12:00:00.000Z") } });
    await new Promise((r) => setTimeout(r, 100));
    expect((hub.models.secret(cid)?.auth as any).tokens.refresh_token).toBe("l3");
    device.send({ type: "run_done", runId: run.run.runId, finalText: "ok" });
  });

  it("takes a renewal for a run from before the hub restarted, which it no longer remembers handing out", async () => {
    const cid = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Restart", secret: { auth: chatgpt("h1", "2026-10-30T00:00:00.000Z") } });
    const rena = await owner.request("POST", "/api/agents", { handle: "rena", name: "Rena", harness: "codex", nodeId: phone.id, settings: { connectionId: cid } });
    const general = await channelWith(`renew-${cid}`.toLowerCase().replace(/_/g, "-"), [rena.id]);
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    await owner.send(general.id, "@rena go");
    const run = await waitFor(() => runs.find((r) => r.run.agentId === rena.id));
    // what a restart does: nothing remembered, and this hub started after the run did
    (hub as any).handedOut.delete(run.run.runId);
    const since = (hub as any).handedOutSince;
    (hub as any).handedOutSince = new Date(Date.now() + 1000).toISOString();
    try {
      device.send({ type: "credential_refreshed", connectionId: cid, runId: run.run.runId, secret: { auth: chatgpt("h2", "2026-10-31T00:00:00.000Z") } });
      await waitFor(() => ((hub.models.secret(cid)?.auth as any).tokens.refresh_token === "h2" ? true : undefined));
    } finally {
      (hub as any).handedOutSince = since;
    }
    // a run started since is remembered, so forgetting it means it was over long ago
    (hub as any).handedOut.delete(run.run.runId);
    device.send({ type: "credential_refreshed", connectionId: cid, runId: run.run.runId, secret: { auth: chatgpt("h3", "2026-11-01T00:00:00.000Z") } });
    await new Promise((r) => setTimeout(r, 100));
    expect((hub.models.secret(cid)?.auth as any).tokens.refresh_token).toBe("h2");
    device.send({ type: "run_done", runId: run.run.runId, finalText: "ok" });
  });

  it("holds a sign-in due a renewal after a cancel, until the device says its harness stopped", async () => {
    const stale = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Cancel", secret: { auth: chatgpt("c1", new Date(Date.now() - 10 * 86_400_000).toISOString()) } });
    const lee = await owner.request("POST", "/api/agents", { handle: "wren", name: "Wren", harness: "codex", nodeId: phone.id, settings: { connectionId: stale } });
    const kit = await owner.request("POST", "/api/agents", { handle: "tess", name: "Tess", harness: "codex", nodeId: phone.id, settings: { connectionId: stale } });
    const general = await channelWith("renew-cancel", [lee.id, kit.id]);
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    await owner.send(general.id, "@wren go");
    const first = await waitFor(() => runs.find((r) => r.run.agentId === lee.id));
    await owner.send(general.id, "@tess go");
    await new Promise((r) => setTimeout(r, 200));
    hub.cancelRun(first.run.runId);
    await new Promise((r) => setTimeout(r, 200));
    // Lee's Codex may still be renewing: Kit must not get the old token yet
    expect(runs.some((r) => r.run.agentId === kit.id)).toBe(false);
    device.send({ type: "credential_refreshed", connectionId: stale, runId: first.run.runId, secret: { auth: chatgpt("c2", new Date(Date.now() - 10 * 86_400_000 + 1000).toISOString()) } });
    device.send({ type: "run_failed", runId: first.run.runId, error: "cancelled" });
    const second = await waitFor(() => runs.find((r) => r.run.agentId === kit.id));
    expect((second.run.credential?.secret.auth as any).tokens.refresh_token).toBe("c2");
    device.send({ type: "run_done", runId: second.run.runId, finalText: "ok" });
  });

  it("frees a sign-in when its device drops, and takes a renewal only for a recent run of that device on that connection", async () => {
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const stale = hub.models.create({ workspaceId: ws, userId: me, provider: "openai", kind: "oauth", label: "Due", secret: { auth: chatgpt("d1", new Date(Date.now() - 10 * 86_400_000).toISOString()) } });
    const cy = await owner.request("POST", "/api/agents", { handle: "cy", name: "Cy", harness: "codex", nodeId: phone.id, settings: { connectionId: stale } });
    await owner.request("POST", "/api/agents", { handle: "di", name: "Di", harness: "codex", nodeId: box.id, settings: { connectionId: stale } });
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    await owner.send(general.id, "@cy go");
    await waitFor(() => (runs.some((r) => r.run.agentId === cy.id) ? true : undefined));
    const cyRun = runs.find((r) => r.run.agentId === cy.id)!.run.runId;
    // Di waits its turn while Cy's run holds the sign-in
    const before = calls.length;
    await owner.send(general.id, "@di go");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.length).toBe(before);
    // Cy's device drops (a crash, say): Di goes ahead on the box
    device.ws.close();
    await waitFor(() => (calls.length > before ? true : undefined));
    // the dropped device comes back and sends the sign-in it renewed for Cy's run: still taken
    device = new FakeDevice();
    await device.connect(phone.token);
    // ...but not for a run that isn't on that connection, nor without a run
    device.send({ type: "credential_refreshed", connectionId: stale, secret: { auth: chatgpt("nope1") } });
    device.send({ type: "credential_refreshed", connectionId: stale, runId: "run_nope", secret: { auth: chatgpt("nope2") } });
    await new Promise((r) => setTimeout(r, 100));
    expect((hub.models.secret(stale)?.auth as any).tokens.refresh_token).not.toMatch(/nope/);
    device.send({ type: "credential_refreshed", connectionId: stale, runId: cyRun, secret: { auth: chatgpt("d2") } });
    await waitFor(() => ((hub.models.secret(stale)?.auth as any).tokens.refresh_token === "d2" ? true : undefined));
    // a run still going on a device that dropped may take longer than the grace: its renewal is still taken
    (hub as any).handedOut.get(cyRun).endedAt = Date.now() - 11 * 60_000;
    device.send({ type: "credential_refreshed", connectionId: stale, runId: cyRun, secret: { auth: chatgpt("d3") } });
    await waitFor(() => ((hub.models.secret(stale)?.auth as any).tokens.refresh_token === "d3" ? true : undefined));
    device.send({ type: "run_done", runId: cyRun, finalText: "done" });
    await waitFor(() => (hub.store.run(cyRun)?.status !== "running" ? true : undefined));
    // long after the run, it isn't
    (hub as any).handedOut.get(cyRun).endedAt = Date.now() - 11 * 60_000;
    device.send({ type: "credential_refreshed", connectionId: stale, runId: cyRun, secret: { auth: chatgpt("late") } });
    await new Promise((r) => setTimeout(r, 100));
    expect((hub.models.secret(stale)?.auth as any).tokens.refresh_token).toBe("d3");
  });

  it("never takes a renewal for a connection that doesn't rotate", async () => {
    const token = hub.models.create({ workspaceId: ws, userId: me, provider: "anthropic", kind: "oauth", label: "Claude", secret: { token: "sk-ant-oat01-original" } });
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const ivy = await owner.request("POST", "/api/agents", { handle: "ivy", name: "Ivy", harness: "claude-code", nodeId: phone.id, settings: { connectionId: token } });
    const runs: Extract<HubToNode, { type: "run" }>[] = [];
    device.onMessage = (m) => {
      if (m.type === "run") runs.push(m);
    };
    await owner.send(general.id, "@ivy go");
    const run = await waitFor(() => runs.find((r) => r.run.agentId === ivy.id));
    device.send({ type: "credential_refreshed", connectionId: token, runId: run.run.runId, secret: { token: "sk-ant-oat01-swapped" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.models.secret(token)?.token).toBe("sk-ant-oat01-original");
    device.send({ type: "run_done", runId: run.run.runId, finalText: "ok" });
  });
});

/** A channel of its own with these agents in it (general's wake-up limit is used up by now). */
async function channelWith(name: string, agentIds: string[]) {
  return owner.request("POST", "/api/channels", { name, members: agentIds.map((id) => ({ kind: "agent", id })) });
}

describe("models across a harness switch", () => {
  it("keeps a model on /harness only when the new harness can run it from the connection", async () => {
    const router = hub.models.create({ workspaceId: ws, userId: me, provider: "openrouter", kind: "key", label: "Router", secret: { key: "sk-or-v1-switch" } });
    const answered = new Set<string>();
    const said = async (handle: string, text: string) => {
      const sent = await owner.send(general.id, text);
      const m = await waitFor(() => hub.store.systemNotices(general.id, null, sent.createdAt).find((m) => m.id !== sent.id && !answered.has(m.id) && m.parts.some((p) => p.type === "status" && p.text.startsWith(`@${handle}`))));
      answered.add(m.id);
      return m.parts.find((p) => p.type === "status") as any;
    };
    // GPT on OpenRouter: Claude Code reaches OpenRouter for Claude models only
    const gus = await owner.request("POST", "/api/agents", { handle: "gus", name: "Gus", harness: "codex", nodeId: box.id, model: "openai/gpt-6.1", settings: { connectionId: router } });
    const hal = await owner.request("POST", "/api/agents", { handle: "hal", name: "Hal", harness: "codex", nodeId: box.id, model: "anthropic/claude-opus-5.5", settings: { connectionId: router } });
    const general = await channelWith("switching", [gus.id, hal.id]);
    expect((await said("gus", "@gus /harness claude code")).text).toContain("on its default model");
    expect(hub.store.agent(gus.id)).toMatchObject({ harness: "claude-code", model: null });
    // Claude on OpenRouter: Claude Code runs it, so it stays
    expect((await said("hal", "@hal /harness claude code")).text).not.toContain("default model");
    expect(hub.store.agent(hal.id)).toMatchObject({ harness: "claude-code", model: "anthropic/claude-opus-5.5" });
  });

  it("runs an agent with no model picked on one its connection offers, not the harness's own setting", async () => {
    const router = hub.models.create({ workspaceId: ws, userId: me, provider: "openrouter", kind: "key", label: "Router 2", secret: { key: "sk-or-v1-default" } });
    const ola = await owner.request("POST", "/api/agents", { handle: "ola", name: "Ola", harness: "codex", nodeId: box.id, settings: { connectionId: router } });
    const general = await channelWith("defaults", [ola.id]);
    // config.toml says gpt-6.1-sol, which OpenRouter doesn't have under that name
    const run = await message(general.id, "@ola hi");
    expect(run.model).toBe("anthropic/claude-opus-5.5");
  });
});

describe("what /context shows after a switch", () => {
  it("doesn't show the last reply's model when it ran in another harness", async () => {
    const pia = await owner.request("POST", "/api/agents", { handle: "pia", name: "Pia", harness: "codex", nodeId: box.id });
    const ch = await channelWith("context-switch", [pia.id]);
    await message(ch.id, "@pia hi");
    expect(await owner.request("GET", `/api/agents/${pia.id}/context?channel=${ch.id}`)).toMatchObject({ model: "gpt-6.1-sol", modelLabel: "GPT-6.1 Sol", contextUsed: 1000 });
    await owner.request("PATCH", `/api/agents/${pia.id}`, { harness: "claude-code" });
    const ctx = await owner.request("GET", `/api/agents/${pia.id}/context?channel=${ch.id}`);
    expect(ctx).toMatchObject({ harness: "claude-code", model: null, contextUsed: null, contextWindow: null });
  });

  it("shows the model a connection's next run uses, by its name", async () => {
    const router = hub.models.create({ workspaceId: ws, userId: me, provider: "openrouter", kind: "key", label: "Router 3", secret: { key: "sk-or-v1-ctx" } });
    const quin = await owner.request("POST", "/api/agents", { handle: "quin", name: "Quin", harness: "claude-code", nodeId: box.id, settings: { connectionId: router } });
    const ctx = await owner.request("GET", `/api/agents/${quin.id}/context`);
    expect(ctx).toMatchObject({ model: "anthropic/claude-opus-5.5", modelLabel: "Claude Opus 5.5", modelIsDefault: true });
  });
});

describe("what others see of my connection", () => {
  it("shows its account to its owner only, and only the owner can ask the provider again (not too often)", async () => {
    const signin = hub.models.create({ workspaceId: ws, userId: me, provider: "anthropic", kind: "oauth", label: "Claude", secret: { token: "sk-ant-oat01-acct" }, account: "me@example.com", plan: "Max" });
    const rae = await owner.request("POST", "/api/agents", { handle: "rae", name: "Rae", harness: "claude-code", nodeId: box.id, settings: { connectionId: signin } });
    expect((await owner.request("GET", `/api/agents/${rae.id}/context`)).connection.account).toBe("me@example.com");
    expect((await owner.request("GET", `/api/agents/${rae.id}/models`)).connection.account).toBe("me@example.com");
    const ctx = await other.request("GET", `/api/agents/${rae.id}/context`);
    expect(ctx.connection).toMatchObject({ id: signin, plan: "Max", account: null });
    expect((await other.request("GET", `/api/agents/${rae.id}/models`)).connection.account).toBeNull();

    const key = hub.models.create({ workspaceId: ws, userId: me, provider: "openrouter", kind: "key", label: "Router 4", secret: { key: "sk-or-v1-fresh" } });
    const sam = await owner.request("POST", "/api/agents", { handle: "sam", name: "Sam", harness: "codex", nodeId: box.id, settings: { connectionId: key } });
    let asked = 0;
    const real = hub.fetchImpl;
    hub.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://openrouter.ai/api/v1/models")) asked++;
      return real(input, init);
    }) as typeof fetch;
    try {
      await owner.request("GET", `/api/model-connections/${key}/models?agent=${sam.id}`);
      expect(asked).toBe(1);
      // someone else's fresh=1 is served from the cache
      for (let i = 0; i < 3; i++) await other.request("GET", `/api/model-connections/${key}/models?agent=${sam.id}&fresh=1`);
      expect(asked).toBe(1);
      // the owner's is fetched, but not again right away
      await owner.request("GET", `/api/model-connections/${key}/models?agent=${sam.id}&fresh=1`);
      await owner.request("GET", `/api/model-connections/${key}/models?agent=${sam.id}&fresh=1`);
      expect(asked).toBe(2);
    } finally {
      hub.fetchImpl = real;
    }
  });
});
