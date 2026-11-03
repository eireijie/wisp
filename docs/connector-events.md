# Connector events (watches)

Agents hear about changes in a person's apps without anyone asking. A new doc, an edit, a
review request, a failed payment: the hub notices it, and the agent decides whether to speak up,
once.

## How it works

```
 app API ──(hub asks "what changed since <cursor>?", no model, no tokens)──► app_events
                                                                              │ one row per agent on the watch
                                   batched: 2 min after the last change,      ▼
                                   10 min at most after the first      background check
                                                                              │ prompt lists the changes
                                                                              ▼
                                                    message_person(about: "notion:<page id>")
                                                    refused if already raised and not answered
```

- **A watch** (`apps/hub/src/watches.ts`) belongs to one person and is shared with the agents they pick (or the agent that set it up). Its key comes from that app's connector, or from a key given for the watch alone.
- **Polling with cursors.** Each watcher keeps its own cursor: Slack message timestamps, GitHub's `since`, Notion's last edit time, Linear notification times, Jira's relative `updated`, Stripe's `created`, Google Drive change page tokens, Gmail `historyId`, Calendar sync tokens. The first look only finds where "now" is. Looking costs no model tokens, and the hub keeps working while it's private on a tailnet.
- **Batching.** A burst of edits becomes one check. Near the end of the person's allowance, changes are gathered for twice as long. While the allowance is used up, the agent's daily checks are used up, it's quiet hours or background work is off, changes wait (and are dropped after 2 days).
- **Mention once.** `message_person` takes an `about` key. The hub refuses a key the agent already raised unless the person wrote back (within 3 days of it). Each check lists what was already raised.
- **Waking idle agents.** An agent with a watch counts as having something to watch, and a change wakes it straight away, so quiet-check back-off no longer delays apps that have a watch.

## What's watched

| Service | Key | What it sees |
| --- | --- | --- |
| Slack | bot token (`xoxb-`) or user token (`xoxp-`) | new messages in channels and DMs the key can read; mentions and DMs marked |
| GitHub | personal access token | notifications (classic token); fine-grained tokens fall back to issues and PRs that involve the person |
| Notion | integration token | new and edited pages and databases shared with the integration |
| Linear | personal API key | the person's notifications |
| Jira | site, email, API token | issues the person is assigned, reported or watches |
| Stripe | restricted key (Events: read) | failed payments, disputes, refunds, subscriptions, checkouts, payouts |
| Google Drive & Docs, Gmail, Calendar | Google sign-in | written and tested, **not offered yet** (see below) |
| Any website | the agent's computer | the agent opens it in its browser every 2+ hours (default 6) and looks for what the person asked |

Browser watches cost a check each time, about 60k tokens, so a watch shows its estimate (checks a day, tokens, share of the allowance) when it's made. API watches only cost when something changes, about 25k tokens per batch.

**Remote MCP connectors don't help with events.** MCP only sends change notices (`resources/subscribe`) inside an open session, and hosted servers (Notion, Linear, GitHub, Zapier) don't use it. So watchers call each app's own API with the same key the connector holds.

## Privacy

- Document text is never fetched or kept. An event is a title, a link, who changed it and when, plus at most a one-line preview (a Slack message, an email subject). Previews are deleted once the agent's check ends, or after a day. Titles and links are kept a week.
- People see their watches (`GET /api/watches`) and can pause them or stop them (`PATCH`/`DELETE /api/watches/:id`). Stopping deletes the watch, its key and everything it saw. Pausing drops what was waiting.
- Keys are never returned by the API. Watches only call public addresses.
- Watching is read-only. Anything outside Wisp the agent then wants to do still goes through `approval_request`.

## For agents and setup flows

- Tools: `watch_list` (what it watches, what can be watched and how to get each key), `watch_start`, `watch_stop`.
- Hub function: `hub.watches.create({ workspaceId, userId, agentIds, service, connectorId?, secrets?, config?, label?, everyMinutes?, createdBy })`. It returns the watch, or `{ error }` in words the agent can pass on (a refused key, a missing computer, an agent not connected to that app). It looks once right away, so a bad key fails while the person is still there.
- A browser watch takes `config.url` and `config.lookFor`, and its agent needs its own computer.

## Adding a service

Write a `Watcher` in `apps/hub/src/watchers/` (`service`, the connector keys it `needs`, `poll(ctx)` returning `{ cursor, events }`), add it to `WATCHERS` and the service name to `WATCH_SERVICES` in `packages/core/src/watches.ts`, and test it with a stubbed `fetch` (`apps/hub/test/watchers.test.ts`).

## Later: push

Webhooks are a follow-up. The plan is a `/hooks/<random id>` path added to the Tailscale Funnel connector door (`reach.ts`), only when the person turns it on. A push would only tell the hub to look now. Its body is never trusted, so the same cursor-based poll still decides what changed. That gives near-instant Slack, GitHub and Stripe events without widening what the public door can do. Gmail push needs a Pub/Sub topic, and Drive and Calendar push need a public HTTPS address, so for Google, polling stays the default.

## Google, Meta and other big platforms: what an official Wisp app needs

Today each owner would have to make their own Google Cloud project, which is developer setup most people won't do. The Google watchers are written and tested against stubbed APIs, but they stay switched off until Wisp has one shared, verified OAuth app (`WISP_GOOGLE_CLIENT_ID` / `WISP_GOOGLE_CLIENT_SECRET`). Until then, agents watch Google in their computer's browser.

What one official Google app would take:

- **Scopes.** Drive changes with file names: `drive.metadata.readonly` (restricted). Gmail sender and subject: `gmail.metadata` or `gmail.readonly` (restricted). Calendar: `calendar.readonly` (sensitive). Restricted scopes need Google's full verification plus a yearly CASA security assessment.
- **Verification.** A verified domain and homepage for the app, a privacy policy that matches Google's Limited Use rules, a demo video of the consent flow, and a written reason for each scope. Google's own review is usually days to a few weeks; CASA is the long part.
- **CASA (Tier 2 for these scopes).** Done by an authorized lab and renewed every year. Reported prices range from about $540 a year (Google's discounted TAC Security plan) to $3,000–4,500 at other labs, with about 1–3 weeks of lab time. Self-scans reportedly aren't accepted any more. Check Google's CASA page for current prices before budgeting.
- **Self-hosting wrinkle.** A shared client ID means every self-hosted hub signs in through Wisp's app, and the redirect has to land on a fixed, verified address. The likely shape: a small sign-in relay on the Wisp website that hands the person's refresh token back to their own hub, and never keeps it. That relay is part of what Google reviews.
- **Until verified.** An app left "in testing" works for up to 100 named test users, but their sign-ins expire every 7 days, so it isn't good enough to ship.

Meta (Instagram, Facebook, WhatsApp) is similar: Business Verification of the company behind the app, App Review for each permission (reported at a few weeks), and webhooks set up in the app dashboard. Until Wisp has those, Meta is also a browser watch.

Sources: [Nango: Google security review](https://nango.dev/docs/api-integrations/google-shared/google-security-review), [Leviathan Security: CASA](https://leviathansecurity.com/programs/google-casa-cloud-application-security-assessment), [Google Apps Script community: CASA verification](https://groups.google.com/g/google-apps-script-community/c/XgsHT2Fr7u8), [Meta: create an app](https://developers.facebook.com/documentation/development/create-an-app.md).
