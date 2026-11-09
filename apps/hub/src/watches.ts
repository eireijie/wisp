import { aboutKey, watchEstimate, WATCH_SERVICES, type AppEvent, type Watch, type WatchService, type WatchServiceInfo } from "@wisp/core";
import { id, now } from "./auth.ts";
import { inQuietHours, SLOW_DOWN_AT } from "./background.ts";
import { isPublicUrl } from "./connector-auth.ts";
import { featureOn } from "./features.ts";
import type { Hub } from "./hub.ts";
import { addedLines, lineKey, readPage } from "./page-diff.ts";
import { WatchError, watcherFor, WATCHERS, type FoundEvent } from "./watchers/index.ts";

/** A check waits this long after the last change, so a burst of edits is one check. */
export const DEBOUNCE_MS = 2 * 60_000;
/** …but never longer than this after the first change it holds. */
export const MAX_WAIT_MS = 10 * 60_000;
/** Changes in one check, at most; the rest go in the next. */
const MAX_EVENTS_PER_CHECK = 40;
/** Delivered changes are kept this long (titles and links only), for "what it watched" and repeats. */
const KEEP_DELIVERED_MS = 7 * 24 * 60 * 60_000;
/** Changes that never reached an agent (its background work was off, the allowance was used up) are dropped after this. */
const KEEP_UNDELIVERED_MS = 2 * 24 * 60 * 60_000;
/** Previews (a message line, a subject) go once the agent has seen them, or after this. */
const KEEP_PREVIEW_MS = 24 * 60 * 60_000;
/** A key that was refused is tried again this much later. */
const BAD_KEY_RETRY_MIN = 6 * 60;
/** A person writing to the agent within this long of something it raised counts as an answer. */
const ANSWER_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Things it raised are listed in its checks for this long. */
const MENTIONS_SHOWN_MS = 30 * 24 * 60 * 60_000;
export const BROWSER_EVERY_MINUTES = 6 * 60;
export const BROWSER_MIN_MINUTES = 2 * 60;
/** A page Wisp could read that fails this many looks in a row is handed to the agent's browser. */
const PAGE_FAILS_BEFORE_AGENT = 3;
/** Quiet looks in a row that keep doubling a signed-in site's wait (capped at a day). */
const MAX_QUIET_LOOKS = 4;
/** New lines from the page, at most, passed to the agent. */
const MAX_NEW_LINES = 15;
/** In a browser check's preview: what to look for, then this, then the lines Wisp saw added. */
const NEW_ON_PAGE = "\n[new on the page]\n";

/**
 * Where a website watch stands. `page`: Wisp reads it itself and keeps a key per line (no text), and the
 * agent is woken only when lines were added. Otherwise the agent looks in its own browser, and `quiet`
 * counts its looks in a row that found nothing to say.
 */
type SiteState = { page?: string[]; fails?: number; quiet?: number };
const siteState = (cursor: string | null): SiteState => {
  try {
    return cursor ? (JSON.parse(cursor) as SiteState) : {};
  } catch {
    return {};
  }
};

type WatchRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  service: WatchService;
  label: string;
  connector_id: string | null;
  secret_json: string;
  config_json: string;
  cursor: string | null;
  every_minutes: number;
  paused: number;
  last_polled_at: string | null;
  next_poll_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
};

export interface WatchInput {
  workspaceId: string;
  userId: string;
  agentIds: string[];
  service: WatchService;
  /** whose key to use; found among the agents' connectors when left out */
  connectorId?: string | null;
  /** a key for this watch alone, e.g. one the agent made during setup */
  secrets?: Record<string, string>;
  config?: Record<string, string | string[]>;
  label?: string;
  everyMinutes?: number;
  createdBy: string | null;
}

export interface Mention {
  about: string;
  saidAt: string;
  answeredAt: string | null;
}

const BROWSER_INFO: WatchServiceInfo = {
  service: "browser",
  name: "A website, in the agent's browser",
  catalogIds: [],
  howToConnect:
    "For apps with no easy key (Google, Meta, school and bank sites…): the agent opens the site in its computer's browser, where the person signed in (or with login_fill), and looks for what they asked. Give the address and what to look for. It costs a check each time, so it's slow on purpose.",
  watches: "whatever the person asks it to look for on one site",
  everyMinutes: BROWSER_EVERY_MINUTES,
  minMinutes: BROWSER_MIN_MINUTES,
  available: true,
  unavailableReason: null,
};

