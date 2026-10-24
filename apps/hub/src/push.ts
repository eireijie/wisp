import webpush from "web-push";
import type { Message } from "@warren/core";
import type { Hub } from "./hub.ts";

const KEY = "push_vapid";
type PushCategory = "approval" | "dm" | "reply" | "channel" | "other";

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

  /**
   * Who hears about an agent's message: in a DM, its person; in a channel, whoever it's answering
   * (and anyone it asks for an OK), plus people who asked for every message there. Muting a
   * channel silences it.
   */
  recipients(msg: Message, channel: { workspaceId: string; kind: string }, onBehalfOf: string | null): string[] {
    if (msg.author.kind !== "agent") return [];
    const { store } = this.hub;
    if (channel.kind === "dm") return store.channelMembers(msg.channelId).filter((m) => m.kind === "user").map((m) => m.id);
    const muted = store.mutedBy(msg.channelId);
    const to = new Set(store.notifyAll(msg.channelId));
    if (onBehalfOf) to.add(onBehalfOf);
    const out = [...to].filter((u) => !muted.has(u));
    // asking for an OK gets through even a muted channel: the agent is stuck until someone answers
    if (onBehalfOf && msg.parts.some((p) => p.type === "approval") && !out.includes(onBehalfOf)) out.push(onBehalfOf);
    return out;
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
    for (const userId of to) {
      const category = asks ? "approval" : channel.kind === "dm" ? "dm" : userId === onBehalfOf ? "reply" : "channel";
      void this.notify(channel.workspaceId, [userId], { title, body, tag: msg.id, url: `/#/c/${msg.channelId}${msg.threadId ? `/t/${msg.threadId}` : ""}` }, category);
    }
  }

  async notify(workspaceId: string, userIds: string[], n: { title: string; body: string; tag?: string; url?: string }, category: PushCategory = "other") {
    const subs = userIds.flatMap((u) => this.hub.store.pushSubscriptions(u)).filter((s) => {
      if (category === "dm") return s.prefs.dms !== false;
      if (category === "reply") return s.prefs.replies !== false;
      if (category === "approval") return s.prefs.approvals !== false;
      return true;
    });
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
