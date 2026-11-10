import { describe, expect, it } from "vitest";
import {
  TEAM_TEMPLATES,
  chartFromSteps,
  describeFlow,
  graphFromTemplate,
  hasSteps,
  isGraphTeam,
  layoutSteps,
  migrateTeam,
  migrateTemplate,
  normalizeSteps,
  startSteps,
  stepGraph,
  stepOrder,
  stepsAfter,
  stepsProblem,
  teamFromTemplate,
  templateFromTeam,
  titleAsVerb,
  type TeamStep,
} from "../src/index.ts";

const step = (id: string, extra: Partial<TeamStep> = {}): TeamStep => ({ id, roleId: "", kind: "do", action: id, next: null, agentId: "a1", x: 0, y: 0, ...extra });
const team = (steps: TeamStep[]) => ({ roles: [], steps });
const names = (id: string | null) => ({ a1: "Nova", a2: "Ghosty", a3: "Pappy" })[id ?? ""] ?? "Someone";

/** Plan and Research side by side, Build uses both, you approve. */
const crew = () => [
  step("plan", { action: "Plan the work", agentId: "a1" }),
  step("research", { action: "Research the options", agentId: "a2" }),
  step("build", { action: "Build it", agentId: "a3", inputs: ["plan", "research"] }),
  step("approve", { action: "Approve before it ships", kind: "ask", agentId: null, inputs: ["build"], sendBackTo: "build" }),
];

describe("the step graph", () => {
  it("reads inputs, nexts and the old single next as the same arrows", () => {
    const viaInputs = stepGraph(crew());
    expect(viaInputs.ins.get("build")).toEqual(["plan", "research"]);
    expect(viaInputs.outs.get("plan")).toEqual(["build"]);
    const viaNexts = stepGraph([step("a", { nexts: ["b", "c"] }), step("b"), step("c")]);
    expect(viaNexts.ins.get("c")).toEqual(["a"]);
    const viaNext = stepGraph([step("a", { next: "b" }), step("b")]);
    expect(viaNext.ins.get("b")).toEqual(["a"]);
  });

  it("starts every step nothing leads to, together, and orders the rest after what they wait for", () => {
    expect(startSteps(crew()).map((s) => s.id)).toEqual(["plan", "research"]);
    expect(stepOrder(crew()).map((s) => s.id)).toEqual(["plan", "research", "build", "approve"]);
    expect([...stepsAfter(crew(), "plan")]).toEqual(expect.arrayContaining(["build", "approve"]));
  });

  it("normalizing makes nexts, inputs and next agree", () => {
    const n = normalizeSteps(crew());
    expect(n.find((s) => s.id === "plan")).toMatchObject({ nexts: ["build"], next: "build", inputs: [] });
    expect(n.find((s) => s.id === "build")).toMatchObject({ inputs: ["plan", "research"], nexts: ["approve"] });
    // idempotent
    expect(normalizeSteps(n)).toEqual(n);
  });

  it("treats an if/else that points back as a loop, and one that points forward as an arrow", () => {
    const steps = [
      step("build"),
      step("check", { kind: "branch", condition: "every test passed", inputs: ["build"], ifTrue: "ship", ifFalse: "build" }),
      step("ship"),
    ];
    const g = stepGraph(steps);
    expect(g.outs.get("check")).toEqual(["ship"]);
    expect(g.back.get("check")).toEqual(["build"]);
    expect(g.ins.get("ship")).toEqual(["check"]);
  });
});

