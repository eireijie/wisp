import { describe, expect, it, vi } from "vitest";
import { backgroundSummary } from "../src/views/AgentBackground.tsx";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const base = { name: "Everyday Helper", scope: "", everyMinutes: 60, dailyCap: 24, enabled: true };

describe("backgroundSummary", () => {
  it("says what it does when on", () => {
    expect(backgroundSummary({ ...base, scope: "my inbox and calendar" })).toBe(
      "While you're away, Everyday Helper will check my inbox and calendar every hour, at most 24 times a day, and message you when something needs you.",
    );
  });
  it("uses everything it can reach without a focus, and ignores blank focus", () => {
    expect(backgroundSummary({ ...base, scope: "   " })).toContain("check everything it can reach every hour");
    expect(backgroundSummary({ ...base, scope: " my inbox. " })).toContain("check my inbox every hour");
  });
  it("describes a missing limit", () => {
    expect(backgroundSummary({ ...base, dailyCap: null })).toContain("every hour, with no daily limit, and message you");
  });
  it("uses the conditional when off", () => {
    expect(backgroundSummary({ ...base, enabled: false })).toBe(
      "If you turn this on, while you're away, Everyday Helper would check everything it can reach every hour, at most 24 times a day, and would message you when something needs you.",
    );
  });
  it("falls back for an unusual pace and a cap of one", () => {
    const s = backgroundSummary({ ...base, everyMinutes: 45, dailyCap: 1 });
    expect(s).toContain("every 45 minutes, at most 1 time a day");
  });
});
