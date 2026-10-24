import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import { parseMentions, type ClientEvent, type Message } from "@warren/core";
import type { Hub } from "./hub.ts";

/**
 * Push notifications to Warren's iOS app through Apple's push service (APNs), so people hear about
 * agent replies, @mentions, approvals and "needs you on its computer" while the app is closed.
 *
 * Optional: a hub without an APNs key keeps device tokens but sends nothing. The key is the
 * self-hoster's own (Apple Developer → Keys → a .p8 with Apple Push Notifications), from env vars
 * (WARREN_APNS_*) or, if those aren't set, from Settings (an owner's PUT /api/settings/push).
 */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** the .p8 file's contents (PEM) */
  key: string;
  /** the app's bundle id; a device that sends its own wins */
  topic: string;
  /** which APNs a device that didn't say goes to */
  environment: "production" | "sandbox";
}

export interface PushDevice {
  token: string;
  userId: string;
  workspaceId: string;
  bundleId: string | null;
  environment: "production" | "sandbox" | null;
}

export interface PushPayload {
  aps: { alert: { title: string; body: string }; sound?: string; badge?: number; "thread-id"?: string };
  warren: { kind: "message" | "approval" | "computer" | "test"; category: "dm" | "reply" | "mention" | "channel" | "approval" | "help" | "other"; channelId?: string; threadId?: string | null; approvalId?: string; computerId?: string };
}

/** What a send came back with: APNs' status and reason ("BadDeviceToken", "Unregistered"…). */
export interface PushResult {
  status: number;
  reason?: string;
}

export type PushTransport = (origin: string, path: string, headers: Record<string, string>, body: string) => Promise<PushResult>;

export const DEFAULT_TOPIC = "ai.warren.ios";
const SETTING = "push.apns";
const ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
/** APNs refuses provider tokens older than an hour and too-frequent new ones; 50 minutes sits between. */
const JWT_TTL_MS = 50 * 60_000;
/** reasons that mean the device token will never work again */
const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

export class Apns {
  /** how pushes reach APNs; tests swap it, or point `origin` at a local HTTP/2 server */
  transport: PushTransport = http2Transport();
  /** overrides Apple's address (tests) */
  origin: string | null = null;
  private jwt: { key: string; value: string; at: number } | null = null;
  /** approvals and help requests already pushed, so a re-broadcast doesn't push twice */
  private seen = new Set<string>();

  constructor(private hub: Hub) {}

  private get db() {
    return this.hub.store.db;
  }

  // --- configuration ----------------------------------------------------------------------------

  /** The APNs key in use: env vars win over Settings. Null when push isn't set up. */
  config(workspaceId: string): (ApnsConfig & { source: "env" | "settings" }) | null {
    const env = process.env;
    const envKey = env.WARREN_APNS_KEY ?? (env.WARREN_APNS_KEY_FILE ? readKey(env.WARREN_APNS_KEY_FILE) : undefined);
    if (env.WARREN_APNS_KEY_ID && env.WARREN_APNS_TEAM_ID && envKey)
      return {
        keyId: env.WARREN_APNS_KEY_ID,
        teamId: env.WARREN_APNS_TEAM_ID,
        key: envKey.replace(/\\n/g, "\n"),
        topic: env.WARREN_APNS_TOPIC || DEFAULT_TOPIC,
        environment: env.WARREN_APNS_ENV === "sandbox" ? "sandbox" : "production",
        source: "env",
      };
    const saved = this.hub.store.setting(workspaceId, SETTING);
    if (!saved) return null;
    try {
      return { ...(JSON.parse(saved) as ApnsConfig), source: "settings" };
    } catch {
      return null;
    }
  }

  saveConfig(workspaceId: string, cfg: ApnsConfig | null) {
    if (cfg) validKey(cfg.key);
    this.hub.store.setSetting(workspaceId, SETTING, cfg ? JSON.stringify(cfg) : null);
    this.jwt = null;
  }

  // --- devices ----------------------------------------------------------------------------------

