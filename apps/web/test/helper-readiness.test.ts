import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@wisp/core";
import type { DeviceInfo } from "../src/devices.ts";
import { helperChecklist, homeReadiness, nextStep, pickHelper } from "../src/onboarding.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const dev = (o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id: "n1", name: "my-mac", online: true, agents: [], ...o });
const helper = (o: Partial<Agent> = {}) => ({ id: "a1", name: "Everyday Agent", nodeId: "n1", harness: "gemini", ...o }) as Agent;
const none = { anywhere: false, address: false, agent: false, devices: false };
const all = { anywhere: true, address: true, agent: true, devices: true };

describe("nextStep", () => {
  it("names the first unmet step, or null when done", () => {
    expect(nextStep(none)).toBe("anywhere");
    expect(nextStep({ ...none, anywhere: true, address: true })).toBe("agent");
    expect(nextStep({ ...all, anywhere: false })).toBe("anywhere");
    expect(nextStep({ ...all, devices: false })).toBe("devices");
    expect(nextStep(all)).toBeNull();
  });
});

describe("pickHelper", () => {
  it("prefers a ready agent over an offline one", () => {
    const off = helper({ id: "off", nodeId: "n2" });
    const ok = helper({ id: "ok" });
    expect(pickHelper([off, ok], [dev(), dev({ id: "n2", online: false })])?.id).toBe("ok");
    expect(pickHelper([], [dev()])).toBeNull();
  });
});

describe("homeReadiness", () => {
  it("asks to continue setup when there is no agent", () => {
    expect(homeReadiness({ ...none, anywhere: true, address: true }, [], [dev()])).toEqual({ kind: "setup", next: "agent" });
  });
  it("says what an agent is waiting for", () => {
    const r = homeReadiness(all, [helper()], [dev({ online: false })]);
    expect(r).toMatchObject({ kind: "waiting", problem: "my-mac is offline", deviceName: "my-mac" });
  });
  it("is ready when the agent can work, even before the first hello", () => {
    expect(homeReadiness({ ...all, hello: false }, [helper()], [dev()])).toMatchObject({ kind: "ready" });
  });
});

describe("helperChecklist", () => {
  it("checks the host install unless the agent is placed in a computer", () => {
    const devices = [dev({ harnesses: [{ id: "gemini", version: "1" }] })];
    expect(helperChecklist([helper({ harness: "claude-code", settings: { runIn: "device" }, computerId: null })], devices).at(-1)?.status).toBe("bad");
    expect(helperChecklist([helper({ harness: "claude-code", settings: { runIn: "computer" }, computerId: "vm" })], devices).find((c) => c.id === "harness")?.status).toBe("ok");
  });

  const status = (c: ReturnType<typeof helperChecklist>) => c.map((x) => `${x.id}:${x.status}`);
  it("starts with making an agent", () => {
    const c = helperChecklist([], [dev()]);
    expect(status(c)).toEqual(["helper:bad", "device:unknown", "online:unknown", "harness:unknown"]);
    expect(c[0].to).toEqual({ view: "welcome" });
  });
  it("points an agent with no device at its device settings", () => {
    const c = helperChecklist([helper({ nodeId: null })], [dev()]);
    expect(status(c)).toEqual(["helper:ok", "device:bad", "online:unknown", "harness:unknown"]);
    expect(c[1].to).toEqual({ view: "agents", agentId: "a1", tab: "device" });
  });
  it("names an offline or paused device and links to Devices", () => {
    const c = helperChecklist([helper()], [dev({ online: false })]);
    expect(status(c)).toEqual(["helper:ok", "device:ok", "online:bad", "harness:unknown"]);
    expect(c[2].fix).toContain("Turn on my-mac");
    expect(c[2].to).toEqual({ view: "computers", computerId: null });
    expect(helperChecklist([helper()], [dev({ paused: true })])[2].fix).toContain("paused");
  });
  it("only calls the AI missing when the device reported what it has", () => {
    expect(helperChecklist([helper()], [dev()])[3].status).toBe("unknown");
    expect(helperChecklist([helper()], [dev({ harnesses: [{ id: "gemini", version: "1" }] })])[3].status).toBe("ok");
    const missing = helperChecklist([helper()], [dev({ harnesses: [{ id: "codex", version: null }] })])[3];
    expect(missing).toMatchObject({ status: "bad", to: { view: "agents", agentId: "a1", tab: "model" } });
  });
  it("doesn't call a device missing while devices are still loading", () => {
    expect(status(helperChecklist([helper()], null))).toEqual(["helper:ok", "device:unknown", "online:unknown", "harness:unknown"]);
  });
});
