/**
 * Watches: an agent keeping an eye on one of the person's apps. The hub asks the app what changed
 * (no model, no tokens), keeps a short line about each change, and wakes the agents on the watch
 * with a batch of them. Apps with no easy API are watched by the agent itself, in its computer's
 * browser, on a slow schedule.
 */

/** Apps the hub can ask what changed, plus "browser" for the ones the agent checks itself. */
export const WATCH_SERVICES = ["slack", "github", "notion", "linear", "jira", "stripe", "gdrive", "gmail", "gcal", "browser"] as const;
export type WatchService = (typeof WATCH_SERVICES)[number];

/** A watch as the API returns it. Secrets are never included. */
export interface Watch {
  id: string;
  workspaceId: string;
  /** the person whose app it is; events only ever reach agents working for them */
  userId: string;
  service: WatchService;
  /** what people see: "Slack", "GitHub", "Canvas (browser)" */
  label: string;
  /** the connector whose key it uses, if any */
  connectorId: string | null;
  /** a key was given for this watch itself (it's never shown) */
  hasOwnKey: boolean;
  /** service options: Slack channels, a browser watch's site and what to look for */
  config: Record<string, string | string[]>;
  agentIds: string[];
  everyMinutes: number;
  paused: boolean;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  /** why the last look failed, in plain words */
  lastError: string | null;
  /** changes seen in the last 7 days */
  recentEvents: number;
  createdBy: string | null;
  createdAt: string;
}

/** One change in an app, as an agent sees it. Document text is never kept; `preview` is a line at most, and it's cleared once delivered. */
export interface AppEvent {
  id: string;
  watchId: string;
  service: WatchService;
  /** "edited", "created", "message", "mention", "review_requested", "email", "event_changed"… */
  kind: string;
  /** the app's own id for the thing that changed; with the service, it's the `about` key for mentioning it once */
  itemId: string;
  title: string;
  url: string | null;
  actor: string | null;
  preview: string | null;
  happenedAt: string;
}

/** What Wisp can watch and how it gets in, for people and for agents setting it up. */
export interface WatchServiceInfo {
  service: WatchService;
  name: string;
  /** catalog connectors whose key works for it */
  catalogIds: string[];
  /** where the key goes and how to get one, in plain words for the agent helping someone set it up */
  howToConnect: string;
  /** "messages in channels the bot is in, and DMs" */
  watches: string;
  everyMinutes: number;
  minMinutes: number;
  /** false while it needs something Wisp doesn't have yet (Google needs Wisp's own sign-in) */
  available: boolean;
  unavailableReason: string | null;
}

/** About how many tokens one browser check uses: screenshots and reading the page. */
export const BROWSER_CHECK_TOKENS = 60_000;
/** About how many tokens one check about a batch of app changes uses. */
export const EVENT_CHECK_TOKENS = 25_000;

/** What a watch may cost a day, so people see it before saying yes. API watches only cost when something changes. */
export function watchEstimate(service: WatchService, everyMinutes: number, dailyAllowance: number | null): { checksPerDay: number; tokensPerDay: number; shareOfAllowance: number | null; note: string } {
  if (service !== "browser") {
    return { checksPerDay: 0, tokensPerDay: 0, shareOfAllowance: 0, note: `Looking costs nothing. Each batch of changes is one check, about ${EVENT_CHECK_TOKENS / 1000}k tokens.` };
  }
  const checksPerDay = Math.max(1, Math.floor((24 * 60) / everyMinutes));
  const tokensPerDay = checksPerDay * BROWSER_CHECK_TOKENS;
  const share = dailyAllowance ? tokensPerDay / dailyAllowance : null;
  return { checksPerDay, tokensPerDay, shareOfAllowance: share, note: `About ${checksPerDay} browser check${checksPerDay === 1 ? "" : "s"} a day, ${Math.round(tokensPerDay / 1000)}k tokens${share !== null ? ` (${Math.round(share * 100)}% of the daily allowance)` : ""}.` };
}

/** How an agent names something it raised, so it's only raised once: "notion:<page id>". */
export function aboutKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}
