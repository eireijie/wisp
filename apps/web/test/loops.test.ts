import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api.ts", () => ({ api: vi.fn(() => new Promise(() => {})), uploadFile: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => false }));
import { loopLine, reminderTimes, whenText } from "../src/components/Loops.tsx";

const local = (days: number, h: number, m = 0) => {
  const d = new Date(2026, 9, 27, h, m);
  d.setDate(d.getDate() + days);
  return d;
};

describe("reminder times", () => {
  it("reads like a person would say it", () => {
    const now = local(0, 16, 12);
    expect(whenText(local(0, 16, 35).toISOString(), now, "12h")).toBe("4:35 PM");
    expect(whenText(local(0, 20).toISOString(), now, "12h")).toBe("8 PM");
    expect(whenText(local(1, 9).toISOString(), now, "12h")).toBe("Tomorrow 9 AM");
    expect(whenText(local(4, 10).toISOString(), now, "12h")).toBe(local(4, 10).toLocaleDateString([], { weekday: "short" }));
    expect(whenText(local(10, 10).toISOString(), now, "12h")).toBe(local(10, 10).toLocaleDateString([], { month: "short", day: "numeric" }));
  });

  it("offers tonight only while it's still ahead", () => {
    expect(reminderTimes(local(0, 16)).map((t) => t.label)).toEqual(["In 1 hour", "Tonight", "Tomorrow morning"]);
    expect(reminderTimes(local(0, 21)).map((t) => t.label)).toEqual(["In 1 hour", "Tomorrow morning"]);
    expect(reminderTimes(local(0, 16))[2].at).toEqual(local(1, 9));
  });
});

describe("a DM's line in the chat list", () => {
  it("says when it waits on you, else when its agent will be back", () => {
    expect(loopLine({ loop: { status: "waiting", summary: "send Sam the deck" } })).toMatchObject({ tone: "warn", text: "Waiting on you · send Sam the deck" });
    const soon = new Date(Date.now() + 20 * 60_000);
    const line = loopLine({ loop: null, next: { label: "Check the build", dueAt: soon.toISOString(), waitingOn: "agent" } }, "12h");
    // later today reads "Back at 4:35"; past midnight, "Back Tomorrow 12:05 AM"
    expect(line?.text).toMatch(/^Back (at \d|Tomorrow).* · Check the build$/);
    // the person's own promises don't count as the agent coming back
    expect(loopLine({ loop: null, next: { label: "Nudge you about the deck", dueAt: soon.toISOString(), waitingOn: "person" } })).toBeNull();
    expect(loopLine({ loop: { status: "done", summary: "" } })).toBeNull();
  });
});
