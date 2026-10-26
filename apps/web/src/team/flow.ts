import {
  DEFAULT_ROUNDS,
  STEP_GAP,
  STEP_ROW,
  STEP_W,
  chartFromSteps,
  graphFromTemplate,
  layoutSteps,
  normalizeSteps,
  stepAgentId,
  stepGraph,
  stepLevels,
  stepNeedsAgent,
  stepOrder,
  stepsAfter,
  stepsProblem,
  startSteps,
  type Agent,
  type ChannelTeam,
  type TeamRole,
  type TeamStep,
  type TeamStepKind,
  type TeamTemplate,
} from "@wisp/core";

// Editing a team's flow chart. Every change goes through `normalizeSteps`, so the arrows (`nexts`,
// `inputs`, `next`) always agree with each other and any client can read any step. These mirror
// the iPhone's helpers (TeamFlow.swift) so both apps edit a team the same way.

export const emptyTeam = (): ChannelTeam => ({ nodes: [], edges: [], roles: [], steps: [] });

/** A stepped team with its plain chart kept in step, so the rest of the app (and older apps) see who's on it. */
export function withChart(team: ChannelTeam): ChannelTeam {
  return { ...team, ...chartFromSteps(team, team.nodes) };
}

const stepsOf = (team: Pick<ChannelTeam, "steps">) => team.steps ?? [];
export const stepById = (team: Pick<ChannelTeam, "steps">, id: string | null | undefined) => stepsOf(team).find((s) => s.id === id);
export const roleById = (team: Pick<ChannelTeam, "roles">, id: string | null | undefined) => (team.roles ?? []).find((r) => r.id === id);
export const titleOf = (s: Pick<TeamStep, "action">) => s.action.trim() || "Untitled step";

/** The number a step shows ("step 3"): its place in the order things happen in. */
export function numberOf(team: Pick<ChannelTeam, "steps">, id: string | null | undefined): number {
  return stepOrder(stepsOf(team)).findIndex((s) => s.id === id) + 1;
}

/** The steps as rows, in order; steps in a row run at the same time. */
export function stepRows<T extends { id: string }>(steps: T[]): T[][] {
  const full = steps as unknown as TeamStep[];
  const level = stepLevels(full);
  const rows = new Map<number, T[]>();
  for (const s of stepOrder(full)) {
    const lv = level.get(s.id) ?? 0;
    rows.set(lv, [...(rows.get(lv) ?? []), steps.find((x) => x.id === s.id)!]);
  }
  return [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k)!);
}

