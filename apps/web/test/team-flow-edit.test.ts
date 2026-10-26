import { describe, expect, it } from "vitest";
import { TEAM_TEMPLATES, describeFlow, stepsProblem, type ChannelTeam, type TeamStep } from "@wisp/core";
import { ADD_KINDS, addStep, connecting, disconnecting, emptyTeam, fillTemplate, fromCanvas, inputIds, movingAfter, numberOf, relayout, removingStep, retype, settingInputs, stepProblems, stepRows, toCanvas, updating } from "../src/team/flow.ts";

const agents = [
  { id: "nova", harness: "claude-code" },
  { id: "ghosty", harness: "codex" },
  { id: "pappy", harness: "kimi" },
];

/** Two steps side by side, a join, and an ask-me at the end. */
function sample(): ChannelTeam {
  let t = emptyTeam();
  t = addStep(t, "agent", {}, agents).team;
  const first = t.steps![0].id;
  const beside = addStep(t, "beside", { after: first }, agents);
  t = beside.team;
  const join = addStep(t, "agent", { between: { from: [first, beside.id], to: [] } }, agents);
  t = join.team;
  const ask = addStep(t, "ask", { after: join.id }, agents);
  return ask.team;
}

describe("editing a team's flow", () => {
  it("starts empty and adds a first step", () => {
    const { team, id } = addStep(emptyTeam(), "agent", {}, agents);
    expect(team.steps).toHaveLength(1);
    expect(team.steps![0]).toMatchObject({ id, kind: "do", agentId: "nova" });
  });

  it("builds a parallel pair, a join and an ask-me step with arrows that agree", () => {
    const t = sample();
    const rows = stepRows(t.steps!);
    expect(rows.map((r) => r.length)).toEqual([2, 1, 1]);
    const [a, b] = rows[0];
    const join = rows[1][0];
    expect(inputIds(join).sort()).toEqual([a.id, b.id].sort());
    expect(a.nexts).toEqual([join.id]);
    expect(b.nexts).toEqual([join.id]);
    expect(rows[2][0].kind).toBe("ask");
    expect(stepsProblem(t)).toBeNull();
  });

  it("says a step 'goes round' only when there is no way out", () => {
    let t = sample();
    const [a] = stepRows(t.steps!)[0];
    const ask = stepRows(t.steps!)[2][0];
    t = connecting(t, ask.id, a.id);
    expect(stepsProblem(t)).toMatch(/circle/);
  });

  it("removing a step joins what led to it to what followed it", () => {
    const t = sample();
    const join = stepRows(t.steps!)[1][0];
    const after = removingStep(t, join.id);
    const [a, b] = stepRows(t.steps!)[0];
    const ask = stepRows(t.steps!)[2][0];
    expect(after.steps).toHaveLength(3);
    expect(after.steps!.find((s) => s.id === a.id)!.nexts).toEqual([ask.id]);
    expect(after.steps!.find((s) => s.id === b.id)!.nexts).toEqual([ask.id]);
  });

  it("sets which steps a step uses, and numbers steps in the order they happen", () => {
    let t = sample();
    const [a, b] = stepRows(t.steps!)[0];
    const join = stepRows(t.steps!)[1][0];
    t = settingInputs(t, join.id, [a.id]);
    expect(inputIds(t.steps!.find((s) => s.id === join.id)!)).toEqual([a.id]);
    expect(t.steps!.find((s) => s.id === b.id)!.nexts).toEqual([]);
    expect(numberOf(t, join.id)).toBeGreaterThan(numberOf(t, a.id));
    t = disconnecting(t, a.id, join.id);
    expect(inputIds(t.steps!.find((s) => s.id === join.id)!)).toEqual([]);
  });

  it("moves a step after another", () => {
    const t = sample();
    const rows = stepRows(t.steps!);
    const ask = rows[2][0];
    const moved = movingAfter(t, ask.id, null);
    expect(stepRows(moved.steps!)[0][0].id).toBe(ask.id);
    expect(moved.steps).toHaveLength(t.steps!.length);
  });

  it("a repeat step needs somewhere to send work back", () => {
    let t = sample();
    const last = stepRows(t.steps!)[2][0];
    const added = addStep(t, "review", { after: last.id }, agents);
    t = added.team;
    expect(t.steps!.find((s) => s.id === added.id)).toMatchObject({ kind: "review", sendBackTo: last.id, maxRounds: 3 });
    expect(stepProblems(updating(t, added.id, { sendBackTo: null })).lines[0]).toMatch(/sends work back/);
  });

  it("changes the kind of a step with the fields the new kind needs", () => {
    let t = addStep(emptyTeam(), "agent", {}, agents).team;
    t = addStep(t, "agent", {}, agents).team;
    const second = t.steps![1].id;
    const r = retype(t, second, "review", agents);
    expect(r.steps!.find((s) => s.id === second)).toMatchObject({ kind: "review", maxRounds: 3 });
    const h = retype(t, second, "handoff", agents);
    expect(stepProblems(h).byStep.get(second)).toMatch(/hands the work to/);
  });

  it("lists a problem for each step that has one", () => {
    let t = addStep(emptyTeam(), "agent", {}, []).team;
    const id = t.steps![0].id;
    expect(stepProblems(t).byStep.get(id)).toMatch(/Pick an agent/);
    t = updating(t, id, { agentId: "nova" });
    expect(stepProblems(t).lines).toEqual([]);
  });

  it("every kind can be added", () => {
    for (const { kind } of ADD_KINDS) {
      const base = addStep(emptyTeam(), "agent", {}, agents).team;
      const { team, id } = addStep(base, kind, { after: base.steps![0].id }, agents);
      expect(team.steps!.some((s: TeamStep) => s.id === id)).toBe(true);
    }
  });

  it("fills a template with agents, one per step, on the harness it suggests", () => {
    const t = TEAM_TEMPLATES[0];
    const team = fillTemplate(t, agents);
    expect(stepsProblem(team)).toBeNull();
    expect(team.steps!.every((s) => s.roleId === "")).toBe(true);
    expect(team.nodes.length).toBeGreaterThan(0);
    expect(describeFlow(team, (id) => id ?? "Someone").length).toBe(team.steps!.length);
  });

  it("keeps dragged steps where they are when the chart is laid out again", () => {
    let t = sample();
    const first = t.steps![0].id;
    t = updating(t, first, { x: 999, y: 777 });
    const kept = relayout(t, new Set([first]));
    expect(kept.steps!.find((s) => s.id === first)).toMatchObject({ x: 999, y: 777 });
    const tidy = relayout(t);
    expect(tidy.steps!.find((s) => s.id === first)!.x).not.toBe(999);
  });

  it("maps stored positions to the canvas and back", () => {
    for (const p of [{ x: 0, y: 0 }, { x: 276, y: 150 }, { x: 552, y: 300 }]) {
      const back = fromCanvas(toCanvas(p));
      expect(back).toEqual(p);
    }
    expect(toCanvas({ x: 0, y: 150 }).x).toBeGreaterThan(toCanvas({ x: 0, y: 0 }).x);
  });
});