describe("checking a flow chart", () => {
  it("accepts parallel steps, a join and an ask-me", () => {
    expect(stepsProblem(team(crew()))).toBeNull();
  });

  it("needs an agent for every step except ask-me and hand-off", () => {
    const steps = crew().map((s) => (s.id === "build" ? { ...s, agentId: null } : s));
    expect(stepsProblem(team(steps))).toMatch(/Pick an agent for “Build it”/);
    expect(stepsProblem(team([step("a"), step("ask", { kind: "ask", agentId: null, inputs: ["a"] })]))).toBeNull();
    expect(stepsProblem(team([step("a"), step("h", { kind: "handoff", agentId: null, inputs: ["a"], handoffTo: "ch_1" })]))).toBeNull();
    expect(stepsProblem(team([step("a"), step("h", { kind: "handoff", agentId: null, inputs: ["a"] })]))).toMatch(/Pick the team/);
  });

  it("needs at least one step an agent does", () => {
    expect(stepsProblem(team([step("ask", { kind: "ask", agentId: null })]))).toMatch(/at least one step that an agent does/);
  });

  it("lets an if/else decide by a rule without an agent", () => {
    const steps = [step("a"), step("r", { kind: "branch", agentId: null, rule: { op: "contains", value: "PASS" }, inputs: ["a"], ifTrue: "b", ifFalse: null }), step("b")];
    expect(stepsProblem(team(steps))).toBeNull();
    expect(stepsProblem(team(steps.map((s) => (s.id === "r" ? { ...s, rule: { op: "contains" as const, value: " " } } : s))))).toMatch(/looks for/);
    expect(stepsProblem(team(steps.map((s) => (s.id === "r" ? { ...s, agentId: "a1", rule: null, condition: "" } : s))))).toMatch(/checks for/);
  });

  it("refuses a circle made of plain arrows", () => {
    const steps = [step("a", { inputs: ["c"] }), step("b", { inputs: ["a"] }), step("c", { inputs: ["b"] })];
    expect(stepsProblem(team(steps))).toMatch(/circle/);
  });

  it("allows a loop only through a repeat, ask-me or if/else step", () => {
    const loop = (mid: Partial<TeamStep>) => [step("build"), step("mid", { inputs: ["build"], ...mid })];
    expect(stepsProblem(team(loop({ kind: "review", sendBackTo: "build", maxRounds: 3 })))).toBeNull();
    expect(stepsProblem(team(loop({ kind: "ask", agentId: null, sendBackTo: "build" })))).toBeNull();
    expect(stepsProblem(team(loop({ kind: "branch", condition: "good?", ifTrue: null, ifFalse: "build" })))).toBeNull();
    // a do step has no way to go back
    expect(stepsProblem(team(loop({ kind: "do", sendBackTo: "build" })))).toBeNull();
    expect(stepGraph(team(loop({ kind: "do", sendBackTo: "build" })).steps).back.get("mid")).toEqual([]);
  });

  it("says where a repeat step sends work back to, and only to a step before it", () => {
    const steps = [step("a"), step("r", { kind: "review", inputs: ["a"] })];
    expect(stepsProblem(team(steps))).toMatch(/sends work back to/);
    expect(stepsProblem(team([...steps.slice(0, 1), step("r", { kind: "review", inputs: ["a"], sendBackTo: "r" })]))).toMatch(/itself/);
    expect(stepsProblem(team([step("a"), step("b"), step("r", { kind: "review", inputs: ["a"], sendBackTo: "b" })]))).toMatch(/step before it/);
  });

  it("makes every step reachable from a start", () => {
    // two steps that wait on each other can never start
    const steps = [step("a"), step("x", { kind: "review", inputs: ["y"], sendBackTo: "a" }), step("y", { inputs: ["x"] })];
    expect(stepsProblem(team(steps))).toMatch(/circle/);
    expect(stepsProblem(team([step("a"), step("b", { nexts: ["zzz"] })]))).toMatch(/isn't there/);
  });

  it("flags duplicate ids, a step leading to itself, and too many steps", () => {
    expect(stepsProblem(team([step("a"), step("a")]))).toMatch(/share an id/);
    expect(stepsProblem(team([step("a", { nexts: ["a"] })]))).toMatch(/itself/);
    expect(stepsProblem(team(Array.from({ length: 41 }, (_, i) => step(`s${i}`))))).toMatch(/at most 40/);
  });

  it("still reads older teams with roles", () => {
    const t = teamFromTemplate(TEAM_TEMPLATES[0]);
    expect(stepsProblem(t)).toMatch(/Pick an agent for Lead/);
    expect(stepsProblem({ roles: t.roles.map((r) => ({ ...r, agentId: "x" })), steps: t.steps })).toBeNull();
    expect(stepsProblem({ roles: t.roles, steps: [] })).toMatch(/at least one step/);
    expect(stepsProblem({ roles: [], steps: [] })).toBeNull();
  });
});

describe("migrating a linear team", () => {
  const old = (): { roles: any[]; steps: TeamStep[] } => ({
    roles: [
      { id: "lead", name: "Lead", description: "Owns the request.", agentId: "a1" },
      { id: "rev", name: "Reviewer", description: "Checks the work.", agentId: "a2" },
    ],
    steps: [
      { id: "plan", roleId: "lead", kind: "do", action: "Plan it", next: "check", x: 0, y: 0 },
      { id: "check", roleId: "rev", kind: "review", action: "Check it", next: "ship", sendBackTo: "plan", maxRounds: 2, x: 0, y: 150 },
      { id: "ship", roleId: "lead", kind: "do", action: "Ship it", next: null, x: 0, y: 300 },
    ],
  });

  it("spells out every arrow, moves the prompt onto the step, and loses nothing", () => {
    const before = old();
    const after = migrateTeam(before);
    expect(isGraphTeam(before)).toBe(false);
    expect(isGraphTeam(after)).toBe(true);
    expect(after.steps.map((s) => [s.id, s.inputs, s.nexts])).toEqual([
      ["plan", [], ["check"]],
      ["check", ["plan"], ["ship"]],
      ["ship", ["check"], []],
    ]);
    expect(after.steps[0].prompt).toBe("Owns the request.");
    expect(after.steps[1]).toMatchObject({ roleId: "rev", kind: "review", sendBackTo: "plan", maxRounds: 2, action: "Check it", next: "ship" });
    expect(after.roles).toEqual(before.roles);
    expect(stepsProblem(after)).toBeNull();
    expect(migrateTeam(after)).toEqual(after);
  });

  it("keeps the plain chart older apps see", () => {
    const m = migrateTeam(old());
    const chart = chartFromSteps(m);
    expect(chart.nodes.map((n) => n.agentId)).toEqual(["a1", "a2"]);
    expect(chart.nodes.find((n) => n.lead)?.agentId).toBe("a1");
    expect(chart.edges).toEqual([{ from: "a1", to: "a2" }]);
  });

  it("a step's own agent beats its role's, and ask/hand-off steps need none", () => {
    const t = migrateTeam(old());
    t.steps[1] = { ...t.steps[1], agentId: "a3" };
    expect(chartFromSteps(t).nodes.map((n) => n.agentId).sort()).toEqual(["a1", "a2", "a3"]);
    expect(hasSteps({ steps: [] })).toBe(false);
    expect(hasSteps({ steps: t.steps })).toBe(true);
  });

  it("makes every built-in template a valid flow chart, with a sample and a mini chart", () => {
    expect(TEAM_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const tpl of TEAM_TEMPLATES) {
      expect(isGraphTeam({ steps: tpl.steps.map((s) => ({ ...s, x: 0, y: 0 })) }), tpl.id).toBe(true);
      expect(tpl.sample?.length, tpl.id).toBeGreaterThan(2);
      const filled = teamFromTemplate(tpl);
      expect(stepsProblem({ roles: filled.roles.map((r) => ({ ...r, agentId: "x" })), steps: filled.steps }), tpl.id).toBeNull();
      const g = graphFromTemplate(tpl, () => "x");
      expect(stepsProblem(g), tpl.id).toBeNull();
      expect(g.roles.map((r) => r.id)).toEqual(tpl.steps.some((s) => s.kind === "hand_out") ? ["backend", "frontend", "reviewer"] : []);
      expect(g.steps.every((s) => s.prompt !== undefined || s.kind === "ask")).toBe(true);
    }
    const crewTpl = TEAM_TEMPLATES.find((t) => t.id === "release-crew")!;
    expect(startSteps(crewTpl.steps.map((s) => ({ ...s, x: 0, y: 0 })) as TeamStep[]).map((s) => s.id)).toEqual(["plan", "research"]);
  });

  it("migrates a template someone saved before graphs, and saves a team as a template without its agents", () => {
    const saved = templateFromTeam(old(), "Mine", "blurb");
    expect(saved.steps.every((s) => !("agentId" in s))).toBe(true);
    const migrated = migrateTemplate(saved);
    expect(migrated.steps[1].inputs).toEqual(["plan"]);
    expect(migrated.steps[0].prompt).toBe("Owns the request.");
  });
});

describe("laying a flow chart out", () => {
  it("puts steps that run together side by side and the rest on later rows", () => {
    const laid = layoutSteps(crew());
    const at = (id: string) => laid.find((s) => s.id === id)!;
    expect(at("plan").y).toBe(at("research").y);
    expect(at("plan").x).not.toBe(at("research").x);
    expect(at("build").y).toBeGreaterThan(at("plan").y);
    expect(at("approve").y).toBeGreaterThan(at("build").y);
  });
});

describe("how it works in plain English", () => {
  it("writes one line per step with at the same time, uses the results of, and you approve", () => {
    const lines = describeFlow(team(crew()), names);
    expect(lines.map((l) => l.text)).toEqual([
      "Nova plans the work.",
      "At the same time, Ghosty researches the options.",
      "Pappy uses the results of steps 1 and 2 to build it.",
      "You approve before it ships. If you ask for changes it goes back to step 3.",
    ]);
    expect(lines.map((l) => l.together)).toEqual([false, true, false, false]);
    expect(lines[3].who).toBe("You");
  });

  it("describes repeat, hand-off, if/else and hand-out steps", () => {
    const steps = [
      step("a", { action: "Draft a plan" }),
      step("r", { kind: "review", action: "Find gaps", agentId: "a2", inputs: ["a"], sendBackTo: "a", maxRounds: 2 }),
      step("i", { kind: "branch", action: "Did tests pass", inputs: ["r"], condition: "every test passed", ifTrue: "h", ifFalse: "a" }),
      step("h", { kind: "handoff", agentId: null, action: "Tell customers", handoffTo: "ch_1", waitForReply: true }),
    ];
    const lines = describeFlow(team(steps), names, () => "Support");
    expect(lines[0].text).toBe("Nova drafts a plan.");
    expect(lines[1].text).toMatch(/^Ghosty finds gaps using the result of step 1\. If it isn't good enough it goes back to step 1, up to 2 rounds, then it asks you\.$/);
    expect(lines[2].text).toBe("Nova works on “Did tests pass”.".replace("works on “Did tests pass”", "looks at the result of step 2: if every test passed, it goes to step 4; if not, to step 1"));
    expect(lines[3].text).toBe("The Support team gets the work, and the next step waits for their answer.");
  });

  it("falls back to quoting the title when it doesn't start with a verb", () => {
    expect(titleAsVerb("Plan the work")).toEqual({ third: "plans the work", base: "plan the work" });
    expect(titleAsVerb("Research")?.third).toBe("researches");
    expect(titleAsVerb("Notify the team")?.third).toBe("notifies the team".replace("notifies", "notifies"));
    expect(titleAsVerb("Finance summary")).toBeNull();
    expect(titleAsVerb("Find gaps, challenge the plan")?.third).toBe("finds gaps, challenges the plan");
    expect(describeFlow(team([step("a", { action: "Finance summary" })]), names)[0].text).toBe("Nova works on “Finance summary”.");
  });
});

describe("describeFlow for a filled template", () => {
  it("names the agents who really fill the roles, not the template's role names", () => {
    const t = teamFromTemplate(TEAM_TEMPLATES.find((x) => x.id === "plan-challenge")!);
    const roles = t.roles.map((r) => ({ ...r, agentId: r.id === "reviewer" || r.id === "frontend" ? "bea" : "atlas" }));
    const lines = describeFlow({ roles, steps: t.steps }, (id) => (id === "bea" ? "Bea" : "Atlas"));
    const handOut = lines.find((l) => l.stepId === "hand-out")!;
    expect(handOut.text).toBe("Atlas hands out the pieces between Atlas and Bea; Bea checks each piece.");
    expect(handOut.text).not.toMatch(/builder|Reviewer/);
  });
});
