import { describeCron, parseCron } from "./schedule.ts";
import type { ChannelTeam, ChannelTeamNode } from "./types.ts";

/**
 * A job on a channel's team: what it's called, what it does (every agent on the team reads this),
 * and who does it. One agent can fill several roles. Older teams run on roles; the flow chart
 * builder gives every step its own agent and prompt instead, and keeps roles only so nothing is lost.
 */
export interface TeamRole {
  id: string;
  name: string;
  description: string;
  /** null until someone picks an agent for it */
  agentId: string | null;
  /** the harness a template suggests for it, e.g. "codex"; only a hint for whoever fills it */
  harness?: string;
}

/**
 * - do: the agent does the step and reports the result
 * - review: "repeat until approved": the agent approves (on to the next step) or sends it back to an earlier step, up to its rounds
 * - hand_out: the agent splits the work into pieces for other roles; each piece can be reviewed
 * - ask: "ask me": a person approves or asks for changes; it shows up in the Inbox
 * - handoff: hands the work to another team, and optionally waits for its answer
 * - branch: "if / else": routes by a condition an agent decides, or by a simple rule on the result
 * - custom: a step whose whole behavior is its prompt
 * - schedule: no work of its own: at its times it asks the team `prompt` and starts the steps its arrows point to
 */
export type TeamStepKind = "do" | "review" | "hand_out" | "ask" | "handoff" | "branch" | "custom" | "schedule";

/** A simple rule on a result, for a branch that needs no agent to decide. Case doesn't matter. */
export interface StepRule {
  op: "contains" | "not_contains" | "starts_with" | "equals";
  value: string;
}

/** One box on a team's flow chart. A new message in the channel starts at the steps nothing leads to. */
export interface TeamStep {
  id: string;
  /** an older team's role for this step; "" for steps that name their agent directly */
  roleId: string;
  kind: TeamStepKind;
  /** the step's title, e.g. "Draft a thorough plan" */
  action: string;
  /** the first step after this one (after approval, for a review); null = the flow ends here. `nexts` has all of them */
  next: string | null;
  /** every step that starts after this one, at the same time; a step with several inputs waits for all of them */
  nexts?: string[];
  /** the steps whose results this one receives (and waits for) */
  inputs?: string[];
  /** who does it; falls back to the role's agent for older teams */
  agentId?: string | null;
  /** what the agent does here: its own instructions for this step */
  prompt?: string;
  /** the harness a template suggests for it; only a hint */
  harness?: string;
  /** review (and ask): the step that gets the work back with the notes when changes are needed */
  sendBackTo?: string | null;
  /** review (and a hand-out's piece reviews, and an if/else that loops back): rounds before it asks a person */
  maxRounds?: number;
  /** hand_out: the roles the pieces go to */
  handTo?: string[];
  /** hand_out: the role that checks each piece; changes go back to whoever built it */
  reviewBy?: string | null;
  /** ask: what the person sees with the question */
  show?: string;
  /** ask: also tell them on their phone */
  notifyPhone?: boolean;
  /** handoff: the other team's channel id */
  handoffTo?: string | null;
  /** handoff: wait for the other team's answer before the next step */
  waitForReply?: boolean;
  /** branch: what the agent decides, as a yes/no question ("every test passed") */
  condition?: string;
  /** branch: a simple rule instead of an agent deciding */
  rule?: StepRule | null;
  /** branch: where "yes" and "no" go (a step before this one makes a loop) */
  ifTrue?: string | null;
  ifFalse?: string | null;
  /** schedule: when it runs, as cron */
  schedule?: string;
  /** schedule: the time zone `schedule` is read in */
  timezone?: string;
  /** schedule: false rests it without losing it */
  enabled?: boolean;
  /** schedule: the person it runs for, set by the hub to whoever last changed it */
  scheduledBy?: string | null;
  /** where it sits on the chart */
  x: number;
  y: number;
}

export const DEFAULT_ROUNDS = 3;
export const MAX_ROUNDS_LIMIT = 10;
export const MAX_STEPS = 40;
/** The status text on the message that opens a scheduled run, so apps can draw it as one. */
export const SCHEDULE_MARK = "Schedule";

/** A team that runs on steps rather than a plain chart of who hands work to whom. */
/** A team is a group: it needs at least this many agents. */
export const MIN_TEAM_AGENTS = 2;

/** Every agent on a team, from its chart, its roles and its steps, counted once. */
export function teamSize(team: Pick<ChannelTeam, "nodes" | "roles" | "steps"> | null | undefined): number {
  if (!team) return 0;
  const ids = new Set<string>();
  for (const n of team.nodes ?? []) ids.add(n.agentId);
  for (const r of team.roles ?? []) if (r.agentId) ids.add(r.agentId);
  for (const s of team.steps ?? []) if (s.agentId) ids.add(s.agentId);
  return ids.size;
}

/** Why a new team can't be made yet, in plain words, or null when it has enough agents. */
export function teamSizeProblem(team: Pick<ChannelTeam, "nodes" | "roles" | "steps"> | null | undefined): string | null {
  return teamSize(team) >= MIN_TEAM_AGENTS ? null : `A team needs at least ${MIN_TEAM_AGENTS} agents. Pick ${MIN_TEAM_AGENTS} or more.`;
}

/**
 * Why a change to an existing team is refused: it would leave fewer than the minimum, having had
 * more. Teams that already had fewer keep working and can be edited freely, just not shrunk.
 */
export function teamShrinkProblem(before: Parameters<typeof teamSize>[0], after: Parameters<typeof teamSize>[0]): string | null {
  const now = teamSize(after);
  return now < MIN_TEAM_AGENTS && now < teamSize(before) ? `A team needs at least ${MIN_TEAM_AGENTS} agents, so this one can't go down to ${now}. Add another agent first.` : null;
}

export function hasSteps(team: Pick<ChannelTeam, "steps"> | null | undefined): boolean {
  return !!team?.steps?.length;
}

