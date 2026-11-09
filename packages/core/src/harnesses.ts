/**
 * The agent harnesses Wisp knows. "native" harnesses have their own adapter; "acp" ones are
 * driven through the Agent Client Protocol (JSON-RPC over stdio), which most agent CLIs speak;
 * "mcp" ones join through wisp-mcp from wherever they already run.
 *
 * A device can override how a harness starts, or add its own ACP agents, in its node.json:
 *   "harnesses": { "qwen": { "args": ["--experimental-acp"] }, "acp:my-bot": { "label": "My bot", "command": "my-bot", "args": ["acp"] } }
 */
export interface HarnessInfo {
  id: string;
  label: string;
  /** binary looked up on the device (`wisp doctor`) */
  binary: string;
  protocol: "native" | "acp" | "mcp";
  /** arguments that start it in ACP mode */
  acpArgs?: string[];
  /** one line for the "add agent" picker */
  note: string;
  /** a plain sentence for people who don't know the product: who makes it and what it is */
  blurb?: string;
  /** what sign-in or account it needs, in plain words */
  account?: string;
  /** where to get an account, for the harnesses Wisp recommends */
  signup?: string;
  /** how to sign it in on a device, when it needs that before it can run */
  login?: string;
  /**
   * How to install it on a device. `npm` packages Wisp can install itself when the device's owner
   * presses Install (the device runs `npm install -g <npm>`; the hub only names the harness).
   * Others show `command` to copy, or `docs`.
   */
  install?: { npm?: string; command?: string; docs?: string };
}

