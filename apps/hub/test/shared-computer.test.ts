import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WispClient } from "@wisp/sdk";
import { buildHub } from "../src/app.ts";
import { ADVANCED_KEY, HOME_KEY, SHARED_KEY, adoptShared, sharedSize } from "../src/shared-computer.ts";
import { saveAgentDefaults } from "../src/agent-defaults.ts";
import { makeRoomFor } from "./room.ts";
import type { Hub } from "../src/hub.ts";

let dir: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: WispClient;
let member: WispClient;
let ws: string;
let home: string;
let other: string;

const caps = (memoryGb: number, vm = true) => ({ platform: "linux", arch: "x64", memoryGb, screen: { ok: false, detail: "" }, vm: { ok: vm, detail: "" } });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-shared-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  ws = setup.workspace?.id ?? hub.store.firstWorkspace()!.id;
  await makeRoomFor(hub, owner, { name: "general" });
  other = (await owner.request("POST", "/api/nodes", { name: "laptop" })).node.id;
  home = (await owner.request("POST", "/api/nodes", { name: "server" })).node.id;
  hub.store.setSetting(ws, HOME_KEY, home);
  hub.store.setNodeCapabilities(home, caps(8));
  hub.store.setNodeCapabilities(other, caps(16));
  await owner.request("POST", "/api/members", { email: "m@example.com", name: "Mem", password: "password123", role: "member" });
  const login = await (await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "m@example.com", password: "password123" }) })).json();
  member = new WispClient({ url, token: login.token });
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the shared computer", () => {
  it("is sized to the device: a quarter of its memory, 1.5 to 4 GB", () => {
    expect(sharedSize(4)).toEqual({ cpus: 1, memoryGb: 1.5 });
    expect(sharedSize(8)).toEqual({ cpus: 2, memoryGb: 2 });
    expect(sharedSize(64)).toEqual({ cpus: 2, memoryGb: 4 });
    expect(sharedSize(undefined)).toEqual({ cpus: 2, memoryGb: 2 });
  });

  it("puts an owner's new agents on one shared computer, off until needed, with their AI beside it", async () => {
    const a = await owner.request("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom", useDefaults: true });
    const b = await owner.request("POST", "/api/agents", { handle: "harry", name: "Harry", harness: "custom", useDefaults: true });
    const shared = hub.store.setting(ws, SHARED_KEY)!;
    expect(a.computerId).toBe(shared);
    expect(b.computerId).toBe(shared);
    expect(a.nodeId).toBe(home);
    // its AI tool runs on the device, not inside the computer, so chat never waits for it
    expect(hub.store.agent(a.id)!.settings.runIn).toBeUndefined();
    const c = hub.store.computer(shared)!;
    expect(c).toMatchObject({ kind: "vm", nodeId: home, status: "stopped", name: "Shared computer" });
    expect(c.config).toMatchObject({ memoryGb: 2, cpus: 2 });
  });

  it("gives a member's agent a computer of its own, never the owner's sign-ins", async () => {
    const m = await member.request("POST", "/api/agents", { handle: "pip", name: "Pip", harness: "custom", useDefaults: true });
    expect(m.computerId).not.toBe(hub.store.setting(ws, SHARED_KEY));
  });

  it("moves an owner's older agents with no computer onto it, and leaves the rest alone", async () => {
    const plain = await owner.request("POST", "/api/agents", { handle: "old", name: "Old", harness: "custom", nodeId: home });
    const headless = await owner.request("POST", "/api/agents", { handle: "quiet", name: "Quiet", harness: "custom", nodeId: home, settings: { headless: true } });
    const elsewhere = await owner.request("POST", "/api/agents", { handle: "far", name: "Far", harness: "custom", nodeId: other });
    // as when upgrading a Wisp from before the shared computer
    hub.store.setSetting(ws, "computers.sharedAdopted", null);
    const moved = adoptShared(hub, ws);
    expect(moved).toEqual([plain.id]);
    expect(hub.store.agent(plain.id)!.computerId).toBe(hub.store.setting(ws, SHARED_KEY));
    expect(hub.store.agent(headless.id)!.computerId).toBeNull();
    // its AI tool is signed in on another device: it stays there
    expect(hub.store.agent(elsewhere.id)!.computerId).toBeNull();
    expect(adoptShared(hub, ws)).toEqual([]);
  });

  it("waits for a device that can run it, then hands it out", async () => {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-shared2-"));
    const built = await buildHub({ dataDir: path.join(dir2, "hub"), setupCode: false });
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
    const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", name: "A", password: "password123", features: "everything" }) })).json();
    const o = new WispClient({ url, token: setup.token });
    const h2 = built.hub;
    const w2 = h2.store.firstWorkspace()!.id;
    const node = (await o.request("POST", "/api/nodes", { name: "mac" })).node.id;
    h2.store.setNodeCapabilities(node, caps(16, false));
    const a = await o.request("POST", "/api/agents", { handle: "early", name: "Early", harness: "custom", useDefaults: true });
    expect(a.computerId).toBeNull();
    expect(a.nodeId).toBe(node);
    h2.store.setNodeCapabilities(node, caps(16, true));
    expect(adoptShared(h2, w2)).toEqual([a.id]);
    expect(h2.store.computer(h2.store.agent(a.id)!.computerId!)!.config).toMatchObject({ memoryGb: 4 });
    await built.app.close();
    await fs.rm(dir2, { recursive: true, force: true });
  }, 120_000);

  it("in Advanced, follows the owner's defaults instead", async () => {
    hub.store.setSetting(ws, ADVANCED_KEY, "true");
    saveAgentDefaults(hub.store, ws, { computer: "none" });
    const a = await owner.request("POST", "/api/agents", { handle: "lone", name: "Lone", harness: "custom", useDefaults: true });
    expect(a.computerId).toBeNull();
    expect(hub.store.agent(a.id)!.settings.headless).toBe(true);
    hub.store.setSetting(ws, ADVANCED_KEY, "false");
  });
});