/**
 * Watches on people's apps. Every so often the hub asks each app what changed since it last
 * looked (a cursor per watch, no model involved), keeps one short line per change for each agent
 * on the watch, and wakes the agent with a batch once things settle. The agent decides whether to
 * say anything, and says each thing once: `message_person` with an `about` key it already used
 * is refused unless the person answered.
 */
export class Watches {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** Only public addresses, so a watch can't be pointed inside the hub's network. Tests replace it. */
  fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!(await isPublicUrl(url))) throw new WatchError("Watches can only reach public addresses.", true);
    return this.hub.fetchImpl(input, { ...init, redirect: "error" });
  };

  constructor(private hub: Hub) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private get db() {
    return this.hub.store.db;
  }

  // --- what can be watched -------------------------------------------------------------

  services(): WatchServiceInfo[] {
    return [
      ...WATCHERS.map((w) => {
        const why = w.unavailable?.() ?? null;
        return { service: w.service, name: w.name, catalogIds: w.catalogIds, howToConnect: w.howToConnect, watches: w.watches, everyMinutes: w.everyMinutes, minMinutes: w.minMinutes, available: !why, unavailableReason: why };
      }),
      BROWSER_INFO,
    ];
  }

  // --- the watches themselves ------------------------------------------------------------

  private row(watchId: string) {
    return this.db.prepare("SELECT * FROM watches WHERE id = ?").get(watchId) as WatchRow | undefined;
  }

  private agentIds(watchId: string) {
    return (this.db.prepare("SELECT agent_id FROM watch_agents WHERE watch_id = ? ORDER BY agent_id").all(watchId) as { agent_id: string }[]).map((r) => r.agent_id);
  }

  private view(r: WatchRow): Watch {
    const recent = (this.db.prepare("SELECT COUNT(DISTINCT item_id || happened_at) AS n FROM app_events WHERE watch_id = ? AND kind != 'browser_check' AND created_at > ?").get(r.id, new Date(Date.now() - KEEP_DELIVERED_MS).toISOString()) as { n: number }).n;
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      userId: r.user_id,
      service: r.service,
      label: r.label,
      connectorId: r.connector_id,
      hasOwnKey: Object.keys(JSON.parse(r.secret_json)).length > 0,
      config: JSON.parse(r.config_json),
      agentIds: this.agentIds(r.id),
      everyMinutes: r.every_minutes,
      paused: !!r.paused,
      lastPolledAt: r.last_polled_at,
      nextPollAt: r.next_poll_at,
      lastError: r.last_error,
      recentEvents: recent,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  get(watchId: string): Watch | undefined {
    const r = this.row(watchId);
    return r && this.view(r);
  }

  /** A person's watches, or the ones an agent is on. */
  list(workspaceId: string, by: { userId?: string; agentId?: string }): Watch[] {
    const rows = by.agentId
      ? (this.db.prepare("SELECT w.* FROM watches w JOIN watch_agents a ON a.watch_id = w.id WHERE w.workspace_id = ? AND a.agent_id = ?" + (by.userId ? " AND w.user_id = ?" : "") + " ORDER BY w.created_at").all(...[workspaceId, by.agentId, ...(by.userId ? [by.userId] : [])]) as WatchRow[])
      : (this.db.prepare("SELECT * FROM watches WHERE workspace_id = ? AND user_id = ? ORDER BY created_at").all(workspaceId, by.userId ?? "") as WatchRow[]);
    return rows.map((r) => this.view(r));
  }

  /** The running watches an agent is on for one person (they wake it themselves when something changes). */
  active(agentId: string, userId: string): { service: WatchService; connectorId: string | null }[] {
    return (this.db.prepare("SELECT w.service, w.connector_id AS connectorId FROM watches w JOIN watch_agents a ON a.watch_id = w.id WHERE a.agent_id = ? AND w.user_id = ? AND w.paused = 0").all(agentId, userId) as { service: WatchService; connectorId: string | null }[]);
  }

  /** Whether Wisp reads this website watch's page itself (so the agent is only woken when it changes). */
  readsPage(watchId: string) {
    return !!siteState(this.row(watchId)?.cursor ?? null).page;
  }

  /**
   * The person changed how often an agent checks for them: its website watches follow, so "checks every
   * 3 hours" means the same thing for both. Only watches this agent alone is on.
   */
  followPace(agentId: string, userId: string, everyMinutes: number) {
    const every = Math.min(24 * 60, Math.max(BROWSER_MIN_MINUTES, Math.round(everyMinutes)));
    const rows = this.db.prepare("SELECT w.* FROM watches w JOIN watch_agents a ON a.watch_id = w.id WHERE a.agent_id = ? AND w.user_id = ? AND w.service = 'browser' AND (SELECT COUNT(*) FROM watch_agents x WHERE x.watch_id = w.id) = 1").all(agentId, userId) as WatchRow[];
    for (const r of rows) {
      if (r.every_minutes === every) continue;
      const from = r.last_polled_at ? new Date(r.last_polled_at).getTime() : Date.now();
      this.db.prepare("UPDATE watches SET every_minutes = ?, next_poll_at = ? WHERE id = ?").run(every, new Date(from + every * 60_000).toISOString(), r.id);
    }
    if (rows.length) this.changed(this.hub.store.agent(agentId)?.workspaceId ?? "", [agentId]);
  }

  /** The values a watch signs in with: its own key over its connector's. */
  private creds(r: Pick<WatchRow, "connector_id" | "secret_json">): Record<string, string> {
    return { ...(r.connector_id ? this.hub.connectors.values(r.connector_id) ?? {} : {}), ...JSON.parse(r.secret_json) };
  }

  /** Why an agent may not get this watch's changes, or null when it may. */
  private whyNotFor(w: Pick<WatchRow, "workspace_id" | "user_id" | "service" | "connector_id">, agentId: string): string | null {
    const agent = this.hub.store.agent(agentId);
    if (!agent || agent.workspaceId !== w.workspace_id) return "agent not found";
    if (this.hub.whyNotAllowed(agent, w.user_id) || !this.hub.answers(agent, w.user_id)) return `${agent.name} doesn't work for that person`;
    if (w.service === "browser" && !agent.computerId) return `${agent.name} needs its own computer to check a website`;
    if (w.connector_id && !this.hub.connectors.forAgent(agentId).some((c) => c.id === w.connector_id)) return `${agent.name} isn't connected to that app`;
    return null;
  }

  /** Start watching. The first look happens now, so a wrong key is caught while someone is there to fix it. */
  async create(input: WatchInput): Promise<Watch | { error: string }> {
    const { service } = input;
    if (!(WATCH_SERVICES as readonly string[]).includes(service)) return { error: `can't watch "${service}"; pick one of ${WATCH_SERVICES.join(", ")}` };
    const agentIds = [...new Set(input.agentIds)];
    if (!agentIds.length) return { error: "pick at least one agent" };
    const config = input.config ?? {};
    let connectorId = input.connectorId ?? null;
    const secrets = Object.fromEntries(Object.entries(input.secrets ?? {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
    let cursor: string | null = null;
    let label = input.label?.trim().slice(0, 80) || "";
    let every: number;
    const at = new Date();

    if (service === "browser") {
      const url = String(config.url ?? "");
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: "a browser watch needs the site's address (config.url)" };
      if (!String(config.lookFor ?? "").trim()) return { error: "say what to look for on the site (config.lookFor)" };
      label ||= `${new URL(url).hostname.replace(/^www\./, "")} (browser)`;
      // unless it's told otherwise, it looks as often as the agent checks in for this person, so the two never disagree
      const pace = agentIds.length === 1 ? this.hub.store.background(agentIds[0], input.userId)?.everyMinutes : undefined;
      every = Math.min(24 * 60, Math.max(BROWSER_MIN_MINUTES, Math.round(input.everyMinutes ?? pace ?? BROWSER_EVERY_MINUTES)));
      // a page Wisp can read itself is compared from now on, at no cost; the agent already saw it while setting this up
      const read = await readPage(this.fetch, url);
      if (read.ok) cursor = JSON.stringify({ page: read.lines.map(lineKey) } satisfies SiteState);
    } else {
      const w = watcherFor(service)!;
      const why = w.unavailable?.();
      if (why) return { error: why };
      const has = (c: Record<string, string>) => w.needs.every((any) => any.some((k) => c[k]?.trim()));
      if (connectorId) {
        const c = this.hub.connectors.get(connectorId);
        if (!c || c.workspaceId !== input.workspaceId) return { error: "connector not found" };
      } else if (!has(secrets)) {
        // the agents' own connector for this app, if one holds the key
        connectorId = agentIds.flatMap((a) => this.hub.connectors.forAgent(a)).find((c) => c.catalogId && w.catalogIds.includes(c.catalogId) && has(this.hub.connectors.values(c.id) ?? {}))?.id ?? null;
      }
      const creds = this.creds({ connector_id: connectorId, secret_json: JSON.stringify(secrets) });
      if (!has(creds)) return { error: `${w.name} needs ${w.needs.map((any) => any.join(" or ")).join(" and ")}. ${w.howToConnect}` };
      label ||= w.name;
      every = Math.min(24 * 60, Math.max(w.minMinutes, Math.round(input.everyMinutes ?? w.everyMinutes)));
      try {
        cursor = (await w.poll({ creds, config, cursor: null, fetch: this.fetch, now: at })).cursor;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const probe = { workspace_id: input.workspaceId, user_id: input.userId, service, connector_id: connectorId };
    for (const a of agentIds) {
      const why = this.whyNotFor(probe, a);
      if (why) return { error: why };
    }
    const wid = id("watch");
    // a site only the agent can see is looked at now, so it learns what the page looks like today
    const agentLooks = service === "browser" && !cursor;
    const nextPoll = agentLooks ? at : new Date(at.getTime() + every * 60_000);
    this.db
      .prepare("INSERT INTO watches (id, workspace_id, user_id, service, label, connector_id, secret_json, config_json, cursor, every_minutes, paused, last_polled_at, next_poll_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)")
      .run(wid, input.workspaceId, input.userId, service, label, connectorId, JSON.stringify(secrets), JSON.stringify(config), cursor, every, agentLooks ? null : at.toISOString(), nextPoll.toISOString(), input.createdBy, now());
    for (const a of agentIds) this.db.prepare("INSERT OR IGNORE INTO watch_agents (watch_id, agent_id) VALUES (?, ?)").run(wid, a);
    this.changed(input.workspaceId, agentIds);
    return this.get(wid)!;
  }

  update(watchId: string, patch: { paused?: boolean; agentIds?: string[]; everyMinutes?: number; config?: Record<string, string | string[]>; label?: string }): Watch | { error: string } {
    const r = this.row(watchId);
    if (!r) return { error: "watch not found" };
    const before = this.agentIds(watchId);
    if (patch.agentIds) {
      for (const a of patch.agentIds) {
        const why = this.whyNotFor(r, a);
        if (why) return { error: why };
      }
      this.db.prepare("DELETE FROM watch_agents WHERE watch_id = ?").run(watchId);
      for (const a of new Set(patch.agentIds)) this.db.prepare("INSERT INTO watch_agents (watch_id, agent_id) VALUES (?, ?)").run(watchId, a);
      // agents taken off it don't get what was waiting for them
      this.db.prepare(`DELETE FROM app_events WHERE watch_id = ? AND run_id IS NULL AND agent_id NOT IN (${patch.agentIds.map(() => "?").join(",") || "''"})`).run(watchId, ...patch.agentIds);
    }
    const min = r.service === "browser" ? BROWSER_MIN_MINUTES : watcherFor(r.service)!.minMinutes;
    if (patch.everyMinutes !== undefined) this.db.prepare("UPDATE watches SET every_minutes = ? WHERE id = ?").run(Math.min(24 * 60, Math.max(min, Math.round(patch.everyMinutes))), watchId);
    if (patch.config) this.db.prepare("UPDATE watches SET config_json = ? WHERE id = ?").run(JSON.stringify(patch.config), watchId);
    if (patch.label?.trim()) this.db.prepare("UPDATE watches SET label = ? WHERE id = ?").run(patch.label.trim().slice(0, 80), watchId);
    if (patch.paused !== undefined) {
      this.db.prepare("UPDATE watches SET paused = ?, next_poll_at = ? WHERE id = ?").run(patch.paused ? 1 : 0, patch.paused ? r.next_poll_at : now(), watchId);
      // paused: nothing it saw before is sent on
      if (patch.paused) this.db.prepare("DELETE FROM app_events WHERE watch_id = ? AND run_id IS NULL").run(watchId);
    }
    this.changed(r.workspace_id, [...before, ...(patch.agentIds ?? [])]);
    return this.get(watchId)!;
  }

  /** Stop watching: the watch, its key and everything it saw are gone. */
  remove(watchId: string) {
    const r = this.row(watchId);
    if (!r) return false;
    const agents = this.agentIds(watchId);
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(watchId);
    this.changed(r.workspace_id, agents);
    return true;
  }

  /** One agent stops; the watch goes when nobody is left on it. */
  removeAgent(watchId: string, agentId: string) {
    const r = this.row(watchId);
    if (!r) return false;
    this.db.prepare("DELETE FROM watch_agents WHERE watch_id = ? AND agent_id = ?").run(watchId, agentId);
    this.db.prepare("DELETE FROM app_events WHERE watch_id = ? AND agent_id = ? AND run_id IS NULL").run(watchId, agentId);
    if (!this.agentIds(watchId).length) return this.remove(watchId);
    this.changed(r.workspace_id, [agentId]);
    return true;
  }

  private changed(workspaceId: string, agentIds: string[]) {
    this.hub.broadcast(workspaceId, { type: "watches_changed" });
    for (const a of new Set(agentIds)) this.hub.broadcast(workspaceId, { type: "background_changed", agentId: a });
  }

  // --- looking -------------------------------------------------------------------------

  /** Look at every watch that's due, then wake agents whose changes have settled. */
  async tick(at = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = this.db.prepare("SELECT * FROM watches WHERE paused = 0 AND (next_poll_at IS NULL OR next_poll_at <= ?) ORDER BY next_poll_at LIMIT 20").all(at.toISOString()) as WatchRow[];
      for (const r of due) await this.look(r, at);
      this.deliver(at);
      this.prune(at);
    } finally {
      this.busy = false;
    }
  }

  private async look(r: WatchRow, at: Date) {
    const after = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
    if (r.service === "browser") return this.lookAtSite(r, at);
    const w = watcherFor(r.service);
    if (!w) return;
    try {
      const res = await w.poll({ creds: this.creds(r), config: JSON.parse(r.config_json), cursor: r.cursor, fetch: this.fetch, now: at });
      this.record(r, res.events, at);
      this.db.prepare("UPDATE watches SET cursor = ?, last_polled_at = ?, next_poll_at = ?, last_error = NULL WHERE id = ?").run(res.cursor, at.toISOString(), after(r.every_minutes), r.id);
      if (r.last_error) this.changed(r.workspace_id, this.agentIds(r.id));
    } catch (e) {
      const bad = e instanceof WatchError && e.badKey;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      this.db.prepare("UPDATE watches SET last_error = ?, next_poll_at = ? WHERE id = ?").run(msg, after(bad ? BAD_KEY_RETRY_MIN : Math.min(60, r.every_minutes * 2)), r.id);
      if (msg !== r.last_error) this.changed(r.workspace_id, this.agentIds(r.id));
    }
  }

  /**
   * A website watch's look. Wisp reads the page itself when it can (no sign-in needed, the text is in the
   * page) and wakes the agent only with lines that are new. Otherwise the agent looks in its browser.
   */
  private async lookAtSite(r: WatchRow, at: Date) {
    const after = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
    const c = JSON.parse(r.config_json) as Record<string, string>;
    const state = siteState(r.cursor);
    const lookFor = String(c.lookFor ?? "").slice(0, 300);
    const check = (preview: string) => this.record(r, [{ kind: "browser_check", itemId: `browser:${r.id}`, title: r.label, url: c.url ?? null, actor: null, preview, happenedAt: at.toISOString() }], at);
    const read = await readPage(this.fetch, c.url ?? "");
    if (read.ok) {
      const added = state.page ? addedLines(state.page, read.lines) : [];
      if (added.length) check(lookFor + NEW_ON_PAGE + added.slice(0, MAX_NEW_LINES).map((l) => l.slice(0, 200)).join("\n"));
      this.db.prepare("UPDATE watches SET cursor = ?, last_polled_at = ?, next_poll_at = ?, last_error = NULL WHERE id = ?").run(JSON.stringify({ page: read.lines.map(lineKey) } satisfies SiteState), at.toISOString(), after(r.every_minutes), r.id);
      return;
    }
    // it could read the page before: try again a few times before paying for the agent to look
    if (state.page && (state.fails ?? 0) + 1 < PAGE_FAILS_BEFORE_AGENT) {
      this.db.prepare("UPDATE watches SET cursor = ?, last_error = ?, next_poll_at = ? WHERE id = ?").run(JSON.stringify({ ...state, fails: (state.fails ?? 0) + 1 } satisfies SiteState), `Couldn't read the page: ${read.why}`.slice(0, 300), after(Math.min(60, r.every_minutes)), r.id);
      return;
    }
    check(lookFor);
    this.db.prepare("UPDATE watches SET cursor = ?, last_polled_at = ?, next_poll_at = ?, last_error = NULL WHERE id = ?").run(JSON.stringify({ quiet: state.quiet ?? 0 } satisfies SiteState), at.toISOString(), after(r.every_minutes), r.id);
  }

  /**
   * A check that looked at sites in the agent's browser ended. Looks that found nothing to tell the person
   * stretch that site's wait, doubling from the second in a row up to a day; anything else starts over.
   */
  checked(runId: string, quiet: boolean) {
    const ids = (this.db.prepare("SELECT DISTINCT watch_id AS id FROM app_events WHERE run_id = ? AND kind = 'browser_check'").all(runId) as { id: string }[]).map((x) => x.id);
    for (const wid of ids) {
      const r = this.row(wid);
      if (!r) continue;
      const state = siteState(r.cursor);
      if (state.page) continue;
      const streak = quiet ? Math.min(MAX_QUIET_LOOKS, (state.quiet ?? 0) + 1) : 0;
      let next = r.next_poll_at;
      if (streak > 1 && r.last_polled_at) {
        const later = new Date(new Date(r.last_polled_at).getTime() + Math.min(24 * 60, r.every_minutes * 2 ** (streak - 1)) * 60_000).toISOString();
        if (!next || later > next) next = later;
      }
      this.db.prepare("UPDATE watches SET cursor = ?, next_poll_at = ? WHERE id = ?").run(JSON.stringify({ ...state, quiet: streak } satisfies SiteState), next, wid);
    }
  }

  /** One row per change for each agent that may see it. Repeats (same thing, same time) are dropped. */
  private record(r: WatchRow, events: FoundEvent[], at: Date) {
    if (!events.length) return;
    const agents = this.agentIds(r.id).filter((a) => !this.whyNotFor(r, a));
    const insert = this.db.prepare("INSERT OR IGNORE INTO app_events (id, watch_id, agent_id, user_id, service, kind, item_id, title, url, actor, preview, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const t = at.toISOString();
    this.db.transaction(() => {
      for (const e of events)
        for (const a of agents) insert.run(id("evt"), r.id, a, r.user_id, r.service, e.kind.slice(0, 40), e.itemId.slice(0, 300), e.title.slice(0, 200), e.url?.slice(0, 1000) ?? null, e.actor?.slice(0, 120) ?? null, e.preview?.slice(0, e.kind === "browser_check" ? 4000 : 300) ?? null, new Date(e.happenedAt).toISOString(), t);
    })();
  }

  /**
   * Wake agents with what's waiting for them, once it's settled (DEBOUNCE_MS since the last change,
   * or MAX_WAIT_MS since the first), the way their background work allows: it's on, it isn't quiet
   * hours, and the person's allowance and the agent's daily checks aren't used up. Browser checks
   * go as soon as they're due. Changes that can't go yet wait.
   */
  deliver(at = new Date()) {
    const { store, background } = this.hub;
    const groups = this.db
      .prepare("SELECT agent_id AS agentId, user_id AS userId, MIN(created_at) AS first, MAX(created_at) AS last, MAX(kind = 'browser_check') AS browser FROM app_events WHERE run_id IS NULL GROUP BY agent_id, user_id")
      .all() as { agentId: string; userId: string; first: string; last: string; browser: number }[];
    for (const g of groups) {
      const agent = store.agent(g.agentId);
      const b = store.background(g.agentId, g.userId);
      if (!agent || !b?.enabled || !featureOn(store, agent.workspaceId, "background")) continue;
      const share = background.allowanceShare(agent.workspaceId, g.userId, at);
      if (share >= 1) continue;
      // near the end of the allowance, changes are gathered for twice as long
      const slow = share >= SLOW_DOWN_AT ? 2 : 1;
      const settled = at.getTime() - new Date(g.last).getTime() >= DEBOUNCE_MS * slow || at.getTime() - new Date(g.first).getTime() >= MAX_WAIT_MS * slow;
      if (!g.browser && !settled) continue;
      const tz = store.user(g.userId)?.timezone || "UTC";
      if (inQuietHours(at, tz, b.quietStart, b.quietEnd)) continue;
      if (background.capReached(g.agentId, g.userId, b.dailyCap, at)) continue;
      const ids = (this.db.prepare("SELECT id FROM app_events WHERE run_id IS NULL AND agent_id = ? AND user_id = ? ORDER BY happened_at LIMIT ?").all(g.agentId, g.userId, MAX_EVENTS_PER_CHECK) as { id: string }[]).map((r) => r.id);
      background.wake(g.agentId, g.userId, [], at, ids);
    }
  }

  /** The changes a check carries. Called by `wake` before the check is sent, so its prompt has them. */
  claim(eventIds: string[], runId: string) {
    const set = this.db.prepare("UPDATE app_events SET run_id = ? WHERE id = ? AND run_id IS NULL");
    this.db.transaction(() => eventIds.forEach((e) => set.run(runId, e)))();
  }

  /** A check that never started gives its changes back. */
  release(runId: string) {
    this.db.prepare("UPDATE app_events SET run_id = NULL WHERE run_id = ?").run(runId);
  }

  /** The check is over: the agent has seen the previews, so they go. Titles and links stay a week. */
  delivered(runId: string) {
    this.db.prepare("UPDATE app_events SET preview = NULL WHERE run_id = ?").run(runId);
  }

  eventsForRun(runId: string): AppEvent[] {
    return (this.db.prepare("SELECT id, watch_id AS watchId, service, kind, item_id AS itemId, title, url, actor, preview, happened_at AS happenedAt FROM app_events WHERE run_id = ? ORDER BY happened_at").all(runId) as AppEvent[]);
  }

  /** What a watch saw lately, for the person: titles and links, never previews. */
  recent(watchId: string, limit = 20): Omit<AppEvent, "preview">[] {
    return this.db.prepare("SELECT MIN(id) AS id, watch_id AS watchId, service, kind, item_id AS itemId, title, url, actor, happened_at AS happenedAt FROM app_events WHERE watch_id = ? AND kind != 'browser_check' GROUP BY item_id, happened_at ORDER BY happened_at DESC LIMIT ?").all(watchId, limit) as Omit<AppEvent, "preview">[];
  }

  private prune(at: Date) {
    const ago = (ms: number) => new Date(at.getTime() - ms).toISOString();
    this.db.prepare("DELETE FROM app_events WHERE (run_id IS NOT NULL AND created_at < ?) OR (run_id IS NULL AND created_at < ?)").run(ago(KEEP_DELIVERED_MS), ago(KEEP_UNDELIVERED_MS));
    this.db.prepare("UPDATE app_events SET preview = NULL WHERE preview IS NOT NULL AND created_at < ?").run(ago(KEEP_PREVIEW_MS));
  }

  // --- saying each thing once ------------------------------------------------------------

  mention(agentId: string, userId: string, about: string): Mention | undefined {
    return this.db.prepare("SELECT about, said_at AS saidAt, answered_at AS answeredAt FROM mentions WHERE agent_id = ? AND user_id = ? AND about = ?").get(agentId, userId, aboutKey(about)) as Mention | undefined;
  }

  /** Whether the agent may raise this: never raised, or raised and answered. Unanswered means dropped for good. */
  mayRaise(agentId: string, userId: string, about: string): { ok: true } | { ok: false; saidAt: string } {
    const m = this.mention(agentId, userId, about);
    return !m || m.answeredAt ? { ok: true } : { ok: false, saidAt: m.saidAt };
  }

  raised(agentId: string, userId: string, about: string, messageId: string) {
    this.db.prepare("INSERT INTO mentions (agent_id, user_id, about, message_id, said_at, answered_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(agent_id, user_id, about) DO UPDATE SET message_id = excluded.message_id, said_at = excluded.said_at, answered_at = NULL").run(agentId, userId, aboutKey(about), messageId, now());
  }

  /** The person wrote to the agent: what it raised lately was answered. */
  personWrote(agentId: string, userId: string, at = new Date()) {
    this.db.prepare("UPDATE mentions SET answered_at = ? WHERE agent_id = ? AND user_id = ? AND answered_at IS NULL AND said_at > ?").run(at.toISOString(), agentId, userId, new Date(at.getTime() - ANSWER_WINDOW_MS).toISOString());
  }

  mentions(agentId: string, userId: string, at = new Date()): Mention[] {
    return this.db.prepare("SELECT about, said_at AS saidAt, answered_at AS answeredAt FROM mentions WHERE agent_id = ? AND user_id = ? AND said_at > ? ORDER BY said_at DESC LIMIT 40").all(agentId, userId, new Date(at.getTime() - MENTIONS_SHOWN_MS).toISOString()) as Mention[];
  }

  // --- what a check is told ------------------------------------------------------------------

  /** The changes a check carries and what the agent already raised, for its prompt. */
  promptLines(run: { id: string; agentId: string; requestedBy: string | null }, name: string, fmt: (iso: string) => string): string[] {
    const events = this.eventsForRun(run.id);
    const mentions = run.requestedBy ? this.mentions(run.agentId, run.requestedBy) : [];
    const watches = run.requestedBy ? this.list(this.hub.store.agent(run.agentId)?.workspaceId ?? "", { agentId: run.agentId, userId: run.requestedBy }) : [];
    const out: string[] = [];
    const apps = events.filter((e) => e.kind !== "browser_check");
    const sites = events.filter((e) => e.kind === "browser_check");
    if (apps.length) {
      const label = new Map(watches.map((w) => [w.id, w.label]));
      out.push(
        `\nThis check is because something changed in ${name}'s apps:`,
        ...apps.map((e) => `- [${label.get(e.watchId) ?? e.service}] ${e.kind.replace(/_/g, " ")}: ${e.title}${e.actor ? ` (by ${e.actor})` : ""}, ${fmt(e.happenedAt)}${e.preview ? ` — "${e.preview}"` : ""}${e.url ? ` ${e.url}` : ""} [about: ${e.service}:${e.itemId}]`),
        `Open what matters with your connectors if you need more than this. If it looks like ${name} is working on something you could help with, you may offer once ("I see you're working on <thing>, want a hand?"). Most changes need nothing from you.`,
      );
    }
    for (const s of sites) {
      const [lookFor, added] = (s.preview ?? "").split(NEW_ON_PAGE);
      out.push(
        added
          ? `\n${s.title} changed. Wisp read ${s.url} and these lines are new since it last looked:\n${added.split("\n").map((l) => `  ${l}`).join("\n")}\nYou're watching it for: ${lookFor}. If these lines answer that, you don't need to open the site; open it only to see more. Most changes need nothing from you. Only tell ${name} what's new and matters.`
          : `\nTime to look at ${s.title}: open ${s.url} in your computer's browser (if it asks you to sign in, use login_fill or ask ${name}), and look for: ${lookFor}. Compare with your watch notes and write down what you saw. Only tell ${name} what's new and matters.`,
      );
    }
    const watchedSites = watches.filter((w) => w.service === "browser" && !w.paused);
    if (watchedSites.length && !sites.length)
      out.push(`\nWisp watches ${watchedSites.map((w) => w.config.url ?? w.label).join(", ")} for you and wakes you when ${watchedSites.length === 1 ? "it changes" : "they change"}, so don't open ${watchedSites.length === 1 ? "it" : "them"} on this check.`);
    if (events.length || mentions.length)
      out.push(
        `\nSay each thing once. When you message ${name} about something, pass \`about\` to message_person with its key (the [about: …] above, or your own short one like "essay-due-friday"). If they don't answer, it's dropped for good: Wisp won't let you raise the same key again unless they wrote back.`,
      );
    if (mentions.length) out.push(`Already raised (don't raise these again unless they answered and something new happened):`, ...mentions.map((m) => `- ${m.about}: ${fmt(m.saidAt)}, ${m.answeredAt ? "they answered" : "no answer, so dropped"}`));
    // apps it's connected to that could tell it about changes, but don't yet
    const unwatched = this.hub.connectors.forAgent(run.agentId).filter((c) => !watches.some((w) => w.connectorId === c.id) && WATCHERS.some((w) => !!c.catalogId && w.catalogIds.includes(c.catalogId) && !w.unavailable?.()));
    if (unwatched.length)
      out.push(`\nYou're connected to ${unwatched.map((c) => c.name).join(", ")}, but Wisp doesn't tell you when ${unwatched.length === 1 ? "it changes" : "they change"}. If ${name} would want that, ask once (about: "watch:${unwatched[0].catalogId}") and start it with watch_start.`);
    const broken = watches.filter((w) => w.lastError);
    if (broken.length) out.push(`\nWatches that couldn't look last time:`, ...broken.map((w) => `- ${w.label}: ${w.lastError}`), `If it's a key problem, tell ${name} once how to fix it.`);
    return out;
  }

  /** What a watch may cost, against the person's allowance. */
  estimate(workspaceId: string, userId: string, service: WatchService, everyMinutes?: number, watchId?: string) {
    const every = everyMinutes ?? (service === "browser" ? BROWSER_EVERY_MINUTES : watcherFor(service)?.everyMinutes ?? 5);
    return watchEstimate(service, every, this.hub.background.dailyTokens(workspaceId, userId), !!watchId && this.readsPage(watchId));
  }
}
