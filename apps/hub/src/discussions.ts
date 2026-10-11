import type { Actor, Discussion } from "@warren/core";
import { id } from "./auth.ts";
import type { Hub } from "./hub.ts";

export const MAX_ROUNDS = 5;

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

  start(o: { workspaceId: string; channelId: string; teamId: string | null; topic: string; goal: string; participants: string[]; moderatorId: string; rounds: number; startedBy: Actor }): Discussion {
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
    const d = store.createDiscussion({ id: did, workspaceId: o.workspaceId, channelId: o.channelId, threadId: root.id, teamId: o.teamId, topic: o.topic, goal: o.goal, participants: o.participants, moderatorId: o.moderatorId, rounds: o.rounds, startedBy: o.startedBy });
    this.next(d, 1);
    return store.discussion(d.id)!;
  }

  /** Start round `n`, or the write-up once every round is done. */
  private next(d: Discussion, n: number) {
    const { store } = this.hub;
    const summary = n > d.rounds;
    const phase = summary ? "summary" : `round:${n}`;
    const updated = store.updateDiscussion(d.id, { round: n, status: summary ? "summarizing" : "running" })!;
    this.notice(updated, summary ? `${this.hub.handleOf(d.moderatorId)} is writing up the decision` : `Round ${n} of ${d.rounds}`);
    for (const agentId of summary ? [d.moderatorId] : d.participants) {
      const runId = store.createRun({ agentId, channelId: d.channelId, threadId: d.threadId, triggerMessageId: d.threadId, hop: 0, discussionId: d.id, phase });
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
    this.notice(done, path ? `Decision saved to ${path}` : "The discussion is over, but the decision couldn't be saved to memory");
    this.broadcast(d.id);
  }

  cancel(d: Discussion) {
    const { store } = this.hub;
    store.updateDiscussion(d.id, { status: "cancelled" });
    for (const r of store.db.prepare("SELECT id FROM runs WHERE discussion_id = ? AND status IN ('queued', 'running')").all(d.id) as { id: string }[]) this.hub.cancelRun(r.id);
    this.notice(store.discussion(d.id)!, "Discussion stopped");
    this.broadcast(d.id);
  }

  /** The decision note goes in the team's decisions folder (or shared/decisions), written by the moderator. */
  private async saveDecision(d: Discussion, text: string): Promise<string> {
    const { store, vault } = this.hub;
    const team = d.teamId ? store.team(d.teamId) : undefined;
    const dir = `${team?.folder ?? "shared"}/decisions`;
    const date = new Date().toISOString().slice(0, 10);
    let path = `${dir}/${date}-${slug(d.topic)}.md`;
    for (let n = 2; vault.list((p) => p.toLowerCase() === path.toLowerCase()).length; n++) path = `${dir}/${date}-${slug(d.topic)}-${n}.md`;
    const moderator = store.agent(d.moderatorId);
    const fm = [
      `discussion: ${d.id}`,
      `date: ${date}`,
      `participants: [${d.participants.map((a) => `"${this.hub.handleOf(a)}"`).join(", ")}]`,
      `moderator: "${this.hub.handleOf(d.moderatorId)}"`,
      "tags: [decision]",
    ];
    const body = `---\n${fm.join("\n")}\n---\n# ${d.topic}\n\n${text.trim() || "(The moderator didn't write a summary.)"}\n`;
    await vault.write(path, body, moderator ? { name: `@${moderator.handle}`, email: `${moderator.handle}@agents.warren` } : { name: "Warren", email: "warren@localhost" }, `Decision: ${d.topic.slice(0, 60)}`);
    return path;
  }

  /** What a participant needs to know about the discussion it's answering in. */
  promptSection(run: { discussionId: string | null; phase: string | null }): string {
    const { store } = this.hub;
    const d = run.discussionId ? store.discussion(run.discussionId) : undefined;
    if (!d || !run.phase) return "";
    const team = d.teamId ? store.team(d.teamId) : undefined;
    const role = (a: string) => team?.members.find((m) => m.agentId === a)?.role;
    const people = d.participants.map((a) => `${this.hub.handleOf(a)}${role(a) ? ` (${role(a)})` : ""}`).join(", ");
    const goal = d.goal ? `\nGoal: ${d.goal}` : "";
    if (run.phase === "summary") {
      return `## Wrap up the discussion\nYou moderated a discussion on: ${d.topic}${goal}\nParticipants: ${people}.\nThe rounds are over; read the thread above. Your reply is saved as the decision note in ${team?.folder ?? "shared"}/decisions/, so write it as that note: what was decided and why, what's still open, and the next tasks with an owner for each. Then hand those tasks out with task_delegate so the work starts.`;
    }
    const n = Number(run.phase.split(":")[1]);
    return `## You're in a discussion\nTopic: ${d.topic}${goal}\nParticipants: ${people}. ${this.hub.handleOf(d.moderatorId)} writes up the decision after round ${d.rounds}.\nThis is round ${n} of ${d.rounds}. ${
      n === 1
        ? "Give your own take: what you'd do and the main risks you see. Everyone answers at the same time, so you'll see the others' answers next round."
        : "Read the thread above and respond to the others: what you agree with, where you disagree and why, and how you'd refine the plan. Don't repeat what's already been said."
    }\nKeep it to a few short paragraphs. Don't start the work yet and don't @mention anyone; the discussion moves on by itself.`;
  }

  private notice(d: Discussion, text: string) {
    this.hub.postMessage({ channelId: d.channelId, threadId: d.threadId, author: { kind: "user", id: "system" }, body: "", parts: [{ type: "notice", text }], route: false });
  }

  broadcast(discussionId: string) {
    const d = this.hub.store.discussion(discussionId);
    if (d) this.hub.broadcast(d.workspaceId, { type: "discussion", discussion: d });
  }
}
