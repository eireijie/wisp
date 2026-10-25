import type { ChannelTeam, ChannelTeamNode } from "./types.ts";

/**
 * A job on a channel's team: what it's called, what it does (every agent on the team reads this),
 * and who does it. One agent can fill several roles.
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
 * - do: the role does the step and reports the result
 * - review: the role approves (on to the next step) or sends it back to an earlier step
 * - hand_out: the role splits the work into pieces for other roles; each piece can be reviewed
 */
export type TeamStepKind = "do" | "review" | "hand_out";

/** One box on a team's flow chart. A new message in the channel starts at the first step. */
export interface TeamStep {
  id: string;
  roleId: string;
  kind: TeamStepKind;
  /** what the role does here, e.g. "Draft a thorough plan" */
  action: string;
  /** the step after this one (after approval, for a review); null = the flow ends here */
  next: string | null;
  /** review: the step that gets the work back with the notes when changes are needed */
  sendBackTo?: string | null;
  /** review (and a hand-out's piece reviews): rounds of changes before it asks a person */
  maxRounds?: number;
  /** hand_out: the roles the pieces go to */
  handTo?: string[];
  /** hand_out: the role that checks each piece; changes go back to whoever built it */
  reviewBy?: string | null;
  /** where it sits on the chart */
  x: number;
  y: number;
}

export const DEFAULT_ROUNDS = 3;
export const MAX_ROUNDS_LIMIT = 10;

/** A team that runs on roles and steps rather than a plain chart of who hands work to whom. */
export function hasSteps(team: Pick<ChannelTeam, "roles" | "steps"> | null | undefined): boolean {
  return !!team?.roles?.length && !!team.steps?.length;
}

/** The first step: a step no other step leads to, else the first one listed. */
export function firstStep(steps: TeamStep[]): TeamStep | undefined {
  const pointed = new Set(steps.flatMap((s) => [s.next]).filter(Boolean));
  return steps.find((s) => !pointed.has(s.id)) ?? steps[0];
}

/** The steps from the first one along `next`, in order (each once). */
export function stepOrder(steps: TeamStep[]): TeamStep[] {
  const out: TeamStep[] = [];
  let s = firstStep(steps);
  while (s && !out.includes(s)) {
    out.push(s);
    const nextId: string | null = s.next;
    s = nextId ? steps.find((x) => x.id === nextId) : undefined;
  }
  return out;
}

/** What's wrong with a team's roles and steps, in plain words, or null when they work. */
export function stepsProblem(team: Pick<ChannelTeam, "roles" | "steps">): string | null {
  const roles = team.roles ?? [];
  const steps = team.steps ?? [];
  if (!roles.length && !steps.length) return null;
  if (!roles.length) return "Add at least one role.";
  if (!steps.length) return "Add at least one step.";
  const roleIds = new Set(roles.map((r) => r.id));
  if (roleIds.size !== roles.length) return "Two roles share an id.";
  if (roles.some((r) => !r.name.trim())) return "Every role needs a name.";
  const stepIds = new Set(steps.map((s) => s.id));
  if (stepIds.size !== steps.length) return "Two steps share an id.";
  for (const s of steps) {
    const role = roles.find((r) => r.id === s.roleId);
    if (!role) return "A step belongs to a role that isn't on the team.";
    if (!role.agentId) return `Pick an agent for ${role.name}.`;
    if (s.next && !stepIds.has(s.next)) return "A step leads to a step that isn't there.";
    if (s.next === s.id) return "A step can't lead to itself.";
    if (s.kind === "review") {
      if (!s.sendBackTo || !stepIds.has(s.sendBackTo)) return `Say where “${s.action || role.name}” sends work back to.`;
      if (s.sendBackTo === s.id) return "A review can't send work back to itself.";
    }
    if (s.kind === "hand_out") {
      if (!s.handTo?.length) return `Pick who “${s.action || role.name}” hands pieces to.`;
      if (s.handTo.some((r) => !roleIds.has(r)) || (s.reviewBy && !roleIds.has(s.reviewBy))) return "A hand-out names a role that isn't on the team.";
      for (const r of [...s.handTo, ...(s.reviewBy ? [s.reviewBy] : [])]) {
        const role = roles.find((x) => x.id === r)!;
        if (!role.agentId) return `Pick an agent for ${role.name}.`;
      }
    }
  }
  // following `next` from the first step reaches every step, with no circle (loops go through "send back")
  const order = stepOrder(steps);
  const last = order.at(-1);
  if (last?.next) return "The steps go round in a circle. Use a review's “send back” for loops.";
  if (order.length !== steps.length) return "Every step needs to be reachable from the first one.";
  return null;
}

/**
 * The plain chart a stepped team also keeps, so older apps and the rest of Wisp see who's on it:
 * the first step's agent leads, everyone else gets work from it.
 */
