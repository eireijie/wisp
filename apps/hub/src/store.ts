import { channelTeams, chartFromSteps, cleanRulePath, hasSteps, isGraphTeam, migrateTeam, parseSubjectKey, subjectKey, teamOf, type AccessRule, type Actor, type Agent, type AgentSettings, type Approval, type Channel, type ChannelNotify, type ChannelSettings, DEFAULT_CHANNEL_SETTINGS, type Computer, type ComputerConfig, type ComputerKind, type ComputerStatus, type ContextUsage, type DeviceCapabilities, type Discussion, type DiscoveredAgent, type HarnessCatalog, type Team, type HarnessId, type MemoryLevel, type Message, type MessagePart, type Reaction, type Role, type Routine, type Section, type Subject, type User, type UserPrefs, type DeviceRole, type OwnRemoteDesktop, type BackgroundWork, type Followup, type Change, type ChatLoop, conversationFor } from "@wisp/core";
import { id, now } from "./auth.ts";
import type { Db } from "./db.ts";

/** Runs nobody wrote a message for: a background check, or a memory pass after recent work. Both count against the background allowance. */
export type RunKind = "background" | "memory";

export interface PushPrefs {
  dms?: boolean;
  replies?: boolean;
  approvals?: boolean;
  help?: boolean;
  tasks?: boolean;
}

/** Typed data access. Keeps SQL in one place. */
export class Store {
  constructor(readonly db: Db) {}

