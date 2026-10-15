import type { AccessLevel, AgentEvent, ConnectorSpec, HarnessCatalog } from "@warren/core";

/** How a harness reaches the Warren MCP server (memory, chat, tasks tools). */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A file a run needs next to it (an MCP config with tokens in it, say): on disk here, and copied along by a launcher that runs the command somewhere else. */
export interface LaunchFile {
  /** where the adapter wrote it; the args refer to it by this path */
  path: string;
  content: string;
}

/** How a harness process starts: what to run, where, with which environment. */
export interface Launch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  files?: LaunchFile[];
}

export interface RunInput {
  prompt: string;
  cwd: string;
  model?: string | null;
  /** Harness session to continue, if this conversation ran before. */
  sessionId?: string | null;
  mcp?: McpServerSpec;
  /** the agent's computer's browser, as MCP tools that work on page elements (Playwright MCP) */
  browser?: McpServerSpec;
  /** connectors the agent's owner gave it: more MCP servers (and secrets, which arrive in `env`) */
  connectors?: ConnectorSpec[];
  /**
   * Start the harness somewhere else, e.g. inside the agent's VM: gets the command as the adapter
   * would run it here (with the files it needs) and returns what to actually run.
   */
  launch?: (l: Launch) => Launch | Promise<Launch>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** reasoning effort; null/undefined = harness default */
  effort?: string | null;
  /** what the agent may do on this device; defaults to "edit" */
  access?: AccessLevel;
  /** use the faster tier, where the harness and model offer one */
  fast?: boolean;
  /** Harness-specific extras from the device's config. */
  options?: Record<string, string>;
}

export type AdapterEvent = AgentEvent | { type: "session"; id: string };

export interface RunResult {
  finalText: string;
  sessionId: string | null;
}

/**
 * A harness adapter turns one Warren run into one headless harness invocation.
 * Adding a harness means implementing this interface.
 */
export interface HarnessAdapter {
  id: string;
  label: string;
  /** Binary the adapter shells out to; used for `warren doctor`. */
  binary: string;
  run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult>;
  /** Models and effort levels this harness offers on this device (shown in agent settings). */
  catalog?(): Promise<HarnessCatalog>;
}
