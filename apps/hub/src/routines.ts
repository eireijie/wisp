import { cronMatches, describeCron, parseCron, zonedParts, type Actor, type RecordedStep, type Routine } from "@warren/core";
import type { Hub } from "./hub.ts";

const WARREN = { name: "Warren", email: "warren@localhost" };

export function routineSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "routine"
  );
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** One line per recorded step, the way the agent reads it. Exported for tests. */
export function stepLine(s: RecordedStep, i: number): string {
  const where = s.x !== undefined && s.y !== undefined ? ` at (${Math.round(s.x)}, ${Math.round(s.y)})` : "";
  const what =
    s.kind === "type"
      ? `typed "${s.text ?? ""}"`
      : s.kind === "key"
        ? `pressed ${s.keys}`
        : s.kind === "scroll"
          ? `scrolled ${s.direction ?? "down"}${where}`
          : s.kind === "drag"
            ? `dragged from (${Math.round(s.x ?? 0)}, ${Math.round(s.y ?? 0)}) to (${Math.round(s.toX ?? 0)}, ${Math.round(s.toY ?? 0)})`
            : s.kind === "note"
              ? `said: "${s.text ?? ""}"`
              : `${{ click: "clicked", double_click: "double-clicked", right_click: "right-clicked" }[s.kind]}${where}`;
  return `${i + 1}. [${clock(s.at)}] ${what}${s.imageFileId ? ` (screen before: file ${s.imageFileId})` : ""}`;
}

/**
 * Routines: things an agent knows how to do again. People teach them by doing a task once
 * while the agent watches, or write the steps; they can run on a schedule.
 */
