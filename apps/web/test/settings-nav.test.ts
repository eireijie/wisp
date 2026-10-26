import { describe, expect, it, vi } from "vitest";
import { FEATURE_PRESETS } from "@wisp/core";

// the settings pages read browser state when their modules load; the list itself doesn't need it
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, THEMES: [], useAppearance: () => ({}) }));
const { settingsNav } = await import("../src/views/SettingsView.tsx");
const { SETTINGS_PAGES } = await import("../src/router.ts");
const ids = (sections: ReturnType<typeof settingsNav>) => sections.map((s) => [s.section, s.pages.map((p) => p.id)]);

describe("settings navigation", () => {
  it("keeps every page in seven sections, technical ones under Advanced", () => {
    expect(ids(settingsNav(false, FEATURE_PRESETS.everything))).toEqual([
      ["General", ["general", "profile", "preferences", "features"]],
      ["Usage", ["usage"]],
      ["People", ["people", "agents"]],
      ["Notifications", ["notifications", "voice"]],
      ["Appearance", ["appearance"]],
      ["Devices", ["devices", "computers", "logins", "mobile", "access"]],
      ["Advanced", ["agent-defaults", "memory", "apps", "runtimes", "harnesses", "connections", "security", "data", "updates"]],
    ]);
  });

  it("still opens every route (SETTINGS_PAGES) somewhere", () => {
    const pages = settingsNav(false, FEATURE_PRESETS.everything).flatMap((s) => s.pages.map((p) => p.id));
    expect([...pages].sort()).toEqual([...SETTINGS_PAGES].sort());
  });

  it("leaves out pages guests can't use", () => {
    const pages = settingsNav(true, FEATURE_PRESETS.everything).flatMap((s) => s.pages.map((p) => p.id));
    for (const id of ["agents", "agent-defaults", "computers", "logins", "apps", "runtimes", "connections"]) expect(pages).not.toContain(id);
  });

  it("hides pages for features that are off, and a section left empty", () => {
    const off = { ...FEATURE_PRESETS.everything, voice: false, invite: false, background: false };
    const nav = settingsNav(false, off);
    const pages = nav.flatMap((s) => s.pages.map((p) => p.id));
    expect(pages).not.toContain("voice");
    expect(pages).not.toContain("people");
    expect(pages).toContain("features");
    expect(nav.map((s) => s.section)).not.toContain("Usage");
  });
});

describe("agent settings navigation", () => {
  it("lists the sections, and every other tab opens from Edit, Computer or Remove", async () => {
    const { agentSections } = await import("../src/views/AgentSettings.tsx");
    const { AGENT_TABS } = await import("../src/router.ts");
    expect(agentSections()).toEqual(["overview", "model", "computer", "access", "routines", "background", "memory", "skills", "apps", "permissions", "connect", "runs", "look"]);
    expect(AGENT_TABS.filter((t) => !agentSections().includes(t))).toEqual(["soul", "instructions", "device", "remove"]);
  });
});
