import type { WatchService } from "@wisp/core";

/** One change a watcher found, before it's handed to agents. */
export interface FoundEvent {
  kind: string;
  itemId: string;
  title: string;
  url?: string | null;
  actor?: string | null;
  /** a line at most: who said what, a subject line; never a whole document */
  preview?: string | null;
  happenedAt: string;
}

export interface PollContext {
  /** the key and values it signs in with: a connector's, or the watch's own */
  creds: Record<string, string>;
  config: Record<string, string | string[]>;
  /** where it left off last time; null on the first look, which only finds where "now" is */
  cursor: string | null;
  fetch: typeof fetch;
  now: Date;
}

export interface PollResult {
  cursor: string;
  events: FoundEvent[];
}

/**
 * How Wisp asks one app what changed. A watcher plugs in by naming the keys it needs (the same
 * keys the app's connector keeps) and answering `poll`. It must keep a page of results short and
 * treat its cursor as its own: the hub only stores it.
 */
export interface Watcher {
  service: Exclude<WatchService, "browser">;
  name: string;
  /** catalog connectors whose values it can use */
  catalogIds: string[];
  /** the values it needs, any one of each inner list (e.g. a bot or a user token) */
  needs: string[][];
  watches: string;
  howToConnect: string;
  everyMinutes: number;
  minMinutes: number;
  /** null when it works; else why not, in plain words */
  unavailable?: () => string | null;
  poll(ctx: PollContext): Promise<PollResult>;
}

/** A failed call to an app, with words a person can act on. */
export class WatchError extends Error {
  constructor(
    message: string,
    /** the key was refused: looking again won't help until it's replaced */
    readonly badKey = false,
    /** the app's HTTP status, when it answered */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** GET or POST JSON, turning refusals into WatchErrors. */
export async function getJson<T = any>(ctx: PollContext, url: string, { app, ...init }: RequestInit & { app: string }): Promise<T> {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new WatchError(`${app} refused the key (${res.status}). It may have expired or be missing a permission.`, true, res.status);
  if (res.status === 429) throw new WatchError(`${app} asked Wisp to slow down; it will look again later.`, false, 429);
  if (!res.ok) throw new WatchError(`${app} answered ${res.status}.`, false, res.status);
  return (await res.json()) as T;
}

/** A line at most. */
export const line = (s: string | null | undefined, max = 200) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};

/** The first value present among keys. */
export const pick = (creds: Record<string, string>, keys: string[]) => keys.map((k) => creds[k]?.trim()).find(Boolean) ?? "";