  /** Remember a phone for this sign-in. Signing out deletes the sign-in, and the phone with it. */
  register(sessionHash: string, userId: string, workspaceId: string, d: { token: string; bundleId?: string | null; environment?: "production" | "sandbox" | null }) {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO push_devices (token, session_hash, user_id, workspace_id, bundle_id, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET session_hash = excluded.session_hash, user_id = excluded.user_id, workspace_id = excluded.workspace_id,
           bundle_id = excluded.bundle_id, environment = excluded.environment, updated_at = excluded.updated_at`,
      )
      .run(d.token.toLowerCase(), sessionHash, userId, workspaceId, d.bundleId ?? null, d.environment ?? null, at, at);
  }

  /** Forget one phone, or every phone on this sign-in. */
  unregister(sessionHash: string, token?: string) {
    if (token) return this.db.prepare("DELETE FROM push_devices WHERE token = ? AND session_hash = ?").run(token.toLowerCase(), sessionHash).changes;
    return this.db.prepare("DELETE FROM push_devices WHERE session_hash = ?").run(sessionHash).changes;
  }

  devices(userId: string): PushDevice[] {
    return this.db
      .prepare("SELECT token, user_id AS userId, workspace_id AS workspaceId, bundle_id AS bundleId, environment FROM push_devices WHERE user_id = ?")
      .all(userId) as PushDevice[];
  }

  // --- what's worth a push (the same rules as the web app's notifications.ts) --------------------

  /** Called with every event the hub broadcasts, and who it went to. Never throws. */
  onEvent(workspaceId: string, event: ClientEvent, only?: (userId: string) => boolean) {
    try {
      for (const [userId, payload] of this.decide(workspaceId, event)) if (!only || only(userId)) void this.sendTo(workspaceId, userId, payload);
    } catch {}
  }

  /** The pushes an event is worth, per person. */
  decide(workspaceId: string, e: ClientEvent): [string, PushPayload][] {
    if (!this.hasDevices(workspaceId)) return [];
    const { store } = this.hub;
    const agentName = (id: string) => store.agent(id)?.name ?? "An agent";
    const out = new Map<string, PushPayload>();

    if (e.type === "message") {
      const m = e.message;
      if (!m.body.trim() || m.author.id === "system") return [];
      // approval and "needs you" cards: their own events below push for them
      if (m.parts.some((p) => p.type === "approval" || p.type === "computer")) return [];
      const ch = store.channel(m.channelId);
      if (!ch) return [];
      const members = store.channelMembers(ch.id).filter((a) => a.kind === "user" && !(m.author.kind === "user" && a.id === m.author.id));
      const from = m.author.kind === "agent" ? agentName(m.author.id) : this.personName(m.author.id);
      const where = { kind: "message" as const, channelId: ch.id, threadId: m.threadId };
      const push = (userId: string, title: string, category: PushPayload["warren"]["category"]) => out.has(userId) || out.set(userId, { aps: { alert: { title, body: preview(m) }, "thread-id": ch.id }, warren: { ...where, category } });

      // an agent wrote to you in a DM
      if (ch.kind === "dm" && m.author.kind === "agent") for (const u of members) push(u.id, from, "dm");
      // an agent answered in a thread you started
      if (m.threadId && m.author.kind === "agent") {
        const root = store.message(m.threadId);
        if (root?.author.kind === "user") push(root.author.id, `${from} in a thread`, "reply");
      }
      // someone @mentioned you (people go by their preferred or first name)
      const mentioned = new Set(parseMentions(m.body));
      if (mentioned.size && ch.kind === "channel")
        for (const p of store.members(workspaceId))
          if (!(m.author.kind === "user" && m.author.id === p.id) && handlesOf(p).some((h) => mentioned.has(h)) && store.isMember(ch.id, { kind: "user", id: p.id }))
            push(p.id, `${from} mentioned you in #${ch.name}`, "mention");
      if (ch.kind === "channel") {
        // people who asked for every message here, and nobody who muted it
        for (const u of store.notifyAll(ch.id)) if (!(m.author.kind === "user" && m.author.id === u)) push(u, `${from} in #${ch.name}`, "channel");
        for (const u of store.mutedBy(ch.id)) out.delete(u);
      }
    }

    if (e.type === "approval" && e.approval.status === "pending" && this.once(`approval:${e.approval.id}`)) {
      const a = e.approval;
      for (const u of store.channelMembers(a.channelId))
        if (u.kind === "user") out.set(u.id, { aps: { alert: { title: `${agentName(a.agentId)} wants your OK`, body: a.summary } }, warren: { kind: "approval", category: "approval", approvalId: a.id, channelId: a.channelId, threadId: a.threadId } });
    }

    if (e.type === "computer") {
      const c = e.computer;
      if (!c.help) this.seen.delete(`help:${c.id}`);
      else if (this.once(`help:${c.id}`))
        for (const p of store.members(workspaceId))
          out.set(p.id, { aps: { alert: { title: `${agentName(c.help.agentId)} needs you on ${c.name}`, body: c.help.request } }, warren: { kind: "computer", category: "help", computerId: c.id } });
    }
    return [...out];
  }

