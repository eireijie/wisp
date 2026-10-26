import type { Actor, Discussion } from "@wisp/core";
import { id } from "./auth.ts";
import type { Hub } from "./hub.ts";

export const MAX_ROUNDS = 5;
/** how many times a channel's leads go back and forth before the plan is written */
export const PLAN_ROUNDS = 2;

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-")
    .slice(0, 60) || "decision";

/**
 * Runs discussions between agents: round 1 everyone answers on their own (in parallel, so nobody
 * anchors on the first answer), later rounds they respond to each other, and then the moderator
 * writes the decision, which is saved to memory, and hands out tasks.
 */
export class Discussions {
  constructor(private hub: Hub) {}

  start(o: { workspaceId: string; channelId: string; topic: string; goal: string; participants: string[]; moderatorId: string; rounds: number; startedBy: Actor; requestedBy: string | null }): Discussion {
    const { store } = this.hub;
    const did = id("disc");
    const names = o.participants.map((a) => this.hub.handleOf(a)).join(", ");
    const root = this.hub.postMessage({
      channelId: o.channelId,
      author: o.startedBy,
      body: `**Discussion: ${o.topic}**${o.goal ? `\n\n${o.goal}` : ""}\n\nWith ${names}. ${this.hub.handleOf(o.moderatorId)} writes up the decision after ${o.rounds} round${o.rounds === 1 ? "" : "s"}.`,
      parts: [{ type: "discussion", discussionId: did }],
      route: false,
    });
    const d = store.createDiscussion({ id: did, workspaceId: o.workspaceId, channelId: o.channelId, threadId: root.id, teamId: null, topic: o.topic, goal: o.goal, participants: o.participants, moderatorId: o.moderatorId, rounds: o.rounds, startedBy: o.startedBy, requestedBy: o.requestedBy });
    this.next(d, 1);
    return store.discussion(d.id)!;
  }

  /**
   * A channel's leads plan a request together, in a thread under it: they each read it and say
   * how they'd go about it, answer each other, and then the first lead writes the plan and hands
   * out the pieces. Nothing is handed out before they've talked.
   */
  plan(o: { workspaceId: string; request: { id: string; channelId: string; body: string }; leads: string[]; requestedBy: string | null; startedBy: Actor }): Discussion {
    const { store } = this.hub;
    const topic = o.request.body.replace(/\s+/g, " ").trim().slice(0, 120) || "A new request";
    const d = store.createDiscussion({
      workspaceId: o.workspaceId,
      channelId: o.request.channelId,
      threadId: o.request.id,
      teamId: null,
      topic,
      goal: "",
      participants: o.leads,
      moderatorId: o.leads[0],
      rounds: PLAN_ROUNDS,
      startedBy: o.startedBy,
      requestedBy: o.requestedBy,
      kind: "plan",
    });
    this.next(d, 1);
    return store.discussion(d.id)!;
  }

