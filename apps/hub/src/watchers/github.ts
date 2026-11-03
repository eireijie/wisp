import { getJson, line, pick, WatchError, type FoundEvent, type PollContext, type Watcher } from "./types.ts";

const OVERLAP_MS = 60_000;

const headers = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "wisp" });

/** "https://api.github.com/repos/o/r/pulls/12" → "https://github.com/o/r/pull/12" */
export function githubHtmlUrl(api: string | null | undefined, repoUrl: string): string {
  const m = api?.match(/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits|releases)\/([^/]+)$/);
  if (!m) return repoUrl;
  return `https://github.com/${m[1]}/${m[2] === "pulls" ? "pull" : m[2] === "commits" ? "commit" : m[2]}/${m[3]}`;
}

/** "o/r#12" for issues and pull requests, so the same thing has the same id whatever happened to it. */
const itemOf = (repo: string, api: string | null | undefined, fallback: string) => {
  const n = api?.match(/\/(?:issues|pulls)\/(\d+)$/)?.[1];
  return n ? `${repo}#${n}` : `${repo}:${fallback}`;
};

async function notifications(ctx: PollContext, token: string, since: string): Promise<FoundEvent[]> {
  const list = await getJson<any[]>(ctx, `https://api.github.com/notifications?${new URLSearchParams({ since, per_page: "50" })}`, { headers: headers(token), app: "GitHub" });
  return list.map((n) => ({
    kind: n.reason ?? "updated",
    itemId: itemOf(n.repository.full_name, n.subject?.url, n.id),
    title: `${n.repository.full_name}: ${n.subject?.title ?? "an update"}`,
    url: githubHtmlUrl(n.subject?.url, n.repository.html_url),
    actor: null,
    preview: line(`${n.subject?.type ?? ""} ${String(n.reason ?? "").replace(/_/g, " ")}`),
    happenedAt: n.updated_at,
  }));
}

/** Fine-grained tokens can't read notifications: issues and pull requests that involve the person, by search. */
async function involving(ctx: PollContext, token: string, login: string, since: string): Promise<FoundEvent[]> {
  const q = `involves:${login} updated:>=${since.slice(0, 19)}Z`;
  const r = await getJson(ctx, `https://api.github.com/search/issues?${new URLSearchParams({ q, sort: "updated", per_page: "30" })}`, { headers: headers(token), app: "GitHub" });
  return ((r.items ?? []) as any[]).map((i) => {
    const repo = String(i.repository_url ?? "").replace("https://api.github.com/repos/", "");
    return { kind: i.pull_request ? "pull_request" : "issue", itemId: `${repo}#${i.number}`, title: `${repo}: ${i.title}`, url: i.html_url, actor: i.user?.login ?? null, preview: line(`${i.state}${i.comments ? `, ${i.comments} comments` : ""}`), happenedAt: i.updated_at };
  });
}

export const github: Watcher = {
  service: "github",
  name: "GitHub",
  catalogIds: ["github"],
  needs: [["GITHUB_TOKEN"]],
  watches: "notifications: reviews asked of the person, mentions, assignments, replies and failed checks",
  howToConnect:
    "Use the GitHub connector's token. A classic token with the notifications and repo scopes sees everything the person is notified about (github.com/settings/tokens/new?scopes=notifications,repo&description=Wisp); a fine-grained token only sees issues and pull requests that involve them.",
  everyMinutes: 5,
  minMinutes: 2,
  async poll(ctx) {
    const token = pick(ctx.creds, ["GITHUB_TOKEN"]);
    if (!token) throw new WatchError("GitHub needs a token.", true);
    const user = await getJson(ctx, "https://api.github.com/user", { headers: headers(token), app: "GitHub" });
    const now = ctx.now.toISOString();
    if (!ctx.cursor) return { cursor: now, events: [] };
    const since = new Date(new Date(ctx.cursor).getTime() - OVERLAP_MS).toISOString();
    const events = await notifications(ctx, token, since).catch((e) => {
      if (e instanceof WatchError && e.status === 403) return involving(ctx, token, user.login, since);
      throw e;
    });
    return { cursor: now, events };
  },
};
