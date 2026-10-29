import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planFromWindows, type AccessLevel, type AgentEvent, type HarnessCatalog, type PlanUsage, type PlanWindow } from "@wisp/core";
import type { AdapterEvent, CatalogPlace, HarnessAdapter, RunInput, RunResult } from "./types.ts";
import { CLAUDE_BUILTINS, claudeCommands, claudeInitCommands, commandsIn, skillsIn } from "./commands.ts";
import { RunFiles, commandVersion, launched, runJsonl } from "./process.ts";

const PERMISSION_MODE: Record<AccessLevel, string> = { "read-only": "plan", edit: "acceptEdits", full: "bypassPermissions" };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The MCP servers a run gets (Wisp's tools, its computer's browser, its connectors), as Claude Code's config, or null without any. Exported for tests. */
export function claudeMcpConfig(input: RunInput): { mcpServers: Record<string, unknown> } | null {
  const servers: Record<string, unknown> = {};
  if (input.mcp) servers.wisp = { type: "stdio", ...input.mcp };
  if (input.browser) servers.browser = { type: "stdio", ...input.browser };
  for (const c of input.connectors ?? []) {
    if (servers[c.name]) continue;
    if (c.kind === "mcp-stdio") servers[c.name] = { type: "stdio", command: c.command, args: c.args ?? [], env: c.env ?? {} };
    else if (c.kind === "mcp-http") servers[c.name] = { type: /\/sse\/?$/.test(c.url ?? "") ? "sse" : "http", url: c.url, headers: c.headers ?? {} };
  }
  return Object.keys(servers).length ? { mcpServers: servers } : null;
}

/**
 * CLI arguments for one run. Soul and instructions travel in the prompt rather than
 * --append-system-prompt: a resumed session replays its original system prompt, so
 * edits would never reach an ongoing conversation. The MCP config holds the agent's token
 * and connector secrets, so a run passes it as a private file (`mcpConfigFile`) rather than
 * inline, where `ps` would show it. Exported for tests.
 */
export function claudeArgs(input: RunInput, opts: { mcpConfigFile?: string } = {}): string[] {
  // partial messages stream the reply as it's written, so a voice call can speak its first sentence early
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  args.push("--permission-mode", PERMISSION_MODE[input.access ?? "edit"]);
  // Claude Code's fast mode is a setting (what /fast toggles); --settings layers it on for this run
  if (input.fast) args.push("--settings", JSON.stringify({ fastMode: true }));
  const mcp = claudeMcpConfig(input);
  if (mcp) {
    args.push("--mcp-config", opts.mcpConfigFile ?? JSON.stringify(mcp));
    args.push("--allowedTools", Object.keys(mcp.mcpServers).map((n) => `mcp__${n}`).join(","));
  }
  return args;
}

/**
 * Environment for one run. Claude Code's own auto-memory is off: it writes to files on the
 * device that nobody else can see, while Wisp's memory is shared and visible.
 */