/** A step id that isn't taken. */
export function freeStepId(team: Pick<ChannelTeam, "steps">, prefix = "step"): string {
  const taken = new Set(stepsOf(team).map((s) => s.id));
  let n = stepsOf(team).length + 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function edit(team: ChannelTeam, change: (all: TeamStep[]) => TeamStep[]): ChannelTeam {
  return { ...team, steps: normalizeSteps(change(stepsOf(team).map((s) => ({ ...s })))) };
}

const blank = (s: TeamStep): TeamStep => ({ ...s, inputs: [], nexts: [], next: null });

/** Draw an arrow a -> b (both ends, and `next`). */
export function connecting(team: ChannelTeam, a: string, b: string): ChannelTeam {
  if (a === b) return team;
  return edit(team, (all) =>
    all.map((s) => {
      if (s.id === a && !(s.nexts ?? []).includes(b)) return { ...s, nexts: [...(s.nexts ?? []), b] };
      if (s.id === b && !(s.inputs ?? []).includes(a)) return { ...s, inputs: [...(s.inputs ?? []), a] };
      return s;
    }),
  );
}

/** Remove the arrow a -> b from both ends and from `next`. */
export function disconnecting(team: ChannelTeam, a: string, b: string): ChannelTeam {
  return edit(team, (all) =>
    all.map((s) => {
      let out = s;
      if (s.id === a) {
        out = { ...out, nexts: (s.nexts ?? []).filter((x) => x !== b), next: s.next === b ? null : s.next };
        if (s.kind === "branch") out = { ...out, ifTrue: s.ifTrue === b ? null : s.ifTrue, ifFalse: s.ifFalse === b ? null : s.ifFalse };
      }
      if (s.id === b) out = { ...out, inputs: (s.inputs ?? []).filter((x) => x !== a) };
      return out;
    }),
  );
}

/** The steps a step can take its input from: every step that doesn't come after it. */
export function possibleInputs(team: ChannelTeam, id: string): TeamStep[] {
  const after = stepsAfter(stepsOf(team), id);
  return stepOrder(stepsOf(team)).filter((s) => s.id !== id && !after.has(s.id));
}

/** The steps whose results a step receives. */
export const inputIds = (s: TeamStep): string[] => s.inputs ?? [];

/** Make `ids` exactly the steps `id` receives results from. */
export function settingInputs(team: ChannelTeam, id: string, ids: string[]): ChannelTeam {
  let next = team;
  const current = inputIds(stepById(team, id) ?? ({} as TeamStep));
  for (const a of current) if (!ids.includes(a)) next = disconnecting(next, a, id);
  for (const a of ids) if (!current.includes(a)) next = connecting(next, a, id);
  return next;
}

/** Change one step; its arrows are kept as they are (edit those with the arrow helpers). */
export function updating(team: ChannelTeam, id: string, patch: Partial<TeamStep> | ((s: TeamStep) => TeamStep)): ChannelTeam {
  return edit(team, (all) => all.map((s) => (s.id === id ? (typeof patch === "function" ? patch(s) : { ...s, ...patch }) : s)));
}

/** Add a step with no arrows yet. */
export const appending = (team: ChannelTeam, step: TeamStep): ChannelTeam => edit(team, (all) => [...all, step]);

/**
 * Put a new step on the chart. `after` = in the middle of that step's arrows (it leads to what the
 * step led to); `beside` = at the same time as that step (same inputs, same followers); neither =
 * a new start, or after the last steps when there are steps already and `atEnd`.
 */
export function inserting(team: ChannelTeam, step: TeamStep, where: { after?: string | null; beside?: string | null; atEnd?: boolean } = {}): ChannelTeam {
  const fresh = blank(step);
  let next = appending(team, fresh);
  const after = stepById(team, where.after);
  const beside = stepById(team, where.beside);
  if (after) {
    const followers = (after.nexts ?? []).filter((id) => stepById(team, id));
    for (const f of followers) next = disconnecting(next, after.id, f);
    next = connecting(next, after.id, fresh.id);
    for (const f of followers) if (f !== fresh.id) next = connecting(next, fresh.id, f);
  } else if (beside) {
    for (const i of inputIds(beside)) next = connecting(next, i, fresh.id);
    for (const n of beside.nexts ?? []) next = connecting(next, fresh.id, n);
  } else if (where.atEnd) {
    const g = stepGraph(stepsOf(team));
    const ends = stepOrder(stepsOf(team)).filter((s) => !(g.outs.get(s.id) ?? []).length && s.kind !== "branch");
    for (const e of ends) next = connecting(next, e.id, fresh.id);
  }
  return next;
}

/** Put a new step just before `id`: it gets what `id` was waiting for, and `id` waits for it. */
export function insertingBefore(team: ChannelTeam, step: TeamStep, id: string): ChannelTeam {
  const anchor = stepById(team, id);
  if (!anchor) return team;
  const fresh = blank(step);
  let next = appending(team, fresh);
  for (const i of inputIds(anchor)) next = connecting(disconnecting(next, i, id), i, fresh.id);
  return connecting(next, fresh.id, id);
}

/** Put a step in between: what `from` led to in `to` now goes through it. Empty `from` = a new start; empty `to` = the end. */
export function insertingBetween(team: ChannelTeam, step: TeamStep, from: string[], to: string[]): ChannelTeam {
  const fresh = blank(step);
  let next = appending(team, fresh);
  const live = to.filter((id) => stepById(team, id));
  for (const a of from.filter((id) => stepById(team, id))) {
    for (const b of live) next = disconnecting(next, a, b);
    next = connecting(next, a, fresh.id);
  }
  for (const b of live) next = connecting(next, fresh.id, b);
  return next;
}

/** Take a step off. Whatever led to it now leads to whatever followed it, and arrows that pointed at it are cleared. */
export function removingStep(team: ChannelTeam, id: string): ChannelTeam {
  const gone = stepById(team, id);
  if (!gone) return team;
  const before = inputIds(gone);
  const after = stepGraph(stepsOf(team)).outs.get(id) ?? [];
  let next = team;
  for (const a of before) next = disconnecting(next, a, id);
  for (const b of after) next = disconnecting(next, id, b);
  next = edit(next, (all) =>
    all
      .filter((s) => s.id !== id)
      .map((s) => ({
        ...s,
        sendBackTo: s.sendBackTo === id ? null : s.sendBackTo,
        ifTrue: s.ifTrue === id ? null : s.ifTrue,
        ifFalse: s.ifFalse === id ? null : s.ifFalse,
      })),
  );
  for (const a of before) for (const b of after) if (a !== b) next = connecting(next, a, b);
  return next;
}

/** Move a step to sit right after `target` (null = first). It leaves its place and takes `target`'s followers. */
export function movingAfter(team: ChannelTeam, id: string, target: string | null): ChannelTeam {
  const moved = stepById(team, id);
  if (!moved || target === id) return team;
  let next = removingStep(team, id);
  const fresh = blank(moved);
  if (target && stepById(next, target)) return inserting(next, fresh, { after: target });
  // first: the steps that started before now wait for it
  const starts = startSteps(stepsOf(next)).map((s) => s.id);
  next = appending(next, fresh);
  for (const s of starts) next = connecting(next, fresh.id, s);
  return next;
}

// --- new steps ----------------------------------------------------------------------------

export type AddKind = "agent" | "beside" | "review" | "ask" | "handoff" | "branch" | "custom" | "handOut";

export const ADD_KINDS: { kind: AddKind; title: string; blurb: string }[] = [
  { kind: "agent", title: "Agent step", blurb: "An agent does one thing." },
  { kind: "beside", title: "Side by side", blurb: "Runs at the same time as this one." },
  { kind: "review", title: "Repeat until approved", blurb: "A checker sends it back, up to a limit." },
  { kind: "ask", title: "Ask me", blurb: "Waits for your yes." },
  { kind: "handoff", title: "Hand off to another team", blurb: "Another team takes it from here." },
  { kind: "branch", title: "If / else", blurb: "Go one way or the other." },
  { kind: "custom", title: "Fully custom", blurb: "Write your own rules." },
  { kind: "handOut", title: "Split the work", blurb: "An agent hands pieces to others." },
];

/** A new step of this kind with sensible words in it. */
export function newStep(team: ChannelTeam, kind: AddKind, anchor: string | null, agents: Pick<Agent, "id">[]): TeamStep {
  const id = freeStepId(team);
  const anchorStep = stepById(team, anchor);
  const fallback = (anchorStep && stepAgentId(team, anchorStep)) || stepsOf(team).map((s) => stepAgentId(team, s)).filter((a): a is string => !!a).at(-1) || agents[0]?.id || null;
  const base = { id, roleId: "", next: null, x: 0, y: 0 };
  switch (kind) {
    case "agent":
    case "beside":
      return { ...base, kind: "do", action: "New step", agentId: fallback };
    case "review":
      return { ...base, kind: "review", action: "Check the work", sendBackTo: anchor, maxRounds: DEFAULT_ROUNDS, agentId: fallback };
    case "ask":
      return { ...base, kind: "ask", action: "Approve before it goes on", notifyPhone: true };
    case "handoff":
      return { ...base, kind: "handoff", action: "Hand off the work", waitForReply: true };
    case "branch":
      return { ...base, kind: "branch", action: "Decide where to go", maxRounds: DEFAULT_ROUNDS, agentId: fallback };
    case "custom":
      return { ...base, kind: "custom", action: "Custom step", agentId: fallback };
    case "handOut":
      return { ...base, kind: "hand_out", action: "Split the work", maxRounds: DEFAULT_ROUNDS, handTo: [], agentId: fallback };
  }
}

/** Where an Add puts the new step. */
export interface AddAt {
  /** between these steps (empty `from` = at the start, empty `to` = at the end) */
  between?: { from: string[]; to: string[] };
  /** or right after this step */
  after?: string | null;
}

/** Add a step of `kind` and return the team and the new step's id. */
export function addStep(team: ChannelTeam, kind: AddKind, at: AddAt, agents: Pick<Agent, "id">[]): { team: ChannelTeam; id: string } {
  const anchor = at.after ?? at.between?.from.at(-1) ?? null;
  const fresh = newStep(team, kind, anchor, agents);
  let next: ChannelTeam;
  if (kind === "beside") next = inserting(team, fresh, { beside: anchor });
  else if (at.between) next = insertingBetween(team, fresh, at.between.from, at.between.to);
  else if (anchor) next = inserting(team, fresh, { after: anchor });
  else next = inserting(team, fresh, { atEnd: stepsOf(team).length > 0 });
  return { team: next, id: fresh.id };
}

/** Change what kind a step is, keeping its words and arrows, with the fields the new kind needs. */
export function retype(team: ChannelTeam, id: string, kind: TeamStepKind, agents: Pick<Agent, "id">[]): ChannelTeam {
  const s = stepById(team, id);
  if (!s || s.kind === kind) return team;
  const earlier = stepOrder(stepsOf(team)).filter((x) => x.id !== id && stepsAfter(stepsOf(team), x.id).has(id));
  const agentId = stepAgentId(team, s) ?? agents[0]?.id ?? null;
  return updating(team, id, (cur) => {
    const out: TeamStep = { ...cur, kind };
    if (stepNeedsAgent({ kind, rule: kind === "branch" ? cur.rule : undefined }) && !out.agentId) out.agentId = agentId;
    if (kind === "review") {
      out.sendBackTo = cur.sendBackTo ?? earlier.at(-1)?.id ?? null;
      out.maxRounds = cur.maxRounds ?? DEFAULT_ROUNDS;
    }
    if (kind === "hand_out") {
      out.handTo = cur.handTo ?? [];
      out.maxRounds = cur.maxRounds ?? DEFAULT_ROUNDS;
    }
    if (kind === "branch") out.maxRounds = cur.maxRounds ?? DEFAULT_ROUNDS;
    if (kind === "ask") out.notifyPhone = cur.notifyPhone ?? true;
    if (kind === "handoff") out.waitForReply = cur.waitForReply ?? true;
    return out;
  });
}

// --- the canvas ---------------------------------------------------------------------------

/**
 * The chart is stored top to bottom (`layoutSteps`: a row for each level, steps that run together
 * side by side). The desktop canvas reads it left to right, so a stored (x, y) is drawn at
 * (y, x) with a different spacing. These two keep that in one place.
 */
export const BOX_W = 188;
export const BOX_H = 104;
const COL = 264;
const LANE = 172;
export function toCanvas(s: { x: number; y: number }): { x: number; y: number } {
  return { x: (s.y / STEP_ROW) * COL, y: (s.x / (STEP_W + STEP_GAP)) * LANE };
}
export function fromCanvas(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round((p.y / LANE) * (STEP_W + STEP_GAP)), y: Math.round((p.x / COL) * STEP_ROW) };
}

