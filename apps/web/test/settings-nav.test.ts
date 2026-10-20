import { describe, expect, it, vi } from "vitest";
import { FEATURE_PRESETS } from "@warren/core";

// the settings pages read browser state when their modules load; the list itself doesn't need it
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, THEMES: [], useAppearance: () => ({}) }));
const { settingsNav } = await import("../src/views/SettingsView.tsx");
const ids = (groups: ReturnType<typeof settingsNav>) => groups.map((g) => [g.group, g.pages.map((p) => p.id)]);

describe("settings navigation", () => {
  it("keeps every page in place in Advanced, yours first, then the organization's", () => {
    const groups = settingsNav(false, false);
    expect(groups.map((g) => g.group)).toEqual(["You", "Organization"]);
    expect(groups[0].pages.map((p) => p.id)).toEqual(["profile", "preferences", "appearance", "notifications", "voice", "security", "mobile"]);
    expect(groups[1].pages.map((p) => p.id)).toEqual(["general", "agent-defaults", "agents", "computers", "memory", "apps", "features", "people", "runtimes", "connections", "data", "updates"]);
  });

  it("moves agent runtimes and connections under Advanced at the bottom in Simple", () => {
    expect(ids(settingsNav(true, false)).slice(1)).toEqual([
      ["Organization", ["general", "agent-defaults", "agents", "computers", "memory", "apps", "features", "people", "data", "updates"]],
      ["Advanced", ["runtimes", "connections"]],
    ]);
  });

  it("leaves out pages guests can't use, and the empty Advanced group with them", () => {
    const groups = settingsNav(true, true);
    expect(groups.map((g) => g.group)).toEqual(["You", "Organization"]);
    expect(groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain("agents");
    expect(groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain("agent-defaults");
  });

  it("hides Voice and People when their features are off", () => {
    const off = { ...FEATURE_PRESETS.everything, voice: false, invite: false };
    const pages = settingsNav(false, false, off).flatMap((g) => g.pages.map((p) => p.id));
    expect(pages).not.toContain("voice");
    expect(pages).not.toContain("people");
    expect(pages).toContain("features");
  });
});

describe("agent settings navigation", () => {
  it("groups the technical tabs under Advanced in Simple, and keeps every tab", async () => {
    const { agentNav } = await import("../src/views/AgentSettings.tsx");
    const simple = agentNav(true);
    expect(simple.map((g) => g.group)).toEqual(["Agent", "Runtime", "Activity", "Advanced"]);
    expect(simple.at(-1)!.items.map((i) => i.id)).toEqual(["model", "permissions", "connect", "background", "look"]);
    expect(simple.slice(0, 3).flatMap((g) => g.items.map((i) => i.id))).toEqual(["overview", "soul", "instructions", "device", "computer", "routines", "runs"]);
    expect(agentNav(false).flatMap((g) => g.items).length).toBe(simple.flatMap((g) => g.items).length);
  });
});
