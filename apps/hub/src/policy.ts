import type { Hub } from "./hub.ts";

/**
 * Workspace-wide rules owners set in Settings, with defaults filled in: what agents ask a person
 * about before doing, how far agents may ping each other, and defaults for new agents and computers.
 */

/** Things agents ask about before doing them on their own initiative; a person asking for exactly that needs no extra OK. All are on by default; owners can turn any off. */
export const ASK_BEFORE = ["send", "spend", "delete", "post", "signup", "share"] as const;
export type AskBefore = (typeof ASK_BEFORE)[number];
export const ASK_BEFORE_DEFAULT: readonly AskBefore[] = ASK_BEFORE;

/** How each rule reads in an agent's prompt. */
export const ASK_BEFORE_TEXT: Record<AskBefore, string> = {
  send: "sending email or messages outside Wisp",
  spend: "buying or paying for anything",
  delete: "deleting files, data or accounts",
  post: "posting publicly (social media, reviews, comments)",
  signup: "signing up for new accounts or services",
  share: "sharing files or private information outside Wisp",
};

export function agentPolicy(hub: Hub, workspaceId: string) {
  const get = (k: string) => hub.store.setting(workspaceId, k);
  const askBefore = (() => {
    try {
      const v = JSON.parse(get("agents.askBefore") ?? "null");
      return Array.isArray(v) ? (v.filter((x) => (ASK_BEFORE as readonly string[]).includes(x)) as AskBefore[]) : [...ASK_BEFORE_DEFAULT];
    } catch {
      return [...ASK_BEFORE_DEFAULT];
    }
  })();
  const num = (k: string, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(get(k)) || d));
  return {
    askBefore,
    maxHops: num("agents.maxHops", 6, 1, 30),
    maxRunsPerMinute: num("agents.maxRunsPerMinute", 20, 1, 200),
    defaultAccess: ((a) => (a === "read-only" || a === "full" ? a : "edit"))(get("agents.defaultAccess")) as "read-only" | "edit" | "full",
    /** leads (of a channel's team or the organization) may create agents; off unless an owner turns it on */
    leadsCreateAgents: get("agents.leadsCreateAgents") === "true",
    /** agents a lead made may make sub-agents of their own (up to MAX_MADE_DEPTH down) */
    subAgents: get("agents.subAgents") === "true",
    /** most agents agents may have made in the organization at once */
    maxAgentMade: num("agents.maxAgentMade", 10, 1, 50),
    /** agents save how they did things as skills (skill_save); on unless an owner turns it off */
    learnSkills: get("agents.learnSkills") !== "false",
    /** after meaningful work an agent that saved nothing gets a short memory pass (AutoMemory); on unless an owner turns it off */
    autoMemory: get("agents.autoMemory") !== "false",
  };
}

/** How far down agents can make agents: a lead's agent is 1, its sub-agent 2, that one's sub-agent 3. */
export const MAX_MADE_DEPTH = 3;

export const VM_SIZES = { small: { cpus: 1, memoryGb: 2 }, medium: { cpus: 2, memoryGb: 4 }, large: { cpus: 4, memoryGb: 8 } };

/** The size of new VMs, and how long a person keeps control of a computer while idle. */
export function computerDefaults(hub: Hub, workspaceId: string) {
  const size = hub.store.setting(workspaceId, "computers.vmSize");
  const idle = Number(hub.store.setting(workspaceId, "computers.controlIdleMinutes"));
  return { vmSize: (size === "small" || size === "large" ? size : "medium") as keyof typeof VM_SIZES, controlIdleMinutes: idle > 0 ? Math.min(idle, 240) : 10 };
}
