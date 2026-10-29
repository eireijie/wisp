import fs from "node:fs/promises";
import path from "node:path";
import { credentialSupport, harnessLabel, hermesProvider, providerLabel, type ConnectionSecret, type RunCredential } from "@wisp/core";
import { yamlSetScalar } from "./harness-formats.ts";

/**
 * Putting a model connection (models.ts) where a harness reads it, for one run, on the device or
 * inside a VM. Keys and long-lived tokens go in the run's environment, so the harness keeps its own
 * folder (sessions, settings) as always. Sign-ins that only live in a file (a ChatGPT sign-in in
 * Codex's auth.json) and Hermes (whose config.yaml picks the provider, over any variable) get a
 * folder of their own per connection: the agent's settings are copied in, never its logins, and
 * the folder stays, so sessions in it can be resumed next time.
 *
 * Harnesses renew some sign-ins as they go and the old refresh token stops working (OpenAI rotates
 * it). After a run, `refreshed()` says whether that happened, so the device can send the new one
 * back to the hub and the next run anywhere uses it.
 */

/** The filesystem the harness runs on: this device's, or a VM's (through its engine). */
export interface CredentialFs {
  join(...parts: string[]): string;
  read(file: string): Promise<string | null>;
  /** write a file (its folder made first), readable only by its owner when `mode` says so */
  write(file: string, content: string, mode?: number): Promise<void>;
  /** make `link` point at `target`, when `target` exists and nothing is at `link` yet */
  link(target: string, link: string): Promise<void>;
}

export const localCredentialFs: CredentialFs = {
  join: (...p) => path.join(...p),
  read: (f) => fs.readFile(f, "utf8").catch(() => null),
  async write(f, content, mode) {
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await fs.writeFile(f, content, mode ? { mode } : undefined);
    if (mode) await fs.chmod(f, mode).catch(() => {});
  },
  async link(target, link) {
    if (!(await fs.stat(target).catch(() => null)) || (await fs.lstat(link).catch(() => null))) return;
    await fs.symlink(target, link).catch(() => {});
  },
};

export interface PreparedCredential {
  /** variables for the run's environment */
  env: Record<string, string>;
  /** after the run: the renewed secret, when the harness renewed the sign-in; else null */
  refreshed(): Promise<ConnectionSecret | null>;
}

export interface CredentialPlaces {
  fs: CredentialFs;
  /** the harness folder the agent uses otherwise (~/.codex, an account's folder, ~/.hermes in a VM) */
  baseHome: string;
  /** the folder this connection gets for this harness, when it needs one (kept between runs) */
  connectionHome: string;
}

/** Variables that carry a model provider's key or token, which a connection's own must not lose to. */
const MODEL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"];

/** Where Hermes keeps a ChatGPT sign-in's tokens (hermes_cli/auth.py DEFAULT_CODEX_BASE_URL). */
const HERMES_CODEX_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Put a connection where `harness` reads it. Throws, in plain words, for a pairing the support
 * table (CREDENTIAL_SUPPORT) doesn't have, or a connection whose secret is missing what it needs.
 */
