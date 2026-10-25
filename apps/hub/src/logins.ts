import { LOGIN_SOURCE_LABEL, siteMatches, siteOf, type Agent, type Approval, type LoginFillResult, type LoginRequest, type LoginSourceKind, type LoginSummary } from "@wisp/core";
import type { Hub } from "./hub.ts";

/**
 * Agents signing in to websites with logins from the person's password manager (Settings →
 * Logins). Wisp keeps only the manager's access token: each password is read at the moment it's
 * filled, goes straight to the agent's computer, and is put into the page there only if the page
 * is on the login's site. The agent hears "filled", never the password.
 */

/** A login as the password manager has it, without its secrets. */
export interface SourceLogin {
  id: string;
  title: string;
  site: string;
  username: string;
}

/** One password manager, opened with its token. */
export interface LoginSource {
  /** the vault Wisp reads from */
  vaultName: string;
  list(): Promise<SourceLogin[]>;
  secret(itemId: string): Promise<{ username: string; password: string; otp?: string }>;
}

/** Opens a password manager; throws a LoginError people can read when the token is wrong. */
export type LoginSourceOpener = (kind: LoginSourceKind, token: string) => Promise<LoginSource>;

export class LoginError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Connection {
  kind: LoginSourceKind;
  token: string;
  vaultName: string;
  connectedBy: string;
  connectedAt: string;
}

const SOURCE_KEY = "logins.source";
const ALWAYS_KEY = "logins.always";
/** how long the list from the password manager is reused */
const LIST_TTL_MS = 60_000;
/** after a yes, more fills of the same login (a sign-in spread over two pages) don't ask again */
const PASS_MS = 10 * 60_000;

/** 1Password, through a service account that can see a vault named "Agents" (or only one vault). */
export const openOnePassword: LoginSourceOpener = async (_kind, token) => {
  const sdk = await import("@1password/sdk");
  let client: Awaited<ReturnType<typeof sdk.createClient>>;
  try {
    client = await sdk.createClient({ auth: token, integrationName: "Wisp", integrationVersion: "1.0.0" });
  } catch (err) {
    throw new LoginError(`1Password didn't accept that token: ${(err as Error).message}`);
  }
  const vaults = await client.vaults.list();
  const vault = vaults.find((v) => v.title.trim().toLowerCase() === "agents") ?? (vaults.length === 1 ? vaults[0] : undefined);
  if (!vault)
    throw new LoginError(
      vaults.length ? `That token can see ${vaults.length} vaults but none is called “Agents”. Give the service account only the Agents vault.` : "That token can't see any vault. Give the service account read access to your Agents vault.",
    );
  const field = (item: { fields: { id: string; value: string }[] }, id: string) => item.fields.find((f) => f.id === id)?.value ?? "";
  return {
    vaultName: vault.title,
    async list() {
      const overviews = (await client.items.list(vault.id)).filter((i) => i.category === sdk.ItemCategory.Login);
      if (!overviews.length) return [];
      const full = await client.items.getAll(vault.id, overviews.map((i) => i.id));
      const out: SourceLogin[] = [];
      for (const r of full.individualResponses) {
        const item = r.content;
        if (!item) continue;
        const site = item.websites.map((w) => siteOf(w.url)).find((s): s is string => !!s);
        if (site) out.push({ id: item.id, title: item.title, site, username: field(item, "username") });
      }
      return out;
    },
    async secret(itemId) {
      const item = await client.items.get(vault.id, itemId);
      const otp = item.fields.find((f) => f.fieldType === sdk.ItemFieldType.Totp)?.details;
      const code = otp?.type === "Otp" ? otp.content.code : undefined;
      return { username: field(item, "username"), password: field(item, "password"), ...(code ? { otp: code } : {}) };
    },
  };
};

export class Logins {
  /** tests swap this for a fake password manager */
  open: LoginSourceOpener = openOnePassword;
  private sources = new Map<string, { token: string; source: Promise<LoginSource> }>();
  private lists = new Map<string, { at: number; logins: Promise<SourceLogin[]> }>();
  private passes = new Map<string, number>();

  constructor(private hub: Hub) {}

  /** What Settings → Logins shows: the connected manager (never its token). */
  status(workspaceId: string) {
    const c = this.connection(workspaceId);
    return c ? { kind: c.kind, label: LOGIN_SOURCE_LABEL[c.kind], vaultName: c.vaultName, connectedBy: c.connectedBy, connectedAt: c.connectedAt } : null;
  }