export const HARNESSES: HarnessInfo[] = [
  { id: "claude-code", label: "Claude Code", binary: "claude", protocol: "native", note: "Anthropic's coding agent", blurb: "Made by Anthropic, the company behind Claude.", account: "Needs a Claude subscription (Pro or Max) or an Anthropic API key, signed in on the device.", signup: "https://claude.ai", login: "claude (then /login)", install: { npm: "@anthropic-ai/claude-code" } },
  { id: "codex", label: "Codex", binary: "codex", protocol: "native", note: "OpenAI's coding agent", blurb: "Made by OpenAI, the company behind ChatGPT.", account: "Needs a ChatGPT account (Plus or higher) or an OpenAI API key, signed in on the device.", signup: "https://chatgpt.com", login: "codex login", install: { npm: "@openai/codex" } },
  { id: "hermes", label: "Hermes", binary: "hermes", protocol: "acp", acpArgs: ["acp"], note: "Nous Research's agent, with its own skills", blurb: "Made by Nous Research. An open-source agent with its own skills.", account: "Use an account from an AI provider you choose; you set it up when you install Hermes.", login: "hermes setup", install: { command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", docs: "https://github.com/NousResearch/hermes-agent" } },
  { id: "gemini", label: "Gemini CLI", binary: "gemini", protocol: "acp", acpArgs: ["--acp"], note: "Google's agent", blurb: "Made by Google. Works with Gemini models.", account: "Sign in with a Google account. There is a free tier.", signup: "https://gemini.google.com", login: "gemini (then sign in)", install: { npm: "@google/gemini-cli" } },
  { id: "opencode", label: "OpenCode", binary: "opencode", protocol: "acp", acpArgs: ["acp"], note: "Open-source agent for any model", blurb: "An open-source agent that works with many AI models.", account: "Use an account from an AI provider you choose.", login: "opencode auth login", install: { npm: "opencode-ai" } },
  { id: "goose", label: "Goose", binary: "goose", protocol: "acp", acpArgs: ["acp"], note: "Block's open-source agent", blurb: "Made by Block. An open-source agent that works with many AI models.", account: "Use an account from an AI provider you choose.", login: "goose configure", install: { command: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash", docs: "https://block.github.io/goose/docs/getting-started/installation" } },
  { id: "kimi", label: "Kimi CLI", binary: "kimi", protocol: "acp", acpArgs: ["acp"], note: "Moonshot's agent", blurb: "Made by Moonshot AI. Works with Kimi models.", account: "Needs a Moonshot (Kimi) account, signed in on the device.", login: "kimi login", install: { npm: "@moonshot-ai/kimi-code", docs: "https://github.com/MoonshotAI/kimi-code" } },
  { id: "qwen", label: "Qwen Code", binary: "qwen", protocol: "acp", acpArgs: ["--acp"], note: "Alibaba's agent", blurb: "Made by Alibaba. Works with Qwen models.", account: "Sign in with the account Qwen Code asks for on the device.", login: "qwen (then sign in)", install: { npm: "@qwen-code/qwen-code" } },
  { id: "cursor", label: "Cursor", binary: "cursor-agent", protocol: "acp", acpArgs: ["acp"], note: "Cursor's agent CLI", blurb: "Made by Cursor, the code editor company.", account: "Needs a Cursor account, signed in on the device.", login: "cursor-agent login", install: { command: "curl https://cursor.com/install -fsS | bash", docs: "https://cursor.com/cli" } },
  { id: "openclaw", label: "OpenClaw", binary: "openclaw", protocol: "acp", acpArgs: ["acp"], note: "Needs its gateway running", blurb: "An open-source assistant that runs through its own gateway.", account: "Set up and sign in inside OpenClaw first; its gateway must be running.", login: "openclaw onboard", install: { npm: "openclaw" } },
  { id: "grok", label: "Grok", binary: "grok", protocol: "mcp", note: "Connects through wisp-mcp", blurb: "Made by xAI. Works with Grok models.", account: "Set up where it already runs. It connects to Wisp through wisp-mcp." },
  { id: "custom", label: "Custom", binary: "", protocol: "mcp", note: "Your own agent, through the API or MCP", blurb: "Your own agent, or one Wisp doesn't list.", account: "Set up where it already runs. It connects to Wisp through the API or wisp-mcp." },
];

export const HARNESS_IDS = HARNESSES.map((h) => h.id);

/** Harnesses that come with Wisp's VM image, so an agent can run entirely inside its VM. */
export const VM_HARNESSES = ["claude-code", "codex", "hermes", "kimi"];

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
 * A run error fit to show a person: one line, no backticks, no file paths or system error codes.
 * The original stays on the run for the logs.
 */
export function plainFailure(error: string): string {
  const line = error.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (/\bE(NOENT|ACCES|PERM|CONNREFUSED|CONNRESET|PIPE|TIMEDOUT)\b|^\s*at\s|Traceback|TypeError|ReferenceError/.test(line)) return "Something went wrong on its device. Try again; if it keeps failing, check that device is running.";
  const plain = line.replace(/`/g, "").replace(/(^|[\s("'=:])(~|\.{0,2})?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, "$1a file").replace(/\s+/g, " ").trim();
  return plain.length > 300 ? `${plain.slice(0, 297).trimEnd()}…` : plain || "It stopped before it finished.";
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
  return { harness, label, login, explain: (device) => `${label} on ${device} isn't signed in. Open Settings → Harnesses, sign in to ${label} on ${device}, then ask again.` };
}

/**
 * The harness to preselect for a new agent: the first of `ids` that's signed in, else the first
 * nobody can tell about, else the first (every one is known to be signed out, so the person is
 * asked to sign in). A harness that would fail its first reply is never picked over one that works.
 * `signedIn` says true, false, or null/undefined when unknown.
 */
export function preferSignedIn(ids: readonly string[], signedIn: (id: string) => boolean | null | undefined): string | undefined {
  const seen = [...new Set(ids)];
  return seen.find((id) => signedIn(id) === true) ?? seen.find((id) => signedIn(id) !== false) ?? seen[0];
}

/** Is any account of a harness signed in (true), are all known to be signed out (false), or can't anyone tell (null)? */
export function accountsSignedIn(accounts: Record<string, boolean | null> | undefined): boolean | null {
  const v = Object.values(accounts ?? {});
  if (v.some((x) => x === true)) return true;
  return v.length && v.every((x) => x === false) ? false : null;
}
