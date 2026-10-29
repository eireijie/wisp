import { z } from "zod";

/**
 * Models are the brain, harnesses the body. A person connects a model provider to Wisp once (a
 * sign-in on their subscription, or an API key); the hub keeps that connection and hands it to
 * whichever device or VM runs an agent that uses it, so nobody signs in inside a VM again.
 *
 * Which harness can use which connection, and how, is one table (CREDENTIAL_SUPPORT) that the hub,
 * the devices and the apps all read. Every row was checked against the harness on a real device
 * (Claude Code 2.1, Codex 0.162, Hermes 0.20); nothing here is a guess about a harness's flags.
 */

export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter", "google", "xai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const ModelProviderId = z.enum(MODEL_PROVIDERS);

/** A sign-in on the person's subscription ("oauth") or an API key ("key"). */
export type ConnectionKind = "oauth" | "key";
export const ConnectionKindId = z.enum(["oauth", "key"]);

export interface ModelProviderInfo {
  id: ModelProvider;
  label: string;
  /** what the subscription is called, for "Sign in with Claude" */
  signInLabel?: string;
  /** the site people open to approve a sign-in, or to make a key */
  site: string;
  keyUrl: string;
  /** what a key starts with, to catch a key pasted into the wrong provider (only where providers are consistent) */
  keyPrefix?: string;
  /**
   * How a sign-in is done: a device runs this harness's own sign-in in a scratch folder and hands
   * the result to the hub. `hermesProvider` is the provider name for `hermes auth add`.
   */
  signIn?: { harness: "claude-code" | "codex" | "hermes"; hermesProvider?: string }[];
}

export const MODEL_PROVIDER_INFO: Record<ModelProvider, ModelProviderInfo> = {
  anthropic: { id: "anthropic", label: "Claude", signInLabel: "Claude subscription", site: "https://claude.ai", keyUrl: "https://console.anthropic.com/settings/keys", keyPrefix: "sk-ant-", signIn: [{ harness: "claude-code" }] },
  openai: { id: "openai", label: "ChatGPT", signInLabel: "ChatGPT subscription", site: "https://chatgpt.com", keyUrl: "https://platform.openai.com/api-keys", keyPrefix: "sk-", signIn: [{ harness: "codex" }] },
  openrouter: { id: "openrouter", label: "OpenRouter", site: "https://openrouter.ai", keyUrl: "https://openrouter.ai/settings/keys", keyPrefix: "sk-or-" },
  google: { id: "google", label: "Gemini", site: "https://aistudio.google.com", keyUrl: "https://aistudio.google.com/apikey" },
  xai: { id: "xai", label: "Grok", signInLabel: "Grok subscription", site: "https://grok.com", keyUrl: "https://console.x.ai", keyPrefix: "xai-", signIn: [{ harness: "hermes", hermesProvider: "xai-oauth" }] },
};

export function providerLabel(p: string): string {
  return MODEL_PROVIDER_INFO[p as ModelProvider]?.label ?? p;
}

/**
 * How one harness uses one kind of connection.
 * - "env": the run's environment carries it (the harness's own folder, sessions and settings stay as they are)
 * - "home": the harness gets a folder of its own for this connection on the device or VM (Codex keeps a
 *   ChatGPT sign-in in CODEX_HOME/auth.json; Hermes picks its provider in config.yaml), with the
 *   agent's settings copied in but none of its logins
 */
export interface CredentialSupport {
  harness: string;
  provider: ModelProvider;
  kind: ConnectionKind;
  how: "env" | "home";
  /** the variables it sets (values come from the connection; "" clears one that would win over it) */
  env?: string[];
  /** a sign-in whose refresh token changes when the harness renews it: the device sends the new one back */
  rotates?: boolean;
  /** plain words for the Harnesses page and code readers */
  note: string;
}

