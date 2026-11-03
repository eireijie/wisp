import { github } from "./github.ts";
import { gcal, gdrive, gmail } from "./google.ts";
import { jira } from "./jira.ts";
import { linear } from "./linear.ts";
import { notion } from "./notion.ts";
import { slack } from "./slack.ts";
import { stripe } from "./stripe.ts";
import type { Watcher } from "./types.ts";

export * from "./types.ts";

/** Every app the hub can ask what changed. A new one plugs in here. */
export const WATCHERS: Watcher[] = [slack, github, notion, linear, jira, stripe, gdrive, gmail, gcal];

export const watcherFor = (service: string) => WATCHERS.find((w) => w.service === service);
