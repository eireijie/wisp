import {
  DEFAULT_ROUNDS,
  migrateTeam,
  stepAgentId,
  stepGraph,
  stepLabel,
  stepOrder,
  stepPrompt,
  stepsAfter,
  startSteps,
  workSteps,
  type Actor,
  type ChannelTeam,
  type FlowCarry,
  type FlowLane,
  type FlowWaiting,
  type Message,
  type TeamFlow,
  type TeamFlowPiece,
  type TeamStep,
} from "@wisp/core";
import { id } from "./auth.ts";
import type { Hub } from "./hub.ts";

type Task = NonNullable<ReturnType<Hub["store"]["task"]>>;
type Agent = NonNullable<ReturnType<Hub["store"]["agent"]>>;

/** How a step's task is handed out; api.ts gives the hub its delegate so tasks look like any other. */
export type Delegate = (o: {
  workspaceId: string;
  author: Actor;
  from: Actor;
  target: Agent;
  title: string;
  brief: string;
  channelId: string;
  hop: number;
  reviewOf?: string | null;
  parentId?: string | null;
  branch?: string | null;
  threadId?: string | null;
  onBehalfOf: string | null;
}) => Task;

const SYSTEM: Actor = { kind: "user", id: "system" };
const STEPS_CHANGED = "The team's steps changed, so this request stopped. Send it again to start over with the new steps.";
/** Teams handing work to each other, at most this many deep. */
const MAX_DEPTH = 3;

/** What makes a step the same step to a running request (where it sits in the chart, and its wording, don't). */
const stepShape = (s: TeamStep) => JSON.stringify([s.kind, s.roleId, s.action, s.sendBackTo ?? null, s.handTo ?? null, s.reviewBy ?? null, s.handoffTo ?? null, s.rule ?? null, s.condition ?? null, s.ifTrue ?? null, s.ifFalse ?? null]);

type Row = { id: string; workspace_id: string; channel_id: string; thread_id: string; status: string; state_json: string; created_at: string; updated_at: string };

const live = (l: FlowLane) => l.status === "running" || l.status === "waiting";

/**
 * Runs a team's flow chart. A person's new message in the channel starts every step nothing leads
 * to, all at once. Each step is a task for its agent (or a question for a person, a request to
 * another team, a yes/no decision). A step with several inputs waits for all of them and gets their
 * results; a repeat step approves or sends the work back (up to its rounds, then a person decides);
 * a hand-out's pieces each get checked before the flow moves on. Wisp moves the work along, not
 * the agents.
 */
export class TeamFlows {
  delegate: Delegate | null = null;
  /** requests that are still starting their first steps (so a quick first step doesn't end them early) */
  private starting = new Set<string>();

  constructor(private hub: Hub) {
    hub.store.db.exec(`CREATE TABLE IF NOT EXISTS team_flows (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      status TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_flows_channel ON team_flows(channel_id, created_at);`);
  }

  // --- storage ---------------------------------------------------------------------

  /** The flow's top-level step, task, pieces and question follow the lane that matters most, for apps that show one step. */
  private mirror(f: TeamFlow) {
    const lanes = Object.values(f.lanes ?? {});
    const focus = lanes.find((l) => l.status === "waiting") ?? lanes.find((l) => l.status === "running") ?? lanes.at(-1);
    if (!focus) return;
    f.stepId = focus.stepId;
    f.taskId = focus.taskId;
    f.carry = focus.carry;
    f.pieces = focus.pieces;
    f.pieceOf = focus.pieceOf;
    f.waitingFor = focus.status === "waiting" ? focus.waitingFor : null;
  }

  /** running while any step works; waiting when only people can move it on. */
  private settle(f: TeamFlow) {
    if (f.status === "done" || f.status === "failed") return;
    const lanes = Object.values(f.lanes ?? {});
    f.status = lanes.some((l) => l.status === "running") ? "running" : lanes.some((l) => l.status === "waiting") ? "waiting" : f.status;
  }

  private save(f: TeamFlow) {
    f.updatedAt = new Date().toISOString();
    this.settle(f);
    this.mirror(f);
    const { id: fid, workspaceId, channelId, threadId, status, createdAt, updatedAt, ...state } = f;
    this.hub.store.db
      .prepare("INSERT INTO team_flows (id, workspace_id, channel_id, thread_id, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, state_json = excluded.state_json, updated_at = excluded.updated_at")
      .run(fid, workspaceId, channelId, threadId, status, JSON.stringify(state), createdAt, updatedAt);
    this.hub.broadcast(workspaceId, { type: "flows_changed", channelId });
  }

  private row(r: Row): TeamFlow {
    const f = { ...(JSON.parse(r.state_json) as Omit<TeamFlow, "id">), id: r.id, workspaceId: r.workspace_id, channelId: r.channel_id, threadId: r.thread_id, status: r.status as TeamFlow["status"], createdAt: r.created_at, updatedAt: r.updated_at };
    if (!f.lanes) {
      // a request that began before steps could run together: its history and current step become lanes
      const lanes: Record<string, FlowLane> = {};
      // a review that sent work back is in history already, but it has to run again: only what comes before the current step is done
      const team = this.team(f);
      const later = team ? stepsAfter(team.steps, f.stepId) : new Set<string>();
      for (const h of f.history) {
        if (h.stepId === f.stepId || later.has(h.stepId)) continue;
        lanes[h.stepId] = { stepId: h.stepId, status: "done", taskId: h.taskId, carry: null, pieces: {}, waitingFor: null, result: this.hub.store.task(h.taskId)?.result ?? undefined };
      }
      const open = f.status === "running" || f.status === "waiting";
      lanes[f.stepId] = { stepId: f.stepId, status: f.status === "waiting" ? "waiting" : open ? "running" : "done", taskId: f.taskId, carry: f.carry ?? null, pieces: f.pieces ?? {}, pieceOf: f.pieceOf, waitingFor: f.waitingFor, ...(f.taskId && !open ? { result: this.hub.store.task(f.taskId)?.result ?? undefined } : {}) };
      f.lanes = lanes;
    }
    return f;
  }

  flow(flowId: string): TeamFlow | undefined {
    const r = this.hub.store.db.prepare("SELECT * FROM team_flows WHERE id = ?").get(flowId) as Row | undefined;
    return r && this.row(r);
  }