export function chartFromSteps(team: Pick<ChannelTeam, "roles" | "steps">, old: ChannelTeamNode[] = []): Pick<ChannelTeam, "nodes" | "edges"> {
  const roles = team.roles ?? [];
  const first = firstStep(team.steps ?? []);
  const leadId = roles.find((r) => r.id === first?.roleId)?.agentId ?? roles.find((r) => r.agentId)?.agentId ?? null;
  const agentIds = [...new Set(roles.map((r) => r.agentId).filter((a): a is string => !!a))];
  const nodes = agentIds.map((agentId, i) => {
    const was = old.find((n) => n.agentId === agentId);
    const names = roles.filter((r) => r.agentId === agentId).map((r) => r.name.trim());
    return { agentId, lead: agentId === leadId, x: was?.x ?? 24 + i * 212, y: was?.y ?? (agentId === leadId ? 24 : 156), role: names.join(", ").slice(0, 60) };
  });
  const edges = leadId ? agentIds.filter((a) => a !== leadId).map((to) => ({ from: leadId, to })) : [];
  return { nodes, edges };
}

/** Steps laid out top to bottom in flow order; a review sits beside the step it sends back to. */
export function layoutSteps(steps: TeamStep[]): TeamStep[] {
  const order = stepOrder(steps);
  const rest = steps.filter((s) => !order.includes(s));
  let row = 0;
  const placed = new Map<string, { x: number; y: number }>();
  for (const s of [...order, ...rest]) {
    const back = s.kind === "review" && s.sendBackTo ? placed.get(s.sendBackTo) : undefined;
    if (back && back.y === (row - 1) * STEP_ROW) placed.set(s.id, { x: back.x + STEP_W + 120, y: back.y });
    else {
      placed.set(s.id, { x: 0, y: row * STEP_ROW });
      // a hand-out's pieces (and whoever checks them) are drawn under it
      row += 1 + (s.kind === "hand_out" ? (s.handTo?.length ? 1 : 0) + (s.reviewBy ? 1 : 0) : 0);
    }
  }
  return steps.map((s) => ({ ...s, ...placed.get(s.id)! }));
}

export const STEP_W = 220;
export const STEP_H = 64;
export const STEP_ROW = 150;

/** A ready-made team: its roles (unfilled) and how they work together. */
export interface TeamTemplate {
  id: string;
  name: string;
  blurb: string;
  roles: Omit<TeamRole, "agentId">[];
  steps: Omit<TeamStep, "x" | "y">[];
}

export const TEAM_TEMPLATES: TeamTemplate[] = [
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
];

/** A template's roles and steps, ready to fill in, with the steps laid out on the chart. */
export function teamFromTemplate(t: Pick<TeamTemplate, "roles" | "steps">): { roles: TeamRole[]; steps: TeamStep[] } {
  return { roles: t.roles.map((r) => ({ ...r, agentId: null })), steps: layoutSteps(t.steps.map((s) => ({ ...s, x: 0, y: 0 }))) };
}

/** A team's roles and steps as a template someone else can start from: who filled them is left out. */
export function templateFromTeam(team: Pick<ChannelTeam, "roles" | "steps">, name: string, blurb = ""): TeamTemplate {
  return {
    id: `own-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team"}`,
    name,
    blurb,
    roles: (team.roles ?? []).map(({ agentId: _a, ...r }) => r),
    steps: (team.steps ?? []).map(({ x: _x, y: _y, ...s }) => s),
  };
}

/** How a step reads in a sentence: "Challenger: Find gaps, challenge the plan". */
export function stepLabel(step: TeamStep, roles: TeamRole[]): string {
  const role = roles.find((r) => r.id === step.roleId);
  return `${role?.name ?? "?"}: ${step.action || (step.kind === "review" ? "Review" : step.kind === "hand_out" ? "Hand out the work" : "Do the work")}`;
}

/** One request going through a stepped team: where it is, and what happened so far. */
export interface TeamFlow {
  id: string;
  workspaceId: string;
  channelId: string;
  /** the person's message; the steps happen in its thread */
  threadId: string;
  /** waiting = a person has to decide (rounds ran out, a run failed, a role has nobody) */
  status: "running" | "waiting" | "done" | "failed";
  request: string;
  requestedBy: string | null;
  stepId: string;
  /** the current step's task */
  taskId: string | null;
  /** how many times each step has run */
  rounds: Record<string, number>;
  /** what the current step was handed (kept so it can run again) */
  carry?: { from: string; text: string; sentBack?: boolean } | null;
  history: { stepId: string; taskId: string; round: number; verdict: "done" | "approved" | "changes" | "failed" | null; at: string }[];
  /** a hand-out's pieces, by the first task of each */
  pieces: Record<string, { taskId: string; agentId: string | null; title: string; rounds: number; reviewTaskId: string | null; lastTaskId?: string; status: "building" | "reviewing" | "approved" | "failed" }>;
  /** follow-up tasks, by the piece they belong to */
  pieceOf?: Record<string, string>;
  waitingFor: { why: string; options: "retry" | "rounds" } | null;
  createdAt: string;
  updatedAt: string;
}
