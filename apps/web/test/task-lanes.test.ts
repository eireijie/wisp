import { describe, expect, it } from "vitest";
import { closedLanes } from "../src/views/task-lanes.ts";

describe("closedLanes", () => {
  it("keeps failed tasks out of Done, and cancelled ones out of Failed", () => {
    const lanes = closedLanes([{ status: "done" }, { status: "failed", result: "It crashed" }, { status: "failed", result: "Cancelled by you." }]);
    expect(lanes.failed.map((t) => t.result)).toEqual(["It crashed"]);
    expect(lanes.done).toHaveLength(2);
  });
  it("has nothing in Failed when nothing failed, so the column goes away", () => {
    expect(closedLanes([{ status: "done" }]).failed).toEqual([]);
  });
});