export function claudeEnv(input: RunInput): Record<string, string> {
  return { ...input.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

/**
 * Claude Code in print mode with stream-json output.
 * Docs: `claude -p --output-format stream-json --verbose [--resume <id>]`.
 */
export const claudeCode: HarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  binary: "claude",

  async catalog(place?: CatalogPlace): Promise<HarnessCatalog> {
    // Claude Code has no model-list command; these aliases always resolve to the latest model of each tier.
    // the user's default model, if they set one in Claude Code's settings
    const settingsFile = place ? `${place.home}/.claude/settings.json` : path.join(os.homedir(), ".claude", "settings.json");
    const text = place ? await place.readFile(settingsFile) : await fs.readFile(settingsFile, "utf8").catch(() => null);
    let settings: any = {};
    try {
      settings = text ? JSON.parse(text) : {};
    } catch {}
    const version = place ? await place.exec(this.binary, ["--version"], { timeout: 15_000 }).then((o) => o.trim().split("\n")[0] || null, () => null) : await commandVersion(this.binary);
    return {
      harness: this.id,
      version,
      defaultModel: typeof settings.model === "string" ? settings.model : undefined,
      efforts: EFFORTS,
      // in a VM: its built-in commands (its own skill folders there aren't read from here)
      commands: place ? CLAUDE_BUILTINS : await claudeCommands(),
      models: [
        { id: "fable", label: "Fable", description: "Most capable, for the hardest work." },
        { id: "opus", label: "Opus", description: "Deep reasoning for complex, multi-step tasks.", fast: { description: "Faster output, higher usage" } },
        { id: "sonnet", label: "Sonnet", description: "Fast and strong; a great everyday default." },
        { id: "haiku", label: "Haiku", description: "Quickest and cheapest, for simple tasks." },
      ],
    };
  },

  async run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult> {
    let finalText = "";
    let sessionId: string | null = input.sessionId ?? null;
    let error: string | null = null;
    const toolNames = new Map<string, string>();
    const streamed = new Set<string>();
    let lastAssistant: any = null;
    let result: any = null;
    let plan: PlanUsage | undefined;
    let init: any = null;

    const files = new RunFiles("wisp-claude-");
    let proc;
    try {
      const mcp = claudeMcpConfig(input);
      const mcpFile = mcp ? await files.add("mcp.json", JSON.stringify(mcp)) : undefined;
      const l = await launched(input, this.binary, claudeArgs(input, { mcpConfigFile: mcpFile?.path }), claudeEnv(input), files.list);
      proc = await runJsonl(l.command, l.args, { cwd: l.cwd, env: l.env, stdin: input.prompt, signal: input.signal }, (m) => {
        for (const e of parseClaudeLine(m, toolNames, streamed)) {
          if (e.type === "session") sessionId = e.id;
          onEvent(e);
        }
        if (m.type === "system" && m.subtype === "init") init = m;
        if (m.type === "assistant" && m.message?.usage) lastAssistant = m;
        if (m.type === "rate_limit_event") plan = claudePlan(m.rate_limit_info) ?? plan;
        if (m.type === "result") {
          result = m;
          if (typeof m.result === "string") finalText = m.result;
          if (m.is_error) error = typeof m.result === "string" ? m.result : (m.subtype ?? "error");
        }
      });
    } finally {
      await files.cleanup();
    }

    if (input.signal?.aborted) throw new Error("cancelled");
    // the session's own "/" list: what the device's catalog shows from now on
    if (init) {
      const known = input.place ? CLAUDE_BUILTINS : [...(await claudeCommands().catch(() => [])), ...(await commandsIn(path.join(input.cwd, ".claude", "commands"))), ...(await skillsIn(path.join(input.cwd, ".claude", "skills"), { via: "raw" }))];
      const commands = claudeInitCommands(init, known);
      if (commands) onEvent({ type: "commands", commands });
    }
    const usage = claudeUsage(lastAssistant, result);
    if (usage) onEvent({ ...usage, effort: input.effort ?? null, ...(plan ? { plan } : {}) });
    else if (plan) onEvent({ type: "usage", plan });
    if (error) throw new Error(error);
    if (proc.exitCode !== 0 && !finalText) throw new Error(lastLine(proc.stderr) || `claude exited with code ${proc.exitCode}`);
    return { finalText, sessionId };
  },
};

/**
 * Context in use = the last model call's full prompt (fresh + cached tokens) plus its output.
 * The window comes from the final result's per-model usage. The final result's `usage` is the
 * sum over every model call in the run, which is what the run cost. Exported for tests.
 */
export function claudeUsage(lastAssistant: any, result: any): Extract<AgentEvent, { type: "usage" }> | null {
  const u = lastAssistant?.message?.usage;
  const model: string | undefined = lastAssistant?.message?.model;
  const perModel = result?.modelUsage ?? {};
  const entry = (model && perModel[model]) ?? Object.values(perModel)[0];
  const total = result?.usage;
  if (!u && !entry && !total) return null;
  const cached = total ? (total.cache_read_input_tokens ?? 0) : 0;
  return {
    type: "usage",
    model: model ?? (Object.keys(perModel)[0] || undefined),
    contextUsed: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined,
    contextWindow: (entry as any)?.contextWindow ?? undefined,
    // fresh, cache-written and cache-read input all count as read
    ...(total ? { inputTokens: (total.input_tokens ?? 0) + (total.cache_creation_input_tokens ?? 0) + cached, outputTokens: total.output_tokens ?? 0, cachedInputTokens: cached } : {}),
  };
}

const CLAUDE_WINDOWS: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet", seven_day_overage_included: "weekly", overage: "extra usage" };

/**
 * A subscription's limits from Claude Code's `rate_limit_event` (stream-json): `utilization` is the
 * used fraction (0–1) and `resetsAt` epoch seconds, for the window that applies now and, where it
 * says, for each window (`unifiedWindows`). Nothing for API keys, which have no such limits. Exported for tests.
 */
export function claudePlan(info: any): PlanUsage | undefined {
  if (!info || typeof info !== "object") return undefined;
  const when = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null);
  const windows: PlanWindow[] = [];
  for (const [id, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
    if (typeof w?.utilization === "number") windows.push({ window: CLAUDE_WINDOWS[id] ?? id, usedFraction: Math.max(0, w.utilization), resetsAt: when(w.resetsAt) });
  }
  if (!windows.length && typeof info.utilization === "number") windows.push({ window: CLAUDE_WINDOWS[info.rateLimitType] ?? info.rateLimitType ?? "limit", usedFraction: Math.max(0, info.utilization), resetsAt: when(info.resetsAt) });
  return planFromWindows(windows);
}

/** Translate one stream-json line into Wisp events. Exported for tests. */
export function parseClaudeLine(m: any, toolNames = new Map<string, string>(), streamed = new Set<string>()): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  if (m.type === "system" && m.subtype === "init" && m.session_id) out.push({ type: "session", id: m.session_id });
  // a message whose text already arrived piece by piece isn't sent again when it completes
  if (m.type === "stream_event") {
    const e = m.event;
    if (e?.type === "message_start" && e.message?.id) streamed.add(e.message.id);
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) out.push({ type: "text", text: e.delta.text });
  }
  if (m.type === "assistant" && Array.isArray(m.message?.content)) {
    const sent = streamed.has(m.message.id);
    for (const c of m.message.content) {
      if (c.type === "text" && c.text && !sent) out.push({ type: "text", text: c.text });
      if (c.type === "tool_use") {
        toolNames.set(c.id, c.name);
        out.push({ type: "tool_call", name: c.name, input: c.input });
      }
    }
  }
  if (m.type === "user" && Array.isArray(m.message?.content)) {
    for (const c of m.message.content) {
      if (c.type === "tool_result") out.push({ type: "tool_result", name: toolNames.get(c.tool_use_id) ?? "tool", output: summarize(c.content) });
    }
  }
  return out;
}

function summarize(content: unknown): unknown {
  if (typeof content === "string") return content.slice(0, 4000);
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? String(c.text).slice(0, 4000) : `[${c?.type}]`)).join("\n");
  return content;
}

function lastLine(s: string) {
  return s.trim().split("\n").pop() ?? "";
}
