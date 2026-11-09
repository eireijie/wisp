import type { AccessLevel, AgentEvent, CommandOption, ConnectionKind, ConnectorSpec, HarnessCatalog, ModelProvider } from "@wisp/core";

/** How a harness reaches the Wisp MCP server (memory, chat, tasks tools). */
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
  /**
   * Let the harness load the person's own plugins, MCP servers and computer-use helpers.
   * Anything but `true` keeps them out: only Wisp's own tools and the run's connectors load.
   */
  ownPlugins?: boolean;
  /** Harness-specific extras from the device's config. */
  options?: Record<string, string>;
  /**
   * The model connection the run uses, when it has one (its secret is already in `env` or in the
   * harness's folder, see credentials.ts): some harnesses need a flag for it too (Codex's provider).
   */
  connection?: { provider: ModelProvider; kind: ConnectionKind };
  /** Where the harness runs when that isn't here (inside a VM): how to read what it leaves behind. */
  place?: RunPlace;
}

/**
 * A filesystem the harness runs on that isn't this process's own (a VM's). Adapters read the
 * harness's own records through it, such as Codex's session file for context and plan usage.
 */
export interface RunPlace {
  /** the home folder there */
  home: string;
  readFile(file: string): Promise<string | null>;
  readDir(dir: string): Promise<string[]>;
}

/**
 * Where to look when listing what a harness offers somewhere other than this device (a VM):
 * how to run a command there and read its files. Without it, catalog() looks here.
 */
export interface CatalogPlace extends RunPlace {
  exec(command: string, args: string[], opts?: { timeout?: number }): Promise<string>;
  /** start a long-running process there (an ACP agent), as RunInput.launch does */
  launch: NonNullable<RunInput["launch"]>;
}

/**
 * What adapters report during a run besides Wisp's own events: the harness session to continue,
 * and the harness's "/" list as the session itself sees it (Claude Code's start-up line), which
 * the device merges into its catalog for where the run ran.
 */
export type AdapterEvent = AgentEvent | { type: "session"; id: string } | { type: "commands"; commands: CommandOption[] };

export interface RunResult {
  finalText: string;
  sessionId: string | null;
}

/**
 * A harness adapter turns one Wisp run into one headless harness invocation.
 * Adding a harness means implementing this interface.
 */
export interface HarnessAdapter {
  id: string;
  label: string;
  /** Binary the adapter shells out to; used for `wisp doctor`. */
  binary: string;
  run(input: RunInput, onEvent: (e: AdapterEvent) => void): Promise<RunResult>;
  /** Models and effort levels this harness offers on this device, or in `place` (shown in agent settings). */
  catalog?(place?: CatalogPlace): Promise<HarnessCatalog>;
}
