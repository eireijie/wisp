import crypto from "node:crypto";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { now } from "./auth.ts";
import type { Db } from "./db.ts";

/**
 * Signing in to remote MCP servers (Notion, Linear, Zapier…) the way the MCP spec describes:
 * the hub finds the server's sign-in page, registers itself as a client, sends the person there,
 * and keeps the tokens it gets back, refreshing them before agents need them. Agents only ever
 * get a short-lived access token in their run.
 */

type Row = {
  connector_id: string;
  required: number;
  redirect_url: string | null;
  client_json: string | null;
  tokens_json: string | null;
  expires_at: string | null;
  verifier: string | null;
  state: string | null;
  signed_in_by: string | null;
  error: string | null;
};

export interface ConnectorAuthStatus {
  /** the server wants people to sign in */
  required: boolean;
  signedIn: boolean;
  /** why the last sign-in or refresh failed */
  error: string | null;
}

export const CALLBACK_PATH = "/api/connectors/oauth/callback";

/** One sign-in flow for one connector, kept in the database between the redirect and the callback. */
class Provider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(
    private db: Db,
    private connectorId: string,
    private redirect: string,
  ) {}

  private row() {
    return this.db.prepare("SELECT * FROM connector_auth WHERE connector_id = ?").get(this.connectorId) as Row | undefined;
  }

  private set(cols: Partial<Row>) {
    this.db.prepare("INSERT OR IGNORE INTO connector_auth (connector_id, updated_at) VALUES (?, ?)").run(this.connectorId, now());
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE connector_auth SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE connector_id = ?`).run(...keys.map((k) => (cols as Record<string, unknown>)[k]), now(), this.connectorId);
  }

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Warren", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  state() {
    return this.row()?.state ?? "";
  }

  clientInformation() {
    const r = this.row();
    // a client registered for another address (the hub moved, or HTTPS was added) can't come back here
    return r?.client_json && r.redirect_url === this.redirect ? (JSON.parse(r.client_json) as OAuthClientInformationMixed) : undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    this.set({ client_json: JSON.stringify(info), redirect_url: this.redirect });
  }

  tokens() {
    const r = this.row();
    return r?.tokens_json ? (JSON.parse(r.tokens_json) as OAuthTokens) : undefined;
  }

  saveTokens(tokens: OAuthTokens) {
    const expires = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    // a refresh may not send a new refresh token; keep the one we have
    const keep = this.tokens()?.refresh_token;
    this.set({ tokens_json: JSON.stringify({ ...tokens, refresh_token: tokens.refresh_token ?? keep }), expires_at: expires, error: null, required: 1 });
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(v: string) {
    this.set({ verifier: v });
  }

  codeVerifier() {
    const v = this.row()?.verifier;
    if (!v) throw new Error("this sign-in has expired; start it again");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") this.set({ client_json: null });
    if (scope === "all" || scope === "tokens") this.set({ tokens_json: null, expires_at: null });
    if (scope === "all" || scope === "verifier") this.set({ verifier: null });
  }
}

export class ConnectorAuth {
  /** tests swap this for a fake server */
  fetchFn: typeof fetch = (...a) => fetch(...a);

  constructor(private db: Db) {}

  private row(connectorId: string) {
    return this.db.prepare("SELECT * FROM connector_auth WHERE connector_id = ?").get(connectorId) as Row | undefined;
  }

  status(connectorId: string): ConnectorAuthStatus | null {
    const r = this.row(connectorId);
    if (!r || !r.required) return null;
    return { required: true, signedIn: !!r.tokens_json, error: r.error };
  }

  /**
   * Whether a remote server wants a sign-in: it answers an unauthenticated MCP request with 401.
   * Remembered, so the Connectors page can show a Sign in button.
   */
  async probe(connectorId: string, url: string, headers: Record<string, string> = {}): Promise<boolean> {
    let required = false;
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "warren", version: "0.1" } } }),
        signal: AbortSignal.timeout(15_000),
      });
      required = res.status === 401;
      await res.body?.cancel().catch(() => {});
    } catch {
      return false;
    }
    if (required) this.db.prepare("INSERT INTO connector_auth (connector_id, required, updated_at) VALUES (?, 1, ?) ON CONFLICT(connector_id) DO UPDATE SET required = 1").run(connectorId, now());
    return required;
  }

  /** Start signing in: returns the page to send the person to, or null if it's signed in already. */
  async start(connectorId: string, serverUrl: string, origin: string, userId: string): Promise<string | null> {
    const redirect = new URL(CALLBACK_PATH, origin).href;
    const provider = new Provider(this.db, connectorId, redirect);
    const state = crypto.randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO connector_auth (connector_id, required, updated_at) VALUES (?, 1, ?) ON CONFLICT(connector_id) DO UPDATE SET required = 1").run(connectorId, now());
    this.db.prepare("UPDATE connector_auth SET state = ?, signed_in_by = ?, error = NULL, tokens_json = NULL, expires_at = NULL WHERE connector_id = ?").run(state, userId, connectorId);
    const result = await auth(provider, { serverUrl, fetchFn: this.fetchFn });
    return result === "REDIRECT" ? provider.authorizationUrl!.href : null;
  }

  /** The sign-in page sent the person back with a code: trade it for tokens. */
  async finish(state: string, code: string, serverUrlFor: (connectorId: string) => string | null): Promise<string> {
    const r = this.db.prepare("SELECT * FROM connector_auth WHERE state = ?").get(state) as Row | undefined;
    if (!r?.redirect_url) throw new Error("This sign-in link has expired. Start it again from Connectors.");
    const serverUrl = serverUrlFor(r.connector_id);
    if (!serverUrl) throw new Error("That connector was removed.");
    const provider = new Provider(this.db, r.connector_id, r.redirect_url);
    try {
      await auth(provider, { serverUrl, authorizationCode: code, fetchFn: this.fetchFn });
    } catch (e) {
      this.db.prepare("UPDATE connector_auth SET error = ? WHERE connector_id = ?").run((e as Error).message.slice(0, 500), r.connector_id);
      throw e;
    } finally {
      this.db.prepare("UPDATE connector_auth SET state = NULL, verifier = NULL WHERE connector_id = ?").run(r.connector_id);
    }
    return r.connector_id;
  }

  /** Make sure the access token will last the run; refresh it if it's about to expire. */
  async fresh(connectorId: string, serverUrl: string): Promise<void> {
    const r = this.row(connectorId);
    if (!r?.tokens_json || !r.redirect_url) return;
    if (r.expires_at && new Date(r.expires_at).getTime() - Date.now() > 5 * 60_000) return;
    const tokens = JSON.parse(r.tokens_json) as OAuthTokens;
    if (!tokens.refresh_token) return;
    const provider = new Provider(this.db, connectorId, r.redirect_url);
    try {
      const result = await auth(provider, { serverUrl, fetchFn: this.fetchFn });
      if (result === "REDIRECT") throw new Error("the sign-in expired; sign in again");
    } catch (e) {
      this.db.prepare("UPDATE connector_auth SET error = ?, tokens_json = NULL, expires_at = NULL WHERE connector_id = ?").run(`Signed out: ${(e as Error).message}`.slice(0, 500), connectorId);
    }
  }

  /** The bearer token to send, if signed in. */
  accessToken(connectorId: string): string | null {
    const r = this.row(connectorId);
    return r?.tokens_json ? ((JSON.parse(r.tokens_json) as OAuthTokens).access_token ?? null) : null;
  }

  signOut(connectorId: string) {
    this.db.prepare("UPDATE connector_auth SET tokens_json = NULL, expires_at = NULL, state = NULL, verifier = NULL, error = NULL WHERE connector_id = ?").run(connectorId);
  }
}
