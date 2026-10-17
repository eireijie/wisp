import { describe, expect, it, vi } from "vitest";
import { notifyStatus } from "../src/views/settings/account.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

describe("notifyStatus", () => {
  it("is On only when the browser allows it and it is switched on", () => {
    expect(notifyStatus("granted", true)).toMatchObject({ key: "on", label: "On" });
  });
  it("is Off when allowed but switched off", () => {
    expect(notifyStatus("granted", false)).toMatchObject({ key: "off", label: "Off" });
  });
  it("says the browser is blocking it and how to unblock, whatever the saved switch says", () => {
    for (const enabled of [true, false]) {
      const s = notifyStatus("denied", enabled);
      expect(s).toMatchObject({ key: "blocked", label: "Blocked by your browser" });
      expect(s.hint).toMatch(/settings/);
    }
  });
  it("says it has not asked yet before permission is requested", () => {
    expect(notifyStatus("default", false)).toMatchObject({ key: "ask", label: "Not asked yet" });
    expect(notifyStatus("default", true).key).toBe("ask");
  });
  it("explains unsupported browsers, with the iPhone Home Screen tip", () => {
    const s = notifyStatus("unsupported", true);
    expect(s).toMatchObject({ key: "unsupported", label: "Not available in this browser" });
    expect(s.hint).toMatch(/Home Screen/);
  });
});