  /** Check the token works and remember it. */
  async connect(workspaceId: string, userId: string, kind: LoginSourceKind, token: string) {
    const source = await this.open(kind, token.trim());
    const logins = await source.list();
    const c: Connection = { kind, token: token.trim(), vaultName: source.vaultName, connectedBy: userId, connectedAt: new Date().toISOString() };
    this.hub.store.setSetting(workspaceId, SOURCE_KEY, JSON.stringify(c));
    this.sources.set(workspaceId, { token: c.token, source: Promise.resolve(source) });
    this.lists.set(workspaceId, { at: Date.now(), logins: Promise.resolve(logins) });
    return { ...this.status(workspaceId)!, count: logins.length };
  }

  disconnect(workspaceId: string) {
    this.hub.store.setSetting(workspaceId, SOURCE_KEY, null);
    this.hub.store.setSetting(workspaceId, ALWAYS_KEY, null);
    this.sources.delete(workspaceId);
    this.lists.delete(workspaceId);
  }

  /** The logins agents can use, with who may use each without asking. */
  async list(workspaceId: string, fresh = false): Promise<LoginSummary[]> {
    const always = this.always(workspaceId);
    return (await this.sourceLogins(workspaceId, fresh)).map((l) => ({ ...l, always: always[l.id] ?? [] }));
  }

  /** Stop letting an agent use a login without asking. */
  forget(workspaceId: string, itemId: string, agentId: string) {
    const always = this.always(workspaceId);
    always[itemId] = (always[itemId] ?? []).filter((a) => a !== agentId);
    if (!always[itemId].length) delete always[itemId];
    this.hub.store.setSetting(workspaceId, ALWAYS_KEY, JSON.stringify(always));
    for (const k of this.passes.keys()) if (k === `${agentId}:${itemId}`) this.passes.delete(k);
  }

  /**
   * An agent wants to sign in to `site` on its computer: fill it now if it may, else ask the
   * person who connected the password manager.
   */
  async request(agent: Agent, site: string, account: string | undefined, requestedBy: string | null): Promise<{ filled: LoginFillResult; login: LoginSummary } | { asked: string; login: LoginSummary }> {
    const c = this.connection(agent.workspaceId);
    if (!c) throw new LoginError("No password manager is connected (Settings → Logins). Use computer_ask_human so the person signs in themselves.", 412);
    this.computerOf(agent);
    const want = siteOf(site);
    if (!want) throw new LoginError(`"${site}" isn't a website address`);
    const all = await this.list(agent.workspaceId);
    let matches = all.filter((l) => siteMatches(want, l.site));
    if (account) matches = matches.filter((l) => l.username.toLowerCase() === account.trim().toLowerCase() || l.title.toLowerCase() === account.trim().toLowerCase());
    if (!matches.length) throw new LoginError(`There's no saved login for ${want}${account ? ` as ${account}` : ""}. Use computer_ask_human so the person signs in themselves.`, 404);
    if (matches.length > 1) throw new LoginError(`There are ${matches.length} logins for ${want}: ${matches.map((l) => l.username || l.title).join(", ")}. Call again with account set to one of them.`, 409);
    const login = matches[0];
    if (this.allowed(agent, login)) return { filled: await this.fill(agent, login), login };
    const where = this.hub.whereIs(agent.id);
    if (!where) throw new LoginError("nobody to ask: this workspace has no owner", 409);
    const ask: LoginRequest = { itemId: login.id, title: login.title, site: login.site, username: login.username, source: c.kind, ownerId: c.connectedBy, requestedBy };
    const approval = this.hub.store.createApproval({ workspaceId: agent.workspaceId, agentId: agent.id, ...where, summary: `Use your ${login.title} login`, details: "", login: ask });
    this.hub.postMessage({ ...where, author: { kind: "agent", id: agent.id }, body: `Can I use your ${login.title} login?`, parts: [{ type: "approval", approvalId: approval.id }], route: false });
    this.hub.broadcast(agent.workspaceId, { type: "approval", approval }, this.hub.audience(approval.channelId));
    return { asked: approval.id, login };
  }

