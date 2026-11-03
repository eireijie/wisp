import { describe, expect, it, vi } from "vitest";
import { FEATURE_PRESETS } from "@wisp/core";

// the settings pages read browser state when their modules load; the list itself doesn't need it
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, THEMES: [], useAppearance: () => ({}) }));
const { settingsNav, settingsLinks } = await import("../src/views/SettingsView.tsx");
const { SETTINGS_PAGES } = await import("../src/router.ts");
const ids = (sections: ReturnType<typeof settingsNav>) => sections.map((s) => [s.section, s.pages.map((p) => p.id)]);

describe("settings navigation", () => {
  it("groups every page under You, Workspace, Agents, Devices and More", () => {
    expect(ids(settingsNav(false, FEATURE_PRESETS.everything))).toEqual([
      ["You", ["profile", "notifications", "appearance", "preferences", "voice", "security"]],
      ["Workspace", ["general", "people", "usage"]],
      ["Agents", ["agents", "agent-defaults", "models", "harnesses", "runtimes", "logins", "apps", "skills", "connections", "memory"]],
      ["Devices", ["devices", "computers", "access", "mobile"]],
      ["More", ["data", "updates"]],
    ]);
  });

  it("keeps the places that do things (Memory, Tasks, Marketplace, Mods, Help) out of Settings", () => {
    const labels = settingsNav(false, FEATURE_PRESETS.everything).flatMap((s) => [...s.pages.map((p) => p.label), ...settingsLinks(s.section, false, FEATURE_PRESETS.everything).map((l) => l.label)]);
    for (const l of ["Tasks", "Marketplace", "Mods", "Help"]) expect(labels).not.toContain(l);
    expect(settingsLinks("You", false, FEATURE_PRESETS.everything)).toEqual([]);
  });

  it("still opens every route (SETTINGS_PAGES) somewhere", () => {
    // Everything leaves out mods that need setting up first (Storage); with every mod on, every page shows
    const pages = settingsNav(false, { ...FEATURE_PRESETS.everything, storage: true }).flatMap((s) => s.pages.map((p) => p.id));
    expect([...pages].sort()).toEqual([...SETTINGS_PAGES].sort());
  });

  it("leaves out pages guests can't use", () => {
    const pages = settingsNav(true, FEATURE_PRESETS.everything).flatMap((s) => s.pages.map((p) => p.id));
    for (const id of ["agents", "agent-defaults", "computers", "logins", "apps", "skills", "runtimes", "connections", "voice", "people", "general"]) expect(pages).not.toContain(id);
  });

  it("hides pages for features that are off, and a section left empty", () => {
    const off = { ...FEATURE_PRESETS.everything, voice: false, invite: false, background: false };
    const nav = settingsNav(false, off);
    const pages = nav.flatMap((s) => s.pages.map((p) => p.id));
    expect(pages).not.toContain("voice");
    expect(pages).not.toContain("people");
    expect(pages).not.toContain("usage");
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
