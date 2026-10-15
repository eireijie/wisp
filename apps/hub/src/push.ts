import webpush from "web-push";
import type { Message } from "@warren/core";
import type { Hub } from "./hub.ts";

const KEY = "push_vapid";

/**
 * Web push: notifications that reach a person's phone or computer while Warren is closed, from an
 * agent writing to them in a DM or asking for their OK. Each workspace gets its own VAPID keys
 * the first time someone turns push on.
 */
export class Push {
  /** tests swap this to see what would be sent */
  send: (sub: webpush.PushSubscription, payload: string, opts: webpush.RequestOptions) => Promise<unknown> = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);

  constructor(private hub: Hub) {}

  keys(workspaceId: string): { publicKey: string; privateKey: string } {
    const saved = this.hub.store.setting(workspaceId, KEY);
    if (saved) return JSON.parse(saved);
    const keys = webpush.generateVAPIDKeys();
    this.hub.store.setSetting(workspaceId, KEY, JSON.stringify(keys));
    return keys;
  }

  /** Who a new message should reach by push, if anyone: people in a DM an agent wrote in, or whoever an approval asks. */
  recipients(msg: Message, channel: { workspaceId: string; kind: string }, onBehalfOf: string | null): string[] {
    if (msg.author.kind !== "agent") return [];
    const asks = msg.parts.some((p) => p.type === "approval");
    if (channel.kind === "dm") return this.hub.store.channelMembers(msg.channelId).filter((m) => m.kind === "user").map((m) => m.id);
    return asks && onBehalfOf ? [onBehalfOf] : [];
  }

  /** Called for every new message; sends in the background and never throws. */
  onMessage(msg: Message, channel: { workspaceId: string; kind: string }, onBehalfOf: string | null) {
    const to = this.recipients(msg, channel, onBehalfOf);
    if (!to.length) return;
    const agent = this.hub.store.agent(msg.author.id);
    const asks = msg.parts.some((p) => p.type === "approval");
    const title = asks ? `${agent?.name ?? "An agent"} wants your OK` : (agent?.name ?? "Warren");
    const body = (msg.body || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!body) return;
    void this.notify(channel.workspaceId, to, { title, body, tag: msg.id, url: `/#/c/${msg.channelId}${msg.threadId ? `/t/${msg.threadId}` : ""}` });
  }

  async notify(workspaceId: string, userIds: string[], n: { title: string; body: string; tag?: string; url?: string }) {
    const subs = userIds.flatMap((u) => this.hub.store.pushSubscriptions(u));
    if (!subs.length) return 0;
    const { publicKey, privateKey } = this.keys(workspaceId);
    const owner = this.hub.store.members(workspaceId).find((m) => m.role === "owner");
    // push services want a contact; Apple rejects made-up ones, so it's the owner's address
    const subject = `mailto:${owner?.email ?? "warren@example.com"}`;
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.send({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(n), { vapidDetails: { subject, publicKey, privateKey }, TTL: 60 * 60 * 24, urgency: "high" });
          sent++;
        } catch (e) {
          // the browser dropped the subscription (signed out, app removed): forget it
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) this.hub.store.deletePushSubscription(s.endpoint);
        }
      }),
    );
    return sent;
  }
}
