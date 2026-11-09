import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ComputerSpec, DeviceCapabilities, Message } from "@wisp/core";
import type { HarnessAdapter } from "@wisp/adapters";
import { WispClient } from "@wisp/sdk";
import { ComputerHost } from "../../node/src/computers/index.ts";
import type { Driver } from "../../node/src/computers/driver.ts";
import { NodeDaemon } from "../../node/src/daemon.ts";
import { buildHub } from "../src/app.ts";
import { IDLE_STOP_MS } from "../src/computers.ts";
import { makeRoomFor } from "./room.ts";
import type { Hub } from "../src/hub.ts";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

/** A fake VM that's off until something uses it, and takes `bootMs` to come up. */
const vms = new Map<string, { on: boolean; starts: number; stops: number }>();
let bootMs = 0;
let report: (id: string, status: "starting" | "ready" | "stopped" | "error", text: string) => void = () => {};

function fakeVm(spec: ComputerSpec): Driver {
  const st = { on: false, starts: 0, stops: 0 };
  vms.set(spec.id, st);
  const up = async () => {
    if (st.on) return;
    report(spec.id, "starting", "Starting the VM…");
    await new Promise((r) => setTimeout(r, bootMs));
    st.on = true;
    st.starts++;
    report(spec.id, "ready", "");
  };
  const on = <T>(v: T) => async () => (await up(), v);
  return {
    label: "fake",
    screenSize: on({ width: 1280, height: 800 }),
    screenshot: async () => (await up(), { jpeg: JPEG, width: 1280, height: 800 }),
    move: on(undefined),
    click: on(undefined),
    mouse: on(undefined),
    drag: on(undefined),
    scroll: on(undefined),
    type: on(undefined),
    key: on(undefined),
    open: on(undefined),
    run: async () => (await up(), { exitCode: 0, output: "ok" }),
    start: up,
    stop: async () => {
      if (!st.on) return;
      st.on = false;
      st.stops++;
      report(spec.id, "stopped", "");
    },
    destroy: async () => {},
  };
}

class FakeHost extends ComputerHost {
  private fakes = new Map<string, Driver>();
  async capabilities(): Promise<DeviceCapabilities> {
    return { platform: "linux", arch: "x64", screen: { ok: false, detail: "none" }, vm: { ok: true, detail: "fake" } };
  }
  async driver(spec: ComputerSpec): Promise<Driver> {
    let d = this.fakes.get(spec.id);
    if (!d) this.fakes.set(spec.id, (d = fakeVm(spec)));
    return d;
  }
}

let duringRun: (() => Promise<void>) | null = null;
const fake: HarnessAdapter = {
  id: "custom",
  label: "Fake",
  binary: "true",
  async run() {
    await duringRun?.();
    return { finalText: "done", sessionId: "s" };
  },
};

