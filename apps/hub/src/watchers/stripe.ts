import { getJson, line, pick, WatchError, type Watcher } from "./types.ts";

/** Stripe events a person would want to hear about, in their words. Others are left out unless the watch lists them. */
export const STRIPE_EVENTS: Record<string, string> = {
  "charge.failed": "A payment failed",
  "charge.dispute.created": "A customer disputed a payment",
  "charge.refunded": "A payment was refunded",
  "invoice.payment_failed": "An invoice payment failed",
  "invoice.paid": "An invoice was paid",
  "customer.subscription.created": "New subscription",
  "customer.subscription.deleted": "A subscription was cancelled",
  "checkout.session.completed": "Someone checked out",
  "payout.failed": "A payout failed",
  "payout.paid": "A payout arrived",
};

const money = (amount: unknown, currency: unknown) => (typeof amount === "number" && typeof currency === "string" ? `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}` : "");

export const stripe: Watcher = {
  service: "stripe",
  name: "Stripe",
  catalogIds: ["stripe"],
  needs: [["STRIPE_SECRET_KEY"]],
  watches: "failed payments, disputes, refunds, new and cancelled subscriptions, checkouts and payouts",
  howToConnect: "Use the Stripe connector's key. A restricted key with only Events: read is enough: dashboard.stripe.com/apikeys → Create restricted key.",
  everyMinutes: 10,
  minMinutes: 5,
  async poll(ctx) {
    const key = pick(ctx.creds, ["STRIPE_SECRET_KEY"]);
    if (!key) throw new WatchError("Stripe needs a key.", true);
    const since = ctx.cursor ?? String(Math.floor(ctx.now.getTime() / 1000));
    const q = new URLSearchParams({ limit: ctx.cursor ? "50" : "1", "created[gte]": since });
    const r = await getJson(ctx, `https://api.stripe.com/v1/events?${q}`, { headers: { authorization: `Bearer ${key}` }, app: "Stripe" });
    if (!ctx.cursor) return { cursor: since, events: [] };
    const wanted = Array.isArray(ctx.config.types) && ctx.config.types.length ? new Set(ctx.config.types) : new Set(Object.keys(STRIPE_EVENTS));
    const list = ((r.data ?? []) as any[]).filter((e) => wanted.has(e.type));
    const latest = ((r.data ?? []) as any[]).reduce((m, e) => Math.max(m, e.created ?? 0), Number(since));
    return {
      cursor: String(latest),
      events: list.map((e) => {
        const o = e.data?.object ?? {};
        return {
          kind: e.type,
          itemId: o.id ?? e.id,
          title: STRIPE_EVENTS[e.type] ?? e.type,
          url: `https://dashboard.stripe.com/${e.livemode ? "" : "test/"}events/${e.id}`,
          actor: o.customer_email ?? o.receipt_email ?? o.billing_details?.email ?? null,
          preview: line([money(o.amount ?? o.amount_due ?? o.amount_total, o.currency), o.description, o.failure_message].filter(Boolean).join(" · ")),
          happenedAt: new Date((e.created ?? 0) * 1000).toISOString(),
        };
      }),
    };
  },
};
