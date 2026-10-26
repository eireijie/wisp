import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { ClientEvent, Computer, MessagePart } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let app: FastifyInstance;
let hub: Hub;
let owner: string;
let guest: string;
let member: string;
let computer: Computer;
let agentId: string;
let channelId: string;
const users: Record<string, string> = {};

async function api(method: "GET" | "POST" | "PUT", url: string, token = owner, payload?: any) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-guest-computers-"));
  ({ app, hub } = await buildHub({ dataDir: dir, setupCode: false }));
  const setup = await api("POST", "/api/setup", "", { email: "owner@example.com", name: "Owner", password: "password123", features: "everything" });
  owner = setup.json().token;
  users.owner = (await api("GET", "/api/me")).json().user.id;
  for (const role of ["guest", "member"] as const) {
    const email = `${role}@example.com`;
    await api("POST", "/api/members", owner, { email, name: role, password: "password123", role });
    const login = (await api("POST", "/api/auth/login", "", { email, password: "password123" })).json();
    if (role === "guest") guest = login.token;
    else member = login.token;
    users[role] = (await api("GET", "/api/me", login.token)).json().user.id;
  }
  const workspaceId = (await api("GET", "/api/me")).json().workspace.id;
  computer = hub.store.createComputer({ workspaceId, kind: "orgo", name: "Private screen", nodeId: null, config: { computerId: "orgo-id" } });
  agentId = (await api("POST", "/api/agents", owner, { handle: "atlas", name: "Atlas", harness: "custom", computerId: computer.id })).json().id;
  channelId = hub.store.channelByName(workspaceId, "general")!.id;
});

