import { describe, expect, it } from "vitest";
import { normalizeSteps, stepsProblem, type ChannelTeam, type TeamStep } from "@wisp/core";
import { agentRulesOf } from "../src/components/channel-rules.ts";
import { escapeAction } from "../src/team/escape.ts";
import { addStep, disconnecting, handoffCanWait, inputIds, insertingBetween, movingAfter, removingStep, stepById, stepProblems, updating } from "../src/team/flow.ts";

const step = (id: string, extra: Partial<TeamStep> = {}): TeamStep => ({ id, roleId: "", kind: "do", action: id, agentId: "nova", next: null, x: 0, y: 0, ...extra });
const team = (steps: TeamStep[]): ChannelTeam => ({ nodes: [], edges: [], roles: [], steps: normalizeSteps(steps) });
const agents = [{ id: "nova", harness: "claude-code" }];

/** check -> (yes) build, (no) stop */
const branching = () => team([step("check", { kind: "branch", condition: "Did it pass?", ifTrue: "build", ifFalse: "stop" }), step("build"), step("stop")]);

describe("review fixes: if/else arrows", () => {
  it("inserting a step on the Yes arrow keeps Yes going through it", () => {
    const t = insertingBetween(branching(), step("approve", { kind: "ask", agentId: null }), ["check"], ["build"]);
    const c = stepById(t, "check")!;
    expect(c.ifTrue).toBe("approve");
    expect(c.ifFalse).toBe("stop");
    expect(stepById(t, "approve")!.nexts).toEqual(["build"]);
    expect(stepProblems(t).lines).toEqual([]);
  });

  it("adding a step after an if/else routes every outcome through it", () => {
    const { team: t, id } = addStep(branching(), "agent", { after: "check" }, agents);
    const c = stepById(t, "check")!;
    expect([c.ifTrue, c.ifFalse]).toEqual([id, id]);
  });

  it("changing Yes leaves No alone when both went to the same step", () => {
    let t = team([step("check", { kind: "branch", condition: "ok?", ifTrue: "finish", ifFalse: "finish" }), step("finish"), step("other")]);
    // what StepForm.setBranch does: the shared arrow stays, only Yes moves
    t = updating(t, "check", { ifTrue: "other" });
    expect(stepById(t, "check")).toMatchObject({ ifTrue: "other", ifFalse: "finish" });
    // not shared: the old arrow is cut
    t = updating(disconnecting(t, "check", "other"), "check", { ifTrue: "finish" });
    expect(inputIds(stepById(t, "other")!)).toEqual([]);
  });

  it("removing the step Yes pointed at sends Yes to what followed it", () => {
    const t = removingStep(team([step("check", { kind: "branch", condition: "ok?", ifTrue: "mid", ifFalse: null }), step("mid", { nexts: ["end"] }), step("end")]), "mid");
    expect(stepById(t, "check")!.ifTrue).toBe("end");
  });
});

describe("review fixes: reordering", () => {
  it("moving a step keeps send-backs and if/else arrows that point at it", () => {
    const base = team([step("a", { nexts: ["b"] }), step("b", { nexts: ["review"] }), step("review", { kind: "review", sendBackTo: "a" })]);
    const moved = movingAfter(base, "a", "b");
    expect(moved.steps!.map((s) => s.id).sort()).toEqual(["a", "b", "review"]);
    expect(stepById(moved, "review")!.sendBackTo).toBe("a");
    expect(stepsProblem(moved)).toBeNull();
    expect(stepProblems(moved).lines).toEqual([]);

    const gate = team([step("a", { nexts: ["b"] }), step("b", { nexts: ["c"] }), step("c", { kind: "branch", condition: "ok?", ifTrue: "a", ifFalse: null })]);
    expect(stepById(movingAfter(gate, "a", "b"), "c")!.ifTrue).toBe("a");
  });
});

describe("review fixes: other", () => {
  it("only a team with steps can answer a hand-off", () => {
    expect(handoffCanWait(undefined)).toBe(true);
    expect(handoffCanWait({ settings: { team: null } })).toBe(false);
    expect(handoffCanWait({ settings: { team: { steps: [] } } })).toBe(false);
    expect(handoffCanWait({ settings: { team: { steps: [step("a")] } } })).toBe(true);
  });

  it("the agents form sends only what it owns, never the team's flow", () => {
    const settings = { defaultAgentId: "nova", replyInThread: true, instructions: "hi", team: team([step("a")]) };
    expect(agentRulesOf(settings)).toEqual({ defaultAgentId: "nova", replyInThread: true, instructions: "hi" });
  });

  it("Escape in the builder asks before dropping edits", () => {
    expect(escapeAction({ discarding: false, changed: true })).toBe("ask");
    expect(escapeAction({ discarding: false, changed: false })).toBe("leave");
    expect(escapeAction({ discarding: true, changed: true })).toBe("keep-editing");
  });

  it("Escape in a dialog opened over the builder (New agent) is left to that dialog", () => {
    expect(escapeAction({ discarding: false, changed: true, nested: true })).toBe("defer");
    expect(escapeAction({ discarding: false, changed: false, nested: true })).toBe("defer");
    expect(escapeAction({ discarding: true, changed: true, nested: true })).toBe("keep-editing");
  });
});
