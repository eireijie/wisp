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
  /**
   * How to install it on a device. `npm` packages Warren can install itself when the device's owner
   * presses Install (the device runs `npm install -g <npm>`; the hub only names the harness).
   * Others show `command` to copy, or `docs`.
   */
  install?: { npm?: string; command?: string; docs?: string };
}

export const HARNESSES: HarnessInfo[] = [
  { id: "claude-code", label: "Claude Code", binary: "claude", protocol: "native", note: "Anthropic's coding agent", login: "claude (then /login)", install: { npm: "@anthropic-ai/claude-code" } },
  { id: "codex", label: "Codex", binary: "codex", protocol: "native", note: "OpenAI's coding agent", login: "codex login", install: { npm: "@openai/codex" } },
  { id: "hermes", label: "Hermes", binary: "hermes", protocol: "acp", acpArgs: ["acp"], note: "Nous Research's agent, with its own skills", login: "hermes setup", install: { docs: "https://github.com/NousResearch/hermes-agent" } },
  { id: "gemini", label: "Gemini CLI", binary: "gemini", protocol: "acp", acpArgs: ["--acp"], note: "Google's agent", login: "gemini (then sign in)", install: { npm: "@google/gemini-cli" } },
  { id: "opencode", label: "OpenCode", binary: "opencode", protocol: "acp", acpArgs: ["acp"], note: "Open-source agent for any model", login: "opencode auth login", install: { npm: "opencode-ai" } },
  { id: "goose", label: "Goose", binary: "goose", protocol: "acp", acpArgs: ["acp"], note: "Block's open-source agent", login: "goose configure", install: { command: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash", docs: "https://block.github.io/goose/docs/getting-started/installation" } },
  { id: "kimi", label: "Kimi CLI", binary: "kimi", protocol: "acp", acpArgs: ["acp"], note: "Moonshot's agent", login: "kimi (then /login)", install: { command: "uv tool install kimi-cli", docs: "https://github.com/MoonshotAI/kimi-cli" } },
  { id: "qwen", label: "Qwen Code", binary: "qwen", protocol: "acp", acpArgs: ["--acp"], note: "Alibaba's agent", login: "qwen (then sign in)", install: { npm: "@qwen-code/qwen-code" } },
  { id: "cursor", label: "Cursor", binary: "cursor-agent", protocol: "acp", acpArgs: ["acp"], note: "Cursor's agent CLI", login: "cursor-agent login", install: { command: "curl https://cursor.com/install -fsS | bash", docs: "https://cursor.com/cli" } },
  { id: "openclaw", label: "OpenClaw", binary: "openclaw", protocol: "acp", acpArgs: ["acp"], note: "Needs its gateway running", login: "openclaw onboard", install: { npm: "openclaw" } },
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

/** What a run's error looks like when the harness wants a person to sign in (or sign in again). */
const SIGN_IN_ERRORS: Record<string, RegExp> = {
  "claude-code": /OAuth (access )?token (has )?expired|Failed to authenticate|not logged in|run \/login|Invalid API key|authentication_error|Please log in/i,
  codex: /not logged in|codex login|401 Unauthorized|Unauthorized|Missing (API key|credentials)|No API key|Please log ?in/i,
};
const SIGN_IN_ANY = /not logged in|not authenticated|not signed in|please (sign|log) in|login required|token (has )?expired|authentication (failed|error|required)|\b401\b/i;

export interface SignInProblem {
  harness: string;
  label: string;
  /** the command to run on the device */
  login: string;
  /** the whole thing in plain words, naming the device */
  explain(device: string): string;
}

/**
 * Is this run error the harness saying it needs a person to sign in on its device? Then what to
 * tell people, so "API Error: 401 OAuth access token has expired" becomes something they can act on.
 */
export function signInProblem(harness: string, error: string): SignInProblem | null {
  const info = harnessInfo(harness);
  if (!info?.login) return null;
  const pattern = SIGN_IN_ERRORS[harness] ?? SIGN_IN_ANY;
  if (!pattern.test(error)) return null;
  const { label, login } = info;
  return { harness, label, login, explain: (device) => `${label} on ${device} needs to be signed in again. In a terminal there, run \`${login}\`; then ask again.` };
}
