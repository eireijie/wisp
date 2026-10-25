import { DEFAULT_ROUNDS, firstStep, hasSteps, stepLabel, stepOrder, type Actor, type ChannelTeam, type Message, type TeamFlow, type TeamFlowPiece, type TeamStep } from "@wisp/core";
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

/** What makes a step the same step to a running request (where it sits in the chart doesn't). */
const stepShape = (s: TeamStep) => JSON.stringify([s.kind, s.roleId, s.action, s.sendBackTo ?? null, s.handTo ?? null, s.reviewBy ?? null]);

/**
 * Runs a stepped team (roles + steps): a person's new message in the channel starts at the first
 * step, each step is a task for the agent in that step's role, a review approves (next step) or
 * sends the work back (up to its rounds, then a person decides), and a hand-out's pieces each get
 * checked by the reviewing role before the flow moves on. Wisp moves the work along, not the agents.
 */
export class TeamFlows {
  delegate: Delegate | null = null;

  constructor(private hub: Hub) {
    hub.store.db.exec(`CREATE TABLE IF NOT EXISTS team_flows (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      status TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_flows_channel ON team_flows(channel_id, created_at);`);
  }

  // --- storage ---------------------------------------------------------------------

  private save(f: TeamFlow) {
    f.updatedAt = new Date().toISOString();
    const { id: fid, workspaceId, channelId, threadId, status, createdAt, updatedAt, ...state } = f;
    this.hub.store.db
      .prepare("INSERT INTO team_flows (id, workspace_id, channel_id, thread_id, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, state_json = excluded.state_json, updated_at = excluded.updated_at")
      .run(fid, workspaceId, channelId, threadId, status, JSON.stringify(state), createdAt, updatedAt);
    this.hub.broadcast(workspaceId, { type: "flows_changed", channelId });
  }

  private row(r: { id: string; workspace_id: string; channel_id: string; thread_id: string; status: string; state_json: string; created_at: string; updated_at: string }): TeamFlow {
    return { ...(JSON.parse(r.state_json) as Omit<TeamFlow, "id">), id: r.id, workspaceId: r.workspace_id, channelId: r.channel_id, threadId: r.thread_id, status: r.status as TeamFlow["status"], createdAt: r.created_at, updatedAt: r.updated_at };
  }

  flow(flowId: string): TeamFlow | undefined {
    const r = this.hub.store.db.prepare("SELECT * FROM team_flows WHERE id = ?").get(flowId) as Parameters<TeamFlows["row"]>[0] | undefined;
    return r && this.row(r);
  }

  /** A channel's flows, newest first. */
  flows(channelId: string, limit = 50): TeamFlow[] {
    return (this.hub.store.db.prepare("SELECT * FROM team_flows WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?").all(channelId, limit) as Parameters<TeamFlows["row"]>[0][]).map((r) => this.row(r));
  }

  private active(workspaceId: string): TeamFlow[] {
    return (this.hub.store.db.prepare("SELECT * FROM team_flows WHERE workspace_id = ? AND status IN ('running', 'waiting')").all(workspaceId) as Parameters<TeamFlows["row"]>[0][]).map((r) => this.row(r));
  }

  // --- the team ----------------------------------------------------------------------

  private team(f: Pick<TeamFlow, "channelId">): ChannelTeam | null {
    const t = this.hub.store.channel(f.channelId)?.settings.team ?? null;
    return hasSteps(t) ? t : null;
  }

  private agentFor(team: ChannelTeam, roleId: string | null | undefined): Agent | undefined {
    const agentId = team.roles?.find((r) => r.id === roleId)?.agentId;
    return agentId ? this.hub.store.agent(agentId) : undefined;
  }

  private roleName(team: ChannelTeam, roleId: string | null | undefined) {
    return team.roles?.find((r) => r.id === roleId)?.name ?? "someone";
  }

  // --- running -----------------------------------------------------------------------

  /** Does this channel run new messages through its steps? */
  runsSteps(channel: { kind: string; archivedAt: string | null; settings: { team: ChannelTeam | null } } | undefined): boolean {
    return !!channel && channel.kind === "channel" && !channel.archivedAt && hasSteps(channel.settings.team);
  }

