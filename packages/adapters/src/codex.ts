import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planFromWindows, type AccessLevel, type AgentEvent, type HarnessCatalog, type ModelOption, type PlanUsage, type PlanWindow } from "@wisp/core";
import type { AdapterEvent, CatalogPlace, HarnessAdapter, RunInput, RunResult } from "./types.ts";
import { codexCommands } from "./commands.ts";
import { commandVersion, execCommand, launched, runJsonl } from "./process.ts";

const SANDBOX: Record<AccessLevel, string> = { "read-only": "read-only", edit: "workspace-write", full: "danger-full-access" };

/**
 * The MCP servers a run gets, as `-c` overrides, and the environment they take their secrets
 * from. Tokens and headers go in Codex's own environment and are named in `env_vars` /
 * `env_http_headers` rather than written into the command line, where `ps` would show them.
 * (Only when two servers want the same variable with different values does the second one's
 * value stay inline.) Exported for tests.
 */
export function codexMcpConfig(input: RunInput): { overrides: string[]; env: Record<string, string> } {
  const overrides: string[] = [];
  const env: Record<string, string> = {};
  const set = (key: string, value: string) => overrides.push("-c", `${key}=${value}`);
  const viaEnv = (key: string, vars: Record<string, string>) => {
    const names: string[] = [];
    const inline: Record<string, string> = {};
    for (const [name, value] of Object.entries(vars)) {
      if (name in env && env[name] !== value) inline[name] = value;
      else {
        env[name] = value;
        names.push(name);
      }
    }
    if (names.length) set(`${key}.env_vars`, `[${names.map(tomlString).join(",")}]`);
    if (Object.keys(inline).length) set(`${key}.env`, tomlTable(inline));
  };
  const servers: [string, { command: string; args: string[]; env?: Record<string, string> }][] = [];
  if (input.mcp) servers.push(["wisp", input.mcp]);
  if (input.browser) servers.push(["browser", input.browser]);
  for (const [name, spec] of servers) {
    const key = `mcp_servers.${name}`;
    set(`${key}.command`, tomlString(spec.command));
    set(`${key}.args`, `[${spec.args.map(tomlString).join(",")}]`);
    viaEnv(key, spec.env ?? {});
    // exec mode can't prompt, so pre-approve these tools (the hub enforces what the agent may touch; the browser is its own VM's)
    set(`${key}.default_tools_approval_mode`, `"approve"`);
  }
  for (const c of input.connectors ?? []) {
    if (c.name === "wisp" || c.name === "browser" || c.kind === "secret") continue;
    const key = `mcp_servers.${tomlKey(c.name)}`;
    if (c.kind === "mcp-stdio") {
      set(`${key}.command`, tomlString(c.command ?? ""));
      set(`${key}.args`, `[${(c.args ?? []).map(tomlString).join(",")}]`);
      if (c.env && Object.keys(c.env).length) viaEnv(key, c.env);
    } else {
      set(`${key}.url`, tomlString(c.url ?? ""));
      // each header's value lives in a variable named after the connector and header
      const headers = Object.entries(c.headers ?? {});
      if (headers.length) {
        const byVar = Object.fromEntries(headers.map(([h, v]) => [`WISP_HEADER_${(c.name + "_" + h).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, v]));
        Object.assign(env, byVar);
        set(`${key}.env_http_headers`, `{${headers.map(([h], i) => `${tomlKey(h)}=${tomlString(Object.keys(byVar)[i])}`).join(",")}}`);
      }
    }
    set(`${key}.default_tools_approval_mode`, `"approve"`);
  }
  return { overrides, env };
}

/** Features of Codex that bring in the person's own plugins, connected apps and screen/browser control. */
const CODEX_PERSONAL_FEATURES = ["plugins", "remote_plugin", "apps", "computer_use", "browser_use", "browser_use_external", "in_app_browser"];

/** Names of the MCP servers a config.toml sets up (`[mcp_servers.NAME]` and its sub-tables). Exported for tests. */
export function codexConfiguredServers(toml: string): string[] {
  const names = new Set<string>();
  for (const m of toml.matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)/gm)) {
    names.add(m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]);
  }
  return [...names];
}

/**
 * What keeps the person's own Codex plugins, connected apps, MCP servers, Computer Use helper and
 * turn-end notifier out of a run: overrides that turn them off. Wisp's own servers and the run's
 * connectors are set after these, so they still load. `personal` is the server names in the
 * config the run reads. Exported for tests.
 */
export function codexIsolation(personal: string[]): string[] {
  const out: string[] = [];
  for (const f of CODEX_PERSONAL_FEATURES) out.push("-c", `features.${f}=false`);
  out.push("-c", "notify=[]");
  for (const name of personal) out.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
  return out;
}

/** CLI arguments for one run. `personalServers` are the MCP servers in the person's own config (see codexIsolation). Exported for tests. */
export function codexArgs(input: RunInput, personalServers: string[] = []): string[] {
  // `exec resume` has no -s flag, so the sandbox is set through config for both forms
  const common = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode=${tomlString(SANDBOX[input.access ?? "edit"])}`];
  if (input.model) common.push("-m", input.model);
  if (input.effort) common.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  // Codex's fast mode is the "priority" service tier (models advertise it in their catalog)
  if (input.fast) common.push("-c", `service_tier="priority"`);
  if (input.ownPlugins !== true) common.push(...codexIsolation(personalServers));
  common.push(...codexConnectionArgs(input.connection));
  common.push(...codexMcpConfig(input).overrides);
  return input.sessionId ? ["exec", "resume", input.sessionId, ...common, "-"] : ["exec", ...common, "-"];
}

/**
 * Flags a model connection needs (models.ts). An OpenRouter key goes through a provider entry that
 * reads it from OPENROUTER_API_KEY (Codex speaks OpenRouter's Responses API); a ChatGPT sign-in is
 * read from auth.json in the run's own CODEX_HOME, never the system keychain. An OpenAI key needs
 * nothing: `codex exec` reads CODEX_API_KEY. Exported for tests.
 */
export function codexConnectionArgs(connection: RunInput["connection"]): string[] {
  if (!connection) return [];
  if (connection.provider === "openrouter") {
    const p = "model_providers.openrouter";
    return ["-c", `model_provider="openrouter"`, "-c", `${p}.name="OpenRouter"`, "-c", `${p}.base_url="https://openrouter.ai/api/v1"`, "-c", `${p}.env_key="OPENROUTER_API_KEY"`, "-c", `${p}.wire_api="responses"`];
  }
  if (connection.provider === "openai" && connection.kind === "oauth") return ["-c", `cli_auth_credentials_store="file"`];
  return [];
}

/** Environment for one run: the run's own (connector secrets) plus what the MCP servers read theirs from. Exported for tests. */
export function codexEnv(input: RunInput): Record<string, string> {
  return { ...input.env, ...codexMcpConfig(input).env };
}

/** Turn `codex debug models` output into Wisp model options (listed models only). Exported for tests. */
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
  let limits: any = null;
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
    if (o.payload?.type === "token_count" && o.payload.rate_limits) limits = o.payload.rate_limits;
  }
  if (!model && !info) return null;
  const last = info?.last_token_usage;
  const plan = codexPlan(limits);
  return {
    type: "usage",
    model,
    effort: effort ?? null,
    contextUsed: last ? (last.input_tokens ?? 0) + (last.output_tokens ?? 0) : undefined,
    contextWindow: info?.model_context_window ?? undefined,
    ...(plan ? { plan } : {}),
  };
}

/**
 * A ChatGPT plan's limits from a session file's `rate_limits` (`primary` / `secondary`, each with
 * `used_percent`, `window_minutes` and `resets_at` in epoch seconds). API keys report none. Exported for tests.
 */
export function codexPlan(limits: any): PlanUsage | undefined {
  if (!limits || typeof limits !== "object") return undefined;
  const windows: PlanWindow[] = [];
  for (const w of [limits.primary, limits.secondary]) {
    if (typeof w?.used_percent !== "number") continue;
    const mins = Number(w.window_minutes) || 0;
    const name = mins === 300 ? "5-hour" : mins === 10080 ? "weekly" : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : mins ? `${Math.round(mins / 60)}-hour` : "limit";
    const resets = typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : typeof w.resets_in_seconds === "number" ? new Date(Date.now() + w.resets_in_seconds * 1000).toISOString() : null;
    windows.push({ window: name, usedFraction: Math.max(0, w.used_percent / 100), resetsAt: resets });
  }
  return planFromWindows(windows, typeof limits.plan_type === "string" ? limits.plan_type : undefined);
}

/**
 * `turn.completed` ends each turn of `codex exec --json` with that turn's token counts.
 * Codex's `input_tokens` already includes the cached part. Exported for tests.
 */
export function codexTokens(m: any): { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null {
  const u = m?.type === "turn.completed" ? m.usage : null;
  if (!u || typeof u !== "object") return null;
  return { inputTokens: u.input_tokens ?? 0, outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cachedInputTokens: u.cached_input_tokens ?? 0 };
}

/**
 * The CODEX_HOME a run actually used: its account's or connection's folder (from its environment),
 * inside its VM when it ran there, else this device's. Exported for tests.
 */
export function runCodexHome(input: Pick<RunInput, "env" | "place">): string {
  return input.env?.CODEX_HOME ?? (input.place ? `${input.place.home}/.codex` : codexHome());
}

/**
 * Read a session's file: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl in the run's own CODEX_HOME,
 * newest days first (in the VM when it ran there).
 */
async function readRollout(sessionId: string, input: Pick<RunInput, "env" | "place">): Promise<string | null> {
  const join = input.place ? path.posix.join : path.join;
  const root = join(runCodexHome(input), "sessions");
  const readDir = input.place ? (d: string) => input.place!.readDir(d) : (d: string) => fs.readdir(d).catch(() => [] as string[]);
  const read = input.place ? (f: string) => input.place!.readFile(f) : (f: string) => fs.readFile(f, "utf8").catch(() => null);
  for (let i = 0; i < 3; i++) {
    // the VM's clock and this device's agree on the day closely enough; both sides of midnight are tried
    const d = new Date(Date.now() - i * 86_400_000);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    const hit = (await readDir(dir)).find((f) => f.endsWith(`-${sessionId}.jsonl`));
    if (hit) return read(join(dir, hit));
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

  async catalog(place?: CatalogPlace): Promise<HarnessCatalog> {
    let models: ModelOption[] = [];
    const run = (args: string[]) => (place ? place.exec(this.binary, args, { timeout: 30_000 }) : execCommand(this.binary, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }));
    // the live catalog can refresh over the network; fall back to the one bundled with the binary
    for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
      try {
        models = parseCodexCatalog(await run(args));
        if (models.length) break;
      } catch {}
    }
    const configText = place ? await place.readFile(`${place.home}/.codex/config.toml`) : await fs.readFile(path.join(codexHome(), "config.toml"), "utf8").catch(() => null);
    const defaults = configText ? codexDefaults(configText) : {};
    const version = place ? await run(["--version"]).then((o) => o.trim().split("\n")[0] || null, () => null) : await commandVersion(this.binary);
    // in a VM: no skills listed (its folders there aren't read from here)
    return { harness: this.id, version, efforts: ["low", "medium", "high"], models, ...defaults, commands: place ? [] : await codexCommands(codexHome()) };
  },

  async run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult> {
    // the servers in the config this run reads (the VM's own, or this device's), so they can be switched off by name
    let personal: string[] = [];
    if (input.ownPlugins !== true) {
      const file = input.place ? `${runCodexHome(input)}/config.toml` : path.join(runCodexHome(input), "config.toml");
      const text = input.place ? await input.place.readFile(file).catch(() => null) : await fs.readFile(file, "utf8").catch(() => null);
      personal = text ? codexConfiguredServers(text) : [];
    }
    const args = codexArgs(input, personal);

    let finalText = "";
    let sessionId: string | null = input.sessionId ?? null;
    let error: string | null = null;
    let tokens = null as ReturnType<typeof codexTokens>;

    const l = await launched(input, this.binary, args, codexEnv(input));
    const proc = await runJsonl(l.command, l.args, { cwd: l.cwd, env: l.env, stdin: input.prompt, signal: input.signal }, (m) => {
      const t = codexTokens(m);
      // a run can take several turns: add them up
      if (t) tokens = { inputTokens: (tokens?.inputTokens ?? 0) + t.inputTokens, outputTokens: (tokens?.outputTokens ?? 0) + t.outputTokens, cachedInputTokens: (tokens?.cachedInputTokens ?? 0) + t.cachedInputTokens };
      for (const e of parseCodexLine(m)) {
        if (e.type === "session") sessionId = e.id;
        if (e.type === "text") finalText = e.text; // the last agent message is the reply
        if (e.type === "error") error = e.message;
        onEvent(e);
      }
    });

    if (input.signal?.aborted) throw new Error("cancelled");
    if (sessionId) {
      const text = await readRollout(sessionId, input).catch(() => null);
      const usage = text ? codexUsageFromRollout(text) : null;
      if (usage) onEvent({ ...usage, ...tokens });
      else if (tokens) onEvent({ type: "usage", ...tokens });
    } else if (tokens) onEvent({ type: "usage", ...tokens });
    if (error && !finalText) throw new Error(error);
    if (proc.exitCode !== 0 && !finalText) throw new Error(proc.stderr.trim().split("\n").pop() || `codex exited with code ${proc.exitCode}`);
    return { finalText, sessionId };
  },
};

/** Translate one `codex exec --json` event into Wisp events. Exported for tests. */
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