/** Lay every step out again, except the ones someone dragged to where they are (`keep`). */
export function relayout(team: ChannelTeam, keep: ReadonlySet<string> = new Set()): ChannelTeam {
  const laid = layoutSteps(stepsOf(team));
  return { ...team, steps: laid.map((s, i) => (keep.has(s.id) ? { ...s, x: stepsOf(team)[i].x, y: stepsOf(team)[i].y } : s)) };
}

// --- checking -----------------------------------------------------------------------------

/** The first thing wrong with one step on its own, or null. */
export function stepProblem(team: ChannelTeam, s: TeamStep): string | null {
  const roles = team.roles ?? [];
  const steps = stepsOf(team);
  const ids = new Set(steps.map((x) => x.id));
  const roleIds = new Set(roles.map((r) => r.id));
  const label = s.action.trim() || roles.find((r) => r.id === s.roleId)?.name || "a step";
  const role = s.roleId ? roles.find((r) => r.id === s.roleId) : undefined;
  if (s.roleId && !role) return "A step belongs to a role that isn't on the team.";
  if (stepNeedsAgent(s) && !stepAgentId(team, s)) return role ? `Pick an agent for ${role.name}.` : `Pick an agent for “${label}”.`;
  const refs = [...(s.nexts ?? []), ...(s.next ? [s.next] : []), ...(s.inputs ?? [])];
  if (refs.some((r) => !ids.has(r))) return "A step leads to a step that isn't there.";
  if (refs.includes(s.id)) return "A step can't lead to itself.";
  if (s.kind === "review") {
    if (!s.sendBackTo || !ids.has(s.sendBackTo)) return `Say where “${label}” sends work back to.`;
    if (s.sendBackTo === s.id) return "A review can't send work back to itself.";
  }
  if (s.kind === "ask" && s.sendBackTo) {
    if (!ids.has(s.sendBackTo)) return `Say where “${label}” sends work back to.`;
    if (s.sendBackTo === s.id) return "A step can't send work back to itself.";
  }
  if (s.kind === "hand_out") {
    if (!s.handTo?.length) return `Pick who “${label}” hands pieces to.`;
    if (s.handTo.some((r) => !roleIds.has(r)) || (s.reviewBy && !roleIds.has(s.reviewBy))) return "A hand-out names a role that isn't on the team.";
    for (const r of [...s.handTo, ...(s.reviewBy ? [s.reviewBy] : [])]) {
      const rl = roles.find((x) => x.id === r);
      if (rl && !rl.agentId) return `Pick an agent for ${rl.name}.`;
    }
  }
  if (s.kind === "handoff" && !s.handoffTo) return `Pick the team “${label}” hands the work to.`;
  if (s.kind === "branch") {
    if (!s.rule && !(s.condition ?? "").trim()) return `Say what “${label}” checks for.`;
    if (s.rule && !s.rule.value.trim()) return `Say what “${label}” looks for in the result.`;
    for (const t of [s.ifTrue, s.ifFalse]) {
      if (t && !ids.has(t)) return "A step leads to a step that isn't there.";
      if (t === s.id) return "A step can't lead to itself.";
    }
    if (!s.ifTrue && !s.ifFalse) return `Say where “${label}” goes next.`;
  }
  return null;
}