  /**
   * Start round `n`, or the write-up once every round is done. Only agents whose device is
   * connected take part: a run for an offline agent would wait for its device and the discussion
   * would wait for the run, so they sit the round out (and someone else writes the decision when
   * the moderator is away). When nobody is there, the discussion stops.
   */
  private next(d: Discussion, n: number) {
    const { store } = this.hub;
    const summary = n > d.rounds;
    const phase = summary ? "summary" : `round:${n}`;
    const handle = (a: string) => this.hub.handleOf(a);
    const list = (ids: string[]) => `${ids.map(handle).join(", ")} ${ids.length === 1 ? "is" : "are"}`;
    const here = (a: string) => {
      const agent = store.agent(a);
      return !!agent && this.hub.agentAvailable(agent);
    };
    const away = d.participants.filter((a) => !here(a));
    let moderatorId = d.moderatorId;
    let standIn = "";
    if (summary && !here(moderatorId)) {
      const other = d.participants.find(here);
      if (other) {
        standIn = ` instead of ${handle(moderatorId)}, who is offline`;
        moderatorId = other;
      }
    }
    const agents = summary ? [moderatorId] : d.participants.filter(here);
    if (!agents.some(here)) {
      const stopped = store.updateDiscussion(d.id, { status: "cancelled" })!;
      this.notice(stopped, summary ? `${handle(moderatorId)} is offline, so nobody can write up the decision. Start the discussion again when an agent is back.` : `${list(away)} offline, so the discussion stopped before round ${n}. Start it again when they're back.`);
      return this.broadcast(d.id);
    }
    const updated = store.updateDiscussion(d.id, { round: n, status: summary ? "summarizing" : "running", moderatorId })!;
    const sitOut = !summary && away.length ? ` (${list(away)} offline and sit${away.length === 1 ? "s" : ""} this round out)` : "";
    const plan = d.kind === "plan";
    this.notice(
      updated,
      summary
        ? `${handle(moderatorId)} is writing up the ${plan ? "plan and handing out the work" : "decision"}${standIn}`
        : plan
          ? n === 1
            ? `${d.participants.map(handle).join(" and ")} are talking it over before handing out work${sitOut}`
            : `The leads are answering each other${sitOut}`
          : `Round ${n} of ${d.rounds}${sitOut}`,
    );
    for (const agentId of agents) {
      const runId = store.createRun({ agentId, channelId: d.channelId, threadId: d.threadId, triggerMessageId: d.threadId, hop: 0, discussionId: d.id, phase, requestedBy: d.requestedBy ?? null });
      this.hub.dispatchRun(runId);
    }
    this.broadcast(updated.id);
  }

  /** A discussion run ended (done, failed or stopped): move on once everyone in this phase is finished. */
  async onRunFinished(run: { discussionId: string | null; phase: string | null }, finalText: string) {
    const { store } = this.hub;
    const d = run.discussionId ? store.discussion(run.discussionId) : undefined;
    if (!d || !run.phase || d.status === "done" || d.status === "cancelled") return;
    const current = d.round > d.rounds ? "summary" : `round:${d.round}`;
    if (run.phase !== current) return;
    if (store.discussionRuns(d.id, run.phase).some((r) => r.status === "queued" || r.status === "running")) return this.broadcast(d.id);
    if (run.phase !== "summary") return this.next(d, d.round + 1);
    const path = await this.saveDecision(d, finalText).catch(() => null);
    const done = store.updateDiscussion(d.id, { status: "done", decisionPath: path })!;
    const what = d.kind === "plan" ? "Plan" : "Decision";
    this.notice(done, path ? `${what} saved to ${path}` : `The discussion is over, but the ${what.toLowerCase()} couldn't be saved to memory`);
    this.broadcast(d.id);
  }

  cancel(d: Discussion) {
    const { store } = this.hub;
    store.updateDiscussion(d.id, { status: "cancelled" });
    for (const r of store.db.prepare("SELECT id FROM runs WHERE discussion_id = ? AND status IN ('queued', 'running')").all(d.id) as { id: string }[]) this.hub.cancelRun(r.id);
    this.notice(store.discussion(d.id)!, "Discussion stopped");
    this.broadcast(d.id);
  }

  /** The decision note goes in the decisions folder of the channel team's memory (or shared/decisions), written by the moderator. */
  private async saveDecision(d: Discussion, text: string): Promise<string> {
    const { store } = this.hub;
    const vault = this.hub.vault(d.workspaceId);
    const team = store.team(d.channelId);
    const dir = `${team?.folder || "shared"}/${d.kind === "plan" ? "plans" : "decisions"}`;
    const date = new Date().toISOString().slice(0, 10);
    let path = `${dir}/${date}-${slug(d.topic)}.md`;
    for (let n = 2; vault.list((p) => p.toLowerCase() === path.toLowerCase()).length; n++) path = `${dir}/${date}-${slug(d.topic)}-${n}.md`;
    const moderator = store.agent(d.moderatorId);
    const fm = [
      `discussion: ${d.id}`,
      `date: ${date}`,
      `participants: [${d.participants.map((a) => `"${this.hub.handleOf(a)}"`).join(", ")}]`,
      `moderator: "${this.hub.handleOf(d.moderatorId)}"`,
      `tags: [${d.kind === "plan" ? "plan" : "decision"}]`,
    ];
    const body = `---\n${fm.join("\n")}\n---\n# ${d.topic}\n\n${text.trim() || "(The moderator didn't write a summary.)"}\n`;
    await vault.write(path, body, moderator ? { name: `@${moderator.handle}`, email: `${moderator.handle}@agents.wisp` } : { name: "Wisp", email: "wisp@localhost" }, `Decision: ${d.topic.slice(0, 60)}`);
    return path;
  }

