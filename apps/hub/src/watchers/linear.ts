import { getJson, line, pick, WatchError, type PollContext, type Watcher } from "./types.ts";

const NOTIFICATIONS = `query { notifications(first: 50) { nodes { id type createdAt actor { name } ... on IssueNotification { issue { id identifier title url } comment { body } } } } }`;

async function gql(ctx: PollContext, key: string, query: string) {
  // personal API keys go as they are; OAuth tokens as Bearer
  const r = await getJson(ctx, "https://api.linear.app/graphql", { method: "POST", headers: { authorization: key.startsWith("lin_api_") ? key : `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ query }), app: "Linear" });
  if (r.errors?.length) {
    const msg = String(r.errors[0]?.message ?? "an error");
    throw new WatchError(`Linear said: ${msg}`, /auth/i.test(msg));
  }
  return r.data;
}

export const linear: Watcher = {
  service: "linear",
  name: "Linear",
  catalogIds: ["linear"],
  needs: [["LINEAR_API_KEY"]],
  watches: "the person's Linear notifications: assignments, mentions, comments and status changes",
  howToConnect: "Use the Linear connector's API key (lin_api_…). Make one at linear.app/settings/account/security → Personal API keys → New key, with read access.",
  everyMinutes: 5,
  minMinutes: 2,
  async poll(ctx) {
    const key = pick(ctx.creds, ["LINEAR_API_KEY"]);
    if (!key) throw new WatchError("Linear needs an API key.", true);
    const data = await gql(ctx, key, NOTIFICATIONS);
    const nodes = (data?.notifications?.nodes ?? []) as any[];
    const now = ctx.now.toISOString();
    if (!ctx.cursor) return { cursor: now, events: [] };
    const fresh = nodes.filter((n) => n.createdAt > ctx.cursor!);
    return {
      cursor: now,
      events: fresh.map((n) => ({
        kind: String(n.type ?? "update").replace(/^issue/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase() || "update",
        itemId: n.issue?.identifier ?? n.id,
        title: n.issue ? `${n.issue.identifier}: ${n.issue.title}` : "a Linear notification",
        url: n.issue?.url ?? null,
        actor: n.actor?.name ?? null,
        preview: line(n.comment?.body),
        happenedAt: n.createdAt,
      })),
    };
  },
};
