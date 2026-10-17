import { describe, expect, it, vi } from "vitest";

// the settings pages read browser state when their modules load; the list itself doesn't need it
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, THEMES: [], useAppearance: () => ({}) }));
const { settingsNav } = await import("../src/views/SettingsView.tsx");
const ids = (groups: ReturnType<typeof settingsNav>) => groups.map((g) => [g.group, g.pages.map((p) => p.id)]);

describe("settings navigation", () => {
  it("keeps every page in place in Advanced", () => {
    const groups = settingsNav(false, false);
    expect(groups.map((g) => g.group)).toEqual(["Account", "Workspace"]);
    expect(groups[1].pages.map((p) => p.id)).toContain("runtimes");
    expect(groups[1].pages.map((p) => p.id)).toContain("connections");
  });

  it("moves agent runtimes and connections under Advanced at the bottom in Simple", () => {
    expect(ids(settingsNav(true, false)).slice(1)).toEqual([
      ["Workspace", ["general", "people", "agents", "memory", "computers", "data", "updates"]],
      ["Advanced", ["runtimes", "connections"]],
    ]);
  });

  it("leaves out pages guests can't use, and the empty Advanced group with them", () => {
    const groups = settingsNav(true, true);
    expect(groups.map((g) => g.group)).toEqual(["Account", "Workspace"]);
    expect(groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain("agents");
  });
});
