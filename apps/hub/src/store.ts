import { cleanRulePath, parseSubjectKey, subjectKey, teamRoots, type AccessRule, type Actor, type Agent, type AgentSettings, type Approval, type Channel, type Computer, type ComputerConfig, type ComputerKind, type ComputerStatus, type ContextUsage, type DeviceCapabilities, type Discussion, type DiscoveredAgent, type HarnessCatalog, type Team, type HarnessId, type MemoryLevel, type Message, type MessagePart, type Reaction, type Role, type Routine, type Section, type Subject, type User, type UserPrefs, type DeviceRole, type BackgroundWork, type Followup } from "@warren/core";
import { id, now } from "./auth.ts";
import type { Db } from "./db.ts";

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
    return w;
  }

  workspace(wsId: string) {
    return this.db.prepare("SELECT id, name, created_at AS createdAt FROM workspaces WHERE id = ?").get(wsId) as { id: string; name: string; createdAt: string } | undefined;
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

  setNodeShared(nodeId: string, shared: boolean) {
    this.db.prepare("UPDATE nodes SET shared = ? WHERE id = ?").run(shared ? 1 : 0, nodeId);
  }

  setNodeRole(nodeId: string, role: DeviceRole | null) {
    this.db.prepare("UPDATE nodes SET role = ? WHERE id = ?").run(role, nodeId);
  }

  setNodeCatalog(nodeId: string, catalog: HarnessCatalog[]) {
    this.db.prepare("UPDATE nodes SET catalog_json = ? WHERE id = ?").run(JSON.stringify(catalog), nodeId);
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

  createAgent(a: { workspaceId: string; handle: string; name: string; harness: HarnessId; model?: string | null; nodeId?: string | null; computerId?: string | null; groups?: string[]; instructions?: string }) {
    const agentId = id("agt");
    this.db
      .prepare("INSERT INTO agents (id, workspace_id, handle, name, harness, model, node_id, computer_id, groups_json, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)")
      .run(agentId, a.workspaceId, a.handle.toLowerCase(), a.name, a.harness, a.model ?? null, a.nodeId ?? null, a.computerId ?? null, a.instructions ?? "", now());
    if (a.groups?.length) this.setAgentTeams(agentId, a.groups);
    return this.agent(agentId)!;
  }

  /** `settings` is merged key by key, so callers can change one setting at a time. */
  updateAgent(agentId: string, patch: Partial<{ name: string; model: string | null; nodeId: string | null; computerId: string | null; groups: string[]; instructions: string; harness: HarnessId; settings: AgentSettings }>) {
    const cur = this.agentRow(agentId);
    if (!cur) return undefined;
    if (patch.groups) this.setAgentTeams(agentId, patch.groups);
    this.db
      .prepare("UPDATE agents SET name = ?, model = ?, node_id = ?, computer_id = ?, instructions = ?, harness = ?, settings_json = ? WHERE id = ?")
      .run(
        patch.name ?? cur.name,
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
    })();
  }

  // --- approvals ------------------------------------------------------------

  createApproval(a: { workspaceId: string; agentId: string; channelId: string; threadId: string | null; summary: string; details: string }): Approval {
    const approvalId = id("apr");
    this.db
      .prepare("INSERT INTO approvals (id, workspace_id, agent_id, channel_id, thread_id, summary, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(approvalId, a.workspaceId, a.agentId, a.channelId, a.threadId, a.summary, a.details, now());
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

  /** Rows to agents, with `groups` filled from the teams they're on. */
  private toAgents(rows: (AgentRow | undefined)[]): (Agent & { instructions: string })[] {
    const list = rows.filter((r): r is AgentRow => !!r);
    if (!list.length) return [];
    const ids = list.map((r) => r.id);
    const memberships = this.db
      .prepare(`SELECT tm.agent_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.agent_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`)
      .all(...ids) as { agent_id: string; name: string }[];
    return list.map((r) => toAgent(r, memberships.filter((m) => m.agent_id === r.id).map((m) => m.name)));
  }

  // --- teams ----------------------------------------------------------------

  teams(workspaceId: string): Team[] {
    return this.withMembers(this.db.prepare("SELECT * FROM teams WHERE workspace_id = ? ORDER BY name").all(workspaceId) as TeamRow[]);
  }

  team(teamId: string): Team | undefined {
    return this.withMembers([this.db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as TeamRow | undefined].filter((r): r is TeamRow => !!r))[0];
  }

  teamByName(workspaceId: string, name: string): Team | undefined {
    return this.withMembers([this.db.prepare("SELECT * FROM teams WHERE workspace_id = ? AND name = ?").get(workspaceId, name.toLowerCase()) as TeamRow | undefined].filter((r): r is TeamRow => !!r))[0];
  }

  createTeam(t: { workspaceId: string; name: string; emoji?: string; description?: string; leadId?: string | null; reportsTo?: string | null; channelId?: string | null; folder?: string; repo?: string | null; baseBranch?: string }): Team {
    const teamId = id("team");
    const name = teamSlug(t.name);
    this.db
      .prepare("INSERT INTO teams (id, workspace_id, name, emoji, description, lead_id, reports_to, channel_id, folder, repo, base_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(teamId, t.workspaceId, name, t.emoji ?? "", t.description ?? "", t.leadId ?? null, t.reportsTo ?? null, t.channelId ?? null, t.folder ?? `teams/${name}`, t.repo ?? null, t.baseBranch ?? "main", now());
    if (t.leadId) this.setTeamMember(teamId, t.leadId, {});
    return this.team(teamId)!;
  }

  updateTeam(teamId: string, patch: Partial<{ emoji: string; description: string; leadId: string | null; reportsTo: string | null; channelId: string | null; repo: string | null; baseBranch: string }>) {
    const cur = this.team(teamId);
    if (!cur) return undefined;
    const pick = <K extends keyof typeof patch>(k: K, fallback: (typeof patch)[K]) => (patch[k] !== undefined ? patch[k] : fallback);
    this.db
      .prepare("UPDATE teams SET emoji = ?, description = ?, lead_id = ?, reports_to = ?, channel_id = ?, repo = ?, base_branch = ? WHERE id = ?")
      .run(pick("emoji", cur.emoji), pick("description", cur.description), pick("leadId", cur.leadId), pick("reportsTo", cur.reportsTo), pick("channelId", cur.channelId), pick("repo", cur.repo), pick("baseBranch", cur.baseBranch), teamId);
    if (patch.leadId) {
      // the lead is the top of the chart: it reports to no one on the team, and whoever was at the top now reports to it
      this.setTeamMember(teamId, patch.leadId, { managerId: null });
      for (const r of teamRoots(this.team(teamId)!)) if (r.agentId !== patch.leadId) this.setTeamMember(teamId, r.agentId, { managerId: patch.leadId });
    }
    return this.team(teamId);
  }

  deleteTeam(teamId: string) {
    this.db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
  }

  /** Add an agent to a team, or change its role, who it reports to, or where it sits on the chart. Left-out fields stay as they are. */
  setTeamMember(teamId: string, agentId: string, m: { role?: string; roleNotes?: string; managerId?: string | null; x?: number | null; y?: number | null }) {
    const cur = this.db.prepare("SELECT role, role_notes, manager_id, x, y FROM team_members WHERE team_id = ? AND agent_id = ?").get(teamId, agentId) as
      | { role: string; role_notes: string; manager_id: string | null; x: number | null; y: number | null }
      | undefined;
    const next = {
      role: m.role ?? cur?.role ?? "",
      notes: m.roleNotes ?? cur?.role_notes ?? "",
      manager: m.managerId !== undefined ? m.managerId : (cur?.manager_id ?? null),
      x: m.x !== undefined ? m.x : (cur?.x ?? null),
      y: m.y !== undefined ? m.y : (cur?.y ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO team_members (team_id, agent_id, role, role_notes, manager_id, x, y) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id, agent_id) DO UPDATE SET role = excluded.role, role_notes = excluded.role_notes, manager_id = excluded.manager_id, x = excluded.x, y = excluded.y`,
      )
      .run(teamId, agentId, next.role, next.notes, next.manager, next.x, next.y);
    if (!cur || m.managerId !== undefined) this.settleLead(teamId);
  }

  /** Remove an agent from a team; whoever reported to it now reports to its manager. */
  removeTeamMember(teamId: string, agentId: string) {
    this.db.transaction(() => {
      const gone = this.db.prepare("SELECT manager_id FROM team_members WHERE team_id = ? AND agent_id = ?").get(teamId, agentId) as { manager_id: string | null } | undefined;
      this.db.prepare("UPDATE team_members SET manager_id = ? WHERE team_id = ? AND manager_id = ?").run(gone?.manager_id ?? null, teamId, agentId);
      this.db.prepare("DELETE FROM team_members WHERE team_id = ? AND agent_id = ?").run(teamId, agentId);
      this.db.prepare("UPDATE teams SET lead_id = NULL WHERE id = ? AND lead_id = ?").run(teamId, agentId);
    })();
    this.settleLead(teamId);
  }

  /** Save where cards sit on the team chart. */
  setTeamLayout(teamId: string, positions: { agentId: string; x: number; y: number }[]) {
    const upd = this.db.prepare("UPDATE team_members SET x = ?, y = ? WHERE team_id = ? AND agent_id = ?");
    this.db.transaction(() => positions.forEach((p) => upd.run(p.x, p.y, teamId, p.agentId)))();
  }

  /**
   * The lead is whoever sits alone at the top of the chart. With several agents at the top,
   * the lead stays who it was (or the first of them, if it left).
   */
  private settleLead(teamId: string) {
    const team = this.team(teamId);
    if (!team) return;
    const roots = teamRoots(team);
    const lead = roots.length === 1 ? roots[0].agentId : team.members.some((m) => m.agentId === team.leadId) ? team.leadId : (roots[0]?.agentId ?? null);
    if (lead !== team.leadId) this.db.prepare("UPDATE teams SET lead_id = ? WHERE id = ?").run(lead, teamId);
  }

  /** Put an agent on exactly these teams (by name), creating teams that don't exist yet. */
  setAgentTeams(agentId: string, names: string[]) {
    const row = this.agentRow(agentId);
    if (!row) return;
    const wanted = new Set(names.map(teamSlug).filter(Boolean));
    for (const t of this.teams(row.workspace_id)) if (!wanted.has(t.name) && t.members.some((m) => m.agentId === agentId)) this.removeTeamMember(t.id, agentId);
    for (const name of wanted) {
      const team = this.teamByName(row.workspace_id, name) ?? this.createTeam({ workspaceId: row.workspace_id, name });
      this.setTeamMember(team.id, agentId, {});
    }
  }

  private withMembers(rows: TeamRow[]): Team[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const members = this.db
      .prepare(`SELECT tm.team_id, tm.agent_id, tm.role, tm.role_notes, tm.manager_id, tm.x, tm.y FROM team_members tm JOIN agents a ON a.id = tm.agent_id WHERE tm.team_id IN (${ids.map(() => "?").join(",")}) ORDER BY a.handle`)
      .all(...ids) as { team_id: string; agent_id: string; role: string; role_notes: string; manager_id: string | null; x: number | null; y: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      emoji: r.emoji ?? "",
      description: r.description,
      leadId: r.lead_id,
      reportsTo: r.reports_to,
      channelId: r.channel_id,
      folder: r.folder,
      repo: r.repo,
      baseBranch: r.base_branch,
      members: members.filter((m) => m.team_id === r.id).map((m) => ({ agentId: m.agent_id, role: m.role, roleNotes: m.role_notes, managerId: m.manager_id, x: m.x, y: m.y })),
      createdAt: r.created_at,
    }));
  }

  // --- channels -------------------------------------------------------------

  createChannel(workspaceId: string, name: string, kind: Channel["kind"] = "channel", topic = ""): Channel {
    const c: Channel = { id: id("ch"), workspaceId, name, kind, topic, sectionId: null, createdAt: now() };
    this.db.prepare("INSERT INTO channels (id, workspace_id, name, kind, topic, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, workspaceId, name, kind, topic, c.createdAt);
    return c;
  }

  channel(channelId: string): Channel | undefined {
    return this.db.prepare("SELECT id, workspace_id AS workspaceId, name, kind, topic, section_id AS sectionId, created_at AS createdAt FROM channels WHERE id = ?").get(channelId) as Channel | undefined;
  }

  channelByName(workspaceId: string, name: string): Channel | undefined {
    return this.db.prepare("SELECT id, workspace_id AS workspaceId, name, kind, topic, section_id AS sectionId, created_at AS createdAt FROM channels WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as
      | Channel
      | undefined;
  }

  channels(workspaceId: string): Channel[] {
    return this.db.prepare("SELECT id, workspace_id AS workspaceId, name, kind, topic, section_id AS sectionId, created_at AS createdAt FROM channels WHERE workspace_id = ? ORDER BY kind, name").all(workspaceId) as Channel[];
  }

  updateChannel(channelId: string, patch: { name?: string; topic?: string; sectionId?: string | null }) {
    const cur = this.channel(channelId);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE channels SET name = ?, topic = ?, section_id = ? WHERE id = ?")
      .run(patch.name ?? cur.name, patch.topic ?? cur.topic, patch.sectionId !== undefined ? patch.sectionId : cur.sectionId, channelId);
    return this.channel(channelId);
  }

  memberCounts(channelIds: string[]): Record<string, number> {
    if (!channelIds.length) return {};
    const rows = this.db
      .prepare(`SELECT channel_id, COUNT(*) AS n FROM channel_members WHERE channel_id IN (${channelIds.map(() => "?").join(",")}) GROUP BY channel_id`)
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
    if (existing) return existing;
    const c = this.createChannel(workspaceId, name, "dm");
    this.addChannelMember(c.id, { kind: "user", id: userId });
    this.addChannelMember(c.id, { kind: "agent", id: agentId });
    return c;
  }

  // --- messages -------------------------------------------------------------

  insertMessage(m: { channelId: string; threadId?: string | null; author: Actor; body: string; parts?: MessagePart[]; hop?: number }): Message {
    const msg: Message = { id: id("msg"), channelId: m.channelId, threadId: m.threadId ?? null, author: m.author, body: m.body, parts: m.parts ?? [], hop: m.hop ?? 0, createdAt: now() };
    this.db
      .prepare("INSERT INTO messages (id, channel_id, thread_id, author_kind, author_id, body, parts_json, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(msg.id, msg.channelId, msg.threadId, msg.author.kind, msg.author.id, msg.body, JSON.stringify(msg.parts), msg.hop, msg.createdAt);
    return msg;
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

  /** Messages with their reactions attached. */
  withReactions(messages: Message[]): Message[] {
    const r = this.reactions(messages.map((m) => m.id));
    return messages.map((m) => ({ ...m, reactions: r[m.id] ?? [] }));
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
  createRun(r: { agentId: string; channelId: string; threadId: string | null; triggerMessageId: string; hop: number; discussionId?: string; phase?: string; requestedBy?: string | null; kind?: "background" }) {
    const runId = id("run");
    this.db
      .prepare("INSERT INTO runs (id, agent_id, channel_id, thread_id, trigger_message_id, status, hop, discussion_id, phase, requested_by, kind, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)")
      .run(runId, r.agentId, r.channelId, r.threadId, r.triggerMessageId, r.hop, r.discussionId ?? null, r.phase ?? null, r.requestedBy ?? null, r.kind ?? null, now());
    return runId;
  }

  run(runId: string) {
    return this.db
      .prepare(
        "SELECT id, agent_id AS agentId, channel_id AS channelId, thread_id AS threadId, trigger_message_id AS triggerMessageId, status, hop, discussion_id AS discussionId, phase, requested_by AS requestedBy, kind FROM runs WHERE id = ?",
      )
      .get(runId) as
      | { id: string; agentId: string; channelId: string; threadId: string | null; triggerMessageId: string; status: string; hop: number; discussionId: string | null; phase: string | null; requestedBy: string | null; kind: "background" | null }
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
        `INSERT INTO discussions (id, workspace_id, channel_id, thread_id, team_id, topic, goal, participants_json, moderator_id, rounds, round, status, started_by_kind, started_by_id, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(did, d.workspaceId, d.channelId, d.threadId, d.teamId, d.topic, d.goal, JSON.stringify(d.participants), d.moderatorId, d.rounds, d.startedBy.kind, d.startedBy.id, d.requestedBy ?? null, ts, ts);
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

  updateDiscussion(discussionId: string, patch: Partial<Pick<Discussion, "round" | "status" | "decisionPath">>) {
    const cur = this.discussion(discussionId);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE discussions SET round = ?, status = ?, decision_path = ?, updated_at = ? WHERE id = ?")
      .run(patch.round ?? cur.round, patch.status ?? cur.status, patch.decisionPath !== undefined ? patch.decisionPath : cur.decisionPath, now(), discussionId);
    return this.discussion(discussionId);
  }

  setRunStatus(runId: string, status: "running" | "done" | "failed" | "cancelled", error?: string) {
    const finished = status === "running" ? null : now();
    this.db.prepare("UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error ?? null, finished, runId);
  }

  queuedRunsForNode(nodeId: string) {
    return this.db
      .prepare("SELECT r.id FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.node_id = ? AND r.status = 'queued' ORDER BY r.created_at")
      .all(nodeId) as { id: string }[];
  }

  agentRuns(agentId: string, limit = 20) {
    return this.db
      .prepare(
        `SELECT r.id, r.status, r.error, r.created_at AS createdAt, r.finished_at AS finishedAt, r.channel_id AS channelId, r.thread_id AS threadId,
                c.name AS channelName, c.kind AS channelKind, m.body AS trigger
         FROM runs r LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN messages m ON m.id = r.trigger_message_id
         WHERE r.agent_id = ? ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as {
      id: string;
      status: string;
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
      .prepare("SELECT status, created_at AS createdAt, usage_json AS usage FROM runs WHERE agent_id = ? AND requested_by = ? AND kind = 'background' AND created_at >= ? ORDER BY created_at DESC")
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
    b.next_at AS nextAt, b.next_reason AS nextReason, b.last_at AS lastAt, b.last_note AS lastNote, b.model, b.effort, b.daily_cap AS dailyCap,
    EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = b.agent_id AND r.kind = 'background' AND r.requested_by = b.user_id AND r.status IN ('queued','running')) AS checking
    FROM background b`;
  private toBackground = (r: Record<string, unknown>): BackgroundWork => ({ ...(r as unknown as BackgroundWork), enabled: !!r.enabled, checking: !!r.checking });

  background(agentId: string, userId: string): BackgroundWork | undefined {
    const r = this.db.prepare(`${this.backgroundSql} WHERE b.agent_id = ? AND b.user_id = ?`).get(agentId, userId) as Record<string, unknown> | undefined;
    return r && this.toBackground(r);
  }

  /** Every person an agent works in the background for (turned on or not). */
  backgroundFor(agentId: string): BackgroundWork[] {
    return (this.db.prepare(`${this.backgroundSql} WHERE b.agent_id = ?`).all(agentId) as Record<string, unknown>[]).map(this.toBackground);
  }

  /** Background work that's on, across every workspace. */
  activeBackground(): BackgroundWork[] {
    return (this.db.prepare(`${this.backgroundSql} WHERE b.enabled = 1`).all() as Record<string, unknown>[]).map(this.toBackground);
  }

  setBackground(agentId: string, userId: string, patch: Partial<Pick<BackgroundWork, "enabled" | "everyMinutes" | "focus" | "quietStart" | "quietEnd" | "nextAt" | "nextReason" | "lastAt" | "lastNote" | "model" | "effort" | "dailyCap">>): BackgroundWork {
    this.db.prepare("INSERT OR IGNORE INTO background (agent_id, user_id, created_at) VALUES (?, ?, ?)").run(agentId, userId, now());
    const v = { ...this.background(agentId, userId)!, ...patch };
    this.db
      .prepare("UPDATE background SET enabled = ?, every_minutes = ?, focus = ?, quiet_start = ?, quiet_end = ?, next_at = ?, next_reason = ?, last_at = ?, last_note = ?, model = ?, effort = ?, daily_cap = ? WHERE agent_id = ? AND user_id = ?")
      .run(v.enabled ? 1 : 0, v.everyMinutes, v.focus, v.quietStart, v.quietEnd, v.nextAt, v.nextReason, v.lastAt, v.lastNote, v.model, v.effort, v.dailyCap, agentId, userId);
    return this.background(agentId, userId)!;
  }

  private followupSql = "SELECT id, agent_id AS agentId, user_id AS userId, due_at AS dueAt, note, status, created_at AS createdAt FROM followups";

  createFollowup(f: { agentId: string; userId: string | null; dueAt: string; note: string }): Followup {
    const fid = id("fup");
    this.db.prepare("INSERT INTO followups (id, agent_id, user_id, due_at, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(fid, f.agentId, f.userId, f.dueAt, f.note, now());
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

  // --- web push ---------------------------------------------------------------------------------

  savePushSubscription(userId: string, endpoint: string, keys: { p256dh: string; auth: string }) {
    this.db.prepare("INSERT INTO push_subscriptions (endpoint, user_id, keys_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json").run(endpoint, userId, JSON.stringify(keys), now());
  }

  deletePushSubscription(endpoint: string) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  pushSubscriptions(userId: string): { endpoint: string; keys: { p256dh: string; auth: string } }[] {
    return (this.db.prepare("SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id = ?").all(userId) as { endpoint: string; keys_json: string }[]).map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json) }));
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
    createdAt: r.created_at,
  };
}

function toAgent(r: AgentRow, teams: string[]): Agent & { instructions: string } {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    handle: r.handle,
    name: r.name,
    harness: r.harness,
    model: r.model,
    nodeId: r.node_id,
    computerId: r.computer_id ?? null,
    groups: teams,
    settings: JSON.parse(r.settings_json ?? "{}"),
    instructions: r.instructions,
    status: "offline",
    createdAt: r.created_at,
  };
}

type TeamRow = {
  id: string;
  workspace_id: string;
  name: string;
  emoji: string;
  description: string;
  lead_id: string | null;
  reports_to: string | null;
  channel_id: string | null;
  folder: string;
  repo: string | null;
  base_branch: string;
  created_at: string;
};

/** Team names are lowercase slugs: "Web Team" → "web-team". */
export function teamSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
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
};

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    author: { kind: r.author_kind, id: r.author_id } as Actor,
    body: r.body,
    parts: JSON.parse(r.parts_json),
    hop: r.hop,
    createdAt: r.created_at,
  };
}

type TaskRow = {
  id: string;
  workspace_id: string;
  from_kind: "user" | "agent";
  from_id: string;
  to_agent_id: string;
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTask(r: TaskRow) {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    from: { kind: r.from_kind, id: r.from_id } as Actor,
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
