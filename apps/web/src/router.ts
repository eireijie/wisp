import { useEffect, useState } from "react";

/**
 * Hash routes:
 *   #/buddy                          desktop ghost (no workspace chrome)
 *   #/c/<channelId>[/t/<threadId>]   chat
 *   #/dashboard (or #/inbox)         the Inbox: what's waiting on you, what agents are doing, new replies
 *   #/vault[/<path>]                 memory vault
 *   #/agents[/<agentId>[/<tab>]]     agents and their settings
 *   #/teams[/<teamId>[/<tab>]]       teams, and each team (members, work, settings)
 *   #/about                          what agents remember about you
 *   #/tasks                          work handed to agents, by status
 *   #/computers[/<id>[/teach/<agentId>]]  agents' computers, live view, teaching a task
 *   #/nodes                          devices
 *   #/connectors                     MCP servers and other connections agents can use
 *   #/skills                         the skill shop: things agents can learn to do
 *   #/settings[/<page>]              your settings and the organization's (see SETTINGS_PAGES); full window on desktops
 *   #/join/<code>                    accept an invite (signed out)
 *   #/welcome[/intro]                first-run onboarding; /intro opens on "what Warren is" and Simple or Advanced
 *   #/help                           help: finish setup, why a helper isn't answering, words you'll see
 *   #/mods                           mods: optional parts of Warren, switched on or off
 *   #/                               the dashboard on desktops, the chats list on phones (App.tsx)
 *   #/chats                          channel list (phones; desktops go to the dashboard)
 *   #/you                            account menu (phones)
 */
export type Route =
  | { view: "buddy" }
  | { view: "chat"; channelId: string | null; threadId: string | null; call?: boolean }
  | { view: "dashboard" }
  | { view: "vault"; path: string | null }
  | { view: "agents"; agentId: string | null; tab?: AgentTab | null }
  | { view: "teams"; teamId: string | null; tab?: TeamTab | null }
  | { view: "about" }
  | { view: "tasks" }
  | { view: "computers"; computerId: string | null; teach?: string | null }
  | { view: "nodes" }
  | { view: "connectors" }
  | { view: "skills" }
  | { view: "settings"; page?: SettingsPage | null }
  | { view: "welcome"; intro?: boolean }
  | { view: "help" }
  | { view: "mods" }
  | { view: "chats" }
  | { view: "you" };

export const AGENT_TABS = ["overview", "look", "soul", "instructions", "model", "device", "computer", "background", "routines", "permissions", "connect", "runs"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const SETTINGS_PAGES = ["profile", "preferences", "notifications", "usage", "voice", "appearance", "security", "mobile", "general", "access", "agent-defaults", "features", "people", "agents", "runtimes", "memory", "computers", "apps", "connections", "data", "updates"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const TEAM_TABS = ["members", "work", "settings"] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "buddy":
      return { view: "buddy" };
    case "dashboard":
    case "inbox":
      return { view: "dashboard" };
    case "connectors":
      return { view: "connectors" };
    case "skills":
      return { view: "skills" };
    case "vault":
      return { view: "vault", path: parts.slice(1).join("/") || null };
    case "agents":
      return { view: "agents", agentId: parts[1] ?? null, tab: AGENT_TABS.find((t) => t === parts[2]) ?? null };
    case "teams":
      return { view: "teams", teamId: parts[1] ?? null, tab: TEAM_TABS.find((t) => t === parts[2]) ?? null };
    case "about":
      return { view: "about" };
    case "tasks":
      return { view: "tasks" };
    case "computers":
      return { view: "computers", computerId: parts[1] ?? null, teach: parts[2] === "teach" ? (parts[3] ?? null) : null };
    case "nodes":
      return { view: "nodes" };
    case "settings":
      return { view: "settings", page: SETTINGS_PAGES.find((p) => p === parts[1]) ?? null };
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
    case "c":
      return { view: "chat", channelId: parts[1] ?? null, threadId: parts[2] === "t" ? (parts[3] ?? null) : null, ...(parts[2] === "call" ? { call: true } : {}) };
    default:
      return { view: "chat", channelId: null, threadId: null };
  }
}

export function href(r: Route): string {
  switch (r.view) {
    case "buddy":
      return "#/buddy";
    case "dashboard":
      return "#/dashboard";
    case "connectors":
      return "#/connectors";
    case "skills":
      return "#/skills";
    case "vault":
      return "#/vault" + (r.path ? "/" + r.path.split("/").map(encodeURIComponent).join("/") : "");
    case "agents":
      return "#/agents" + (r.agentId ? `/${r.agentId}${r.tab ? `/${r.tab}` : ""}` : "");
    case "teams":
      return "#/teams" + (r.teamId ? `/${r.teamId}${r.tab && r.tab !== "members" ? `/${r.tab}` : ""}` : "");
    case "about":
      return "#/about";
    case "tasks":
      return "#/tasks";
    case "computers":
      return "#/computers" + (r.computerId ? `/${r.computerId}${r.teach ? `/teach/${r.teach}` : ""}` : "");
    case "nodes":
      return "#/nodes";
    case "settings":
      return "#/settings" + (r.page ? `/${r.page}` : "");
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
    case "chat":
      return r.channelId ? `#/c/${r.channelId}${r.call ? "/call" : r.threadId ? `/t/${r.threadId}` : ""}` : "#/";
  }
}

/** Views with unsaved work register one of these; `go()` asks before leaving. Returns the question, or null when it's fine to go. */
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
  if (!mayLeave()) return;
  location.hash = href(r);
}

/** The last place in the app outside Settings, for Settings' "Back to app". */
let lastAppHash: string | null = null;
function noteAppHash() {
  if (typeof location === "undefined") return;
  if (parseRoute(location.hash).view !== "settings") lastAppHash = location.hash || "#/";
}
if (typeof window !== "undefined") {
  noteAppHash();
  window.addEventListener("hashchange", noteAppHash);
}
export function appHashBeforeSettings(): string {
  return lastAppHash ?? href({ view: "dashboard" });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
