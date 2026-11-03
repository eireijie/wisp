import { envVar } from "@wisp/core";
import { getJson, line, pick, WatchError, type FoundEvent, type PollContext, type Watcher } from "./types.ts";

/**
 * Google Drive (and Docs), Gmail and Calendar, read through Google's change feeds: Drive's change
 * page tokens, Gmail's history ids and Calendar's sync tokens. They need a Google sign-in through
 * an OAuth app. Wisp doesn't have its own verified one yet (see docs/connector-events.md), so these
 * only work when a hub is given one (WISP_GOOGLE_CLIENT_ID and WISP_GOOGLE_CLIENT_SECRET) and a
 * watch holds the person's refresh token. Until then agents watch Google in their computer's browser.
 */

const client = () => ({ id: envVar("GOOGLE_CLIENT_ID") ?? "", secret: envVar("GOOGLE_CLIENT_SECRET") ?? "" });

const unavailable = () => (client().id && client().secret ? null : "Wisp doesn't have its own Google sign-in yet. Watch it in the agent's computer's browser for now.");

const HOW = "Needs Wisp's Google sign-in, which isn't available yet. Until then, watch it with a browser watch on the agent's computer, where the person is signed in.";

/** A short-lived access token from the watch's refresh token. Cached for the life of the token. */
const cache = new Map<string, { token: string; until: number }>();
async function accessToken(ctx: PollContext): Promise<string> {
  const refresh = pick(ctx.creds, ["GOOGLE_REFRESH_TOKEN"]);
  if (!refresh) throw new WatchError("Google needs the person to sign in.", true);
  const hit = cache.get(refresh);
  if (hit && hit.until > ctx.now.getTime() + 60_000) return hit.token;
  const { id, secret } = client();
  const res = await ctx.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(20_000),
  });
  const r = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !r.access_token) throw new WatchError(r.error === "invalid_grant" ? "The Google sign-in expired or was removed. Sign in again." : `Google sign-in failed (${r.error ?? res.status}).`, r.error === "invalid_grant");
  cache.set(refresh, { token: r.access_token, until: ctx.now.getTime() + (r.expires_in ?? 3600) * 1000 });
  return r.access_token;
}

const google = async (ctx: PollContext, url: string) => getJson(ctx, url, { headers: { authorization: `Bearer ${await accessToken(ctx)}` }, app: "Google" });

/** Fields Drive sends back for each change: enough to say what changed, never the file's contents. */
const DRIVE_FIELDS = "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(name,mimeType,webViewLink,createdTime,modifiedTime,trashed,lastModifyingUser(displayName,me)))";

export const gdrive: Watcher = {
  service: "gdrive",
  name: "Google Drive & Docs",
  catalogIds: ["gdrive"],
  needs: [["GOOGLE_REFRESH_TOKEN"]],
  watches: "new and edited Docs, Sheets, Slides and files in the person's Drive",
  howToConnect: HOW,
  everyMinutes: 5,
  minMinutes: 2,
  unavailable,
  async poll(ctx) {
    if (!ctx.cursor) {
      const r = await google(ctx, "https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true");
      return { cursor: r.startPageToken, events: [] };
    }
    const events: FoundEvent[] = [];
    let token: string = ctx.cursor;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ pageToken: token, pageSize: "100", fields: DRIVE_FIELDS, includeItemsFromAllDrives: "true", supportsAllDrives: "true" });
      const r = await google(ctx, `https://www.googleapis.com/drive/v3/changes?${q}`);
      for (const c of (r.changes ?? []) as any[]) {
        const f = c.file;
        if (c.removed || !f || f.trashed || f.mimeType === "application/vnd.google-apps.folder") continue;
        const created = f.createdTime && f.modifiedTime && Math.abs(new Date(f.modifiedTime).getTime() - new Date(f.createdTime).getTime()) < 120_000;
        events.push({ kind: created ? "created" : "edited", itemId: c.fileId, title: line(f.name, 120) ?? "a file", url: f.webViewLink ?? null, actor: f.lastModifyingUser?.me ? "you" : f.lastModifyingUser?.displayName ?? null, preview: line(f.mimeType?.replace("application/vnd.google-apps.", "")), happenedAt: f.modifiedTime ?? c.time });
      }
      if (r.newStartPageToken) return { cursor: r.newStartPageToken, events };
      if (!r.nextPageToken) break;
      token = r.nextPageToken;
    }
    return { cursor: token, events };
  },
};

