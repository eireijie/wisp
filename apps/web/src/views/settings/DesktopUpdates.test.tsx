import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdate } from "../../desktop.ts";
import { describe as describeUpdate } from "./DesktopUpdates.tsx";

const u = (state: DesktopUpdate["state"], detail = ""): DesktopUpdate => ({ state, detail, version: "0.0.7", current: "0.0.6" });

vi.mock("../../components/ui.tsx", () => ({ Button: () => null, Pill: () => null }));
vi.mock("./parts.tsx", () => ({ Card: () => null, Row: () => null }));

describe("desktop update wording", () => {
  it("says what to do once an update is downloaded", () => {
    expect(describeUpdate(u("ready", "0.0.7")).hint).toMatch(/Restart Wisp/);
  });
  it("says the version when up to date", () => {
    expect(describeUpdate(u("current")).hint).toContain("0.0.6");
  });
  it("shows why an install can't update itself", () => {
    expect(describeUpdate(u("unsupported", "From source, use git pull.")).hint).toBe("From source, use git pull.");
    expect(describeUpdate(u("error", "GitHub said 500")).hint).toBe("GitHub said 500");
  });
  it("never sends people to a menu on another computer", () => {
    for (const s of ["idle", "checking", "downloading", "ready", "current", "unsupported", "error", "timed-out"] as const) expect(describeUpdate(u(s)).hint).not.toMatch(/menu/i);
  });
});
