import { describe, expect, it } from "vitest";
import { TEAM_TEMPLATES, describeFlow, stepPrompt, stepsProblem, type ChannelTeam, type TeamFlow, type TeamStep } from "@wisp/core";
import { ADD_KINDS, addStep, lanesOf, prepareTeam, waitingLanes, connecting, disconnecting, emptyTeam, fillTemplate, fromCanvas, inputIds, movingAfter, numberOf, relayout, removingStep, retype, rowInputs, insertingBetween, settingInputs, stepProblems, stepRows, toCanvas, updating } from "../src/team/flow.ts";

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

  it("readies an older role-based team: prompts and agents on the steps, a place on the chart, gone agents cleared", () => {
    const old: ChannelTeam = {
      nodes: [],
      edges: [],
      roles: [{ id: "lead", name: "Lead", description: "Plan it.", agentId: "nova" }],
      steps: [
        { id: "a", roleId: "lead", kind: "do", action: "Plan", next: "b", x: 0, y: 0 },
        { id: "b", roleId: "", kind: "do", action: "Build", next: null, agentId: "gone", x: 0, y: 0 },
      ],
    };
    const t = prepareTeam(old, new Set(["nova", "ghosty"]));
    expect(t.steps![0]).toMatchObject({ agentId: "nova", prompt: "Plan it.", nexts: ["b"] });
    expect(t.steps![1].agentId).toBeNull();
    expect(t.steps![1].y).toBeGreaterThan(t.steps![0].y);
    expect(t.roles).toHaveLength(1);
  });

  it("reads a request's lanes, and makes some for an older request that has none", () => {
    const base = { id: "f", workspaceId: "w", channelId: "c", threadId: "t", request: "x", requestedBy: null, taskId: null, rounds: {}, pieces: {}, createdAt: "", updatedAt: "" };
    const lane = (stepId: string, status: "running" | "waiting" | "done" | "skipped", waitingFor: TeamFlow["waitingFor"] = null) => ({ stepId, status, taskId: null, carry: null, pieces: {}, waitingFor });
    const withLanes: TeamFlow = { ...base, status: "waiting", stepId: "a", history: [], waitingFor: null, lanes: { a: lane("a", "waiting", { why: "failed", options: "retry" }), b: lane("b", "waiting", { why: "ask", options: "ask" }), c: lane("c", "running") } };
    expect(waitingLanes(withLanes).map((l) => l.stepId).sort()).toEqual(["a", "b"]);
    const older: TeamFlow = { ...base, status: "waiting", stepId: "b", history: [{ stepId: "a", taskId: "t1", round: 1, verdict: "approved", at: "" }], waitingFor: { why: "rounds ran out", options: "rounds" } };
    expect(Object.fromEntries(Object.entries(lanesOf(older)).map(([k, l]) => [k, l.status]))).toEqual({ a: "done", b: "waiting" });
    expect(waitingLanes(older).map((l) => l.waitingFor?.options)).toEqual(["rounds"]);
  });

  it("removing or disconnecting a step leaves no edge behind in nexts, inputs or next", () => {
    const t = sample();
    const join = stepRows(t.steps!)[1][0];
    const gone = removingStep(t, join.id);
    for (const s of gone.steps!) {
      for (const ref of [...(s.nexts ?? []), ...(s.inputs ?? []), ...(s.next ? [s.next] : [])]) expect(ref).not.toBe(join.id);
    }
    expect(stepsProblem(gone)).toBeNull();
    // cutting A -> B really stops B following A
    const [a] = stepRows(t.steps!)[0];
    const cut = disconnecting(t, a.id, join.id);
    expect(cut.steps!.find((s) => s.id === a.id)).toMatchObject({ nexts: [], next: null });
    expect(inputIds(cut.steps!.find((s) => s.id === join.id)!)).not.toContain(a.id);
  });

  it("a step's own prompt is what runs: editing it replaces an older role's text", () => {
    const old: ChannelTeam = { nodes: [], edges: [], roles: [{ id: "r", name: "R", description: "Merge automatically.", agentId: "nova" }], steps: [{ id: "a", roleId: "r", kind: "do", action: "Merge", next: null, x: 0, y: 0 }] };
    const t = prepareTeam(old);
    expect(stepPrompt(t, t.steps![0])).toBe("Merge automatically.");
    const edited = updating(t, "a", { prompt: "Never merge without approval." });
    expect(stepPrompt(edited, edited.steps![0])).toBe("Never merge without approval.");
  });

  it("every kind of step can be edited, with the fields the form has, into a valid team", () => {
    const base = addStep(emptyTeam(), "agent", {}, agents);
    const first = base.id;
    const fill: Record<string, (t: ChannelTeam, id: string) => ChannelTeam> = {
      review: (t) => t,
      ask: (t) => t,
      custom: (t) => t,
      handoff: (t, id) => updating(t, id, { handoffTo: "other-team" }),
      branch: (t, id) => updating(t, id, { condition: "every test passed", ifTrue: null, ifFalse: first }),
      handOut: (t, id) => updating({ ...t, roles: [{ id: "r1", name: "Builder", description: "", agentId: "pappy" }] }, id, { handTo: ["r1"] }),
    };
    for (const [kind, configure] of Object.entries(fill)) {
      const added = addStep(base.team, kind as never, { after: first }, agents);
      const t = configure(added.team, added.id);
      expect(stepProblems(t).lines, kind).toEqual([]);
    }
    // changing an ordinary step into each kind also ends valid after its fields are filled
    for (const kind of ["review", "handoff", "branch", "hand_out"] as const) {
      let t = addStep(base.team, "agent", { after: first }, agents).team;
      const id = t.steps!.at(-1)!.id;
      t = retype(t, id, kind, agents);
      if (kind === "handoff") t = updating(t, id, { handoffTo: "x" });
      if (kind === "branch") t = updating(t, id, { rule: { op: "contains", value: "ok" }, ifTrue: first });
      if (kind === "hand_out") t = updating({ ...t, roles: [{ id: "r1", name: "B", description: "", agentId: "pappy" }] }, id, { handTo: ["r1"] });
      expect(stepProblems(t).lines, kind).toEqual([]);
    }
  });
});

describe("adding a step from the phone's flow", () => {
  it("goes between a step and what it really waits for, not the whole row above", () => {
    const step = (id: string, extra: Partial<TeamStep> = {}): TeamStep => ({ id, roleId: "", kind: "do", action: id, agentId: "nova", next: null, nexts: [], inputs: [], x: 0, y: 0, ...extra });
    // Yes -> A -> Ship, No -> B -> End
    let t: ChannelTeam = { nodes: [], edges: [], roles: [], steps: [step("gate", { kind: "branch", ifTrue: "a", ifFalse: "b" }), step("a"), step("b"), step("ship", { inputs: ["a"] }), step("end", { inputs: ["b"] })] };
    t = { ...t, steps: t.steps!.map((s) => ({ ...s })) };
    const rows = stepRows(t.steps!);
    const shipRow = rows.find((r) => r.some((s) => s.id === "ship"))!.filter((s) => s.id === "ship");
    expect(rowInputs(shipRow)).toEqual(["a"]);
    const next = insertingBetween(t, step("ask", { kind: "ask", agentId: null }), rowInputs(shipRow), ["ship"]);
    const ask = next.steps!.find((s) => s.id === "ask")!;
    expect(ask.inputs).toEqual(["a"]);
    expect(next.steps!.find((s) => s.id === "ship")!.inputs).toEqual(["ask"]);
    expect(next.steps!.find((s) => s.id === "end")!.inputs).toEqual(["b"]);
  });
});
