import type { AccessLevel, AgentEvent, HarnessCatalog } from "@warren/core";

/** How a harness reaches the Warren MCP server (memory, chat, tasks tools). */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunInput {
  prompt: string;
  cwd: string;
  model?: string | null;
  /** Harness session to continue, if this conversation ran before. */
  sessionId?: string | null;
  mcp?: McpServerSpec;
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
