import { useMemo, useSyncExternalStore } from "react";

/**
 * Hash routes:
 *   #/buddy                          desktop ghost (no workspace chrome)
 *   #/c/<channelId>[/t/<threadId>][/m/<messageId>]   chat
 *   #/dashboard (or #/inbox)         the Inbox: what's waiting on you, what agents are doing, new replies
 *   #/vault[/<path>]                 memory vault
 *   #/agents[/<agentId>[/<tab>]]     agents and their settings
 *   #/about                          what agents remember about you
 *   #/tasks                          work handed to agents, by status
 *   #/computers[/<id>[/teach/<agentId>]]  devices and their agents' computers, live view, teaching a task
 *   #/computers/d/<nodeId>           one device's page (#/nodes[/<nodeId>] still lands here)
 *   #/marketplace[/<section>]        apps and skills to get, and what devices already have (MARKET_SECTIONS)
 *   #/connectors, #/skills           older addresses of the marketplace (installed apps, skills)
 *   #/settings[/<page>[/<item>]]     your settings and the organization's (see SETTINGS_PAGES); full window on desktops; <item> opens one thing in a page (a skill)
 *   #/join/<code>                    accept an invite (signed out)
 *   #/authorize/<requestId>          let an app (Grok, ChatGPT, Claude…) connect as an agent (the hub's /oauth/authorize sends people here)
 *   #/welcome[/intro]                first-run onboarding; /intro opens on "what Wisp is"
 *   #/help                           help: finish setup, why a helper isn't answering, words you'll see
 *   #/mods                           mods: optional parts of Wisp, switched on or off
 *   #/                               the dashboard on desktops, the chats list on phones (App.tsx)
 *   #/chats                          channel list (phones; desktops go to the dashboard)
 *   #/you                            account menu (phones)
 */
export type Route =
  | { view: "buddy" }
  | { view: "authorize"; requestId: string }
  | { view: "chat"; channelId: string | null; threadId: string | null; messageId?: string; call?: boolean }
  | { view: "dashboard" }
  | { view: "vault"; path: string | null }
  | { view: "agents"; agentId: string | null; tab?: AgentTab | null }
  | { view: "about" }
  | { view: "tasks" }
  | { view: "computers"; computerId: string | null; teach?: string | null; deviceId?: string | null }
  | { view: "marketplace"; section?: MarketSection | null }
  | { view: "connectors" }
  | { view: "skills" }
  | { view: "settings"; page?: SettingsPage | null; item?: string | null }
  | { view: "welcome"; intro?: boolean }
  | { view: "help" }
  | { view: "mods" }
  | { view: "chats" }
  | { view: "you" }
  | { view: "more" };

