import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@warren/core";
import { setupProgress, stepsDone, type OnboardingState } from "../src/onboarding.ts";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const empty: OnboardingState = { devices: [], computers: [], agents: [], firstReply: null, memoryNotes: [] };

describe("setup progress", () => {
  it("checks off a connected device, what it does for agents, and the first agent", () => {
    expect(Object.values(stepsDone(empty)).some(Boolean)).toBe(false);
    const offline = { ...empty, devices: [{ id: "n", name: "box", online: false, mine: true, role: null }] };
    expect(stepsDone(offline)).toMatchObject({ device: false, role: false });
    const set = { ...empty, devices: [{ id: "n", name: "box", online: true, mine: true, role: "vms" as const }], agents: [{ id: "a" } as Agent] };
    expect(stepsDone(set)).toEqual({ device: true, role: true, agent: true, harness: true, hello: false });
  });
});

describe("setupProgress", () => {
  it("counts finished steps and says when setup is complete", () => {
    expect(setupProgress(stepsDone(empty))).toEqual({ progress: 0, steps: 5, complete: false });
    expect(setupProgress({ device: true, role: true, agent: true, harness: true, hello: true })).toMatchObject({ progress: 5, complete: true });
  });
});
