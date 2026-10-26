import { api, setToken } from "./api.ts";

/** An organization the signed-in person belongs to (GET /api/orgs). */
export interface Org {
  id: string;
  name: string;
  role: "owner" | "member" | "guest";
  members: number;
  agents: number;
  current: boolean;
  /** something new there since you last looked (best effort) */
  unread: boolean;
  /** you own it, it isn't the first organization on this Wisp, and you're in another one */
  canDelete?: boolean;
}

/** Every organization you're in. A hub without organizations answers 404: then it's just this one, and null comes back. */
export async function listOrgs(): Promise<Org[] | null> {
  try {
    const list = await api<Org[]>("GET", "/api/orgs");
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Open the app fresh in another organization: its own channels, agents and memory. The hub has
 * already revoked the token the request went out with, so the new one is stored before anything else.
 */
function enter(token: string) {
  setToken(token);
  location.hash = "#/";
  location.reload();
}

/** Make a new organization (you own it), then switch to it. It starts with the Simple features unless you pick Everything. */
export async function createOrg(name: string, features?: "simple" | "everything"): Promise<void> {
  const r = await api<{ org: { id: string; name: string }; token: string }>("POST", "/api/orgs", { name: name.trim(), ...(features ? { features } : {}) });
  enter(r.token);
}

/** Switch to another organization you belong to. */
export async function switchOrg(id: string): Promise<void> {
  const r = await api<{ token: string }>("POST", `/api/orgs/${encodeURIComponent(id)}/switch`);
  enter(r.token);
}

/**
 * Delete an organization for good; `name` must match it. If you were in it, the hub moved your
 * sign-in to another of your organizations and the app opens there.
 */
export async function deleteOrg(id: string, name: string): Promise<void> {
  const r = await api<{ ok: true; token?: string }>("DELETE", `/api/orgs/${encodeURIComponent(id)}`, { name });
  if (r.token) enter(r.token);
}

/** The invite code from a pasted link (…#/join/<code>, …/join/<code>, ?code=<code>) or a bare code. */
export function inviteCode(text: string): string {
  const t = text.trim();
  const m = t.match(/[#/]join\/([^/?#\s]+)/) ?? t.match(/[?&]code=([^&#\s]+)/);
  return decodeURIComponent(m ? m[1] : t);
}

/** Join another organization with an invite link or code, then switch to it. */
export async function joinOrg(code: string): Promise<void> {
  const r = await api<{ token: string }>("POST", "/api/invites/join", { code: inviteCode(code) });
  enter(r.token);
}

/** "Just you · 4 agents", "3 people · 6 agents". */
export function orgSummary(o: Pick<Org, "members" | "agents">): string {
  const people = o.members <= 1 ? "Just you" : `${o.members} people`;
  return `${people} · ${o.agents} agent${o.agents === 1 ? "" : "s"}`;
}

/** Up to two letters for an organization's tile: "Acme Studio" → "AS". */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export const ORG_TONES = 6;

/** A stable tile color (1…ORG_TONES, the --org-N tokens) from the organization's id. */
export function orgTone(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % ORG_TONES) + 1;
}
