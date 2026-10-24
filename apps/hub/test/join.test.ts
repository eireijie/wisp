import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { buildHub } from "../src/app.ts";
import { issueToken, resolveToken } from "../src/auth.ts";
import { createOrganization } from "../src/api-orgs.ts";
import { JOIN_TTL_MS, INVITE_TTL_MS } from "../src/join.ts";

let built: Awaited<ReturnType<typeof buildHub>>, dir: string, owner: string, workspaceId: string;
let counter = 1;
const device = { name: "My laptop", kind: "computer", platform: "linux" };
const call = (method: "GET" | "POST", url: string, payload?: unknown, token = "", headers: Record<string, string> = {}, remoteAddress = `192.168.1.${counter++}`) => built.app.inject({ method, url, payload: payload as any, remoteAddress, headers: { host: "wisp.example:4747", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const ask = async (payload: unknown = device, remoteAddress?: string, headers?: Record<string, string>) => call("POST", "/api/join/requests", payload, "", headers, remoteAddress);
const poll = (r: any, key = r.secret) => call("GET", `/api/join/requests/${r.requestId}`, undefined, "", { "x-join-secret": key });
const approve = (r: any, token = owner) => call("POST", `/api/join/requests/${r.requestId}/approve`, undefined, token);
const makeInvite = async () => (await call("POST", "/api/join/invites", undefined, owner)).json();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-join-"));
  built = await buildHub({ dataDir: dir });
  const setup = (await call("POST", "/api/setup", { email: "owner@example.com", name: "Yug", password: "password123", workspaceName: "Yug's Wisp" })).json();
  owner = setup.token; workspaceId = setup.workspace.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await built.app.close(); await fs.rm(dir, { recursive: true, force: true }); });

describe("asking to join", () => {
  it("starts new accounts in the Simple experience", async () => {
    expect((await call("GET", "/api/me", undefined, owner)).json().prefs.experience).toBe("simple");
    const legacy = built.hub.store.createUser("legacy@example.com", "Legacy", "");
    built.hub.store.setPrefs(legacy.id, { clock: "24h" });
    await createOrganization(built.hub, legacy, "New Wisp");
    expect(built.hub.store.prefs(legacy.id)).toEqual({ clock: "24h", experience: "simple" });
    built.hub.store.setPrefs(legacy.id, { experience: "advanced" });
    await createOrganization(built.hub, legacy, "Another Wisp");
    expect(built.hub.store.prefs(legacy.id).experience).toBe("advanced");
  });
  it("creates a computer only after approval and hands out its credential exactly once", async () => {
    const started = await ask();
    expect(started.statusCode).toBe(201);
    const r = started.json();
    expect(r.code).toMatch(/^\d{6}$/);
    expect(Date.parse(r.expiresAt) - Date.now()).toBeGreaterThan(JOIN_TTL_MS - 5000);
    expect((await poll(r)).json()).toEqual({ status: "pending" });
    expect((await poll(r, "wrong")).statusCode).toBe(404);
    expect((await call("GET", `/api/join/requests/${r.requestId}`)).statusCode).toBe(404);
    const list = (await call("GET", "/api/join/requests", undefined, owner)).json();
    expect(list.find((v: any) => v.id === r.requestId)).toEqual({ id: r.requestId, ...device, code: r.code, createdAt: expect.any(String) });
    expect(JSON.stringify(list)).not.toContain(r.secret);
    const before = built.hub.store.nodes(workspaceId).length;
    const results = await Promise.all([approve(r), approve(r)]);
    expect(results.map((v) => v.statusCode).sort()).toEqual([200, 409]);
    expect(built.hub.store.nodes(workspaceId)).toHaveLength(before + 1);
    const done = (await poll(r)).json();
    expect(done).toMatchObject({ status: "approved", nodeId: expect.any(String), nodeToken: expect.stringMatching(/^wr_node_/), hubUrl: "http://wisp.example:4747", workspaceName: "Yug's Wisp" });
    expect(resolveToken(built.hub.store.db, done.nodeToken)).toMatchObject({ kind: "node", subjectId: done.nodeId, workspaceId });
    expect(built.hub.store.node(done.nodeId)).toMatchObject({ name: device.name, ownerId: resolveToken(built.hub.store.db, owner)!.subjectId });
    expect((await poll(r)).json()).toEqual({ status: "approved" });
  });
  it("rejects invalid inputs, defaults the device name, and denies without creating a computer", async () => {
    expect((await ask({ ...device, name: " ", kind: "phone" })).statusCode).toBe(400);
    expect((await ask({ ...device, platform: "" })).statusCode).toBe(400);
    const r = (await ask({ kind: "computer", platform: "darwin" })).json();
    const list = (await call("GET", "/api/join/requests", undefined, owner)).json();
    expect(list.find((v: any) => v.id === r.requestId).name).toBe(os.hostname());
    const before = built.hub.store.nodes(workspaceId).length;
    expect((await call("POST", `/api/join/requests/${r.requestId}/deny`, undefined, owner)).json()).toEqual({ status: "denied" });
    expect((await poll(r)).json()).toEqual({ status: "denied" });
    expect((await approve(r)).statusCode).toBe(409);
    expect(built.hub.store.nodes(workspaceId)).toHaveLength(before);
  });
  it("requires owners and isolates workspaces", async () => {
    const store = built.hub.store;
    const u = store.createUser("member@example.com", "Member", "");
    store.addMember(workspaceId, u.id, "member");
    const member = issueToken(store.db, "session", u.id, workspaceId);
    const ws = store.createWorkspace("Other Wisp");
    store.addMember(ws.id, u.id, "owner");
    const other = issueToken(store.db, "session", u.id, ws.id);
    const r = (await ask()).json();
    expect((await approve(r, "")).statusCode).toBe(401);
    expect((await approve(r, member)).statusCode).toBe(403);
    expect((await approve(r, other)).statusCode).toBe(404);
    expect((await call("GET", "/api/join/requests", undefined, member)).statusCode).toBe(403);
    expect((await call("GET", "/api/join/requests", undefined, other)).json()).toEqual([]);
    expect((await call("POST", "/api/join/invites", undefined, member)).statusCode).toBe(403);
    const events: any[][] = [[], [], []];
    const sockets = events.map((messages) => Object.assign(new EventEmitter(), { readyState: 1, send: (data: string) => messages.push(JSON.parse(data)), terminate() {} }) as unknown as WebSocket);
    const ownerId = resolveToken(store.db, owner)!.subjectId;
    built.hub.addClient(sockets[0], workspaceId, ownerId, "test");
    built.hub.addClient(sockets[1], workspaceId, u.id, "test");
    built.hub.addClient(sockets[2], ws.id, u.id, "test");
    const next = (await ask()).json();
    await approve(next);
    expect(events[0].map((e: any) => e.type)).toEqual(["join_request", "join_request_done"]);
    expect(events[0][0].request.code).toBe(next.code);
    expect(events[1]).toEqual([]); expect(events[2]).toEqual([]);
    for (const socket of sockets) socket.emit("close");
  });
  it("expires pending requests and cannot approve an expired code", async () => {
    const r = (await ask()).json();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(r.expiresAt));
    expect((await poll(r)).json()).toEqual({ status: "expired" });
    expect((await approve(r)).statusCode).toBe(409);
    expect((await call("GET", "/api/join/requests", undefined, owner)).json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: r.requestId })]));
  });
  it("limits even invalid requests to ten per minute per actual peer", async () => {
    for (let n = 0; n < 10; n++) expect((await ask({}, "192.168.2.222")).statusCode).toBe(400);
    const limited = await ask(device, "192.168.2.222");
    expect(limited.statusCode).toBe(429); expect(limited.headers["retry-after"]).toBe("60");
    expect((await ask(device, "192.168.2.223")).statusCode).toBe(201);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    expect((await ask(device, "192.168.2.222")).statusCode).toBe(201);
  });
});

