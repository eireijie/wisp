import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inFolder, storagePath } from "@wisp/core";
import { createWispMcp } from "@wisp/mcp/src/server.ts";
import { WispClient } from "@wisp/sdk";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { parseMultistatus } from "../src/storage-providers.ts";
import { makeRoomAs } from "./room.ts";
import { startStubs, type Stubs } from "./storage-stubs.ts";

/**
 * The Storage mod. WebDAV runs against a real server when WISP_TEST_WEBDAV is set
 * ("http://127.0.0.1:8080/|user|password|/its/root/folder"), else against the stub;
 * Nextcloud's sign-in, Google Drive and Dropbox always run against stubs.
 */
const LIVE = process.env.WISP_TEST_WEBDAV?.split("|");

let dir: string;
let files: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let member: string;
let stubs: Stubs;
let scout: any;
let other: any;
let scoutToken: string;
let otherToken: string;
let davUrl: string;
let davUser: string;
let davPass: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data: data as T, ...(res.headers.get("location") ? { location: res.headers.get("location") } : {}) } as any;
}

const agentCall = (token: string) => (url: string, body: unknown) => api("POST", url, body, token);

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-storage-"));
  files = LIVE?.[3] ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-storage-files-")));
  for (const d of ["Clients/Acme", "Clients/AcmeEvil", "Photos", "Private"]) await fsp.mkdir(path.join(files, d), { recursive: true });
  await fsp.writeFile(path.join(files, "Clients/Acme/notes.txt"), "Acme likes blue.");
  await fsp.writeFile(path.join(files, "Clients/AcmeEvil/secret.txt"), "not yours");
  await fsp.writeFile(path.join(files, "Private/diary.txt"), "dear diary");
  await fsp.writeFile(path.join(files, "Photos/cat.txt"), "a cat");
  stubs = await startStubs(files, { user: "yug", password: "app-pass-123" });
  [davUrl, davUser, davPass] = LIVE ?? [`${stubs.base}/dav/`, "yug", "app-pass-123"];

  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  hub.storage.google = { auth: `${stubs.base}/google/auth`, token: `${stubs.base}/google/token`, api: `${stubs.base}/google/drive/v3`, upload: `${stubs.base}/google/upload/drive/v3` };
  hub.storage.dropbox = { auth: `${stubs.base}/dropbox/auth`, token: `${stubs.base}/dropbox/token`, api: `${stubs.base}/dropbox/api/2`, content: `${stubs.base}/dropbox/content/2` };
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Me", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  await api("PUT", "/api/features", { invite: true });
  const { code } = (await api("POST", "/api/invites", { role: "member" })).data;
  member = (await api("POST", "/api/invites/accept", { code, email: "m@example.com", name: "Member", password: "password123" }, "")).data.token;
  scout = (await api("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom" })).data;
  other = (await api("POST", "/api/agents", { handle: "other", name: "Other", harness: "custom" })).data;
  scoutToken = (await api("POST", `/api/agents/${scout.id}/token`)).data.token;
  otherToken = (await api("POST", `/api/agents/${other.id}/token`)).data.token;
});

afterAll(async () => {
  await close();
  await stubs.close();
  await fsp.rm(dir, { recursive: true, force: true });
  if (!LIVE) await fsp.rm(files, { recursive: true, force: true });
});