/** The kinds that an agent does (the rest are a person, another team, or a rule). */
export function stepNeedsAgent(step: Pick<TeamStep, "kind" | "rule">): boolean {
  if (step.kind === "ask" || step.kind === "handoff" || step.kind === "schedule") return false;
  if (step.kind === "branch" && step.rule) return false;
  return true;
}

/** The agent that does a step: its own, else its role's. */
export function stepAgentId(team: Pick<ChannelTeam, "roles">, step: Pick<TeamStep, "agentId" | "roleId">): string | null {
  return step.agentId || team.roles?.find((r) => r.id === step.roleId)?.agentId || null;
}

/** What a step is told to do: its own prompt, else its older role's description. */
export function stepPrompt(team: Pick<ChannelTeam, "roles">, step: Pick<TeamStep, "prompt" | "roleId">): string {
  return (step.prompt ?? team.roles?.find((r) => r.id === step.roleId)?.description ?? "").trim();
}

// --- the graph ----------------------------------------------------------------------

export interface StepGraph {
  ids: string[];
  /** forward edges: who each step waits for, and who it leads to */
  ins: Map<string, string[]>;
  outs: Map<string, string[]>;
  /** loops: where a review or ask-me sends work back to, and an if/else's "back" arrows */
  back: Map<string, string[]>;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** The forward edges of a team's steps and its loops. Dangling ids are dropped here; `stepsProblem` reports them. */
export function stepGraph(steps: TeamStep[]): StepGraph {
  const ids = steps.map((s) => s.id);
  const known = new Set(ids);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const outs = new Map<string, string[]>(ids.map((i) => [i, []]));
  const ins = new Map<string, string[]>(ids.map((i) => [i, []]));
  const back = new Map<string, string[]>(ids.map((i) => [i, []]));
  const add = (a: string, b: string) => {
    if (!known.has(a) || !known.has(b) || a === b || outs.get(a)!.includes(b)) return;
    outs.get(a)!.push(b);
    ins.get(b)!.push(a);
  };
  for (const s of steps) {
    if (s.kind !== "branch") for (const n of [...(s.nexts ?? []), ...(s.next ? [s.next] : [])]) add(s.id, n);
    // an if/else only leads to the steps its Yes and No name; a plain arrow from it never fires
    for (const i of s.inputs ?? []) if (byId.get(i)?.kind !== "branch") add(i, s.id);
  }
  // an if/else's arrows go forward, unless they point at a step that leads here (that's a loop)
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...(outs.get(x) ?? []));
    }
    return false;
  };
  for (const s of steps) {
    if (s.kind !== "branch") continue;
    for (const t of uniq([s.ifTrue, s.ifFalse].filter((x): x is string => !!x && known.has(x)))) {
      if (t === s.id || reaches(t, s.id)) back.get(s.id)!.push(t);
      else add(s.id, t);
    }
  }
  for (const s of steps) if ((s.kind === "review" || s.kind === "ask") && s.sendBackTo && known.has(s.sendBackTo)) back.get(s.id)!.push(s.sendBackTo);
  return { ids, ins, outs, back };
}

/** Steps whose edges (nexts, inputs, next) all agree with each other, so any client can read any one of them. */
export function normalizeSteps(steps: TeamStep[]): TeamStep[] {
  const g = stepGraph(steps);
  const known = new Set(g.ids);
  // an arrow to a step that isn't there stays, so checking can say so
  return steps.map((s) => {
    const nexts = [...(g.outs.get(s.id) ?? []), ...[...(s.nexts ?? []), ...(s.next ? [s.next] : [])].filter((x) => !known.has(x))];
    const inputs = [...(g.ins.get(s.id) ?? []), ...(s.inputs ?? []).filter((x) => !known.has(x))];
    return { ...s, nexts, inputs, next: nexts[0] ?? null };
  });
}

/** The steps nothing leads to but a schedule: where a new message starts, all at once. */
export function startSteps(steps: TeamStep[]): TeamStep[] {
  const g = stepGraph(steps);
  const kind = new Map(steps.map((s) => [s.id, s.kind]));
  return steps.filter((s) => s.kind !== "schedule" && g.ins.get(s.id)!.every((i) => kind.get(i) === "schedule"));
}

/** The steps that do work, in the order they happen: what step numbers count. */
export function workSteps(steps: TeamStep[]): TeamStep[] {
  return stepOrder(steps).filter((s) => s.kind !== "schedule");
}

/** The first step: a step nothing leads to, else the first one listed. */
export function firstStep(steps: TeamStep[]): TeamStep | undefined {
  return startSteps(steps)[0] ?? steps[0];
}