  // --- users & workspaces -------------------------------------------------

  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  createUser(email: string, name: string, passwordHash: string) {
    const u = { id: id("usr"), email: email.toLowerCase(), name, createdAt: now() };
    this.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, u.name, passwordHash, u.createdAt);
    this.setPrefs(u.id, { experience: "simple" });
    return u;
  }

  userByEmail(email: string) {
    return this.db.prepare("SELECT id, email, name, password_hash, created_at FROM users WHERE email = ?").get(email.toLowerCase()) as
      | { id: string; email: string; name: string; password_hash: string; created_at: string }
      | undefined;
  }

  user(userId: string): User | undefined {
    const r = this.db.prepare("SELECT id, email, name, preferred_name, timezone, created_at FROM users WHERE id = ?").get(userId) as
      | { id: string; email: string; name: string; preferred_name: string | null; timezone: string | null; created_at: string }
      | undefined;
    return r && { id: r.id, email: r.email, name: r.name, preferredName: r.preferred_name, timezone: r.timezone, createdAt: r.created_at };
  }

  updateUser(userId: string, patch: Partial<{ name: string; email: string; preferredName: string | null; timezone: string | null; passwordHash: string }>) {
    const cols: [string, unknown][] = [];
    if (patch.name !== undefined) cols.push(["name", patch.name]);
    if (patch.email !== undefined) cols.push(["email", patch.email.toLowerCase()]);
    if (patch.preferredName !== undefined) cols.push(["preferred_name", patch.preferredName]);
    if (patch.timezone !== undefined) cols.push(["timezone", patch.timezone]);
    if (patch.passwordHash !== undefined) cols.push(["password_hash", patch.passwordHash]);
    if (cols.length) this.db.prepare(`UPDATE users SET ${cols.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(([, v]) => v), userId);
    return this.user(userId);
  }

  passwordHash(userId: string): string | null {
    return (this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined)?.password_hash ?? null;
  }

  prefs(userId: string): UserPrefs {
    const r = this.db.prepare("SELECT prefs_json FROM users WHERE id = ?").get(userId) as { prefs_json: string } | undefined;
    return r ? JSON.parse(r.prefs_json) : {};
  }

  setPrefs(userId: string, prefs: UserPrefs) {
    this.db.prepare("UPDATE users SET prefs_json = ? WHERE id = ?").run(JSON.stringify(prefs), userId);
    return prefs;
  }

  /** A person's sign-ins: one per browser or app they signed in from. `id` is a short, stable handle on the token. */
  sessions(userId: string) {
    return (
      this.db.prepare("SELECT hash, label, created_at, last_used FROM tokens WHERE kind = 'session' AND subject_id = ? ORDER BY COALESCE(last_used, created_at) DESC").all(userId) as {
        hash: string;
        label: string;
        created_at: string;
        last_used: string | null;
      }[]
    ).map((r) => ({ id: r.hash.slice(0, 16), hash: r.hash, label: r.label, createdAt: r.created_at, lastUsed: r.last_used }));
  }

  /** Remove tokens of `kind` whose hash starts with `idPrefix` (16 hex chars); only when exactly one matches. */
  revokeTokenById(kind: string, idPrefix: string, where: { subjectId?: string } = {}): boolean {
    if (!/^[0-9a-f]{16}$/.test(idPrefix)) return false;
    const rows = this.db.prepare("SELECT hash, subject_id FROM tokens WHERE kind = ? AND hash LIKE ?").all(kind, `${idPrefix}%`) as { hash: string; subject_id: string }[];
    if (rows.length !== 1 || (where.subjectId && rows[0].subject_id !== where.subjectId)) return false;
    this.db.prepare("DELETE FROM tokens WHERE hash = ?").run(rows[0].hash);
    return true;
  }

  // --- invites ----------------------------------------------------------------

  createInvite(i: { workspaceId: string; codeHash: string; role: Role; createdBy: string; expiresAt: string }) {
    const inviteId = id("inv");
    this.db
      .prepare("INSERT INTO invites (id, workspace_id, code_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(inviteId, i.workspaceId, i.codeHash, i.role, i.createdBy, now(), i.expiresAt);
    return this.invite(inviteId)!;
  }

  invite(inviteId: string) {
    return this.db
      .prepare("SELECT id, workspace_id AS workspaceId, role, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, used_by AS usedBy, used_at AS usedAt, revoked FROM invites WHERE id = ?")
      .get(inviteId) as Invite | undefined;
  }

  inviteByCode(codeHash: string) {
    const r = this.db.prepare("SELECT id FROM invites WHERE code_hash = ?").get(codeHash) as { id: string } | undefined;
    return r ? this.invite(r.id) : undefined;
  }

  /** Invites nobody used yet that haven't expired or been revoked. */
  openInvites(workspaceId: string) {
    return this.db
      .prepare(
        "SELECT id, workspace_id AS workspaceId, role, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, used_by AS usedBy, used_at AS usedAt, revoked FROM invites WHERE workspace_id = ? AND used_by IS NULL AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC",
      )
      .all(workspaceId, now()) as Invite[];
  }

  useInvite(inviteId: string, userId: string) {
    return this.db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL AND revoked = 0").run(userId, now(), inviteId).changes === 1;
  }

  revokeInvite(inviteId: string) {
    this.db.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").run(inviteId);
  }

  createWorkspace(name: string) {
    const w = { id: id("ws"), name, createdAt: now() };
    this.db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(w.id, w.name, w.createdAt);
    // a new organization has no agents from before the shared computer to move onto it (shared-computer.ts)
    this.setSetting(w.id, "computers.sharedAdopted", "true");
    return w;
  }

  workspace(wsId: string) {
    return this.db.prepare("SELECT id, name, created_at AS createdAt FROM workspaces WHERE id = ?").get(wsId) as { id: string; name: string; createdAt: string } | undefined;
  }

  /** Delete an organization; nearly everything in it goes with it (ON DELETE CASCADE). */
  deleteWorkspace(wsId: string) {
    this.db.transaction(() => {
      const people = this.db.prepare("SELECT user_id AS id FROM memberships WHERE workspace_id = ?").all(wsId) as { id: string }[];
      // these aren't tied to the organization by a foreign key
      this.db.prepare("DELETE FROM tokens WHERE workspace_id = ?").run(wsId);
      this.db.prepare("DELETE FROM vault_tokens WHERE workspace_id = ?").run(wsId);
      this.db.prepare("DELETE FROM oauth_grants WHERE workspace_id = ?").run(wsId);
      this.db.prepare("DELETE FROM changes WHERE workspace_id = ?").run(wsId);
      this.db.prepare("DELETE FROM push_devices WHERE workspace_id = ?").run(wsId);
      // team requests: their table is made by TeamFlows, so it may not be there
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_flows'").get()) this.db.prepare("DELETE FROM team_flows WHERE workspace_id = ?").run(wsId);
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(wsId);
      // an account that belonged only here would have nowhere to sign in to: it goes too, as in removeMember
      for (const p of people) if (!this.db.prepare("SELECT 1 FROM memberships WHERE user_id = ? LIMIT 1").get(p.id)) this.db.prepare("DELETE FROM users WHERE id = ?").run(p.id);
    })();
  }

  firstWorkspace() {
    return this.db.prepare("SELECT id, name, created_at AS createdAt FROM workspaces ORDER BY created_at LIMIT 1").get() as
      | { id: string; name: string; createdAt: string }
      | undefined;
  }

  addMember(workspaceId: string, userId: string, role: Role) {
    this.db.prepare("INSERT OR REPLACE INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)").run(workspaceId, userId, role);
  }

  /** Take someone out of a workspace: their sign-ins end, and an account in no other workspace is deleted. */
  removeMember(workspaceId: string, userId: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
      this.db.prepare("DELETE FROM channel_members WHERE member_kind = 'user' AND member_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").run(userId, workspaceId);
      this.db.prepare("DELETE FROM tokens WHERE kind = 'session' AND subject_id = ? AND workspace_id = ?").run(userId, workspaceId);
      const elsewhere = this.db.prepare("SELECT 1 FROM memberships WHERE user_id = ? LIMIT 1").get(userId);
      if (!elsewhere) this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    })();
  }

  role(workspaceId: string, userId: string): Role | null {
    const r = this.db.prepare("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId) as { role: Role } | undefined;
    return r?.role ?? null;
  }

  members(workspaceId: string) {
    return this.db
      .prepare("SELECT u.id, u.email, u.name, u.preferred_name AS preferredName, u.timezone, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name")
      .all(workspaceId) as { id: string; email: string; name: string; preferredName: string | null; timezone: string | null; role: Role }[];
  }

  renameWorkspace(workspaceId: string, name: string) {
    this.db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, workspaceId);
  }

  // --- nodes ----------------------------------------------------------------

  createNode(workspaceId: string, name: string, ownerId: string) {
    const n = { id: id("node"), workspaceId, name, ownerId, shared: false, createdAt: now() };
    this.db.prepare("INSERT INTO nodes (id, workspace_id, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)").run(n.id, workspaceId, name, ownerId, n.createdAt);
    return n;
  }

  nodes(workspaceId: string) {
    return (
      this.db.prepare("SELECT id, name, owner_id AS ownerId, shared, role, last_seen AS lastSeen, created_at AS createdAt FROM nodes WHERE workspace_id = ? ORDER BY name").all(workspaceId) as {
        id: string;
        name: string;
        ownerId: string | null;
        shared: number;
        role: DeviceRole | null;
        lastSeen: string | null;
        createdAt: string;
      }[]
    ).map((n) => ({ ...n, shared: !!n.shared }));
  }

  /** A device: `ownerId` is the person who connected it; `shared` lets others in the workspace put agents and VMs on it. */
  node(nodeId: string) {
    const r = this.db.prepare("SELECT id, workspace_id AS workspaceId, name, owner_id AS ownerId, shared, role FROM nodes WHERE id = ?").get(nodeId) as
      | { id: string; workspaceId: string; name: string; ownerId: string | null; shared: number; role: DeviceRole | null }
      | undefined;
    return r && { ...r, shared: !!r.shared };
  }

  /** Who the device belongs to; null once its owner left the workspace. */
  setNodeOwner(nodeId: string, ownerId: string | null) {
    this.db.prepare("UPDATE nodes SET owner_id = ? WHERE id = ?").run(ownerId, nodeId);
  }

  setNodeShared(nodeId: string, shared: boolean) {
    this.db.prepare("UPDATE nodes SET shared = ? WHERE id = ?").run(shared ? 1 : 0, nodeId);
  }

  /** The remote desktop app the device's owner already uses, or null. */
  nodeRemoteDesktop(nodeId: string): OwnRemoteDesktop | null {
    const r = this.db.prepare("SELECT remote_desktop_json FROM nodes WHERE id = ?").get(nodeId) as { remote_desktop_json: string | null } | undefined;
    return r?.remote_desktop_json ? JSON.parse(r.remote_desktop_json) : null;
  }

  setNodeRemoteDesktop(nodeId: string, remote: OwnRemoteDesktop | null) {
    this.db.prepare("UPDATE nodes SET remote_desktop_json = ? WHERE id = ?").run(remote ? JSON.stringify(remote) : null, nodeId);
  }

  setNodeRole(nodeId: string, role: DeviceRole | null) {
    this.db.prepare("UPDATE nodes SET role = ? WHERE id = ?").run(role, nodeId);
  }

  setNodeCatalog(nodeId: string, catalog: HarnessCatalog[]) {
    this.db.prepare("UPDATE nodes SET catalog_json = ? WHERE id = ?").run(JSON.stringify(catalog), nodeId);
  }

  /** What a VM on a device has installed (each harness and its models), as the device reported it. */
  setComputerCatalog(nodeId: string, computerId: string, catalog: HarnessCatalog[]) {
    this.db.prepare("INSERT INTO computer_catalogs (node_id, computer_id, catalog_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (node_id, computer_id) DO UPDATE SET catalog_json = excluded.catalog_json, updated_at = excluded.updated_at").run(nodeId, computerId, JSON.stringify(catalog), new Date().toISOString());
  }

  /** A VM's catalog, or null when its device hasn't reported one yet. */
  computerCatalog(nodeId: string, computerId: string): HarnessCatalog[] | null {
    const r = this.db.prepare("SELECT catalog_json FROM computer_catalogs WHERE node_id = ? AND computer_id = ?").get(nodeId, computerId) as { catalog_json: string } | undefined;
    return r ? JSON.parse(r.catalog_json) : null;
  }

  nodeCatalog(nodeId: string): HarnessCatalog[] {
    const r = this.db.prepare("SELECT catalog_json FROM nodes WHERE id = ?").get(nodeId) as { catalog_json: string } | undefined;
    return r ? JSON.parse(r.catalog_json) : [];
  }

  setNodeCapabilities(nodeId: string, caps: DeviceCapabilities) {
    this.db.prepare("UPDATE nodes SET capabilities_json = ? WHERE id = ?").run(JSON.stringify(caps), nodeId);
  }

  nodeCapabilities(nodeId: string): DeviceCapabilities | null {
    const r = this.db.prepare("SELECT capabilities_json FROM nodes WHERE id = ?").get(nodeId) as { capabilities_json: string | null } | undefined;
    return r?.capabilities_json ? JSON.parse(r.capabilities_json) : null;
  }

  setNodeDiscovered(nodeId: string, agents: DiscoveredAgent[]) {
    this.db.prepare("UPDATE nodes SET discovered_json = ? WHERE id = ?").run(JSON.stringify(agents), nodeId);
  }

  nodeDiscovered(nodeId: string): DiscoveredAgent[] {
    const r = this.db.prepare("SELECT discovered_json FROM nodes WHERE id = ?").get(nodeId) as { discovered_json: string } | undefined;
    return r ? JSON.parse(r.discovered_json) : [];
  }

  touchNode(nodeId: string, name?: string) {
    if (name) this.db.prepare("UPDATE nodes SET last_seen = ?, name = ? WHERE id = ?").run(now(), name, nodeId);
    else this.db.prepare("UPDATE nodes SET last_seen = ? WHERE id = ?").run(now(), nodeId);
  }

  deleteNode(nodeId: string) {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  // --- agents ---------------------------------------------------------------

  createAgent(a: { workspaceId: string; handle: string; name: string; harness: HarnessId; model?: string | null; nodeId?: string | null; computerId?: string | null; instructions?: string }) {
    const agentId = id("agt");
    this.db
      .prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, model, node_id, computer_id, groups_json, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)")
      .run(agentId, a.workspaceId, a.handle.toLowerCase(), a.name, a.harness, a.model ?? null, a.nodeId ?? null, a.computerId ?? null, a.instructions ?? "", now());
    return this.agent(agentId)!;
  }

  /** `settings` is merged key by key, so callers can change one setting at a time. */
  updateAgent(agentId: string, patch: Partial<{ name: string; handle: string; model: string | null; nodeId: string | null; computerId: string | null; instructions: string; harness: HarnessId; settings: AgentSettings }>) {
    const cur = this.agentRow(agentId);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE agents SET name = ?, handle = ?, model = ?, node_id = ?, computer_id = ?, instructions = ?, harness = ?, settings_json = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
        patch.handle?.toLowerCase() ?? cur.handle,
        patch.model !== undefined ? patch.model : cur.model,
        patch.nodeId !== undefined ? patch.nodeId : cur.node_id,
        patch.computerId !== undefined ? patch.computerId : cur.computer_id,
        patch.instructions ?? cur.instructions,
        patch.harness ?? cur.harness,
        JSON.stringify({ ...JSON.parse(cur.settings_json), ...patch.settings }),
        agentId,
      );
    return this.agent(agentId);
  }

  deleteAgent(agentId: string) {
    this.clearDefaultAgent(agentId);
    this.db.prepare("DELETE FROM channel_members WHERE member_kind = 'agent' AND member_id = ?").run(agentId);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  }

  private agentRow(agentId: string) {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  }

  agent(agentId: string): (Agent & { instructions: string }) | undefined {
    return this.toAgents([this.agentRow(agentId)])[0];
  }

  agentByHandle(workspaceId: string, handle: string) {
    return this.toAgents([this.db.prepare("SELECT * FROM agents WHERE workspace_id = ? AND handle = ?").get(workspaceId, handle.toLowerCase()) as AgentRow | undefined])[0];
  }

  agents(workspaceId: string) {
    return this.toAgents(this.db.prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY handle").all(workspaceId) as AgentRow[]);
  }

  agentsOnNode(nodeId: string) {
    return this.toAgents(this.db.prepare("SELECT * FROM agents WHERE node_id = ? ORDER BY handle").all(nodeId) as AgentRow[]);
  }

  agentsOnComputer(computerId: string) {
    return this.toAgents(this.db.prepare("SELECT * FROM agents WHERE computer_id = ? ORDER BY handle").all(computerId) as AgentRow[]);
  }

  // --- computers ------------------------------------------------------------

  createComputer(c: { workspaceId: string; name: string; kind: ComputerKind; nodeId: string | null; config: ComputerConfig; status?: ComputerStatus; statusText?: string }): Computer {
    const computerId = id("cmp");
    this.db
      .prepare("INSERT INTO computers (id, workspace_id, name, kind, node_id, config_json, status, status_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(computerId, c.workspaceId, c.name, c.kind, c.nodeId, JSON.stringify(c.config), c.status ?? "ready", c.statusText ?? "", now());
    return this.computer(computerId)!;
  }

  computer(computerId: string): Computer | undefined {
    const r = this.db.prepare("SELECT * FROM computers WHERE id = ?").get(computerId) as ComputerRow | undefined;
    return r && toComputer(r);
  }

  computers(workspaceId: string): Computer[] {
    return (this.db.prepare("SELECT * FROM computers WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as ComputerRow[]).map(toComputer);
  }

  computersOnNode(nodeId: string): Computer[] {
    return (this.db.prepare("SELECT * FROM computers WHERE node_id = ?").all(nodeId) as ComputerRow[]).map(toComputer);
  }

  updateComputer(computerId: string, patch: Partial<{ name: string; config: ComputerConfig; status: ComputerStatus; statusText: string; help: Computer["help"] }>) {
    const cur = this.computer(computerId);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE computers SET name = ?, config_json = ?, status = ?, status_text = ?, help_json = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
        JSON.stringify(patch.config ?? cur.config),
        patch.status ?? cur.status,
        patch.statusText ?? cur.statusText,
        patch.help !== undefined ? (patch.help ? JSON.stringify(patch.help) : null) : cur.help ? JSON.stringify(cur.help) : null,
        computerId,
      );
    return this.computer(computerId);
  }

  /** Remember something done on a computer (who, what), keeping the last 500. */
  logComputer(computerId: string, actor: Actor, text: string) {
    this.db.prepare("INSERT INTO computer_log (computer_id, actor_kind, actor_id, text, at) VALUES (?, ?, ?, ?, ?)").run(computerId, actor.kind, actor.id, text.slice(0, 300), now());
    this.db.prepare("DELETE FROM computer_log WHERE computer_id = ? AND id <= (SELECT id FROM computer_log WHERE computer_id = ? ORDER BY id DESC LIMIT 1 OFFSET 500)").run(computerId, computerId);
  }

  computerLog(computerId: string, limit = 100): { actor: Actor; text: string; at: string }[] {
    return (this.db.prepare("SELECT actor_kind, actor_id, text, at FROM computer_log WHERE computer_id = ? ORDER BY id DESC LIMIT ?").all(computerId, limit) as { actor_kind: Actor["kind"]; actor_id: string; text: string; at: string }[]).map((r) => ({
      actor: { kind: r.actor_kind, id: r.actor_id } as Actor,
      text: r.text,
      at: r.at,
    }));
  }

  deleteComputer(computerId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE agents SET computer_id = NULL WHERE computer_id = ?").run(computerId);
      this.db.prepare("DELETE FROM computers WHERE id = ?").run(computerId);
      this.db.prepare("DELETE FROM computer_catalogs WHERE computer_id = ?").run(computerId);
    })();
  }

  // --- approvals ------------------------------------------------------------

  createApproval(a: { workspaceId: string; agentId: string; channelId: string; threadId: string | null; summary: string; details: string; login?: Approval["login"]; flow?: Approval["flow"]; storage?: Approval["storage"]; device?: Approval["device"] }): Approval {
    const approvalId = id("apr");
    this.db
      .prepare("INSERT INTO approvals (id, workspace_id, agent_id, channel_id, thread_id, summary, details, status, created_at, login_json, flow_json, storage_json, device_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)")
      .run(approvalId, a.workspaceId, a.agentId, a.channelId, a.threadId, a.summary, a.details, now(), a.login ? JSON.stringify(a.login) : null, a.flow ? JSON.stringify(a.flow) : null, a.storage ? JSON.stringify(a.storage) : null, a.device ? JSON.stringify(a.device) : null);
    return this.approval(approvalId)!;
  }

  approval(approvalId: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
    return r && toApproval(r);
  }

  approvals(workspaceId: string, status?: Approval["status"]): Approval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200").all(workspaceId, status)
      : this.db.prepare("SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200").all(workspaceId);
    return (rows as ApprovalRow[]).map(toApproval);
  }

  decideApproval(approvalId: string, status: "approved" | "denied", userId: string, note: string) {
    this.db.prepare("UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, userId, note, now(), approvalId);
    return this.approval(approvalId);
  }

  // --- routines ---------------------------------------------------------------

  createRoutine(r: { workspaceId: string; agentId: string; name: string; notePath: string; schedule: string | null; timezone: string; channelId: string | null; status: Routine["status"]; createdBy: Actor }): Routine {
    const routineId = id("rtn");
    this.db
      .prepare("INSERT INTO routines (id, workspace_id, agent_id, name, note_path, schedule, timezone, channel_id, enabled, status, created_by_kind, created_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .run(routineId, r.workspaceId, r.agentId, r.name, r.notePath, r.schedule, r.timezone, r.channelId, r.status, r.createdBy.kind, r.createdBy.id, now());
    return this.routine(routineId)!;
  }

  routine(routineId: string): Routine | undefined {
    const r = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(routineId) as RoutineRow | undefined;
    return r && toRoutine(r);
  }

  routines(workspaceId: string, agentId?: string): Routine[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM routines WHERE workspace_id = ? AND agent_id = ? ORDER BY name").all(workspaceId, agentId)
      : this.db.prepare("SELECT * FROM routines WHERE workspace_id = ? ORDER BY name").all(workspaceId);
    return (rows as RoutineRow[]).map(toRoutine);
  }

  scheduledRoutines(): Routine[] {
    return (this.db.prepare("SELECT * FROM routines WHERE enabled = 1 AND schedule IS NOT NULL AND status = 'ready'").all() as RoutineRow[]).map(toRoutine);
  }

  updateRoutine(routineId: string, patch: Partial<Pick<Routine, "name" | "notePath" | "schedule" | "timezone" | "channelId" | "enabled" | "status" | "lastRunAt">>) {
    const cur = this.routine(routineId);
    if (!cur) return undefined;
    const v = { ...cur, ...patch };
    this.db
      .prepare("UPDATE routines SET name = ?, note_path = ?, schedule = ?, timezone = ?, channel_id = ?, enabled = ?, status = ?, last_run_at = ? WHERE id = ?")
      .run(v.name, v.notePath, v.schedule, v.timezone, v.channelId, v.enabled ? 1 : 0, v.status, v.lastRunAt, routineId);
    return this.routine(routineId);
  }

  /** A run of the routine finished successfully (lastRunAt is only when it was asked for). */
  routineCompleted(routineId: string, at = now()) {
    this.db.prepare("UPDATE routines SET last_completed_at = ? WHERE id = ?").run(at, routineId);
  }

  deleteRoutine(routineId: string) {
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(routineId);
  }

  // --- workspace settings -----------------------------------------------------

  setting(workspaceId: string, key: string): string | null {
    const r = this.db.prepare("SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?").get(workspaceId, key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(workspaceId: string, key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?").run(workspaceId, key);
    else this.db.prepare("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(workspaceId, key, value, now());
  }

  // --- memory sync tokens (Obsidian's Git plugin) -----------------------------

  addVaultToken(row: { id: string; hash: string; userId: string; workspaceId: string; label: string }) {
    this.db.prepare("INSERT INTO vault_tokens (id, hash, user_id, workspace_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.hash, row.userId, row.workspaceId, row.label, now());
  }

  vaultTokens(userId: string): { id: string; label: string; createdAt: string; lastUsed: string | null }[] {
    return this.db.prepare("SELECT id, label, created_at AS createdAt, last_used AS lastUsed FROM vault_tokens WHERE user_id = ? ORDER BY created_at").all(userId) as { id: string; label: string; createdAt: string; lastUsed: string | null }[];
  }

  /** Whose memory-sync token this is; also notes that it was just used. */
  useVaultToken(hash: string): { userId: string; workspaceId: string } | undefined {
    const r = this.db.prepare("SELECT id, user_id AS userId, workspace_id AS workspaceId FROM vault_tokens WHERE hash = ?").get(hash) as { id: string; userId: string; workspaceId: string } | undefined;
    if (r) this.db.prepare("UPDATE vault_tokens SET last_used = ? WHERE id = ?").run(now(), r.id);
    return r && { userId: r.userId, workspaceId: r.workspaceId };
  }

  removeVaultToken(userId: string, tokenId: string): boolean {
    return this.db.prepare("DELETE FROM vault_tokens WHERE id = ? AND user_id = ?").run(tokenId, userId).changes > 0;
  }

  private toAgents(rows: (AgentRow | undefined)[]): (Agent & { instructions: string })[] {
    return rows.filter((r): r is AgentRow => !!r).map(toAgent);
  }

  // --- teams: a channel's team is the only kind ----------------------------

  /** Every channel's team (archived channels and DMs have none). */
  teams(workspaceId: string): Team[] {
    return channelTeams(this.channels(workspaceId));
  }

  /** A channel's team, by the channel's id (which is also the team's id). */
  team(channelId: string): Team | undefined {
    const ch = this.channel(channelId);
    return (ch && teamOf(ch)) ?? undefined;
  }

  /** A team by its channel's name ("web" or "#web"). */
  teamByName(workspaceId: string, name: string): Team | undefined {
    const ch = this.channelByName(workspaceId, name.trim().replace(/^#/, "").toLowerCase());
    return (ch && teamOf(ch)) ?? undefined;
  }

  // --- channels -------------------------------------------------------------

  createChannel(workspaceId: string, name: string, kind: Channel["kind"] = "channel", topic = ""): Channel {
    const c: Channel = { id: id("ch"), workspaceId, name, kind, topic, sectionId: null, private: false, archivedAt: null, settings: { ...DEFAULT_CHANNEL_SETTINGS }, createdAt: now() };
    this.db.prepare("INSERT INTO channels (id, workspace_id, name, kind, topic, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, workspaceId, name, kind, topic, c.createdAt);
    return c;
  }

  private static CHANNEL_COLS = "id, workspace_id AS workspaceId, name, kind, topic, section_id AS sectionId, private, archived_at AS archivedAt, settings_json, created_at AS createdAt";

  private toChannel(r: (Omit<Channel, "private" | "settings"> & { private: number; settings_json: string }) | undefined): Channel | undefined {
    if (!r) return undefined;
    const { settings_json, ...rest } = r;
    let settings: Partial<ChannelSettings> = {};
    try {
      settings = JSON.parse(settings_json || "{}");
    } catch {}
    return { ...rest, private: !!r.private, settings: { ...DEFAULT_CHANNEL_SETTINGS, ...settings } };
  }

  /**
   * Teams that run on a single chain of steps (and the roles that hold their prompts) become flow
   * charts: every step gets its prompt and all its arrows spelled out. Nothing is removed, and
   * teams already in the new form are left alone.
   */
  migrateTeamSteps(): number {
    const rows = this.db.prepare("SELECT id, settings_json FROM channels WHERE settings_json LIKE '%\"steps\"%'").all() as { id: string; settings_json: string }[];
    let n = 0;
    for (const r of rows) {
      const team = this.channel(r.id)?.settings.team;
      if (!team?.steps?.length || isGraphTeam(team)) continue;
      const migrated = migrateTeam(team);
      this.updateChannel(r.id, { settings: { team: { ...migrated, ...chartFromSteps(migrated, team.nodes) } } });
      n++;
    }
    return n;
  }

  channel(channelId: string): Channel | undefined {
    return this.toChannel(this.db.prepare(`SELECT ${Store.CHANNEL_COLS} FROM channels WHERE id = ?`).get(channelId) as never);
  }

  channelByName(workspaceId: string, name: string): Channel | undefined {
    return this.toChannel(this.db.prepare(`SELECT ${Store.CHANNEL_COLS} FROM channels WHERE workspace_id = ? AND name = ?`).get(workspaceId, name) as never);
  }

  channels(workspaceId: string): Channel[] {
    return (this.db.prepare(`SELECT ${Store.CHANNEL_COLS} FROM channels WHERE workspace_id = ? ORDER BY kind, name`).all(workspaceId) as never[]).map((r) => this.toChannel(r)!);
  }

  updateChannel(channelId: string, patch: { name?: string; topic?: string; sectionId?: string | null; private?: boolean; archivedAt?: string | null; settings?: Partial<ChannelSettings> }) {
    const cur = this.channel(channelId);
    if (!cur) return undefined;
    // rules about a channel's team name it by the channel's name, so they follow a rename
    if (patch.name && patch.name !== cur.name) this.renameTeamRules(cur.workspaceId, cur.name, patch.name);
    this.db
      .prepare("UPDATE channels SET name = ?, topic = ?, section_id = ?, private = ?, archived_at = ?, settings_json = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
        patch.topic ?? cur.topic,
        patch.sectionId !== undefined ? patch.sectionId : cur.sectionId,
        (patch.private ?? cur.private) ? 1 : 0,
        patch.archivedAt !== undefined ? patch.archivedAt : cur.archivedAt,
        JSON.stringify({ ...cur.settings, ...patch.settings }),
        channelId,
      );
    return this.channel(channelId);
  }

  /**
   * The agent is gone, or left: channels whose default agent it was go back to "only @mentioned
   * agents", and it comes off their team chart (with its arrows; whoever it handed work to now
   * gets work from whoever handed it work).
   */
  clearDefaultAgent(agentId: string, channelId?: string) {
    const rows = this.db.prepare(`SELECT id, settings_json FROM channels WHERE settings_json LIKE ?${channelId ? " AND id = ?" : ""}`).all(`%${agentId}%`, ...(channelId ? [channelId] : [])) as { id: string; settings_json: string }[];
    for (const r of rows) {
      const settings = this.channel(r.id)?.settings;
      if (!settings) continue;
      if (settings.defaultAgentId === agentId) this.updateChannel(r.id, { settings: { defaultAgentId: null } });
      const team = settings.team;
      if (hasSteps(team) && (team!.roles?.some((r) => r.agentId === agentId) || team!.steps!.some((s) => s.agentId === agentId))) {
        // a team with steps keeps them; the agent's steps (and roles) just need someone new
        const roles = (team!.roles ?? []).map((r) => (r.agentId === agentId ? { ...r, agentId: null } : r));
        const steps = team!.steps!.map((s) => (s.agentId === agentId ? { ...s, agentId: null } : s));
        this.updateChannel(r.id, { settings: { team: { ...team!, roles, steps, ...chartFromSteps({ roles, steps }, team!.nodes) } } });
      } else if (team?.nodes.some((n) => n.agentId === agentId)) {
        const above = team.edges.filter((e) => e.to === agentId).map((e) => e.from);
        const below = team.edges.filter((e) => e.from === agentId).map((e) => e.to);
        const edges = [...team.edges.filter((e) => e.from !== agentId && e.to !== agentId), ...above.flatMap((from) => below.map((to) => ({ from, to })))];
        const nodes = team.nodes.filter((n) => n.agentId !== agentId);
        // with its lead gone, whoever it handed work to leads now
        const fed = new Set(edges.map((e) => e.to));
        this.updateChannel(r.id, { settings: { team: nodes.length ? { nodes: nodes.map((n) => (n.lead || fed.has(n.agentId) ? n : { ...n, lead: true })), edges } : null } });
      }
    }
  }

  // --- one person's channel settings and pins -------------------------------

  channelPrefs(userId: string): Record<string, { notify: ChannelNotify; starred: boolean }> {
    const rows = this.db.prepare("SELECT channel_id, notify, starred FROM channel_prefs WHERE user_id = ?").all(userId) as { channel_id: string; notify: ChannelNotify; starred: number }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, { notify: r.notify, starred: !!r.starred }]));
  }

  setChannelPrefs(userId: string, channelId: string, patch: { notify?: ChannelNotify; starred?: boolean }) {
    const cur = this.channelPrefs(userId)[channelId] ?? { notify: "default" as const, starred: false };
    this.db
      .prepare("INSERT INTO channel_prefs (user_id, channel_id, notify, starred) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, channel_id) DO UPDATE SET notify = excluded.notify, starred = excluded.starred")
      .run(userId, channelId, patch.notify ?? cur.notify, (patch.starred ?? cur.starred) ? 1 : 0);
  }

  /** People who muted a channel. */
  mutedBy(channelId: string): Set<string> {
    return new Set((this.db.prepare("SELECT user_id FROM channel_prefs WHERE channel_id = ? AND notify = 'mute'").all(channelId) as { user_id: string }[]).map((r) => r.user_id));
  }

  /** People in a channel who want a notification for every message there. */
  notifyAll(channelId: string): string[] {
    return (
      this.db
        .prepare("SELECT p.user_id FROM channel_prefs p JOIN channel_members m ON m.channel_id = p.channel_id AND m.member_kind = 'user' AND m.member_id = p.user_id WHERE p.channel_id = ? AND p.notify = 'all'")
        .all(channelId) as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  pin(channelId: string, messageId: string, by: Actor) {
    this.db.prepare("INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by_kind, pinned_by_id, created_at) VALUES (?, ?, ?, ?, ?)").run(channelId, messageId, by.kind, by.id, now());
  }

  unpin(channelId: string, messageId: string) {
    this.db.prepare("DELETE FROM pins WHERE channel_id = ? AND message_id = ?").run(channelId, messageId);
  }

  /** Pinned message ids per channel, newest pin first. */
  pinnedIds(channelIds: string[]): Record<string, string[]> {
    if (!channelIds.length) return {};
    const rows = this.db
      .prepare(`SELECT channel_id, message_id FROM pins WHERE channel_id IN (${channelIds.map(() => "?").join(",")}) ORDER BY created_at DESC`)
      .all(...channelIds) as { channel_id: string; message_id: string }[];
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.channel_id] ??= []).push(r.message_id);
    return out;
  }

  pins(channelId: string): { message: Message; pinnedBy: Actor; pinnedAt: string }[] {
    const rows = this.db.prepare("SELECT message_id, pinned_by_kind, pinned_by_id, created_at FROM pins WHERE channel_id = ? ORDER BY created_at DESC").all(channelId) as { message_id: string; pinned_by_kind: Actor["kind"]; pinned_by_id: string; created_at: string }[];
    return rows.flatMap((r) => {
      const message = this.message(r.message_id);
      return message ? [{ message, pinnedBy: { kind: r.pinned_by_kind, id: r.pinned_by_id } as Actor, pinnedAt: r.created_at }] : [];
    });
  }

  /** The agents in each channel, in the order they joined: what a team's icon shows when its chart doesn't name them. */
  agentMemberIds(channelIds: string[]): Record<string, string[]> {
    if (!channelIds.length) return {};
    const rows = this.db
      .prepare(
        `SELECT m.channel_id, m.member_id FROM channel_members m JOIN channels c ON c.id = m.channel_id
         WHERE m.channel_id IN (${channelIds.map(() => "?").join(",")}) AND m.member_kind = 'agent'
           AND EXISTS (SELECT 1 FROM agents a WHERE a.id = m.member_id AND a.workspace_id = c.workspace_id)
         ORDER BY m.rowid`,
      )
      .all(...channelIds) as { channel_id: string; member_id: string }[];
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.channel_id] ??= []).push(r.member_id);
    return out;
  }

  /** Members per channel: only people still in the workspace and agents that still exist, like the member list. */
  memberCounts(channelIds: string[]): Record<string, number> {
    if (!channelIds.length) return {};
    const rows = this.db
      .prepare(
        `SELECT m.channel_id, COUNT(*) AS n FROM channel_members m JOIN channels c ON c.id = m.channel_id
         WHERE m.channel_id IN (${channelIds.map(() => "?").join(",")})
           AND ((m.member_kind = 'user' AND EXISTS (SELECT 1 FROM memberships s WHERE s.workspace_id = c.workspace_id AND s.user_id = m.member_id))
             OR (m.member_kind = 'agent' AND EXISTS (SELECT 1 FROM agents a WHERE a.id = m.member_id AND a.workspace_id = c.workspace_id)))
         GROUP BY m.channel_id`,
      )
      .all(...channelIds) as { channel_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.n]));
  }

  isMember(channelId: string, member: Actor): boolean {
    return !!this.db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND member_kind = ? AND member_id = ?").get(channelId, member.kind, member.id);
  }

  // --- read state -----------------------------------------------------------

  markRead(userId: string, channelId: string, at = now()) {
    this.db
      .prepare("INSERT INTO channel_reads (user_id, channel_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)")
      .run(userId, channelId, at);
  }

  /** Last-read time and unread top-level messages (not written by the user) per channel. */
  readState(userId: string, channelIds: string[]): Record<string, { lastReadAt: string | null; unread: number }> {
    const out: Record<string, { lastReadAt: string | null; unread: number }> = {};
    const reads = this.db.prepare("SELECT channel_id, last_read_at FROM channel_reads WHERE user_id = ?").all(userId) as { channel_id: string; last_read_at: string }[];
    const last = new Map(reads.map((r) => [r.channel_id, r.last_read_at]));
    const count = this.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL AND created_at > ? AND NOT (author_kind = 'user' AND author_id IN (?, 'system'))",
    );
    for (const id of channelIds) {
      const at = last.get(id) ?? null;
      out[id] = { lastReadAt: at, unread: (count.get(id, at ?? "", userId) as { n: number }).n };
    }
    return out;
  }

  /** The newest top-level message in each channel, for the chats list's preview line and its order. */
  lastMessages(channelIds: string[]): Record<string, { at: string; body: string; author: { kind: string; id: string } }> {
    const out: Record<string, { at: string; body: string; author: { kind: string; id: string } }> = {};
    const stmt = this.db.prepare("SELECT body, author_kind, author_id, created_at FROM messages WHERE channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL AND NOT (author_kind = 'user' AND author_id = 'system') ORDER BY created_at DESC LIMIT 1");
    for (const id of channelIds) {
      const r = stmt.get(id) as { body: string; author_kind: string; author_id: string; created_at: string } | undefined;
      if (r) out[id] = { at: r.created_at, body: r.body.slice(0, 400), author: { kind: r.author_kind, id: r.author_id } };
    }
    return out;
  }

  // --- sections -------------------------------------------------------------

  sections(workspaceId: string): Section[] {
    return this.db.prepare("SELECT id, name, emoji, position FROM sections WHERE workspace_id = ? ORDER BY position, created_at").all(workspaceId) as Section[];
  }

  section(sectionId: string) {
    return this.db.prepare("SELECT id, workspace_id AS workspaceId, name, emoji, position FROM sections WHERE id = ?").get(sectionId) as (Section & { workspaceId: string }) | undefined;
  }

  createSection(workspaceId: string, name: string, emoji: string): Section {
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sections WHERE workspace_id = ?").get(workspaceId) as { p: number }).p;
    const sid = id("sec");
    this.db.prepare("INSERT INTO sections (id, workspace_id, name, emoji, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sid, workspaceId, name, emoji, pos, now());
    return { id: sid, name, emoji, position: pos };
  }

  updateSection(sectionId: string, patch: { name?: string; emoji?: string; position?: number }) {
    const cur = this.section(sectionId);
    if (!cur) return undefined;
    this.db.prepare("UPDATE sections SET name = ?, emoji = ?, position = ? WHERE id = ?").run(patch.name ?? cur.name, patch.emoji ?? cur.emoji, patch.position ?? cur.position, sectionId);
    return this.section(sectionId);
  }

  /** Channels in a deleted section fall back to the default group. */
  deleteSection(sectionId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE channels SET section_id = NULL WHERE section_id = ?").run(sectionId);
      this.db.prepare("DELETE FROM sections WHERE id = ?").run(sectionId);
    })();
  }

  addChannelMember(channelId: string, member: Actor) {
    this.db.prepare("INSERT OR IGNORE INTO channel_members (channel_id, member_kind, member_id) VALUES (?, ?, ?)").run(channelId, member.kind, member.id);
  }

  removeChannelMember(channelId: string, member: Actor) {
    this.db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND member_kind = ? AND member_id = ?").run(channelId, member.kind, member.id);
  }

  channelMembers(channelId: string): Actor[] {
    return (this.db.prepare("SELECT member_kind AS kind, member_id AS id FROM channel_members WHERE channel_id = ?").all(channelId) as Actor[]).map((a) => ({ kind: a.kind, id: a.id }) as Actor);
  }

  /**
   * Delete a channel. Its messages, members, read marks, approvals and discussions go with it (FK
   * cascade) and routines posting there lose it (FK set null); tasks and files that point at it
   * without a foreign key are let go of here, so nothing points at a channel that's gone.
   */
  deleteChannel(channelId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET channel_id = NULL, thread_id = NULL WHERE channel_id = ?").run(channelId);
      this.db.prepare("UPDATE files SET channel_id = NULL WHERE channel_id = ?").run(channelId);
      this.db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    })();
  }

  /** Get or create the DM channel between a user and an agent. */
  dmChannel(workspaceId: string, userId: string, agentId: string): Channel {
    const name = `dm:${userId}:${agentId}`;
    const existing = this.channelByName(workspaceId, name);
    if (existing) {
      // someone who was removed and invited back is in their old DM again
      if (this.role(workspaceId, userId)) this.addChannelMember(existing.id, { kind: "user", id: userId });
      if (this.agent(agentId)?.workspaceId === workspaceId) this.addChannelMember(existing.id, { kind: "agent", id: agentId });
      return existing;
    }
    const c = this.createChannel(workspaceId, name, "dm");
    this.addChannelMember(c.id, { kind: "user", id: userId });
    this.addChannelMember(c.id, { kind: "agent", id: agentId });
    return c;
  }

  // --- messages -------------------------------------------------------------

  insertMessage(m: { channelId: string; threadId?: string | null; author: Actor; body: string; parts?: MessagePart[]; hop?: number; replyToId?: string | null; conversationId?: string | null; contextId?: string | null }): Message {
    const msg: Message = { id: id("msg"), channelId: m.channelId, threadId: m.threadId ?? null, author: m.author, body: m.body, parts: m.parts ?? [], hop: m.hop ?? 0, createdAt: now(), ...(m.replyToId ? { replyToId: m.replyToId } : {}) };
    // the top of a DM or team splits into chats after a quiet break; threads don't
    let contextId = m.contextId ?? null;
    if (!msg.threadId) {
      const latest = this.latestWritten(msg.channelId);
      const natural = msg.author.id === "system" ? (latest?.conversationId ?? msg.id) : conversationFor(latest, msg);
      // a reply to an earlier request stays in that request's chat, unless someone has written in a
      // newer chat since: then it lands in the chat going on now and brings its own back with it
      const current = latest && (latest.conversationId || latest.id);
      if (m.conversationId && (!latest || current === m.conversationId)) msg.conversationId = m.conversationId;
      else {
        msg.conversationId = natural;
        if (m.conversationId) contextId = m.conversationId;
      }
    }
    if (!msg.conversationId || contextId === msg.conversationId) contextId = null;
    this.db
      .prepare("INSERT INTO messages (id, channel_id, thread_id, author_kind, author_id, body, parts_json, hop, created_at, reply_to_id, conversation_id, context_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(msg.id, msg.channelId, msg.threadId, msg.author.kind, msg.author.id, msg.body, JSON.stringify(msg.parts), msg.hop, msg.createdAt, msg.replyToId ?? null, msg.conversationId ?? null, contextId);
    return this.withReplyQuote(contextId ? { ...msg, contextId } : msg);
  }

  /** The latest top-level message someone wrote in a channel (not Wisp's own notices): where its current chat stands. */
  latestWritten(channelId: string): { id: string; createdAt: string; authorId: string; conversationId: string | null } | undefined {
    const r = this.db.prepare("SELECT id, created_at, author_id, conversation_id FROM messages WHERE channel_id = ? AND thread_id IS NULL AND author_id != 'system' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(channelId) as { id: string; created_at: string; author_id: string; conversation_id: string | null } | undefined;
    return r && { id: r.id, createdAt: r.created_at, authorId: r.author_id, conversationId: r.conversation_id };
  }

  /** When a chat started: its first message that's still there (the very first may have been deleted). */
  chatStart(conversationId: string): string | undefined {
    return (this.db.prepare("SELECT MIN(created_at) AS at FROM messages WHERE conversation_id = ?").get(conversationId) as { at: string | null }).at ?? undefined;
  }

  /** The last messages of one chat, oldest first. */
  conversationMessages(conversationId: string, limit = 20): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(conversationId, limit) as MessageRow[]).map(toMessage).reverse();
  }

  /** Earlier chats that messages in this one brought back (replies into them, check-backs on them), latest first. */
  contextsOf(conversationId: string): string[] {
    const rows = this.db.prepare("SELECT context_id FROM messages WHERE conversation_id = ? AND context_id IS NOT NULL GROUP BY context_id ORDER BY MAX(created_at) DESC").all(conversationId) as { context_id: string }[];
    return rows.map((r) => r.context_id);
  }

  deleteMessage(messageId: string) {
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  }

  editMessage(messageId: string, body: string): Message | undefined {
    this.db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(body, now(), messageId);
    return this.message(messageId);
  }

  /** Empty a deleted thread root but keep the row, so its replies can still be opened. */
  blankMessage(messageId: string): Message | undefined {
    this.db.transaction(() => {
      this.db.prepare("UPDATE messages SET body = '', parts_json = '[]', deleted_at = ? WHERE id = ?").run(now(), messageId);
      this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(messageId);
      this.db.prepare("DELETE FROM pins WHERE message_id = ?").run(messageId);
    })();
    return this.message(messageId);
  }

  /** System notices (status lines) posted in a channel or thread since a moment, oldest first. */
  systemNotices(channelId: string, threadId: string | null, since: string): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? AND author_id = 'system' AND created_at >= ? AND ${threadId ? "thread_id = ?" : "thread_id IS NULL"} ORDER BY created_at`)
      .all(...(threadId ? [channelId, since, threadId] : [channelId, since])) as MessageRow[];
    return rows.map(toMessage);
  }

  message(messageId: string): Message | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    return r && toMessage(r);
  }

  /** Top-level messages of a channel (newest last), or replies in a thread when threadId is given. */
  messages(channelId: string, opts: { threadId?: string | null; before?: string; limit?: number } = {}): Message[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const params: unknown[] = [channelId];
    let sql = "SELECT * FROM messages WHERE channel_id = ?";
    if (opts.threadId) {
      sql += " AND (thread_id = ? OR id = ?)";
      params.push(opts.threadId, opts.threadId);
    } else sql += " AND thread_id IS NULL";
    if (opts.before) {
      sql += " AND created_at < ?";
      params.push(opts.before);
    }
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as MessageRow[]).map(toMessage).reverse();
  }

  replyCounts(messageIds: string[]): Record<string, number> {
    if (!messageIds.length) return {};
    const rows = this.db
      .prepare(`SELECT thread_id, COUNT(*) AS n FROM messages WHERE thread_id IN (${messageIds.map(() => "?").join(",")}) GROUP BY thread_id`)
      .all(...messageIds) as { thread_id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.thread_id, r.n]));
  }

  // --- reactions ------------------------------------------------------------

  /** Toggle one actor's emoji on a message. Returns true when it was added. */
  toggleReaction(messageId: string, actor: Actor, emoji: string, on?: boolean): boolean {
    const exists = !!this.db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND actor_kind = ? AND actor_id = ? AND emoji = ?").get(messageId, actor.kind, actor.id, emoji);
    const want = on ?? !exists;
    if (want && !exists) this.db.prepare("INSERT INTO reactions (message_id, actor_kind, actor_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)").run(messageId, actor.kind, actor.id, emoji, now());
    if (!want && exists) this.db.prepare("DELETE FROM reactions WHERE message_id = ? AND actor_kind = ? AND actor_id = ? AND emoji = ?").run(messageId, actor.kind, actor.id, emoji);
    return want;
  }

  reactions(messageIds: string[]): Record<string, Reaction[]> {
    if (!messageIds.length) return {};
    const rows = this.db
      .prepare(`SELECT message_id, actor_kind, actor_id, emoji FROM reactions WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...messageIds) as { message_id: string; actor_kind: "user" | "agent"; actor_id: string; emoji: string }[];
    const out: Record<string, Reaction[]> = {};
    for (const r of rows) {
      const list = (out[r.message_id] ??= []);
      let entry = list.find((x) => x.emoji === r.emoji);
      if (!entry) list.push((entry = { emoji: r.emoji, actors: [] }));
      entry.actors.push({ kind: r.actor_kind, id: r.actor_id } as Actor);
    }
    return out;
  }

  /** A reply with the message it quotes attached, as that message reads now. */
  withReplyQuote(m: Message & { contextId?: string }): Message {
    const { contextId, ...rest } = m;
    let out: Message = rest;
    if (contextId) {
      const at = this.chatStart(contextId);
      if (at) out = { ...out, context: { conversationId: contextId, at } };
    }
    if (!out.replyToId) return out;
    const q = this.message(out.replyToId);
    if (!q || q.channelId !== out.channelId) return out;
    const file = q.parts.find((p) => p.type === "file");
    const text = q.body.replace(/\s+/g, " ").trim() || (file && file.type === "file" ? file.name : "");
    return { ...out, replyTo: { id: q.id, author: q.author, snippet: q.deletedAt ? "" : text.length > 140 ? `${text.slice(0, 140)}…` : text, ...(q.deletedAt ? { deleted: true } : {}), createdAt: q.createdAt, ...(q.conversationId ? { conversationId: q.conversationId } : {}) } };
  }

  /** Messages with their reactions and the messages they quote attached. */
  withReactions(messages: Message[]): Message[] {
    const r = this.reactions(messages.map((m) => m.id));
    return messages.map((m) => this.withReplyQuote({ ...m, reactions: r[m.id] ?? [] }));
  }

  // --- search ---------------------------------------------------------------

  searchMessages(channelIds: string[], q: string, limit = 20) {
    if (!channelIds.length || !q.trim()) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    return (this.db
      .prepare(`SELECT * FROM messages WHERE channel_id IN (${channelIds.map(() => "?").join(",")}) AND body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`)
      .all(...channelIds, like, limit) as MessageRow[]).map(toMessage);
  }

  // --- runs -----------------------------------------------------------------

  /** `requestedBy`: the person this run is ultimately for (who asked, or who asked the agent that asked); null when nobody did. */
  /** `kind: "background"` is a check the agent does on its own: no trigger message, and nothing posted when it ends. */
  /** `kind: "memory"` is a pass that saves what recent work taught it (AutoMemory): also no trigger message, nothing posted. */
  createRun(r: { agentId: string; channelId: string; threadId: string | null; triggerMessageId: string; hop: number; discussionId?: string; phase?: string; requestedBy?: string | null; kind?: RunKind }) {
    const runId = id("run");
    this.db
      .prepare("INSERT INTO runs (id, agent_id, channel_id, thread_id, trigger_message_id, status, hop, discussion_id, phase, requested_by, kind, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)")
      .run(runId, r.agentId, r.channelId, r.threadId, r.triggerMessageId, r.hop, r.discussionId ?? null, r.phase ?? null, r.requestedBy ?? null, r.kind ?? null, now());
    return runId;
  }

  run(runId: string) {
    return this.db
      .prepare(
        "SELECT id, agent_id AS agentId, channel_id AS channelId, thread_id AS threadId, trigger_message_id AS triggerMessageId, status, hop, discussion_id AS discussionId, phase, requested_by AS requestedBy, kind, created_at AS createdAt, finished_at AS finishedAt FROM runs WHERE id = ?",
      )
      .get(runId) as
      | { id: string; agentId: string; channelId: string; threadId: string | null; triggerMessageId: string; status: string; hop: number; discussionId: string | null; phase: string | null; requestedBy: string | null; kind: RunKind | null; createdAt: string; finishedAt: string | null }
      | undefined;
  }

  /** Runs of one discussion phase, e.g. "round:2" or "summary". */
  discussionRuns(discussionId: string, phase: string) {
    return this.db.prepare("SELECT id, agent_id AS agentId, status FROM runs WHERE discussion_id = ? AND phase = ?").all(discussionId, phase) as { id: string; agentId: string; status: string }[];
  }

  // --- discussions ------------------------------------------------------------

  createDiscussion(d: Omit<Discussion, "id" | "round" | "status" | "decisionPath" | "createdAt" | "updatedAt"> & { id?: string }): Discussion {
    const did = d.id ?? id("disc");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO discussions (id, workspace_id, channel_id, thread_id, team_id, topic, goal, participants_json, moderator_id, rounds, round, status, started_by_kind, started_by_id, requested_by, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(did, d.workspaceId, d.channelId, d.threadId, d.teamId, d.topic, d.goal, JSON.stringify(d.participants), d.moderatorId, d.rounds, d.startedBy.kind, d.startedBy.id, d.requestedBy ?? null, d.kind ?? null, ts, ts);
    return this.discussion(did)!;
  }

  discussion(discussionId: string): Discussion | undefined {
    const r = this.db.prepare("SELECT * FROM discussions WHERE id = ?").get(discussionId) as DiscussionRow | undefined;
    return r && toDiscussion(r);
  }

  discussions(workspaceId: string, filter: { channelId?: string; status?: string } = {}): Discussion[] {
    let sql = "SELECT * FROM discussions WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    if (filter.channelId) {
      sql += " AND channel_id = ?";
      params.push(filter.channelId);
    }
    if (filter.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    return (this.db.prepare(sql + " ORDER BY created_at DESC LIMIT 100").all(...params) as DiscussionRow[]).map(toDiscussion);
  }

  updateDiscussion(discussionId: string, patch: Partial<Pick<Discussion, "round" | "status" | "decisionPath" | "moderatorId">>) {
    const cur = this.discussion(discussionId);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE discussions SET round = ?, status = ?, decision_path = ?, moderator_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.round ?? cur.round, patch.status ?? cur.status, patch.decisionPath !== undefined ? patch.decisionPath : cur.decisionPath, patch.moderatorId ?? cur.moderatorId, now(), discussionId);
    return this.discussion(discussionId);
  }

  setRunStatus(runId: string, status: "running" | "done" | "failed" | "cancelled", error?: string) {
    const finished = status === "running" ? null : now();
    this.db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error ?? null, finished, runId);
  }

  /** A run that never reached a device leaves no trace (a background check cancelled before it started). */
  deleteQueuedRun(runId: string) {
    return this.db.prepare("DELETE FROM runs WHERE id = ? AND status = 'queued'").run(runId).changes > 0;
  }

  queuedRunsForNode(nodeId: string) {
    return this.db
      .prepare("SELECT r.id FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.node_id = ? AND r.status = 'queued' ORDER BY r.created_at")
      .all(nodeId) as { id: string }[];
  }

  agentRuns(agentId: string, limit = 20) {
    return this.db
      .prepare(
        `SELECT r.id, r.status, r.kind, r.error, r.created_at AS createdAt, r.finished_at AS finishedAt, r.channel_id AS channelId, r.thread_id AS threadId,
                c.name AS channelName, c.kind AS channelKind, m.body AS trigger
         FROM runs r LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN messages m ON m.id = r.trigger_message_id
         WHERE r.agent_id = ? AND NOT (r.kind IN ('background','memory') AND r.status = 'queued') ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as {
      id: string;
      status: string;
      kind: string;
      error: string | null;
      createdAt: string;
      finishedAt: string | null;
      channelId: string;
      threadId: string | null;
      channelName: string | null;
      channelKind: string | null;
      trigger: string | null;
    }[];
  }

  /** A run can report usage more than once (token counts, then the context window): later reports add to the earlier ones. */
  setRunUsage(runId: string, usage: Omit<ContextUsage, "at">) {
    const before = this.db.prepare("SELECT usage_json FROM runs WHERE id = ?").get(runId) as { usage_json: string | null } | undefined;
    const merged = { ...(before?.usage_json ? JSON.parse(before.usage_json) : {}), ...usage };
    this.db.prepare("UPDATE runs SET usage_json = ? WHERE id = ?").run(JSON.stringify(merged), runId);
  }

  /** Background checks for one person since `since`, newest first, with what each reported using. */
  backgroundRuns(agentId: string, userId: string, since: string) {
    const rows = this.db
      .prepare("SELECT status, created_at AS createdAt, usage_json AS usage FROM runs WHERE agent_id = ? AND requested_by = ? AND kind = 'background' AND status != 'queued' AND created_at >= ? ORDER BY created_at DESC")
      .all(agentId, userId, since) as { status: string; createdAt: string; usage: string | null }[];
    return rows.map((r) => {
      const u = r.usage ? (JSON.parse(r.usage) as Omit<ContextUsage, "at">) : null;
      // tokens only when the harness said how many
      const tokens = u && (u.inputTokens !== undefined || u.outputTokens !== undefined) ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : null;
      return { status: r.status, createdAt: r.createdAt, tokens };
    });
  }

  /** The most recent usage report for an agent in one conversation (channel + thread). */
  latestUsage(agentId: string, channelId: string, threadId: string | null): ContextUsage | null {
    const r = this.db
      .prepare(
        `SELECT usage_json, COALESCE(finished_at, created_at) AS at FROM runs
         WHERE agent_id = ? AND channel_id = ? AND thread_id IS ? AND usage_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId, channelId, threadId) as { usage_json: string; at: string } | undefined;
    return r ? { ...JSON.parse(r.usage_json), at: r.at } : null;
  }

  /** Runs that haven't ended yet (queued or running). */
  activeRuns(agentId: string) {
    return this.db.prepare("SELECT id, trigger_message_id AS triggerMessageId FROM runs WHERE agent_id = ? AND status IN ('queued', 'running') ORDER BY created_at").all(agentId) as { id: string; triggerMessageId: string }[];
  }

  activeRunCount(agentId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'running'").get(agentId) as { n: number }).n;
  }

  // --- tasks ----------------------------------------------------------------

  createTask(t: { workspaceId: string; from: Actor; toAgentId: string; title: string; brief: string; channelId: string | null; threadId: string | null; teamId?: string | null; branch?: string | null; reviewOf?: string | null; parentId?: string | null }) {
    const taskId = id("task");
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, workspace_id, from_kind, from_id, to_agent_id, title, brief, status, channel_id, thread_id, team_id, branch, review_of, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, t.workspaceId, t.from.kind, t.from.id, t.toAgentId, t.title, t.brief, t.channelId, t.threadId, t.teamId ?? null, t.branch ?? null, t.reviewOf ?? null, t.parentId ?? null, ts, ts);
    return this.task(taskId)!;
  }

  task(taskId: string) {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return r && toTask(r);
  }

  tasks(workspaceId: string, filter: { agentId?: string; status?: string } = {}) {
    let sql = "SELECT * FROM tasks WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    if (filter.agentId) {
      sql += " AND (to_agent_id = ? OR (from_kind = 'agent' AND from_id = ?))";
      params.push(filter.agentId, filter.agentId);
    }
    if (filter.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    return (this.db.prepare(sql + " ORDER BY created_at DESC LIMIT 200").all(...params) as TaskRow[]).map(toTask);
  }

  /** The pieces a task was broken into, oldest first. */
  subtasks(parentId: string) {
    return (this.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at").all(parentId) as TaskRow[]).map(toTask);
  }

  /** The task a thread is about (tasks are discussed in the thread of the message that handed them out). */
  taskByThread(threadId: string) {
    const r = this.db.prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1").get(threadId) as TaskRow | undefined;
    return r && toTask(r);
  }

  setTaskBranch(taskId: string, branch: string | null) {
    this.db.prepare("UPDATE tasks SET branch = ? WHERE id = ?").run(branch, taskId);
  }

  markTaskMerged(taskId: string) {
    this.db.prepare("UPDATE tasks SET merged_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), taskId);
  }

  updateTask(taskId: string, status: "open" | "in_progress" | "done" | "failed", result?: string) {
    this.db.prepare("UPDATE tasks SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?").run(status, result ?? null, now(), taskId);
    return this.task(taskId);
  }

  /** A failed task goes back to open; what went wrong last time no longer describes it. */
  reopenTask(taskId: string) {
    this.db.prepare("UPDATE tasks SET status = 'open', result = NULL, updated_at = ? WHERE id = ?").run(now(), taskId);
    return this.task(taskId);
  }

  // --- memory access rules -------------------------------------------------

  accessRules(workspaceId: string): AccessRule[] {
    return (this.db.prepare("SELECT * FROM access_rules WHERE workspace_id = ? ORDER BY path_key, subject").all(workspaceId) as RuleRow[]).flatMap(toRule);
  }

  accessRule(ruleId: string): (AccessRule & { workspaceId: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM access_rules WHERE id = ?").get(ruleId) as RuleRow | undefined;
    const rule = r && toRule(r)[0];
    return rule && { ...rule, workspaceId: r.workspace_id };
  }

  /** The stored rule for exactly this path and subject, if any. */
  accessRuleAt(workspaceId: string, path: string, subject: Subject): AccessRule | undefined {
    const r = this.db.prepare("SELECT * FROM access_rules WHERE workspace_id = ? AND path_key = ? AND subject = ?").get(workspaceId, cleanRulePath(path).toLowerCase(), subjectKey(subject)) as RuleRow | undefined;
    return r && toRule(r)[0];
  }

  /** One rule per path and subject: setting it again replaces the level and startup flag. */
  setAccessRule(workspaceId: string, r: { path: string; subject: Subject; level: MemoryLevel; startup?: boolean; createdBy: Actor }): AccessRule {
    const path = cleanRulePath(r.path);
    this.db
      .prepare(
        `INSERT INTO access_rules (id, workspace_id, path, path_key, subject, level, startup, created_by_kind, created_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, path_key, subject) DO UPDATE SET path = excluded.path, level = excluded.level, startup = excluded.startup, created_by_kind = excluded.created_by_kind, created_by_id = excluded.created_by_id`,
      )
      .run(id("rule"), workspaceId, path, path.toLowerCase(), subjectKey(r.subject), r.level, r.startup ? 1 : 0, r.createdBy.kind, r.createdBy.id, now());
    return this.accessRuleAt(workspaceId, path, r.subject)!;
  }

  removeAccessRule(workspaceId: string, ruleId: string) {
    this.db.prepare("DELETE FROM access_rules WHERE workspace_id = ? AND id = ?").run(workspaceId, ruleId);
  }

  /** Drop every rule naming someone who is gone. */
  /** Point rules about one team (and roles on it) at its new name. */
  renameTeamRules(workspaceId: string, from: string, to: string) {
    // names match the way rules do: ignoring case
    this.db.prepare("UPDATE OR REPLACE access_rules SET subject = ? WHERE workspace_id = ? AND lower(subject) = lower(?)").run(`team:${to}`, workspaceId, `team:${from}`);
    this.db
      .prepare("UPDATE OR REPLACE access_rules SET subject = ? || substr(subject, ?) WHERE workspace_id = ? AND lower(substr(subject, 1, ?)) = lower(?)")
      .run(`role:${to}/`, `role:${from}/`.length + 1, workspaceId, `role:${from}/`.length, `role:${from}/`);
  }

  removeRulesFor(workspaceId: string, subject: Subject) {
    this.db.prepare("DELETE FROM access_rules WHERE workspace_id = ? AND subject = ?").run(workspaceId, subjectKey(subject));
  }

  // --- files ----------------------------------------------------------------

  insertFile(f: { workspaceId: string; sha256: string; name: string; mime: string; size: number; uploader: Actor; channelId: string | null }) {
    const fid = id("file");
    this.db
      .prepare("INSERT INTO files (id, workspace_id, sha256, name, mime, size, uploader_kind, uploader_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(fid, f.workspaceId, f.sha256, f.name, f.mime, f.size, f.uploader.kind, f.uploader.id, f.channelId, now());
    return this.file(fid)!;
  }

  file(fileId: string) {
    return this.db
      .prepare("SELECT id, workspace_id AS workspaceId, sha256, name, mime, size, uploader_kind AS uploaderKind, uploader_id AS uploaderId, channel_id AS channelId, created_at AS createdAt FROM files WHERE id = ?")
      .get(fileId) as FileRecord | undefined;
  }

  files(workspaceId: string, channelId?: string) {
    let sql = "SELECT id, workspace_id AS workspaceId, sha256, name, mime, size, uploader_kind AS uploaderKind, uploader_id AS uploaderId, channel_id AS channelId, created_at AS createdAt FROM files WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    if (channelId) {
      sql += " AND channel_id = ?";
      params.push(channelId);
    }
    return this.db.prepare(sql + " ORDER BY created_at DESC LIMIT 200").all(...params) as FileRecord[];
  }

  // --- background work and follow-ups ---------------------------------------------------------

  private backgroundSql = `SELECT b.agent_id AS agentId, b.user_id AS userId, b.enabled, b.every_minutes AS everyMinutes, b.focus, b.quiet_start AS quietStart, b.quiet_end AS quietEnd,
    b.next_at AS nextAt, b.next_reason AS nextReason, b.last_at AS lastAt, b.last_note AS lastNote, b.model, b.effort, b.daily_cap AS dailyCap, b.quiet_streak AS quietStreak,
    EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = b.agent_id AND r.kind = 'background' AND r.requested_by = b.user_id AND r.status IN ('queued','running')) AS checking
    FROM background b`;
  private toBackground = (r: Record<string, unknown>): BackgroundWork => ({ ...(r as unknown as BackgroundWork), enabled: !!r.enabled, checking: !!r.checking });

  background(agentId: string, userId: string): BackgroundWork | undefined {
    const r = this.db.prepare(`${this.backgroundSql} WHERE b.agent_id = ? AND b.user_id = ?`).get(agentId, userId) as Record<string, unknown> | undefined;
    return r && this.toBackground(r);
  }

  /** Background work that's on, across every workspace. */
  activeBackground(): BackgroundWork[] {
    return (this.db.prepare(`${this.backgroundSql} WHERE b.enabled = 1`).all() as Record<string, unknown>[]).map(this.toBackground);
  }

  setBackground(agentId: string, userId: string, patch: Partial<Pick<BackgroundWork, "enabled" | "everyMinutes" | "focus" | "quietStart" | "quietEnd" | "nextAt" | "nextReason" | "lastAt" | "lastNote" | "model" | "effort" | "dailyCap" | "quietStreak">>): BackgroundWork {
    this.db.prepare("INSERT OR IGNORE INTO background (agent_id, user_id, created_at) VALUES (?, ?, ?)").run(agentId, userId, now());
    const v = { ...this.background(agentId, userId)!, ...patch };
    this.db
      .prepare("UPDATE background SET enabled = ?, every_minutes = ?, focus = ?, quiet_start = ?, quiet_end = ?, next_at = ?, next_reason = ?, last_at = ?, last_note = ?, model = ?, effort = ?, daily_cap = ?, quiet_streak = ? WHERE agent_id = ? AND user_id = ?")
      .run(v.enabled ? 1 : 0, v.everyMinutes, v.focus, v.quietStart, v.quietEnd, v.nextAt, v.nextReason, v.lastAt, v.lastNote, v.model, v.effort, v.dailyCap, v.quietStreak ?? 0, agentId, userId);
    return this.background(agentId, userId)!;
  }

  /** Background checks for one person since `since`, by every agent in a workspace: what each used. */
  backgroundRunsFor(workspaceId: string, userId: string, since: string) {
    const rows = this.db
      .prepare("SELECT r.agent_id AS agentId, r.usage_json AS usage FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.workspace_id = ? AND r.requested_by = ? AND r.kind IN ('background','memory') AND r.status != 'queued' AND r.created_at >= ?")
      .all(workspaceId, userId, since) as { agentId: string; usage: string | null }[];
    return rows.map((r) => {
      const u = r.usage ? (JSON.parse(r.usage) as Omit<ContextUsage, "at">) : null;
      const tokens = u && (u.inputTokens !== undefined || u.outputTokens !== undefined) ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : null;
      return { agentId: r.agentId, tokens };
    });
  }

  /**
   * Token use by finished-or-running runs (anything past queued) in one workspace between `from` and `to`,
   * grouped in the database by quarter hour (every time zone's offset is a multiple of 15 minutes), agent,
   * model and kind. Runs that reported no token counts are counted as `guess` each. `includeUnattributed`
   * adds runs nobody is recorded as having asked for (they belong to the workspace owner).
   */
  usageRows(workspaceId: string, userId: string, includeUnattributed: boolean, from: string, to: string, guess: number) {
    const tokenSql = "(json_extract(r.usage_json, '$.inputTokens') IS NOT NULL OR json_extract(r.usage_json, '$.outputTokens') IS NOT NULL)";
    return this.db
      .prepare(
        `SELECT substr(r.created_at, 1, 14) || printf('%02d', (CAST(substr(r.created_at, 15, 2) AS INTEGER) / 15) * 15) AS slot,
                r.agent_id AS agentId, r.kind IN ('background','memory') AS background, json_extract(r.usage_json, '$.model') AS model,
                COUNT(*) AS runs, SUM(r.status = 'failed') AS failed,
                SUM(CASE WHEN ${tokenSql} THEN COALESCE(json_extract(r.usage_json, '$.inputTokens'), 0) + COALESCE(json_extract(r.usage_json, '$.outputTokens'), 0) ELSE ? END) AS tokens,
                SUM(NOT ${tokenSql}) AS guessed
         FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE a.workspace_id = ? AND (r.requested_by = ? ${includeUnattributed ? "OR r.requested_by IS NULL" : ""})
           AND r.status != 'queued' AND r.created_at >= ? AND r.created_at < ?
         GROUP BY slot, r.agent_id, background, model`,
      )
      .all(guess, workspaceId, userId, from, to) as { slot: string; agentId: string; background: number; model: string | null; runs: number; failed: number; tokens: number; guessed: number }[];
  }

  private changeSql = "SELECT id, user_id AS userId, agent_id AS agentId, lines_json AS lines, undo_json AS undo, created_at AS createdAt, undone_at AS undoneAt FROM changes";
  private toChange = (r: Record<string, unknown>): Change & { undo: unknown } => ({ ...(r as unknown as Change), lines: JSON.parse(r.lines as string), undo: JSON.parse(r.undo as string) });

  createChange(c: { workspaceId: string; userId: string; agentId: string; lines: string[]; undo: unknown }) {
    const cid = id("chg");
    this.db.prepare("INSERT INTO changes (id, workspace_id, user_id, agent_id, lines_json, undo_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(cid, c.workspaceId, c.userId, c.agentId, JSON.stringify(c.lines), JSON.stringify(c.undo), now());
    return this.change(cid)!;
  }

  change(changeId: string) {
    const r = this.db.prepare(`${this.changeSql} WHERE id = ?`).get(changeId) as Record<string, unknown> | undefined;
    return r && this.toChange(r);
  }

  /** What agents changed for one person, newest first. */
  changes(workspaceId: string, userId: string, limit = 30) {
    return (this.db.prepare(`${this.changeSql} WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceId, userId, limit) as Record<string, unknown>[]).map(this.toChange);
  }

  markChangeUndone(changeId: string) {
    this.db.prepare("UPDATE changes SET undone_at = ? WHERE id = ?").run(now(), changeId);
  }

  private followupSql = `SELECT id, agent_id AS agentId, user_id AS userId, due_at AS dueAt, note, status, created_at AS createdAt,
    label, waiting_on AS waitingOn, condition, kind, channel_id AS channelId, message_id AS messageId FROM followups`;

  createFollowup(f: { agentId: string; userId: string | null; dueAt: string; note: string; label?: string | null; waitingOn?: Followup["waitingOn"]; condition?: string; kind?: Followup["kind"]; channelId?: string | null; runId?: string | null }): Followup {
    const fid = id("fup");
    this.db
      .prepare("INSERT INTO followups (id, agent_id, user_id, due_at, note, status, created_at, label, waiting_on, condition, kind, channel_id, run_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)")
      .run(fid, f.agentId, f.userId, f.dueAt, f.note, now(), f.label ?? null, f.waitingOn ?? "agent", f.condition ?? "", f.kind ?? "followup", f.channelId ?? null, f.runId ?? null);
    return this.followup(fid)!;
  }

  followup(followupId: string): Followup | undefined {
    return this.db.prepare(`${this.followupSql} WHERE id = ?`).get(followupId) as Followup | undefined;
  }

  /** An agent's follow-ups that haven't happened yet, soonest first. */
  pendingFollowups(agentId: string): Followup[] {
    return this.db.prepare(`${this.followupSql} WHERE agent_id = ? AND status = 'pending' ORDER BY due_at`).all(agentId) as Followup[];
  }

  dueFollowups(at: string): Followup[] {
    return this.db.prepare(`${this.followupSql} WHERE status = 'pending' AND due_at <= ? ORDER BY due_at`).all(at) as Followup[];
  }

  setFollowupStatus(followupId: string, status: Followup["status"]) {
    this.db.prepare("UPDATE followups SET status = ? WHERE id = ?").run(status, followupId);
  }

  rescheduleFollowup(followupId: string, dueAt: string) {
    this.db.prepare("UPDATE followups SET due_at = ? WHERE id = ?").run(dueAt, followupId);
  }

  /** Follow-ups set during a run that have no reply to show them yet. */
  unplacedFollowups(runId: string): Followup[] {
    return this.db.prepare(`${this.followupSql} WHERE run_id = ? AND message_id IS NULL`).all(runId) as Followup[];
  }

  placeFollowup(followupId: string, messageId: string) {
    this.db.prepare("UPDATE followups SET message_id = ? WHERE id = ?").run(messageId, followupId);
  }

  // --- where a DM stands (chat_status) ------------------------------------------------------------

  private loopSql = "SELECT channel_id AS channelId, agent_id AS agentId, user_id AS userId, status, summary, nudges, updated_at AS updatedAt FROM chat_loops";

  chatLoop(channelId: string): ChatLoop | undefined {
    return this.db.prepare(`${this.loopSql} WHERE channel_id = ?`).get(channelId) as ChatLoop | undefined;
  }

  /** One person's chats by where they stand, keyed by channel. */
  chatLoopsFor(userId: string, channelIds: string[]): Record<string, ChatLoop> {
    if (!channelIds.length) return {};
    const rows = this.db.prepare(`${this.loopSql} WHERE user_id = ? AND channel_id IN (${channelIds.map(() => "?").join(",")})`).all(userId, ...channelIds) as ChatLoop[];
    return Object.fromEntries(rows.map((r) => [r.channelId, r]));
  }

  /** Chats with one agent that wait on this person. */
  waitingLoops(agentId: string, userId: string): ChatLoop[] {
    return this.db.prepare(`${this.loopSql} WHERE agent_id = ? AND user_id = ? AND status = 'waiting' ORDER BY updated_at DESC`).all(agentId, userId) as ChatLoop[];
  }

  setChatLoop(l: { channelId: string; agentId: string; userId: string; status: ChatLoop["status"]; summary?: string; nudges?: number }): ChatLoop {
    const was = this.chatLoop(l.channelId);
    this.db
      .prepare("INSERT INTO chat_loops (channel_id, agent_id, user_id, status, summary, nudges, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET status = excluded.status, summary = excluded.summary, nudges = excluded.nudges, updated_at = excluded.updated_at")
      .run(l.channelId, l.agentId, l.userId, l.status, l.summary ?? was?.summary ?? "", l.nudges ?? was?.nudges ?? 0, now());
    return this.chatLoop(l.channelId)!;
  }

  checkbackOn(agentId: string, userId: string): boolean {
    return !this.db.prepare("SELECT 1 FROM checkback_off WHERE agent_id = ? AND user_id = ?").get(agentId, userId);
  }

  setCheckback(agentId: string, userId: string, on: boolean) {
    if (on) this.db.prepare("DELETE FROM checkback_off WHERE agent_id = ? AND user_id = ?").run(agentId, userId);
    else this.db.prepare("INSERT OR IGNORE INTO checkback_off (agent_id, user_id) VALUES (?, ?)").run(agentId, userId);
  }

  // --- web push ---------------------------------------------------------------------------------

  savePushSubscription(userId: string, endpoint: string, keys: { p256dh: string; auth: string }, prefs: PushPrefs = {}) {
    this.db.prepare("INSERT INTO push_subscriptions (endpoint, user_id, keys_json, prefs_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, prefs_json = excluded.prefs_json").run(endpoint, userId, JSON.stringify(keys), JSON.stringify(prefs), now());
  }

  deletePushSubscription(endpoint: string) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  pushSubscriptions(userId: string): { endpoint: string; keys: { p256dh: string; auth: string }; prefs: PushPrefs }[] {
    return (this.db.prepare("SELECT endpoint, keys_json, prefs_json FROM push_subscriptions WHERE user_id = ?").all(userId) as { endpoint: string; keys_json: string; prefs_json: string }[]).map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json), prefs: JSON.parse(r.prefs_json) }));
  }
}