  /** An ask-me step set to "Tell me on my phone: off" keeps its approval in the Inbox but sends no notification. */
  silentApproval(approval: { flow?: { flowId: string; stepId: string } | null }): boolean {
    const ref = approval.flow;
    const f = ref && this.flow(ref.flowId);
    const team = f ? this.team(f) : null;
    return team?.steps.find((s) => s.id === ref!.stepId)?.notifyPhone === false;
  }

  /** A channel's flows, newest first. */
  flows(channelId: string, limit = 50): TeamFlow[] {
    return (this.hub.store.db.prepare("SELECT * FROM team_flows WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?").all(channelId, limit) as Row[]).map((r) => this.row(r));
  }

  private active(workspaceId: string): TeamFlow[] {
    return (this.hub.store.db.prepare("SELECT * FROM team_flows WHERE workspace_id = ? AND status IN ('running', 'waiting')").all(workspaceId) as Row[]).map((r) => this.row(r));
  }

  // --- the team ----------------------------------------------------------------------

  private team(f: Pick<TeamFlow, "channelId">): (ChannelTeam & { steps: TeamStep[] }) | null {
    const t = this.hub.store.channel(f.channelId)?.settings.team ?? null;
    return t?.steps?.length ? (migrateTeam(t) as ChannelTeam & { steps: TeamStep[] }) : null;
  }

  private agentFor(team: ChannelTeam, step: TeamStep | undefined): Agent | undefined {
    const agentId = step && stepAgentId(team, step);
    return agentId ? this.hub.store.agent(agentId) : undefined;
  }

  /** Who a step is, in words: its role, else its agent, else its title. */
  private who(team: ChannelTeam, step: TeamStep | undefined): string {
    if (!step) return "someone";
    return team.roles?.find((r) => r.id === step.roleId)?.name ?? this.agentFor(team, step)?.name ?? (step.action.trim() || "someone");
  }

  private title(team: ChannelTeam, step: TeamStep): string {
    return step.action.trim() || stepLabel(step, team.roles ?? [], this.agentFor(team, step)?.name);
  }

  // --- running -----------------------------------------------------------------------

  /** Does this channel run new messages through its steps? */
  runsSteps(channel: { kind: string; archivedAt: string | null; settings: { team: ChannelTeam | null } } | undefined): boolean {
    return !!channel && channel.kind === "channel" && !channel.archivedAt && !!channel.settings.team?.steps?.length;
  }

  /** Is this schedule's last run still going? */
  scheduleBusy(channelId: string, scheduleId: string): boolean {
    return this.flows(channelId).some((f) => f.scheduleId === scheduleId && (f.status === "running" || f.status === "waiting"));
  }

  /**
   * A new message in a stepped channel: start every step nothing leads to, in a thread under it.
   * With `scheduleId` a schedule box started it: only what its arrows lead to runs, and a step
   * that also waits for something this run won't reach goes on with what it gets.
   */
  start(msg: Message, workspaceId: string, requestedBy: string | null, depth = 0, scheduleId?: string): TeamFlow | null {
    const channel = this.hub.store.channel(msg.channelId);
    const team = channel?.settings.team?.steps?.length ? (migrateTeam(channel.settings.team) as ChannelTeam & { steps: TeamStep[] }) : null;
    const starters = team && !scheduleId ? startSteps(team.steps) : [];
    if (!channel || !team || (!scheduleId && !starters.length)) return null;
    const now = new Date().toISOString();
    const f: TeamFlow = {
      id: id("flow"),
      workspaceId,
      channelId: channel.id,
      threadId: msg.id,
      status: "running",
      request: msg.body,
      requestedBy,
      stepId: starters[0]?.id ?? scheduleId!,
      ...(scheduleId ? { scheduleId } : {}),
      taskId: null,
      rounds: {},
      history: [],
      pieces: {},
      waitingFor: null,
      lanes: {},
      depth,
      createdAt: now,
      updatedAt: now,
    };
    this.starting.add(f.id);
    try {
      // schedules do no work: the arrows of the one that fired (of all of them, for a message) are already open, the others never will be
      for (const s of team.steps) if (s.kind === "schedule") f.lanes![s.id] = { stepId: s.id, status: !scheduleId || s.id === scheduleId ? "done" : "skipped", taskId: null, carry: null, pieces: {}, waitingFor: null };
      if (scheduleId) {
        const g = stepGraph(team.steps);
        for (const s of team.steps) if (!g.ins.get(s.id)!.length && !f.lanes![s.id]) this.skip(f, team, s.id);
      }
      for (const s of starters) if (!f.lanes![s.id]) this.runStep(f, s, null);
    } finally {
      this.starting.delete(f.id);
    }
    this.afterMove(f);
    return this.flow(f.id) ?? f;
  }

  /** What the steps feeding this one produced, as one thing to hand it. */
  private carryFor(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, step: TeamStep): FlowCarry | null {
    const g = stepGraph(team.steps);
    const ins = (g.ins.get(step.id) ?? []).map((i) => ({ step: team.steps.find((s) => s.id === i)!, lane: f.lanes?.[i] })).filter((x) => x.lane?.status === "done" && x.lane.result !== undefined);
    if (!ins.length) return null;
    if (ins.length === 1) return { from: this.who(team, ins[0].step), text: ins[0].lane!.result || "(no result given)" };
    return { from: ins.map((x) => this.who(team, x.step)).join(" and "), text: ins.map((x) => `**${this.title(team, x.step)}** (${this.who(team, x.step)}):\n${x.lane!.result || "(no result given)"}`).join("\n\n") };
  }