/** What's wrong with the team, one plain line each, and which steps they belong to. Empty when it works. */
export function stepProblems(team: ChannelTeam): { lines: string[]; byStep: Map<string, string> } {
  const byStep = new Map<string, string>();
  const steps = stepsOf(team);
  for (const s of steps) {
    const p = stepProblem(team, s);
    if (p) byStep.set(s.id, p);
  }
  const lines = [...new Set(byStep.values())];
  if (!lines.length) {
    const p = stepsProblem(team);
    if (p) lines.push(p);
  }
  return { lines, byStep };
}

// --- templates ----------------------------------------------------------------------------

/** A template as a team to edit: every step names its own agent (a different one each where it can); roles stay only where a split-the-work step needs them. */
export function fillTemplate(t: Pick<TeamTemplate, "roles" | "steps">, agents: Pick<Agent, "id" | "harness">[], base: ChannelTeam | null = null): ChannelTeam {
  const used = new Set<string>();
  const { roles, steps } = graphFromTemplate(t, ({ harness, index }) => {
    const pick = agents.find((a) => a.harness === harness && !used.has(a.id)) ?? agents.find((a) => a.harness === harness) ?? agents.find((a) => !used.has(a.id)) ?? (agents.length ? agents[index % agents.length] : undefined);
    if (pick) used.add(pick.id);
    return pick?.id ?? null;
  });
  return withChart({ ...(base ?? emptyTeam()), nodes: [], edges: [], roles, steps });
}

/** Steps an agent drew, as a team: normalized and laid out. */
export function teamFromSteps(steps: TeamStep[], base: ChannelTeam | null = null): ChannelTeam {
  return withChart({ ...(base ?? emptyTeam()), nodes: [], edges: [], roles: [], steps: layoutSteps(normalizeSteps(steps)) });
}

/** The agents that do things on a team, once each, in the order they work. */
export function teamAgentIds(team: ChannelTeam): string[] {
  return [...new Set(stepOrder(stepsOf(team)).map((s) => stepAgentId(team, s)).filter((a): a is string => !!a))];
}

export const KIND_MARK: Record<TeamStepKind, string | null> = {
  do: null,
  review: "Repeats until approved",
  ask: "Asks you",
  handoff: "Hands off",
  branch: "If / else",
  hand_out: "Splits the work",
  custom: "Custom",
};

export type { TeamRole };
