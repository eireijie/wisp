/**
 * The agent harnesses Warren knows. "native" harnesses have their own adapter; "acp" ones are
 * driven through the Agent Client Protocol (JSON-RPC over stdio), which most agent CLIs speak;
 * "mcp" ones join through warren-mcp from wherever they already run.
 *
 * A device can override how a harness starts, or add its own ACP agents, in its node.json:
 *   "harnesses": { "qwen": { "args": ["--experimental-acp"] }, "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["acp"] } }
 */
export interface HarnessInfo {
  id: string;
  label: string;
  /** binary looked up on the device (`warren doctor`) */
  binary: string;
  protocol: "native" | "acp" | "mcp";
  /** arguments that start it in ACP mode */
  acpArgs?: string[];
  /** one line for the "add agent" picker */
  note: string;
  /** how to sign it in on a device, when it needs that before it can run */
  login?: string;
}

export const HARNESSES: HarnessInfo[] = [
  { id: "claude-code", label: "Claude Code", binary: "claude", protocol: "native", note: "Anthropic's coding agent", login: "claude (then /login)" },
  { id: "codex", label: "Codex", binary: "codex", protocol: "native", note: "OpenAI's coding agent", login: "codex login" },
  { id: "hermes", label: "Hermes", binary: "hermes", protocol: "acp", acpArgs: ["acp"], note: "Nous Research's agent, with its own skills", login: "hermes setup" },
  { id: "gemini", label: "Gemini CLI", binary: "gemini", protocol: "acp", acpArgs: ["--acp"], note: "Google's agent", login: "gemini (then sign in)" },
  { id: "opencode", label: "OpenCode", binary: "opencode", protocol: "acp", acpArgs: ["acp"], note: "Open-source agent for any model", login: "opencode auth login" },
  { id: "goose", label: "Goose", binary: "goose", protocol: "acp", acpArgs: ["acp"], note: "Block's open-source agent", login: "goose configure" },
  { id: "kimi", label: "Kimi CLI", binary: "kimi", protocol: "acp", acpArgs: ["acp"], note: "Moonshot's agent", login: "kimi (then /login)" },
  { id: "qwen", label: "Qwen Code", binary: "qwen", protocol: "acp", acpArgs: ["--acp"], note: "Alibaba's agent", login: "qwen (then sign in)" },
  { id: "cursor", label: "Cursor", binary: "cursor-agent", protocol: "acp", acpArgs: ["acp"], note: "Cursor's agent CLI", login: "cursor-agent login" },
  { id: "openclaw", label: "OpenClaw", binary: "openclaw", protocol: "acp", acpArgs: ["acp"], note: "Needs its gateway running", login: "openclaw onboard" },
  { id: "grok", label: "Grok", binary: "grok", protocol: "mcp", note: "Connects through warren-mcp" },
  { id: "custom", label: "Custom", binary: "", protocol: "mcp", note: "Your own agent, through the API or MCP" },
];

export const HARNESS_IDS = HARNESSES.map((h) => h.id);

/** Harnesses that come with Warren's VM image, so an agent can run entirely inside its VM. */
export const VM_HARNESSES = ["claude-code", "codex"];

export function runsInVm(harness: string): boolean {
  return VM_HARNESSES.includes(harness);
}

/** A harness a device declared itself (`acp:<name>` in its node.json). */
export const DEVICE_HARNESS = /^acp:[a-z0-9][a-z0-9-]{0,39}$/;

export function harnessInfo(id: string): HarnessInfo | undefined {
  return HARNESSES.find((h) => h.id === id);
}

export function harnessLabel(id: string): string {
  return harnessInfo(id)?.label ?? (id.startsWith("acp:") ? id.slice(4) : id);
}