/** Every step after this one, however far (not counting loops back). */
export function stepsAfter(steps: TeamStep[], id: string): Set<string> {
  const g = stepGraph(steps);
  const out = new Set<string>();
  const stack = [...(g.outs.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue;
    out.add(x);
    stack.push(...(g.outs.get(x) ?? []));
  }
  return out;
}

/** The steps in the order they'd happen: nothing before the steps it waits for; ties keep the order listed. */
export function stepOrder(steps: TeamStep[]): TeamStep[] {
  const g = stepGraph(steps);
  const left = new Map(steps.map((s) => [s.id, g.ins.get(s.id)!.length]));
  const out: TeamStep[] = [];
  const done = new Set<string>();
  while (out.length < steps.length) {
    const next = steps.find((s) => !done.has(s.id) && left.get(s.id) === 0);
    // a circle: the rest follow in the order listed
    const s = next ?? steps.find((x) => !done.has(x.id))!;
    out.push(s);
    done.add(s.id);
    for (const o of g.outs.get(s.id) ?? []) left.set(o, (left.get(o) ?? 1) - 1);
  }
  return out;
}

/** How far down each step is: 0 for the first, one more than the deepest step it waits for. */
export function stepLevels(steps: TeamStep[]): Map<string, number> {
  const g = stepGraph(steps);
  const level = new Map<string, number>();
  for (const s of stepOrder(steps)) level.set(s.id, Math.max(-1, ...(g.ins.get(s.id) ?? []).map((i) => level.get(i) ?? 0)) + 1);
  return level;
}

/** An older linear team (or template) as a graph: every step's edges spelled out, its prompt on the step, nothing lost. Safe to run again. */
export function migrateTeam<T extends Pick<ChannelTeam, "roles" | "steps">>(team: T): T {
  if (!team.steps?.length) return team;
  const roles = team.roles ?? [];
  const steps = normalizeSteps(
    team.steps.map((s) => ({
      ...s,
      roleId: s.roleId ?? "",
      prompt: s.prompt ?? roles.find((r) => r.id === s.roleId)?.description,
    })),
  );
  return { ...team, steps };
}

export function isGraphTeam(team: { steps?: Pick<TeamStep, "nexts" | "inputs">[] }): boolean {
  return !!team.steps?.every((s) => s.nexts !== undefined && s.inputs !== undefined);
}

// --- checking ------------------------------------------------------------------------

/** What's wrong with a schedule box on its own, or null. */
export function scheduleProblem(s: Pick<TeamStep, "schedule" | "timezone" | "prompt">): string | null {
  if (!(s.prompt ?? "").trim()) return "Say what the schedule asks the team.";
  try {
    parseCron(s.schedule ?? "");
  } catch {
    return "Say when the schedule runs.";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone || "UTC" });
  } catch {
    return "The schedule's time zone isn't one Wisp knows.";
  }
  return null;
}

/** What's wrong with a team's roles and steps, in plain words, or null when they work. */
export function stepsProblem(team: Pick<ChannelTeam, "roles" | "steps">): string | null {
  const roles = team.roles ?? [];
  const steps = team.steps ?? [];
  if (!steps.length) return roles.length ? "Add at least one step." : null;
  if (steps.length > MAX_STEPS) return `A team can have at most ${MAX_STEPS} steps.`;
  const roleIds = new Set(roles.map((r) => r.id));
  if (roleIds.size !== roles.length) return "Two roles share an id.";
  if (roles.some((r) => !r.name.trim())) return "Every role needs a name.";
  const stepIds = new Set(steps.map((s) => s.id));
  if (stepIds.size !== steps.length) return "Two steps share an id.";
  const label = (s: TeamStep) => (s.action || "").trim() || roles.find((r) => r.id === s.roleId)?.name || "a step";
  const refs = (s: TeamStep) => [...(s.nexts ?? []), ...(s.next ? [s.next] : []), ...(s.inputs ?? [])];
  for (const s of steps) {
    const role = s.roleId ? roles.find((r) => r.id === s.roleId) : undefined;
    if (s.roleId && !role) return "A step belongs to a role that isn't on the team.";
    if (stepNeedsAgent(s) && !stepAgentId(team, s)) return role ? `Pick an agent for ${role.name}.` : `Pick an agent for “${label(s)}”.`;
    if (refs(s).some((r) => !stepIds.has(r)) || (s.next && !stepIds.has(s.next))) return "A step leads to a step that isn't there.";
    if (refs(s).includes(s.id)) return "A step can't lead to itself.";
    if (s.kind === "review") {
      if (!s.sendBackTo || !stepIds.has(s.sendBackTo)) return `Say where “${label(s)}” sends work back to.`;
      if (s.sendBackTo === s.id) return "A review can't send work back to itself.";
    }
    if (s.kind === "ask" && s.sendBackTo) {
      if (!stepIds.has(s.sendBackTo)) return `Say where “${label(s)}” sends work back to.`;
      if (s.sendBackTo === s.id) return "A step can't send work back to itself.";
    }
    if (s.kind === "hand_out") {
      if (!s.handTo?.length) return `Pick who “${label(s)}” hands pieces to.`;
      if (s.handTo.some((r) => !roleIds.has(r)) || (s.reviewBy && !roleIds.has(s.reviewBy))) return "A hand-out names a role that isn't on the team.";
      for (const r of [...s.handTo, ...(s.reviewBy ? [s.reviewBy] : [])]) {
        const rl = roles.find((x) => x.id === r)!;
        if (!rl.agentId) return `Pick an agent for ${rl.name}.`;
      }
    }
    if (s.kind === "handoff" && !s.handoffTo) return `Pick the team “${label(s)}” hands the work to.`;
    if (s.kind === "schedule") {
      const problem = scheduleProblem(s);
      if (problem) return problem;
    }
    if (s.kind === "branch") {
      if (!s.rule && !(s.condition ?? "").trim()) return `Say what “${label(s)}” checks for.`;
      if (s.rule && !s.rule.value.trim()) return `Say what “${label(s)}” looks for in the result.`;
      for (const t of [s.ifTrue, s.ifFalse]) {
        if (t && !stepIds.has(t)) return "A step leads to a step that isn't there.";
        if (t === s.id) return "A step can't lead to itself.";
      }
      if (!s.ifTrue && !s.ifFalse) return `Say where “${label(s)}” goes next.`;
    }
  }
  if (!steps.some((s) => s.kind !== "ask" && s.kind !== "handoff" && stepNeedsAgent(s))) return "Add at least one step that an agent does.";
  const g = stepGraph(steps);
  for (const s of steps) {
    if (s.kind !== "schedule") continue;
    if (g.ins.get(s.id)!.length) return "Nothing can lead to a schedule. It starts the steps its arrows point to.";
    if (!g.outs.get(s.id)!.length) return "Point the schedule at the steps it starts.";
  }
  if (steps.some((s) => g.back.get(s.id)!.some((t) => steps.find((x) => x.id === t)?.kind === "schedule"))) return "Work can't go back to a schedule.";
  // forward arrows never go round: loops go through a repeat, ask-me or if/else step
  const left = new Map(steps.map((s) => [s.id, g.ins.get(s.id)!.length]));
  const queue = steps.filter((s) => !left.get(s.id)).map((s) => s.id);
  let seen = 0;
  while (queue.length) {
    const x = queue.pop()!;
    seen++;
    for (const o of g.outs.get(x)!) {
      left.set(o, left.get(o)! - 1);
      if (!left.get(o)) queue.push(o);
    }
  }
  if (seen !== steps.length) return "The steps go round in a circle. To loop, use a repeat step with a limit, or an ask-me step.";
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) {
    for (const t of g.back.get(s.id)!) {
      // a loop goes back to a step before it
      if (!stepsAfter(steps, t).has(s.id)) return s.kind === "branch" ? `“${label(s)}” can only loop back to a step before it.` : `“${label(s)}” can only send work back to a step before it.`;
    }
  }
  // every cycle holds a repeat step (it has a max), an ask-me step (a person decides) or an if/else (it has a max too)
  for (const comp of cycles(steps, g)) if (!comp.some((id) => ["review", "ask", "branch"].includes(byId.get(id)!.kind))) return "The steps go round in a circle. To loop, use a repeat step with a limit, or an ask-me step.";
  // every step is reachable from a start
  const reach = new Set<string>();
  const stack = steps.filter((s) => !g.ins.get(s.id)!.length).map((s) => s.id);
  while (stack.length) {
    const x = stack.pop()!;
    if (reach.has(x)) continue;
    reach.add(x);
    stack.push(...g.outs.get(x)!, ...g.back.get(x)!);
  }
  if (reach.size !== steps.length) return "Every step needs to be reachable from the start.";
  return null;
}

