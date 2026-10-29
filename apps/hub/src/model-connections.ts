import { CREDENTIAL_SUPPORT, ConnectionSecret, harnessesFor, keyHint, type ConnectionKind, type ConnectionModel, type HarnessCatalog, type ModelConnection, type ModelProvider, type PlanUsage, type RunCredential } from "@wisp/core";
import { id, now } from "./auth.ts";
import type { Db } from "./db.ts";

/**
 * Model connections (models.ts): a person's sign-in or API key for a model provider, kept on the
 * hub and handed to whichever device or VM runs an agent on it, with each run. Secrets stay here:
 * nothing in this file returns one to a person, only to a run (credentialFor) and to the device
 * that renews it. SQL for them lives here, apart from the main store.
 */

type Row = {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: ModelProvider;
  kind: ConnectionKind;
  label: string;
  account: string | null;
  plan: string | null;
  secret_json: string;
  usage_json: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_error: string | null;
};

/** How long a provider's model list is reused before it's fetched again. */
const MODELS_TTL_MS = 10 * 60_000;

/**
 * A ChatGPT or Grok sign-in whose token will be renewed soon. Renewing rotates the refresh token
 * (the old one stops working at once), so while it's due, the hub runs one agent on it at a time
 * and waits for the renewed one to come back before the next. Codex renews auth.json once it's
 * 8 days old; Hermes once the access token is about to expire. 6 days and a day's margin cover both.
 */
export function renewalDue(secret: ConnectionSecret, at = Date.now()): boolean {
  const auth = (secret.auth ?? secret.pool) as Record<string, any> | undefined;
  if (!auth) return false;
  const last = Date.parse(String(auth.last_refresh ?? ""));
  if (!Number.isFinite(last) || at - last > 6 * 86_400_000) return true;
  const access = String(auth.tokens?.access_token ?? auth.access_token ?? "");
  const exp = jwtExpiry(access);
  return exp !== null && exp - at < 86_400_000;
}

