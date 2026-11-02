import { describe, expect, it } from "vitest";
import { teamIconAgentIds } from "../src/teams.ts";

const node = (agentId: string, lead = false) => ({ agentId, lead, x: 0, y: 0 });
const settings = (nodes: ReturnType<typeof node>[]) => ({ defaultAgentId: null, replyInThread: false, instructions: "", team: { nodes, edges: [] } });

describe("teamIconAgentIds", () => {
  it("puts the lead first, then the rest of the chart", () => {
    expect(teamIconAgentIds({ settings: settings([node("cy"), node("atlas", true), node("nova")]) })).toEqual(["atlas", "cy", "nova"]);
  });

  it("uses the agents in the channel when the chart doesn't name them", () => {
    const plain = { defaultAgentId: null, replyInThread: false, instructions: "", team: null };
    expect(teamIconAgentIds({ settings: plain, agentIds: ["atlas", "nova"] })).toEqual(["atlas", "nova"]);
  });

  it("fills up from the channel after the chart, without repeating anyone", () => {
    expect(teamIconAgentIds({ settings: settings([node("nova", true)]), agentIds: ["atlas", "nova"] })).toEqual(["nova", "atlas"]);
  });

  it("is empty when nobody is on the team", () => {
    expect(teamIconAgentIds({ settings: settings([]) })).toEqual([]);
  });
});