  /**
   * The person answered: on yes, fill it right away (and remember "always"); either way the agent
   * hears about it where it asked. Returns the message for the agent.
   */
  async decide(a: Approval, approve: boolean, always: boolean): Promise<string> {
    const ask = a.login!;
    const agent = this.hub.store.agent(a.agentId);
    if (!approve || !agent) return `Not allowed: don't use the ${ask.title} login. If you still need to sign in, use computer_ask_human so the person does it.`;
    if (always) {
      const list = this.always(a.workspaceId);
      list[ask.itemId] = [...new Set([...(list[ask.itemId] ?? []), agent.id])];
      this.hub.store.setSetting(a.workspaceId, ALWAYS_KEY, JSON.stringify(list));
    }
    this.passes.set(`${agent.id}:${ask.itemId}`, Date.now() + PASS_MS);
    const login = (await this.list(a.workspaceId).catch(() => [])).find((l) => l.id === ask.itemId);
    if (!login) return `Allowed, but the ${ask.title} login is gone from the password manager now.`;
    try {
      return `Allowed. ${say(login, await this.fill(agent, login))}`;
    } catch (err) {
      const why = (err as Error).message.replace(/\.$/, "");
      // a problem with the page or computer can clear up; one with the setup (no VM, say) won't
      return err instanceof LoginError ? `Allowed, but ${why[0].toLowerCase()}${why.slice(1)}.` : `Allowed, but filling it didn't work: ${why}. Call login_fill again once its sign-in page is open.`;
    }
  }

  /** Read the secret now and put it in the page on the agent's computer. */
  async fill(agent: Agent, login: LoginSummary): Promise<LoginFillResult> {
    const comp = this.computerOf(agent);
    const secret = await (await this.source(agent.workspaceId)).secret(login.id);
    const result = (await this.hub.computers.act(comp, { action: "fill_login", site: login.site, username: secret.username, password: secret.password, ...(secret.otp ? { otp: secret.otp } : {}) }, { kind: "agent", id: agent.id })) as LoginFillResult;
    if (result.filled.length) this.hub.computers.log(comp, { kind: "agent", id: agent.id }, `Used the ${login.title} login`);
    return result;
  }

  /** What the agent hears after a fill, in a sentence. */
  say = say;

  private allowed(agent: Agent, login: LoginSummary) {
    if (login.always.includes(agent.id)) return true;
    const until = this.passes.get(`${agent.id}:${login.id}`);
    return !!until && until > Date.now();
  }

  private computerOf(agent: Agent) {
    const comp = agent.computerId ? this.hub.store.computer(agent.computerId) : null;
    if (!comp || comp.kind !== "vm") throw new LoginError("Logins are filled in the browser on your own VM, and you don't have one. Use computer_ask_human so the person signs in.", 409);
    return comp;
  }

  private connection(workspaceId: string): Connection | null {
    const raw = this.hub.store.setting(workspaceId, SOURCE_KEY);
    try {
      return raw ? (JSON.parse(raw) as Connection) : null;
    } catch {
      return null;
    }
  }

  private always(workspaceId: string): Record<string, string[]> {
    try {
      return JSON.parse(this.hub.store.setting(workspaceId, ALWAYS_KEY) ?? "{}");
    } catch {
      return {};
    }
  }

  private source(workspaceId: string): Promise<LoginSource> {
    const c = this.connection(workspaceId);
    if (!c) return Promise.reject(new LoginError("No password manager is connected (Settings → Logins).", 412));
    const cached = this.sources.get(workspaceId);
    if (cached && cached.token === c.token) return cached.source;
    const source = this.open(c.kind, c.token);
    this.sources.set(workspaceId, { token: c.token, source });
    source.catch(() => this.sources.delete(workspaceId));
    return source;
  }

  private async sourceLogins(workspaceId: string, fresh: boolean): Promise<SourceLogin[]> {
    if (!this.connection(workspaceId)) return [];
    const cached = this.lists.get(workspaceId);
    if (cached && !fresh && Date.now() - cached.at < LIST_TTL_MS) return cached.logins;
    const logins = this.source(workspaceId).then((s) => s.list());
    this.lists.set(workspaceId, { at: Date.now(), logins });
    logins.catch(() => this.lists.delete(workspaceId));
    return logins;
  }
}

function say(login: LoginSummary, r: LoginFillResult): string {
  if (r.wrongSite) return `Nothing was filled: the page open is on ${r.wrongSite}, not ${login.site}. Open ${login.site}'s sign-in page and call login_fill again.`;
  if (!r.filled.length) return `Nothing was filled: ${r.problem ?? "no sign-in boxes on the page"}. Open ${login.site}'s sign-in page and call login_fill again.`;
  const what = r.filled.length === 1 && r.filled[0] === "username" ? `filled the ${login.title} username${r.submitted ? " and went on" : ""}; if a password page comes next, call login_fill again` : `filled the ${login.title} login (${r.filled.join(", ")})${r.submitted ? " and pressed sign in" : ""}`;
  return `Wisp ${what}. Take a screenshot to check it worked.`;
}
