import { soulPath } from "./soul.ts";
import type { Actor, Role } from "./types.ts";

/** How much someone may do with a memory note or folder. "manage" also lets them change who has access. */
export type MemoryLevel = "none" | "read" | "edit" | "manage";
export const MEMORY_LEVELS: readonly MemoryLevel[] = ["none", "read", "edit", "manage"];

/** Who an access rule is about. */
export type Subject =
  | { kind: "user"; id: string }
  | { kind: "members" } // every owner and member (not guests)
  | { kind: "guests" }
  | { kind: "agent"; id: string }
  | { kind: "team"; name: string } // everyone on a channel's team, by the channel's name
  | { kind: "role"; team: string; role: string } // agents with that role on a channel's team, e.g. reviewers in #web
  | { kind: "all_agents" };

/**
 * Access to a note or folder. Rules on a folder apply to everything inside it; a rule closer
 * to the note wins, then the most specific subject (one agent beats its role, which beats its
 * team, which beats all agents).
 */
export interface AccessRule {
  id?: string;
  /** vault-relative folder or note path; "" is the whole vault */
  path: string;
  subject: Subject;
  level: MemoryLevel;
  /** agents this rule covers get the note(s) in their prompt on every run */
  startup?: boolean;
  /** a default that follows the workspace's structure (not stored, but can be overridden) */
  builtin?: boolean;
  createdBy?: Actor;
}

/** Who is asking. */
export interface Viewer {
  actor: Actor;
  role?: Role; // people
  teams?: string[]; // agents: names of the channels whose teams they're on
  teamRoles?: { team: string; role: string }[]; // agents: their role on each team, when they have one
  soulLocked?: boolean; // agents
}

export const atLeast = (have: MemoryLevel, need: MemoryLevel) => MEMORY_LEVELS.indexOf(have) >= MEMORY_LEVELS.indexOf(need);

/** Stable text form of a subject, e.g. "agent:agt_x" or "all_agents". */
export function subjectKey(s: Subject): string {
  switch (s.kind) {
    case "user":
    case "agent":
      return `${s.kind}:${s.id}`;
    case "team":
      return `team:${s.name}`;
    case "role":
      return `role:${s.team}/${s.role}`;
    default:
      return s.kind;
  }
}

export function parseSubjectKey(key: string): Subject | null {
  const i = key.indexOf(":");
  const kind = i < 0 ? key : key.slice(0, i);
  const rest = i < 0 ? "" : key.slice(i + 1);
  if ((kind === "user" || kind === "agent") && rest) return { kind, id: rest };
  if (kind === "team" && rest) return { kind, name: rest };
  if (kind === "role" && rest.includes("/")) {
    const [team, ...role] = rest.split("/");
    if (team && role.join("/")) return { kind, team, role: role.join("/") };
  }
  if (!rest && (kind === "members" || kind === "guests" || kind === "all_agents")) return { kind };
  return null;
}

/** Folder/note path as rules store it: forward slashes, no leading or trailing slash. */
export function cleanRulePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Paths compare case-insensitively: macOS and Windows file systems do. */
const pathKey = (p: string) => cleanRulePath(p).toLowerCase();
const depth = (key: string) => (key ? key.split("/").length : 0);