describe("invite links", () => {
  it("requires an invite remotely, rejects spoofed forwarding, and allows multi-use invites", async () => {
    expect((await ask(device, "8.8.8.8")).statusCode).toBe(403);
    expect((await ask(device, "8.8.8.8", { "x-forwarded-for": "192.168.1.3" })).statusCode).toBe(403);
    expect((await ask(device, "127.0.0.1", { "cf-connecting-ip": "8.8.8.8" })).statusCode).toBe(403);
    const link = await makeInvite();
    expect(link.url).toMatch(/^http:\/\/wisp.example:4747\/join\/[\w-]+$/);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(INVITE_TTL_MS - 5000);
    const invite = new URL(link.url).pathname.split("/")[2];
    for (let n = 0; n < 2; n++) expect((await ask({ ...device, invite }, "8.8.4.4")).statusCode).toBe(201);
    expect((await ask({ ...device, invite: "invalid" })).statusCode).toBe(403);
    const page = await call("GET", `/join/${invite}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Open Wisp on that computer and pick Join my Wisp");
    expect(page.body).toContain("| sh -s join");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await call("GET", "/join/invalid")).statusCode).toBe(410);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(link.expiresAt));
    expect((await call("GET", `/join/${invite}`)).statusCode).toBe(410);
    expect((await ask({ ...device, invite }, "8.8.4.4")).statusCode).toBe(403);
  });
  it("keeps the browser's HTTPS scheme for a matching request origin", async () => {
    const response = await call("POST", "/api/join/invites", undefined, owner, { origin: "https://wisp.example:4747" });
    expect(response.json().url).toMatch(/^https:\/\/wisp.example:4747\/join\//);
    const unrelated = await call("POST", "/api/join/invites", undefined, owner, { origin: "https://unrelated.example" });
    expect(unrelated.json().url).toMatch(/^http:\/\/wisp.example:4747\/join\//);
  });
  it("prefers Tailscale HTTPS over the request origin", async () => {
    vi.spyOn(built.hub.reach, "publicUrl").mockResolvedValue("https://home.tailnet.ts.net");
    expect((await makeInvite()).url).toMatch(/^https:\/\/home.tailnet.ts.net\/join\//);
  });
  it("keeps invites across restarts and scopes requests to the invited workspace", async () => {
    const store = built.hub.store, userId = resolveToken(store.db, owner)!.subjectId;
    const ws = store.createWorkspace("Invited Wisp"); store.addMember(ws.id, userId, "owner");
    const token = issueToken(store.db, "session", userId, ws.id);
    const link = (await call("POST", "/api/join/invites", undefined, token)).json();
    const invite = new URL(link.url).pathname.split("/")[2];
    await built.app.close();
    built = await buildHub({ dataDir: dir });
    const r = (await ask({ ...device, invite }, "9.9.9.9")).json();
    expect((await approve(r)).statusCode).toBe(404);
    expect((await approve(r, token)).statusCode).toBe(200);
    expect((await poll(r)).json().workspaceName).toBe("Invited Wisp");
  });
});