export const gmail: Watcher = {
  service: "gmail",
  name: "Gmail",
  catalogIds: [],
  needs: [["GOOGLE_REFRESH_TOKEN"]],
  watches: "new email in the inbox: who it's from and the subject",
  howToConnect: HOW,
  everyMinutes: 2,
  minMinutes: 1,
  unavailable,
  async poll(ctx) {
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    const start = async () => ({ cursor: String((await google(ctx, `${base}/profile`)).historyId), events: [] });
    if (!ctx.cursor) return start();
    const r = await google(ctx, `${base}/history?${new URLSearchParams({ startHistoryId: ctx.cursor, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" })}`).catch((e) =>
      // a history id that's too old: start again from now
      e instanceof WatchError && e.status === 404 ? null : Promise.reject(e),
    );
    if (!r) return start();
    const ids = [...new Set(((r.history ?? []) as any[]).flatMap((h) => (h.messagesAdded ?? []).map((m: any) => m.message.id as string)))].slice(0, 20);
    const events: FoundEvent[] = [];
    for (const id of ids) {
      const m = await google(ctx, `${base}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const h = (name: string) => (m.payload?.headers ?? []).find((x: any) => x.name.toLowerCase() === name.toLowerCase())?.value ?? null;
      events.push({ kind: (m.labelIds ?? []).includes("IMPORTANT") ? "important_email" : "email", itemId: m.threadId ?? id, title: line(h("Subject"), 120) ?? "(no subject)", url: `https://mail.google.com/mail/u/0/#inbox/${m.threadId ?? id}`, actor: line(h("From"), 80), preview: line(m.snippet), happenedAt: new Date(Number(m.internalDate ?? ctx.now.getTime())).toISOString() });
    }
    return { cursor: String(r.historyId ?? ctx.cursor), events };
  },
};

export const gcal: Watcher = {
  service: "gcal",
  name: "Google Calendar",
  catalogIds: [],
  needs: [["GOOGLE_REFRESH_TOKEN"]],
  watches: "events added, moved or cancelled on the person's main calendar",
  howToConnect: HOW,
  everyMinutes: 10,
  minMinutes: 5,
  unavailable,
  async poll(ctx) {
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    // the first look lists everything once to get a sync token; only changes after that are news
    const full = async () => {
      let page: string | undefined;
      for (let i = 0; i < 20; i++) {
        const r = await google(ctx, `${base}?${new URLSearchParams({ maxResults: "250", singleEvents: "true", ...(page ? { pageToken: page } : {}) })}`);
        if (r.nextSyncToken) return { cursor: r.nextSyncToken as string, events: [] };
        page = r.nextPageToken;
        if (!page) break;
      }
      throw new WatchError("Google Calendar didn't give a sync token.");
    };
    if (!ctx.cursor) return full();
    const events: FoundEvent[] = [];
    let page: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await google(ctx, `${base}?${new URLSearchParams({ syncToken: ctx.cursor, singleEvents: "true", ...(page ? { pageToken: page } : {}) })}`).catch((e) =>
        // the sync token expired: list again from scratch
        e instanceof WatchError && e.status === 410 ? null : Promise.reject(e),
      );
      if (!r) return full();
      for (const e of (r.items ?? []) as any[]) {
        const created = e.created && e.updated && Math.abs(new Date(e.updated).getTime() - new Date(e.created).getTime()) < 120_000;
        const when = e.start?.dateTime ?? e.start?.date ?? null;
        events.push({ kind: e.status === "cancelled" ? "event_cancelled" : created ? "event_added" : "event_changed", itemId: e.id, title: line(e.summary, 120) ?? "an event", url: e.htmlLink ?? null, actor: e.organizer?.self ? "you" : e.organizer?.email ?? null, preview: when ? `starts ${when}` : null, happenedAt: e.updated ?? ctx.now.toISOString() });
      }
      if (r.nextSyncToken) return { cursor: r.nextSyncToken, events };
      page = r.nextPageToken;
      if (!page) break;
    }
    return { cursor: ctx.cursor, events };
  },
};
