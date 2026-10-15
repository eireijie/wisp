import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;

/** A stand-in for APNs: checks the provider token like Apple does and records what it got. */
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const p8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const apns = http2.createServer();
const got: { path: string; headers: http2.IncomingHttpHeaders; body: any }[] = [];
/** device tokens APNs should call gone */
const gone = new Set<string>();
apns.on("stream", (stream, headers) => {
  let data = "";
  stream.on("data", (c) => (data += c));
  stream.on("end", () => {
    const [h, p, sig] = String(headers.authorization).replace(/^bearer /, "").split(".");
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const token = String(headers[":path"]).split("/").pop()!;
    got.push({ path: String(headers[":path"]), headers, body: JSON.parse(data) });
    const [status, reason] = !ok || claims.iss !== "TEAM123456" ? [403, "InvalidProviderToken"] : gone.has(token) ? [410, "Unregistered"] : [200, ""];
    stream.respond({ ":status": status, "content-type": "application/json" });
    stream.end(reason ? JSON.stringify({ reason }) : "");
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

const PHONE = "a".repeat(64);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-apns-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  await new Promise<void>((r) => apns.listen(0, "127.0.0.1", r));
  hub.apns.origin = `http://127.0.0.1:${(apns.address() as { port: number }).port}`;
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yugal Patel", password: "password123", workspaceName: "Lab" }, "")).data.token;
});

afterAll(async () => {
  await close();
  apns.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("push notifications", () => {
  it("is optional: phones register before a key is set, and nothing is sent", async () => {
    expect((await api("GET", "/api/me/push")).data).toEqual({ available: false, devices: 0 });
    expect((await api("POST", "/api/me/push", { token: "not hex" })).status).toBe(400);
    expect((await api("POST", "/api/me/push", { token: PHONE.toUpperCase(), bundleId: "ai.warren.ios", environment: "sandbox" })).data).toEqual({ ok: true, available: false });
    expect((await api("GET", "/api/me/push")).data).toEqual({ available: false, devices: 1 });
    expect((await api("POST", "/api/me/push/test")).status).toBe(409);
  });

  it("takes an APNs key from Settings (owners only, never shown back)", async () => {
    expect((await api("PUT", "/api/settings/push", { keyId: "KEY1234567", teamId: "TEAM123456", key: "nope" })).status).toBe(400);
    const saved = (await api("PUT", "/api/settings/push", { keyId: "KEY1234567", teamId: "TEAM123456", key: p8, environment: "sandbox" })).data;
    expect(saved).toEqual({ configured: true, source: "settings", keyId: "KEY1234567", teamId: "TEAM123456", topic: "ai.warren.ios", environment: "sandbox" });
    expect(JSON.stringify((await api("GET", "/api/settings/push")).data)).not.toContain("PRIVATE KEY");
    const test = (await api("POST", "/api/me/push/test")).data;
    expect(test).toEqual({ sent: 1, failed: [] });
    const last = got.at(-1)!;
    expect(last.path).toBe(`/3/device/${PHONE}`);
    expect(last.headers).toMatchObject({ "apns-topic": "ai.warren.ios", "apns-push-type": "alert" });
    expect(last.body).toMatchObject({ aps: { alert: { title: "Warren" }, sound: "default", badge: 0 }, warren: { kind: "test" } });
  });

  it("pushes an agent's DM and its reply in your thread, with your unread count as the badge", async () => {
    const atlas = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
    const agentToken = (await api("POST", `/api/agents/${atlas.id}/token`, {})).data.token;
    const dm = (await api("POST", `/api/dm/${atlas.id}`, {})).data;
    const before = got.length;
    expect((await api("POST", `/api/channels/${dm.id}/messages`, { body: "The report is ready." }, agentToken)).status).toBe(200);
    const push = await waitFor(() => got.slice(before).find((g) => g.body.warren.channelId === dm.id));
    expect(push.body).toMatchObject({ aps: { alert: { title: "Atlas", body: "The report is ready." }, "thread-id": dm.id, badge: 1 }, warren: { kind: "message", channelId: dm.id, threadId: null } });

    const general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
    const root = (await api("POST", `/api/channels/${general.id}/messages`, { body: "can someone look at the logs?" })).data;
    const n = got.length;
    await api("POST", `/api/channels/${general.id}/messages`, { body: "On it.", threadId: root.id }, agentToken);
    const reply = await waitFor(() => got.slice(n).find((g) => g.body.warren.threadId === root.id));
    expect(reply.body.aps.alert.title).toBe("Atlas in a thread");
    // your own messages never push to you
    const m = got.length;
    await api("POST", `/api/channels/${dm.id}/messages`, { body: "thanks" });
    await new Promise((r) => setTimeout(r, 150));
    expect(got.length).toBe(m);
  });

  it("pushes @mentions of you by name, approvals once, and an agent needing you on its computer", async () => {
    const general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
    const atlas = (await api<any[]>("GET", "/api/agents")).data.find((a) => a.handle === "atlas");
    const agentToken = (await api("POST", `/api/agents/${atlas.id}/token`, {})).data.token;
    const n = got.length;
    await api("POST", `/api/channels/${general.id}/messages`, { body: "@yugal the deploy is done" }, agentToken);
    const mention = await waitFor(() => got.slice(n).find((g) => g.body.aps.alert.title.includes("mentioned you")));
    expect(mention.body.aps.alert.title).toBe("Atlas mentioned you in #general");

    const ws = (await api("GET", "/api/me")).data.workspace.id;
    const approval = { id: "apv_1", agentId: atlas.id, channelId: general.id, threadId: null, summary: "Send the invoice", details: "", status: "pending" } as any;
    expect(hub.apns.decide(ws, { type: "approval", approval })).toHaveLength(1);
    expect(hub.apns.decide(ws, { type: "approval", approval })).toHaveLength(0);
    const computer = { id: "cmp_1", name: "Lab VM", help: { agentId: atlas.id, request: "Sign in to Stripe", channelId: general.id, threadId: null, at: "" } } as any;
    const [[, help]] = hub.apns.decide(ws, { type: "computer", computer });
    expect(help).toMatchObject({ aps: { alert: { title: "Atlas needs you on Lab VM", body: "Sign in to Stripe" } }, warren: { kind: "computer", computerId: "cmp_1" } });
    expect(hub.apns.decide(ws, { type: "computer", computer })).toHaveLength(0);
  });

  it("drops a phone APNs says is gone, and every phone on a sign-in that signs out", async () => {
    gone.add(PHONE);
    expect((await api("POST", "/api/me/push/test")).data).toEqual({ sent: 0, failed: [{ status: 410, reason: "Unregistered" }] });
    expect((await api("GET", "/api/me/push")).data.devices).toBe(0);
    gone.clear();

    const phone = (await api<{ token: string }>("POST", "/api/auth/login", { email: "me@example.com", password: "password123" }, "")).data.token;
    await api("POST", "/api/me/push", { token: "b".repeat(64) }, phone);
    expect((await api("GET", "/api/me/push")).data.devices).toBe(1);
    await api("POST", "/api/auth/logout", {}, phone);
    expect((await api("GET", "/api/me/push")).data.devices).toBe(0);
  });
});
