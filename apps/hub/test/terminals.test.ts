import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";
import type { Computer } from "@wisp/core";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { harnessOn } from "../src/terminals.ts";

/** The Code mod's terminals, end to end: a browser socket, the hub, a real device and a real shell. */

const hasPty = (() => {
  try {
    createRequire(import.meta.url)("node-pty");
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: string;
let member: string;
let device: Computer;
const oldShell = process.env.SHELL;

async function api<T = any>(method: string, url: string, body?: unknown, token = owner): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

/** A pane: what the shell printed, the control messages, and how the socket closed. */
async function pane(session: string, token = owner) {
  const r = await api<{ url: string }>("POST", `/api/computers/${device.id}/terminal`, { session }, token);
  expect(r.status).toBe(200);
  const ws = new WebSocket(`${base.replace("http", "ws")}${r.data.url}&cols=100&rows=30`);
  const p = { ws, out: "", control: [] as any[], closed: null as null | { code: number; reason: string } };
  ws.on("message", (data, isBinary) => {
    if (isBinary) p.out += data.toString();
    else p.control.push(JSON.parse(data.toString()));
  });
  ws.on("close", (code, reason) => (p.closed = { code, reason: reason.toString() }));
  await waitFor(() => p.control.find((m) => m.type === "ready") ?? p.closed);
  return p;
}

beforeAll(async () => {
  // a plain shell, so what it prints doesn't depend on whoever runs the tests
  process.env.SHELL = "/bin/sh";
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-terminals-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false, logger: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "o@example.com", name: "Owner", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  const { code } = (await api("POST", "/api/invites", { role: "member" })).data;
  member = (await api("POST", "/api/invites/accept", { code, email: "m@example.com", name: "Mem", password: "password123" }, "")).data.token;
  const { node, token } = (await api("POST", "/api/nodes", { name: "box" })).data;
  device = hub.store.createComputer({ workspaceId: node.workspaceId, name: "box screen", kind: "device", nodeId: node.id, config: {} });
  daemon = new NodeDaemon({ hub: base, token, name: "box", dir: path.join(dir, "node") }, () => {}, {});
  daemon.start();
  await waitFor(() => hub.isNodeOnline(node.id));
});

afterAll(async () => {
  await daemon?.stop(100);
  await close();
  process.env.SHELL = oldShell;
  await fsp.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasPty)("a terminal on the owner's device", () => {
  it("runs what's typed and shows what the shell prints", async () => {
    const p = await pane("main");
    expect(p.control[0]).toEqual({ type: "ready", resumed: false });
    p.ws.send(Buffer.from("echo wisp-$((40+2))\r"), { binary: true });
    await waitFor(() => p.out.includes("wisp-42"));
    p.ws.close();
    await waitFor(() => p.closed);
  });

  it("comes back to the same shell after the page goes away, with its recent screen", async () => {
    const p = await pane("main");
    expect(p.control[0]).toEqual({ type: "ready", resumed: true });
    await waitFor(() => p.out.includes("wisp-42"));
    p.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    // tmux applies a new size a moment later, so ask until it has
    let asked = 0;
    await waitFor(() => {
      if (/\b40 120\b/.test(p.out)) return true;
      if (asked++ % 20 === 0) p.ws.send(Buffer.from("stty size\r"), { binary: true });
    });
    // closing the pane for good stops the shell
    p.ws.send(JSON.stringify({ type: "end" }));
    await waitFor(() => p.closed);
    const again = await pane("main");
    expect(again.control[0]).toEqual({ type: "ready", resumed: false });
    again.ws.send(JSON.stringify({ type: "end" }));
    await waitFor(() => again.closed);
  });

  it("tells the page when the shell exits", async () => {
    const p = await pane("short");
    p.ws.send(Buffer.from("exit\r"), { binary: true });
    await waitFor(() => p.closed);
    expect(p.control.at(-1)).toMatchObject({ type: "closed", exited: true });
  });

  it("closes open terminals when Code is turned off", async () => {
    const p = await pane("off");
    expect((await api("PUT", "/api/features", { code: false })).status).toBe(200);
    await waitFor(() => p.closed);
    expect(p.closed!.code).toBe(4403);
    expect((await api("POST", `/api/computers/${device.id}/terminal`, {})).status).toBe(403);
    await api("PUT", "/api/features", { code: true });
  });
});

describe("who can open one", () => {
  it("not a member: the owner's screen is hidden from them, and a VM there is refused", async () => {
    expect((await api("POST", `/api/computers/${device.id}/terminal`, {}, member)).status).toBe(404);
    const vm = hub.store.createComputer({ workspaceId: device.workspaceId, name: "owner-vm", kind: "vm", nodeId: device.nodeId!, config: {} });
    const r = await api("POST", `/api/computers/${vm.id}/terminal`, {}, member);
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/Only Owner can open a terminal on owner-vm/);
  });

  it("an agent's CLI in a pane gets the person's own model sign-in, never someone else's", async () => {
    const ownerId = (await api("GET", "/api/me")).data.user.id;
    const memberId = (await api("GET", "/api/me", undefined, member)).data.user.id;
    const ws = device.workspaceId;
    hub.models.create({ workspaceId: ws, userId: memberId, provider: "openai", kind: "key", label: "theirs", secret: { key: "sk-member-0000" } });
    expect(hub.terminalCredential(device, ownerId, "codex")).toBeNull();
    const mine = hub.models.create({ workspaceId: ws, userId: ownerId, provider: "openai", kind: "key", label: "mine", secret: { key: "sk-owner-0000" } });
    expect(hub.terminalCredential(device, ownerId, "codex")).toMatchObject({ connectionId: mine, provider: "openai", kind: "key" });
    // one the harness can't use isn't handed to it
    expect(hub.terminalCredential(device, ownerId, "gemini")).toBeNull();
  });

  it("knows when a VM's agents run their harness on a device, signed in there", async () => {
    const vm = hub.store.createComputer({ workspaceId: device.workspaceId, name: "shared", kind: "vm", nodeId: device.nodeId!, config: {} });
    expect(harnessOn(hub, vm, "codex")).toEqual({});
    const r = await api("POST", "/api/agents", { handle: "atlas", name: "Atlas", harness: "codex", nodeId: device.nodeId, computerId: vm.id });
    expect(r.status).toBe(200);
    expect(harnessOn(hub, vm, "codex")).toEqual({ harnessOn: "box" });
    // one that runs inside the VM signs in there
    hub.store.updateAgent(r.data.id, { settings: { runIn: "computer" } });
    expect(harnessOn(hub, vm, "codex")).toEqual({});
  });

  it("a link works once", async () => {
    const r = await api<{ url: string }>("POST", `/api/computers/${device.id}/terminal`, {});
    const codes: number[] = [];
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(`${base.replace("http", "ws")}${r.data.url}&cols=80&rows=24`);
      await new Promise<void>((resolve) => {
        ws.on("message", (d, bin) => !bin && JSON.parse(d.toString()).type === "ready" && ws.close());
        ws.on("close", (code) => (codes.push(code), resolve()));
      });
    }
    expect(codes[1]).toBe(4401);
  });

  it("not without a ticket", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/terminals/${device.id}?cols=80&rows=24`);
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
