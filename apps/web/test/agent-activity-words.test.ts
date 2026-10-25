import { describe, expect, it } from "vitest";
import { activityPhrase, minutesSince, workKind, workSteps, workSummary } from "../src/components/agentActivity.ts";

describe("plain words for what an agent is doing", () => {
  it("names the current tool in a few plain words", () => {
    expect(activityPhrase("mcp__wisp__memory_search")).toBe("searching memory");
    expect(activityPhrase("mcp__wisp__computer_click")).toBe("using its computer");
    expect(activityPhrase("Edit")).toBe("editing files");
    expect(activityPhrase("apply_patch")).toBe("editing files");
    expect(activityPhrase("WebSearch")).toBe("searching the web");
    expect(activityPhrase("WebFetch")).toBe("browsing");
    expect(activityPhrase("Bash")).toBe("running a command");
    expect(activityPhrase(null)).toBe("thinking");
    expect(activityPhrase(null, true)).toBe("writing a reply");
    expect(workKind("something_unknown")).toBe("other");
  });

  it("folds repeated work into steps, the last one live", () => {
    const steps = workSteps(["Read", "Read", "Edit", "mcp__wisp__memory_search"], true);
    expect(steps.map((s) => s.text)).toEqual(["Read 2 files", "Edited files", "Searching memory"]);
    expect(steps.map((s) => s.now)).toEqual([false, false, true]);
    expect(workSteps([], true)).toEqual([]);
  });

  it("sums up a finished reply in one line", () => {
    const fetches = Array.from({ length: 6 }, () => ({ name: "WebFetch" }));
    expect(workSummary([{ name: "WebSearch" }, ...fetches])).toBe("Searched the web · read 6 pages");
    expect(workSummary([{ name: "Edit", input: { file_path: "a.ts" } }, { name: "Edit", input: { file_path: "a.ts" } }, { name: "Edit", input: { file_path: "b.ts" } }])).toBe("Edited 2 files");
    expect(workSummary([{ name: "Read" }, { name: "Edit" }, { name: "Bash" }, { name: "WebSearch" }, { name: "x" }])).toBe("Read 1 file · edited 1 file · ran a command · +2 more");
    expect(workSummary([])).toBe("");
  });

  it("says how long it has been working", () => {
    expect(minutesSince(0, 30_000)).toBe("just now");
    expect(minutesSince(0, 12 * 60_000)).toBe("12 min");
    expect(minutesSince(0, 75 * 60_000)).toBe("1 h 15 min");
  });
});
