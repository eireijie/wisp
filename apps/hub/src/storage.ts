import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  STORAGE_SERVICES,
  baseName,
  folderFor,
  inFolder,
  storagePath,
  StoragePathError,
  type Agent,
  type Approval,
  type StorageConnection,
  type StorageEntry,
  type StorageFolder,
  type StorageRequest,
  type StorageService,
  type StorageSignIn,
} from "@wisp/core";
import { id, now } from "./auth.ts";
import { featureOn } from "./features.ts";
import type { Hub } from "./hub.ts";
import { DROPBOX, DriveProvider, DropboxProvider, GOOGLE, StorageError, WebdavProvider, mimeOf, type DropboxEndpoints, type GoogleEndpoints, type StorageProvider } from "./storage-providers.ts";

export { StorageError } from "./storage-providers.ts";

/**
 * The Storage mod: owners connect a file server or cloud drive, choose the folders agents may use
 * and which agents; agents list, read, search and copy files out freely inside those folders, and
 * ask before adding, replacing or deleting anything. Every call to the service is made here on
 * the hub, so passwords and tokens never reach an agent or a device.
 *
 * What Wisp keeps: an app password or a service's sign-in token, encrypted with a key that only
 * lives in the hub's data folder; or, for a login from the password manager, just which login
 * it is (read each time, never kept).
 */

type Row = {
  id: string;
  workspace_id: string;
  name: string;
  service: StorageService;
  kind: string;
  url: string | null;
  account: string;
  sign_in: StorageSignIn;
  login_item_id: string | null;
  secret_enc: string | null;
  folders_json: string;
  all_agents: number;
  always_json: string;
  problem: string | null;
  created_by: string;
  created_at: string;
};

/** What a connection's encrypted secret holds. */
type Secret = { password?: string; username?: string; accessToken?: string; refreshToken?: string; expiresAt?: number; clientId?: string; clientSecret?: string };

/** Your own Google or Dropbox app, kept per workspace so it's entered once. */
type OAuthApp = { clientId: string; clientSecret?: string };

/** files bigger than this aren't moved in one go */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** what storage_read hands an agent directly; bigger files go through Wisp files */
export const MAX_READ_BYTES = 5 * 1024 * 1024;
const PENDING_TTL = 15 * 60_000;

export class Storage {
  /** tests point these at stub servers */
  google: GoogleEndpoints = GOOGLE;
  dropbox: DropboxEndpoints = DROPBOX;
  private dataDir = "";
  private filesDir = "";
  private key: Buffer | null = null;
  /** sign-ins waiting on the person in the browser */
  private pending = new Map<string, { at: number } & ({ kind: "nextcloud"; workspaceId: string; userId: string; server: string; poll: string; token: string } | { kind: "oauth"; workspaceId: string; userId: string; service: "gdrive" | "dropbox"; verifier: string; redirect: string; app: OAuthApp })>();

  constructor(private hub: Hub) {}

  configure(opts: { dataDir: string; filesDir: string }) {
    this.dataDir = opts.dataDir;
    this.filesDir = opts.filesDir;
  }

  private get db() {
    return this.hub.store.db;
  }

  on(workspaceId: string) {
    return featureOn(this.hub.store, workspaceId, "storage");
  }

  // --- secrets ---------------------------------------------------------------------------------

  /** The key secrets are sealed with: made once, kept beside the database, readable only by the hub. */
  private secretKey(): Buffer {
    if (this.key) return this.key;
    if (!this.dataDir) throw new Error("storage isn't configured");
    const file = path.join(this.dataDir, "storage.key");
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    this.key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    return this.key;
  }

