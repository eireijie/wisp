import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@wisp/core";
import { completeSetupStep, isLocalOnlyHost, nextStep, savedSetup, setupProgress, stepsDone, type OnboardingState } from "../src/onboarding.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));
afterEach(() => vi.unstubAllGlobals());
const empty: OnboardingState = { devices: [], computers: [], agents: [], firstReply: null, memoryNotes: [] };

describe("four-step setup progress", () => {
  it("tracks choices separately from agent and reach readiness", () => {
    expect(stepsDone(empty)).toEqual({ ready: false, agent: false, anywhere: false, devices: false });
    expect(stepsDone({ ...empty, agents: [{ id: "a" } as Agent], reachable: true })).toEqual({ ready: false, agent: true, anywhere: true, devices: false });
    expect(stepsDone(empty, { ready: true, agent: true, anywhere: true })).toEqual({ ready: true, agent: true, anywhere: true, devices: false });
    expect(nextStep(stepsDone(empty, { ready: true, agent: true }))).toBe("anywhere");
  });
  it("counts all four decisions including explicit skips", () => {
    expect(setupProgress(stepsDone(empty))).toEqual({ progress: 0, steps: 4, complete: false });
    const done = stepsDone(empty, { ready: true, agent: true, anywhere: true, devices: true });
    expect(setupProgress(done)).toEqual({ progress: 4, steps: 4, complete: true });
    expect(nextStep(done)).toBeNull();
  });
  it("persists progress per workspace and tolerates unavailable browser storage", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    completeSetupStep("one", "ready");
    completeSetupStep("one", "agent");
    expect(savedSetup("one")).toEqual({ ready: true, agent: true });
    expect(savedSetup("two")).toEqual({});
    storage.set("wisp.setup.v2.two", "bad-json");
    expect(savedSetup("two")).toEqual({});
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
    expect(() => completeSetupStep("one", "ready")).not.toThrow();
    expect(savedSetup("one")).toEqual({});
  });
});
describe("isLocalOnlyHost", () => {
  it("flags addresses that only work on this computer", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.255", "::1", "[::1]", " LOCALHOST "]) expect(isLocalOnlyHost(h)).toBe(true);
    for (const h of ["wisp.example.com", "192.168.1.20", "", "localhost.example.com", "127.0.0.1.example.com", "127.0.0.999", "127.", "::1.example.com", "[::1", "::1]"]) expect(isLocalOnlyHost(h)).toBe(false);
  });
});
