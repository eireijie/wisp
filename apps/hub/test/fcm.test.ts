import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;

/** A stand-in for Google: trades the service account's JWT for an access token, then takes FCM sends. */
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const got: { path: string; auth: string; body: any }[] = [];
let tokenRequests = 0;
let expireNext = false;
/** registration tokens FCM should call gone */
const gone = new Set<string>();
let tokenUri = "";
const google = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/token") {
      tokenRequests++;
      const jwt = new URLSearchParams(data).get("assertion")!;
      const [h, p, sig] = jwt.split(".");
      const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"));
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      if (!ok || claims.iss !== "wisp@demo.iam.gserviceaccount.com" || claims.aud !== tokenUri || !String(claims.scope).includes("firebase.messaging")) return reply(400, { error: "invalid_grant" });
      return reply(200, { access_token: `at-${tokenRequests}`, expires_in: 3600 });
    }
    const body = JSON.parse(data);
    got.push({ path: req.url!, auth: String(req.headers.authorization), body });
    if (expireNext) {
      expireNext = false;
      return reply(401, { error: { status: "UNAUTHENTICATED" } });
    }
    if (gone.has(body.message.token)) return reply(404, { error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } });
    reply(200, { name: "projects/demo/messages/1" });
  });
});

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const waitFor = async <T>(fn: () => T | undefined, ms = 3000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const PHONE = "dQw4w9WgXcQ:APA91bHexampleToken_with-MixedCase0123456789";
const client = { applicationId: "1:123456789:android:abc123def", apiKey: "AIzaSyExampleExampleExample", senderId: "123456789" };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-fcm-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
  tokenUri = `${origin}/token`;
  hub.fcm.origin = origin;
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Alex Morgan", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
});

afterAll(async () => {
  await close();
  google.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Android push notifications", () => {
  const serviceAccount = () => JSON.stringify({ type: "service_account", project_id: "demo", client_email: "wisp@demo.iam.gserviceaccount.com", private_key: pem, token_uri: tokenUri });

  it("is optional: a phone registers before Firebase is set up, and nothing is sent", async () => {
    expect((await api("GET", "/api/me/push")).data).toEqual({ available: false, devices: 0, android: { available: false, firebase: null } });
    expect((await api("POST", "/api/me/push", { platform: "android", token: "short" })).status).toBe(400);
    // the token keeps its case (FCM tokens are case-sensitive)
    expect((await api("POST", "/api/me/push", { platform: "android", token: PHONE, bundleId: "ai.wisp.android" })).data).toEqual({ ok: true, available: false });
    expect(hub.apns.devices((await api("GET", "/api/me")).data.user.id)[0]).toMatchObject({ token: PHONE, platform: "android" });
    expect((await api("POST", "/api/me/push/test")).status).toBe(409);
  });

  it("takes a service account and client config from Settings (owners only), and hands the client config to the app", async () => {
    expect((await api("PUT", "/api/settings/push/android", { ...client, serviceAccount: "nope" })).status).toBe(400);
    expect((await api("PUT", "/api/settings/push/android", { ...client, serviceAccount: "{}" })).status).toBe(400);
    const saved = (await api("PUT", "/api/settings/push/android", { ...client, serviceAccount: serviceAccount() })).data;
    expect(saved).toEqual({ configured: true, source: "settings", projectId: "demo", clientEmail: "wisp@demo.iam.gserviceaccount.com", ...client });
    expect(JSON.stringify((await api("GET", "/api/settings/push/android")).data)).not.toContain("PRIVATE KEY");
    expect((await api("GET", "/api/me/push")).data.android).toEqual({ available: true, firebase: { projectId: "demo", ...client } });
  });

  it("sends a test push as a data message with an OAuth token minted from the service account", async () => {
    expect((await api("POST", "/api/me/push/test")).data).toEqual({ sent: 1, failed: [] });
    const last = got.at(-1)!;
    expect(last.path).toBe("/v1/projects/demo/messages:send");
    expect(last.auth).toBe("Bearer at-1");
    expect(last.body.message).toMatchObject({ token: PHONE, data: { title: "Wisp", body: "Notifications work on this phone.", kind: "test", category: "other", badge: "0" }, android: { priority: "HIGH" } });
    // the access token is reused, and refreshed when Google says it expired
    await api("POST", "/api/me/push/test");
    expect(tokenRequests).toBe(1);
    expireNext = true;
    expect((await api("POST", "/api/me/push/test")).data).toEqual({ sent: 1, failed: [] });
    expect(tokenRequests).toBe(2);
  });

  it("pushes an agent's DM and approvals to the phone with the route in the data", async () => {
    const atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
    const agentToken = (await api("POST", `/api/agents/${atlas.id}/token`, {})).data.token;
    const dm = (await api("POST", `/api/dm/${atlas.id}`, {})).data;
    const before = got.length;
    await api("POST", `/api/channels/${dm.id}/messages`, { body: "The report is ready." }, agentToken);
    const push = await waitFor(() => got.slice(before).find((g) => g.body.message.data.channelId === dm.id));
    expect(push.body.message.data).toMatchObject({ title: "Atlas", body: "The report is ready.", kind: "message", category: "dm", channelId: dm.id, badge: "1" });
    expect(push.body.message.data.threadId).toBeUndefined();

    const ws = (await api("GET", "/api/me")).data.workspace.id;
    const approval = { id: "apv_1", agentId: atlas.id, channelId: dm.id, threadId: null, summary: "Send the invoice", details: "", status: "pending" } as any;
    hub.apns.onEvent(ws, { type: "approval", approval });
    const ask = await waitFor(() => got.slice(before).find((g) => g.body.message.data.kind === "approval"));
    expect(ask.body.message.data).toMatchObject({ title: "Atlas wants your OK", approvalId: "apv_1", channelId: dm.id });
  });

  it("drops a phone FCM says is gone, and the phone of a sign-in that signs out", async () => {
    gone.add(PHONE);
    expect((await api("POST", "/api/me/push/test")).data).toEqual({ sent: 0, failed: [{ status: 404, reason: "UNREGISTERED" }] });
    expect((await api("GET", "/api/me/push")).data.devices).toBe(0);
    gone.clear();

    const phone = (await api<{ token: string }>("POST", "/api/auth/login", { email: "me@example.com", password: "password123" }, "")).data.token;
    await api("POST", "/api/me/push", { platform: "android", token: "b".repeat(40) }, phone);
    expect((await api("GET", "/api/me/push")).data.devices).toBe(1);
    await api("POST", "/api/auth/logout", {}, phone);
    expect((await api("GET", "/api/me/push")).data.devices).toBe(0);
  });

  it("can be removed again", async () => {
    expect((await api("DELETE", "/api/settings/push/android")).data).toEqual({ configured: false });
    expect((await api("GET", "/api/me/push")).data.android.available).toBe(false);
  });
});
