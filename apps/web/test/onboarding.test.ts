import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@warren/core";
import { isLocalOnlyHost, setupProgress, stepsDone, type OnboardingState } from "../src/onboarding.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const empty: OnboardingState = { devices: [], computers: [], agents: [], firstReply: null, memoryNotes: [] };

describe("setup progress", () => {
  it("checks off a connected device, what it does for agents, and the first agent", () => {
    expect(Object.values(stepsDone(empty)).some(Boolean)).toBe(false);
    const offline = { ...empty, devices: [{ id: "n", name: "box", online: false, mine: true, role: null }] };
    expect(stepsDone(offline)).toMatchObject({ device: false, role: false });
    const set = { ...empty, devices: [{ id: "n", name: "box", online: true, mine: true, role: "vms" as const }], agents: [{ id: "a" } as Agent] };
    expect(stepsDone(set)).toEqual({ anywhere: false, device: true, role: true, agent: true, harness: true, hello: false });
    // reachable from anywhere once Tailscale serves the hub
    expect(stepsDone({ ...set, reachable: true }).anywhere).toBe(true);
  });
});

describe("setupProgress", () => {
  it("counts finished steps and says when setup is complete", () => {
    expect(setupProgress(stepsDone(empty))).toEqual({ progress: 0, steps: 6, complete: false });
    expect(setupProgress({ anywhere: true, device: true, role: true, agent: true, harness: true, hello: true })).toMatchObject({ progress: 6, complete: true });
  });
});

describe("isLocalOnlyHost", () => {
  it("flags addresses that only work on this computer", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.255", "::1", "[::1]", " LOCALHOST "]) expect(isLocalOnlyHost(h)).toBe(true);
    for (const h of ["warren.example.com", "192.168.1.20", "", "localhost.example.com", "127.0.0.1.example.com", "127.0.0.999", "127.", "::1.example.com", "[::1", "::1]"]) expect(isLocalOnlyHost(h)).toBe(false);
  });
});
