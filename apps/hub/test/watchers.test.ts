import { afterEach, describe, expect, it } from "vitest";
import { watchEstimate } from "@wisp/core";
import { WatchError, watcherFor, type PollContext } from "../src/watchers/index.ts";
import { githubHtmlUrl } from "../src/watchers/github.ts";

/** A fake app: answers by URL, and remembers what was asked. */
function fakeFetch(routes: [RegExp, (url: URL, init?: RequestInit) => unknown][]) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ url: url.href, init });
    const hit = routes.find(([re]) => re.test(url.href));
    if (!hit) return new Response("not found", { status: 404 });
    const out = hit[1](url, init);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { fetch: f, seen };
}

const ctx = (f: typeof globalThis.fetch, over: Partial<PollContext> = {}): PollContext => ({ creds: {}, config: {}, cursor: null, fetch: f, now: new Date("2026-11-02T12:00:00Z"), ...over });
const poll = (service: string, c: PollContext) => watcherFor(service)!.poll(c);

describe("watchers", () => {
  it("Slack: the first look only finds now; then new messages, not its own or joins, with mentions and DMs told apart", async () => {
    const { fetch, seen } = fakeFetch([
      [/auth\.test/, () => ({ ok: true, user_id: "UBOT", bot_id: "BBOT" })],
      [/users\.conversations/, () => ({ ok: true, channels: [{ id: "C1", name: "launch" }, { id: "D1", is_im: true }, { id: "C2", name: "random" }] })],
      [/conversations\.history\?channel=C1/, () => ({ ok: true, messages: [{ ts: "1762084900.000100", user: "USAM", text: "<@UBOT> can you look at the deck?" }, { ts: "1762084901.000100", user: "UBOT", text: "mine" }, { ts: "1762084902.000100", subtype: "channel_join", user: "UX" }] })],
      [/conversations\.history\?channel=D1/, () => ({ ok: true, messages: [{ ts: "1762084903.000200", user: "USAM", text: "lunch?" }] })],
      [/conversations\.history\?channel=C2/, () => ({ ok: true, messages: [] })],
    ]);
    const first = await poll("slack", ctx(fetch, { creds: { SLACK_BOT_TOKEN: "xoxb-1" } }));
    expect(first).toEqual({ cursor: String(Math.floor(new Date("2026-11-02T12:00:00Z").getTime() / 1000)), events: [] });
    const next = await poll("slack", ctx(fetch, { creds: { SLACK_BOT_TOKEN: "xoxb-1" }, cursor: "1762084800", now: new Date("2026-11-02T12:05:00Z") }));
    expect(next.events.map((e) => [e.kind, e.title, e.preview])).toEqual([
      ["mention", "#launch", "<@UBOT> can you look at the deck?"],
      ["dm", "a direct message", "lunch?"],
    ]);
    expect(next.events[0].url).toBe("https://slack.com/archives/C1/p1762084900000100");
    // looks overlap a minute so nothing stamped early is missed
    expect(seen.find((s) => s.url.includes("channel=C1"))!.url).toContain("oldest=1762084740");
    expect(seen[0].init?.headers).toMatchObject({ authorization: "Bearer xoxb-1" });
  });

  it("Slack: only the channels asked for, and a refused key says so", async () => {
    const { fetch, seen } = fakeFetch([
      [/auth\.test/, () => ({ ok: true, user_id: "U1" })],
      [/users\.conversations/, () => ({ ok: true, channels: [{ id: "C1", name: "launch" }, { id: "C2", name: "random" }] })],
      [/conversations\.history/, () => ({ ok: true, messages: [] })],
    ]);
    await poll("slack", ctx(fetch, { creds: { SLACK_USER_TOKEN: "xoxp-1" }, cursor: "1", config: { channels: ["#Launch"] } }));
    expect(seen.filter((s) => s.url.includes("conversations.history")).map((s) => new URL(s.url).searchParams.get("channel"))).toEqual(["C1"]);
    const bad = fakeFetch([[/auth\.test/, () => ({ ok: false, error: "invalid_auth" })]]);
    const e = await poll("slack", ctx(bad.fetch, { creds: { SLACK_BOT_TOKEN: "x" } })).catch((x) => x);
    expect(e).toBeInstanceOf(WatchError);
    expect(e.badKey).toBe(true);
  });

  it("GitHub: notifications, as links people can open; fine-grained tokens fall back to search", async () => {
    const notifications = [{ id: "9", reason: "review_requested", updated_at: "2026-11-02T12:01:00Z", repository: { full_name: "o/r", html_url: "https://github.com/o/r" }, subject: { title: "Add watches", type: "PullRequest", url: "https://api.github.com/repos/o/r/pulls/12" } }];
    const { fetch } = fakeFetch([
      [/api\.github\.com\/user$/, () => ({ login: "me" })],
      [/notifications/, () => notifications],
    ]);
    expect((await poll("github", ctx(fetch, { creds: { GITHUB_TOKEN: "ghp" } }))).events).toEqual([]);
    const r = await poll("github", ctx(fetch, { creds: { GITHUB_TOKEN: "ghp" }, cursor: "2026-11-02T11:55:00.000Z" }));
    expect(r.events).toEqual([expect.objectContaining({ kind: "review_requested", itemId: "o/r#12", title: "o/r: Add watches", url: "https://github.com/o/r/pull/12" })]);

    const fine = fakeFetch([
      [/api\.github\.com\/user$/, () => ({ login: "me" })],
      [/notifications/, () => new Response("{}", { status: 403 })],
      [/search\/issues/, (u) => (expect(u.searchParams.get("q")).toBe("involves:me updated:>=2026-11-02T11:54:00Z"), { items: [{ number: 3, title: "Bug", html_url: "https://github.com/o/r/issues/3", repository_url: "https://api.github.com/repos/o/r", updated_at: "2026-11-02T11:59:00Z", state: "open", user: { login: "sam" } }] })],
    ]);
    const s = await poll("github", ctx(fine.fetch, { creds: { GITHUB_TOKEN: "github_pat" }, cursor: "2026-11-02T11:55:00.000Z" }));
    expect(s.events).toEqual([expect.objectContaining({ kind: "issue", itemId: "o/r#3", actor: "sam" })]);
    expect(githubHtmlUrl("https://api.github.com/repos/o/r/commits/abc", "x")).toBe("https://github.com/o/r/commit/abc");
  });

  it("Notion: new and edited pages since the last look, by title", async () => {
    const page = (id: string, title: string, created: string, edited: string) => ({ object: "page", id, url: `https://notion.so/${id}`, created_time: created, last_edited_time: edited, last_edited_by: { id: "u1" }, properties: { Name: { type: "title", title: [{ plain_text: title }] } } });
    const results = [page("p2", "Launch plan", "2026-11-02T12:03:00.000Z", "2026-11-02T12:04:00.000Z"), page("p1", "Q4 notes", "2026-10-01T00:00:00.000Z", "2026-11-02T12:02:00.000Z"), page("p0", "Old", "2026-01-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")];
    const { fetch, seen } = fakeFetch([[/api\.notion\.com\/v1\/search/, () => ({ results })]]);
    expect(await poll("notion", ctx(fetch, { creds: { NOTION_TOKEN: "ntn" } }))).toEqual({ cursor: "2026-11-02T12:04:00.000Z", events: [] });
    const r = await poll("notion", ctx(fetch, { creds: { NOTION_TOKEN: "ntn" }, cursor: "2026-11-02T12:00:00.000Z" }));
    expect(r.events.map((e) => [e.kind, e.title, e.itemId])).toEqual([
      ["created", "Launch plan", "p2"],
      ["edited", "Q4 notes", "p1"],
    ]);
    expect(r.cursor).toBe("2026-11-02T12:04:00.000Z");
    expect(seen[0].init?.headers).toMatchObject({ "notion-version": "2022-06-28" });
  });

  it("Linear: notifications since the last look", async () => {
    const { fetch, seen } = fakeFetch([[/api\.linear\.app/, () => ({ data: { notifications: { nodes: [{ id: "n1", type: "issueAssignedToYou", createdAt: "2026-11-02T12:01:00.000Z", actor: { name: "Sam" }, issue: { identifier: "ENG-7", title: "Fix login", url: "https://linear.app/x/issue/ENG-7" } }, { id: "n0", type: "issueComment", createdAt: "2026-11-01T00:00:00.000Z" }] } } })]]);
    const r = await poll("linear", ctx(fetch, { creds: { LINEAR_API_KEY: "lin_api_1" }, cursor: "2026-11-02T12:00:00.000Z" }));
    expect(r.events).toEqual([expect.objectContaining({ kind: "assigned to you", itemId: "ENG-7", title: "ENG-7: Fix login", actor: "Sam" })]);
    expect(seen[0].init?.headers).toMatchObject({ authorization: "lin_api_1" });
    const bad = fakeFetch([[/api\.linear\.app/, () => ({ errors: [{ message: "Authentication required, not authenticated" }] })]]);
    expect((await poll("linear", ctx(bad.fetch, { creds: { LINEAR_API_KEY: "x" } })).catch((e) => e)).badKey).toBe(true);
  });

  it("Jira: issues that involve the person, with Server's older search when Cloud's isn't there", async () => {
    const issues = { issues: [{ key: "OPS-1", fields: { summary: "Server down", updated: "2026-11-02T12:01:00.000+0000", status: { name: "In Progress" } } }] };
    const { fetch, seen } = fakeFetch([
      [/rest\/api\/3\/search\/jql/, () => new Response("gone", { status: 404 })],
      [/rest\/api\/2\/search/, () => issues],
    ]);
    const r = await poll("jira", ctx(fetch, { creds: { JIRA_URL: "https://acme.atlassian.net/", JIRA_USERNAME: "me@acme.com", JIRA_API_TOKEN: "t" }, cursor: "2026-11-02T11:50:00.000Z" }));
    expect(r.events).toEqual([expect.objectContaining({ itemId: "OPS-1", url: "https://acme.atlassian.net/browse/OPS-1", happenedAt: "2026-11-02T12:01:00.000Z", preview: "status: In Progress" })]);
    expect(new URL(seen[0].url).searchParams.get("jql")).toContain("updated >= -11m");
    expect(seen[0].init?.headers).toMatchObject({ authorization: `Basic ${Buffer.from("me@acme.com:t").toString("base64")}` });
    await expect(poll("jira", ctx(fetch, { creds: { JIRA_URL: "http://10.0.0.1", JIRA_API_TOKEN: "t" } }))).rejects.toThrow(/https/);
  });

  it("Stripe: only events people care about, in plain words", async () => {
    const { fetch } = fakeFetch([[/api\.stripe\.com\/v1\/events/, () => ({ data: [{ id: "evt_1", type: "charge.failed", created: 1762084900, livemode: true, data: { object: { id: "ch_1", amount: 1250, currency: "usd", billing_details: { email: "a@b.com" }, failure_message: "Card declined" } } }, { id: "evt_2", type: "customer.updated", created: 1762084901, data: { object: { id: "cus_1" } } }] })]]);
    const r = await poll("stripe", ctx(fetch, { creds: { STRIPE_SECRET_KEY: "rk" }, cursor: "1762084800" }));
    expect(r.events).toEqual([expect.objectContaining({ kind: "charge.failed", itemId: "ch_1", title: "A payment failed", actor: "a@b.com", preview: "12.50 USD · Card declined", url: "https://dashboard.stripe.com/events/evt_1" })]);
    expect(r.cursor).toBe("1762084901");
  });

  describe("Google, once Wisp has its own sign-in", () => {
    afterEach(() => {
      delete process.env.WISP_GOOGLE_CLIENT_ID;
      delete process.env.WISP_GOOGLE_CLIENT_SECRET;
    });
    const token: [RegExp, () => unknown] = [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "ya29", expires_in: 3600 })];

    it("isn't offered until then", () => {
      expect(watcherFor("gdrive")!.unavailable!()).toMatch(/browser/);
      process.env.WISP_GOOGLE_CLIENT_ID = "id";
      process.env.WISP_GOOGLE_CLIENT_SECRET = "s";
      expect(watcherFor("gdrive")!.unavailable!()).toBeNull();
    });

    it("Drive: follows change page tokens; new and edited Docs, no folders or trash", async () => {
      const { fetch, seen } = fakeFetch([
        token,
        [/changes\/startPageToken/, () => ({ startPageToken: "100" })],
        [/drive\/v3\/changes\?/, () => ({ newStartPageToken: "105", changes: [{ fileId: "d1", time: "2026-11-02T12:01:00Z", file: { name: "Essay draft", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/d1", createdTime: "2026-11-02T12:00:30Z", modifiedTime: "2026-11-02T12:01:00Z", lastModifyingUser: { me: true } } }, { fileId: "f1", file: { name: "Folder", mimeType: "application/vnd.google-apps.folder" } }, { fileId: "x", removed: true }] })],
      ]);
      const c = { creds: { GOOGLE_REFRESH_TOKEN: "r1" } };
      expect(await poll("gdrive", ctx(fetch, c))).toEqual({ cursor: "100", events: [] });
      const r = await poll("gdrive", ctx(fetch, { ...c, cursor: "100" }));
      expect(r).toEqual({ cursor: "105", events: [expect.objectContaining({ kind: "created", itemId: "d1", title: "Essay draft", actor: "you", preview: "document" })] });
      // never asks for a file's contents
      expect(seen.some((s) => /files\/.*(export|alt=media)/.test(s.url))).toBe(false);
    });

    it("Gmail: new inbox mail by history id, subject and sender only; starts over when the id is too old", async () => {
      const { fetch } = fakeFetch([
        [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "ya29-b", expires_in: 3600 })],
        [/users\/me\/profile/, () => ({ historyId: "900" })],
        [/users\/me\/history\?startHistoryId=500/, () => ({ historyId: "510", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] })],
        [/users\/me\/history\?startHistoryId=1/, () => new Response("{}", { status: 404 })],
        [/messages\/m1/, () => ({ id: "m1", threadId: "t1", labelIds: ["INBOX", "IMPORTANT"], snippet: "The venue changed to…", internalDate: "1762084900000", payload: { headers: [{ name: "From", value: "Event Team <e@x.com>" }, { name: "Subject", value: "Tomorrow's event: new venue" }] } })],
      ]);
      const c = { creds: { GOOGLE_REFRESH_TOKEN: "r2" } };
      const r = await poll("gmail", ctx(fetch, { ...c, cursor: "500" }));
      expect(r).toEqual({ cursor: "510", events: [expect.objectContaining({ kind: "important_email", itemId: "t1", title: "Tomorrow's event: new venue", actor: "Event Team <e@x.com>" })] });
      expect(await poll("gmail", ctx(fetch, { ...c, cursor: "1" }))).toEqual({ cursor: "900", events: [] });
    });

    it("Calendar: sync tokens; added, moved and cancelled events", async () => {
      const { fetch } = fakeFetch([
        [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "ya29-c", expires_in: 3600 })],
        [/events\?.*syncToken=s1/, () => ({ nextSyncToken: "s2", items: [{ id: "e1", status: "confirmed", summary: "Dentist", created: "2026-10-01T00:00:00Z", updated: "2026-11-02T12:00:00Z", start: { dateTime: "2026-11-03T09:00:00Z" } }, { id: "e2", status: "cancelled", updated: "2026-11-02T12:01:00Z" }] })],
        [/events\?maxResults/, () => ({ nextSyncToken: "s1", items: [] })],
      ]);
      const c = { creds: { GOOGLE_REFRESH_TOKEN: "r3" } };
      expect(await poll("gcal", ctx(fetch, c))).toEqual({ cursor: "s1", events: [] });
      const r = await poll("gcal", ctx(fetch, { ...c, cursor: "s1" }));
      expect(r.cursor).toBe("s2");
      expect(r.events.map((e) => [e.kind, e.title])).toEqual([
        ["event_changed", "Dentist"],
        ["event_cancelled", "an event"],
      ]);
    });
  });

  it("estimates what a watch costs: API watches nothing to look, browser ones per check", () => {
    expect(watchEstimate("notion", 5, 1_000_000)).toMatchObject({ checksPerDay: 0, tokensPerDay: 0 });
    expect(watchEstimate("browser", 360, 1_000_000)).toMatchObject({ checksPerDay: 4, tokensPerDay: 240_000, shareOfAllowance: 0.24 });
  });
});
