import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AccessLevel, AgentEvent, HarnessCatalog, ModelOption } from "@warren/core";
import type { AdapterEvent, HarnessAdapter, RunInput, RunResult } from "./types.ts";
import { commandVersion, execCommand, launched, runJsonl } from "./process.ts";

const SANDBOX: Record<AccessLevel, string> = { "read-only": "read-only", edit: "workspace-write", full: "danger-full-access" };

/** CLI arguments for one run. Exported for tests. */
export function codexArgs(input: RunInput): string[] {
  // `exec resume` has no -s flag, so the sandbox is set through config for both forms
  const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode=${tomlString(SANDBOX[input.access ?? "edit"])}`];
  if (input.model) common.push("-m", input.model);
  if (input.effort) common.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  // Codex's fast mode is the "priority" service tier (models advertise it in their catalog)
  if (input.fast) common.push("-c", `service_tier="priority"`);
  for (const [name, spec] of [["warren", input.mcp], ["browser", input.browser]] as const) {
    if (!spec) continue;
    common.push("-c", `mcp_servers.${name}.command=${tomlString(spec.command)}`);
    common.push("-c", `mcp_servers.${name}.args=[${spec.args.map(tomlString).join(",")}]`);
    common.push("-c", `mcp_servers.${name}.env={${Object.entries(spec.env).map(([k, v]) => `${k}=${tomlString(v)}`).join(",")}}`);
    // exec mode can't prompt, so pre-approve these tools (the hub enforces what the agent may touch; the browser is its own VM's)
    common.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
  }
  for (const c of input.connectors ?? []) {
    if (c.name === "warren" || c.name === "browser" || c.kind === "secret") continue;
    const key = `mcp_servers.${tomlKey(c.name)}`;
    if (c.kind === "mcp-stdio") {
      common.push("-c", `${key}.command=${tomlString(c.command ?? "")}`);
      common.push("-c", `${key}.args=[${(c.args ?? []).map(tomlString).join(",")}]`);
      if (c.env && Object.keys(c.env).length) common.push("-c", `${key}.env=${tomlTable(c.env)}`);
    } else {
      common.push("-c", `${key}.url=${tomlString(c.url ?? "")}`);
      if (c.headers && Object.keys(c.headers).length) common.push("-c", `${key}.http_headers=${tomlTable(c.headers)}`);
    }
    common.push("-c", `${key}.default_tools_approval_mode="approve"`);
  }
  return input.sessionId ? ["exec", "resume", input.sessionId, ...common, "-"] : ["exec", ...common, "-"];
}

/** Turn `codex debug models` output into Warren model options (listed models only). Exported for tests. */
export function parseCodexCatalog(raw: string): ModelOption[] {
  const data = JSON.parse(raw);
  const models: any[] = Array.isArray(data) ? data : (data.models ?? []);
  return models
    .filter((m) => m?.slug && m.visibility !== "hide")
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => ({
      id: m.slug,
      label: m.display_name ?? m.slug,
      description: m.description ?? undefined,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((e: any) => e.effort).filter(Boolean) : undefined,
      defaultEffort: m.default_reasoning_level ?? undefined,
      // Codex reserves part of the window; report what's actually usable
      contextWindow: m.context_window ? Math.round((m.context_window * (m.effective_context_window_percent ?? 100)) / 100) : undefined,
      fast: fastTier(m),
    }));
}

function fastTier(m: any): { description?: string } | undefined {
  const tier = (m.service_tiers ?? []).find((t: any) => t?.id === "priority" || /fast/i.test(t?.name ?? ""));
  if (tier) return { description: tier.description ?? undefined };
  return (m.additional_speed_tiers ?? []).includes("fast") ? {} : undefined;
}

const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

/** Top-level `model` / `model_reasoning_effort` from Codex's config.toml (what it uses by default). */
export function codexDefaults(toml: string): { defaultModel?: string; defaultEffort?: string } {
  const top = toml.split(/^\s*\[/m)[0]; // keys before the first [section]
  const get = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  return { defaultModel: get("model"), defaultEffort: get("model_reasoning_effort") };
}

/**
 * Codex's exec JSON sums tokens across a turn's model calls, which overstates context. Its
 * session file records the real thing: the last call's token usage, the usable window, and the
 * model and effort that ran. Exported for tests.
 */
export function codexUsageFromRollout(text: string): Extract<AgentEvent, { type: "usage" }> | null {
  let model: string | undefined;
  let effort: string | null | undefined;
  let info: any = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "turn_context" && o.payload) {
      model = o.payload.model ?? model;
      effort = o.payload.effort ?? effort;
    }
    if (o.payload?.type === "token_count" && o.payload.info) info = o.payload.info;
  }
  if (!model && !info) return null;
  const last = info?.last_token_usage;
  return {
    type: "usage",
    model,
    effort: effort ?? null,
    contextUsed: last ? (last.input_tokens ?? 0) + (last.output_tokens ?? 0) : undefined,
    contextWindow: info?.model_context_window ?? undefined,
  };
}

/** Find a session's file: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, newest days first. */
async function findRollout(sessionId: string): Promise<string | null> {
  const root = path.join(codexHome(), "sessions");
  const days: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push(path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
  }
  for (const dir of days) {
    try {
      const hit = (await fs.readdir(dir)).find((f) => f.endsWith(`-${sessionId}.jsonl`));
      if (hit) return path.join(dir, hit);
    } catch {}
  }
  return null;
}

/**
 * OpenAI Codex CLI: `codex exec --json [-m model] -` and `codex exec resume <id> --json -`.
 * The prompt goes in on stdin.
 */
export const codex: HarnessAdapter = {
  id: "codex",
  label: "Codex",
  binary: "codex",

  async catalog(): Promise<HarnessCatalog> {
    let models: ModelOption[] = [];
    // the live catalog can refresh over the network; fall back to the one bundled with the binary
    for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
      try {
        const stdout = await execCommand(this.binary, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
        models = parseCodexCatalog(stdout);
        if (models.length) break;
      } catch {}
    }
    const defaults = await fs.readFile(path.join(codexHome(), "config.toml"), "utf8").then(codexDefaults, () => ({}));
    return { harness: this.id, version: await commandVersion(this.binary), efforts: ["low", "medium", "high"], models, ...defaults };
  },

  async run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult> {
    const args = codexArgs(input);

    let finalText = "";
    let sessionId: string | null = input.sessionId ?? null;
    let error: string | null = null;

    const l = launched(input, this.binary, args, input.env);
    const proc = await runJsonl(l.command, l.args, { cwd: l.cwd, env: l.env, stdin: input.prompt, signal: input.signal }, (m) => {
      for (const e of parseCodexLine(m)) {
        if (e.type === "session") sessionId = e.id;
        if (e.type === "text") finalText = e.text; // the last agent message is the reply
        if (e.type === "error") error = e.message;
        onEvent(e);
      }
    });

    if (input.signal?.aborted) throw new Error("cancelled");
    if (sessionId) {
      const file = await findRollout(sessionId);
      const usage = file ? codexUsageFromRollout(await fs.readFile(file, "utf8").catch(() => "")) : null;
      if (usage) onEvent(usage);
    }
    if (error && !finalText) throw new Error(error);
    if (proc.exitCode !== 0 && !finalText) throw new Error(proc.stderr.trim().split("\n").pop() || `codex exited with code ${proc.exitCode}`);
    return { finalText, sessionId };
  },
};

/** Translate one `codex exec --json` event into Warren events. Exported for tests. */
export function parseCodexLine(m: any): AdapterEvent[] {
  switch (m.type) {
    case "thread.started":
      return m.thread_id ? [{ type: "session", id: m.thread_id }] : [];
    case "turn.failed":
      return [{ type: "error", message: m.error?.message ?? "turn failed" }];
    case "error":
      return [{ type: "error", message: m.message ?? "error" }];
    case "item.started":
    case "item.completed": {
      const it = m.item ?? {};
      const done = m.type === "item.completed";
      if (it.type === "agent_message" && done) return [{ type: "text", text: it.text ?? "" }];
      if (it.type === "command_execution")
        return done ? [{ type: "tool_result", name: "shell", output: { command: it.command, exit_code: it.exit_code, output: String(it.aggregated_output ?? "").slice(0, 4000) } }] : [{ type: "tool_call", name: "shell", input: { command: it.command } }];
      if (it.type === "mcp_tool_call") {
        const name = `${it.server}.${it.tool}`;
        return done ? [{ type: "tool_result", name, output: it.result ?? it.error }] : [{ type: "tool_call", name, input: it.arguments }];
      }
      if (it.type === "file_change" && done) return [{ type: "tool_call", name: "edit_files", input: it.changes }];
      if (it.type === "web_search" && done) return [{ type: "tool_call", name: "web_search", input: { query: it.query } }];
      return [];
    }
    default:
      return [];
  }
}

/** A TOML key: bare when it can be, quoted otherwise. */
function tomlKey(k: string) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function tomlTable(o: Record<string, string>) {
  return `{${Object.entries(o).map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`).join(",")}}`;
}

function tomlString(s: string) {
  return JSON.stringify(s); // JSON string escaping is valid TOML basic-string escaping
}