/** Does a rule on `rulePath` cover `path` (the same note/folder or something inside it)? */
export function covers(rulePath: string, path: string): boolean {
  const r = pathKey(rulePath);
  const p = pathKey(path);
  return r === "" || p === r || p.startsWith(r + "/");
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** How specifically a subject names this viewer: 4 = by name, 3 = by team role, 2 = by team, 1 = by kind, 0 = not at all. */
export function specificity(v: Viewer, s: Subject): number {
  const { actor } = v;
  if (actor.kind === "user") {
    if (s.kind === "user") return s.id === actor.id ? 4 : 0;
    if (s.kind === "members") return v.role === "owner" || v.role === "member" ? 1 : 0;
    if (s.kind === "guests") return v.role === "guest" ? 1 : 0;
    return 0;
  }
  if (s.kind === "agent") return s.id === actor.id ? 4 : 0;
  if (s.kind === "role") return v.teamRoles?.some((r) => same(r.team, s.team) && same(r.role, s.role)) ? 3 : 0;
  if (s.kind === "team") return v.teams?.some((t) => same(t, s.name)) ? 2 : 0;
  if (s.kind === "all_agents") return 1;
  return 0;
}

/** What the defaults depend on. */
export interface WorkspaceShape {
  agents: { id: string }[];
  /** `above`: agents the team reports to, nearest first (its boss, the boss's boss, ...) */
  teams?: { name: string; folder: string; above: string[] }[];
  people?: { id: string }[];
}

/**
 * Defaults that follow the workspace: people (not guests) edit everything, guests read shared/,
 * every agent edits shared/ and its own folder, each team edits its pool and so does everyone it
 * reports to, and each person's folder is theirs to manage and open to agents but not to other people.
 */
export function builtinRules(ws: WorkspaceShape): AccessRule[] {
  const rules: AccessRule[] = [
    { path: "", subject: { kind: "members" }, level: "edit", builtin: true },
    { path: "shared", subject: { kind: "all_agents" }, level: "edit", builtin: true },
    { path: "shared", subject: { kind: "guests" }, level: "read", builtin: true },
  ];
  for (const a of ws.agents) rules.push({ path: `agents/${a.id}`, subject: { kind: "agent", id: a.id }, level: "edit", builtin: true });
  for (const t of ws.teams ?? []) {
    if (!t.folder) continue;
    rules.push({ path: t.folder, subject: { kind: "team", name: t.name }, level: "edit", builtin: true });
    for (const boss of t.above) rules.push({ path: t.folder, subject: { kind: "agent", id: boss }, level: "edit", builtin: true });
  }
  for (const p of ws.people ?? []) {
    const path = personDir(p.id);
    rules.push({ path, subject: { kind: "user", id: p.id }, level: "manage", builtin: true });
    rules.push({ path, subject: { kind: "members" }, level: "none", builtin: true });
    rules.push({ path, subject: { kind: "all_agents" }, level: "edit", builtin: true });
  }
  return rules;
}

/** Where what agents learn about a person lives. */
export const personDir = (userId: string) => `people/${userId}`;

export interface Decision {
  level: MemoryLevel;
  /** the rule that decided it; null for owners (always manage) or when nothing applies */
  rule: AccessRule | null;
}

/**
 * Build a fast access check for one viewer. Only the rules naming this viewer are kept,
 * sorted so the first covering rule is the deciding one: deepest path, then most specific
 * subject, then stored over built-in, then the higher level.
 */
export function accessChecker(v: Viewer, rules: AccessRule[]): (path: string) => Decision {
  if (v.actor.kind === "user" && v.role === "owner") return () => ({ level: "manage", rule: null });
  const mine = rules
    .map((rule) => ({ rule, key: pathKey(rule.path), spec: specificity(v, rule.subject) }))
    .filter((r) => r.spec > 0)
    .sort((a, b) => depth(b.key) - depth(a.key) || b.spec - a.spec || Number(!!a.rule.builtin) - Number(!!b.rule.builtin) || MEMORY_LEVELS.indexOf(b.rule.level) - MEMORY_LEVELS.indexOf(a.rule.level));
  const soul = v.actor.kind === "agent" && v.soulLocked ? soulPath(v.actor.id).toLowerCase() : null;
  return (path) => {
    const p = pathKey(path);
    const hit = mine.find((r) => r.key === "" || p === r.key || p.startsWith(r.key + "/"));
    if (!hit) return { level: "none", rule: null };
    let level = hit.rule.level;
    // agents never manage access; guests only ever read; a locked soul is read-only to its agent
    if (v.actor.kind === "agent" && level === "manage") level = "edit";
    if (v.role === "guest" && atLeast(level, "edit")) level = "read";
    if (soul && p === soul && atLeast(level, "edit")) level = "read";
    return { level, rule: hit.rule };
  };
}

/** Stored rules asking for notes to be loaded into this agent's prompt. */
export function startupRules(v: Viewer, rules: AccessRule[]): AccessRule[] {
  return rules.filter((r) => r.startup && !r.builtin && specificity(v, r.subject) > 0);
}