function jwtExpiry(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class ModelConnections {
  private cache = new Map<string, { at: number; models: ConnectionModel[] }>();

  constructor(
    readonly db: Db,
    /** for tests: answer providers' model lists without the network */
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  create(c: { workspaceId: string; userId: string; provider: ModelProvider; kind: ConnectionKind; label: string; secret: ConnectionSecret; account?: string | null; plan?: string | null }): string {
    const cid = id("mc");
    const t = now();
    this.db
      .prepare("INSERT INTO model_connections (id, workspace_id, user_id, provider, kind, label, account, plan, secret_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(cid, c.workspaceId, c.userId, c.provider, c.kind, c.label, c.account ?? null, c.plan ?? null, JSON.stringify(ConnectionSecret.parse(c.secret)), t, t);
    return cid;
  }

  row(connectionId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM model_connections WHERE id = ?").get(connectionId) as Row | undefined;
  }

  /** A person's connections, oldest first. */
  mine(workspaceId: string, userId: string): Row[] {
    return this.db.prepare("SELECT * FROM model_connections WHERE workspace_id = ? AND user_id = ? ORDER BY created_at").all(workspaceId, userId) as Row[];
  }

  /** As people see it: never the secret (a key's last four characters at most). */
  view(r: Row, viewerId: string, usedBy: ModelConnection["usedBy"]): ModelConnection {
    const secret = JSON.parse(r.secret_json) as ConnectionSecret;
    return {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      label: r.label,
      account: r.account,
      plan: r.plan,
      keyHint: r.kind === "key" && secret.key ? keyHint(secret.key) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
      lastError: r.last_error,
      usage: r.usage_json ? JSON.parse(r.usage_json) : null,
      usedBy,
      harnesses: harnessesFor(r.provider, r.kind),
      mine: r.user_id === viewerId,
    };
  }

  rename(connectionId: string, label: string) {
    this.db.prepare("UPDATE model_connections SET label = ?, updated_at = ? WHERE id = ?").run(label, now(), connectionId);
  }

  remove(connectionId: string) {
    this.db.prepare("DELETE FROM model_connections WHERE id = ?").run(connectionId);
    for (const k of [...this.cache.keys()]) if (k === connectionId || k.startsWith(`${connectionId}:`)) this.cache.delete(k);
  }

  secret(connectionId: string): ConnectionSecret | null {
    const r = this.row(connectionId);
    return r ? (JSON.parse(r.secret_json) as ConnectionSecret) : null;
  }

  /** What a run carries to its device (RunRequest.credential). */
  credentialFor(connectionId: string): RunCredential | null {
    const r = this.row(connectionId);
    return r ? { connectionId: r.id, provider: r.provider, kind: r.kind, secret: JSON.parse(r.secret_json) } : null;
  }

  /** A harness renewed the sign-in: keep the new one (only the parts a sign-in has). */
  saveRenewed(connectionId: string, secret: ConnectionSecret) {
    const r = this.row(connectionId);
    if (!r || r.kind !== "oauth") return false;
    const before = JSON.parse(r.secret_json) as ConnectionSecret;
    const next: ConnectionSecret = { ...before, ...(secret.auth ? { auth: secret.auth } : {}), ...(secret.pool ? { pool: secret.pool } : {}), ...(secret.token ? { token: secret.token } : {}) };
    this.db.prepare("UPDATE model_connections SET secret_json = ?, updated_at = ?, last_error = NULL WHERE id = ?").run(JSON.stringify(ConnectionSecret.parse(next)), now(), connectionId);
    return true;
  }

  /** A run reported how much of the plan is used. */
  setUsage(connectionId: string, plan: PlanUsage) {
    this.db.prepare("UPDATE model_connections SET usage_json = ? WHERE id = ?").run(JSON.stringify({ ...plan, capturedAt: now() }), connectionId);
  }

  /** A run on it started (or worked again, clearing an earlier sign-in error). */
  used(connectionId: string) {
    this.db.prepare("UPDATE model_connections SET last_used_at = ? WHERE id = ?").run(now(), connectionId);
  }

  setError(connectionId: string, error: string | null) {
    this.db.prepare("UPDATE model_connections SET last_error = ? WHERE id = ?").run(error ? error.slice(0, 500) : null, connectionId);
  }

  /** A sign-in whose harness renews it, changing the refresh token (a key or Claude's long-lived token never does). */
  rotates(connectionId: string): boolean {
    const r = this.row(connectionId);
    return !!r && r.kind === "oauth" && CREDENTIAL_SUPPORT.some((s) => s.provider === r.provider && s.kind === "oauth" && s.rotates);
  }

  /** Whether the hub should run one agent at a time on it right now (see renewalDue). */
  oneAtATime(connectionId: string): boolean {
    return this.rotates(connectionId) && renewalDue(JSON.parse(this.row(connectionId)!.secret_json));
  }

  /**
   * The models a connection offers. Keys ask the provider's own list (cached for a while); sign-ins
   * use what the harness that runs them lists (`catalog`), since subscriptions have no list of
   * their own (Claude's is tried with the token first). Throws only for a key the provider turns down.
   */
  async models(connectionId: string, catalog?: HarnessCatalog | null, opts: { fresh?: boolean } = {}): Promise<ConnectionModel[]> {
    const r = this.row(connectionId);
    if (!r) return [];
    // a key's list is the provider's; a sign-in's may be the harness's, so it's kept per harness
    const cacheKey = r.kind === "key" ? connectionId : `${connectionId}:${catalog?.harness ?? ""}`;
    const hit = this.cache.get(cacheKey);
    if (hit && !opts.fresh && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
    const secret = JSON.parse(r.secret_json) as ConnectionSecret;
    let models: ConnectionModel[] | null = null;
    if (r.kind === "key" && secret.key) models = await this.providerModels(r.provider, { key: secret.key });
    else if (r.provider === "anthropic" && secret.token) models = await this.providerModels("anthropic", { oauthToken: secret.token }).catch(() => null);
    if (!models?.length) models = (catalog?.models ?? []).map((m) => ({ id: m.id, label: m.label, ...(m.description ? { description: m.description } : {}), ...(m.efforts ? { efforts: m.efforts } : {}), ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }));
    if (models.length) this.cache.set(cacheKey, { at: Date.now(), models });
    return models;
  }

  /** Check a key before keeping it: the provider's model list with it. Null when it works (or the provider can't be reached). */
  async checkKey(provider: ModelProvider, key: string): Promise<string | null> {
    try {
      await this.providerModels(provider, { key }, true);
      return null;
    } catch (err) {
      return err instanceof KeyRejected ? err.message : null;
    }
  }

  /** A provider's own model list. Exported through the class for tests via fetchFn. */
  private async providerModels(provider: ModelProvider, auth: { key?: string; oauthToken?: string }, check = false): Promise<ConnectionModel[]> {
    const get = async (url: string, headers: Record<string, string>) => {
      const res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) throw new KeyRejected(`${res.status === 401 ? "the key wasn't accepted" : "the key isn't allowed to do that"} (${providerName(provider)} said ${res.status})`);
      if (!res.ok) throw new Error(`${providerName(provider)} answered ${res.status}`);
      return (await res.json()) as any;
    };
    const bearer = { authorization: `Bearer ${auth.key ?? auth.oauthToken}` };
    if (provider === "anthropic") {
      const headers: Record<string, string> = auth.key ? { "x-api-key": auth.key, "anthropic-version": "2023-06-01" } : { ...bearer, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
      const data = await get("https://api.anthropic.com/v1/models?limit=100", headers);
      return (data.data ?? []).map((m: any) => ({ id: String(m.id), label: String(m.display_name ?? m.id) }));
    }
    if (provider === "openai") {
      const data = await get("https://api.openai.com/v1/models", bearer);
      return (data.data ?? [])
        .map((m: any) => String(m.id))
        .filter((m: string) => /^(gpt|o\d|codex|chatgpt)/.test(m) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct)/.test(m))
        .sort()
        .map((m: string) => ({ id: m, label: m }));
    }
    if (provider === "openrouter") {
      // the list is public; the key is checked on its own endpoint
      if (check && auth.key) await get("https://openrouter.ai/api/v1/key", bearer);
      const data = await get("https://openrouter.ai/api/v1/models", {});
      return (data.data ?? []).map((m: any) => ({
        id: String(m.id),
        label: String(m.name ?? m.id),
        ...(m.description ? { description: String(m.description).slice(0, 300) } : {}),
        ...(Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning") ? { efforts: ["low", "medium", "high"] } : {}),
        ...(typeof m.context_length === "number" ? { contextWindow: m.context_length } : {}),
      }));
    }
    if (provider === "google") {
      // the key goes in a header, not the address
      const data = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": auth.key ?? "" });
      return (data.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), label: String(m.displayName ?? m.name), ...(typeof m.inputTokenLimit === "number" ? { contextWindow: m.inputTokenLimit } : {}) }));
    }
    if (provider === "xai") {
      const data = await get("https://api.x.ai/v1/models", bearer);
      return (data.data ?? []).map((m: any) => ({ id: String(m.id), label: String(m.id) }));
    }
    return [];
  }
}

export class KeyRejected extends Error {}

function providerName(p: ModelProvider) {
  return { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", google: "Google", xai: "xAI" }[p] ?? p;
}

/**
 * The models a harness can run from a connection's list. Claude Code reaches OpenRouter through its
 * Anthropic-compatible endpoint, which serves Claude models only; everything else runs what the
 * provider lists. Exported for tests.
 */
export function modelsForHarness(harness: string, provider: ModelProvider, models: ConnectionModel[]): ConnectionModel[] {
  if (harness === "claude-code" && provider === "openrouter") return models.filter((m) => m.id.startsWith("anthropic/"));
  return models;
}