  /** A person's new message in a stepped channel: start at the first step, in a thread under it. */
  start(msg: Message, workspaceId: string, requestedBy: string | null): TeamFlow | null {
    const channel = this.hub.store.channel(msg.channelId);
    const team = channel?.settings.team;
    const first = team && hasSteps(team) ? firstStep(team.steps!) : undefined;
    if (!channel || !team || !first) return null;
    const now = new Date().toISOString();
    const f: TeamFlow = {
      id: id("flow"),
      workspaceId,
      channelId: channel.id,
      threadId: msg.id,
      status: "running",
      request: msg.body,
      requestedBy,
      stepId: first.id,
      taskId: null,
      rounds: {},
      history: [],
      pieces: {},
      waitingFor: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runStep(f, first, null);
    return f;
  }

  /** Hand the step to its role's agent as a task, with what came before. */
  private runStep(f: TeamFlow, step: TeamStep, carry: { from: string; text: string; sentBack?: boolean } | null) {
    // the flow is on this step even when it can't run yet, so trying again runs this one
    f.stepId = step.id;
    f.taskId = null;
    f.carry = carry;
    const team = this.team(f);
    const agent = team && this.agentFor(team, step.roleId);
    const deleg = this.delegate;
    if (!team || !agent || !deleg) return this.wait(f, `${team ? this.roleName(team, step.roleId) : "This step"} has nobody to do it. Pick an agent for the role in the channel's Team tab, then try again.`, "retry");
    const role = team.roles!.find((r) => r.id === step.roleId)!;
    if (step.kind === "review") {
      // nobody approves their own work
      const reviewed = team.steps!.find((s) => s.id === step.sendBackTo);
      const built = [...f.history].reverse().find((h) => h.stepId === step.sendBackTo);
      if (reviewed && built && this.hub.store.task(built.taskId)?.toAgentId === agent.id)
        return this.wait(f, `${agent.name} did ${stepLabel(reviewed, team.roles!)} and would be reviewing its own work as the ${role.name}. Pick a different agent for the role, then try again, or approve it anyway.`, "retry");
    }
    const order = stepOrder(team.steps!);
    const n = order.findIndex((s) => s.id === step.id) + 1;
    const round = (f.rounds[step.id] ?? 0) + 1;
    const handTo = (step.handTo ?? []).map((r) => ({ role: this.roleName(team, r), agent: this.agentFor(team, r) })).filter((x) => x.agent);
    const reviewer = step.kind === "hand_out" ? this.agentFor(team, step.reviewBy) : undefined;
    const how =
      step.kind === "review"
        ? `Review it as the ${role.name}. If it's ready, finish this task with task_update (status done, verdict "approved"). If it needs changes, finish it with status done, verdict "changes" and a numbered list of what to change as the result; it goes back to ${this.roleName(team, team.steps!.find((s) => s.id === step.sendBackTo)?.roleId)}.`
        : step.kind === "hand_out"
          ? `Break the work into pieces and hand each one with task_delegate to: ${handTo.map((h) => `\`${h.agent!.handle}\` (${h.role})`).join(", ")}. ${reviewer ? `Each finished piece is checked by ${reviewer.name} (${this.roleName(team, step.reviewBy)}) and goes back to its builder if it needs changes; you don't need to review them yourself. ` : ""}When every piece is in, finish this task with task_update (status done) and a short summary.`
          : "Do this step, then finish this task with task_update (status done) with your whole output as the result, so the next step gets it.";
    // the brief is posted as a message: only the agent it's for is @mentioned, or others would wake up too
    const brief = [
      `Step ${n} of ${order.length} for #${this.hub.store.channel(f.channelId)?.name}: **${stepLabel(step, team.roles!)}**${round > 1 ? ` (round ${round})` : ""}.`,
      `The request:\n> ${f.request.trim().replace(/\n/g, "\n> ")}`,
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
      title: step.action.trim() || stepLabel(step, team.roles!),
      brief,
      channelId: f.channelId,
      hop: 1,
      threadId: f.threadId,
      onBehalfOf: f.requestedBy,
    });
    f.status = "running";
    f.taskId = task.id;
    f.waitingFor = null;
    f.rounds[step.id] = round;
    // a new hand-out starts with no pieces
    if (step.kind === "hand_out") f.pieces = {};
    f.history.push({ stepId: step.id, taskId: task.id, round, verdict: null, at: new Date().toISOString() });
    this.save(f);
  }

  /** Stop and let a person decide: a review ran out of rounds, a run failed, a role has nobody. */
  private wait(f: TeamFlow, why: string, options: "retry" | "rounds", piece?: string) {
    f.status = "waiting";
    f.waitingFor = { why, options, ...(piece ? { piece } : {}) };
    this.save(f);
    this.hub.postMessage({ channelId: f.channelId, threadId: f.threadId, author: SYSTEM, body: why, route: false, onBehalfOf: f.requestedBy });
  }

  private finish(f: TeamFlow, status: "done" | "failed", note: string) {
    f.status = status;
    f.taskId = null;
    f.waitingFor = null;
    this.save(f);
    this.hub.postMessage({ channelId: f.channelId, threadId: f.threadId, author: SYSTEM, body: "", parts: [{ type: "status", text: note }], route: false });
  }

  /** Cancel the work the flow still has open: the step's task, its pieces and their reviews. */
  private cancelOpen(f: TeamFlow, note: string) {
    const ids = new Set<string>();
    if (f.taskId) {
      ids.add(f.taskId);
      for (const t of this.hub.store.subtasks(f.taskId)) ids.add(t.id);
    }
    for (const p of Object.values(f.pieces)) if (p.reviewTaskId) ids.add(p.reviewTaskId);
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
  }

  private advance(f: TeamFlow, from: TeamStep, result: string) {
    const team = this.team(f);
    if (!team) return this.finish(f, "failed", "The team's steps were removed, so this stopped.");
    const next = from.next ? team.steps!.find((s) => s.id === from.next) : undefined;
    if (!next) return this.finish(f, "done", "All steps done.");
    this.runStep(f, next, { from: this.roleName(team, from.roleId), text: result || "(no result given)" });
  }

  /**
   * A task finished. If it's a step, a piece of a hand-out, or a piece's review, move the flow on.
   * Returns true when the flow takes care of reviewing it (so the usual branch review is skipped).
   */
  taskFinished(task: Task, verdict: "approved" | "changes" | null): boolean {
    for (const f of this.active(task.workspaceId)) {
      const team = this.team(f);
      const step = team?.steps!.find((s) => s.id === f.stepId);
      if (!team || !step) {
        // its step is gone: nothing can pick this up any more
        if (f.taskId === task.id) this.finish(f, "failed", STEPS_CHANGED);
        continue;
      }
      // the step's own task
      if (f.taskId === task.id) {
        const h = [...f.history].reverse().find((x) => x.taskId === task.id);
        if (task.status === "failed") {
          if (h) h.verdict = "failed";
          this.wait(f, `${stepLabel(step, team.roles!)} didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}`, "retry");
          return false;
        }
        if (step.kind === "review") {
          if (!verdict) {
            this.wait(f, `${this.roleName(team, step.roleId)} finished the review without saying "approved" or "changes". Try again to ask for the review again, or approve it anyway.`, "retry");
            return false;
          }
          if (h) h.verdict = verdict;
          if (verdict === "changes") return this.sendBack(f, team, step, task.result ?? ""), false;
          this.advance(f, step, this.lastResultBefore(f, team, step));
          return false;
        }
        if (h) h.verdict = "done";
        if (step.kind === "hand_out") return this.afterPiece(f, step), false;
        this.advance(f, step, task.result ?? "");
        return false;
      }
      if (step.kind !== "hand_out" || !f.taskId) continue;
      // a piece of the hand-out (or a follow-up on one)
      if (task.parentId === f.taskId && !task.reviewOf) {
        const key = this.pieceKey(f, task.id);
        const piece = (f.pieces[key] ??= { taskId: key, agentId: task.toAgentId, title: task.title, rounds: 0, reviewTaskId: null, status: "building" });
        // the same task finished twice doesn't start another review
        if (piece.status === "approved" || piece.lastTaskId === task.id) return false;
        piece.lastTaskId = task.id;
        if (task.status === "failed") {
          this.pieceNeedsPerson(piece, `**${piece.title}** didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}. Try again to hand it back to its builder, or approve it anyway.`, "retry", "build");
          this.afterPiece(f, step);
          return false;
        }
        return this.reviewPiece(f, team, step, piece, task);
      }
      // a piece's review
      const piece = Object.values(f.pieces).find((p) => p.reviewTaskId === task.id);
      if (piece) {
        piece.reviewTaskId = null;
        piece.lastReviewId = task.id;
        const reviewerRole = this.roleName(team, step.reviewBy);
        if (task.status === "failed") {
          this.pieceNeedsPerson(piece, `The review of **${piece.title}** didn't finish: ${(task.result ?? "no reason given").slice(0, 300)}. Try again to ask for it again, or approve it anyway.`, "retry", "review");
        } else if (verdict === "approved") {
          piece.status = "approved";
        } else if (!verdict) {
          this.pieceNeedsPerson(piece, `${reviewerRole} finished the review of **${piece.title}** without saying "approved" or "changes". Try again to ask for it again, or approve it anyway.`, "retry", "review");
        } else {
          piece.rounds++;
          const max = step.maxRounds ?? DEFAULT_ROUNDS;
          if (piece.rounds >= max) this.pieceNeedsPerson(piece, `**${piece.title}** was sent back ${piece.rounds} time${piece.rounds === 1 ? "" : "s"}. Approve it anyway or give it another round.`, "rounds", "build");
          else if (!this.followUp(f, team, step, piece, `Changes: ${piece.title}`, `${reviewerRole} sent **${piece.title}** back (round ${piece.rounds + 1} of ${max}):\n\n${task.result ?? ""}\n\nMake these changes, then finish this task with task_update (status done).`))
            this.pieceNeedsPerson(piece, `Nobody is left to make the changes to **${piece.title}**. Approve it anyway, or stop.`, "retry", "build");
        }
        this.afterPiece(f, step);
        return false;
      }
    }
    return false;
  }

  /** A piece was built: have the reviewing role check it, unless nobody else can. True when a review started. */
  private reviewPiece(f: TeamFlow, team: ChannelTeam, step: TeamStep, piece: TeamFlowPiece, built: Task): boolean {
    if (!step.reviewBy) {
      piece.status = "approved";
      this.afterPiece(f, step);
      return false;
    }
    const reviewer = this.agentFor(team, step.reviewBy);
    const role = this.roleName(team, step.reviewBy);
    if (!reviewer || reviewer.id === built.toAgentId) {
      this.pieceNeedsPerson(
        piece,
        reviewer
          ? `**${piece.title}** was built by ${reviewer.name}, who is also the ${role}, so nobody else would check it. Pick a different agent for the role, then try again, or approve it anyway.`
          : `Nobody is in the ${role} role to check **${piece.title}**. Pick an agent for it in the Team tab, then try again, or approve it anyway.`,
        "retry",
        "review",
      );
      this.afterPiece(f, step);
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
  private followUp(f: TeamFlow, team: ChannelTeam, step: TeamStep, piece: TeamFlowPiece, title: string, brief: string): boolean {
    const builder = piece.agentId ? this.hub.store.agent(piece.agentId) : undefined;
    if (!builder || !f.taskId) return false;
    const last = piece.lastTaskId ? this.hub.store.task(piece.lastTaskId) : undefined;
    const lead = this.agentFor(team, step.roleId);
    const task = this.delegate!({
      workspaceId: f.workspaceId,
      author: SYSTEM,
      from: lead ? { kind: "agent", id: lead.id } : SYSTEM,
      target: builder,
      title,
      brief,
      channelId: f.channelId,
      hop: 1,
      parentId: f.taskId,
      branch: last?.branch ?? null,
      threadId: f.threadId,
      onBehalfOf: f.requestedBy,
    });
    f.pieceOf = { ...(f.pieceOf ?? {}), [task.id]: piece.taskId };
    piece.status = "building";
    delete piece.problem;
    return true;
  }

  private pieceNeedsPerson(piece: TeamFlowPiece, why: string, options: "retry" | "rounds", redo: "build" | "review") {
    piece.status = "failed";
    piece.problem = { why, options, redo };
  }

  /** Is this task part of a running flow (a step, a piece, or a piece's review)? Flows do their own reviewing. */
  inFlow(task: Task): boolean {
    return this.active(task.workspaceId).some((f) => f.history.some((h) => h.taskId === task.id) || (!!f.taskId && task.parentId === f.taskId) || Object.values(f.pieces).some((p) => p.reviewTaskId === task.id || p.taskId === task.id));
  }

  /** A follow-up on a piece counts as that piece. */
  private pieceKey(f: TeamFlow, taskId: string) {
    return f.pieceOf?.[taskId] ?? taskId;
  }

  private piecesApproved(f: TeamFlow, step: TeamStep): boolean {
    if (!step.reviewBy || !f.taskId) return true;
    // every piece handed out so far, including ones nobody has finished yet
    const keys = new Set(this.hub.store.subtasks(f.taskId).filter((t) => !t.reviewOf).map((t) => this.pieceKey(f, t.id)));
    return [...keys].every((k) => f.pieces[k]?.status === "approved");
  }

  /**
   * After a piece moved: a piece that needs a person waits for one (one at a time); when every
   * piece is approved and the hand-out is done, move on.
   */
  private afterPiece(f: TeamFlow, step: TeamStep) {
    const stuck = Object.values(f.pieces).find((p) => p.status === "failed");
    if (stuck) {
      if (f.status === "waiting" && f.waitingFor?.piece === stuck.taskId) return this.save(f);
      return this.wait(f, stuck.problem?.why ?? `**${stuck.title}** needs a person.`, stuck.problem?.options ?? "retry", stuck.taskId);
    }
    const handOut = f.taskId ? this.hub.store.task(f.taskId) : undefined;
    if (handOut?.status === "done" && this.piecesApproved(f, step)) return this.advance(f, step, handOut.result ?? "");
    // a piece's question is answered; one about the whole step still stands
    if (f.waitingFor?.piece) {
      f.status = "running";
      f.waitingFor = null;
    }
    this.save(f);
  }

  /** What the reviewed step said, so the step after a review gets the work, not "approved". */
  private lastResultBefore(f: TeamFlow, team: ChannelTeam, review: TeamStep): string {
    const back = review.sendBackTo;
    const h = [...f.history].reverse().find((x) => x.stepId === back);
    return (h && this.hub.store.task(h.taskId)?.result) || "";
  }

  private sendBack(f: TeamFlow, team: ChannelTeam, review: TeamStep, notes: string) {
    const max = review.maxRounds ?? DEFAULT_ROUNDS;
    const used = f.rounds[review.id] ?? 1;
    const to = team.steps!.find((s) => s.id === review.sendBackTo);
    if (!to) return this.wait(f, "This review has nowhere to send the work back to. Fix the step in the Team tab, then try again.", "retry");
    if (used >= max) return this.wait(f, `${this.roleName(team, review.roleId)} sent it back ${used} time${used === 1 ? "" : "s"}. Approve it anyway, or give it another round.`, "rounds");
    this.runStep(f, to, { from: this.roleName(team, review.roleId), text: notes || "(no notes given)", sentBack: true });
  }

  // --- the team changed -------------------------------------------------------------

  /** A channel's steps were edited: a request whose step is gone or now means something else stops. */
  teamChanged(channelId: string, before: ChannelTeam | null, after: ChannelTeam | null) {
    const ch = this.hub.store.channel(channelId);
    if (!ch) return;
    for (const f of this.active(ch.workspaceId).filter((x) => x.channelId === channelId)) {
      const was = before?.steps?.find((s) => s.id === f.stepId);
      const now = hasSteps(after) ? after!.steps!.find((s) => s.id === f.stepId) : undefined;
      if (was && now && stepShape(was) === stepShape(now)) continue;
      this.cancelOpen(f, STEPS_CHANGED);
      this.finish(f, "failed", STEPS_CHANGED);
    }
  }

  // --- a person decides --------------------------------------------------------------

  /**
   * On a waiting request: "approve" goes on as if it passed, "retry" runs it again (or another
   * round), "stop" ends it. Stop also ends a running one. Whatever is still open is cancelled.
   */
  decide(flowId: string, action: "approve" | "retry" | "stop"): TeamFlow | undefined {
    const f = this.flow(flowId);
    if (!f || (f.status !== "waiting" && f.status !== "running")) return f;
    if (action === "stop") {
      this.cancelOpen(f, "Stopped by a person.");
      this.finish(f, "failed", "Stopped.");
      return this.flow(flowId);
    }
    if (f.status !== "waiting") return f;
    const team = this.team(f);
    const step = team?.steps!.find((s) => s.id === f.stepId);
    if (!team || !step) {
      this.cancelOpen(f, STEPS_CHANGED);
      this.finish(f, "failed", STEPS_CHANGED);
      return this.flow(flowId);
    }
    // one piece of a hand-out
    const piece = f.waitingFor?.piece ? f.pieces[f.waitingFor.piece] : undefined;
    if (piece) {
      const problem = piece.problem;
      f.status = "running";
      f.waitingFor = null;
      delete piece.problem;
      if (action === "approve") piece.status = "approved";
      else if (problem?.redo === "review") {
        const built = piece.lastTaskId ? this.hub.store.task(piece.lastTaskId) : undefined;
        if (built) {
          this.reviewPiece(f, team, step, piece, built);
          return this.flow(flowId);
        }
        piece.status = "approved";
      } else {
        // another round, or trying a failed piece again: back to its builder
        if (problem?.options === "rounds") piece.rounds = 0;
        const notes = problem?.options === "rounds" ? ((piece.lastReviewId && this.hub.store.task(piece.lastReviewId)?.result) || "") : "";
        const max = step.maxRounds ?? DEFAULT_ROUNDS;
        const brief = problem?.options === "rounds"
          ? `${this.roleName(team, step.reviewBy)} sent **${piece.title}** back, and a person gave it another round (round 1 of ${max}):\n\n${notes}\n\nMake these changes, then finish this task with task_update (status done).`
          : `**${piece.title}** didn't finish last time. Pick it up again, then finish this task with task_update (status done).`;
        if (!this.followUp(f, team, step, piece, `${problem?.options === "rounds" ? "Changes" : "Try again"}: ${piece.title}`, brief))
          this.pieceNeedsPerson(piece, `Nobody is left to work on **${piece.title}**. Approve it anyway, or stop.`, "retry", "build");
      }
      this.afterPiece(f, step);
      return this.flow(flowId);
    }
    this.cancelOpen(f, action === "approve" ? "Approved by a person, so this wasn't needed." : "Started again by a person.");
    if (action === "retry") {
      // another round of a review starts from the step it reviews
      const back = step.kind === "review" ? team.steps!.find((s) => s.id === step.sendBackTo) : undefined;
      if (back && f.waitingFor?.options === "rounds") {
        f.rounds[step.id] = 0;
        const notes = f.taskId ? (this.hub.store.task(f.taskId)?.result ?? "") : "";
        this.runStep(f, back, { from: this.roleName(team, step.roleId), text: notes, sentBack: true });
      } else {
        f.rounds[step.id] = Math.max(0, (f.rounds[step.id] ?? 1) - 1);
        this.runStep(f, step, f.carry ?? null);
      }
      return this.flow(flowId);
    }
    // approve
    for (const p of Object.values(f.pieces)) p.status = "approved";
    const last = [...f.history].reverse().find((h) => h.stepId === step.id);
    if (last && step.kind === "review") last.verdict = "approved";
    this.advance(f, step, step.kind === "review" ? this.lastResultBefore(f, team, step) : ((f.taskId && this.hub.store.task(f.taskId)?.result) ?? f.carry?.text ?? ""));
    return this.flow(flowId);
  }
}