  // --- sending ------------------------------------------------------------------------------------

  /** Push to this person's phones in the event's workspace, with that workspace's unread badge. */
  async sendTo(workspaceId: string, userId: string, payload: PushPayload): Promise<{ sent: number; failed: { status: number; reason?: string }[] }> {
    const devices = this.devices(userId).filter((d) => d.workspaceId === workspaceId);
    const result = { sent: 0, failed: [] as { status: number; reason?: string }[] };
    if (!devices.length) return result;
    const cfg = this.config(workspaceId);
    if (!cfg) return result;
    const body = JSON.stringify({ ...payload, aps: { sound: "default", badge: this.unread(userId, workspaceId), ...payload.aps } });
    for (const d of devices) {
      const env = d.environment ?? cfg.environment;
      let r = await this.post(cfg, env, d, body).catch((err: Error) => ({ status: 0, reason: err.message }) as PushResult);
      if (r.status === 403 && r.reason === "ExpiredProviderToken") {
        this.jwt = null;
        r = await this.post(cfg, env, d, body).catch((err: Error) => ({ status: 0, reason: err.message }) as PushResult);
      }
      if (r.status === 200) result.sent++;
      else {
        result.failed.push(r);
        // APNs says this phone is gone (the app was deleted, or the token is for another app or server)
        if (r.status === 410 || (r.status === 400 && DEAD.has(r.reason ?? ""))) this.db.prepare("DELETE FROM push_devices WHERE token = ?").run(d.token);
      }
    }
    return result;
  }

  private post(cfg: ApnsConfig, env: "production" | "sandbox", d: PushDevice, body: string) {
    const headers = {
      authorization: `bearer ${this.providerToken(cfg)}`,
      "apns-topic": d.bundleId || cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    return this.transport(this.origin ?? ORIGINS[env], `/3/device/${d.token}`, headers, body);
  }

  /** The signed JWT APNs wants, made again every 50 minutes. */
  private providerToken(cfg: ApnsConfig): string {
    const cacheKey = `${cfg.teamId}:${cfg.keyId}`;
    if (this.jwt && this.jwt.key === cacheKey && Date.now() - this.jwt.at < JWT_TTL_MS) return this.jwt.value;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "ES256", kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: cfg.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { key: cacheKey, value: `${unsigned}.${sig}`, at: Date.now() };
    return this.jwt.value;
  }

  // --- helpers ------------------------------------------------------------------------------------

  private hasDevices(workspaceId: string) {
    return !!this.db.prepare("SELECT 1 FROM push_devices WHERE workspace_id = ? LIMIT 1").get(workspaceId);
  }

  private once(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private personName(userId: string) {
    const u = this.hub.store.user(userId);
    return u?.preferredName || u?.name || "Someone";
  }

  /** Unread across the chats the app lists (every channel, and your DMs), as the app's badge. */
  private unread(userId: string, workspaceId: string) {
    const { store } = this.hub;
    const ids = store
      .channels(workspaceId)
      .filter((ch) => ch.kind === "channel" || store.isMember(ch.id, { kind: "user", id: userId }))
      .map((ch) => ch.id);
    return Object.values(store.readState(userId, ids)).reduce((n, r) => n + r.unread, 0);
  }
}

/** "@alex", "@alexandra": what people are @mentioned as (their preferred name and first name). */
function handlesOf(p: { name: string; preferredName: string | null }) {
  return [p.preferredName, p.name.split(/\s+/)[0]].filter((x): x is string => !!x).map((x) => x.toLowerCase());
}

function preview(m: Message) {
  const text = m.body.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function readKey(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Throws when the text isn't a private key Node can sign with (a .p8 is PKCS#8 PEM). */
export function validKey(key: string) {
  crypto.createPrivateKey(key);
}

/** One HTTP/2 connection per APNs host, kept open between pushes as Apple asks. */
function http2Transport(): PushTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const session = (origin: string) => {
    let s = sessions.get(origin);
    if (!s || s.closed || s.destroyed) {
      s = http2.connect(origin);
      s.on("error", () => sessions.delete(origin));
      s.on("close", () => sessions.delete(origin));
      s.unref();
      sessions.set(origin, s);
    }
    return s;
  };
  return (origin, path, headers, body) =>
    new Promise((resolve, reject) => {
      const req = session(origin).request({ ":method": "POST", ":path": path, ...headers });
      req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let data = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      req.setEncoding("utf8");
      req.on("data", (c: string) => (data += c));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {}
        resolve({ status, reason });
      });
      req.on("error", reject);
      req.end(body);
    });
}
