import type { Hub } from "./hub.ts";

/**
 * Workspace-wide rules owners set in Settings, with defaults filled in: what agents ask a person
 * about before doing, how far agents may ping each other, and defaults for new agents and computers.
 */

/** Things agents ask about before doing them, unless someone asked for exactly that. */
export const ASK_BEFORE = ["send", "spend", "delete", "post", "signup", "share"] as const;
export type AskBefore = (typeof ASK_BEFORE)[number];
export const ASK_BEFORE_DEFAULT: AskBefore[] = ["send", "spend", "delete", "post"];

/** How each rule reads in an agent's prompt. */
export const ASK_BEFORE_TEXT: Record<AskBefore, string> = {
  send: "sending email or messages outside Warren",
  spend: "buying or paying for anything",
  delete: "deleting files, data or accounts",
  post: "posting publicly (social media, reviews, comments)",
  signup: "signing up for new accounts or services",
  share: "sharing files or private information outside Warren",
};

export function agentPolicy(hub: Hub, workspaceId: string) {
  const get = (k: string) => hub.store.setting(workspaceId, k);
  const askBefore = (() => {
    try {
      const v = JSON.parse(get("agents.askBefore") ?? "null");
      return Array.isArray(v) ? (v.filter((x) => (ASK_BEFORE as readonly string[]).includes(x)) as AskBefore[]) : ASK_BEFORE_DEFAULT;
    } catch {
      return ASK_BEFORE_DEFAULT;
    }
  })();
  const num = (k: string, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(get(k)) || d));
  return {
    askBefore,
    maxHops: num("agents.maxHops", 6, 1, 30),
    maxRunsPerMinute: num("agents.maxRunsPerMinute", 20, 1, 200),
    defaultAccess: ((a) => (a === "read-only" || a === "full" ? a : "edit"))(get("agents.defaultAccess")) as "read-only" | "edit" | "full",
  };
}

export const VM_SIZES = { small: { cpus: 1, memoryGb: 2 }, medium: { cpus: 2, memoryGb: 4 }, large: { cpus: 4, memoryGb: 8 } };

/** The size of new VMs, and how long a person keeps control of a computer while idle. */
export function computerDefaults(hub: Hub, workspaceId: string) {
  const size = hub.store.setting(workspaceId, "computers.vmSize");
  const idle = Number(hub.store.setting(workspaceId, "computers.controlIdleMinutes"));
  return { vmSize: (size === "small" || size === "large" ? size : "medium") as keyof typeof VM_SIZES, controlIdleMinutes: idle > 0 ? Math.min(idle, 240) : 10 };
}