export const CREDENTIAL_SUPPORT: CredentialSupport[] = [
  // Claude Code: `claude -p` reads these before anything it keeps itself (checked with 2.1.309)
  { harness: "claude-code", provider: "anthropic", kind: "key", how: "env", env: ["ANTHROPIC_API_KEY"], note: "ANTHROPIC_API_KEY" },
  { harness: "claude-code", provider: "anthropic", kind: "oauth", how: "env", env: ["CLAUDE_CODE_OAUTH_TOKEN"], note: "a one-year token from `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN; it doesn't rotate" },
  { harness: "claude-code", provider: "openrouter", kind: "key", how: "env", env: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"], note: "OpenRouter's Anthropic-compatible endpoint (ANTHROPIC_BASE_URL=https://openrouter.ai/api); Claude models only" },
  // Codex: CODEX_API_KEY is read by `codex exec`; a ChatGPT sign-in only lives in auth.json (checked with 0.162.1)
  { harness: "codex", provider: "openai", kind: "key", how: "env", env: ["CODEX_API_KEY"], note: "CODEX_API_KEY (read by codex exec)" },
  { harness: "codex", provider: "openai", kind: "oauth", how: "home", rotates: true, note: "auth.json in a CODEX_HOME of its own; Codex renews the token in there and the device sends it back" },
  { harness: "codex", provider: "openrouter", kind: "key", how: "env", env: ["OPENROUTER_API_KEY"], note: "a model_providers.openrouter entry (Responses API at https://openrouter.ai/api/v1) set with -c, key in OPENROUTER_API_KEY" },
  // Hermes: config.yaml's provider wins over any variable, so it gets a HERMES_HOME of its own (checked with 0.20)
  { harness: "hermes", provider: "anthropic", kind: "key", how: "home", env: ["ANTHROPIC_API_KEY"], note: "provider anthropic, key in its .env" },
  { harness: "hermes", provider: "anthropic", kind: "oauth", how: "home", env: ["CLAUDE_CODE_OAUTH_TOKEN"], note: "provider anthropic, the `claude setup-token` token in its .env" },
  { harness: "hermes", provider: "openai", kind: "key", how: "home", env: ["OPENAI_API_KEY"], note: "provider openai-api, key in its .env" },
  { harness: "hermes", provider: "openai", kind: "oauth", how: "home", rotates: true, note: "provider openai-codex, the ChatGPT sign-in in its auth.json credential pool" },
  { harness: "hermes", provider: "openrouter", kind: "key", how: "home", env: ["OPENROUTER_API_KEY"], note: "provider openrouter, key in its .env" },
  { harness: "hermes", provider: "google", kind: "key", how: "home", env: ["GEMINI_API_KEY"], note: "provider gemini, key in its .env" },
  { harness: "hermes", provider: "xai", kind: "key", how: "home", env: ["XAI_API_KEY"], note: "provider xai, key in its .env" },
  { harness: "hermes", provider: "xai", kind: "oauth", how: "home", rotates: true, note: "provider xai-oauth, the Grok sign-in in its auth.json credential pool" },
];

/** How `harness` uses this kind of connection to `provider`, or null when it can't. */
export function credentialSupport(harness: string, provider: string, kind: string): CredentialSupport | null {
  return CREDENTIAL_SUPPORT.find((s) => s.harness === harness && s.provider === provider && s.kind === kind) ?? null;
}

/** Harnesses that can run on a connection. */
export function harnessesFor(provider: string, kind: string): string[] {
  return CREDENTIAL_SUPPORT.filter((s) => s.provider === provider && s.kind === kind).map((s) => s.harness);
}

/** Which Hermes provider a connection is, in Hermes's own names (config.yaml `model.provider`). */
export function hermesProvider(provider: string, kind: string): string | null {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai") return kind === "oauth" ? "openai-codex" : "openai-api";
  if (provider === "openrouter") return "openrouter";
  if (provider === "google") return "gemini";
  if (provider === "xai") return kind === "oauth" ? "xai-oauth" : "xai";
  return null;
}

/**
 * What a connection's secret looks like, by provider and kind. Kept on the hub only (never sent
 * back by any API) and handed to a device inside a run.
 * - key: `{ key }`
 * - anthropic oauth: `{ token }` (from `claude setup-token`; long-lived, doesn't rotate)
 * - openai oauth: `{ auth }`, Codex's whole auth.json (`{ auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }`)
 * - xai oauth: `{ pool }`, a Hermes credential-pool entry (`{ access_token, refresh_token, base_url, last_refresh }`)
 */
export const ConnectionSecret = z.object({
  key: z.string().max(4000).optional(),
  token: z.string().max(4000).optional(),
  auth: z.record(z.unknown()).optional(),
  pool: z.record(z.unknown()).optional(),
});
export type ConnectionSecret = z.infer<typeof ConnectionSecret>;

/** A connection as a run carries it to a device (RunRequest.credential). */
export const RunCredential = z.object({
  connectionId: z.string().max(64),
  provider: ModelProviderId,
  kind: ConnectionKindId,
  secret: ConnectionSecret,
  /** the model to run when the agent has none picked: one the connection offers (else the harness would use its own setting, maybe another provider's model) */
  model: z.string().max(200).optional(),
});
export type RunCredential = z.infer<typeof RunCredential>;

/**
 * How much of a subscription's limit is used, as the harness reported it after a run (Claude's
 * rate_limit_event, Codex's rate_limits). `usedFraction` is 0–1 of the window that's closest to
 * running out; `windows` has each one.
 */
export const PlanWindow = z.object({
  /** "5-hour", "weekly", … */
  window: z.string().max(40),
  usedFraction: z.number().min(0).max(10),
  /** ISO time it resets */
  resetsAt: z.string().max(40).nullable(),
});
export type PlanWindow = z.infer<typeof PlanWindow>;
export const PlanUsage = PlanWindow.extend({
  /** the plan's name where the harness says it ("pro", "max") */
  planType: z.string().max(40).optional(),
  windows: z.array(PlanWindow).max(6).optional(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

/** The busiest of several windows, as the summary. */
export function planFromWindows(windows: PlanWindow[], planType?: string): PlanUsage | undefined {
  if (!windows.length) return undefined;
  const top = [...windows].sort((a, b) => b.usedFraction - a.usedFraction)[0];
  return { ...top, ...(planType ? { planType } : {}), windows };
}

/**
 * A connection as people see it (GET /api/model-connections): never the secret. `keyHint` is the
 * key's last four characters; `account` is the email or account name a sign-in belongs to, where known.
 */
export interface ModelConnection {
  id: string;
  provider: ModelProvider;
  kind: ConnectionKind;
  label: string;
  account: string | null;
  /** "Max", "Pro", "Plus"… where the sign-in says */
  plan: string | null;
  keyHint: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** the last time it failed to sign in (a revoked key, an expired sign-in); null once a run works again */
  lastError: string | null;
  /** the latest plan usage a run reported */
  usage: (PlanUsage & { capturedAt: string }) | null;
  /** agents that run on it */
  usedBy: { id: string; handle: string; name: string }[];
  /** harnesses that can use it */
  harnesses: string[];
  /** whether the person asking owns it (only owners see their own connections in full, and only they assign them) */
  mine: boolean;
}

/** A model a connection offers (GET /api/model-connections/:id/models). */
export interface ConnectionModel {
  id: string;
  label: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
}

/** The last four characters of a key, for "API key ····a91f". */
export function keyHint(key: string): string {
  return key.trim().slice(-4);
}

/**
 * Who a ChatGPT sign-in belongs to and on which plan, from the id token Codex keeps (a JWT; read,
 * not verified: it's for display). Exported for tests.
 */
export function chatgptAccount(auth: Record<string, unknown> | undefined): { account: string | null; plan: string | null } {
  const idToken = (auth?.tokens as { id_token?: unknown } | undefined)?.id_token;
  if (typeof idToken !== "string") return { account: null, plan: null };
  try {
    const part = idToken.split(".")[1] ?? "";
    const json = JSON.parse(typeof atob === "function" ? atob(part.replace(/-/g, "+").replace(/_/g, "/")) : "");
    const claims = (json["https://api.openai.com/auth"] ?? {}) as { chatgpt_plan_type?: unknown };
    const plan = typeof claims.chatgpt_plan_type === "string" ? claims.chatgpt_plan_type : null;
    return { account: typeof json.email === "string" ? json.email : null, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
  } catch {
    return { account: null, plan: null };
  }
}
