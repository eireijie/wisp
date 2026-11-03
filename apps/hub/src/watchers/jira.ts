import { getJson, line, pick, WatchError, type PollContext, type Watcher } from "./types.ts";

/** Jira writes offsets without a colon ("+0000"). */
const iso = (s: string) => new Date(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toISOString();

export const jira: Watcher = {
  service: "jira",
  name: "Jira",
  catalogIds: ["jira"],
  needs: [["JIRA_URL"], ["JIRA_API_TOKEN"]],
  watches: "issues the person is assigned, reported or watches, when they change",
  howToConnect: "Use the Jira connector's site address, email and API token. Make a token at id.atlassian.com/manage-profile/security/api-tokens → Create API token.",
  everyMinutes: 10,
  minMinutes: 5,
  async poll(ctx) {
    const base = pick(ctx.creds, ["JIRA_URL"]).replace(/\/+$/, "");
    const token = pick(ctx.creds, ["JIRA_API_TOKEN"]);
    const user = pick(ctx.creds, ["JIRA_USERNAME"]);
    if (!base || !token) throw new WatchError("Jira needs the site address and an API token.", true);
    if (!/^https:\/\//.test(base)) throw new WatchError("Jira's address has to start with https://.", true);
    const auth = user ? `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` : `Bearer ${token}`;
    const get = (path: string) => getJson(ctx, `${base}${path}`, { headers: { authorization: auth, accept: "application/json" }, app: "Jira" });
    const now = ctx.now.toISOString();
    if (!ctx.cursor) {
      await get("/rest/api/3/myself").catch((e) => (e instanceof WatchError && e.status === 404 ? get("/rest/api/2/myself") : Promise.reject(e)));
      return { cursor: now, events: [] };
    }
    // relative minutes, so the person's time zone in Jira doesn't matter; repeats are dropped
    const minutes = Math.ceil((ctx.now.getTime() - new Date(ctx.cursor).getTime()) / 60_000) + 1;
    const jql = `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${minutes}m ORDER BY updated DESC`;
    const q = new URLSearchParams({ jql, fields: "summary,updated,status", maxResults: "50" });
    // Cloud has /search/jql; Server and Data Center still have /search
    const r = await get(`/rest/api/3/search/jql?${q}`).catch((e) => (e instanceof WatchError && (e.status === 404 || e.status === 410) ? get(`/rest/api/2/search?${q}`) : Promise.reject(e)));
    return {
      cursor: now,
      events: ((r.issues ?? []) as any[]).map((i) => ({ kind: "updated", itemId: i.key, title: `${i.key}: ${i.fields?.summary ?? ""}`.trim(), url: `${base}/browse/${i.key}`, actor: null, preview: line(i.fields?.status?.name ? `status: ${i.fields.status.name}` : null), happenedAt: iso(i.fields.updated) })),
    };
  },
};