export interface FileRecord {
  id: string;
  workspaceId: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  uploaderKind: string;
  uploaderId: string;
  channelId: string | null;
  createdAt: string;
}

type AgentRow = {
  id: string;
  workspace_id: string;
  handle: string;
  name: string;
  harness: HarnessId;
  model: string | null;
  node_id: string | null;
  computer_id: string | null;
  groups_json: string;
  instructions: string;
  settings_json: string;
  created_at: string;
};

type ComputerRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: ComputerKind;
  node_id: string | null;
  config_json: string;
  status: ComputerStatus;
  status_text: string;
  help_json: string | null;
  created_at: string;
};

function toComputer(r: ComputerRow): Computer {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    kind: r.kind,
    nodeId: r.node_id,
    config: JSON.parse(r.config_json),
    status: r.status,
    statusText: r.status_text,
    controller: null,
    help: r.help_json ? JSON.parse(r.help_json) : null,
    createdAt: r.created_at,
  };
}

type ApprovalRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string;
  thread_id: string | null;
  summary: string;
  details: string;
  status: Approval["status"];
  decided_by: string | null;
  note: string;
  created_at: string;
  decided_at: string | null;
  login_json: string | null;
  flow_json: string | null;
  storage_json: string | null;
  device_json?: string | null;
};

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    summary: r.summary,
    details: r.details,
    status: r.status,
    decidedBy: r.decided_by,
    note: r.note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    login: r.login_json ? JSON.parse(r.login_json) : null,
    flow: r.flow_json ? JSON.parse(r.flow_json) : null,
    storage: r.storage_json ? JSON.parse(r.storage_json) : null,
    device: r.device_json ? JSON.parse(r.device_json) : null,
  };
}

type RoutineRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  note_path: string;
  schedule: string | null;
  timezone: string;
  channel_id: string | null;
  enabled: number;
  status: Routine["status"];
  created_by_kind: "user" | "agent";
  created_by_id: string;
  last_run_at: string | null;
  last_completed_at: string | null;
  created_at: string;
};

function toRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    name: r.name,
    notePath: r.note_path,
    schedule: r.schedule,
    timezone: r.timezone,
    channelId: r.channel_id,
    enabled: !!r.enabled,
    status: r.status,
    createdBy: { kind: r.created_by_kind, id: r.created_by_id },
    lastRunAt: r.last_run_at,
    lastCompletedAt: r.last_completed_at,
    createdAt: r.created_at,
  };
}

function toAgent(r: AgentRow): Agent & { instructions: string } {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    handle: r.handle,
    name: r.name,
    harness: r.harness,
    model: r.model,
    nodeId: r.node_id,
    computerId: r.computer_id ?? null,
    settings: JSON.parse(r.settings_json ?? "{}"),
    instructions: r.instructions,
    status: "offline",
    createdAt: r.created_at,
  };
}

type MessageRow = {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_kind: "user" | "agent";
  author_id: string;
  body: string;
  parts_json: string;
  hop: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  conversation_id?: string | null;
  context_id?: string | null;
};