  seal(value: unknown): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.secretKey(), iv);
    const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
  }

  unseal<T>(sealed: string | null): T | null {
    if (!sealed?.startsWith("v1:")) return null;
    const raw = Buffer.from(sealed.slice(3), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", this.secretKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
  }

  // --- connections -----------------------------------------------------------------------------

  private row(connectionId: string) {
    return this.db.prepare("SELECT * FROM storage_connections WHERE id = ?").get(connectionId) as Row | undefined;
  }

  private view(r: Row): StorageConnection {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      service: r.service,
      kind: STORAGE_SERVICES[r.service]?.kind ?? "webdav",
      url: r.url,
      account: r.account,
      signIn: r.sign_in,
      loginItemId: r.login_item_id,
      folders: JSON.parse(r.folders_json),
      allAgents: !!r.all_agents,
      agentIds: (this.db.prepare("SELECT agent_id FROM storage_agents WHERE connection_id = ? ORDER BY agent_id").all(r.id) as { agent_id: string }[]).map((x) => x.agent_id),
      always: JSON.parse(r.always_json),
      problem: r.problem,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  list(workspaceId: string): StorageConnection[] {
    return (this.db.prepare("SELECT * FROM storage_connections WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as Row[]).map((r) => this.view(r));
  }

  get(connectionId: string): StorageConnection | undefined {
    const r = this.row(connectionId);
    return r && this.view(r);
  }

  private insert(c: { workspaceId: string; userId: string; name: string; service: StorageService; url: string | null; account: string; signIn: StorageSignIn; loginItemId?: string | null; secret?: Secret | null }): StorageConnection {
    const cid = id("stor");
    const name = this.freeName(c.workspaceId, c.name);
    this.db
      .prepare("INSERT INTO storage_connections (id, workspace_id, name, service, kind, url, account, sign_in, login_item_id, secret_enc, folders_json, all_agents, always_json, problem, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '[]', NULL, ?, ?)")
      .run(cid, c.workspaceId, name, c.service, STORAGE_SERVICES[c.service].kind, c.url, c.account, c.signIn, c.loginItemId ?? null, c.secret ? this.seal(c.secret) : null, c.userId, now());
    return this.get(cid)!;
  }

  private freeName(workspaceId: string, base: string) {
    const taken = new Set((this.db.prepare("SELECT lower(name) AS n FROM storage_connections WHERE workspace_id = ?").all(workspaceId) as { n: string }[]).map((r) => r.n));
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
    return name;
  }

  update(connectionId: string, patch: { name?: string; folders?: StorageFolder[]; allAgents?: boolean; agentIds?: string[] }): StorageConnection | undefined {
    const r = this.row(connectionId);
    if (!r) return undefined;
    const folders = patch.folders?.map((f) => ({ path: storagePath(f.path), access: f.access === "write" ? "write" : "read" }));
    // one entry per folder: the last one given wins
    const unique = folders && [...new Map(folders.map((f) => [f.path, f])).values()];
    // "Always" answers only hold for folders that still allow changes
    const always = (JSON.parse(r.always_json) as StorageConnection["always"]).filter((a) => (unique ?? JSON.parse(r.folders_json)).some((f: StorageFolder) => f.path === a.folder && f.access === "write"));
    this.db
      .prepare("UPDATE storage_connections SET name = ?, folders_json = ?, all_agents = ?, always_json = ? WHERE id = ?")
      .run(patch.name?.trim() || r.name, unique ? JSON.stringify(unique) : r.folders_json, patch.allAgents === undefined ? r.all_agents : patch.allAgents ? 1 : 0, JSON.stringify(always), connectionId);
    if (patch.agentIds) {
      const agents = patch.agentIds.filter((a) => this.hub.store.agent(a)?.workspaceId === r.workspace_id);
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM storage_agents WHERE connection_id = ?").run(connectionId);
        const ins = this.db.prepare("INSERT OR IGNORE INTO storage_agents (connection_id, agent_id) VALUES (?, ?)");
        for (const a of agents) ins.run(connectionId, a);
      })();
    }
    return this.get(connectionId);
  }

  remove(connectionId: string) {
    this.db.prepare("DELETE FROM storage_connections WHERE id = ?").run(connectionId);
  }

  /** Stop letting an agent change files in a folder without asking. */
  forgetAlways(connectionId: string, agentId: string, folder: string) {
    const r = this.row(connectionId);
    if (!r) return;
    const always = (JSON.parse(r.always_json) as StorageConnection["always"]).filter((a) => !(a.agentId === agentId && a.folder === folder));
    this.db.prepare("UPDATE storage_connections SET always_json = ? WHERE id = ?").run(JSON.stringify(always), connectionId);
  }

  private setProblem(connectionId: string, problem: string | null) {
    this.db.prepare("UPDATE storage_connections SET problem = ? WHERE id = ?").run(problem, connectionId);
  }

  // --- reaching the service --------------------------------------------------------------------

  private fetch: typeof fetch = (...a) => this.hub.fetchImpl(...a);

  /** A provider for a connection, signing in the way it was set up. */
  provider(r: Row): StorageProvider {
    const kind = STORAGE_SERVICES[r.service].kind;
    if (kind === "webdav") {
      return new WebdavProvider(r.url!, async () => {
        if (r.sign_in === "password-manager") return this.hub.logins.credentials(r.workspace_id, r.login_item_id!);
        const s = this.unseal<Secret>(r.secret_enc);
        if (!s?.password) throw new StorageError("This storage has no password saved. Connect it again from Settings → Storage.", 412);
        return { username: s.username ?? r.account, password: s.password };
      }, this.fetch);
    }
    const token = () => this.accessToken(r.id);
    return kind === "gdrive" ? new DriveProvider(token, this.fetch, this.google) : new DropboxProvider(token, this.fetch, this.dropbox);
  }

  /** A service's access token, refreshed when it's about to run out. */
  private async accessToken(connectionId: string): Promise<string> {
    const r = this.row(connectionId);
    const s = r && this.unseal<Secret>(r.secret_enc);
    if (!r || !s?.accessToken) throw new StorageError("This storage isn't signed in. Sign in again from Settings → Storage.", 412);
    if (!s.expiresAt || s.expiresAt - Date.now() > 60_000) return s.accessToken;
    if (!s.refreshToken || !s.clientId) throw new StorageError("The sign-in ran out. Sign in again from Settings → Storage.", 412);
    const tokens = await this.exchange(r.service as "gdrive" | "dropbox", { grant_type: "refresh_token", refresh_token: s.refreshToken }, { clientId: s.clientId, clientSecret: s.clientSecret });
    const next: Secret = { ...s, accessToken: tokens.access_token, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined, refreshToken: tokens.refresh_token ?? s.refreshToken };
    this.db.prepare("UPDATE storage_connections SET secret_enc = ? WHERE id = ?").run(this.seal(next), connectionId);
    return next.accessToken!;
  }

  /** Run something against the service, noting on the connection whether it worked. */
  private async use<T>(r: Row, fn: (p: StorageProvider) => Promise<T>): Promise<T> {
    try {
      const out = await fn(this.provider(r));
      if (r.problem) this.setProblem(r.id, null);
      return out;
    } catch (e) {
      const err = e instanceof StorageError ? e : new StorageError(`Couldn't reach ${r.name}: ${(e as Error).message}`, 502);
      // only problems with the connection itself show on its row; a missing file doesn't
      if (err.status === 412 || err.status === 502) this.setProblem(r.id, err.message);
      throw err;
    }
  }

  // --- connecting ------------------------------------------------------------------------------

  /** A WebDAV server signed in with an app password or a login from the password manager; checked before it's saved. */
  async connectWebdav(workspaceId: string, userId: string, c: { service: "nextcloud" | "truenas" | "webdav"; url: string; name?: string; username?: string; password?: string; loginItemId?: string }): Promise<StorageConnection> {
    const url = webdavUrl(c.url);
    let username = c.username?.trim() ?? "";
    let secret: Secret | null = null;
    let signIn: StorageSignIn;
    if (c.loginItemId) {
      signIn = "password-manager";
      if (!this.hub.logins.status(workspaceId)) throw new StorageError("No password manager is connected. Connect one in Settings → Logins, or use an app password.", 412);
      username = (await this.hub.logins.credentials(workspaceId, c.loginItemId)).username;
    } else {
      if (!c.password) throw new StorageError("Give an app password, or pick a login from your password manager.");
      if (!username) throw new StorageError("Give the user name to sign in as.");
      signIn = "app-password";
      secret = { username, password: c.password };
    }
    // Nextcloud's files live under /remote.php/dav/files/<user>/; an address of just the server means that
    const base = c.service === "nextcloud" && !/\/remote\.php\//.test(new URL(url).pathname) ? `${url.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(username)}/` : url;
    const probe = { id: "", workspace_id: workspaceId, name: "", service: c.service, kind: "webdav", url: base, account: username, sign_in: signIn, login_item_id: c.loginItemId ?? null, secret_enc: secret ? this.seal(secret) : null, folders_json: "[]", all_agents: 0, always_json: "[]", problem: null, created_by: userId, created_at: "" } as Row;
    const root = await this.provider(probe).stat("/").catch((e: Error) => {
      throw e instanceof StorageError ? e : new StorageError(`Couldn't reach ${new URL(base).host}: ${e.message}`, 502);
    });
    if (!root || root.type !== "folder") throw new StorageError(`${base} isn't a WebDAV folder. Check the address.`, 400);
    // "Other server" says nothing about which one; its address does
    const name = c.name?.trim() || (c.service === "webdav" ? new URL(base).hostname : STORAGE_SERVICES[c.service].name);
    return this.insert({ workspaceId, userId, name, service: c.service, url: base, account: username, signIn, loginItemId: c.loginItemId ?? null, secret });
  }

  /**
   * Nextcloud's own sign-in (Login Flow v2): the person approves Wisp in their browser and
   * Nextcloud hands back an app password just for Wisp, which they can revoke there.
   */
  async nextcloudStart(workspaceId: string, userId: string, server: string): Promise<{ pendingId: string; loginUrl: string }> {
    const base = webdavUrl(server).replace(/\/+$/, "");
    const res = await this.fetch(`${base}/index.php/login/v2`, { method: "POST", headers: { "user-agent": "Wisp" }, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
      throw new StorageError(`Couldn't reach ${new URL(base).host}: ${e.message}`, 502);
    });
    if (!res.ok) throw new StorageError(`${new URL(base).host} didn't start a Nextcloud sign-in (${res.status}). Is it a Nextcloud server?`, 502);
    const flow = (await res.json()) as { poll?: { token: string; endpoint: string }; login?: string };
    if (!flow.poll?.token || !flow.poll.endpoint || !flow.login) throw new StorageError(`${new URL(base).host} didn't start a Nextcloud sign-in.`, 502);
    // the poll address must be on the same server the person typed in
    if (new URL(flow.poll.endpoint).origin !== new URL(base).origin || new URL(flow.login).origin !== new URL(base).origin) throw new StorageError("That server sent a sign-in for a different address.", 502);
    const pendingId = crypto.randomBytes(16).toString("hex");
    this.sweep();
    this.pending.set(pendingId, { at: Date.now(), kind: "nextcloud", workspaceId, userId, server: base, poll: flow.poll.endpoint, token: flow.poll.token });
    return { pendingId, loginUrl: flow.login };
  }

  /** Ask Nextcloud whether the person approved yet; on yes, the connection is made. */
  async nextcloudPoll(workspaceId: string, pendingId: string): Promise<StorageConnection | null> {
    const p = this.pending.get(pendingId);
    if (!p || p.kind !== "nextcloud" || p.workspaceId !== workspaceId) throw new StorageError("That sign-in ran out. Start again.", 410);
    const res = await this.fetch(p.poll, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: p.token }).toString(), signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`Nextcloud answered ${res.status} while signing in.`, 502);
    const got = (await res.json()) as { server: string; loginName: string; appPassword: string };
    this.pending.delete(pendingId);
    return this.connectWebdav(workspaceId, p.userId, { service: "nextcloud", url: p.server, username: got.loginName, password: got.appPassword });
  }

  /** The Google or Dropbox app this workspace signs in through (never its secret). */
  oauthApps(workspaceId: string): Partial<Record<"gdrive" | "dropbox", { clientId: string }>> {
    const out: Partial<Record<"gdrive" | "dropbox", { clientId: string }>> = {};
    for (const s of ["gdrive", "dropbox"] as const) {
      const app = this.oauthApp(workspaceId, s);
      if (app) out[s] = { clientId: app.clientId };
    }
    return out;
  }

  private oauthApp(workspaceId: string, service: "gdrive" | "dropbox"): OAuthApp | null {
    return this.unseal<OAuthApp>(this.hub.store.setting(workspaceId, `storage.app.${service}`));
  }

  /** Start signing in to Drive or Dropbox; returns the page to send the person to. */
  oauthStart(workspaceId: string, userId: string, service: "gdrive" | "dropbox", origin: string, app?: { clientId?: string; clientSecret?: string }): { url: string } {
    const saved = this.oauthApp(workspaceId, service);
    const clientId = app?.clientId?.trim() || saved?.clientId;
    if (!clientId) throw new StorageError(service === "gdrive" ? "Give your Google app's client ID and secret." : "Give your Dropbox app's key.");
    const clientSecret = app?.clientSecret?.trim() || (clientId === saved?.clientId ? saved?.clientSecret : undefined);
    if (service === "gdrive" && !clientSecret) throw new StorageError("Google needs the app's client secret too.");
    const use: OAuthApp = { clientId, ...(clientSecret ? { clientSecret } : {}) };
    this.hub.store.setSetting(workspaceId, `storage.app.${service}`, this.seal(use));
    const verifier = crypto.randomBytes(32).toString("base64url");
    const state = crypto.randomBytes(16).toString("hex");
    const redirect = `${new URL(origin).origin}${STORAGE_CALLBACK}`;
    this.sweep();
    this.pending.set(state, { at: Date.now(), kind: "oauth", workspaceId, userId, service, verifier, redirect, app: use });
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256" });
    if (service === "gdrive") {
      params.set("scope", "https://www.googleapis.com/auth/drive");
      params.set("access_type", "offline");
      params.set("prompt", "consent");
      return { url: `${this.google.auth}?${params}` };
    }
    params.set("token_access_type", "offline");
    return { url: `${this.dropbox.auth}?${params}` };
  }

  /** The service sent the person back with a code: swap it for tokens and save the connection. */
  async oauthFinish(state: string, code: string): Promise<StorageConnection> {
    const p = this.pending.get(state);
    if (!p || p.kind !== "oauth") throw new StorageError("That sign-in ran out. Start again from Settings → Storage.", 410);
    this.pending.delete(state);
    const t = await this.exchange(p.service, { grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier }, p.app);
    const secret: Secret = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, clientId: p.app.clientId, clientSecret: p.app.clientSecret };
    const account = await this.whoAmI(p.service, t.access_token).catch(() => "");
    return this.insert({ workspaceId: p.workspaceId, userId: p.userId, name: STORAGE_SERVICES[p.service].name, service: p.service, url: null, account, signIn: "oauth", secret });
  }

  private async exchange(service: "gdrive" | "dropbox", form: Record<string, string>, app: OAuthApp): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const body = new URLSearchParams({ ...form, client_id: app.clientId, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}) });
    const res = await this.fetch(service === "gdrive" ? this.google.token : this.dropbox.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new StorageError(`${STORAGE_SERVICES[service].name} didn't sign Wisp in: ${json.error_description ?? json.error ?? res.status}`, 502);
    return json as { access_token: string };
  }

  private async whoAmI(service: "gdrive" | "dropbox", token: string): Promise<string> {
    if (service === "gdrive") {
      const r = (await (await this.fetch(`${this.google.api}/about?fields=user`, { headers: { authorization: `Bearer ${token}` } })).json()) as { user?: { emailAddress?: string; displayName?: string } };
      return r.user?.emailAddress ?? r.user?.displayName ?? "";
    }
    const r = (await (await this.fetch(`${this.dropbox.api}/users/get_current_account`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()) as { email?: string; name?: { display_name?: string } };
    return r.email ?? r.name?.display_name ?? "";
  }

  private sweep() {
    for (const [k, v] of this.pending) if (Date.now() - v.at > PENDING_TTL) this.pending.delete(k);
  }

  // --- what people browse ----------------------------------------------------------------------

  /** A folder's contents, for picking folders in Settings (owners only, so any folder). */
  async browse(connectionId: string, folder: string): Promise<StorageEntry[]> {
    const r = this.row(connectionId);
    if (!r) throw new StorageError("No such storage.", 404);
    let p: string;
    try {
      p = storagePath(folder);
    } catch (e) {
      throw new StorageError((e as Error).message, 400);
    }
    return (await this.use(r, (pr) => pr.list(p))).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  }

  // --- agents ----------------------------------------------------------------------------------

  /** The connections an agent may use (none while the mod is off). */
  forAgent(agent: Agent): StorageConnection[] {
    if (!this.on(agent.workspaceId)) return [];
    const rows = this.db
      .prepare("SELECT * FROM storage_connections WHERE workspace_id = ? AND (all_agents = 1 OR id IN (SELECT connection_id FROM storage_agents WHERE agent_id = ?)) ORDER BY created_at")
      .all(agent.workspaceId, agent.id) as Row[];
    return rows.map((r) => this.view(r)).filter((c) => c.folders.length > 0);
  }

  /** Find one of the agent's connections by id or name. */
  private mine(agent: Agent, ref: string): Row {
    const c = this.forAgent(agent).find((x) => x.id === ref || x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!c) {
      const names = this.forAgent(agent).map((x) => x.name);
      throw new StorageError(names.length ? `You have no storage called "${ref}". You have: ${names.join(", ")}.` : "You don't have any storage. A person adds it in Settings → Storage.", 404);
    }
    return this.row(c.id)!;
  }

  /**
   * Check a path the agent gave against the connection's folders. Paths are cleaned first, so
   * nothing like "/Allowed/../Other" gets through, and a folder only covers what's inside it.
   */
  private allowed(r: Row, rawPath: string, need: "read" | "write"): { path: string; folder: StorageFolder } {
    let p: string;
    try {
      p = storagePath(rawPath);
    } catch (e) {
      throw new StorageError((e as StoragePathError).message, 400);
    }
    const folders = JSON.parse(r.folders_json) as StorageFolder[];
    const folder = folderFor(p, folders);
    if (!folder) throw new StorageError(`${p} is outside the folders you can use on ${r.name}: ${folders.map((f) => f.path).join(", ")}.`, 403);
    if (need === "write" && folder.access !== "write") throw new StorageError(`${folder.path} on ${r.name} is read only for agents. Ask the person to allow changes there in Settings → Storage.`, 403);
    return { path: p, folder };
  }

  /** Paths a listing or search may show: only what's inside the allowed folders. */
  private visible(r: Row, entries: StorageEntry[]): StorageEntry[] {
    const folders = JSON.parse(r.folders_json) as StorageFolder[];
    return entries.filter((e) => {
      try {
        return !!folderFor(storagePath(e.path), folders);
      } catch {
        return false;
      }
    });
  }

  async agentList(agent: Agent, ref: string, rawPath?: string): Promise<{ connection: string; path: string; entries: StorageEntry[] } | { connection: string; folders: StorageFolder[] }> {
    const r = this.mine(agent, ref);
    if (!rawPath || rawPath === "") return { connection: r.name, folders: JSON.parse(r.folders_json) };
    const { path: p } = this.allowed(r, rawPath, "read");
    return { connection: r.name, path: p, entries: this.visible(r, await this.use(r, (pr) => pr.list(p))) };
  }

  async agentRead(agent: Agent, ref: string, rawPath: string) {
    const r = this.mine(agent, ref);
    const { path: p } = this.allowed(r, rawPath, "read");
    return this.use(r, (pr) => pr.read(p, MAX_READ_BYTES));
  }

  async agentSearch(agent: Agent, ref: string, query: string, rawPath?: string): Promise<StorageEntry[]> {
    const r = this.mine(agent, ref);
    const folders = JSON.parse(r.folders_json) as StorageFolder[];
    const under = rawPath ? [this.allowed(r, rawPath, "read").path] : folders.map((f) => f.path);
    return this.visible(r, await this.use(r, (pr) => pr.search(query.trim(), under)));
  }

  /** Copy a file from the storage into Wisp, so it can be attached, viewed or downloaded. */
  async agentToWisp(agent: Agent, ref: string, rawPath: string, channelId: string | null) {
    const r = this.mine(agent, ref);
    const { path: p } = this.allowed(r, rawPath, "read");
    const f = await this.use(r, (pr) => pr.read(p, MAX_FILE_BYTES));
    return this.saveToWisp(agent, f.name, f.mime, f.data, channelId);
  }

  private async saveToWisp(agent: Agent, name: string, mime: string, data: Buffer, channelId: string | null) {
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    const dest = path.join(this.filesDir, sha.slice(0, 2), sha);
    if (!fs.existsSync(dest)) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
    }
    return this.hub.store.insertFile({ workspaceId: agent.workspaceId, sha256: sha, name, mime, size: data.length, uploader: { kind: "agent", id: agent.id }, channelId });
  }

  /**
   * An agent wants to put a Wisp file on the storage, make a folder or delete something: do it
   * now if a person already said "Always in this folder" (never for deleting), else ask.
   */
  async agentChange(agent: Agent, ref: string, action: "put" | "delete" | "mkdir", rawPath: string, fileId: string | null, requestedBy: string | null): Promise<{ done: string } | { asked: string; summary: string }> {
    const r = this.mine(agent, ref);
    const { path: p, folder } = this.allowed(r, rawPath, "write");
    if (p === folder.path && action === "delete") throw new StorageError(`${p} is a whole allowed folder; agents can't delete it. Delete what's inside instead.`, 403);
    let file: ReturnType<Hub["store"]["file"]> | undefined;
    if (action === "put") {
      file = fileId ? this.hub.store.file(fileId) : undefined;
      if (!file || file.workspaceId !== agent.workspaceId) throw new StorageError("No such Wisp file. Upload it with file_upload first.", 404);
      if (file.size > MAX_FILE_BYTES) throw new StorageError(`That file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 413);
    }
    const there = await this.use(r, (pr) => pr.stat(p));
    if (action === "delete" && !there) throw new StorageError(`There's nothing at ${p}.`, 404);
    if (action === "mkdir" && there) return { done: `${p} is already there.` };
    if (action === "put" && there?.type === "folder") throw new StorageError(`${p} is a folder; give the file's own path, like ${p}/${file!.name}.`, 409);
    const kind: StorageRequest["action"] = action === "delete" ? "delete" : action === "mkdir" ? "mkdir" : there ? "replace" : "upload";
    const req: StorageRequest = { connectionId: r.id, connectionName: r.name, service: r.service, action: kind, path: p, fileId: file?.id ?? null, size: file?.size ?? null, folder: folder.path, requestedBy };
    const always = (JSON.parse(r.always_json) as StorageConnection["always"]).some((a) => a.agentId === agent.id && a.folder === folder.path);
    if (always && kind !== "delete") return { done: await this.perform(req) };
    const where = this.hub.whereIs(agent.id);
    if (!where) throw new StorageError("nobody to ask: this workspace has no owner", 409);
    const summary = describe(req);
    const approval = this.hub.store.createApproval({ workspaceId: agent.workspaceId, agentId: agent.id, ...where, summary, details: "", storage: req });
    this.hub.postMessage({ ...where, author: { kind: "agent", id: agent.id }, body: `Can I ${summary[0].toLowerCase()}${summary.slice(1)}?`, parts: [{ type: "approval", approvalId: approval.id }], route: false });
    this.hub.broadcast(agent.workspaceId, { type: "approval", approval }, this.hub.audience(approval.channelId));
    return { asked: approval.id, summary };
  }

  /** Do what was asked, checking the folder rules again (they may have changed since). */
  private async perform(req: StorageRequest): Promise<string> {
    const r = this.row(req.connectionId);
    if (!r) throw new StorageError(`${req.connectionName} isn't connected any more.`, 410);
    this.allowed(r, req.path, "write");
    if (req.action === "delete") {
      await this.use(r, (pr) => pr.remove(req.path));
      return `Deleted ${req.path} on ${r.name}.`;
    }
    if (req.action === "mkdir") {
      await this.use(r, (pr) => pr.mkdir(req.path));
      return `Made the folder ${req.path} on ${r.name}.`;
    }
    const f = req.fileId ? this.hub.store.file(req.fileId) : undefined;
    if (!f) throw new StorageError("The Wisp file is gone.", 410);
    const data = await fsp.readFile(path.join(this.filesDir, f.sha256.slice(0, 2), f.sha256));
    await this.use(r, (pr) => pr.write(req.path, data, f.mime || mimeOf(req.path)));
    return `${req.action === "replace" ? "Replaced" : "Saved"} ${req.path} on ${r.name}.`;
  }

  /** A person answered: on yes, do it now (remembering "Always in this folder"). Returns what the agent hears. */
  async decide(a: Approval, approve: boolean, always: boolean): Promise<string> {
    const req = a.storage!;
    if (!approve) return `Not allowed: don't ${describe(req)[0].toLowerCase()}${describe(req).slice(1)}.`;
    if (always && req.action !== "delete") {
      const r = this.row(req.connectionId);
      if (r) {
        const list = (JSON.parse(r.always_json) as StorageConnection["always"]).filter((x) => !(x.agentId === a.agentId && x.folder === req.folder));
        list.push({ agentId: a.agentId, folder: req.folder });
        this.db.prepare("UPDATE storage_connections SET always_json = ? WHERE id = ?").run(JSON.stringify(list), r.id);
      }
    }
    try {
      return `Allowed. ${await this.perform(req)}`;
    } catch (e) {
      return `Allowed, but it didn't work: ${(e as Error).message}`;
    }
  }

  /** What an agent with storage is told, for its prompt ("" when it has none). */
  promptSection(agent: Agent): string {
    const conns = this.forAgent(agent);
    if (!conns.length) return "";
    const line = (c: StorageConnection) => `- ${c.name} (${STORAGE_SERVICES[c.service].name}): ${c.folders.map((f) => `${f.path}${f.access === "write" ? " (read and change)" : " (read only)"}`).join(", ")}`;
    return [
      `## Your storage`,
      `You can use files on these, only inside the folders listed. Use storage_list, storage_read, storage_search and storage_download freely there. storage_upload, storage_mkdir and storage_delete ask a person first; after one, end your turn and you'll get a message with the answer.`,
      ...conns.map(line),
    ].join("\n");
  }
}

export const STORAGE_CALLBACK = "/api/storage/oauth/callback";

/** One line for the approval card, like "Upload report.pdf to Home Nextcloud › /Clients". */
export function describe(req: StorageRequest): string {
  const where = `${req.connectionName} › ${req.path.slice(0, req.path.lastIndexOf("/")) || "/"}`;
  const name = baseName(req.path);
  if (req.action === "delete") return `Delete ${name} from ${where}`;
  if (req.action === "mkdir") return `Make the folder ${name} in ${where}`;
  return `${req.action === "replace" ? "Replace" : "Upload"} ${name} ${req.action === "replace" ? "in" : "to"} ${where}`;
}

/** A server address people typed: https unless they said otherwise, and nothing that isn't http(s). */
export function webdavUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new StorageError(`"${raw}" isn't a server address.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new StorageError("Use an http:// or https:// address.");
  if (u.username || u.password) throw new StorageError("Leave the user name and password out of the address.");
  u.hash = "";
  u.search = "";
  return u.toString();
}

export { inFolder };
