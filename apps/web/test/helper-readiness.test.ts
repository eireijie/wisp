import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@warren/core";
import type { DeviceInfo } from "../src/devices.ts";
import { helperChecklist, homeReadiness, nextStep, pickHelper } from "../src/onboarding.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const dev = (o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id: "n1", name: "my-mac", online: true, agents: [], ...o });
const helper = (o: Partial<Agent> = {}) => ({ id: "a1", name: "Everyday Helper", nodeId: "n1", harness: "gemini", ...o }) as Agent;
const none = { anywhere: true, device: false, role: false, agent: false, harness: false, hello: false };
const all = { anywhere: true, device: true, role: true, agent: true, harness: true, hello: true };

describe("nextStep", () => {
  it("names the first unmet step, or null when done", () => {
    expect(nextStep(none)).toBe("device");
    // Tailscale comes first, before any device
    expect(nextStep({ ...none, anywhere: false })).toBe("anywhere");
    expect(nextStep({ ...all, hello: false })).toBe("hello");
    expect(nextStep(all)).toBeNull();
  });
});

describe("pickHelper", () => {
  it("prefers a ready helper over an offline one", () => {
    const off = helper({ id: "off", nodeId: "n2" });
    const ok = helper({ id: "ok" });
    expect(pickHelper([off, ok], [dev(), dev({ id: "n2", online: false })])?.id).toBe("ok");
    expect(pickHelper([], [dev()])).toBeNull();
  });
});

describe("homeReadiness", () => {
  it("asks to continue setup when there is no helper", () => {
    expect(homeReadiness({ ...none, device: true }, [], [dev()])).toEqual({ kind: "setup", next: "role" });
  });
  it("says what a helper is waiting for", () => {
    const r = homeReadiness(all, [helper()], [dev({ online: false })]);
    expect(r).toMatchObject({ kind: "waiting", problem: "my-mac is offline", deviceName: "my-mac" });
  });
  it("is ready when the helper can work, even before the first hello", () => {
    expect(homeReadiness({ ...all, hello: false }, [helper()], [dev()])).toMatchObject({ kind: "ready" });
  });
});

describe("helperChecklist", () => {
  const status = (c: ReturnType<typeof helperChecklist>) => c.map((x) => `${x.id}:${x.status}`);
  it("starts with making a helper", () => {
    const c = helperChecklist([], [dev()]);
    expect(status(c)).toEqual(["helper:bad", "device:unknown", "online:unknown", "harness:unknown"]);
    expect(c[0].to).toEqual({ view: "welcome" });
  });
  it("points a helper with no device at its device settings", () => {
    const c = helperChecklist([helper({ nodeId: null })], [dev()]);
    expect(status(c)).toEqual(["helper:ok", "device:bad", "online:unknown", "harness:unknown"]);
    expect(c[1].to).toEqual({ view: "agents", agentId: "a1", tab: "device" });
  });
  it("names an offline or paused device and links to Devices", () => {
    const c = helperChecklist([helper()], [dev({ online: false })]);
    expect(status(c)).toEqual(["helper:ok", "device:ok", "online:bad", "harness:unknown"]);
    expect(c[2].fix).toContain("Turn on my-mac");
    expect(c[2].to).toEqual({ view: "nodes" });
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
