/**
 * Logins agents use from the person's own password manager. Wisp never stores a password: it
 * reads one at the moment of filling and hands it straight to the agent's computer.
 */

/** The password managers Wisp can read logins from. */
export type LoginSourceKind = "1password";

export const LOGIN_SOURCE_LABEL: Record<LoginSourceKind, string> = { "1password": "1Password" };

/** A login as people and agents see it: never the password. */
export interface LoginSummary {
  id: string;
  title: string;
  /** e.g. "zendesk.com" */
  site: string;
  username: string;
  /** agents allowed to use it without asking each time */
  always: string[];
}

/** What an agent asks for when it wants to use a login (an approval's `login`). */
export interface LoginRequest {
  itemId: string;
  title: string;
  site: string;
  username: string;
  source: LoginSourceKind;
  /** the person who connected the password manager: only they can say yes */
  ownerId: string;
  /** the person the agent was working for */
  requestedBy: string | null;
}

/** "https://www.zendesk.com/login" → "zendesk.com"; also takes a bare "zendesk.com". */
export function siteOf(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    if (!host.includes(".") && host !== "localhost") return null;
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A page on `host` may use a login saved for `site` (the site itself or one of its subdomains). */
export function siteMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const s = site.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}
