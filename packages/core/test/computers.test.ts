import { describe, expect, it } from "vitest";
import { describeCron, fitInto, nextRun, parseCron, parseKeys, readTunnelFrame, toScreen, tunnelFrame, x11Combo, cronMatches, zonedParts } from "../src/index.ts";

describe("keys", () => {
  it("normalizes combos the way agents write them", () => {
    expect(parseKeys("cmd+shift+T")).toEqual({ mods: ["meta", "shift"], key: "t" });
    expect(parseKeys("ctrl-c")).toEqual({ mods: ["ctrl"], key: "c" });
    expect(parseKeys("Return")).toEqual({ mods: [], key: "Enter" });
    expect(parseKeys("ctrl++")).toEqual({ mods: ["ctrl"], key: "+" });
    expect(parseKeys("shift")).toEqual({ mods: [], key: "Shift" });
    expect(parseKeys("alt+F4")).toEqual({ mods: ["alt"], key: "F4" });
    expect(parseKeys("A")).toEqual({ mods: [], key: "A" });
    expect(() => parseKeys("ctrl+banana")).toThrow(/unknown key/);
    expect(() => parseKeys("foo+c")).toThrow(/isn't ctrl/);
  });

  it("writes X11 combos", () => {
    expect(x11Combo(parseKeys("cmd+l"))).toBe("super+l");
    expect(x11Combo(parseKeys("ctrl+PageDown"))).toBe("ctrl+Next");
    expect(x11Combo(parseKeys("Enter"))).toBe("Return");
  });
});

describe("screen space", () => {
  it("fits screenshots into a box without upscaling, and maps clicks back", () => {
    expect(fitInto(2940, 1912)).toEqual({ width: 1230, height: 800 });
    expect(fitInto(800, 600)).toEqual({ width: 800, height: 600 });
    expect(toScreen(615, 400, { width: 1230, height: 800 }, { width: 1470, height: 956 })).toEqual({ x: 735, y: 478 });
    expect(toScreen(10, 20, undefined, { width: 1, height: 1 })).toEqual({ x: 10, y: 20 });
  });

  it("frames tunnel bytes with their tunnel id", () => {
    const f = tunnelFrame("tun_abc", new Uint8Array([1, 2, 3]));
    expect(readTunnelFrame(f)).toEqual({ tunnelId: "tun_abc", payload: new Uint8Array([1, 2, 3]) });
    expect(readTunnelFrame(new Uint8Array([9, 1]))).toBeNull();
  });
});

describe("schedules", () => {
  it("parses and matches cron in a time zone", () => {
    const weekdays9 = parseCron("0 9 * * 1-5");
    // 2026-10-12 is a Monday; 13:00 UTC is 9:00 in New York
    expect(cronMatches(weekdays9, zonedParts(new Date("2026-10-12T13:00:00Z"), "America/New_York"))).toBe(true);
    expect(cronMatches(weekdays9, zonedParts(new Date("2026-10-12T13:00:00Z"), "UTC"))).toBe(false);
    expect(cronMatches(weekdays9, zonedParts(new Date("2026-10-11T13:00:00Z"), "America/New_York"))).toBe(false);
    expect(cronMatches(parseCron("*/15 * * * *"), { minute: 45, hour: 3, day: 1, month: 1, weekday: 0 })).toBe(true);
    expect(cronMatches(parseCron("0 0 * * 7"), { minute: 0, hour: 0, day: 4, month: 1, weekday: 0 })).toBe(true);
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
  });

  it("finds the next run and says it in words", () => {
    expect(nextRun("30 9 * * 1", "UTC", new Date("2026-10-11T12:00:00Z"))?.toISOString()).toBe("2026-10-12T09:30:00.000Z");
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 9am");
    expect(describeCron("30 17 * * *")).toBe("Every day at 5:30pm");
    expect(describeCron("0 8 * * 1")).toBe("Every Monday at 8am");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 10 1 * *")).toBe("On the 1st of every month at 10am");
  });
});