/** The groups of steps that lead back to themselves (strongly connected, with loops counted). */
function cycles(steps: TeamStep[], g: StepGraph): string[][] {
  const next = (id: string) => [...g.outs.get(id)!, ...g.back.get(id)!];
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || next(v).includes(v)) out.push(comp);
    }
  };
  for (const s of steps) if (!idx.has(s.id)) visit(s.id);
  return out;
}

// --- the chart older apps see ---------------------------------------------------------

/**
 * The plain chart a stepped team also keeps, so older apps and the rest of Wisp see who's on it:
 * the first step's agent leads, everyone else gets work from it.
 */
export function chartFromSteps(team: Pick<ChannelTeam, "roles" | "steps">, old: ChannelTeamNode[] = []): Pick<ChannelTeam, "nodes" | "edges"> {
  const roles = team.roles ?? [];
  const steps = team.steps ?? [];
  const agentOf = (s: TeamStep) => stepAgentId(team, s);
  const first = stepOrder(steps).find((s) => agentOf(s)) ?? firstStep(steps);
  const leadId = (first && agentOf(first)) ?? null;
  const agentIds = uniq([...steps.map(agentOf), ...roles.map((r) => r.agentId)].filter((a): a is string => !!a));
  const nodes = agentIds.map((agentId, i) => {
    const was = old.find((n) => n.agentId === agentId);
    const names = uniq([...roles.filter((r) => r.agentId === agentId).map((r) => r.name.trim()), ...steps.filter((s) => agentOf(s) === agentId && !s.roleId).map((s) => (s.action || "").trim())].filter(Boolean));
    return { agentId, lead: agentId === leadId, x: was?.x ?? 24 + i * 212, y: was?.y ?? (agentId === leadId ? 24 : 156), role: names.join(", ").slice(0, 60) };
  });
  const edges = leadId ? agentIds.filter((a) => a !== leadId).map((to) => ({ from: leadId, to })) : [];
  return { nodes, edges };
}

export const STEP_W = 220;
export const STEP_H = 64;
export const STEP_ROW = 150;
export const STEP_GAP = 56;

/** Steps laid out top to bottom, a row for each step that has to wait for another; steps that run together sit side by side. */
export function layoutSteps<T extends Omit<TeamStep, "x" | "y"> & { x?: number; y?: number }>(steps: T[]): (T & { x: number; y: number })[] {
  const full = steps.map((s) => ({ ...s, x: s.x ?? 0, y: s.y ?? 0 })) as TeamStep[];
  const level = stepLevels(full);
  const rows = new Map<number, string[]>();
  for (const s of stepOrder(full)) rows.set(level.get(s.id)!, [...(rows.get(level.get(s.id)!) ?? []), s.id]);
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const [lv, row] of rows) row.forEach((id, i) => pos.set(id, { x: Math.round(((widest - row.length) / 2 + i) * (STEP_W + STEP_GAP)), y: lv * STEP_ROW }));
  return steps.map((s) => ({ ...s, ...pos.get(s.id)! }));
}

// --- plain English ----------------------------------------------------------------------

const VERBS = new Set(
  "plan research build draft write review check find fix test run read collect gather sort triage reproduce verify approve ship send deliver design create make summarize summarise analyze analyse compare study explore investigate prepare publish post update edit clean translate propose pick choose answer reply respond report hand split merge deploy release schedule book call email notify tell ask look search scan list rank score rewrite refactor implement develop code debug document outline brainstorm decide confirm validate monitor track measure label tag file open close assign sign pay order buy sell collect extract fetch pull push upload download share present explain teach polish format proofread fact-check challenge".split(" "),
);

function third(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh|o)$/i.test(word)) return word + "es";
  return word + "s";
}

const lcFirst = (s: string) => (s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1]) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const joinWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** "Plan the work" -> "plans the work", when the title starts with an everyday verb; null otherwise. */
export function titleAsVerb(title: string): { third: string; base: string } | null {
  const t = title.trim().replace(/[.!]+$/, "");
  const m = /^([A-Za-z-]+)(\b.*)$/s.exec(t);
  if (!m || !VERBS.has(m[1].toLowerCase())) return null;
  const w = m[1].toLowerCase();
  // "Find gaps, challenge the plan": each clause that starts with a verb agrees too
  const more = (rest: string, f: (v: string) => string) => rest.replace(/, ([A-Za-z-]+)\b/g, (all, v: string) => (VERBS.has(v.toLowerCase()) ? `, ${f(v.toLowerCase())}` : all));
  return { third: `${third(w)}${more(m[2], third)}`, base: `${w}${m[2]}` };
}

