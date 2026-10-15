import { describe, expect, it } from "vitest";
import { parseClaudeLine, parseCodexLine } from "../src/index.ts";

describe("claude stream-json", () => {
  it("maps init, text, tool use and results", () => {
    const names = new Map<string, string>();
    expect(parseClaudeLine({ type: "system", subtype: "init", session_id: "s1" }, names)).toEqual([{ type: "session", id: "s1" }]);
    expect(
      parseClaudeLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "mcp__warren__memory_search", input: { q: "x" } }] } }, names),
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_call", name: "mcp__warren__memory_search", input: { q: "x" } },
    ]);
    expect(parseClaudeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "found" }] }] } }, names)).toEqual([
      { type: "tool_result", name: "mcp__warren__memory_search", output: "found" },
    ]);
  });
});

describe("codex exec --json", () => {
  it("maps thread, commands, messages, failures", () => {
    expect(parseCodexLine({ type: "thread.started", thread_id: "th" })).toEqual([{ type: "session", id: "th" }]);
    expect(parseCodexLine({ type: "item.started", item: { type: "command_execution", command: "ls" } })).toEqual([{ type: "tool_call", name: "shell", input: { command: "ls" } }]);
    expect(parseCodexLine({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual([{ type: "text", text: "done" }]);
    expect(parseCodexLine({ type: "turn.failed", error: { message: "quota" } })).toEqual([{ type: "error", message: "quota" }]);
    expect(parseCodexLine({ type: "turn.completed" })).toEqual([]);
  });
});

import { claudeArgs, claudeEnv, codexArgs, parseCodexCatalog } from "../src/index.ts";

describe("model, effort and access flags", () => {
  it("claude", () => {
    const a = claudeArgs({ prompt: "", cwd: "/", model: "opus", effort: "high", access: "read-only", sessionId: "s1" });
    expect(a).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high", "--resume", "s1"]));
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("plan");
    const d = claudeArgs({ prompt: "", cwd: "/" });
    expect(d).not.toContain("--effort");
    expect(d[d.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(claudeArgs({ prompt: "", cwd: "/", access: "full" })).toContain("bypassPermissions");
    const fast = claudeArgs({ prompt: "", cwd: "/", fast: true });
    expect(JSON.parse(fast[fast.indexOf("--settings") + 1])).toEqual({ fastMode: true });
    expect(d).not.toContain("--settings");
  });

  it("codex, including resume (which has no -s flag)", () => {
    const a = codexArgs({ prompt: "", cwd: "/", model: "gpt-6-astra", effort: "xhigh", access: "full", sessionId: "t1" });
    expect(a.slice(0, 3)).toEqual(["exec", "resume", "t1"]);
    expect(a).not.toContain("-s");
    expect(a).toEqual(expect.arrayContaining(["-m", "gpt-6-astra", 'model_reasoning_effort="xhigh"', 'sandbox_mode="danger-full-access"']));
    expect(codexArgs({ prompt: "", cwd: "/" })).toContain('sandbox_mode="workspace-write"');
    expect(codexArgs({ prompt: "", cwd: "/", fast: true })).toContain('service_tier="priority"');
    expect(codexArgs({ prompt: "", cwd: "/" }).join(" ")).not.toContain("service_tier");
  });

  it("parses the codex model catalog, hiding hidden models", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "b", display_name: "B", visibility: "list", priority: 2, description: "second", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low", service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }] },
        { slug: "a", display_name: "A", visibility: "list", priority: 1 },
        { slug: "secret", visibility: "hide", priority: 0 },
      ],
    });
    expect(parseCodexCatalog(raw)).toEqual([
      { id: "a", label: "A", description: undefined, efforts: undefined, defaultEffort: undefined, contextWindow: undefined, fast: undefined },
      { id: "b", label: "B", description: "second", efforts: ["low", "high"], defaultEffort: "low", contextWindow: undefined, fast: { description: "1.5x speed" } },
    ]);
  });
});

import { acpUsage, claudeUsage, codexDefaults, codexTokens, codexUsageFromRollout } from "../src/index.ts";

describe("context usage", () => {
  it("reads the real context from a Codex session file", () => {
    const lines = [
      { type: "turn_context", payload: { model: "gpt-5.6-luna", effort: "high" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9000, output_tokens: 400 }, total_token_usage: { input_tokens: 99999 }, model_context_window: 258400 } } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 15849, output_tokens: 30 }, model_context_window: 258400 } } },
    ];
    expect(codexUsageFromRollout(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n")).toEqual({ type: "usage", model: "gpt-5.6-luna", effort: "high", contextUsed: 15879, contextWindow: 258400 });
    expect(codexUsageFromRollout("")).toBeNull();
  });

  it("reads Codex's default model and effort from config.toml, ignoring sections", () => {
    expect(codexDefaults('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n')).toEqual({ defaultModel: "gpt-5.6-sol", defaultEffort: "high" });
    expect(codexDefaults('[profiles.x]\nmodel = "other"\n')).toEqual({ defaultModel: undefined, defaultEffort: undefined });
  });

  it("measures Claude Code context from the last model call, window from the result", () => {
    const last = { type: "assistant", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 12, cache_read_input_tokens: 20000, cache_creation_input_tokens: 800, output_tokens: 300 } } };
    const result = { type: "result", modelUsage: { "claude-sonnet-5-5": { contextWindow: 1000000, inputTokens: 999 } } };
    expect(claudeUsage(last, result)).toEqual({ type: "usage", model: "claude-sonnet-5-5", contextUsed: 21112, contextWindow: 1000000 });
    expect(claudeUsage(null, null)).toBeNull();
  });
});

