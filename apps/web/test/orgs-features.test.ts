import { describe, expect, it, vi } from "vitest";
import { FEATURE_KEYS, FEATURE_PRESETS } from "@warren/core";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));
const { inviteCode, orgInitials, orgSummary, orgTone, ORG_TONES } = await import("../src/orgs.ts");
const { featurePreset, featuresIn, FEATURE_GROUPS } = await import("../src/features.ts");
const { featuresForExperience } = await import("../src/onboarding.ts");

describe("organizations", () => {
  it("reads the code from a pasted invite link or a bare code", () => {
    expect(inviteCode("https://warren.example/#/join/abc123")).toBe("abc123");
    expect(inviteCode("  http://localhost:7777/join/x-y_z?ref=1 ")).toBe("x-y_z");
    expect(inviteCode("https://warren.example/?code=q9")).toBe("q9");
    expect(inviteCode("plaincode")).toBe("plaincode");
  });

  it("says who's in it in plain words", () => {
    expect(orgSummary({ members: 1, agents: 4 })).toBe("Just you · 4 agents");
    expect(orgSummary({ members: 3, agents: 1 })).toBe("3 people · 1 agent");
  });

  it("makes short initials and a stable tile color", () => {
    expect(orgInitials("Acme Studio")).toBe("AS");
    expect(orgInitials("weekend")).toBe("WE");
    const tone = orgTone("ws_abc");
    expect(tone).toBe(orgTone("ws_abc"));
    expect(tone).toBeGreaterThanOrEqual(1);
    expect(tone).toBeLessThanOrEqual(ORG_TONES);
  });
});

describe("features", () => {
  it("names the Quick start choice a set of features matches", () => {
    expect(featurePreset(FEATURE_PRESETS.simple)).toBe("simple");
    expect(featurePreset(FEATURE_PRESETS.everything)).toBe("everything");
    expect(featurePreset({ ...FEATURE_PRESETS.simple, voice: true })).toBe("custom");
  });

  it("puts every feature in exactly one group", () => {
    expect(FEATURE_GROUPS.flatMap((g) => featuresIn(g.id)).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("maps the onboarding choice to a preset", () => {
    expect(featuresForExperience("simple")).toEqual(FEATURE_PRESETS.simple);
    expect(featuresForExperience("advanced")).toEqual(FEATURE_PRESETS.everything);
  });
});