describe("paths", () => {
  it("refuses anything that climbs out instead of cleaning it up", () => {
    expect(storagePath("Clients//Acme/./notes.txt")).toBe("/Clients/Acme/notes.txt");
    expect(storagePath("/")).toBe("/");
    for (const bad of ["/Clients/../Private", "..", "/a/b/../../..", "a\\..\\b", "/a/\u0000b", "/a/....", "/a/\nb"]) expect(() => storagePath(bad), bad).toThrow();
  });

  it("treats a folder as covering only what's inside it", () => {
    expect(inFolder("/Clients/Acme/x", "/Clients/Acme")).toBe(true);
    expect(inFolder("/Clients/Acme", "/Clients/Acme")).toBe(true);
    expect(inFolder("/Clients/AcmeEvil/x", "/Clients/Acme")).toBe(false);
    expect(inFolder("/Clients", "/Clients/Acme")).toBe(false);
    expect(inFolder("/anything", "/")).toBe(true);
  });

  it("reads WebDAV answers whatever the namespace prefix", () => {
    const rows = parseMultistatus(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/b%20c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/a/x.txt</D:href><D:propstat><D:prop><D:getcontentlength>12</D:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:getcontenttype/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`);
    expect(rows).toMatchObject([
      { href: "/a/b%20c/", folder: true },
      { href: "/a/x.txt", folder: false, size: 12, mime: null },
    ]);
  });
});

describe("while the mod is off", () => {
  it("stays out of the way: no routes, no tools, nothing in prompts", async () => {
    expect((await api("GET", "/api/me")).data.features.storage).toBe(false);
    expect((await api("GET", "/api/storage")).status).toBe(404);
    expect((await api("POST", "/api/storage/webdav", { service: "webdav", url: davUrl, username: davUser, password: davPass })).status).toBe(404);
    expect((await api("GET", "/api/storage/mine", undefined, scoutToken)).data).toEqual([]);
    expect((await agentCall(scoutToken)("/api/storage/agent/list", { storage: "x" })).status).toBe(404);
  });
});

describe("WebDAV", () => {
  let conn: any;

  beforeAll(async () => {
    expect((await api("PUT", "/api/features", { storage: true })).status).toBe(200);
  });

  it("only lets owners connect, checks the server first, and never shows the password", async () => {
    expect((await api("POST", "/api/storage/webdav", { service: "webdav", url: davUrl, username: davUser, password: davPass }, member)).status).toBe(403);
    const wrong = await api("POST", "/api/storage/webdav", { service: "webdav", url: davUrl, username: davUser, password: "nope" });
    expect(wrong.status).toBe(502);
    expect(wrong.data.error).toMatch(/401/);
    const r = await api("POST", "/api/storage/webdav", { service: "truenas", url: davUrl, username: davUser, password: davPass, name: "NAS" });
    expect(r.status).toBe(200);
    conn = r.data;
    expect(conn).toMatchObject({ name: "NAS", service: "truenas", kind: "webdav", signIn: "app-password", account: davUser, folders: [] });
    const listed = await api("GET", "/api/storage", undefined, member);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.data)).not.toContain(davPass);
    // kept sealed on disk, under a key only the hub can read
    const row = hub.store.db.prepare("SELECT secret_enc FROM storage_connections WHERE id = ?").get(conn.id) as { secret_enc: string };
    expect(row.secret_enc).toMatch(/^v1:/);
    expect(row.secret_enc).not.toContain(davPass);
    expect(fs.readFileSync(path.join(dir, "wisp.db")).toString("latin1")).not.toContain(davPass);
    expect(fs.statSync(path.join(dir, "storage.key")).mode & 0o777).toBe(0o600);
  });

  it("gives agents nothing until a person picks folders and agents", async () => {
    expect((await api("GET", "/api/storage/mine", undefined, scoutToken)).data).toEqual([]);
    expect((await api("PATCH", `/api/storage/${conn.id}`, { folders: [{ path: "/Clients/Acme", access: "write" }] }, member)).status).toBe(403);
    expect((await api("PATCH", `/api/storage/${conn.id}`, { folders: [{ path: "/Clients/../Private", access: "read" }] })).status).toBe(400);
    const r = await api("PATCH", `/api/storage/${conn.id}`, { folders: [{ path: "Clients/Acme/", access: "write" }, { path: "/Photos", access: "read" }], agentIds: [scout.id] });
    expect(r.data.folders).toEqual([{ path: "/Clients/Acme", access: "write" }, { path: "/Photos", access: "read" }]);
    expect((await api("GET", "/api/storage/mine", undefined, scoutToken)).data).toEqual([{ id: conn.id, name: "NAS", service: "truenas", folders: r.data.folders }]);
    // agents it wasn't given don't see it
    expect((await api("GET", "/api/storage/mine", undefined, otherToken)).data).toEqual([]);
    expect((await agentCall(otherToken)("/api/storage/agent/list", { storage: "NAS", path: "/Photos" })).status).toBe(404);
    const browse = await api("GET", `/api/storage/${conn.id}/browse?path=/Clients`);
    expect(browse.data.entries.map((e: any) => e.name)).toEqual(["Acme", "AcmeEvil"]);
  });

  it("tells the agent about it in its prompt", async () => {
    await makeRoomAs(hub, base, owner, { name: "general" });
    const general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
    const msg = (await api("POST", `/api/channels/${general.id}/messages`, { body: "hi" })).data;
    const prompt = await hub.buildPrompt(scout.id, general.id, null, msg.id);
    expect(prompt).toContain("## Your storage");
    expect(prompt).toContain("/Clients/Acme (read and change)");
    expect(prompt).toContain("/Photos (read only)");
    expect(await hub.buildPrompt(other.id, general.id, null, msg.id)).not.toContain("## Your storage");
  });

  it("lets agents list, read and search only inside their folders", async () => {
    const call = agentCall(scoutToken);
    expect((await call("/api/storage/agent/list", { storage: "NAS" })).data.folders).toHaveLength(2);
    const ls = await call("/api/storage/agent/list", { storage: "nas", path: "/Clients/Acme" });
    expect(ls.data.entries.map((e: any) => e.path)).toEqual(["/Clients/Acme/notes.txt"]);
    expect((await call("/api/storage/agent/read", { storage: conn.id, path: "/Clients/Acme/notes.txt" })).data).toMatchObject({ text: "Acme likes blue." });
    for (const p of ["/Clients", "/Private/diary.txt", "/Clients/AcmeEvil/secret.txt", "/"]) {
      const r = await call("/api/storage/agent/read", { storage: "NAS", path: p });
      expect(r.status, p).toBe(403);
    }
    for (const p of ["/Clients/Acme/../../Private/diary.txt", "/Clients/Acme/..\\..\\Private", "../Private"]) {
      const r = await call("/api/storage/agent/read", { storage: "NAS", path: p });
      expect(r.status, p).toBe(400);
    }
    // an encoded ".." is just an odd file name, not a way out
    expect((await call("/api/storage/agent/read", { storage: "NAS", path: "/Clients/Acme/%2e%2e/%2e%2e/Private/diary.txt" })).status).toBe(404);
    const found = await call("/api/storage/agent/search", { storage: "NAS", query: "t" });
    const paths = found.data.map((e: any) => e.path);
    expect(paths).toContain("/Clients/Acme/notes.txt");
    expect(paths).toContain("/Photos/cat.txt");
    expect(paths.some((p: string) => p.startsWith("/Private") || p.startsWith("/Clients/AcmeEvil"))).toBe(false);
  });

  it("copies a file into Wisp for the agent's conversation", async () => {
    const f = await agentCall(scoutToken)("/api/storage/agent/download", { storage: "NAS", path: "/Photos/cat.txt" });
    expect(f.status).toBe(200);
    expect(f.data).toMatchObject({ name: "cat.txt", size: 5 });
    expect(f.data.channelId).toBeTruthy();
    const res = await fetch(`${base}/api/files/${f.data.id}`, { headers: { authorization: `Bearer ${owner}` } });
    expect(await res.text()).toBe("a cat");
  });

  it("asks before writing, lets only owners answer, and remembers Always for that folder", async () => {
    const call = agentCall(scoutToken);
    const up = await fetch(`${base}/api/files`, { method: "POST", headers: { authorization: `Bearer ${scoutToken}`, "content-type": "application/octet-stream", "x-filename": "q3.txt", "x-mime-type": "text/plain" }, body: "Q3 numbers" });
    const file = await up.json();
    // read-only and outside folders are refused outright, with no card
    expect((await call("/api/storage/agent/change", { storage: "NAS", action: "put", path: "/Photos/q3.txt", fileId: file.id })).status).toBe(403);
    expect((await call("/api/storage/agent/change", { storage: "NAS", action: "put", path: "/Private/q3.txt", fileId: file.id })).status).toBe(403);
    expect((await call("/api/storage/agent/change", { storage: "NAS", action: "delete", path: "/Clients/Acme" })).status).toBe(403);
    const asked = await call("/api/storage/agent/change", { storage: "NAS", action: "put", path: "/Clients/Acme/q3.txt", fileId: file.id });
    expect(asked.data).toMatchObject({ status: "asked" });
    expect(fs.existsSync(path.join(files, "Clients/Acme/q3.txt"))).toBe(false);
    const approval = (await api("GET", `/api/approvals/${asked.data.approvalId}`)).data;
    expect(approval.summary).toBe("Upload q3.txt to NAS › /Clients/Acme");
    expect(approval.storage).toMatchObject({ action: "upload", path: "/Clients/Acme/q3.txt", folder: "/Clients/Acme" });
    // a member can't answer it (here they can't even see the owner's DM it was asked in)
    expect([403, 404]).toContain((await api("POST", `/api/approvals/${approval.id}/decide`, { approve: true }, member)).status);
    expect((await api("GET", `/api/approvals/${approval.id}`)).data.status).toBe("pending");
    expect((await api("POST", `/api/approvals/${approval.id}/decide`, { approve: true, always: true })).status).toBe(200);
    await expect.poll(() => fs.existsSync(path.join(files, "Clients/Acme/q3.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(files, "Clients/Acme/q3.txt"), "utf8")).toBe("Q3 numbers");
    // Always in this folder: the next change there goes straight through (a replace, now)
    const again = await call("/api/storage/agent/change", { storage: "NAS", action: "put", path: "/Clients/Acme/q3.txt", fileId: file.id });
    expect(again.data).toEqual({ status: "done", message: "Replaced /Clients/Acme/q3.txt on NAS." });
    expect((await call("/api/storage/agent/change", { storage: "NAS", action: "mkdir", path: "/Clients/Acme/2026" })).data.status).toBe("done");
    expect(fs.statSync(path.join(files, "Clients/Acme/2026")).isDirectory()).toBe(true);
    // deleting always asks, and a no leaves the file alone
    const del = await call("/api/storage/agent/change", { storage: "NAS", action: "delete", path: "/Clients/Acme/q3.txt" });
    expect(del.data.status).toBe("asked");
    await api("POST", `/api/approvals/${del.data.approvalId}/decide`, { approve: false });
    expect(fs.existsSync(path.join(files, "Clients/Acme/q3.txt"))).toBe(true);
    const del2 = await call("/api/storage/agent/change", { storage: "NAS", action: "delete", path: "/Clients/Acme/q3.txt" });
    await api("POST", `/api/approvals/${del2.data.approvalId}/decide`, { approve: true, always: true });
    await expect.poll(() => fs.existsSync(path.join(files, "Clients/Acme/q3.txt"))).toBe(false);
    expect((await api("GET", "/api/storage")).data.connections[0].always).toEqual([{ agentId: scout.id, folder: "/Clients/Acme" }]);
  });

  it("checks folders again when the answer comes: a folder made read only meanwhile isn't written", async () => {
    const up = await fetch(`${base}/api/files`, { method: "POST", headers: { authorization: `Bearer ${scoutToken}`, "content-type": "application/octet-stream", "x-filename": "late.txt" }, body: "late" });
    const file = await up.json();
    await api("DELETE", `/api/storage/${conn.id}/always/${scout.id}?folder=${encodeURIComponent("/Clients/Acme")}`);
    const asked = await agentCall(scoutToken)("/api/storage/agent/change", { storage: "NAS", action: "put", path: "/Clients/Acme/late.txt", fileId: file.id });
    expect(asked.data.status).toBe("asked");
    await api("PATCH", `/api/storage/${conn.id}`, { folders: [{ path: "/Clients/Acme", access: "read" }] });
    await api("POST", `/api/approvals/${asked.data.approvalId}/decide`, { approve: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(path.join(files, "Clients/Acme/late.txt"))).toBe(false);
    await api("PATCH", `/api/storage/${conn.id}`, { folders: [{ path: "/Clients/Acme", access: "write" }, { path: "/Photos", access: "read" }] });
  });

  it("reads a login from the password manager each time and keeps no password", async () => {
    let reads = 0;
    hub.logins.open = async () => ({
      vaultName: "Agents",
      list: async () => [{ id: "nas-1", title: "NAS", site: new URL(davUrl).host, username: davUser }],
      secret: async () => (reads++, { username: davUser, password: davPass }),
    });
    expect((await api("PUT", "/api/logins/source", { kind: "1password", token: "ops_test" })).status).toBe(200);
    const r = await api("POST", "/api/storage/webdav", { service: "webdav", url: davUrl, loginItemId: "nas-1", name: "Vault NAS" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ signIn: "password-manager", loginItemId: "nas-1", account: davUser });
    expect((hub.store.db.prepare("SELECT secret_enc FROM storage_connections WHERE id = ?").get(r.data.id) as { secret_enc: string | null }).secret_enc).toBeNull();
    await api("PATCH", `/api/storage/${r.data.id}`, { folders: [{ path: "/Photos", access: "read" }], allAgents: true });
    const before = reads;
    expect((await agentCall(otherToken)("/api/storage/agent/read", { storage: "Vault NAS", path: "/Photos/cat.txt" })).data.text).toBe("a cat");
    expect(reads).toBeGreaterThan(before);
    await api("DELETE", `/api/storage/${r.data.id}`);
    await api("DELETE", "/api/logins/source");
  });
});

describe("Nextcloud sign-in", () => {
  it("gets its own app password through the browser approval, never the person's password", async () => {
    const start = await api("POST", "/api/storage/nextcloud/start", { server: `${stubs.base}/nc` });
    expect(start.status).toBe(200);
    expect(start.data.loginUrl).toBe(`${stubs.base}/nc/login/v2/flow/abc`);
    expect((await api("POST", "/api/storage/nextcloud/poll", { pendingId: start.data.pendingId })).data).toEqual({ waiting: true });
    stubs.approveNextcloud();
    const done = await api("POST", "/api/storage/nextcloud/poll", { pendingId: start.data.pendingId });
    expect(done.data.connection).toMatchObject({ service: "nextcloud", account: "yug", url: `${stubs.base}/nc/remote.php/dav/files/yug/`, signIn: "app-password" });
    expect((await api("POST", "/api/storage/nextcloud/poll", { pendingId: start.data.pendingId })).status).toBe(410);
    expect((await api("GET", `/api/storage/${done.data.connection.id}/browse?path=/Clients`)).data.entries.length).toBeGreaterThan(0);
    await api("DELETE", `/api/storage/${done.data.connection.id}`);
  });
});

describe("Google Drive and Dropbox", () => {
  const signIn = async (service: "gdrive" | "dropbox", app: Record<string, string>, code: string) => {
    const start = await api("POST", "/api/storage/oauth/start", { service, origin: base, ...app });
    expect(start.status).toBe(200);
    const u = new URL(start.data.url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(`${base}/api/storage/oauth/callback`);
    const back = (await api("GET", `/api/storage/oauth/callback?state=${u.searchParams.get("state")}&code=${code}`, undefined, "")) as any;
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/storage=ok#\/settings\/storage\/stor_/);
    return decodeURIComponent(back.location.split("/").pop());
  };

  it("signs in to Drive through the workspace's own Google app and works by path", async () => {
    expect((await api("POST", "/api/storage/oauth/start", { service: "gdrive", origin: base, clientId: "goog-client" })).status).toBe(400);
    const acme = stubs.seedDrive("Acme", stubs.seedDrive("Clients", "root"));
    stubs.seedDrive("brief.txt", acme, Buffer.from("Drive brief"));
    stubs.seedDrive("other.txt", "root", Buffer.from("not this"));
    const id = await signIn("gdrive", { clientId: "goog-client", clientSecret: "goog-secret" }, "goog-code");
    const conn = (await api("GET", "/api/storage")).data.connections.find((c: any) => c.id === id);
    expect(conn).toMatchObject({ service: "gdrive", account: "you@example.com", signIn: "oauth" });
    expect((await api("GET", "/api/storage")).data.apps).toEqual({ gdrive: { clientId: "goog-client" } });
    expect(JSON.stringify((await api("GET", "/api/storage")).data)).not.toMatch(/goog-secret|goog-access|goog-refresh/);
    await api("PATCH", `/api/storage/${id}`, { folders: [{ path: "/Clients/Acme", access: "write" }], agentIds: [scout.id] });
    const call = agentCall(scoutToken);
    expect((await call("/api/storage/agent/list", { storage: "Google Drive", path: "/Clients/Acme" })).data.entries.map((e: any) => e.path)).toEqual(["/Clients/Acme/brief.txt"]);
    expect((await call("/api/storage/agent/read", { storage: "Google Drive", path: "/Clients/Acme/brief.txt" })).data.text).toBe("Drive brief");
    expect((await call("/api/storage/agent/read", { storage: "Google Drive", path: "/other.txt" })).status).toBe(403);
    expect((await call("/api/storage/agent/search", { storage: "Google Drive", query: ".txt" })).data.map((e: any) => e.path)).toEqual(["/Clients/Acme/brief.txt"]);
    const up = await (await fetch(`${base}/api/files`, { method: "POST", headers: { authorization: `Bearer ${scoutToken}`, "content-type": "application/octet-stream", "x-filename": "plan.txt" }, body: "the plan" })).json();
    const asked = await call("/api/storage/agent/change", { storage: "Google Drive", action: "put", path: "/Clients/Acme/plan.txt", fileId: up.id });
    await api("POST", `/api/approvals/${asked.data.approvalId}/decide`, { approve: true });
    await expect.poll(() => [...stubs.drive.values()].find((f) => f.name === "plan.txt")?.data?.toString()).toBe("the plan");
    expect([...stubs.drive.values()].find((f) => f.name === "plan.txt")!.parents).toEqual([acme]);
    // the Google token only ever went to the Google stub
    expect(stubs.seen.filter((s) => s.auth === "Bearer goog-access").every((s) => s.path.startsWith("/google/"))).toBe(true);
  });

  it("signs in to Dropbox with just an app key and keeps to the folders", async () => {
    stubs.seedDropbox("/Work", "folder");
    stubs.seedDropbox("/Work/todo.md", Buffer.from("- ship"));
    stubs.seedDropbox("/Home", "folder");
    stubs.seedDropbox("/Home/todo.md", Buffer.from("- rest"));
    const id = await signIn("dropbox", { clientId: "dbx-key" }, "dbx-code");
    await api("PATCH", `/api/storage/${id}`, { folders: [{ path: "/Work", access: "write" }], agentIds: [scout.id] });
    const call = agentCall(scoutToken);
    expect((await call("/api/storage/agent/read", { storage: "Dropbox", path: "/Work/todo.md" })).data.text).toBe("- ship");
    expect((await call("/api/storage/agent/read", { storage: "Dropbox", path: "/Home/todo.md" })).status).toBe(403);
    expect((await call("/api/storage/agent/search", { storage: "Dropbox", query: "todo" })).data.map((e: any) => e.path)).toEqual(["/Work/todo.md"]);
    const asked = await call("/api/storage/agent/change", { storage: "Dropbox", action: "delete", path: "/Work/todo.md" });
    expect(asked.data.status).toBe("asked");
    await api("POST", `/api/approvals/${asked.data.approvalId}/decide`, { approve: true });
    await expect.poll(() => stubs.dropbox.has("/work/todo.md")).toBe(false);
    expect(stubs.dropbox.has("/home/todo.md")).toBe(true);
  });
});

describe("agent tools", () => {
  const connect = async (token: string) => {
    const server = await createWispMcp(new WispClient({ url: base, token }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(b);
    return mcp;
  };
  const call = async (mcp: Client, name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

  it("only shows storage tools to agents that have storage", async () => {
    const lonely = (await api("POST", "/api/agents", { handle: "lonely", name: "Lonely", harness: "custom" })).data;
    const none = await connect((await api("POST", `/api/agents/${lonely.id}/token`)).data.token);
    expect((await none.listTools()).tools.some((t) => t.name.startsWith("storage_"))).toBe(false);
    await none.close();
    const mcp = await connect(scoutToken);
    const names = (await mcp.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("storage_")).sort();
    expect(names).toEqual(["storage_delete", "storage_download", "storage_list", "storage_mkdir", "storage_read", "storage_search", "storage_upload"]);
    expect(await call(mcp, "storage_read", { storage: "NAS", path: "/Clients/Acme/notes.txt" })).toBe("Acme likes blue.");
    expect(await call(mcp, "storage_read", { storage: "NAS", path: "/Private/diary.txt" })).toMatch(/^Error: .*outside the folders/);
    const local = path.join(dir, "out");
    expect(await call(mcp, "storage_download", { storage: "NAS", path: "/Photos/cat.txt", dest_dir: local })).toMatch(/^Saved to /);
    expect(fs.readFileSync(path.join(local, "cat.txt"), "utf8")).toBe("a cat");
    fs.writeFileSync(path.join(local, "draft.md"), "# draft");
    expect(await call(mcp, "storage_upload", { storage: "NAS", path: "/Clients/Acme/draft.md", local_path: path.join(local, "draft.md") })).toMatch(/^Asked the person: "Upload draft.md to NAS › \/Clients\/Acme"/);
    await mcp.close();
  });
});

describe("turning the mod off", () => {
  it("cuts agents off at once but keeps what was set up", async () => {
    await api("PUT", "/api/features", { storage: false });
    expect((await api("GET", "/api/storage/mine", undefined, scoutToken)).data).toEqual([]);
    expect((await agentCall(scoutToken)("/api/storage/agent/read", { storage: "NAS", path: "/Photos/cat.txt" })).status).toBe(404);
    await api("PUT", "/api/features", { storage: true });
    expect((await api("GET", "/api/storage")).data.connections.length).toBeGreaterThan(0);
  });
});