export class Routines {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private hub: Hub) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run every scheduled routine whose time has come (once per matching minute). */
  async tick(at = new Date()) {
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    for (const r of this.hub.store.scheduledRoutines()) {
      try {
        if (!cronMatches(parseCron(r.schedule!), zonedParts(minute, r.timezone))) continue;
      } catch {
        continue;
      }
      if (r.lastRunAt && new Date(r.lastRunAt).getTime() >= minute.getTime()) continue;
      this.run(r, null, minute);
    }
  }

  /** Where a routine's runs are posted: its channel, or a DM between the agent and whoever made it. */
  channelFor(r: Routine): string | null {
    if (r.channelId && this.hub.store.channel(r.channelId)) return r.channelId;
    const owner = r.createdBy.kind === "user" ? r.createdBy.id : this.hub.store.members(r.workspaceId).find((m) => m.role === "owner")?.id;
    return owner ? this.hub.store.dmChannel(r.workspaceId, owner, r.agentId).id : null;
  }

  /** Wake the agent to do the routine. `by` is the person who pressed Run; null for the schedule (due at `at`). */
  run(r: Routine, by: Actor | null, at = new Date()) {
    const agent = this.hub.store.agent(r.agentId);
    const channelId = this.channelFor(r);
    if (!agent || !channelId) return null;
    this.hub.store.updateRoutine(r.id, { lastRunAt: at.toISOString() });
    const why = by ? "" : ` (${r.schedule ? describeCron(r.schedule).replace(/^Every/, "every") : "scheduled"})`;
    const msg = this.hub.postMessage({
      channelId,
      author: by ?? { kind: "user", id: "system" },
      body: `@${agent.handle} Run the routine **${r.name}**${why}.`,
      parts: [{ type: "routine", routineId: r.id }],
    });
    this.hub.broadcast(r.workspaceId, { type: "routines_changed" });
    return msg;
  }

  /**
   * A person showed the agent how to do something. The recording becomes a note, the routine
   * starts as "learning", and the agent is asked to turn the recording into steps it can follow.
   */
  async teach(o: { workspaceId: string; agentId: string; userId: string; name: string; computerId: string | null; steps: RecordedStep[]; durationMs: number; narration?: string }) {
    const agent = this.hub.store.agent(o.agentId)!;
    const user = this.hub.store.user(o.userId);
    const slug = routineSlug(o.name);
    let base = `agents/${agent.id}/routines/${slug}`;
    for (let i = 2; this.hub.vault.list((p) => p.toLowerCase() === `${base}.md`.toLowerCase()).length; i++) base = `agents/${agent.id}/routines/${slug}-${i}`;
    const computer = o.computerId ? this.hub.store.computer(o.computerId) : undefined;
    const recording = [
      `# Recording: ${o.name}`,
      "",
      `${user?.name ?? "Someone"} did this once on ${computer ? `the computer "${computer.name}"` : "a computer"} so @${agent.handle} could learn it (${clock(o.durationMs)} long, ${o.steps.length} steps).`,
      o.narration?.trim() ? `\n## What they said\n${o.narration.trim()}` : "",
      "",
      "## Steps",
      ...o.steps.map(stepLine),
      "",
    ].join("\n");
    await this.hub.vault.write(`${base}.recording.md`, recording, WARREN, `Recording for routine "${o.name}"`);
    await this.hub.vault.write(
      `${base}.md`,
      `# ${o.name}\n\n@${agent.handle} is learning this from [[${base.split("/").pop()}.recording]]. The steps will appear here.\n`,
      WARREN,
      `New routine "${o.name}"`,
    );
    const routine = this.hub.store.createRoutine({
      workspaceId: o.workspaceId,
      agentId: agent.id,
      name: o.name,
      notePath: `${base}.md`,
      schedule: null,
      timezone: "UTC",
      channelId: null,
      status: "learning",
      createdBy: { kind: "user", id: o.userId },
    });
    const channelId = this.channelFor(routine)!;
    this.hub.postMessage({
      channelId,
      author: { kind: "user", id: o.userId },
      body: `@${agent.handle} I just showed you how to **${o.name}**. Learn it so you can do it on your own next time.`,
      parts: [{ type: "routine", routineId: routine.id }],
    });
    this.hub.broadcast(o.workspaceId, { type: "routines_changed" });
    return routine;
  }

  /** What an agent should know about its routines, for its prompt. */
  async promptSection(agentId: string, trigger: { parts: { type: string; routineId?: string }[] }): Promise<string> {
    const agent = this.hub.store.agent(agentId);
    if (!agent) return "";
    const mine = this.hub.store.routines(agent.workspaceId, agentId);
    const out: string[] = [];
    const part = trigger.parts.find((p) => p.type === "routine");
    const r = part?.routineId ? this.hub.store.routine(part.routineId) : undefined;
    if (r && r.agentId === agentId) {
      const note = await this.hub.vault.read(r.notePath).then((n) => n.content, () => "");
      if (r.status === "learning") {
        const rec = await this.hub.vault.read(r.notePath.replace(/\.md$/, ".recording.md")).then((n) => n.content, () => "");
        out.push(
          `## Learning a routine: ${r.name} (routine id ${r.id})`,
          `A person did this task once while you watched. Their recording is below; the "screen before" files are screenshots you can look at with file_view.`,
          `Work out the steps so you could do it yourself next time: what to open, which buttons and fields to use (describe them by their labels, not by coordinates, since layouts move), what to type, and which parts change from one time to the next. If something is unclear, ask.`,
          `Save the steps with routine_save (routine_id "${r.id}"), then reply with a short summary of what you learned and anything you need to know before running it on your own.`,
          "",
          rec,
        );
      } else {
        out.push(`## Routine to run now: ${r.name}`, `Follow these steps (from ${r.notePath}). If a step doesn't match what you see, adapt; if you get stuck, say what blocked you.`, "", note);
      }
    }
    const others = mine.filter((x) => x.id !== r?.id && x.status === "ready");
    if (others.length) out.push(`\nRoutines you know (steps in your memory, run one when asked): ${others.map((x) => `"${x.name}"${x.schedule ? ` (${describeCron(x.schedule).toLowerCase()})` : ""}`).join(", ")}.`);
    return out.join("\n");
  }
}
