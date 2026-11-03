import { getJson, line, pick, WatchError, type PollContext, type Watcher } from "./types.ts";

/** Errors Slack gives for a key that won't work until it's replaced. */
const BAD_KEY = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "missing_scope", "no_permission"]);
/** Channels looked at each time, so a big workspace can't run Slack's limits down. */
const MAX_CHANNELS = 25;
/** Looks overlap by this much, so a message Slack stamped a little early isn't missed (repeats are dropped). */
const OVERLAP_SECONDS = 60;

async function call(ctx: PollContext, token: string, method: string, params: Record<string, string> = {}) {
  const r = await getJson(ctx, `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, app: "Slack" });
  if (!r.ok) throw new WatchError(r.error === "missing_scope" ? `Slack's key is missing a permission (${r.needed ?? "channels:history"}).` : `Slack said ${r.error}.`, BAD_KEY.has(r.error));
  return r;
}

const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(",") : []).map((x) => x.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);

export const slack: Watcher = {
  service: "slack",
  name: "Slack",
  catalogIds: ["slack"],
  needs: [["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"]],
  watches: "new messages in the channels and DMs the key can read, and mentions of the person",
  howToConnect:
    "Use the Slack connector's bot token (xoxb-…), or a user token (xoxp-…) to see what the person sees. A bot only sees channels it was added to. To make one: api.slack.com/apps → Create app → OAuth & Permissions, add channels:history, groups:history, im:history and channels:read, install it to the workspace, then copy the token.",
  everyMinutes: 5,
  minMinutes: 2,
  async poll(ctx) {
    const token = pick(ctx.creds, ["SLACK_USER_TOKEN", "SLACK_BOT_TOKEN"]);
    if (!token) throw new WatchError("Slack needs a token.", true);
    const me = await call(ctx, token, "auth.test");
    const nowTs = Math.floor(ctx.now.getTime() / 1000);
    if (!ctx.cursor) return { cursor: String(nowTs), events: [] };
    const only = asList(ctx.config.channels);
    const convs = await call(ctx, token, "users.conversations", { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: "200" });
    const channels = ((convs.channels ?? []) as { id: string; name?: string; is_im?: boolean }[]).filter((c) => !only.length || (c.name && only.includes(c.name.toLowerCase()))).slice(0, MAX_CHANNELS);
    const oldest = String(Math.max(0, Number(ctx.cursor) - OVERLAP_SECONDS));
    const events = [];
    for (const c of channels) {
      const h = await call(ctx, token, "conversations.history", { channel: c.id, oldest, limit: "20" });
      for (const m of (h.messages ?? []) as { ts: string; user?: string; bot_id?: string; subtype?: string; text?: string }[]) {
        // joins, topic changes and the like aren't news; the key's own messages aren't either
        if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "file_share") continue;
        if (m.user && m.user === me.user_id) continue;
        if (m.bot_id && me.bot_id && m.bot_id === me.bot_id) continue;
        const mention = !!me.user_id && !!m.text?.includes(`<@${me.user_id}>`);
        events.push({
          kind: c.is_im ? "dm" : mention ? "mention" : "message",
          itemId: `${c.id}:${m.ts}`,
          title: c.is_im ? "a direct message" : `#${c.name ?? c.id}`,
          url: `https://slack.com/archives/${c.id}/p${m.ts.replace(".", "")}`,
          actor: m.user ?? null,
          preview: line(m.text),
          happenedAt: new Date(Number(m.ts) * 1000).toISOString(),
        });
      }
    }
    return { cursor: String(nowTs), events: events.slice(0, 50) };
  },
};
