import { describe, expect, it } from "vitest";
import { agentsOnDevice, whoCanAsk } from "../src/devices.ts";
import { noChartLine } from "../src/components/channel-rules.ts";

const agent = (settings: object = {}, computerId: string | null = null) => ({ harness: "codex", settings, computerId }) as Parameters<typeof whoCanAsk>[0];

describe("whoCanAsk", () => {
  it("says what's enforced: a private device answers only its owner until opened up", () => {
    expect(whoCanAsk(agent({ respondTo: "anyone" }), { shared: false })).toBe("me");
    expect(whoCanAsk(agent({ respondTo: "anyone", anyoneCanAsk: true }), { shared: false })).toBe("anyone");
    expect(whoCanAsk(agent({ respondTo: "people" }), { shared: true })).toBe("people");
  });
  it("isn't limited by the device when it works inside its own computer", () => {
    expect(whoCanAsk(agent({ respondTo: "anyone", runIn: "computer" }, "vm"), { shared: false })).toBe("anyone");
  });
});

describe("the same count everywhere", () => {
  it("counts agents by where they run, with or without a computer", () => {
    expect(agentsOnDevice([{ nodeId: "a" }, { nodeId: "a" }, { nodeId: "b" }, { nodeId: null }], "a")).toHaveLength(2);
  });
  it("doesn't say a team with agents has nobody", () => {
    expect(noChartLine(0)).toBe("No agents here yet");
    expect(noChartLine(4)).toContain("Its 4 agents answer");
  });
});