/** A message as stored; `contextId` is turned into `context` (with its start time) by withReplyQuote. */
function toMessage(r: MessageRow): Message & { contextId?: string } {
  return {
    id: r.id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    author: { kind: r.author_kind, id: r.author_id } as Actor,
    body: r.body,
    parts: JSON.parse(r.parts_json),
    hop: r.hop,
    createdAt: r.created_at,
    ...(r.edited_at ? { editedAt: r.edited_at } : {}),
    ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
    ...(r.reply_to_id ? { replyToId: r.reply_to_id } : {}),
    ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
    ...(r.context_id ? { contextId: r.context_id } : {}),
  };
}

type TaskRow = {
  id: string;
  workspace_id: string;
  from_kind: "user" | "agent";
  from_id: string;
  to_agent_id: string | null;
  title: string;
  brief: string;
  status: string;
  result: string | null;
  channel_id: string | null;
  thread_id: string | null;
  team_id: string | null;
  branch: string | null;
  review_of: string | null;
  merged_at: string | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
};

type DiscussionRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_id: string;
  team_id: string | null;
  topic: string;
  goal: string;
  participants_json: string;
  moderator_id: string;
  rounds: number;
  round: number;
  status: Discussion["status"];
  decision_path: string | null;
  started_by_kind: "user" | "agent";
  started_by_id: string;
  requested_by: string | null;
  kind: "plan" | null;
  created_at: string;
  updated_at: string;
};

