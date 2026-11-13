import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_SUPPORT, MODEL_PROVIDER_INFO, type ModelConnection } from "@wisp/core";
// the helpers are pure; the store (which reads the browser) only backs the hooks
vi.mock("../src/store.ts", () => ({ useStore: Object.assign(() => 0, { subscribe: () => () => {} }) }));
import { agentComputer, canUse, connectWays, readyConnection, signInProvider, connectionName, connectionSub, connectionsFor, contextLine, effortShort, modelName, planLeft, runLine, siteName, windowName, type AgentContext, type AgentModels, type HarnessComputer } from "../src/models.ts";

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  harness: "hermes",
  harnessVersion: "0.20",
  model: "claude-opus-5-5",
  modelIsDefault: false,
  effort: "high",
  effortIsDefault: false,
  access: "edit",
  fast: false,
  fastAvailable: false,
  fastDescription: null,
  contextUsed: 98_000,
  contextWindow: 258_000,
  lastRunAt: null,
  efforts: ["low", "medium", "high", "max"],
  connection: { id: "mc1", provider: "anthropic", kind: "oauth", label: "Claude", account: "yug@example.com", plan: "Max" },
  plan: null,
  ...over,
});
const models = (over: Partial<AgentModels> = {}): AgentModels => ({ device: null, computer: null, catalog: null, connection: null, models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }], ...over });
const conn = (over: Partial<ModelConnection>): ModelConnection => ({
  id: "c",
  provider: "anthropic",
  kind: "oauth",
  label: "Claude",
  account: null,
  plan: null,
  keyHint: null,
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
  lastError: null,
  usage: null,
  usedBy: [],
  harnesses: [],
  mine: true,
  ...over,
});

describe("the chat's model line", () => {
  it("reads harness · model · effort on phones and model · effort on desktops", () => {
    expect(runLine(ctx(), models(), true)).toBe("Hermes · Opus 5.5 · High");
    expect(runLine(ctx(), models(), false)).toBe("Opus 5.5 · High");
  });

  it("names the model from the computer's catalog, and its provider from the connection or the harness's own sign-in", () => {
    expect(modelName(ctx(), models())).toEqual({ name: "Opus 5.5", provider: "Claude" });
    const own = ctx({ harness: "codex", model: "gpt-6.1-sol", connection: null });
    expect(modelName(own, models({ models: null, catalog: { harness: "codex", version: null, efforts: [], models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }] } }))).toEqual({ name: "GPT-6.1 Sol", provider: "ChatGPT" });
    expect(modelName(ctx({ model: null, connection: null }), null)).toEqual({ name: "Default model", provider: null });
  });

  it("leaves effort out when the model has none", () => {
    expect(runLine(ctx({ effort: null }), models(), true)).toBe("Hermes · Opus 5.5");
  });

  it("shortens effort names when many share the row", () => {
    expect(effortShort("xhigh", true)).toBe("X-High");
    expect(effortShort("xhigh", false)).toBe("Extra high");
    expect(effortShort("high", true)).toBe("High");
  });
});

describe("context and plan", () => {
  it("says how full the context is", () => {
    expect(contextLine(ctx())).toEqual({ pct: (98 / 258) * 100, left: "Context 38%", right: "98K of 258K" });
    expect(contextLine(ctx({ contextUsed: null }))).toMatchObject({ pct: null, left: "Context", right: "258K window" });
  });

  it("says how much of a plan is left and when it resets", () => {
    const now = new Date(2026, 9, 29, 0, 10);
    const at = new Date(2026, 9, 29, 1, 40);
    const r = planLeft({ usedFraction: 0.74, resetsAt: at.toISOString() }, now);
    expect(r.left).toBe(26);
    expect(r.text).toMatch(/^26% left · resets 1:40/);
    expect(planLeft({ usedFraction: 1.4, resetsAt: null }).text).toBe("0% left");
  });

  it("names plan windows plainly", () => {
    expect(windowName("5-hour")).toBe("5-hour window");
    expect(windowName("weekly")).toBe("This week");
  });
});