export interface FlowLine {
  stepId: string;
  /** 1-based, the order steps happen in */
  n: number;
  /** runs at the same time as the step before it */
  together: boolean;
  /** "Nova", "You", or the team it's handed to */
  who: string;
  /** the rest of the sentence, without the name */
  rest: string;
  /** the whole sentence */
  text: string;
}

/** How a team works, one plain line per step. `nameOf` gives an agent's name; `teamName` the name of a team by channel id. */
export function describeFlow(team: Pick<ChannelTeam, "roles" | "steps">, nameOf: (agentId: string | null) => string, teamName: (channelId: string) => string = () => "another"): FlowLine[] {
  const steps = (team.steps ?? []).filter((s) => s.kind !== "schedule");
  const order = stepOrder(steps);
  const num = (id: string | null | undefined) => order.findIndex((s) => s.id === id) + 1;
  const g = stepGraph(steps);
  const lines: FlowLine[] = [];
  for (const s of team.steps ?? []) {
    if (s.kind !== "schedule") continue;
    const starts = joinWords((s.nexts ?? []).map(num).filter(Boolean).sort((a, b) => a - b).map(String));
    const when = s.schedule ? describeCron(s.schedule).replace(/^Every/, "every") : "at its times";
    const rest = `${s.enabled === false ? "is off. When on, it starts" : "starts"} ${starts ? `step${starts.length > 1 ? "s" : ""} ${starts}` : "nothing yet"} ${when}`;
    lines.push({ stepId: s.id, n: 0, together: false, who: "Schedule", rest, text: `Schedule ${rest}.` });
  }
  let prevKey = "";
  for (const [i, s] of order.entries()) {
    const ins = g.ins.get(s.id)!;
    const key = ins.slice().sort().join(",");
    const together = i > 0 && key === prevKey;
    prevKey = key;
    const title = (s.action || "").trim();
    const agent = nameOf(stepAgentId(team, s));
    const what = ins.length ? (ins.length === 1 ? `the result of step ${num(ins[0])}` : `the results of steps ${joinWords(ins.map((x) => String(num(x))))}`) : "";
    const verb = titleAsVerb(title);
    let who = agent;
    let rest: string;
    if (s.kind === "ask") {
      who = "You";
      const v = /^(approve|check|review|confirm|decide|choose|pick|sign)\b/i.exec(title);
      rest = v ? lcFirst(title) : title ? `look at “${title}”` : "approve it";
      rest += v ? "" : ", then approve it or ask for changes";
      if (s.sendBackTo) rest += `. If you ask for changes it goes back to step ${num(s.sendBackTo)}`;
    } else if (s.kind === "handoff") {
      const t = s.handoffTo ? teamName(s.handoffTo) : "another";
      who = `The ${t} team`;
      rest = `gets the work${s.waitForReply ? ", and the next step waits for their answer" : ""}`;
    } else if (s.kind === "branch") {
      const test = s.rule ? `the result ${({ contains: "contains", not_contains: "doesn't contain", starts_with: "starts with", equals: "is" } as const)[s.rule.op]} “${s.rule.value}”` : (s.condition ?? "").trim();
      const yes = s.ifTrue ? `step ${num(s.ifTrue)}` : "the end";
      const no = s.ifFalse ? `step ${num(s.ifFalse)}` : "the end";
      rest = `${s.rule ? "checks" : "looks at"} ${what || "the work"}: if ${test}, it goes to ${yes}; if not, to ${no}`;
    } else if (s.kind === "review") {
      const max = s.maxRounds ?? DEFAULT_ROUNDS;
      rest = `${verb ? verb.third : "checks the work"}${what ? ` using ${what}` : ""}. If it isn't good enough it goes back to step ${num(s.sendBackTo)}, up to ${max} round${max === 1 ? "" : "s"}, then it asks you`;
    } else if (s.kind === "hand_out") {
      // the agents who really fill those roles, not the template's role names
      const who2 = (r: string) => {
        const role = team.roles?.find((x) => x.id === r);
        return role?.agentId ? nameOf(role.agentId) : null;
      };
      const names = [...new Set((s.handTo ?? []).map(who2).filter((n): n is string => !!n))];
      const checker = s.reviewBy ? who2(s.reviewBy) : null;
      rest = `${verb ? verb.third : "splits the work"}${names.length ? ` between ${joinWords(names)}` : ""}${checker ? `; ${checker} checks each piece` : ""}`;
    } else if (verb) {
      rest = what ? `uses ${what} to ${verb.base}` : verb.third;
    } else {
      rest = what ? `uses ${what} for “${title || "this step"}”` : `works on “${title || "this step"}”`;
    }
    const prefix = together ? "At the same time, " : "";
    lines.push({ stepId: s.id, n: i + 1, together, who, rest, text: `${prefix}${together ? who : who.charAt(0).toUpperCase() + who.slice(1)} ${rest}.` });
  }
  return lines;
}

/** How a step reads in a sentence: "Challenger: Find gaps, challenge the plan". */
export function stepLabel(step: TeamStep, roles: TeamRole[], agentName?: string | null): string {
  const role = roles.find((r) => r.id === step.roleId);
  const fallback = step.kind === "review" ? "Review" : step.kind === "hand_out" ? "Hand out the work" : step.kind === "ask" ? "Ask you" : step.kind === "handoff" ? "Hand off the work" : step.kind === "branch" ? "Decide where to go" : "Do the work";
  return `${role?.name ?? agentName ?? "Step"}: ${step.action || fallback}`;
}

/** Short names for the kinds, as the builder shows them. */
export const STEP_KIND_LABELS: Record<TeamStepKind, string> = {
  do: "Agent",
  review: "Repeat until approved",
  hand_out: "Split the work",
  ask: "Ask me",
  handoff: "Hand off to a team",
  branch: "If / else",
  custom: "Custom",
  schedule: "Schedule",
};

