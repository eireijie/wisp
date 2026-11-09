import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FEATURE_PRESETS, resolveFeatures } from "@wisp/core";
import { buildHub } from "../src/app.ts";
import { setWorkspaceFeatures } from "../src/features.ts";
import type { Hub } from "../src/hub.ts";
import type { Computer } from "@wisp/core";

/** Who can work a VM (control, live view, commands, files) and who can open a terminal on it. */

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;
let owner: string;
let member: string;
let ownerId: string;
let memberId: string;
let ownersVm: Computer;
let sharedVm: Computer;
let membersVm: Computer;

async function api<T = any>(method: string, url: string, body?: unknown, token = member): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wisp-computer-access-"));
  const built = await buildHub({ dataDir: dir, setupCode: false, logger: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  owner = (await api("POST", "/api/setup", { email: "o@example.com", name: "Owner", password: "password123", features: "everything", workspaceName: "Lab" }, "")).data.token;
  const { code } = (await api("POST", "/api/invites", { role: "member" }, owner)).data;
  member = (await api("POST", "/api/invites/accept", { code, email: "m@example.com", name: "Mem", password: "password123" }, "")).data.token;
  ownerId = hub.store.userByEmail("o@example.com")!.id;
  memberId = hub.store.userByEmail("m@example.com")!.id;
  const ownersNode = (await api("POST", "/api/nodes", { name: "Owner's Mac" }, owner)).data.node;
  const sharedNode = (await api("POST", "/api/nodes", { name: "Shared box" }, owner)).data.node;
  await api("PATCH", `/api/nodes/${sharedNode.id}`, { shared: true }, owner);
  const membersNode = (await api("POST", "/api/nodes", { name: "Member's PC" })).data.node;
  const vm = (nodeId: string, name: string) => hub.store.createComputer({ workspaceId: ownersNode.workspaceId, name, kind: "vm", nodeId, config: {} });
  ownersVm = vm(ownersNode.id, "owner-vm");
  sharedVm = vm(sharedNode.id, "shared-vm");
  membersVm = vm(membersNode.id, "member-vm");
});

afterAll(async () => {
  await close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("a VM on the owner's device", () => {
  it("a member can still see it in the list", async () => {
    expect((await api<any[]>("GET", "/api/computers")).data.map((c) => c.id)).toContain(ownersVm.id);
  });

  it("a member can't run commands in it", async () => {
    const r = await api("POST", `/api/computers/${ownersVm.id}/act`, { action: { action: "run", command: "cat ~/.claude/.credentials.json" } });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/Owner's Mac/);
  });

  it("a member can't take control, open the live view or move files", async () => {
    expect((await api("POST", `/api/computers/${ownersVm.id}/control`, { take: true })).status).toBe(403);
    expect((await api("POST", `/api/computers/${ownersVm.id}/view`, {})).status).toBe(403);
    expect((await api("GET", `/api/computers/${ownersVm.id}/files`)).status).toBe(403);
    expect((await api("PUT", `/api/computers/${ownersVm.id}/clipboard`, { text: "hi" })).status).toBe(403);
    expect(hub.computers.controller(ownersVm.id)).toBeNull();
  });

  it("the owner gets past the check (the device is just offline here)", async () => {
    const r = await api("POST", `/api/computers/${ownersVm.id}/act`, { action: { action: "run", command: "true" } }, owner);
    expect(r.status).not.toBe(403);
    expect((await api("POST", `/api/computers/${ownersVm.id}/control`, { take: true }, owner)).status).toBe(200);
    await api("POST", `/api/computers/${ownersVm.id}/control`, { take: false }, owner);
  });
});

describe("a VM on a shared or the member's own device", () => {
  it("a member can use one on a device its owner shared", async () => {
    expect(hub.computers.canUse(sharedVm, memberId)).toBe(true);
    expect((await api("POST", `/api/computers/${sharedVm.id}/control`, { take: true })).status).toBe(200);
    await api("POST", `/api/computers/${sharedVm.id}/control`, { take: false });
  });

  it("a member can use one on their own device", () => {
    expect(hub.computers.canUse(membersVm, memberId)).toBe(true);
  });
});

describe("terminals (the Code mod)", () => {
  it("only whoever's machine it is, even on a shared device", () => {
    expect(hub.computers.canUseShell(ownersVm, ownerId)).toBe(true);
    expect(hub.computers.canUseShell(ownersVm, memberId)).toBe(false);
    expect(hub.computers.canUseShell(sharedVm, memberId)).toBe(false);
    expect(hub.computers.canUseShell(membersVm, memberId)).toBe(true);
    expect(hub.computers.canUseShell(membersVm, ownerId)).toBe(false);
  });

  it("none while Code is off", () => {
    setWorkspaceFeatures(hub.store, ownersVm.workspaceId, { code: false });
    expect(hub.computers.canUseShell(ownersVm, ownerId)).toBe(false);
    setWorkspaceFeatures(hub.store, ownersVm.workspaceId, { code: true });
    expect(hub.computers.canUseShell(ownersVm, ownerId)).toBe(true);
  });
});

describe("the Code mod switch", () => {
  it("is on by default, in Simple and for organizations that saved their mods before it existed", () => {
    expect(FEATURE_PRESETS.simple.code).toBe(true);
    expect(FEATURE_PRESETS.everything.code).toBe(true);
    expect(resolveFeatures({ voice: true }).code).toBe(true);
    expect(resolveFeatures({ code: false }).code).toBe(false);
  });
});
