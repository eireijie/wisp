import { envVar } from "@wisp/core";
import crypto from "node:crypto";
import fs from "node:fs";
import type { Hub } from "./hub.ts";
import type { PushPayload, PushDevice } from "./apns.ts";

/**
 * Push notifications to Wisp's Android app through Firebase Cloud Messaging (FCM, HTTP v1), the
 * Android twin of apns.ts. Optional: a hub without a Firebase service account keeps Android
 * tokens but sends nothing. The service account is the self-hoster's own (Firebase console →
 * Project settings → Service accounts → Generate new private key), from env vars (WISP_FCM_*) or,
 * if those aren't set, from Settings (an owner's PUT /api/settings/push/android).
 *
 * The same settings hold the Firebase *client* config (app id, API key, sender id) that the app
 * fetches from GET /api/me/push, so the open-source app has no google-services.json baked in.
 */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** What the Android app needs to start Firebase at runtime (none of it secret). */
export interface FirebaseClientConfig {
  projectId: string;
  applicationId: string;
  apiKey: string;
  senderId: string;
}

export interface FcmConfig {
  serviceAccount: ServiceAccount;
  applicationId: string;
  apiKey: string;
  senderId: string;
}

export interface FcmResult {
  status: number;
  /** FCM's error status ("UNREGISTERED", "INVALID_ARGUMENT"…) and message, when it said */
  reason?: string;
  message?: string;
}

const SETTING = "push.fcm";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_ORIGIN = "https://fcm.googleapis.com";

export class Fcm {
  /** overrides Google's FCM address (tests) */
  origin: string | null = null;
  private access: { key: string; value: string; expires: number } | null = null;

  constructor(private hub: Hub) {}

  private get db() {
    return this.hub.store.db;
  }

  // --- configuration ----------------------------------------------------------------------------

  /** The Firebase setup in use: env vars win over Settings. Null when Android push isn't set up. */
  config(workspaceId: string): (FcmConfig & { source: "env" | "settings" }) | null {
    const env = process.env;
    const file = envVar("FCM_SERVICE_ACCOUNT_FILE", env);
    const raw = envVar("FCM_SERVICE_ACCOUNT", env) ?? (file ? readFile(file) : undefined);
    const applicationId = envVar("FCM_APP_ID", env), apiKey = envVar("FCM_API_KEY", env), senderId = envVar("FCM_SENDER_ID", env);
    if (raw && applicationId && apiKey && senderId) {
      try {
        return { serviceAccount: parseServiceAccount(raw), applicationId, apiKey, senderId, source: "env" };
      } catch {}
    }
    const saved = this.hub.store.setting(workspaceId, SETTING);
    if (!saved) return null;
    try {
      return { ...(JSON.parse(saved) as FcmConfig), source: "settings" };
    } catch {
      return null;
    }
  }

  saveConfig(workspaceId: string, cfg: FcmConfig | null) {
    if (cfg) parseServiceAccount(JSON.stringify(cfg.serviceAccount));
    this.hub.store.setSetting(workspaceId, SETTING, cfg ? JSON.stringify(cfg) : null);
    this.access = null;
  }

  /** What the app starts Firebase with; null when this hub can't send to Android. */
  client(workspaceId: string): FirebaseClientConfig | null {
    const cfg = this.config(workspaceId);
    return cfg ? { projectId: cfg.serviceAccount.project_id, applicationId: cfg.applicationId, apiKey: cfg.apiKey, senderId: cfg.senderId } : null;
  }

  // --- sending ------------------------------------------------------------------------------------

  /** Push to this person's Android phones in the workspace. */
  async sendTo(workspaceId: string, userId: string, payload: PushPayload, badge: number): Promise<{ sent: number; failed: { status: number; reason?: string }[] }> {
    const devices = (this.hub.apns.devices(userId) as PushDevice[]).filter((d) => d.platform === "android" && d.workspaceId === workspaceId);
    const result = { sent: 0, failed: [] as { status: number; reason?: string }[] };
    if (!devices.length) return result;
    const cfg = this.config(workspaceId);
    if (!cfg) return result;
    const { alert } = payload.aps;
    const data: Record<string, string> = { title: alert.title, body: alert.body, badge: String(badge), kind: payload.wisp.kind, category: payload.wisp.category };
    for (const [k, v] of Object.entries(payload.wisp)) if ((k === "channelId" || k === "threadId" || k === "approvalId" || k === "computerId") && typeof v === "string") data[k] = v;
    for (const d of devices) {
      let r = await this.post(cfg, d.token, data).catch((err: Error) => ({ status: 0, message: err.message }) as FcmResult);
      if (r.status === 401) {
        this.access = null;
        r = await this.post(cfg, d.token, data).catch((err: Error) => ({ status: 0, message: err.message }) as FcmResult);
      }
      if (r.status === 200) result.sent++;
      else {
        result.failed.push({ status: r.status, reason: r.reason ?? r.message });
        // FCM says this install is gone (app deleted or data cleared)
        if (r.reason === "UNREGISTERED" || (r.status === 400 && r.reason === "INVALID_ARGUMENT" && /registration token/i.test(r.message ?? "")))
          this.db.prepare("DELETE FROM push_devices WHERE token = ?").run(d.token);
      }
    }
    return result;
  }

  private async post(cfg: FcmConfig, token: string, data: Record<string, string>): Promise<FcmResult> {
    const bearer = await this.accessToken(cfg.serviceAccount);
    const res = await fetch(`${this.origin ?? DEFAULT_ORIGIN}/v1/projects/${encodeURIComponent(cfg.serviceAccount.project_id)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: "86400s" } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { status: 200 };
    let reason: string | undefined, message: string | undefined;
    try {
      const err = ((await res.json()) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } }).error;
      reason = err?.details?.find((d) => d.errorCode)?.errorCode ?? err?.status;
      message = err?.message;
    } catch {}
    return { status: res.status, reason, message };
  }

  /** A Google OAuth access token for FCM: a signed JWT (RS256) traded at the account's token_uri, cached until it nears expiry. */
  private async accessToken(sa: ServiceAccount): Promise<string> {
    const key = `${sa.client_email}:${sa.project_id}`;
    if (this.access && this.access.key === key && Date.now() < this.access.expires) return this.access.value;
    const uri = sa.token_uri || DEFAULT_TOKEN_URI;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 })}`;
    const sig = crypto.sign("sha256", Buffer.from(unsigned), sa.private_key).toString("base64url");
    const res = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google refused the service account (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google sent no access token");
    this.access = { key, value: body.access_token, expires: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
    return this.access.value;
  }
}

function readFile(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Throws when the text isn't a Firebase service-account key file Node can sign with. */
export function parseServiceAccount(raw: string): ServiceAccount {
  const j = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!j.project_id || !j.client_email || !j.private_key) throw new Error("not a service account key");
  const private_key = j.private_key.replace(/\\n/g, "\n");
  crypto.createPrivateKey(private_key);
  return { project_id: j.project_id, client_email: j.client_email, private_key, ...(j.token_uri ? { token_uri: j.token_uri } : {}) };
}
