import { cronMatches, parseCron, SCHEDULE_MARK, zonedParts, type TeamFlow, type TeamStep } from "@wisp/core";
import type { Hub } from "./hub.ts";

/** Schedule boxes on team flow charts: at their times they ask the team and start the steps they point to. */
export class TeamSchedules {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private hub: Hub) {
    hub.store.db.exec(`CREATE TABLE IF NOT EXISTS team_schedule_runs (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, step_id TEXT NOT NULL, last_run_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, step_id)
    )`);
  }

  start() {
    this.timer = setInterval(() => this.tick(), 20_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run every schedule whose time has come, once per matching minute. A time the hub slept through is skipped, and so is one that finds the last run still going. */
  tick(at = new Date()) {
    const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const rows = this.hub.store.db.prepare(`SELECT id FROM channels WHERE kind = 'channel' AND archived_at IS NULL AND settings_json LIKE '%"kind":"schedule"%'`).all() as { id: string }[];
    for (const { id } of rows) {
      for (const s of this.hub.store.channel(id)?.settings.team?.steps ?? []) {
        if (s.kind !== "schedule" || s.enabled === false || !this.due(s, minute)) continue;
        const last = this.lastRun(id, s.id);
        if (last && new Date(last).getTime() >= minute.getTime()) continue;
        this.hub.store.db.prepare("INSERT OR REPLACE INTO team_schedule_runs (channel_id, step_id, last_run_at) VALUES (?, ?, ?)").run(id, s.id, minute.toISOString());
        this.run(id, s.id, null);
      }
    }
  }

  private due(s: TeamStep, minute: Date): boolean {
    try {
      return cronMatches(parseCron(s.schedule ?? ""), zonedParts(minute, s.timezone || "UTC"));
    } catch {
      return false;
    }
  }

  private lastRun(channelId: string, stepId: string): string | null {
    const r = this.hub.store.db.prepare("SELECT last_run_at FROM team_schedule_runs WHERE channel_id = ? AND step_id = ?").get(channelId, stepId) as { last_run_at: string } | undefined;
    return r?.last_run_at ?? null;
  }

  /** Start one run now. `by` is the person who pressed Run now; null for the clock. Null back when there's no such schedule or its last run is still going. */
  run(channelId: string, stepId: string, by: string | null): TeamFlow | null {
    const channel = this.hub.store.channel(channelId);
    const step = channel?.settings.team?.steps?.find((s) => s.id === stepId && s.kind === "schedule");
    if (!channel || !step || !this.hub.flows.runsSteps(channel) || this.hub.flows.scheduleBusy(channelId, stepId)) return null;
    // it works for whoever set it up, while they're still here
    const owner = step.scheduledBy && this.hub.store.members(channel.workspaceId).some((m) => m.id === step.scheduledBy) ? step.scheduledBy : null;
    const requestedBy = by ?? owner;
    const msg = this.hub.postMessage({
      channelId,
      author: { kind: "user", id: "system" },
      body: (step.prompt ?? "").trim(),
      parts: [{ type: "status", text: SCHEDULE_MARK }],
      route: false,
      onBehalfOf: requestedBy,
    });
    return this.hub.flows.start(msg, channel.workspaceId, requestedBy, 0, stepId);
  }
}
