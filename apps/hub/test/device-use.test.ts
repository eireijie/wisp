import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WispClient } from "@wisp/sdk";
import type { Message } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import { keepDeviceScreens } from "../src/shared-computer.ts";
import { makeRoomFor } from "./room.ts";
import type { Hub } from "../src/hub.ts";

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let hub: Hub;
let url: string;
let close: () => Promise<void>;
let owner: WispClient;
let member: WispClient;
let agentApi: WispClient;
let agentId: string;
let mac: string;
let memberPc: string;
let ownerId: string;
let ws: string;
let generalId: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-devuse-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  ownerId = setup.user.id;
  ws = hub.store.firstWorkspace()!.id;
  generalId = (await makeRoomFor(hub, owner, { name: "general" })).data.id;
  mac = (await owner.request("POST", "/api/nodes", { name: "MacBook Air" })).node.id;
  const server = (await owner.request("POST", "/api/nodes", { name: "server" })).node.id;
  await owner.request("POST", "/api/members", { email: "m@example.com", name: "Mem", password: "password123", role: "member" });
  member = new WispClient({ url, token: (await (await fetch(url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "m@example.com", password: "password123" }) })).json()).token });
  memberPc = (await member.request("POST", "/api/nodes", { name: "Mem's PC" })).node.id;
  const agent = await owner.request("POST", "/api/agents", { handle: "scout", name: "Scout", harness: "custom", nodeId: server });
  agentId = agent.id;
  agentApi = new WispClient({ url, token: (await owner.request("POST", `/api/agents/${agentId}/token`)).token });
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Scout acting for the owner, as if in a run they asked for. */
const asOwnersWork = async <T>(fn: () => Promise<T>) => {
  const real = hub.currentRun.bind(hub);
  hub.currentRun = ((id: string) => (id === agentId ? ({ id: "r1", requestedBy: ownerId, channelId: generalId, threadId: null } as never) : real(id))) as typeof hub.currentRun;
  try {
    return await fn();
  } finally {
    hub.currentRun = real;
  }
};

describe("Use my computers", () => {
  it("is off until a device's owner allows it, and only they can", async () => {
    await expect(asOwnersWork(() => agentApi.computer({ action: "screenshot" }, { device: "MacBook Air" }))).rejects.toThrow(/can't use MacBook Air/);
    // a member can't let an agent onto the owner's Mac, nor the owner onto the member's PC
    await expect(member.request("PATCH", `/api/agents/${agentId}`, { settings: { useDevices: { [mac]: "tell" } } })).rejects.toThrow();
    await expect(owner.request("PATCH", `/api/agents/${agentId}`, { settings: { useDevices: { [memberPc]: "tell" } } })).rejects.toThrow(/Only Mem decides/);
    await owner.request("PATCH", `/api/agents/${agentId}`, { settings: { useDevices: { [mac]: "ask" } } });
    expect(hub.store.agent(agentId)!.settings.useDevices).toEqual({ [mac]: "ask" });
    expect(await agentApi.myDevices()).toMatchObject([{ name: "MacBook Air", how: "ask" }]);
  });

  it("asks first for each task, then goes ahead after a yes", async () => {
    await expect(asOwnersWork(() => agentApi.computer({ action: "screenshot" }, { device: "macbook", why: "Your bank is only signed in there." }))).rejects.toThrow(/Asked Me whether you can use MacBook Air/);
    // asking again doesn't post a second card
    await expect(asOwnersWork(() => agentApi.computer({ action: "screenshot" }, { device: "MacBook Air" }))).rejects.toThrow(/Asked/);
    const pending = hub.store.approvals(ws, "pending").filter((a) => a.device);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ summary: "Use your MacBook Air?", details: "Your bank is only signed in there.", device: { nodeId: mac, ownerId } });
    // only the Mac's owner answers
    await expect(member.request("POST", `/api/approvals/${pending[0].id}/decide`, { approve: true })).rejects.toThrow();
    await owner.request("POST", `/api/approvals/${pending[0].id}/decide`, { approve: true });
    const said = (await owner.messages(pending[0].channelId, { limit: 50 })).messages as Message[];
    expect(said.some((m) => m.body.includes("@scout Go ahead: you can use MacBook Air"))).toBe(true);
    // allowed now: it gets past Wisp's checks to the device (offline in this test)
    await expect(asOwnersWork(() => agentApi.computer({ action: "screenshot" }, { device: "MacBook Air" }))).rejects.toThrow(/offline/);
  });

  it("only for the device owner's own requests", async () => {
    const real = hub.currentRun.bind(hub);
    hub.currentRun = ((id: string) => (id === agentId ? ({ id: "r2", requestedBy: "someone-else" } as never) : real(id))) as typeof hub.currentRun;
    try {
      await expect(agentApi.computer({ action: "screenshot" }, { device: "MacBook Air" })).rejects.toThrow(/only use it for things Me asked for/);
    } finally {
      hub.currentRun = real;
    }
  });

  it("on 'tell me after', goes ahead and says so once the work is done", async () => {
    await owner.request("PATCH", `/api/agents/${agentId}`, { settings: { useDevices: { [mac]: "tell" } } });
    await expect(asOwnersWork(() => agentApi.computer({ action: "click", x: 1, y: 1 }, { device: "MacBook Air" }))).rejects.toThrow(/offline/);
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    hub.deviceUse.noteUse("r3", mac);
    hub.deviceUse.runEnded({ id: "r3", agentId, channelId: general.id, threadId: null });
    const msgs = (await owner.messages(general.id, { limit: 50 })).messages as Message[];
    expect(msgs.some((m) => m.parts?.some((p) => p.type === "notice" && p.text === "@scout used your MacBook Air for 1 min"))).toBe(true);
  });

  it("keeps agents already on a person's own screen there, as allowed", async () => {
    const screen = hub.store.createComputer({ workspaceId: ws, name: "MacBook Air", kind: "device", nodeId: mac, config: {}, status: "ready" });
    const onScreen = await owner.request("POST", "/api/agents", { handle: "desk", name: "Desk", harness: "custom", nodeId: mac, computerId: screen.id });
    expect(keepDeviceScreens(hub, ws)).toEqual([onScreen.id]);
    expect(hub.store.agent(onScreen.id)!.settings.useDevices).toEqual({ [mac]: "tell" });
    expect(keepDeviceScreens(hub, ws)).toEqual([]);
  });
});