/** A ready-made team: its roles (unfilled), how they work together, and a sample of how it sounds. */
export interface TeamTemplate {
  id: string;
  name: string;
  blurb: string;
  roles: Omit<TeamRole, "agentId">[];
  steps: Omit<TeamStep, "x" | "y">[];
  /** a short example conversation: who says it (a role's name, or "You") and what */
  sample?: { who: string; text: string }[];
}

const RAW_TEMPLATES: TeamTemplate[] = [
  {
    id: "plan-challenge",
    name: "Plan and challenge",
    blurb: "A lead plans, a challenger pushes back until it approves, then the lead hands out the work.",
    roles: [
      { id: "lead", name: "Lead", harness: "claude-code", description: "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in." },
      { id: "challenger", name: "Challenger", harness: "codex", description: "You review the lead's plan before any work starts. Look for gaps, wrong assumptions, missing tests, security problems and anything the request asked for that the plan skips. Challenge it; don't rewrite it. Send it back with a numbered list, or approve it when it's ready." },
      { id: "backend", name: "Backend builder", harness: "codex", description: "You build the server, data and API pieces of an approved plan. Keep to the plan; if something in it can't work, say so in the thread instead of quietly doing something else." },
      { id: "frontend", name: "Frontend builder", harness: "kimi", description: "You build the screens of an approved plan. Match the look and patterns already in the app." },
      { id: "reviewer", name: "Reviewer", harness: "claude-code", description: "You review every finished piece: read the diff, run the tests, try it. Approve it, or send it back with exactly what needs to change. You never review work you built yourself." },
    ],
    steps: [
      { id: "plan", roleId: "lead", kind: "do", action: "Draft a thorough plan", next: "challenge" },
      { id: "challenge", roleId: "challenger", kind: "review", action: "Find gaps, challenge the plan", next: "hand-out", sendBackTo: "plan", maxRounds: 3 },
      { id: "hand-out", roleId: "lead", kind: "hand_out", action: "Hand out the pieces", next: "report", handTo: ["backend", "frontend"], reviewBy: "reviewer", maxRounds: 3 },
      { id: "report", roleId: "lead", kind: "do", action: "Report back", next: null },
    ],
  },
  {
    id: "build-review",
    name: "Build and review",
    blurb: "One builds, another harness reviews, a tester checks it runs.",
    roles: [
      { id: "builder", name: "Builder", harness: "codex", description: "You build what's asked, with tests, and say what you changed and how you checked it." },
      { id: "reviewer", name: "Reviewer", harness: "claude-code", description: "You read the builder's work as a skeptical senior engineer: correctness, edge cases, readability, security. Approve it or send it back with a numbered list." },
      { id: "tester", name: "Tester", harness: "gemini", description: "You run the thing for real, the way a person would use it, and report what works and what doesn't, with steps to reproduce." },
    ],
    steps: [
      { id: "build", roleId: "builder", kind: "do", action: "Build it", next: "review" },
      { id: "review", roleId: "reviewer", kind: "review", action: "Review the work", next: "test", sendBackTo: "build", maxRounds: 3 },
      { id: "test", roleId: "tester", kind: "review", action: "Try it for real", next: null, sendBackTo: "build", maxRounds: 2 },
    ],
  },
  {
    id: "research-desk",
    name: "Research desk",
    blurb: "Researcher digs, fact-checker verifies every claim, writer delivers.",
    roles: [
      { id: "researcher", name: "Researcher", harness: "claude-code", description: "You dig into the question using primary sources and collect findings with links. Say how sure you are of each one." },
      { id: "checker", name: "Fact-checker", harness: "codex", description: "You check every claim against its source. Anything unsupported, out of date or overstated goes back with a list." },
      { id: "writer", name: "Writer", harness: "claude-code", description: "You turn checked findings into a short, clear write-up for the person who asked, with the sources." },
    ],
    steps: [
      { id: "research", roleId: "researcher", kind: "do", action: "Research the question", next: "check" },
      { id: "check", roleId: "checker", kind: "review", action: "Check every claim", next: "write", sendBackTo: "research", maxRounds: 2 },
      { id: "write", roleId: "writer", kind: "do", action: "Write it up", next: null },
    ],
  },
  {
    id: "bug-squad",
    name: "Bug squad",
    blurb: "Reproduce, fix, verify. Nothing closes until the verifier sees it fixed.",
    roles: [
      { id: "reproducer", name: "Reproducer", harness: "claude-code", description: "You reproduce the bug reliably and write the exact steps, plus a failing test when you can." },
      { id: "fixer", name: "Fixer", harness: "codex", description: "You find the root cause and fix it, not the symptom. Make the failing test pass." },
      { id: "verifier", name: "Verifier", harness: "claude-code", description: "You follow the reproduction steps again on the fix. Approve only when the bug is gone and nothing nearby broke." },
    ],
    steps: [
      { id: "repro", roleId: "reproducer", kind: "do", action: "Reproduce the bug", next: "fix" },
      { id: "fix", roleId: "fixer", kind: "do", action: "Fix the root cause", next: "verify" },
      { id: "verify", roleId: "verifier", kind: "review", action: "Verify the fix", next: null, sendBackTo: "fix", maxRounds: 3 },
    ],
  },
  {
    id: "support-queue",
    name: "Support queue",
    blurb: "Triage sorts, responder drafts, a checker reads every reply before it goes out.",
    roles: [
      { id: "triage", name: "Triage", harness: "claude-code", description: "You read each request, work out what's actually being asked and how urgent it is, and gather what the responder needs." },
      { id: "responder", name: "Responder", harness: "claude-code", description: "You draft the reply in the person's voice. Anything about money, refunds or contracts gets flagged for a person instead." },
      { id: "checker", name: "Checker", harness: "codex", description: "You read every draft before it goes anywhere: is it right, kind and complete? Approve it or send it back." },
    ],
    steps: [
      { id: "triage", roleId: "triage", kind: "do", action: "Sort the request", next: "draft" },
      { id: "draft", roleId: "responder", kind: "do", action: "Draft the reply", next: "check" },
      { id: "check", roleId: "checker", kind: "review", action: "Check the draft", next: null, sendBackTo: "draft", maxRounds: 2 },
    ],
  },
  {
    id: "release-crew",
    name: "Release crew",
    blurb: "A planner and a researcher work side by side, a builder uses both, and you approve before it ships.",
    roles: [
      { id: "planner", name: "Planner", harness: "claude-code", description: "You turn the request into a short plan: what changes, in what order, and what could go wrong." },
      { id: "researcher", name: "Researcher", harness: "gemini", description: "You look into the options for the request, compare them, and say which you'd pick and why. Keep it short, with links." },
      { id: "builder", name: "Builder", harness: "codex", description: "Build the feature from the plan and the research. Keep changes small and add tests." },
    ],
    steps: [
      { id: "plan", roleId: "planner", kind: "do", action: "Plan the work", next: null },
      { id: "research", roleId: "researcher", kind: "do", action: "Research the options", next: null },
      { id: "build", roleId: "builder", kind: "do", action: "Build it", next: null, inputs: ["plan", "research"] },
      { id: "approve", roleId: "", kind: "ask", action: "Approve before it ships", next: null, inputs: ["build"], sendBackTo: "build", show: "The finished build and a short summary of what changed." },
    ],
  },
];