  /** What a participant needs to know about the discussion it's answering in. */
  promptSection(run: { discussionId: string | null; phase: string | null }): string {
    const { store } = this.hub;
    const d = run.discussionId ? store.discussion(run.discussionId) : undefined;
    if (!d || !run.phase) return "";
    if (d.kind === "plan") return this.planSection(d, run.phase);
    const team = store.team(d.channelId);
    const role = (a: string) => team?.members.find((m) => m.agentId === a)?.role;
    const people = d.participants.map((a) => `${this.hub.handleOf(a)}${role(a) ? ` (${role(a)})` : ""}`).join(", ");
    const goal = d.goal ? `\nGoal: ${d.goal}` : "";
    if (run.phase === "summary") {
      return `## Wrap up the discussion\nYou moderated a discussion on: ${d.topic}${goal}\nParticipants: ${people}.\nThe rounds are over; read the thread above. Your reply is saved as the decision note in ${team?.folder || "shared"}/decisions/, so write it as that note: what was decided and why, what's still open, and the next tasks with an owner for each. Then hand those tasks out with task_delegate so the work starts.`;
    }
    const n = Number(run.phase.split(":")[1]);
    return `## You're in a discussion\nTopic: ${d.topic}${goal}\nParticipants: ${people}. ${this.hub.handleOf(d.moderatorId)} writes up the decision after round ${d.rounds}.\nThis is round ${n} of ${d.rounds}. ${
      n === 1
        ? "Give your own take: what you'd do and the main risks you see. Everyone answers at the same time, so you'll see the others' answers next round."
        : "Read the thread above and respond to the others: what you agree with, where you disagree and why, and how you'd refine the plan. Don't repeat what's already been said."
    }\nKeep it to a few short paragraphs. Don't start the work yet and don't @mention anyone; the discussion moves on by itself.`;
  }

  /** What a lead needs to know while the leads plan a request together. */
  private planSection(d: Discussion, phase: string): string {
    const others = d.participants.filter((a) => a !== d.moderatorId);
    const leads = d.participants.map((a) => this.hub.handleOf(a)).join(", ");
    if (phase === "summary") {
      return `## Write the plan and hand out the work\nYou and the other leads (${leads}) talked over the request at the top of this thread. Read the thread, then reply with the plan you agreed on: the steps, who does each one, and anything still open. Then hand each piece to the agent it's for with task_delegate (to the agents your team chart says get work from a lead; ${others.length ? "a co-lead's agents too" : "your own agents"}), or do a piece yourself when nobody fits. Each piece you hand out opens its own sub-thread here. Your plan is saved to memory as a note.`;
    }
    const n = Number(phase.split(":")[1]);
    return `## Plan this with the other leads first\nYou lead #${this.hub.store.channel(d.channelId)?.name ?? "this channel"} together with ${leads}. A request came in (the message at the top of this thread). Before anyone hands out work, the leads agree on a plan. This is round ${n} of ${d.rounds}. ${
      n === 1
        ? "Say how you'd go about it: the steps, which agents on the team should do which part, and the risks. The other leads answer at the same time, so you'll see their takes next round."
        : "Read what the other leads said and answer them: what you agree with, what you'd change and why, and who should do what. Don't repeat what's already been said."
    }\nKeep it short. Don't hand out work or start on it yet, and don't @mention anyone; ${this.hub.handleOf(d.moderatorId)} writes the plan and hands out the work after round ${d.rounds}.`;
  }

  private notice(d: Discussion, text: string) {
    this.hub.postMessage({ channelId: d.channelId, threadId: d.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "notice", text }], route: false });
  }

  broadcast(discussionId: string) {
    const d = this.hub.store.discussion(discussionId);
    if (d) this.hub.broadcast(d.workspaceId, { type: "discussion", discussion: d });
  }
}
