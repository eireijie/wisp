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

import { claudeUsage, codexDefaults, codexUsageFromRollout } from "../src/index.ts";

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

describe("claude env", () => {
  it("turns off Claude Code's device-local auto memory so memory lives in Warren", () => {
    expect(claudeEnv({ prompt: "", cwd: "/", env: { A: "1" } })).toEqual({ A: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });
});

import { escapeForCmd } from "../src/process.ts";

describe("windows command lines", () => {
  it("quotes arguments so JSON and spaces reach a .cmd shim intact", () => {
    expect(escapeForCmd("--verbose")).toBe('^"--verbose^"');
    expect(escapeForCmd('{"a":"b c"}')).toBe('^"{\\^"a\\^":\\^"b c\\^"}^"');
    expect(escapeForCmd("x&y|z")).toBe('^"x^&y^|z^"');
    expect(escapeForCmd("dir\\")).toBe('^"dir\\\\^"');
  });
});

import fs from "node:fs";
import fsp from "node:fs/promises";
import { RunFiles, claudeMcpConfig, runJsonl } from "../src/index.ts";

describe("secrets stay off the command line", () => {
  const mcp = { command: "node", args: ["warren-mcp.mjs"], env: { WARREN_URL: "http://hub", WARREN_TOKEN: "wr_agent_secret" } };

  it("claude gets its MCP config (tokens and all) as a private file", async () => {
    const input = { prompt: "", cwd: "/", mcp };
    const files = new RunFiles("warren-test-");
    const file = await files.add("mcp.json", JSON.stringify(claudeMcpConfig(input)));
    try {
      const a = claudeArgs(input, { mcpConfigFile: file.path });
      expect(a[a.indexOf("--mcp-config") + 1]).toBe(file.path);
      expect(a[a.indexOf("--allowedTools") + 1]).toBe("mcp__warren");
      expect(a.join(" ")).not.toContain("wr_agent_secret");
      expect(JSON.parse(fs.readFileSync(file.path, "utf8")).mcpServers.warren.env.WARREN_TOKEN).toBe("wr_agent_secret");
      if (process.platform !== "win32") expect((await fsp.stat(file.path)).mode & 0o777).toBe(0o600);
    } finally {
      await files.cleanup();
    }
    // gone with the run
    expect(fs.existsSync(file.path)).toBe(false);
    expect(claudeMcpConfig({ prompt: "", cwd: "/" })).toBeNull();
    expect(claudeArgs({ prompt: "", cwd: "/" })).not.toContain("--mcp-config");
  });
});

describe("cancelling a run", () => {
  it("kills a harness that ignores SIGTERM", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const proc = runJsonl(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { cwd: process.cwd(), signal: ac.signal, killAfterMs: 300 }, () => {});
    setTimeout(() => ac.abort(), 200);
    const res = await proc;
    expect(res.exitCode).toBeNull(); // ended by a signal, not on its own
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});
