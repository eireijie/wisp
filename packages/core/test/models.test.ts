import { describe, expect, it } from "vitest";
import { CREDENTIAL_SUPPORT, HubToNode, MODEL_PROVIDERS, MODEL_PROVIDER_INFO, NodeToHub, RunRequest, chatgptAccount, credentialSupport, harnessesFor, hermesProvider, keyHint, planFromWindows } from "../src/index.ts";

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("model connections: which harness runs which connection", () => {
  it("has one row per harness, provider and kind, each with a way to hand it over", () => {
    const keys = CREDENTIAL_SUPPORT.map((s) => `${s.harness}/${s.provider}/${s.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of CREDENTIAL_SUPPORT) {
      expect(MODEL_PROVIDERS).toContain(s.provider);
      if (s.how === "env") expect(s.env?.length).toBeGreaterThan(0);
    }
  });

  it("answers what was checked against the real harnesses", () => {
    expect(credentialSupport("claude-code", "anthropic", "oauth")).toMatchObject({ how: "env", env: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(credentialSupport("claude-code", "anthropic", "key")).toMatchObject({ env: ["ANTHROPIC_API_KEY"] });
    expect(credentialSupport("codex", "openai", "key")).toMatchObject({ env: ["CODEX_API_KEY"] });
    expect(credentialSupport("codex", "openai", "oauth")).toMatchObject({ how: "home", rotates: true });
    expect(credentialSupport("hermes", "openai", "oauth")).toMatchObject({ how: "home", rotates: true });
    // a Claude sign-in can't drive Codex, and Codex has no Google provider
    expect(credentialSupport("codex", "anthropic", "oauth")).toBeNull();
    expect(credentialSupport("codex", "google", "key")).toBeNull();
    expect(credentialSupport("kimi", "openai", "key")).toBeNull();
    expect(harnessesFor("openrouter", "key").sort()).toEqual(["claude-code", "codex", "hermes"]);
    expect(harnessesFor("anthropic", "oauth").sort()).toEqual(["claude-code", "hermes"]);
  });

  it("names Hermes's providers its own way", () => {
    expect(hermesProvider("openai", "oauth")).toBe("openai-codex");
    expect(hermesProvider("openai", "key")).toBe("openai-api");
    expect(hermesProvider("google", "key")).toBe("gemini");
    expect(hermesProvider("xai", "oauth")).toBe("xai-oauth");
  });

  it("signs in only where a harness can", () => {
    expect(MODEL_PROVIDER_INFO.anthropic.signIn?.[0].harness).toBe("claude-code");
    expect(MODEL_PROVIDER_INFO.openai.signIn?.[0].harness).toBe("codex");
    expect(MODEL_PROVIDER_INFO.openrouter.signIn).toBeUndefined();
  });

  it("shows a key's last four and who a ChatGPT sign-in belongs to", () => {
    expect(keyHint("sk-or-v1-abcdefa91f")).toBe("a91f");
    expect(chatgptAccount({ tokens: { id_token: jwt({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) } })).toEqual({ account: "me@example.com", plan: "Pro" });
    expect(chatgptAccount({ tokens: { id_token: "not-a-jwt" } })).toEqual({ account: null, plan: null });
    expect(chatgptAccount(undefined)).toEqual({ account: null, plan: null });
  });

  it("sums up a plan by its busiest window", () => {
    const p = planFromWindows([{ window: "5-hour", usedFraction: 0.2, resetsAt: null }, { window: "weekly", usedFraction: 0.74, resetsAt: "2026-11-01T00:00:00.000Z" }], "max");
    expect(p).toMatchObject({ window: "weekly", usedFraction: 0.74, planType: "max" });
    expect(p?.windows).toHaveLength(2);
    expect(planFromWindows([])).toBeUndefined();
  });
});

describe("model connections on the wire", () => {
  const run = { runId: "r", agentId: "a", channelId: "c", threadId: null, prompt: "hi", hop: 0 };

  it("carries a credential with a run, and a run without one still parses", () => {
    const parsed = RunRequest.parse({ ...run, credential: { connectionId: "mc_1", provider: "openai", kind: "oauth", secret: { auth: { tokens: { refresh_token: "r" } } } } });
    expect(parsed.credential?.provider).toBe("openai");
    expect(RunRequest.parse(run).credential).toBeUndefined();
    // a device from before connections drops what it doesn't know rather than failing
    expect(HubToNode.safeParse({ type: "run", run: { ...run, credential: { connectionId: "mc_1", provider: "anthropic", kind: "key", secret: { key: "k" } } } }).success).toBe(true);
  });

  it("reports renewed sign-ins, VM catalogs and sign-in progress", () => {
    expect(NodeToHub.parse({ type: "credential_refreshed", connectionId: "mc_1", secret: { auth: { last_refresh: "x" } } }).type).toBe("credential_refreshed");
    expect(NodeToHub.parse({ type: "catalog", catalog: [], computerId: "cmp_1" })).toMatchObject({ computerId: "cmp_1" });
    expect(NodeToHub.parse({ type: "catalog", catalog: [] })).not.toHaveProperty("computerId");
    expect(NodeToHub.parse({ type: "model_login", login: { id: "ml_1", provider: "openai", harness: "codex", status: "running", output: "", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" } }).type).toBe("model_login");
    expect(NodeToHub.parse({ type: "model_login_done", loginId: "ml_1", ok: true, secret: { token: "sk-ant-oat01-x" } }).type).toBe("model_login_done");
    expect(NodeToHub.safeParse({ type: "run_event", runId: "r", event: { type: "usage", plan: { window: "weekly", usedFraction: 0.3, resetsAt: null } } }).success).toBe(true);
    expect(HubToNode.parse({ type: "model_login", requestId: "q", op: "start", loginId: "ml_1", provider: "anthropic", harness: "claude-code" }).type).toBe("model_login");
  });
});