const SAMPLES: Record<string, { who: string; text: string }[]> = {
  "plan-challenge": [
    { who: "You", text: "Add a waitlist page to the site." },
    { who: "Lead", text: "Here's the plan: a /waitlist page, a POST endpoint, and an emails table. Risks: spam signups." },
    { who: "Challenger", text: "Sending it back: 1. No rate limit. 2. Nothing says how duplicates are handled." },
    { who: "Lead", text: "Updated: limit of 5 signups an hour per address, duplicates ignored." },
    { who: "Challenger", text: "Approved. Hand it out." },
  ],
  "build-review": [
    { who: "You", text: "Make the settings page remember the last tab." },
    { who: "Builder", text: "Done: saved the tab in local storage, added a test." },
    { who: "Reviewer", text: "Sending it back: it breaks when storage is blocked." },
    { who: "Builder", text: "Fixed, and added a test for blocked storage." },
    { who: "Tester", text: "Tried it in two browsers. It works." },
  ],
  "research-desk": [
    { who: "You", text: "Which password managers work with our setup?" },
    { who: "Researcher", text: "Three do: A, B and C. Sources attached, B is the least certain." },
    { who: "Fact-checker", text: "The claim about B is out of date. Please recheck." },
    { who: "Writer", text: "Here's the short write-up with the three options and sources." },
  ],
  "bug-squad": [
    { who: "You", text: "Uploads fail on large files." },
    { who: "Reproducer", text: "Reproduced with a 60 MB file. Added a failing test." },
    { who: "Fixer", text: "The proxy cut the body at 50 MB. Raised it and the test passes." },
    { who: "Verifier", text: "Followed the steps again. The bug is gone." },
  ],
  "support-queue": [
    { who: "You", text: "A customer says they were charged twice." },
    { who: "Triage", text: "Urgent. Billing question, order #4821, two charges on the same day." },
    { who: "Responder", text: "Drafted a reply and flagged the refund for a person." },
    { who: "Checker", text: "Approved. It's kind and complete." },
  ],
  "release-crew": [
    { who: "You", text: "Ship dark mode for the dashboard." },
    { who: "Planner", text: "Plan: tokens first, then the charts, then the settings toggle." },
    { who: "Researcher", text: "At the same time: two libraries handle theming. I'd pick the smaller one." },
    { who: "Builder", text: "Built it using both. All tests pass." },
    { who: "You", text: "Approved. Ship it." },
  ],
};

/** A template as a graph: every step's edges spelled out and its prompt on the step. */
export function migrateTemplate(t: TeamTemplate): TeamTemplate {
  const roles = t.roles;
  const steps = normalizeSteps(t.steps.map((s) => ({ ...s, x: 0, y: 0, prompt: s.prompt ?? roles.find((r) => r.id === s.roleId)?.description, harness: s.harness ?? roles.find((r) => r.id === s.roleId)?.harness })) as TeamStep[]).map(({ x: _x, y: _y, ...s }) => s);
  return { ...t, steps, sample: t.sample ?? SAMPLES[t.id] };
}

export const TEAM_TEMPLATES: TeamTemplate[] = RAW_TEMPLATES.map(migrateTemplate);

/** A template's roles and steps, ready to fill in, with the steps laid out on the chart (older apps: who fills each role is chosen after). */
export function teamFromTemplate(t: Pick<TeamTemplate, "roles" | "steps">): { roles: TeamRole[]; steps: TeamStep[] } {
  return { roles: t.roles.map((r) => ({ ...r, agentId: null })), steps: layoutSteps(t.steps.map((s) => ({ ...s, x: 0, y: 0 }))) };
}

/**
 * A template as steps that each name their own agent (left empty to fill in). Prompts come along.
 * Roles are left behind, except the ones a split-the-work step hands pieces to.
 */
export function graphFromTemplate(t: Pick<TeamTemplate, "roles" | "steps">, agentFor: (hint: { harness?: string; roleName: string; index: number }) => string | null = () => null): { roles: TeamRole[]; steps: TeamStep[] } {
  const kept = new Set(t.steps.flatMap((s) => (s.kind === "hand_out" ? [...(s.handTo ?? []), ...(s.reviewBy ? [s.reviewBy] : [])] : [])));
  const roles = t.roles.filter((r) => kept.has(r.id)).map((r, index) => ({ ...r, agentId: agentFor({ harness: r.harness, roleName: r.name, index }) }));
  const steps = layoutSteps(t.steps.map((s, index) => ({ ...s, x: 0, y: 0, roleId: "", agentId: stepNeedsAgent(s) ? agentFor({ harness: s.harness, roleName: t.roles.find((r) => r.id === s.roleId)?.name ?? "", index }) : null })));
  return { roles, steps };
}