afterAll(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("guests and computers", () => {
  it("forbids every computer read and live-view ticket for guests", async () => {
    for (const url of ["/api/computers", `/api/computers/${computer.id}`, `/api/computers/${computer.id}/screen`, `/api/computers/${computer.id}/log`, `/api/computers/${computer.id}/clipboard`, `/api/computers/${computer.id}/files`, `/api/computers/${computer.id}/files/download?path=secret`, "/api/computers/mine", "/api/settings/computers", `/ws/computers/${computer.id}/frames`, `/ws/computers/${computer.id}/vnc`])
      expect((await api("GET", url, guest)).statusCode, url).toBe(403);
    expect((await api("POST", `/api/computers/${computer.id}/view`, guest, {})).statusCode).toBe(403);
  });

  it.each(["owner", "member"] as const)("keeps computer reads and screenshots available to a %s", async (role) => {
    const token = role === "owner" ? owner : member;
    const latest = vi.spyOn(hub.computers, "latest").mockResolvedValue({ image: Buffer.from("jpeg").toString("base64"), width: 1, height: 1, at: Date.now() });
    try {
      expect((await api("GET", "/api/computers", token)).json()).toContainEqual(expect.objectContaining({ id: computer.id }));
      for (const suffix of ["", "/log", "/screen"]) expect((await api("GET", `/api/computers/${computer.id}${suffix}`, token)).statusCode).toBe(200);
      expect(latest).toHaveBeenCalled();
      expect(hub.computers.canSee(computer, users[role])).toBe(true);
    } finally { latest.mockRestore(); }
  });

  it("keeps agents and chat while removing computer data from REST payloads", async () => {
    const parts: MessagePart[] = [
      { type: "computer", computerId: computer.id },
      { type: "tool_call", name: "mcp__wisp__computer_screenshot", input: {}, output: { image: "secret-screen" } },
      { type: "tool_call", name: "read_file", input: { path: "readme" }, output: "ordinary agent data" },
    ];
    const message = hub.postMessage({ channelId, author: { kind: "agent", id: agentId }, body: "Screen result", parts, route: false });
    hub.store.pin(channelId, message.id, { kind: "user", id: users.owner });
    const messages = (await api("GET", `/api/channels/${channelId}/messages`, guest)).json().messages;
    expect(messages.find((m: any) => m.id === message.id)).toMatchObject({ body: "Screen result", parts: [parts[2]] });
    for (const url of [`/api/channels/${channelId}/pins`, "/api/search?q=Screen"])
      expect((await api("GET", url, guest)).body).not.toMatch(/secret-screen|computer_screenshot|orgo-id/);
    const agents = (await api("GET", "/api/agents", guest)).json();
    expect(agents.find((a: any) => a.id === agentId)).toMatchObject({ name: "Atlas", computerId: null });
    expect((await api("GET", "/api/onboarding", guest)).json().computers).toEqual([]);
    expect((await api("GET", `/api/agents/${agentId}/harness`, guest)).json().computerId).toBeNull();
    expect((await api("GET", `/api/agents/${agentId}/background`, guest)).json().sources.some((s: any) => s.kind === "computer")).toBe(false);
    expect((await api("GET", `/api/channels/${channelId}/messages`, member)).body).toContain("secret-screen");
  });

  it("filters computer events and tool payloads per websocket recipient", () => {
    const received: Record<string, ClientEvent[]> = { guest: [], member: [], owner: [] };
    const sockets: WebSocket[] = [];
    for (const role of ["guest", "member", "owner"] as const) {
      const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (data: string) => received[role].push(JSON.parse(data)), terminate: () => {} }) as unknown as WebSocket;
      sockets.push(socket);
      hub.addClient(socket, computer.workspaceId, users[role], "test");
    }
    try {
      hub.computers.changed(computer.id);
      hub.broadcast(computer.workspaceId, { type: "computer_removed", computerId: computer.id });
      hub.broadcast(computer.workspaceId, { type: "run_event", runId: "run", agentId, channelId, event: { type: "tool_result", name: "computer_screenshot", output: { image: "secret-screen" } } });
      hub.postMessage({ channelId, author: { kind: "agent", id: agentId }, body: "Hello", parts: [{ type: "tool_call", name: "browser_screenshot", input: {}, output: "secret-screen" }], route: false });
      expect(received.guest).toHaveLength(1);
      expect(received.guest[0]).toMatchObject({ type: "message", message: { body: "Hello", parts: [] } });
      expect(received.owner).toHaveLength(4);
      expect(received.member).toHaveLength(4);
    } finally { for (const socket of sockets) socket.emit("close"); }
  });

  it("refuses frames to guests and stops sending when a viewer becomes a guest", async () => {
    const { node } = (await api("POST", "/api/nodes", owner, { name: "Frame host" })).json();
    const screen = hub.store.createComputer({ workspaceId: computer.workspaceId, kind: "vm", name: "Frames", nodeId: node.id, config: {} });
    const guestSocket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() }) as unknown as WebSocket;
    hub.computers.addFrameViewer(screen, guestSocket, users.guest);
    expect(guestSocket.send).not.toHaveBeenCalled();
    expect(guestSocket.close).toHaveBeenCalledWith(4403, "forbidden");
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() }) as unknown as WebSocket;
    hub.computers.addFrameViewer(screen, socket, users.member);
    expect(socket.send).toHaveBeenCalledTimes(1);
    hub.store.db.prepare("UPDATE memberships SET role = 'guest' WHERE user_id = ?").run(users.member);
    try {
      hub.computers.onFrame(node.id, { type: "screen_frame", computerId: screen.id, image: "secret-screen", width: 1, height: 1 });
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(socket.close).toHaveBeenCalledWith(4403, "forbidden");
    } finally {
      hub.store.db.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").run(users.member);
      socket.emit("close");
    }
  });

  it("rejects outstanding live-view tickets after a member becomes a guest", async () => {
    const ticket = await hub.computers.ticket(computer, users.member);
    hub.store.db.prepare("UPDATE memberships SET role = 'guest' WHERE user_id = ?").run(users.member);
    try { expect(hub.computers.redeem(ticket, computer.id)).toBeNull(); }
    finally { hub.store.db.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").run(users.member); }
  });
});