export async function prepareCredential(harness: string, cred: RunCredential, at: CredentialPlaces): Promise<PreparedCredential> {
  const support = credentialSupport(harness, cred.provider, cred.kind);
  if (!support) throw new Error(`${harnessLabel(harness)} can't use a ${providerLabel(cred.provider)} ${cred.kind === "oauth" ? "sign-in" : "key"}`);
  const s = cred.secret;
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`the ${providerLabel(cred.provider)} connection has no ${what}; connect it again in Settings → Models`);
    return v;
  };
  const none = async () => null;

  if (harness === "claude-code") {
    // `claude -p` takes an API key over a token over its own login; the others are cleared so the connection wins
    if (cred.provider === "anthropic" && cred.kind === "key") return { env: { ANTHROPIC_API_KEY: need(s.key, "key"), CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_AUTH_TOKEN: "" }, refreshed: none };
    if (cred.provider === "anthropic") return { env: { CLAUDE_CODE_OAUTH_TOKEN: need(s.token, "token"), ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" }, refreshed: none };
    // OpenRouter's Anthropic-compatible endpoint takes the key as a bearer token
    return { env: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: need(s.key, "key"), ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" }, refreshed: none };
  }

  if (harness === "codex") {
    if (cred.kind === "key") return { env: cred.provider === "openrouter" ? { OPENROUTER_API_KEY: need(s.key, "key") } : { CODEX_API_KEY: need(s.key, "key") }, refreshed: none };
    // a ChatGPT sign-in: auth.json in a CODEX_HOME of its own, with the agent's config.toml and skills
    const home = at.connectionHome;
    const authFile = at.fs.join(home, "auth.json");
    const given = s.auth;
    if (!given || !tokensOf(given).refresh_token) throw new Error("the ChatGPT connection has no sign-in; connect it again in Settings → Models");
    const local = parseJson(await at.fs.read(authFile));
    // two runs on this device share the folder: a sign-in renewed here since is newer than the hub's copy, so it stays
    const auth = local && newer(local.last_refresh, given.last_refresh) ? local : given;
    await at.fs.write(authFile, JSON.stringify(auth, null, 2), 0o600);
    await copyConfig(at, "config.toml");
    for (const name of ["skills", "AGENTS.md", "rules", "prompts"]) await at.fs.link(at.fs.join(at.baseHome, name), at.fs.join(home, name));
    const sent = tokensOf(auth);
    return {
      env: { CODEX_HOME: home },
      async refreshed() {
        const now = parseJson(await at.fs.read(authFile));
        const t = now ? tokensOf(now) : null;
        if (!now || !t?.refresh_token || (t.refresh_token === sent.refresh_token && t.access_token === sent.access_token)) return local && auth === local ? { auth } : null;
        return { auth: now };
      },
    };
  }

  if (harness === "hermes") {
    const provider = hermesProvider(cred.provider, cred.kind)!;
    const home = at.connectionHome;
    // config.yaml picks the provider (it wins over any variable), the agent's other settings as they are
    const config = (await at.fs.read(at.fs.join(at.baseHome, "config.yaml"))) ?? "";
    let edited: string;
    try {
      edited = yamlSetScalar(config, ["model", "provider"], provider);
    } catch {
      edited = `model:\n  provider: ${provider}\n`;
    }
    await at.fs.write(at.fs.join(home, "config.yaml"), edited, 0o600);
    // its .env, without any model key in it (Hermes prefers .env over the environment), plus the connection's
    const dotenv = ((await at.fs.read(at.fs.join(at.baseHome, ".env"))) ?? "")
      .split("\n")
      .filter((l) => !MODEL_VARS.includes(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(l)?.[1] ?? ""))
      .join("\n")
      .trimEnd();
    const keyVar = support.env?.[0];
    const value = cred.kind === "key" ? need(s.key, "key") : cred.provider === "anthropic" ? need(s.token, "token") : null;
    await at.fs.write(at.fs.join(home, ".env"), `${dotenv ? dotenv + "\n" : ""}${keyVar && value ? `${keyVar}=${value}\n` : ""}`, 0o600);
    // a sign-in Hermes renews itself goes in its credential pool (auth.json)
    const authFile = at.fs.join(home, "auth.json");
    let sent: Record<string, unknown> | null = null;
    if (cred.kind === "oauth" && cred.provider !== "anthropic") {
      const entry = cred.provider === "openai" ? hermesEntryFromCodex(s.auth) : s.pool ? { id: "wisp", label: "Wisp", auth_type: "oauth", priority: 0, source: "manual:device_code", ...s.pool } : null;
      if (!entry?.refresh_token) throw new Error(`the ${providerLabel(cred.provider)} connection has no sign-in; connect it again in Settings → Models`);
      const local = parseJson(await at.fs.read(authFile))?.credential_pool?.[provider]?.[0];
      sent = local && newer(local.last_refresh, entry.last_refresh as string | undefined) ? local : entry;
      await at.fs.write(authFile, JSON.stringify({ version: 1, providers: {}, active_provider: provider, credential_pool: { [provider]: [sent] } }, null, 2), 0o600);
    } else await at.fs.write(authFile, JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2), 0o600);
    for (const name of ["skills", "memories", "SOUL.md"]) await at.fs.link(at.fs.join(at.baseHome, name), at.fs.join(home, name));
    return {
      env: { HERMES_HOME: home },
      async refreshed() {
        if (!sent) return null;
        const now = parseJson(await at.fs.read(authFile))?.credential_pool?.[provider]?.[0];
        if (!now?.refresh_token || (now.refresh_token === sent.refresh_token && now.access_token === sent.access_token)) return null;
        return cred.provider === "openai" ? { auth: codexAuthFromHermes(s.auth ?? {}, now) } : { pool: { access_token: now.access_token, refresh_token: now.refresh_token, base_url: now.base_url, last_refresh: now.last_refresh } };
      },
    };
  }
  throw new Error(`${harnessLabel(harness)} can't use model connections yet`);
}

/** The agent's own copy of a settings file, refreshed each run (so changes to it reach the connection's folder). */
async function copyConfig(at: CredentialPlaces, name: string) {
  const text = await at.fs.read(at.fs.join(at.baseHome, name));
  if (text !== null) await at.fs.write(at.fs.join(at.connectionHome, name), text, 0o600);
}

function tokensOf(auth: Record<string, unknown>): { access_token?: string; refresh_token?: string } {
  return (auth.tokens as { access_token?: string; refresh_token?: string }) ?? {};
}

function parseJson(text: string | null): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Was `a` renewed after `b` (ISO times; a missing one is older)? */
function newer(a: unknown, b: unknown): boolean {
  const ta = typeof a === "string" ? Date.parse(a) : NaN;
  const tb = typeof b === "string" ? Date.parse(b) : NaN;
  return Number.isFinite(ta) && (!Number.isFinite(tb) || ta > tb);
}

/** A ChatGPT sign-in (Codex's auth.json) as an entry of Hermes's credential pool for openai-codex. Exported for tests. */
export function hermesEntryFromCodex(auth: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const t = auth ? tokensOf(auth) : {};
  if (!t.access_token || !t.refresh_token) return null;
  return { id: "wisp", label: "Wisp", auth_type: "oauth", priority: 0, source: "manual:device_code", access_token: t.access_token, refresh_token: t.refresh_token, base_url: HERMES_CODEX_URL, last_refresh: auth?.last_refresh ?? null };
}

/** Hermes's renewed tokens back in Codex's auth.json shape, keeping what Hermes doesn't track (the id token, account). Exported for tests. */
export function codexAuthFromHermes(before: Record<string, unknown>, entry: Record<string, any>): Record<string, unknown> {
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, ...before, tokens: { ...((before.tokens as object) ?? {}), access_token: entry.access_token, refresh_token: entry.refresh_token }, last_refresh: entry.last_refresh ?? new Date().toISOString() };
}
