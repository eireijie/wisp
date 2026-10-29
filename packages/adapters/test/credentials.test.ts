import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunCredential } from "@wisp/core";
import { claudePlan, codexArgs, codexConnectionArgs, codexPlan, codexUsageFromRollout, localCredentialFs, prepareCredential, runCodexHome, setupTokenFrom } from "../src/index.ts";
import { codexAuthFromHermes, hermesEntryFromCodex } from "../src/credentials.ts";

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-cred-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const cred = (provider: RunCredential["provider"], kind: RunCredential["kind"], secret: RunCredential["secret"]): RunCredential => ({ connectionId: "mc_test", provider, kind, secret });
const chatgpt = (refresh: string, at = "2026-10-28T00:00:00.000Z") => ({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id", access_token: `a-${refresh}`, refresh_token: refresh, account_id: "acct" }, last_refresh: at });
const read = (f: string) => fs.readFile(f, "utf8");

/** a harness folder like the agent's own, with settings and a login of its own that must not be copied */
async function base(name: string, files: Record<string, string>) {
  const d = path.join(dir, name);
  await fs.mkdir(path.join(d, "skills", "a-skill"), { recursive: true });
  for (const [f, t] of Object.entries(files)) await fs.writeFile(path.join(d, f), t);
  return d;
}

describe("handing a connection to Claude Code", () => {
  const at = { fs: localCredentialFs, baseHome: "/unused", connectionHome: "/unused" };
  it("puts a key, a token or OpenRouter in the environment, clearing what would win over it", async () => {
    expect((await prepareCredential("claude-code", cred("anthropic", "key", { key: "sk-ant-api-1" }), at)).env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api-1", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "" });
    expect((await prepareCredential("claude-code", cred("anthropic", "oauth", { token: "sk-ant-oat01-x" }), at)).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" });
    expect((await prepareCredential("claude-code", cred("openrouter", "key", { key: "sk-or-1" }), at)).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "sk-or-1", ANTHROPIC_API_KEY: "" });
    expect(await (await prepareCredential("claude-code", cred("anthropic", "key", { key: "k" }), at)).refreshed()).toBeNull();
  });

  it("refuses what the table doesn't have, and a connection missing its secret", async () => {
    await expect(prepareCredential("claude-code", cred("openai", "key", { key: "k" }), at)).rejects.toThrow(/can't use a ChatGPT key/);
    await expect(prepareCredential("claude-code", cred("anthropic", "oauth", {}), at)).rejects.toThrow(/no token/);
  });
});

describe("handing a connection to Codex", () => {
  it("keeps keys in the environment and the agent's own folder", async () => {
    const at = { fs: localCredentialFs, baseHome: "/unused", connectionHome: "/unused" };
    expect((await prepareCredential("codex", cred("openai", "key", { key: "sk-1" }), at)).env).toEqual({ CODEX_API_KEY: "sk-1" });
    expect((await prepareCredential("codex", cred("openrouter", "key", { key: "sk-or-1" }), at)).env).toEqual({ OPENROUTER_API_KEY: "sk-or-1" });
  });

  it("gives a ChatGPT sign-in a CODEX_HOME of its own, with the agent's settings but not its login", async () => {
    const baseHome = await base("codex-base", { "config.toml": 'model = "gpt-6.1-sol"\n', "auth.json": JSON.stringify(chatgpt("the-agents-own")) });
    const connectionHome = path.join(dir, "conns", "mc_test", "codex");
    const p = await prepareCredential("codex", cred("openai", "oauth", { auth: chatgpt("r1") }), { fs: localCredentialFs, baseHome, connectionHome });
    expect(p.env).toEqual({ CODEX_HOME: connectionHome });
    expect(JSON.parse(await read(path.join(connectionHome, "auth.json"))).tokens.refresh_token).toBe("r1");
    expect((await fs.stat(path.join(connectionHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await read(path.join(connectionHome, "config.toml"))).toContain("gpt-6.1-sol");
    expect((await fs.lstat(path.join(connectionHome, "skills"))).isSymbolicLink()).toBe(true);
    // nothing renewed: nothing to send back
    expect(await p.refreshed()).toBeNull();
    // Codex renewed it during the run: the new one goes back
    await fs.writeFile(path.join(connectionHome, "auth.json"), JSON.stringify(chatgpt("r2", "2026-10-29T00:00:00.000Z")));
    expect((await p.refreshed())?.auth).toMatchObject({ tokens: { refresh_token: "r2" } });
  });

  it("keeps a sign-in renewed on this device over the hub's older copy, and reports it", async () => {
    const baseHome = await base("codex-base-2", {});
    const connectionHome = path.join(dir, "conns", "mc_newer", "codex");
    await fs.mkdir(connectionHome, { recursive: true });
    await fs.writeFile(path.join(connectionHome, "auth.json"), JSON.stringify(chatgpt("renewed-here", "2026-10-29T00:00:00.000Z")));
    const p = await prepareCredential("codex", cred("openai", "oauth", { auth: chatgpt("hub-old", "2026-10-20T00:00:00.000Z") }), { fs: localCredentialFs, baseHome, connectionHome });
    expect(JSON.parse(await read(path.join(connectionHome, "auth.json"))).tokens.refresh_token).toBe("renewed-here");
    expect((await p.refreshed())?.auth).toMatchObject({ tokens: { refresh_token: "renewed-here" } });
  });

  it("adds the flags a connection needs, and reads the session from the run's own CODEX_HOME", () => {
    expect(codexConnectionArgs({ provider: "openrouter", kind: "key" }).join(" ")).toContain('model_providers.openrouter.env_key="OPENROUTER_API_KEY"');
    expect(codexConnectionArgs({ provider: "openai", kind: "oauth" })).toEqual(["-c", 'cli_auth_credentials_store="file"']);
    expect(codexConnectionArgs({ provider: "openai", kind: "key" })).toEqual([]);
    expect(codexArgs({ prompt: "", cwd: "/", connection: { provider: "openrouter", kind: "key" } })).toContain('model_provider="openrouter"');
    expect(runCodexHome({ env: { CODEX_HOME: "/x/conn" } })).toBe("/x/conn");
    expect(runCodexHome({ place: { home: "/home/wisp", readFile: async () => null, readDir: async () => [] } })).toBe("/home/wisp/.codex");
  });
});

describe("handing a connection to Hermes", () => {
  it("gives it a HERMES_HOME whose config picks the provider and whose .env has only the connection's key", async () => {
    const baseHome = await base("hermes-base", { "config.yaml": "model:\n  default: gpt-5.6-luna\n  provider: openai-codex # mine\nagent:\n  max_turns: 90\n", ".env": "OPENROUTER_API_KEY=sk-or-mine\nFIRECRAWL_API_KEY=fc-1\n" });
    const connectionHome = path.join(dir, "conns", "mc_key", "hermes");
    const p = await prepareCredential("hermes", cred("anthropic", "key", { key: "sk-ant-api-9" }), { fs: localCredentialFs, baseHome, connectionHome });
    expect(p.env).toEqual({ HERMES_HOME: connectionHome });
    const config = await read(path.join(connectionHome, "config.yaml"));
    expect(config).toContain("provider: anthropic");
    expect(config).toContain("max_turns: 90");
    const env = await read(path.join(connectionHome, ".env"));
    expect(env).toContain("FIRECRAWL_API_KEY=fc-1");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-api-9");
    expect(env).not.toContain("sk-or-mine");
    expect(JSON.parse(await read(path.join(connectionHome, "auth.json"))).credential_pool).toEqual({});
  });

  it("sets the model the hub picked from the connection, so another provider's default isn't sent to it", async () => {
    const baseHome = await base("hermes-base-model", { "config.yaml": "model:\n  default: gpt-5.6-luna\n  provider: openai-codex\n" });
    const connectionHome = path.join(dir, "conns", "mc_or", "hermes");
    await prepareCredential("hermes", { ...cred("openrouter", "key", { key: "sk-or-v1-x" }), model: "anthropic/claude-opus-5.5" }, { fs: localCredentialFs, baseHome, connectionHome });
    const config = await read(path.join(connectionHome, "config.yaml"));
    expect(config).toContain("provider: openrouter");
    expect(config).toContain("default: anthropic/claude-opus-5.5");
    expect(config).not.toContain("gpt-5.6-luna");
  });

  it("puts a ChatGPT sign-in in its credential pool and sends a renewal back as Codex's auth.json", async () => {
    const baseHome = await base("hermes-base-2", {});
    const connectionHome = path.join(dir, "conns", "mc_oauth", "hermes");
    const p = await prepareCredential("hermes", cred("openai", "oauth", { auth: chatgpt("r1") }), { fs: localCredentialFs, baseHome, connectionHome });
    const auth = JSON.parse(await read(path.join(connectionHome, "auth.json")));
    expect(auth.active_provider).toBe("openai-codex");
    expect(auth.credential_pool["openai-codex"][0]).toMatchObject({ auth_type: "oauth", source: "manual:device_code", refresh_token: "r1", base_url: "https://chatgpt.com/backend-api/codex" });
    expect(await read(path.join(connectionHome, "config.yaml"))).toContain("provider: openai-codex");
    expect(await p.refreshed()).toBeNull();
    auth.credential_pool["openai-codex"][0] = { ...auth.credential_pool["openai-codex"][0], access_token: "a2", refresh_token: "r2", last_refresh: "2026-10-30T00:00:00.000Z" };
    await fs.writeFile(path.join(connectionHome, "auth.json"), JSON.stringify(auth));
    // what Hermes doesn't track (the id token, the account) is kept
    expect((await p.refreshed())?.auth).toMatchObject({ tokens: { refresh_token: "r2", access_token: "a2", id_token: "id", account_id: "acct" }, last_refresh: "2026-10-30T00:00:00.000Z" });
  });

  it("converts between Codex's and Hermes's shapes", () => {
    expect(hermesEntryFromCodex({ tokens: { access_token: "a" } })).toBeNull();
    expect(codexAuthFromHermes({}, { access_token: "a", refresh_token: "r", last_refresh: "t" })).toEqual({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "a", refresh_token: "r" }, last_refresh: "t" });
  });
});

describe("plan usage harnesses report", () => {
  it("reads Claude Code's rate_limit_event", () => {
    const p = claudePlan({ status: "allowed", resetsAt: 1793600000, rateLimitType: "five_hour", utilization: 0.26, unifiedWindows: { five_hour: { utilization: 0.26, resetsAt: 1793600000 }, seven_day: { utilization: 0.4, resetsAt: 1794000000 } } });
    expect(p).toMatchObject({ window: "weekly", usedFraction: 0.4, resetsAt: new Date(1794000000 * 1000).toISOString() });
    expect(p?.windows?.map((w) => w.window)).toEqual(["5-hour", "weekly"]);
    expect(claudePlan({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 })).toMatchObject({ window: "5-hour", usedFraction: 0.1, resetsAt: null });
    expect(claudePlan(null)).toBeUndefined();
  });

  it("reads Codex's rate_limits from its session file", () => {
    expect(codexPlan({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 1793602994 }, secondary: null, plan_type: "pro" })).toMatchObject({ window: "weekly", usedFraction: 0.01, planType: "pro" });
    const rollout = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5 }, model_context_window: 100 }, rate_limits: { primary: { used_percent: 74, window_minutes: 300, resets_at: 1793602994 } } } }),
    ].join("\n");
    expect(codexUsageFromRollout(rollout)).toMatchObject({ model: "gpt-6.1-sol", contextUsed: 15, plan: { window: "5-hour", usedFraction: 0.74 } });
  });

  it("finds the token `claude setup-token` prints", () => {
    expect(setupTokenFrom("Your token:\n\u001b[1msk-ant-oat01-AbC_d-0123456789abcdefghij\u001b[0m\nStore this token securely.")).toBe("sk-ant-oat01-AbC_d-0123456789abcdefghij");
    expect(setupTokenFrom("Paste code here if prompted >")).toBeNull();
  });
});
