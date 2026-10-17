import { describe, expect, it, vi } from "vitest";
import { TEAM_TEMPLATES } from "@warren/core";
import { ROLE_CONTRIBUTIONS, roleContribution, slugifyName, teamShortName } from "../src/components/TeamBuilder.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

describe("slugifyName", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(slugifyName("  My Cool Team!! ")).toBe("my-cool-team");
    expect(slugifyName("a  --  b")).toBe("a-b");
    expect(slugifyName("***")).toBe("");
    expect(slugifyName("x".repeat(60))).toHaveLength(40);
  });
});

describe("teamShortName", () => {
  it("follows the name until the person edits it", () => {
    expect(teamShortName("Web Site", "", false)).toBe("web-site");
    expect(teamShortName("Web Site", "Docs Team", true)).toBe("docs-team");
  });
});

describe("roleContribution", () => {
  it("covers every template role", () => {
    for (const t of TEAM_TEMPLATES) for (const r of t.roles) expect(roleContribution(r.role), r.role).toBeTruthy();
    expect(ROLE_CONTRIBUTIONS["fact-checker"]).toBe("Checks facts");
  });
  it("falls back to the first sentence of the notes, or null", () => {
    expect(roleContribution("Custom", "Does a thing. And more.")).toBe("Does a thing.");
    expect(roleContribution("Custom")).toBeNull();
  });
});