describe("token usage", () => {
  it("takes Claude Code's run total from the final result, cache reads included", () => {
    // the shape of a stream-json `result` line
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      result: "Inbox quiet.",
      usage: { input_tokens: 21, cache_creation_input_tokens: 2400, cache_read_input_tokens: 61000, output_tokens: 1350, service_tier: "standard" },
      modelUsage: { "claude-haiku-4-5": { inputTokens: 21, outputTokens: 1350, cacheReadInputTokens: 61000, cacheCreationInputTokens: 2400, contextWindow: 200000 } },
    };
    const last = { type: "assistant", message: { model: "claude-haiku-4-5", usage: { input_tokens: 5, cache_read_input_tokens: 20000, cache_creation_input_tokens: 100, output_tokens: 300 } } };
    expect(claudeUsage(last, result)).toEqual({
      type: "usage",
      model: "claude-haiku-4-5",
      contextUsed: 20405,
      contextWindow: 200000,
      inputTokens: 63421,
      outputTokens: 1350,
      cachedInputTokens: 61000,
    });
    // a result with no usage still gives the context numbers
    expect(claudeUsage(last, { type: "result", modelUsage: {} })).not.toHaveProperty("inputTokens");
  });

  it("reads a Codex turn's counts, where input already includes the cached part", () => {
    const line = { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 64 } };
    expect(codexTokens(line)).toEqual({ inputTokens: 24763, outputTokens: 186, cachedInputTokens: 24448 });
    expect(codexTokens({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
    expect(codexTokens({ type: "turn.completed" })).toBeNull();
    expect(codexTokens({ type: "item.completed", usage: { input_tokens: 1 } })).toBeNull();
  });

  it("reads the usage an ACP agent returns with the end of a prompt, if it sends any", () => {
    const res = { stopReason: "end_turn", usage: { totalTokens: 9200, inputTokens: 8000, outputTokens: 900, thoughtTokens: 300, cachedReadTokens: 6500 } };
    expect(acpUsage(res.usage, { model: "gemini-3-pro", effort: null })).toEqual({
      type: "usage",
      model: "gemini-3-pro",
      effort: null,
      contextUsed: 9200,
      inputTokens: 8000,
      outputTokens: 1200,
      cachedInputTokens: 6500,
    });
    expect(acpUsage(undefined)).toBeNull();
    expect(acpUsage({})).toBeNull();
    // only a total: context stays known, token counts stay unknown
    expect(acpUsage({ totalTokens: 500 })).toEqual({ type: "usage", model: undefined, effort: null, contextUsed: 500 });
  });
});

describe("claude env", () => {
  it("turns off Claude Code's device-local auto memory so memory lives in Warren", () => {
    expect(claudeEnv({ prompt: "", cwd: "/", env: { A: "1" } })).toEqual({ A: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });
});
