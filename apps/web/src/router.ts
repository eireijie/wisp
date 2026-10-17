import { useEffect, useState } from "react";

/**
 * Hash routes:
 *   #/buddy                          desktop ghost (no workspace chrome)
 *   #/c/<channelId>[/t/<threadId>]   chat
 *   #/dashboard                      a bit of everything: agents, teams, tasks
 *   #/vault[/<path>]                 memory vault
 *   #/agents[/<agentId>[/<tab>]]     agents and their settings
 *   #/teams[/<teamId>[/<tab>]]       teams, the org chart, and each team's chart
 *   #/about                          what agents remember about you
 *   #/tasks                          work handed to agents, by status
 *   #/computers[/<id>[/teach/<agentId>]]  agents' computers, live view, teaching a task
 *   #/nodes                          devices
 *   #/connectors                     MCP servers and other connections agents can use
 *   #/skills                         the skill shop: things agents can learn to do
 *   #/settings[/<page>]              your settings and the workspace's (see SETTINGS_PAGES)
 *   #/join/<code>                    accept an invite (signed out)
 *   #/welcome                        first-run onboarding
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
  | { view: "welcome" }
  | { view: "chats" }
  | { view: "you" };

export const AGENT_TABS = ["overview", "look", "soul", "instructions", "model", "device", "computer", "background", "routines", "permissions", "connect", "runs"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const SETTINGS_PAGES = ["profile", "preferences", "notifications", "voice", "appearance", "security", "general", "people", "agents", "runtimes", "memory", "computers", "connections", "addons", "data", "updates"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const TEAM_TABS = ["chart", "work", "settings"] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "buddy":
      return { view: "buddy" };
    case "dashboard":
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
      return { view: "welcome" };
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
      return "#/teams" + (r.teamId ? `/${r.teamId}${r.tab && r.tab !== "chart" ? `/${r.tab}` : ""}` : "");
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
      return "#/welcome";
    case "chats":
      return "#/chats";
    case "you":
      return "#/you";
    case "chat":
      return r.channelId ? `#/c/${r.channelId}${r.call ? "/call" : r.threadId ? `/t/${r.threadId}` : ""}` : "#/";
  }
}

export function go(r: Route) {
  location.hash = href(r);
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