  /** Start a step: a new lane, and whatever the kind needs (a task, a question for a person, a message to another team). */
  private runStep(f: TeamFlow, step: TeamStep, carry: FlowCarry | null): void {
    const team = this.team(f);
    const lane: FlowLane = { stepId: step.id, status: "running", taskId: null, carry, pieces: {}, waitingFor: null };
    (f.lanes ??= {})[step.id] = lane;
    f.stepId = step.id;
    if (!team) return this.waitLane(f, lane, "This team's steps are gone.", "retry");
    f.status = f.status === "waiting" ? "running" : f.status;
    if (step.kind === "ask") return this.askPerson(f, team, step, lane);
    if (step.kind === "handoff") return this.handOffToTeam(f, team, step, lane);
    if (step.kind === "branch" && step.rule) {
      const text = carry?.text ?? "";
      const t = text.toLowerCase();
      const v = step.rule.value.toLowerCase();
      const yes = step.rule.op === "contains" ? t.includes(v) : step.rule.op === "not_contains" ? !t.includes(v) : step.rule.op === "starts_with" ? t.trim().startsWith(v) : t.trim() === v;
      lane.chose = yes ? "yes" : "no";
      f.rounds[step.id] = (f.rounds[step.id] ?? 0) + 1;
      return this.complete(f, lane, text);
    }
    const agent = this.agentFor(team, step);
    const deleg = this.delegate;
    if (!agent || !deleg) return this.waitLane(f, lane, `${step.roleId ? this.who(team, step) : `“${this.title(team, step)}”`} has nobody to do it. Pick an agent for ${step.roleId ? "the role" : "the step"} in the team's steps, then try again.`, "retry");
    if (step.kind === "review") {
      // nobody approves their own work
      const reviewed = team.steps.find((s) => s.id === step.sendBackTo);
      const built = [...f.history].reverse().find((h) => h.stepId === step.sendBackTo);
      if (reviewed && built && this.hub.store.task(built.taskId)?.toAgentId === agent.id && !f.selfReviewOk?.includes(step.id)) {
        this.waitLane(f, lane, `${agent.name} did ${this.title(team, reviewed)} and would be reviewing its own work as ${step.roleId ? `the ${this.who(team, step)}` : `“${this.title(team, step)}”`}. Pick a different agent for this step, or let ${agent.name} review its own work.`, "retry");
        lane.waitingFor!.selfReview = { agent: agent.name };
        this.save(f);
        return;
      }
    }
    const order = workSteps(team.steps);
    const n = order.findIndex((s) => s.id === step.id) + 1;
    const round = (f.rounds[step.id] ?? 0) + 1;
    const handTo = (step.handTo ?? []).map((r) => ({ role: team.roles?.find((x) => x.id === r)?.name ?? "someone", agent: this.hub.store.agent(team.roles?.find((x) => x.id === r)?.agentId ?? "") })).filter((x) => x.agent);
    const checker = step.kind === "hand_out" && step.reviewBy ? this.hub.store.agent(team.roles?.find((x) => x.id === step.reviewBy)?.agentId ?? "") : undefined;
    const sendBack = team.steps.find((s) => s.id === step.sendBackTo);
    const how =
      step.kind === "review"
        ? `Review it${step.roleId ? ` as the ${this.who(team, step)}` : ""}. If it's ready, finish this task with task_update (status done, verdict "approved"). If it needs changes, finish it with status done, verdict "changes" and a numbered list of what to change as the result; it goes back to ${this.who(team, sendBack)}.`
        : step.kind === "branch"
          ? `Decide this about the work above: ${(step.condition ?? "").trim() || "is it good?"} Finish this task with task_update (status done) and verdict "approved" for yes or "changes" for no, and say why in the result.`
          : step.kind === "hand_out"
            ? `Break the work into pieces and hand each one with task_delegate to: ${handTo.map((h) => `\`${h.agent!.handle}\` (${h.role})`).join(", ")}. ${checker ? `Each finished piece is checked by ${checker.name} (${team.roles?.find((x) => x.id === step.reviewBy)?.name}) and goes back to its builder if it needs changes; you don't need to review them yourself. ` : ""}When every piece is in, finish this task with task_update (status done) and a short summary.`
            : "Do this step, then finish this task with task_update (status done) with your whole output as the result, so the next step gets it.";
    // a prompt a role already gave every agent isn't said twice
    const own = stepPrompt(team, step);
    const prompt = own && own !== (team.roles?.find((r) => r.id === step.roleId)?.description ?? "").trim() ? `What to do in this step:\n${own}` : "";
    // the brief is posted as a message: only the agent it's for is @mentioned, or others would wake up too
    const brief = [
      `Step ${n} of ${order.length} for #${this.hub.store.channel(f.channelId)?.name}: **${stepLabel(step, team.roles ?? [], agent.name)}**${round > 1 ? ` (round ${round})` : ""}.`,
      `The request:\n> ${f.request.trim().replace(/\n/g, "\n> ")}`,
      prompt,
      carry ? `${carry.sentBack ? `Sent back by ${carry.from}` : `From ${carry.from}`}:\n${carry.text.trim()}` : "",
      how,
    ]
      .filter(Boolean)
      .join("\n\n");
    const task = deleg({
      workspaceId: f.workspaceId,
      author: SYSTEM,
      from: SYSTEM,
      target: agent,
      title: this.title(team, step),
      brief,
      channelId: f.channelId,
      hop: 1,
      threadId: f.threadId,
      onBehalfOf: f.requestedBy,
    });
    lane.taskId = task.id;
    lane.waitingFor = null;
    f.rounds[step.id] = round;
    f.history.push({ stepId: step.id, taskId: task.id, round, verdict: null, at: new Date().toISOString() });
    this.save(f);
  }

  /** An ask-me step: a card in the Inbox (and a message in the thread) with the work so far. */
  private askPerson(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, step: TeamStep, lane: FlowLane) {
    const g = stepGraph(team.steps);
    const before = (g.ins.get(step.id) ?? []).map((i) => this.agentFor(team, team.steps.find((s) => s.id === i))).find(Boolean);
    const asker = before ?? team.nodes.map((n) => this.hub.store.agent(n.agentId)).find(Boolean) ?? [...(team.roles ?? []), ...team.steps].map((x) => this.hub.store.agent(("agentId" in x && x.agentId) || "")).find(Boolean);
    if (!asker) return this.waitLane(f, lane, `Nobody on this team can ask you “${this.title(team, step)}”: add an agent to the team, then try again.`, "retry");
    const title = this.title(team, step);
    const shown = lane.carry?.text?.trim() ?? "";
    const approval = this.hub.store.createApproval({
      workspaceId: f.workspaceId,
      agentId: asker.id,
      channelId: f.channelId,
      threadId: f.threadId,
      summary: title,
      details: [step.show?.trim(), shown].filter(Boolean).join("\n\n"),
      flow: { flowId: f.id, stepId: step.id },
    });
    lane.approvalId = approval.id;
    f.rounds[step.id] = (f.rounds[step.id] ?? 0) + 1;
    this.waitLane(f, lane, `Waiting for you: ${title}`, "ask", undefined, false);
    this.hub.postMessage({ channelId: f.channelId, threadId: f.threadId, author: { kind: "agent", id: asker.id }, body: `${title}: can I go ahead?`, parts: [{ type: "approval", approvalId: approval.id }], route: false, onBehalfOf: f.requestedBy });
    this.hub.broadcast(f.workspaceId, { type: "approval", approval }, this.hub.audience(approval.channelId));
  }

  /** A hand-off step: the work goes to another team's channel; with "wait", the next step gets its answer. */
  private handOffToTeam(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, step: TeamStep, lane: FlowLane) {
    const target = step.handoffTo ? this.hub.store.channel(step.handoffTo) : undefined;
    const mine = this.hub.store.channel(f.channelId);
    // a private team only takes work from people who can see it (the same rule as the REST API: its members and owners)
    const seen = !!target && (!target.private || (!!f.requestedBy && !!this.hub.audience(target.id)?.(f.requestedBy)));
    if (!target || !seen || target.workspaceId !== f.workspaceId || target.kind !== "channel" || target.archivedAt || target.id === f.channelId)
      return this.waitLane(f, lane, `“${this.title(team, step)}” hands the work to a team that isn't there any more. Pick another team in the steps, then try again.`, "retry");
    if ((f.depth ?? 0) >= MAX_DEPTH) return this.waitLane(f, lane, `Teams have handed this work on ${MAX_DEPTH} times in a row. Stopping here so it doesn't go round forever.`, "retry");
    const body = [`From the ${mine?.name} team${f.request ? `, who were asked:\n> ${f.request.trim().replace(/\n/g, "\n> ")}` : ""}`, step.prompt?.trim() ?? "", lane.carry?.text?.trim() ? `Their work so far:\n${lane.carry.text.trim()}` : ""].filter(Boolean).join("\n\n");
    const runs = this.runsSteps(target);
    // a plain team's leads read what comes in, so the lead is mentioned; a team with steps starts its own request
    const lead = !runs ? target.settings.team?.nodes.find((n) => n.lead) : undefined;
    const handle = lead ? this.hub.store.agent(lead.agentId)?.handle : undefined;
    const msg = this.hub.postMessage({ channelId: target.id, author: SYSTEM, body: handle ? `@${handle} ${body}` : body, route: !runs && !!handle, onBehalfOf: f.requestedBy });
    const child = runs ? this.start(msg, f.workspaceId, f.requestedBy, (f.depth ?? 0) + 1) : null;
    lane.handoff = { channelId: target.id, flowId: child?.id ?? null };
    f.rounds[step.id] = (f.rounds[step.id] ?? 0) + 1;
    if (step.waitForReply && child) {
      // a team that finished before this was linked has already sent its news: take the answer now
      const now = this.flow(child.id);
      if (now?.status === "done") return this.complete(f, lane, now.result || `#${target.name} finished.`);
      if (now?.status === "failed") return this.failLane(f, lane, `The team this step handed work to stopped before it finished. Try again to hand it over again, or skip this step to go on without an answer.`);
      this.save(f);
      return;
    }
    this.complete(f, lane, `Handed to #${target.name}.`);
  }

  /** Stop and let a person decide: a review ran out of rounds, a run failed, a role has nobody, an ask-me step. */
  private waitLane(f: TeamFlow, lane: FlowLane, why: string, options: FlowWaiting["options"], piece?: string, post = true) {
    lane.status = "waiting";
    lane.waitingFor = { why, options, ...(piece ? { piece } : {}) };
    f.status = "waiting";
    f.stepId = lane.stepId;
    this.save(f);
    if (post) this.hub.postMessage({ channelId: f.channelId, threadId: f.threadId, author: SYSTEM, body: why, route: false, onBehalfOf: f.requestedBy });
  }

  /** A step (or the hand-over to another team) ran and failed: a person can try again or skip it. */
  private failLane(f: TeamFlow, lane: FlowLane, why: string) {
    this.waitLane(f, lane, why, "retry");
    lane.waitingFor!.failed = true;
    this.save(f);
  }

  private finish(f: TeamFlow, status: "done" | "failed", note: string) {
    f.status = status;
    if (status === "done") {
      const team = this.team(f);
      const g = team && stepGraph(team.steps);
      const last = Object.values(f.lanes ?? {}).filter((l) => l.status === "done" && l.result !== undefined && (!g || !(g.outs.get(l.stepId)?.length)));
      f.result = last.map((l) => l.result).filter(Boolean).join("\n\n") || undefined;
    }
    f.waitingFor = null;
    this.save(f);
    this.hub.postMessage({ channelId: f.channelId, threadId: f.threadId, author: SYSTEM, body: "", parts: [{ type: "status", text: note }], route: false });
    this.handOffDone(f);
  }

  /** Another team's request finished: the hand-off step waiting for it goes on with its answer. */
  private handOffDone(child: TeamFlow) {
    for (const f of this.active(child.workspaceId)) {
      const lane = Object.values(f.lanes ?? {}).find((l) => live(l) && l.handoff?.flowId === child.id);
      if (!lane) continue;
      if (child.status === "done") this.complete(f, lane, child.result || `#${this.hub.store.channel(child.channelId)?.name} finished.`);
      else this.failLane(f, lane, `The team this step handed work to stopped before it finished. Try again to hand it over again, or skip this step to go on without an answer.`);
    }
  }

  /** Cancel the work a lane still has open: its task, its pieces and their reviews, and a team it handed work to. */
  private cancelLane(f: TeamFlow, lane: FlowLane, note: string) {
    const ids = new Set<string>();
    if (lane.taskId) {
      ids.add(lane.taskId);
      for (const t of this.hub.store.subtasks(lane.taskId)) ids.add(t.id);
    }
    for (const p of Object.values(lane.pieces)) if (p.reviewTaskId) ids.add(p.reviewTaskId);
    let cancelled = false;
    for (const taskId of ids) {
      const t = this.hub.store.task(taskId);
      if (!t || (t.status !== "open" && t.status !== "in_progress")) continue;
      if (t.toAgentId && t.channelId && t.threadId) {
        const runs = this.hub.store.db.prepare("SELECT id FROM runs WHERE agent_id = ? AND channel_id = ? AND thread_id = ? AND status IN ('queued', 'running')").all(t.toAgentId, t.channelId, t.threadId) as { id: string }[];
        for (const r of runs) this.hub.cancelRun(r.id);
      }
      this.hub.store.updateTask(t.id, "failed", note);
      cancelled = true;
    }
    if (cancelled) this.hub.broadcast(f.workspaceId, { type: "tasks_changed" });
    if (lane.approvalId) {
      const a = this.hub.store.approval(lane.approvalId);
      if (a?.status === "pending") {
        this.hub.store.decideApproval(a.id, "denied", "system", note);
        this.hub.broadcast(f.workspaceId, { type: "approval", approval: this.hub.store.approval(a.id)! }, this.hub.audience(a.channelId));
      }
    }
    if (lane.handoff?.flowId) {
      const child = this.flow(lane.handoff.flowId);
      if (child && (child.status === "running" || child.status === "waiting")) {
        lane.handoff = { ...lane.handoff, flowId: null };
        this.cancelAll(child, note);
        this.finish(child, "failed", "Stopped.");
      }
    }
  }

  private cancelAll(f: TeamFlow, note: string) {
    for (const l of Object.values(f.lanes ?? {})) if (live(l)) this.cancelLane(f, l, note);
  }

  /** A step finished with this result: its lane is done, and whatever was waiting on it can go. */
  private complete(f: TeamFlow, lane: FlowLane, result: string, leaveLoop = false): void {
    const team = this.team(f);
    lane.status = "done";
    lane.result = result;
    lane.waitingFor = null;
    const step = team?.steps.find((s) => s.id === lane.stepId);
    if (!team || !step) return this.finish(f, "failed", "The team's steps were removed, so this stopped.");
    const g = stepGraph(team.steps);
    if (step.kind === "branch") {
      let to = lane.chose === "no" ? step.ifFalse : step.ifTrue;
      let back = to && g.back.get(step.id)?.includes(to);
      if (back && leaveLoop) {
        // a person approved it anyway: take the other way out, or end here if that goes back too
        const other = lane.chose === "no" ? step.ifTrue : step.ifFalse;
        const forward = !!other && !g.back.get(step.id)?.includes(other);
        if (forward) lane.chose = lane.chose === "no" ? "yes" : "no";
        to = forward ? other : null;
        back = false;
      }
      if (back) {
        // going back round: bounded by the if/else's rounds, then a person decides
        const max = step.maxRounds ?? DEFAULT_ROUNDS;
        const used = f.rounds[step.id] ?? 1;
        if (used >= max) {
          lane.status = "waiting";
          return this.waitLane(f, lane, `${this.title(team, step)} sent the work back ${used} time${used === 1 ? "" : "s"}. Approve it anyway, or give it another round.`, "rounds");
        }
        this.resetFrom(f, team, to!);
        return this.runStep(f, team.steps.find((s) => s.id === to)!, { from: this.who(team, step), text: result || "(no notes given)", sentBack: true });
      }
      // the other way's steps are skipped once nothing else leads to them either (the chosen path may still reach them)
      for (const o of g.outs.get(step.id) ?? []) if (o !== to) this.ready(f, team, o);
      if (to) this.ready(f, team, to);
    } else {
      for (const o of g.outs.get(step.id) ?? []) this.ready(f, team, o);
    }
    this.afterMove(f);
  }

  /** Steps that were only waiting on this one start; when nothing is open any more, the request is done. */
  private afterMove(f: TeamFlow) {
    if (f.status === "failed" || f.status === "done") return;
    const team = this.team(f);
    if (team) for (const s of team.steps) if (!f.lanes?.[s.id]) this.ready(f, team, s.id);
    if ((f.status as string) === "failed" || (f.status as string) === "done" || this.starting.has(f.id)) return;
    const lanes = Object.values(f.lanes ?? {});
    if (lanes.length && !lanes.some(live)) return this.finish(f, "done", "All steps done.");
    this.save(f);
  }

  /** Does a step have everything it waits for? If so run it (or skip it when every way in was skipped). */
  private ready(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, stepId: string) {
    if (f.lanes?.[stepId]) return;
    const step = team.steps.find((s) => s.id === stepId);
    if (!step) return;
    const g = stepGraph(team.steps);
    const ins = g.ins.get(stepId) ?? [];
    // the steps nothing leads to start with the request; the rest wait for what leads to them
    if (!ins.length) return;
    const state = (i: string): "done" | "skipped" | "open" => {
      const l = f.lanes?.[i];
      if (!l || live(l)) return "open";
      if (l.status === "skipped") return "skipped";
      const from = team.steps.find((s) => s.id === i);
      // an if/else that went the other way doesn't lead here
      if (from?.kind === "branch" && (l.chose === "no" ? from.ifFalse : from.ifTrue) !== stepId) return "skipped";
      return "done";
    };
    const states = ins.map(state);
    if (states.some((s) => s === "open")) return;
    if (states.every((s) => s === "skipped")) return this.skip(f, team, stepId);
    const done = new Set(ins.filter((_, k) => states[k] === "done"));
    const carry = this.carryFor({ ...f, lanes: Object.fromEntries(Object.entries(f.lanes ?? {}).filter(([k]) => done.has(k))) }, team, step);
    this.runStep(f, step, carry);
  }

  /** A step that won't happen (an if/else went the other way); what follows may now be ready, or skipped too. */
  private skip(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, stepId: string) {
    if (f.lanes?.[stepId]) return;
    (f.lanes ??= {})[stepId] = { stepId, status: "skipped", taskId: null, carry: null, pieces: {}, waitingFor: null };
    for (const o of stepGraph(team.steps).outs.get(stepId) ?? []) this.ready(f, team, o);
  }

  /** Going back to a step: it and everything after it start over (what's still open is cancelled). */
  private resetFrom(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, stepId: string) {
    for (const sid of [stepId, ...stepsAfter(team.steps, stepId)]) {
      const l = f.lanes?.[sid];
      if (!l) continue;
      if (live(l)) this.cancelLane(f, l, "Sent back, so this wasn't needed.");
      delete f.lanes![sid];
    }
  }

  /**
   * A task finished. If it's a step, a piece of a hand-out, or a piece's review, move the flow on.
   * Returns true when the flow takes care of reviewing it (so the usual branch review is skipped).
   */
  taskFinished(task: Task, verdict: "approved" | "changes" | null): boolean {
    for (const f of this.active(task.workspaceId)) {
      const team = this.team(f);
      for (const lane of Object.values(f.lanes ?? {})) {
        if (!live(lane)) continue;
        const step = team?.steps.find((s) => s.id === lane.stepId);
        if (!team || !step) {
          // its step is gone: nothing can pick this up any more
          if (lane.taskId === task.id) this.finish(f, "failed", STEPS_CHANGED);
          continue;
        }
        // the step's own task
        if (lane.taskId === task.id) {
          const h = [...f.history].reverse().find((x) => x.taskId === task.id);
          if (task.status === "failed") {
            if (h) h.verdict = "failed";
            this.failLane(f, lane, `${stepLabel(step, team.roles ?? [], this.agentFor(team, step)?.name)} didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}`);
            return false;
          }
          if (step.kind === "review") {
            if (!verdict) {
              this.waitLane(f, lane, `${this.who(team, step)} finished the review without saying "approved" or "changes". Try again to ask for the review again, or approve it anyway.`, "retry");
              return false;
            }
            if (h) h.verdict = verdict;
            if (verdict === "changes") return this.sendBack(f, team, step, lane, task.result ?? ""), false;
            this.complete(f, lane, this.reviewed(f, team, step, lane));
            return false;
          }
          if (step.kind === "branch") {
            if (!verdict) {
              this.waitLane(f, lane, `${this.who(team, step)} didn't say yes or no to “${(step.condition ?? "").trim()}”. Try again to ask again, or approve to go the “yes” way.`, "retry");
              return false;
            }
            if (h) h.verdict = verdict;
            lane.chose = verdict === "approved" ? "yes" : "no";
            this.complete(f, lane, lane.carry?.text ?? task.result ?? "");
            return false;
          }
          if (h) h.verdict = "done";
          if (step.kind === "hand_out") return this.afterPiece(f, lane, step), false;
          this.complete(f, lane, task.result ?? "");
          return false;
        }
        if (step.kind !== "hand_out" || !lane.taskId) continue;
        // a piece of the hand-out (or a follow-up on one)
        if (task.parentId === lane.taskId && !task.reviewOf) {
          const key = this.pieceKey(lane, task.id);
          const piece = (lane.pieces[key] ??= { taskId: key, agentId: task.toAgentId, title: task.title, rounds: 0, reviewTaskId: null, status: "building" });
          // the same task finished twice doesn't start another review
          if (piece.status === "approved" || piece.lastTaskId === task.id) return false;
          piece.lastTaskId = task.id;
          if (task.status === "failed") {
            this.pieceNeedsPerson(piece, `**${piece.title}** didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}. Try again to hand it back to its builder, or skip it.`, "retry", "build", true);
            this.afterPiece(f, lane, step);
            return false;
          }
          return this.reviewPiece(f, team, lane, step, piece, task);
        }
        // a piece's review
        const piece = Object.values(lane.pieces).find((p) => p.reviewTaskId === task.id);
        if (piece) {
          piece.reviewTaskId = null;
          piece.lastReviewId = task.id;
          const reviewerRole = (step.reviewBy && team.roles?.find((r) => r.id === step.reviewBy)?.name) || "The reviewer";
          if (task.status === "failed") {
            this.pieceNeedsPerson(piece, `The review of **${piece.title}** didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}. Try again to ask for it again, or skip it.`, "retry", "review", true);
          } else if (verdict === "approved") {
            piece.status = "approved";
          } else if (!verdict) {
            this.pieceNeedsPerson(piece, `${reviewerRole} finished the review of **${piece.title}** without saying "approved" or "changes". Try again to ask for it again, or approve it anyway.`, "retry", "review");
          } else {
            piece.rounds++;
            const max = step.maxRounds ?? DEFAULT_ROUNDS;
            if (piece.rounds >= max) this.pieceNeedsPerson(piece, `**${piece.title}** was sent back ${piece.rounds} time${piece.rounds === 1 ? "" : "s"}. Approve it anyway or give it another round.`, "rounds", "build");
            else if (!this.followUp(f, team, lane, step, piece, `Changes: ${piece.title}`, `${reviewerRole} sent **${piece.title}** back (round ${piece.rounds + 1} of ${max}):\n\n${task.result ?? ""}\n\nMake these changes, then finish this task with task_update (status done).`))
              this.pieceNeedsPerson(piece, `Nobody is left to make the changes to **${piece.title}**. Approve it anyway, or stop.`, "retry", "build");
          }
          this.afterPiece(f, lane, step);
          return false;
        }
      }
    }
    return false;
  }

  /** A piece was built: have the reviewing role check it, unless nobody else can. True when a review started. */
  private reviewPiece(f: TeamFlow, team: ChannelTeam, lane: FlowLane, step: TeamStep, piece: TeamFlowPiece, built: Task): boolean {
    if (!step.reviewBy) {
      piece.status = "approved";
      this.afterPiece(f, lane, step);
      return false;
    }
    const reviewRole = team.roles?.find((r) => r.id === step.reviewBy);
    const reviewer = reviewRole?.agentId ? this.hub.store.agent(reviewRole.agentId) : undefined;
    const role = reviewRole?.name ?? "reviewer";
    if (!reviewer || reviewer.id === built.toAgentId) {
      this.pieceNeedsPerson(
        piece,
        reviewer
          ? `**${piece.title}** was built by ${reviewer.name}, who is also the ${role}, so nobody else would check it. Pick a different agent for the role, then try again, or approve it anyway.`
          : `Nobody is in the ${role} role to check **${piece.title}**. Pick an agent for it in the team's steps, then try again, or approve it anyway.`,
        "retry",
        "review",
      );
      this.afterPiece(f, lane, step);
      return false;
    }
    const review = this.delegate!({
      workspaceId: f.workspaceId,
      author: SYSTEM,
      from: SYSTEM,
      target: reviewer,
      title: `Review: ${built.title}`,
      brief: `${this.hub.store.agent(built.toAgentId ?? "")?.name ?? "The builder"} finished **${built.title}**${built.branch ? ` on branch \`${built.branch}\`` : ""}.\n\n${built.result ? `What they said:\n${built.result}\n\n` : ""}${built.branch ? "Your checkout is on that branch: read the diff and run the tests. If it's good, merge it with `branch_merge`.\n\n" : ""}Review it as the ${role}. Finish this task with task_update: status done with verdict "approved" if it's good, or verdict "changes" and a numbered list of what to change.`,
      channelId: f.channelId,
      hop: 1,
      reviewOf: built.id,
      branch: built.branch,
      threadId: f.threadId,
      onBehalfOf: f.requestedBy,
    });
    piece.status = "reviewing";
    piece.reviewTaskId = review.id;
    delete piece.problem;
    this.save(f);
    return true;
  }

  /** Hand a piece back to its builder. False when its builder is gone. */
  private followUp(f: TeamFlow, team: ChannelTeam, lane: FlowLane, step: TeamStep, piece: TeamFlowPiece, title: string, brief: string): boolean {
    const builder = piece.agentId ? this.hub.store.agent(piece.agentId) : undefined;
    if (!builder || !lane.taskId) return false;
    const last = piece.lastTaskId ? this.hub.store.task(piece.lastTaskId) : undefined;
    const lead = this.agentFor(team, step);
    const task = this.delegate!({
      workspaceId: f.workspaceId,
      author: SYSTEM,
      from: lead ? { kind: "agent", id: lead.id } : SYSTEM,
      target: builder,
      title,
      brief,
      channelId: f.channelId,
      hop: 1,
      parentId: lane.taskId,
      branch: last?.branch ?? null,
      threadId: f.threadId,
      onBehalfOf: f.requestedBy,
    });
    lane.pieceOf = { ...(lane.pieceOf ?? {}), [task.id]: piece.taskId };
    piece.status = "building";
    delete piece.problem;
    return true;
  }

  private pieceNeedsPerson(piece: TeamFlowPiece, why: string, options: "retry" | "rounds", redo: "build" | "review", failed = false) {
    piece.status = "failed";
    piece.problem = { why, options, redo, ...(failed ? { failed } : {}) };
  }

  /** Is this task part of a running flow (a step, a piece, or a piece's review)? Flows do their own reviewing. */
  inFlow(task: Task): boolean {
    return this.active(task.workspaceId).some((f) => f.history.some((h) => h.taskId === task.id) || Object.values(f.lanes ?? {}).some((l) => (!!l.taskId && task.parentId === l.taskId) || Object.values(l.pieces).some((p) => p.reviewTaskId === task.id || p.taskId === task.id)));
  }

  /** A follow-up on a piece counts as that piece. */
  private pieceKey(lane: FlowLane, taskId: string) {
    return lane.pieceOf?.[taskId] ?? taskId;
  }

  private piecesApproved(lane: FlowLane, step: TeamStep): boolean {
    if (!step.reviewBy || !lane.taskId) return true;
    // every piece handed out so far, including ones nobody has finished yet
    const keys = new Set(this.hub.store.subtasks(lane.taskId).filter((t) => !t.reviewOf).map((t) => this.pieceKey(lane, t.id)));
    return [...keys].every((k) => lane.pieces[k]?.status === "approved");
  }

  /**
   * After a piece moved: a piece that needs a person waits for one (one at a time); when every
   * piece is approved and the hand-out is done, move on.
   */
  private afterPiece(f: TeamFlow, lane: FlowLane, step: TeamStep) {
    const stuck = Object.values(lane.pieces).find((p) => p.status === "failed");
    if (stuck) {
      if (lane.status === "waiting" && lane.waitingFor?.piece === stuck.taskId) return this.save(f);
      this.waitLane(f, lane, stuck.problem?.why ?? `**${stuck.title}** needs a person.`, stuck.problem?.options ?? "retry", stuck.taskId);
      if (stuck.problem?.failed) {
        lane.waitingFor!.failed = true;
        this.save(f);
      }
      return;
    }
    const handOut = lane.taskId ? this.hub.store.task(lane.taskId) : undefined;
    if (handOut?.status === "done" && this.piecesApproved(lane, step)) return this.complete(f, lane, handOut.result ?? "");
    // a piece's question is answered; one about the whole step still stands
    if (lane.waitingFor?.piece) {
      lane.status = "running";
      lane.waitingFor = null;
      f.status = "running";
    }
    this.save(f);
  }

  /** What the reviewed step said, so the step after a review gets the work, not "approved". */
  private reviewed(f: TeamFlow, team: ChannelTeam, review: TeamStep, lane: FlowLane): string {
    const h = [...f.history].reverse().find((x) => x.stepId === review.sendBackTo);
    return (h && this.hub.store.task(h.taskId)?.result) || f.lanes?.[review.sendBackTo ?? ""]?.result || lane.carry?.text || "";
  }

  private sendBack(f: TeamFlow, team: ChannelTeam & { steps: TeamStep[] }, review: TeamStep, lane: FlowLane, notes: string) {
    const max = review.maxRounds ?? DEFAULT_ROUNDS;
    const used = f.rounds[review.id] ?? 1;
    const to = team.steps.find((s) => s.id === review.sendBackTo);
    if (!to) return this.waitLane(f, lane, "This review has nowhere to send the work back to. Fix the step in the team's steps, then try again.", "retry");
    if (used >= max) return this.waitLane(f, lane, `${this.who(team, review)} sent it back ${used} time${used === 1 ? "" : "s"}. Approve it anyway, or give it another round.`, "rounds");
    this.resetFrom(f, team, to.id);
    this.runStep(f, to, { from: this.who(team, review), text: notes || "(no notes given)", sentBack: true });
    this.afterMove(f);
  }

  // --- the team changed -------------------------------------------------------------

  /** A channel's steps were edited: a request whose step is gone or now means something else stops. */
  teamChanged(channelId: string, before: ChannelTeam | null, after: ChannelTeam | null) {
    const ch = this.hub.store.channel(channelId);
    if (!ch) return;
    for (const f of this.active(ch.workspaceId).filter((x) => x.channelId === channelId)) {
      const changed = Object.values(f.lanes ?? {})
        .filter(live)
        .some((l) => {
          const was = before?.steps?.find((s) => s.id === l.stepId);
          const now = after?.steps?.length ? after.steps.find((s) => s.id === l.stepId) : undefined;
          return !(was && now && stepShape(was) === stepShape(now));
        });
      if (!changed) continue;
      this.cancelAll(f, STEPS_CHANGED);
      this.finish(f, "failed", STEPS_CHANGED);
    }
  }

  // --- a person decides --------------------------------------------------------------

  /** An ask-me card was answered in the Inbox (or the thread): yes goes on, no sends it back with the note. */
  askDecided(approval: { id: string; flow?: { flowId: string; stepId: string } | null }, approved: boolean, note: string, by: string) {
    const ref = approval.flow;
    if (!ref) return;
    const f = this.flow(ref.flowId);
    const lane = f?.lanes?.[ref.stepId];
    if (!f || !lane || lane.approvalId !== approval.id || lane.status !== "waiting" || lane.waitingFor?.options !== "ask") return;
    this.decideLane(f, lane, approved ? "approve" : "changes", note, by);
  }

  /**
   * On a waiting request: "approve" goes on as if it passed, "retry" runs it again (or another
   * round), "stop" ends it, "changes" (an ask-me step) sends the work back with a note. Stop also
   * ends a running one. Whatever is still open is cancelled. `stepId` picks the step when several wait.
   */
  decide(flowId: string, action: "approve" | "retry" | "stop" | "changes" | "allow", opts: { stepId?: string; note?: string; by?: string } = {}): TeamFlow | undefined {
    const f = this.flow(flowId);
    if (!f || (f.status !== "waiting" && f.status !== "running")) return f;
    if (action === "stop") {
      this.cancelAll(f, "Stopped by a person.");
      this.finish(f, "failed", "Stopped.");
      return this.flow(flowId);
    }
    const lanes = Object.values(f.lanes ?? {}).filter((l) => l.status === "waiting");
    const lane = opts.stepId ? f.lanes?.[opts.stepId] : lanes[0];
    if (!lane || lane.status !== "waiting") return f;
    if (action === "allow") {
      // "let it review its own work": remember that for this step, then run it
      if (!lane.waitingFor?.selfReview) return f;
      f.selfReviewOk = [...new Set([...(f.selfReviewOk ?? []), lane.stepId])];
      this.decideLane(f, lane, "retry", "", opts.by ?? "");
      return this.flow(flowId);
    }
    this.decideLane(f, lane, action, opts.note ?? "", opts.by ?? "");
    return this.flow(flowId);
  }

  private decideLane(f: TeamFlow, lane: FlowLane, action: "approve" | "retry" | "changes", note: string, by: string) {
    const team = this.team(f);
    const step = team?.steps.find((s) => s.id === lane.stepId);
    if (!team || !step) {
      this.cancelAll(f, STEPS_CHANGED);
      this.finish(f, "failed", STEPS_CHANGED);
      return;
    }
    // an ask-me step
    if (lane.waitingFor?.options === "ask" || step.kind === "ask") {
      const a = lane.approvalId ? this.hub.store.approval(lane.approvalId) : undefined;
      if (a?.status === "pending" && action !== "retry") {
        this.hub.store.decideApproval(a.id, action === "approve" ? "approved" : "denied", by || "system", note);
        this.hub.broadcast(f.workspaceId, { type: "approval", approval: this.hub.store.approval(a.id)! }, this.hub.audience(a.channelId));
      }
      if (action === "retry") {
        // ask again
        this.cancelLane(f, lane, "Asked again.");
        f.rounds[step.id] = Math.max(0, (f.rounds[step.id] ?? 1) - 1);
        this.runStep(f, step, lane.carry);
        return;
      }
      lane.waitingFor = null;
      lane.status = "running";
      f.status = "running";
      if (action === "approve") {
        this.complete(f, lane, lane.carry?.text ?? "");
        return;
      }
      const to = team.steps.find((s) => s.id === step.sendBackTo);
      if (!to) {
        this.cancelAll(f, "You asked for changes.");
        this.finish(f, "failed", "You asked for changes, and this step has nowhere to send the work back to. Stopped.");
        return;
      }
      this.resetFrom(f, team, to.id);
      this.runStep(f, to, { from: "You", text: note.trim() || "(no notes given)", sentBack: true });
      this.afterMove(f);
      return;
    }
    if (action === "changes") return;
    // one piece of a hand-out
    const piece = lane.waitingFor?.piece ? lane.pieces[lane.waitingFor.piece] : undefined;
    if (piece) {
      const problem = piece.problem;
      lane.status = "running";
      f.status = "running";
      lane.waitingFor = null;
      delete piece.problem;
      if (action === "approve") piece.status = "approved";
      else if (problem?.redo === "review") {
        const built = piece.lastTaskId ? this.hub.store.task(piece.lastTaskId) : undefined;
        if (built) {
          this.reviewPiece(f, team, lane, step, piece, built);
          return;
        }
        piece.status = "approved";
      } else {
        // another round, or trying a failed piece again: back to its builder
        if (problem?.options === "rounds") piece.rounds = 0;
        const notes = problem?.options === "rounds" ? ((piece.lastReviewId && this.hub.store.task(piece.lastReviewId)?.result) || "") : "";
        const max = step.maxRounds ?? DEFAULT_ROUNDS;
        const reviewer = (step.reviewBy && team.roles?.find((r) => r.id === step.reviewBy)?.name) || "The reviewer";
        const brief =
          problem?.options === "rounds"
            ? `${reviewer} sent **${piece.title}** back, and a person gave it another round (round 1 of ${max}):\n\n${notes}\n\nMake these changes, then finish this task with task_update (status done).`
            : `**${piece.title}** didn't finish last time. Pick it up again, then finish this task with task_update (status done).`;
        if (!this.followUp(f, team, lane, step, piece, `${problem?.options === "rounds" ? "Changes" : "Try again"}: ${piece.title}`, brief))
          this.pieceNeedsPerson(piece, `Nobody is left to work on **${piece.title}**. Approve it anyway, or stop.`, "retry", "build");
      }
      this.afterPiece(f, lane, step);
      return;
    }
    // a hand-off that stopped
    if (lane.handoff && action === "approve") {
      this.cancelLane(f, lane, "Approved by a person, so this wasn't needed.");
      this.complete(f, lane, "Went on without an answer from the other team.");
      return;
    }
    const wasRounds = lane.waitingFor?.options === "rounds";
    const stuckResult = lane.taskId ? (this.hub.store.task(lane.taskId)?.result ?? "") : "";
    this.cancelLane(f, lane, action === "approve" ? "Approved by a person, so this wasn't needed." : "Started again by a person.");
    if (action === "retry") {
      lane.status = "running";
      f.status = "running";
      // another round of a review (or an if/else) starts from the step it sends back to
      const back = step.kind === "review" ? team.steps.find((s) => s.id === step.sendBackTo) : step.kind === "branch" ? team.steps.find((s) => s.id === (lane.chose === "no" ? step.ifFalse : step.ifTrue)) : undefined;
      if (back && wasRounds) {
        f.rounds[step.id] = 0;
        this.resetFrom(f, team, back.id);
        this.runStep(f, back, { from: this.who(team, step), text: stuckResult || lane.result || "", sentBack: true });
      } else {
        f.rounds[step.id] = Math.max(0, (f.rounds[step.id] ?? 1) - 1);
        this.runStep(f, step, lane.carry ?? null);
      }
      this.afterMove(f);
      return;
    }
    // approve
    for (const p of Object.values(lane.pieces)) p.status = "approved";
    const last = [...f.history].reverse().find((h) => h.stepId === step.id);
    if (last && step.kind === "review") last.verdict = "approved";
    const result = step.kind === "review" ? this.reviewed(f, team, step, lane) : ((lane.taskId && this.hub.store.task(lane.taskId)?.result) || lane.carry?.text || "");
    if (step.kind === "branch" && !lane.chose) lane.chose = "yes";
    lane.status = "running";
    f.status = "running";
    this.complete(f, lane, result, wasRounds && step.kind === "branch");
  }
}