export const AGENT_TABS = ["overview", "look", "soul", "instructions", "model", "device", "computer", "access", "background", "routines", "memory", "skills", "apps", "permissions", "connect", "runs", "remove"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const SETTINGS_PAGES = ["profile", "preferences", "notifications", "usage", "voice", "appearance", "security", "devices", "mobile", "general", "access", "agent-defaults", "people", "agents", "runtimes", "models", "harnesses", "memory", "computers", "logins", "storage", "apps", "skills", "connections", "data", "updates"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const MARKET_SECTIONS = ["all", "apps", "skills", "devices", "installed"] as const;
export type MarketSection = (typeof MARKET_SECTIONS)[number];

export function routeForRole(route: Route, role?: "owner" | "member" | "guest"): Route {
  return role === "guest" && route.view === "computers" ? { view: "dashboard" } : route;
}

export function parseRoute(hash: string): Route {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { view: "chat", channelId: null, threadId: null };
  }
  switch (parts[0]) {
    case "buddy":
      return { view: "buddy" };
    case "authorize":
      return parts[1] ? { view: "authorize", requestId: parts[1] } : { view: "dashboard" };
    case "dashboard":
    case "inbox":
      return { view: "dashboard" };
    case "marketplace":
      // mods have one home now: their own page
      if (parts[1] === "mods") return { view: "mods" };
      return { view: "marketplace", section: MARKET_SECTIONS.find((x) => x === parts[1]) ?? null };
    case "connectors":
      return { view: "connectors" };
    case "skills":
      return { view: "skills" };
    case "vault":
      return { view: "vault", path: parts.slice(1).join("/") || null };
    case "agents":
      return { view: "agents", agentId: parts[1] ?? null, tab: AGENT_TABS.find((t) => t === parts[2]) ?? null };
    case "teams":
      // teams are channels now; an old link lands on the channel (a team's id is its channel's)
      return { view: "chat", channelId: parts[1] ?? null, threadId: null };
    case "about":
      return { view: "about" };
    case "tasks":
      return { view: "tasks" };
    case "computers":
      if (parts[1] === "d") return { view: "computers", computerId: null, deviceId: parts[2] ?? null };
      return { view: "computers", computerId: parts[1] ?? null, teach: parts[2] === "teach" ? (parts[3] ?? null) : null };
    case "nodes":
      // devices live inside Computers now
      return { view: "computers", computerId: null, ...(parts[1] ? { deviceId: parts[1] } : {}) };
    case "settings": {
      const page = SETTINGS_PAGES.find((p) => p === parts[1]) ?? null;
      // one thing inside a page, e.g. a skill: #/settings/skills/<id>
      return { view: "settings", page, ...(page && parts[2] ? { item: parts.slice(2).join("/") } : {}) };
    }
    case "welcome":
      return { view: "welcome", ...(parts[1] === "intro" ? { intro: true } : {}) };
    case "help":
      return { view: "help" };
    case "mods":
      return { view: "mods" };
    case "chats":
      return { view: "chats" };
    case "you":
      return { view: "you" };
    case "more":
      return { view: "more" };
    case "c": {
      const messageIndex = parts[2] === "t" ? 4 : parts[2] === "call" ? 3 : 2;
      const messageId = parts[messageIndex] === "m" ? parts[messageIndex + 1] : undefined;
      return { view: "chat", channelId: parts[1] ?? null, threadId: parts[2] === "t" ? (parts[3] ?? null) : null, ...(parts[2] === "call" ? { call: true } : {}), ...(messageId ? { messageId } : {}) };
    }
    default:
      return { view: "chat", channelId: null, threadId: null };
  }
}

export function href(r: Route): string {
  switch (r.view) {
    case "buddy":
      return "#/buddy";
    case "authorize":
      return `#/authorize/${encodeURIComponent(r.requestId)}`;
    case "dashboard":
      return "#/dashboard";
    case "marketplace":
      return "#/marketplace" + (r.section && r.section !== "all" ? `/${r.section}` : "");
    case "connectors":
      return "#/connectors";
    case "skills":
      return "#/skills";
    case "vault":
      return "#/vault" + (r.path ? "/" + r.path.split("/").map(encodeURIComponent).join("/") : "");
    case "agents":
      return "#/agents" + (r.agentId ? `/${r.agentId}${r.tab ? `/${r.tab}` : ""}` : "");
    case "about":
      return "#/about";
    case "tasks":
      return "#/tasks";
    case "computers":
      return "#/computers" + (r.deviceId ? `/d/${r.deviceId}` : r.computerId ? `/${r.computerId}${r.teach ? `/teach/${r.teach}` : ""}` : "");
    case "settings":
      return "#/settings" + (r.page ? `/${r.page}${r.item ? `/${encodeURIComponent(r.item)}` : ""}` : "");
    case "welcome":
      return r.intro ? "#/welcome/intro" : "#/welcome";
    case "help":
      return "#/help";
    case "mods":
      return "#/mods";
    case "chats":
      return "#/chats";
    case "you":
      return "#/you";
    case "more":
      return "#/more";
    case "chat":
      return r.channelId ? `#/c/${r.channelId}${r.call ? "/call" : r.threadId ? `/t/${r.threadId}` : ""}${r.messageId ? `/m/${encodeURIComponent(r.messageId)}` : ""}` : "#/";
  }
}

/** Views with unsaved work register one of these; navigation asks before leaving. Returns the question, or null when it's fine to go. */
type LeaveGuard = () => string | null;
const guards = new Set<LeaveGuard>();

/** Ask before navigating away while `why()` returns a question (an unsaved note, say). Returns the unregister function. */
export function guardLeaving(why: LeaveGuard): () => void {
  guards.add(why);
  return () => void guards.delete(why);
}

/** Is it fine to leave the current view? Asks the person when something would be lost. */
export function mayLeave(): boolean {
  for (const why of guards) {
    const q = why();
    if (q && !confirm(q)) return false;
  }
  return true;
}

export function go(r: Route) {
  transition(href(r), true);
}

/** The last place in the app outside Settings, for Settings' "Back to app". */
let lastAppHash: string | null = null;
let currentHash = typeof location === "undefined" ? "" : location.hash;
const listeners = new Set<() => void>();
const subscribe = (on: () => void) => {
  listeners.add(on);
  return () => void listeners.delete(on);
};

function transition(hash: string, push = false) {
  if (hash === currentHash) return;
  if (!mayLeave()) {
    if (!push) history.replaceState(history.state, "", location.pathname + location.search + currentHash);
    return;
  }
  if (push) location.hash = hash;
  currentHash = location.hash;
  noteAppHash();
  listeners.forEach((on) => on());
}

function noteAppHash() {
  if (typeof location === "undefined") return;
  if (parseRoute(currentHash).view !== "settings") lastAppHash = currentHash || "#/";
}
if (typeof window !== "undefined") {
  noteAppHash();
  const on = () => transition(location.hash);
  window.addEventListener("hashchange", on);
  window.addEventListener("popstate", on);
}
export function appHashBeforeSettings(): string {
  return lastAppHash ?? href({ view: "dashboard" });
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => currentHash);
  return useMemo(() => parseRoute(hash), [hash]);
}
