import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null) as T };
}

const login = async (email: string, password: string, ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150.0 Safari/537.36") =>
  (await api<{ token: string }>("POST", "/api/auth/login", { email, password }, "", { "user-agent": ua })).data.token;

async function browserSocket(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ token })));
    ws.once("message", (raw) => {
      expect(JSON.parse(raw.toString()).type).toBe("ready");
      resolve();
    });
    ws.once("error", reject);
  });
  return { ws, closed };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-settings-"));
  const built = await buildHub({ dataDir: dir });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "me@example.com", name: "Yugal Patel", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("your settings", () => {
  it("keeps your profile and preferences, and agents see your name and local time", async () => {
    const me = (await api("PATCH", "/api/me", { preferredName: "Yug", timezone: "America/New_York" })).data;
    expect(me).toMatchObject({ name: "Yugal Patel", preferredName: "Yug", timezone: "America/New_York" });
    expect((await api("PATCH", "/api/me", { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await api("PUT", "/api/me/prefs", { sendWith: "mod-enter", clock: "24h" })).data).toEqual({ sendWith: "mod-enter", clock: "24h", experience: "simple" });
    expect((await api("GET", "/api/me")).data.prefs).toEqual({ sendWith: "mod-enter", clock: "24h", experience: "simple" });

    const agent = (await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "custom" })).data;
    const general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
    const msg = (await api("POST", `/api/channels/${general.id}/messages`, { body: "@atlas hi" })).data;
    const prompt = await hub.buildPrompt(agent.id, general.id, null, msg.id);
    expect(prompt).toContain("New message from Yug:");
    expect(prompt).toMatch(/It's \w+day, .* for Yug \(America\/New_York\)\./);
  });

  it("closes every socket for a revoked sign-in while keeping other sign-ins connected", async () => {
    const other = await login("me@example.com", "password123");
    const session = (await api<any[]>("GET", "/api/me/sessions", undefined, other)).data.find((s) => s.current);
    const live = await browserSocket(owner);
    const revoked = await browserSocket(other);
    const revokedTab = await browserSocket(other);
    expect((await api("DELETE", `/api/me/sessions/${session.id}`)).status).toBe(200);
    expect(await revoked.closed).toBe(4401);
    expect(await revokedTab.closed).toBe(4401);
    expect((await api("GET", "/api/me", undefined, other)).status).toBe(401);
    const event = new Promise<string>((resolve) => live.ws.once("message", (raw) => resolve(JSON.parse(raw.toString()).type)));
    hub.broadcast((await api("GET", "/api/me")).data.workspace.id, { type: "channels_changed" });
    expect(await event).toBe("channels_changed");
    live.ws.close();
  });

  it("closes the socket when its own sign-in logs out", async () => {
    const other = await login("me@example.com", "password123");
    const live = await browserSocket(other);
    expect((await api("POST", "/api/auth/logout", undefined, other)).status).toBe(200);
    expect(await live.closed).toBe(4401);
  });

  it("changes your password, signs out your other sign-ins, and lists them by device", async () => {
    const phone = await login("me@example.com", "password123", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1");
    const phoneSocket = await browserSocket(phone);
    const currentSocket = await browserSocket(owner);
    const sessions = (await api<any[]>("GET", "/api/me/sessions")).data;
    expect(sessions.map((s) => s.label)).toContain("Safari on iPhone");
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    expect((await api("POST", "/api/me/password", { current: "wrong", next: "password456" })).status).toBe(403);
    expect(phoneSocket.ws.readyState).toBe(WebSocket.OPEN);
    expect((await api("POST", "/api/me/password", { current: "password123", next: "password456" })).status).toBe(200);
    expect(await phoneSocket.closed).toBe(4401);
    expect(currentSocket.ws.readyState).toBe(WebSocket.OPEN);
    expect((await api("GET", "/api/me", undefined, phone)).status).toBe(401);
    expect((await api("GET", "/api/me")).status).toBe(200);
    const other = await login("me@example.com", "password456");
    expect(other).toBeTruthy();
    const otherSocket = await browserSocket(other);
    expect((await api("POST", "/api/me/sessions/sign-out-others")).data.signedOut).toBeGreaterThan(0);
    expect(await otherSocket.closed).toBe(4401);
    expect(currentSocket.ws.readyState).toBe(WebSocket.OPEN);
    expect((await api<any[]>("GET", "/api/me/sessions")).data).toHaveLength(1);
    currentSocket.ws.close();
  });
});

describe("workspace settings", () => {
  it("invites someone with a link, once", async () => {
    const inv = (await api("POST", "/api/invites", { role: "member", days: 3 })).data;
    expect(inv.code).toBeTruthy();
    expect((await api("GET", `/api/invites/check?code=${inv.code}`, undefined, "")).data).toMatchObject({ workspace: "Lab", role: "member" });
    const joined = await api("POST", "/api/invites/accept", { code: inv.code, name: "Sam", email: "sam@example.com", password: "password123" }, "");
    expect(joined.status).toBe(200);
    expect((await api("GET", "/api/me", undefined, joined.data.token)).data).toMatchObject({ role: "member", user: { name: "Sam" } });
    // used up, and it's gone from the list
    expect((await api("POST", "/api/invites/accept", { code: inv.code, name: "Eve", email: "eve@example.com", password: "password123" }, "")).status).toBe(404);
    expect((await api<any[]>("GET", "/api/invites")).data).toEqual([]);
    // members can't make invites
    expect((await api("POST", "/api/invites", {}, joined.data.token)).status).toBe(403);
  });

  it("changes roles and removes people, keeping at least one owner, and disconnects what they connected", async () => {
    const sam = (await api<any[]>("GET", "/api/members")).data.find((m) => m.name === "Sam");
    const me = (await api<any[]>("GET", "/api/members")).data.find((m) => m.role === "owner");
    expect((await api("PATCH", `/api/members/${me.id}`, { role: "member" })).status).toBe(409);
    const samToken = await login("sam@example.com", "password123");
    const browser = await browserSocket(samToken);
    // Sam's laptop is connected, with an agent on it that has a harness token
    const laptop = (await api("POST", "/api/nodes", { name: "sams-laptop" }, samToken)).data;
    const nodeSocket = (token: string) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${token}` } });
      const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      const opened = new Promise<boolean>((resolve) => {
        ws.on("message", () => resolve(true));
        ws.on("close", () => resolve(false));
      });
      return { ws, closed, opened };
    };
    const live = nodeSocket(laptop.token);
    expect(await live.opened).toBe(true);
    const agent = (await api("POST", "/api/agents", { handle: "lap", name: "Lap", harness: "codex", nodeId: laptop.node.id }, samToken)).data;
    const harnessToken = (await api("POST", `/api/node/agents/${agent.id}/token`, undefined, laptop.token)).data.token;
    expect((await api("GET", "/api/me", undefined, harnessToken)).status).toBe(200);
    expect((await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === laptop.node.id)).toMatchObject({ online: true, ownerId: sam.id });

    expect((await api("PATCH", `/api/members/${sam.id}`, { role: "guest" })).data.role).toBe("guest");
    expect((await api("DELETE", `/api/members/${sam.id}`)).status).toBe(200);
    expect(await browser.closed).toBe(4401);
    expect((await api("GET", "/api/me", undefined, samToken)).status).toBe(401);
    expect((await api<any[]>("GET", "/api/members")).data.map((m) => m.name)).toEqual(["Yugal Patel"]);
    // the laptop is off the hub, its token and the agent's harness token no longer work, and it belongs to nobody
    expect(await live.closed).toBe(4401);
    expect(await nodeSocket(laptop.token).opened).toBe(false);
    expect((await api("GET", "/api/me", undefined, harnessToken)).status).toBe(401);
    expect((await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === laptop.node.id)).toMatchObject({ online: false, ownerId: null });
  });

  it("closes all sign-ins when an owner resets someone's password", async () => {
    const inv = (await api("POST", "/api/invites", { role: "member" })).data;
    const joined = (await api("POST", "/api/invites/accept", { code: inv.code, name: "Reset", email: "reset@example.com", password: "password123" }, "")).data;
    const member = (await api("GET", "/api/me", undefined, joined.token)).data.user;
    const browser = await browserSocket(joined.token);
    const phoneToken = await login("reset@example.com", "password123");
    const phone = await browserSocket(phoneToken);
    expect((await api("POST", `/api/members/${member.id}/password`, { password: "password456" })).status).toBe(200);
    expect(await browser.closed).toBe(4401);
    expect(await phone.closed).toBe(4401);
    expect((await api("GET", "/api/me", undefined, joined.token)).status).toBe(401);
    expect((await api("DELETE", `/api/members/${member.id}`)).status).toBe(200);
  });

  it("sets what agents ask about first, how far they can ping each other, and new agents' access", async () => {
    expect((await api("GET", "/api/settings/agents")).data).toEqual({ askBefore: ["send", "spend", "delete", "post", "signup", "share"], maxHops: 6, maxRunsPerMinute: 20, defaultAccess: "edit", leadsCreateAgents: false, subAgents: false, maxAgentMade: 10 });
    await api("PUT", "/api/settings/agents", { askBefore: ["spend", "signup"], maxHops: 2, defaultAccess: "read-only" });
    const agent = (await api("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom" })).data;
    expect(agent.settings.access).toBe("read-only");
    const general = (await api<any[]>("GET", "/api/channels")).data.find((c) => c.name === "general");
    const msg = (await api("POST", `/api/channels/${general.id}/messages`, { body: "@nova hi" })).data;
    const prompt = await hub.buildPrompt(agent.id, general.id, null, msg.id);
    expect(prompt).toContain("buying or paying for anything; signing up for new accounts or services");
    expect(prompt).not.toContain("posting publicly");
    // a message two hops deep is turned away
    hub.postMessage({ channelId: general.id, author: { kind: "agent", id: agent.id }, body: "@atlas ping", hop: 2 });
    const notice = (await api<any>("GET", `/api/channels/${general.id}/messages`)).data.messages.find((m: any) => m.parts.some((p: any) => p.text?.includes("hop limit 2")));
    expect(notice).toBeTruthy();
  });

  it("lists agents' connection tokens and disconnects them", async () => {
    const agent = (await api<any[]>("GET", "/api/agents")).data.find((a) => a.handle === "atlas");
    const t = (await api("POST", `/api/agents/${agent.id}/token`)).data.token;
    const list = (await api<any[]>("GET", "/api/connections")).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agentId: agent.id, kind: "connection" });
    expect((await api("GET", "/api/computers/mine", undefined, t)).status).not.toBe(401);
    expect((await api("DELETE", `/api/connections/${list[0].id}`)).status).toBe(200);
    expect((await api("GET", "/api/computers/mine", undefined, t)).status).toBe(401);
  });

  it("lets a device's owner say what it does for agents", async () => {
    const node = (await api("POST", "/api/nodes", { name: "box" })).data.node;
    expect((await api("PATCH", `/api/nodes/${node.id}`, { role: "vms" })).status).toBe(200);
    expect((await api<any[]>("GET", "/api/nodes")).data.find((n) => n.id === node.id).role).toBe("vms");
    expect((await api("PATCH", `/api/nodes/${node.id}`, { role: "everything" })).status).toBe(400);
  });

  it("renames the workspace and exports memory and conversations", async () => {
    expect((await api("PATCH", "/api/workspace", { name: "Lab 2" })).data.name).toBe("Lab 2");
    const zip = await fetch(base + "/api/export/vault.zip", { headers: { authorization: `Bearer ${owner}` } });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    const conv = (await api("GET", "/api/export/conversations.json")).data;
    expect(conv.channels.find((c: any) => c.name === "#general").messages.some((m: any) => m.text === "@atlas hi" && m.from === "Yugal Patel")).toBe(true);
  });
});
