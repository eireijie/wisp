import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shortDescription, type AccessLevel, type AgentEvent, type CommandOption, type ConnectorSpec, type HarnessCatalog, type ModelOption } from "@wisp/core";
import type { AdapterEvent, HarnessAdapter, McpServerSpec, RunInput, RunResult } from "./types.ts";
import { commandVersion, launched, spawnCommand, stopProcess } from "./process.ts";

/**
 * Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0 over stdio, one JSON
 * object per line. Warren is the client; the harness is the agent. One run is: initialize,
 * session/new (or session/load to resume), then session/prompt while session/update
 * notifications stream what the agent does.
 */

const PROTOCOL_VERSION = 1;

type Json = any;

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
}

/** A JSON-RPC connection to an ACP agent process. Exported for tests. */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  stderr = "";
  private closed: Error | null = null;
  readonly exited: Promise<number | null>;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private onNotify: (method: string, params: Json) => void,
    private onRequest: (method: string, params: Json) => Promise<Json>,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      this.stderr = (this.stderr + c).slice(-8000);
    });
    this.exited = new Promise((resolve) => {
      child.on("error", (err) => {
        this.fail(err);
        resolve(null);
      });
      child.on("close", (code) => {
        this.fail(new Error(lastLine(this.stderr) || `the agent exited with code ${code}`));
        resolve(code);
      });
    });
    // a write to an exited agent surfaces through `close`, not as an unhandled error
    child.stdin.on("error", () => {});
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private write(msg: Json) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: Json, timeoutMs = 0): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} timed out`))), timeoutMs) : null;
      this.pending.set(id, {
        resolve: (v) => (timer && clearTimeout(timer), resolve(v)),
        reject: (e) => (timer && clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private receive(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a banner or log line on stdout
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(msg.error.message ?? "error", msg.error.code, msg.error.data));
      else p.resolve(msg.result ?? null);
    } else if (msg.method && msg.id !== undefined) {
      this.onRequest(msg.method, msg.params).then(
        (result) => this.write({ jsonrpc: "2.0", id: msg.id, result }),
        (err) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (err as Error).message } }),
      );
    } else if (msg.method) {
      this.onNotify(msg.method, msg.params);
    }
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {}
    // SIGTERM, and SIGKILL a little later for an agent that ignores it
    stopProcess(this.child);
  }
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** ACP wants MCP server env as a list of {name, value}. Exported for tests. */
export function acpMcpServers(mcp: McpServerSpec | undefined, browser?: McpServerSpec, connectors: ConnectorSpec[] = []): Json[] {
  const out: Json[] = [];
  for (const [name, s] of [["warren", mcp], ["browser", browser]] as [string, McpServerSpec | undefined][]) {
    if (s) out.push({ name, command: s.command, args: s.args, env: Object.entries(s.env).map(([n, value]) => ({ name: n, value })) });
  }
  // every ACP agent must accept stdio servers; http ones are optional in the protocol, so they're left out
  for (const c of connectors) {
    if (c.kind !== "mcp-stdio" || out.some((o) => o.name === c.name)) continue;
    out.push({ name: c.name, command: c.command ?? "", args: c.args ?? [], env: Object.entries(c.env ?? {}).map(([n, value]) => ({ name: n, value })) });
  }
  return out;
}

/**
 * Answer a permission request from the agent. Read-only agents may look but not change or run
 * anything; "edit" and "full" agents may go ahead (headless runs have nobody to ask, and Warren's
 * own tools are checked by the hub). Exported for tests.
 */
export function permissionOutcome(params: Json, access: AccessLevel): Json {
  const options: Json[] = Array.isArray(params?.options) ? params.options : [];
  const kind: string = params?.toolCall?.kind ?? "other";
  const blocked = access === "read-only" && ["edit", "delete", "move", "execute"].includes(kind);
  const pick = (kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
  const choice = blocked ? pick(["reject_once", "reject_always"]) : pick(["allow_once", "allow_always"]);
  return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
}

/** Text of an ACP content block (or list of them). */
function contentText(c: Json): string {
  if (!c) return "";
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join("\n");
  if (c.type === "text") return String(c.text ?? "");
  if (c.type === "content") return contentText(c.content);
  if (c.type === "diff") return `edited ${c.path ?? "a file"}`;
  if (c.type === "terminal") return "[terminal]";
  if (c.type === "resource_link") return String(c.uri ?? "");
  if (c.type === "resource") return String(c.resource?.text ?? c.resource?.uri ?? "");
  return `[${c.type}]`;
}

/**
 * Translate one session/update into Warren events. `tools` remembers each tool call's name so
 * results can be matched to it. Exported for tests.
 */
export function parseAcpUpdate(update: Json, tools = new Map<string, string>()): AdapterEvent[] {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const t = contentText(update.content);
      return t ? [{ type: "text", text: t }] : [];
    }
    case "tool_call": {
      const name = toolName(update);
      tools.set(update.toolCallId, name);
      const out: AdapterEvent[] = [{ type: "tool_call", name, input: update.rawInput ?? (update.locations?.length ? { locations: update.locations } : {}) }];
      if (update.status === "completed" || update.status === "failed") out.push({ type: "tool_result", name, output: update.rawOutput ?? contentText(update.content).slice(0, 4000) });
      return out;
    }
    case "tool_call_update": {
      if (update.status !== "completed" && update.status !== "failed") return [];
      const name = tools.get(update.toolCallId) ?? toolName(update);
      const output = update.rawOutput ?? contentText(update.content).slice(0, 4000);
      return [{ type: "tool_result", name, output: update.status === "failed" ? { error: output } : output }];
    }
    case "plan": {
      const entries: Json[] = update.entries ?? [];
      const active = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status === "pending");
      return active ? [{ type: "status", text: String(active.content).slice(0, 200) }] : [];
    }
    default:
      return [];
  }
}

/** A tool call's name: MCP tools keep their server-qualified name so Warren can recognize its own. */
function toolName(u: Json): string {
  const title = String(u.title ?? "").trim();
  const raw = u._meta?.toolName ?? u.rawInput?.tool ?? null;
  if (typeof raw === "string" && raw) return raw;
  // agents title MCP calls like "warren/chat_send", "mcp__warren__chat_send" or "chat_send (warren MCP Server)"
  const m = title.match(/^(?:mcp__)?warren(?:__|\/|\.|:)\s*([a-z_]+)/i) ?? title.match(/^([a-z][a-z_]+)\s*\(warren/i);
  if (m) return `warren.${m[1]}`;
  if (u.kind && u.kind !== "other") return title ? `${u.kind}: ${title}`.slice(0, 120) : u.kind;
  return (title || "tool").slice(0, 120);
}

export interface AcpCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Pick a model with whatever the agent offers: the `models` list, or a "model" config option. */
async function chooseModel(conn: AcpConnection, sessionId: string, session: Json, model: string | null | undefined) {
  if (!model) return;
  const options: Json[] = session?.configOptions ?? [];
  const opt = options.find((o) => o?.category === "model" || o?.id === "model");
  if (opt) return conn.request("session/set_config_option", { sessionId, configId: opt.id, value: model }, 15_000).catch(() => {});
  if (session?.models) return conn.request("session/set_model", { sessionId, modelId: model }, 15_000).catch(() => {});
}

/** Effort is a "thought_level" config option where an agent has one. */
async function chooseEffort(conn: AcpConnection, sessionId: string, session: Json, effort: string | null | undefined) {
  if (!effort) return;
  const opt = (session?.configOptions ?? []).find((o: Json) => o?.category === "thought_level");
  const value = opt?.options?.find((o: Json) => String(o.value ?? o.id).toLowerCase() === effort.toLowerCase());
  if (opt && value) await conn.request("session/set_config_option", { sessionId, configId: opt.id, value: value.value ?? value.id }, 15_000).catch(() => {});
}

/** Full access turns on a mode that skips the agent's own approvals, when it has one ("yolo", "bypassPermissions"). */
async function chooseMode(conn: AcpConnection, sessionId: string, session: Json, access: AccessLevel) {
  const modes: Json[] = session?.modes?.availableModes ?? [];
  const want = access === "full" ? /yolo|bypass|full|auto/i : access === "read-only" ? /plan|read|ask/i : null;
  const mode = want && modes.find((m) => want.test(`${m.id} ${m.name ?? ""}`));
  if (mode) await conn.request("session/set_mode", { sessionId, modeId: mode.id }, 15_000).catch(() => {});
}

function lastLine(s: string) {
  return s.trim().split("\n").pop() ?? "";
}

/**
 * An adapter for any harness that speaks ACP, started with `binary args...` (a device changes
 * these in its node.json `harnesses` section; see deviceAdapters).
 */
export function acpAdapter(info: { id: string; label: string; binary: string; args: string[]; vm?: { binary: string; args: string[] } }): HarnessAdapter {
  const command = (input?: RunInput): AcpCommand =>
    // inside a VM the agent is the copy that comes with the image, not whatever this device's node.json points at
    input?.launch && info.vm ? { command: info.vm.binary, args: info.vm.args } : { command: info.binary, args: info.args };

  return {
    id: info.id,
    label: info.label,
    binary: info.binary,

    async run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult> {
      const cmd = command(input);
      const l = await launched(input, cmd.command, cmd.args, input.env);
      const child = spawnCommand(l.command, l.args, { cwd: l.cwd, env: { ...process.env, ...l.env }, stdio: ["pipe", "pipe", "pipe"] });
      const tools = new Map<string, string>();
      let text = "";
      let prompting = false;
      let sessionId: string | null = null;

      const conn = new AcpConnection(
        child,
        (method, params) => {
          if (method !== "session/update" || !prompting || (sessionId && params?.sessionId !== sessionId)) return;
          for (const e of parseAcpUpdate(params.update, tools)) {
            if (e.type === "text") text += e.text;
            onEvent(e);
          }
        },
        async (method, params) => {
          if (method === "session/request_permission") return permissionOutcome(params, input.access ?? "edit");
          // Warren doesn't offer files or terminals to the agent; it uses its own
          throw new Error(`${method} is not supported by Warren`);
        },
      );
      const onAbort = () => {
        if (sessionId) conn.notify("session/cancel", { sessionId });
        setTimeout(() => conn.close(), 3000).unref();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const init = await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "warren", version: "0.1.0" } }, 60_000);
        const mcpServers = acpMcpServers(input.mcp, input.browser, input.connectors);
        let session: Json = null;
        if (input.sessionId && init?.agentCapabilities?.loadSession) {
          try {
            session = await conn.request("session/load", { sessionId: input.sessionId, cwd: input.cwd, mcpServers }, 120_000);
            sessionId = input.sessionId;
          } catch {
            session = null; // gone or expired: start fresh below
          }
        }
        if (!sessionId) {
          try {
            session = await conn.request("session/new", { cwd: input.cwd, mcpServers }, 120_000);
          } catch (err) {
            // some agents (OpenClaw) refuse per-session MCP servers; run without Warren's tools rather than not at all
            if (!mcpServers.length || !/mcp/i.test((err as Error).message)) throw err;
            onEvent({ type: "status", text: `${info.label} doesn't accept Warren's tools per session; add warren-mcp to its own MCP settings to give it chat, memory and computer tools.` });
            session = await conn.request("session/new", { cwd: input.cwd, mcpServers: [] }, 120_000);
          }
          sessionId = session?.sessionId;
          if (!sessionId) throw new Error(`${info.label} didn't start a session`);
          onEvent({ type: "session", id: sessionId });
        }
        await chooseMode(conn, sessionId!, session, input.access ?? "edit");
        await chooseModel(conn, sessionId!, session, input.model);
        await chooseEffort(conn, sessionId!, session, input.effort);

        prompting = true;
        const res = await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] });
        if (input.signal?.aborted || res?.stopReason === "cancelled") throw new Error("cancelled");
        if (res?.stopReason === "refusal" && !text.trim()) throw new Error(`${info.label} refused the request`);
        const usage = acpUsage(res?.usage, input);
        if (usage) onEvent(usage);
        return { finalText: text.trim(), sessionId };
      } catch (err) {
        if (input.signal?.aborted) throw new Error("cancelled");
        const msg = err instanceof AcpError && /auth/i.test(err.message) ? `${info.label} isn't signed in on this device: ${err.message}` : (err as Error).message;
        throw new Error(msg);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        conn.close();
        await Promise.race([conn.exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    },

    /**
     * Start the agent once to read the models it offers (from session/new). Agents that list
     * none still get a catalog entry so people can see the harness is installed.
     */
    async catalog(): Promise<HarnessCatalog> {
      const version = await commandVersion(info.binary);
      const base: HarnessCatalog = { harness: info.id, version, models: [], efforts: [] };
      if (version === null) return base;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warren-acp-"));
      const cmd = command();
      const child = spawnCommand(cmd.command, cmd.args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      // agents announce their "/" commands in a session/update right after the session starts
      let announced: (c: Json) => void = () => {};
      const commands = new Promise<Json>((r) => (announced = r));
      const conn = new AcpConnection(
        child,
        (method, params) => {
          if (method === "session/update" && params?.update?.sessionUpdate === "available_commands_update") announced(params.update.availableCommands);
        },
        async () => ({ outcome: { outcome: "cancelled" } }),
      );
      try {
        await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 20_000);
        const session = await conn.request("session/new", { cwd: dir, mcpServers: [] }, 20_000);
        const listed = await Promise.race([commands, new Promise((r) => setTimeout(() => r(null), 3000).unref())]);
        return { ...base, ...acpModels(session), commands: acpCommands(listed) };
      } catch {
        return base;
      } finally {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The commands from an available_commands_update; an agent runs them when a prompt starts with "/name". Exported for tests. */
export function acpCommands(list: Json): CommandOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c: Json) => typeof c?.name === "string" && c.name.trim())
    .slice(0, 500)
    .map((c: Json) => ({ name: c.name.trim().replace(/^\//, ""), description: shortDescription(c.description), hint: typeof c.input?.hint === "string" ? c.input.hint.slice(0, 120) : undefined, kind: "command" as const, via: "raw" as const }));
}

/** Models and effort levels from a session/new response. Exported for tests. */
export function acpModels(session: Json): Pick<HarnessCatalog, "models" | "efforts" | "defaultModel" | "defaultEffort"> {
  const options: Json[] = session?.configOptions ?? [];
  const modelOpt = options.find((o) => o?.category === "model");
  const effortOpt = options.find((o) => o?.category === "thought_level");
  const flat = (opt: Json): Json[] => (opt?.options ?? []).flatMap((o: Json) => (Array.isArray(o.options) ? o.options : [o]));
  let models: ModelOption[] = flat(modelOpt).map((o) => ({ id: String(o.value ?? o.id), label: String(o.name ?? o.value), description: o.description ?? undefined }));
  let defaultModel: string | undefined = modelOpt?.currentValue ?? undefined;
  if (!models.length && session?.models?.availableModels) {
    models = session.models.availableModels.map((m: Json) => ({ id: String(m.modelId), label: String(m.name ?? m.modelId), description: m.description ?? undefined }));
    defaultModel = session.models.currentModelId ?? undefined;
  }
  const efforts = flat(effortOpt).map((o) => String(o.value ?? o.id));
  return { models: models.slice(0, 200), efforts, defaultModel, defaultEffort: effortOpt?.currentValue ?? undefined };
}

/**
 * The `usage` ACP agents may return with the end of a prompt (ACP's token usage fields). Agents
 * that don't send it give nothing. Exported for tests.
 */
export function acpUsage(usage: any, input: { model?: string | null; effort?: string | null } = {}): Extract<AgentEvent, { type: "usage" }> | null {
  if (!usage || !(usage.totalTokens || usage.inputTokens || usage.outputTokens)) return null;
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
  const inputTokens = n(usage.inputTokens);
  const outputTokens = n(usage.outputTokens);
  return {
    type: "usage",
    model: input.model ?? undefined,
    effort: input.effort ?? null,
    contextUsed: n(usage.totalTokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(inputTokens !== undefined || outputTokens !== undefined ? { inputTokens: inputTokens ?? 0, outputTokens: (outputTokens ?? 0) + (n(usage.thoughtTokens) ?? 0), cachedInputTokens: n(usage.cachedReadTokens) } : {}),
  };
}