let dir: string;
let hub: Hub;
let close: () => Promise<void>;
let daemon: NodeDaemon;
let owner: WispClient;
let agentApi: WispClient;
let agentId: string;
let computerId: string;
let ownerId: string;

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-idle-"));
  const built = await buildHub({ dataDir: path.join(dir, "hub"), setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
  const setup = await (await fetch(url + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", features: "everything" }) })).json();
  owner = new WispClient({ url, token: setup.token });
  ownerId = setup.user.id;
  await makeRoomFor(hub, owner, { name: "general" });
  const created = await owner.request("POST", "/api/nodes", { name: "box" });
  const nodeId = created.node.id;
  const comp = await owner.request("POST", "/api/computers", { name: "Shared", kind: "vm", nodeId });
  computerId = comp.id;
  const agent = await owner.request("POST", "/api/agents", { handle: "nova", name: "Nova", harness: "custom", nodeId, computerId, settings: { respondTo: "anyone" } });
  agentId = agent.id;
  agentApi = new WispClient({ url, token: (await owner.request("POST", `/api/agents/${agentId}/token`)).token });
  const nodeDir = path.join(dir, "node");
  let send: ((id: string, status: "starting" | "ready" | "stopped" | "error", text: string) => void) | null = null;
  report = (id, status, text) => send?.(id, status, text);
  daemon = new NodeDaemon({ hub: url, token: created.token, name: "box", dir: nodeDir, noPrepare: true }, () => {}, { custom: fake }, new FakeHost({ dir: nodeDir, onVmStatus: (id, status, text) => send?.(id, status, text) }));
  send = (id, status, text) => (daemon as unknown as { send: (m: unknown) => void }).send({ type: "computer_status", computerId: id, status, text });
  daemon.start();
  await waitFor(async () => (await owner.agents()).find((a) => a.status === "online"));
});

afterAll(async () => {
  daemon?.stop();
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

const status = () => hub.store.computer(computerId)!.status;

describe("computers that stop when idle", () => {
  it("starts on first use, stays on while used, and stops after the idle time", async () => {
    await agentApi.request("POST", "/api/computers/mine/act", { action: { action: "click", x: 1, y: 1 } });
    await waitFor(() => status() === "ready");
    expect(vms.get(computerId)!.starts).toBe(1);
    const t0 = Date.now();
    // seen first now; not idle long enough yet
    expect(hub.computers.stopIdle(t0)).toEqual([]);
    expect(hub.computers.stopIdle(t0 + IDLE_STOP_MS - 1000)).toEqual([]);
    expect(hub.computers.stopIdle(t0 + IDLE_STOP_MS + 1000)).toEqual([computerId]);
    await waitFor(() => status() === "stopped");
    expect(vms.get(computerId)!.on).toBe(false);
    // files, sign-ins and apps stay: it was stopped, not removed
    expect(hub.store.computer(computerId)).toBeTruthy();
  });

  it("doesn't start a computer that's off just to show a thumbnail", async () => {
    const before = vms.get(computerId)!.starts;
    // no picture yet, and it's off: none, rather than starting it
    await expect(hub.computers.latest(hub.store.computer(computerId)!, 1000)).rejects.toThrow(/is off/);
    expect(vms.get(computerId)!.starts).toBe(before);
    expect(vms.get(computerId)!.on).toBe(false);
  });

  it("never stops while an agent works or someone has control", async () => {
    await agentApi.request("POST", "/api/computers/mine/act", { action: { action: "type", text: "hi" } });
    await waitFor(() => status() === "ready");
    const c = hub.store.computer(computerId)!;
    hub.computers.take(c, ownerId);
    const t0 = Date.now();
    hub.computers.stopIdle(t0);
    expect(hub.computers.stopIdle(t0 + IDLE_STOP_MS * 3)).toEqual([]);
    hub.computers.release(hub.store.computer(computerId)!, ownerId);
    // idle time counts again from the last moment it was in use
    expect(hub.computers.stopIdle(t0 + IDLE_STOP_MS * 3 + 1000)).toEqual([]);
    expect(hub.computers.stopIdle(t0 + IDLE_STOP_MS * 4 + 2000)).toEqual([computerId]);
    await waitFor(() => status() === "stopped");
  });

  it("says 'Starting the computer…' in chat when an agent waits on it", async () => {
    bootMs = 2600;
    const general = (await owner.channels()).find((c) => c.name === "general")!;
    const said: string[] = [];
    const orig = hub.broadcast.bind(hub);
    hub.broadcast = ((wsId: string, ev: { type: string; event?: { type: string; text?: string } }, who?: unknown) => {
      if (ev.type === "run_event" && ev.event?.type === "status" && ev.event.text) said.push(ev.event.text);
      return (orig as (...a: unknown[]) => unknown)(wsId, ev, who);
    }) as typeof hub.broadcast;
    duringRun = async () => void (await agentApi.request("POST", "/api/computers/mine/act", { action: { action: "click", x: 2, y: 2 } }));
    await owner.send(general.id, "@nova click it");
    await waitFor(async () => ((await owner.messages(general.id, { limit: 20 })).messages as Message[]).some((m) => m.body === "done"), 10_000);
    hub.broadcast = orig;
    duringRun = null;
    bootMs = 0;
    expect(said).toContain("Starting the computer…");
    expect(status()).toBe("ready");
  });

  it("waits for a stop under way, then starts again for a use that came in during it", async () => {
    const c = hub.store.computer(computerId)!;
    const stop = hub.computers.act(c, { action: "stop" }, { kind: "user", id: "system" });
    const use = agentApi.request("POST", "/api/computers/mine/act", { action: { action: "click", x: 3, y: 3 } });
    await Promise.all([stop, use]);
    await waitFor(() => vms.get(computerId)!.on);
    expect(vms.get(computerId)!.on).toBe(true);
  });

  it("gives a shared computer's mouse and keyboard to one agent at a time", async () => {
    const c = hub.store.computer(computerId)!;
    const other = await owner.request("POST", "/api/agents", { handle: "pip", name: "Pip", harness: "custom", nodeId: c.nodeId, computerId });
    const real = hub.currentRun.bind(hub);
    // Nova is in the middle of a task
    hub.currentRun = ((id: string) => (id === agentId ? ({ id: "run-x" } as never) : real(id))) as typeof hub.currentRun;
    try {
      await hub.computers.takeScreen(c, agentId);
      await expect(hub.computers.takeScreen(c, other.id, 300)).rejects.toThrow(/@nova is using/);
      // Nova's still holding it: Nova goes on
      await hub.computers.takeScreen(c, agentId, 300);
    } finally {
      hub.currentRun = real;
    }
    // Nova's work ended: Pip gets it straight away
    await hub.computers.takeScreen(c, other.id, 300);
  });
});
