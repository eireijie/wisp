import { describe, expect, it } from "vitest";
import { projectName } from "../src/memory-import.ts";

describe("projectName", () => {
  it("puts every line about one project under one name", () => {
    expect(projectName("Wisp: an agents app")).toBe("Wisp");
    expect(projectName("Wisp, formerly Warren, provides agents")).toBe("Wisp");
    expect(projectName("Wisp's immediate work is fixing sign-in")).toBe("Wisp");
    expect(projectName("Wisp lives in /Users/me/kodi")).toBe("Wisp");
    expect(projectName("Hotel Reconciliation Center's documented Windows run")).toBe("Hotel Reconciliation Center");
    expect(projectName("Instant Tracker manages scratch-off inventory")).toBe("Instant Tracker");
    expect(projectName("Garden sensor - a Pi in the shed")).toBe("Garden sensor");
  });
  it("gives none for a line that names nothing", () => {
    expect(projectName("next step is shipping v1")).toBeNull();
  });
});