/** A team's steps as a template someone else can start from: who filled them is left out. */
export function templateFromTeam(team: Pick<ChannelTeam, "roles" | "steps">, name: string, blurb = ""): TeamTemplate {
  return {
    id: `own-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team"}`,
    name,
    blurb,
    roles: (team.roles ?? []).map(({ agentId: _a, ...r }) => r),
    steps: (team.steps ?? []).map(({ x: _x, y: _y, agentId: _g, handoffTo: _h, scheduledBy: _b, ...s }) => ({ ...s, ...(s.kind === "handoff" ? { handoffTo: null } : {}) })),
  };
}

/** One piece of a hand-out, by the first task for it. */
export interface TeamFlowPiece {
  taskId: string;
  agentId: string | null;
  title: string;
  rounds: number;
  reviewTaskId: string | null;
  /** the latest task that built it, and the latest review of it */
  lastTaskId?: string;
  lastReviewId?: string;
  status: "building" | "reviewing" | "approved" | "failed";
  /** why a failed piece waits for a person, and what trying again redoes */
  problem?: { why: string; options: "retry" | "rounds"; redo: "build" | "review"; failed?: boolean };
}

/** What a waiting request asks of a person. "ask" = an ask-me step, answered from the Inbox. */
export interface FlowWaiting {
  why: string;
  options: "retry" | "rounds" | "ask";
  /** the step (or its hand-over) ran and failed: offer Try again or Skip, never Approve */
  failed?: boolean;
  /** a review step that would be done by the agent whose work it reviews: the person picks another agent, or lets it go ahead */
  selfReview?: { agent: string };
  /** `piece` when it's one piece of a hand-out that needs a person, not the whole step */
  piece?: string;
}

/** What a step was handed (kept so it can run again). */
export interface FlowCarry {
  from: string;
  text: string;
  sentBack?: boolean;
}

/** One step's run in a request: a request has one for every step that has started (steps that run together each have their own). */
export interface FlowLane {
  stepId: string;
  /** skipped = an if/else went the other way */
  status: "running" | "waiting" | "done" | "skipped";
  /** the step's task (an ask-me or hand-off step has none) */
  taskId: string | null;
  carry: FlowCarry | null;
  pieces: Record<string, TeamFlowPiece>;
  pieceOf?: Record<string, string>;
  waitingFor: FlowWaiting | null;
  /** what the step produced, passed on to the steps that use it */
  result?: string;
  /** ask-me: the Inbox card */
  approvalId?: string | null;
  /** hand-off: the other team's request */
  handoff?: { channelId: string; flowId: string | null };
  /** if / else: which way it went */
  chose?: "yes" | "no";
}

export interface TeamFlow {
  id: string;
  workspaceId: string;
  channelId: string;
  /** the schedule box that started it, if one did */
  scheduleId?: string;
  /** the person's message; the steps happen in its thread */
  threadId: string;
  /** waiting = a person has to decide (rounds ran out, a run failed, a role has nobody, an ask-me step) */
  status: "running" | "waiting" | "done" | "failed";
  request: string;
  requestedBy: string | null;
  /** the step it's on now (with several running together, the one that needs a person first); `lanes` has them all */
  stepId: string;
  /** the current step's task */
  taskId: string | null;
  /** how many times each step has run */
  rounds: Record<string, number>;
  carry?: FlowCarry | null;
  history: { stepId: string; taskId: string; round: number; verdict: "done" | "approved" | "changes" | "failed" | null; at: string }[];
  /** a hand-out's pieces, by the first task of each */
  pieces: Record<string, TeamFlowPiece>;
  /** follow-up tasks, by the piece they belong to */
  pieceOf?: Record<string, string>;
  waitingFor: FlowWaiting | null;
  /** review steps a person said may be done by the author of the work */
  selfReviewOk?: string[];
  /** every step that has started, by step id */
  lanes?: Record<string, FlowLane>;
  /** what the last steps produced, once it's done */
  result?: string;
  /** how many teams deep this request was handed on */
  depth?: number;
  createdAt: string;
  updatedAt: string;
}

/** A flowchart an agent drew from a sentence, before anyone creates it. */
export interface TeamDraft {
  id: string;
  status: "working" | "ready" | "failed";
  description: string;
  agentId: string;
  /** what the agent called the team, if it did */
  name?: string;
  steps?: TeamStep[];
  /** how it works, one line per step */
  lines?: FlowLine[];
  problem?: string;
}

/** What a team's newest request says about it, for the Inbox: never "quiet" when it failed. */
export type TeamRunState = { state: "working" | "failed" | "needs-you" | "stopped" | "quiet"; text: string };

export function teamRunState(flows: Pick<TeamFlow, "status" | "waitingFor" | "lanes">[], busyName?: string | null): TeamRunState {
  const latest = flows[0];
  if (latest && (latest.status === "waiting" || latest.status === "running")) {
    // steps that run together each have a lane: one failed step shows even while the others still work
    const waiting = Object.values(latest.lanes ?? {}).filter((l) => l.status === "waiting");
    const failed = latest.waitingFor?.failed || waiting.some((l) => l.waitingFor?.failed);
    if (failed) return { state: "failed", text: "Failed · a step didn't finish. Try again or skip it" };
    if (latest.status === "waiting" || waiting.length) return { state: "needs-you", text: "Waiting for you" };
  }
  if (latest?.status === "running") return { state: "working", text: busyName ? `Working · ${busyName} is on it` : "Working" };
  if (latest?.status === "failed") return { state: "stopped", text: "Stopped · the last request didn't finish" };
  if (busyName != null) return { state: "working", text: busyName ? `Working · ${busyName} is on it` : "Working" };
  return { state: "quiet", text: "Quiet" };
}