function toDiscussion(r: DiscussionRow): Discussion {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    teamId: r.team_id,
    topic: r.topic,
    goal: r.goal,
    participants: JSON.parse(r.participants_json),
    moderatorId: r.moderator_id,
    rounds: r.rounds,
    round: r.round,
    status: r.status,
    decisionPath: r.decision_path,
    startedBy: { kind: r.started_by_kind, id: r.started_by_id } as Actor,
    requestedBy: r.requested_by,
    kind: r.kind ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTask(r: TaskRow) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    from: { kind: r.from_kind, id: r.from_id } as Actor,
    /** who does it; null once that agent was removed (finished tasks outlive their agent) */
    toAgentId: r.to_agent_id,
    title: r.title,
    brief: r.brief,
    status: r.status as "open" | "in_progress" | "done" | "failed",
    result: r.result,
    channelId: r.channel_id,
    threadId: r.thread_id,
    teamId: r.team_id,
    branch: r.branch,
    reviewOf: r.review_of,
    mergedAt: r.merged_at,
    /** the task this is a piece of (a subtask the parent's agent handed out); null at the top */
    parentId: r.parent_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type RuleRow = {
  id: string;
  workspace_id: string;
  path: string;
  subject: string;
  level: MemoryLevel;
  startup: number;
  created_by_kind: string | null;
  created_by_id: string | null;
};

/** Empty when the subject can't be parsed, so one bad row can't break access checks. */
function toRule(r: RuleRow): AccessRule[] {
  const subject = parseSubjectKey(r.subject);
  if (!subject) return [];
  const createdBy: Actor | undefined = r.created_by_kind === "user" || r.created_by_kind === "agent" ? { kind: r.created_by_kind, id: r.created_by_id ?? "" } : undefined;
  return [{ id: r.id, path: r.path, subject, level: r.level, startup: !!r.startup, ...(createdBy ? { createdBy } : {}) }];
}

export interface Invite {
  id: string;
  workspaceId: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
  revoked: number;
}