describe("connections", () => {
  it("describes a sign-in and a key", () => {
    expect(connectionSub(conn({ plan: "Max", account: "yug@example.com" }))).toBe("Signed in · Max · yug@example.com");
    expect(connectionSub(conn({ plan: "Max", account: "yug@example.com" }), true)).toBe("Signed in · Max");
    expect(connectionSub(conn({ kind: "key", keyHint: "a91f" }))).toBe("Key ····a91f");
  });

  it("goes by its provider, or its own name when there are two of a provider", () => {
    const a = conn({ id: "a", label: "Work" });
    const b = conn({ id: "b", label: "Home" });
    const o = conn({ id: "o", provider: "openrouter", label: "OpenRouter key" });
    expect(connectionName(o, [a, o])).toBe("OpenRouter");
    expect(connectionName(a, [a, b])).toBe("Work");
  });

  it("offers only connections the harness can use", () => {
    const list = [conn({ id: "a", harnesses: ["claude-code", "hermes"] }), conn({ id: "b", provider: "google", kind: "key", harnesses: ["hermes"] })];
    expect(connectionsFor("claude-code", list).map((c) => c.id)).toEqual(["a"]);
    expect(connectionsFor("hermes", list).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("checks a harness against the support table", () => {
    expect(canUse(CREDENTIAL_SUPPORT, "codex", { provider: "openai", kind: "oauth" })).toBe(true);
    expect(canUse(CREDENTIAL_SUPPORT, "codex", { provider: "anthropic", kind: "oauth" })).toBe(false);
    expect(canUse(CREDENTIAL_SUPPORT, "codex", null)).toBe(true);
  });

  it("offers a sign-in only where the provider has one", () => {
    expect(connectWays(MODEL_PROVIDER_INFO.anthropic)).toEqual(["oauth", "key"]);
    expect(connectWays(MODEL_PROVIDER_INFO.openrouter)).toEqual(["key"]);
    expect(siteName("https://claude.ai/oauth/authorize?x=1")).toBe("claude.ai");
  });
});

describe("the agent's computer", () => {
  const computers: HarnessComputer[] = [
    { id: "n1", kind: "device", name: "MacBook", nodeId: "n1", online: true, reported: true, harnesses: [] },
    { id: "vm1", kind: "vm", name: "agent's desk", nodeId: "n1", online: true, reported: true, harnesses: [] },
  ];
  it("is its VM when it runs in one, else its device", () => {
    expect(agentComputer({ nodeId: "n1" }, { computer: { id: "vm1", name: "agent's desk", reported: true } }, computers)?.name).toBe("agent's desk");
    expect(agentComputer({ nodeId: "n1" }, { computer: null }, computers)?.name).toBe("MacBook");
  });
});

describe("signing in once in setup", () => {
  it("knows which provider a harness signs in to through Wisp", () => {
    expect(signInProvider("claude-code")).toBe("anthropic");
    expect(signInProvider("codex")).toBe("openai");
    // Hermes keeps its many sign-ins where it runs
    expect(signInProvider("hermes")).toBeNull();
    expect(signInProvider("gemini")).toBeNull();
  });
  it("counts only the person's own connection whose sign-in still works", () => {
    const c = (over: Partial<ModelConnection>) => ({ id: "mc", provider: "anthropic", kind: "oauth", harnesses: ["claude-code"], mine: true, lastError: null, ...over }) as ModelConnection;
    expect(readyConnection("claude-code", [c({ id: "dead", lastError: "OAuth session expired" }), c({ id: "ok" })])?.id).toBe("ok");
    expect(readyConnection("claude-code", [c({ mine: false })])).toBeUndefined();
    expect(readyConnection("codex", [c({})])).toBeUndefined();
  });
});
