import crypto from "node:crypto";
import Database from "better-sqlite3";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','member','guest')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS device_invites (
  hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, last_seen TEXT, catalog_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  handle TEXT NOT NULL, name TEXT NOT NULL, harness TEXT NOT NULL, model TEXT,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  groups_json TEXT NOT NULL DEFAULT '[]', instructions TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, handle)
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('session','agent','node')),
  subject_id TEXT NOT NULL, workspace_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, last_used TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('channel','dm')), topic TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('user','agent')), member_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_kind, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id TEXT, author_kind TEXT NOT NULL, author_id TEXT NOT NULL,
  body TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]', hop INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, thread_id TEXT, trigger_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  hop INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','in_progress','done','failed')),
  result TEXT, channel_id TEXT, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  team_id TEXT, branch TEXT, review_of TEXT, merged_at TEXT, parent_id TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_json TEXT NOT NULL, grantee_json TEXT NOT NULL, perms_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS access_rules (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL, path_key TEXT NOT NULL, subject TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('none','read','edit','manage')), startup INTEGER NOT NULL DEFAULT 0,
  created_by_kind TEXT, created_by_id TEXT, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, path_key, subject)
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  lead_id TEXT REFERENCES agents(id) ON DELETE SET NULL, reports_to TEXT REFERENCES agents(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL, folder TEXT NOT NULL,
  repo TEXT, base_branch TEXT NOT NULL DEFAULT 'main', created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT '', role_notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (team_id, agent_id)
);
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL, topic TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
  participants_json TEXT NOT NULL, moderator_id TEXT NOT NULL, rounds INTEGER NOT NULL, round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running','summarizing','done','cancelled')), decision_path TEXT,
  started_by_kind TEXT NOT NULL, started_by_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, actor_kind, actor_id, emoji)
);
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('device','vm','orgo')),
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE, config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready', status_text TEXT NOT NULL DEFAULT '',
  help_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_id TEXT, summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')), decided_by TEXT, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT NOT NULL, note_path TEXT NOT NULL,
  schedule TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ready',
  created_by_kind TEXT NOT NULL, created_by_id TEXT NOT NULL, last_run_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner','member','guest')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_by TEXT, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS computer_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, computer_id TEXT NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS computer_log_by_computer ON computer_log(computer_id, id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  uploader_kind TEXT NOT NULL, uploader_id TEXT NOT NULL, channel_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mcp-stdio','mcp-http','secret')), catalog_id TEXT,
  command TEXT, args_json TEXT NOT NULL DEFAULT '[]', url TEXT, headers_json TEXT NOT NULL DEFAULT '{}',
  env_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS agent_connectors (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, connector_id)
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('catalog','custom','taught','learned')), catalog_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES tokens(hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'ios',
  bundle_id TEXT, environment TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_devices_by_user ON push_devices(user_id);
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);
CREATE TABLE IF NOT EXISTS background (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1, every_minutes INTEGER NOT NULL DEFAULT 60,
  quiet_start TEXT NOT NULL DEFAULT '22:00', quiet_end TEXT NOT NULL DEFAULT '07:00',
  next_at TEXT, next_reason TEXT NOT NULL DEFAULT '', last_at TEXT, last_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, user_id)
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id TEXT,
  due_at TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS followups_due ON followups(status, due_at);
CREATE TABLE IF NOT EXISTS chat_loops (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open','waiting','done','closed')), summary TEXT NOT NULL DEFAULT '',
  nudges INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkback_off (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, user_id)
);
CREATE TABLE IF NOT EXISTS connector_auth (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  required INTEGER NOT NULL DEFAULT 1, redirect_url TEXT, client_json TEXT, tokens_json TEXT, expires_at TEXT,
  verifier TEXT, state TEXT, signed_in_by TEXT, error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY, secret_hash TEXT, name TEXT NOT NULL DEFAULT '', redirect_uris_json TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used TEXT
);
CREATE TABLE IF NOT EXISTS vault_tokens (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used TEXT
);
CREATE TABLE IF NOT EXISTS channel_prefs (
  user_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  notify TEXT NOT NULL DEFAULT 'default', starred INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by_kind TEXT NOT NULL, pinned_by_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_id)
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, lines_json TEXT NOT NULL, undo_json TEXT NOT NULL,
  created_at TEXT NOT NULL, undone_at TEXT
);
CREATE INDEX IF NOT EXISTS changes_by_user ON changes(workspace_id, user_id, created_at);
CREATE TABLE IF NOT EXISTS model_connections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('oauth','key')), label TEXT NOT NULL,
  account TEXT, plan TEXT, secret_json TEXT NOT NULL, usage_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS model_connections_by_user ON model_connections(workspace_id, user_id);
CREATE TABLE IF NOT EXISTS computer_catalogs (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, computer_id TEXT NOT NULL,
  catalog_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, computer_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

/** Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS won't add them to existing databases. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  // the message a reply quotes (an inline quote, not a thread)
  ["messages", "reply_to_id", "TEXT"],
  ["push_subscriptions", "prefs_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["agents", "settings_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["nodes", "catalog_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["channels", "section_id", "TEXT"],
  ["channels", "private", "INTEGER NOT NULL DEFAULT 0"],
  ["channels", "archived_at", "TEXT"],
  ["channels", "settings_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["runs", "usage_json", "TEXT"],
  ["runs", "discussion_id", "TEXT"],
  ["runs", "phase", "TEXT"],
  ["tasks", "team_id", "TEXT"],
  ["tasks", "branch", "TEXT"],
  ["tasks", "review_of", "TEXT"],
  ["tasks", "merged_at", "TEXT"],
  ["teams", "emoji", "TEXT NOT NULL DEFAULT ''"],
  ["team_members", "manager_id", "TEXT"],
  ["team_members", "x", "REAL"],
  ["team_members", "y", "REAL"],
  ["agents", "computer_id", "TEXT"],
  ["nodes", "capabilities_json", "TEXT"],
  ["nodes", "discovered_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["nodes", "owner_id", "TEXT"],
  ["nodes", "shared", "INTEGER NOT NULL DEFAULT 0"],
  ["runs", "requested_by", "TEXT"],
  ["tokens", "created_by", "TEXT"],
  ["tokens", "expires_at", "TEXT"],
  ["nodes", "role", "TEXT"],
  ["users", "preferred_name", "TEXT"],
  ["users", "timezone", "TEXT"],
  ["users", "prefs_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["discussions", "requested_by", "TEXT"],
  ["tasks", "parent_id", "TEXT"],
  ["runs", "kind", "TEXT"],
  ["background", "focus", "TEXT NOT NULL DEFAULT ''"],
  ["background", "model", "TEXT"],
  ["background", "effort", "TEXT"],
  // NULL means no limit, so existing rows get the default of 24 from the column itself
  ["background", "daily_cap", "INTEGER DEFAULT 24"],
  ["background", "quiet_streak", "INTEGER NOT NULL DEFAULT 0"],
  // from when agents could borrow a device's screen; only migrateLoans reads it now
  ["approvals", "loan_json", "TEXT"],
  ["approvals", "login_json", "TEXT"],
  // an ask-me step of a team's flow: which request and step this approval answers
  ["approvals", "flow_json", "TEXT"],
  // last_run_at is when a run was requested; this is when one actually finished
  ["routines", "last_completed_at", "TEXT"],
  ["messages", "edited_at", "TEXT"],
  ["messages", "deleted_at", "TEXT"],
  ["discussions", "kind", "TEXT"],
  // the remote desktop app its owner already uses (OwnRemoteDesktop), shown to them only
  ["nodes", "remote_desktop_json", "TEXT"],
  // what a follow-up looks like under the reply that set it, and whose move it is
  ["followups", "label", "TEXT"],
  ["followups", "waiting_on", "TEXT NOT NULL DEFAULT 'agent'"],
  ["followups", "condition", "TEXT NOT NULL DEFAULT ''"],
  ["followups", "kind", "TEXT NOT NULL DEFAULT 'followup'"],
  ["followups", "channel_id", "TEXT"],
  ["followups", "message_id", "TEXT"],
  ["followups", "run_id", "TEXT"],
  // on for every agent in the workspace, including ones made later
  ["skills", "all_agents", "INTEGER NOT NULL DEFAULT 0"],
  ["connectors", "all_agents", "INTEGER NOT NULL DEFAULT 0"],
  // a skill an agent saved on its own: who, and how often runs read it
  ["skills", "learned_by", "TEXT"],
  ["skills", "uses", "INTEGER NOT NULL DEFAULT 0"],
  ["skills", "last_used_at", "TEXT"],
];

/** How long a connection token for an agent lasts (POST /api/agents/:id/token). */
export const AGENT_TOKEN_TTL_MS = 90 * 86_400_000;

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec(SCHEMA);
  const added = new Set<string>();
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      added.add(`${table}.${column}`);
    }
  }
  migrateGrants(db);
  migrateGroups(db);
  migrateNodeOwners(db);
  if (added.has("nodes.role")) migrateNodeRoles(db);
  migrateTaskAssignee(db);
  migrateSkillSources(db);
  migrateLoans(db);
  dropOrphanChannelMembers(db);
  expireOldAgentTokens(db);
  return db;
}

/** Connection tokens for agents used to last forever; ones from then get the same limit as new ones. */
function expireOldAgentTokens(db: Database.Database) {
  db.prepare("UPDATE tokens SET expires_at = ? WHERE kind = 'agent' AND label = 'mcp' AND expires_at IS NULL").run(new Date(Date.now() + AGENT_TOKEN_TTL_MS).toISOString());
}

/** Deleted agents and removed people used to stay in channel_members, inflating member counts. */
function dropOrphanChannelMembers(db: Database.Database) {
  db.exec(`
    DELETE FROM channel_members WHERE member_kind = 'agent' AND NOT EXISTS
      (SELECT 1 FROM agents a JOIN channels c ON c.workspace_id = a.workspace_id WHERE a.id = member_id AND c.id = channel_id);
    DELETE FROM channel_members WHERE member_kind = 'user' AND NOT EXISTS
      (SELECT 1 FROM memberships s JOIN channels c ON c.workspace_id = s.workspace_id WHERE s.user_id = member_id AND c.id = channel_id);
  `);
}

/**
 * Agents used to borrow a device's screen, or have it lent to them. Now only agents that run on a
 * device use its screen, so old lends and loans go, and requests nobody answered are turned down.
 */
function migrateLoans(db: Database.Database) {
  db.prepare(`UPDATE approvals SET status = 'denied', note = 'Agents no longer borrow devices; run an agent on the device instead.', decided_at = ? WHERE status = 'pending' AND loan_json IS NOT NULL`).run(new Date().toISOString());
  const rows = db.prepare(`SELECT id, config_json FROM computers WHERE kind = 'device' AND (config_json LIKE '%"lend"%' OR config_json LIKE '%"loan"%')`).all() as { id: string; config_json: string }[];
  const update = db.prepare("UPDATE computers SET config_json = ? WHERE id = ?");
  for (const r of rows) {
    const { lend: _lend, loan: _loan, ...config } = JSON.parse(r.config_json) as Record<string, unknown>;
    update.run(JSON.stringify(config), r.id);
  }
}

/**
 * Tasks used to vanish with their agent (ON DELETE CASCADE on a NOT NULL to_agent_id). Finished
 * work should outlive the agent that did it, so the column becomes nullable and is cleared instead.
 * SQLite can't change a column's constraints in place, so the table is rebuilt once.
 */
function migrateTaskAssignee(db: Database.Database) {
  const fk = (db.prepare("PRAGMA foreign_key_list(tasks)").all() as { from: string; on_delete: string }[]).find((f) => f.from === "to_agent_id");
  if (!fk || fk.on_delete === "SET NULL") return;
  const columns = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name).join(", ");
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`CREATE TABLE tasks_new (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','in_progress','done','failed')),
      result TEXT, channel_id TEXT, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      team_id TEXT, branch TEXT, review_of TEXT, merged_at TEXT, parent_id TEXT
    )`);
    db.exec(`INSERT INTO tasks_new (${columns}) SELECT ${columns} FROM tasks`);
    db.exec("DROP TABLE tasks");
    db.exec("ALTER TABLE tasks_new RENAME TO tasks");
  })();
  db.pragma("foreign_keys = ON");
}

/**
 * Skills agents learn on their own are source 'learned', which the first CHECK on skills.source
 * didn't allow. SQLite can't change a CHECK in place, so the table is rebuilt once; agent_skills
 * points at it by id and keeps its rows (foreign keys are off while it's swapped).
 */
function migrateSkillSources(db: Database.Database) {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skills'").get() as { sql: string } | undefined)?.sql ?? "";
  if (sql.includes("'learned'")) return;
  const columns = (db.prepare("PRAGMA table_info(skills)").all() as { name: string }[]).map((c) => c.name).join(", ");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE skills_new (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('catalog','custom','taught','learned')), catalog_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        all_agents INTEGER NOT NULL DEFAULT 0, learned_by TEXT, uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
        UNIQUE (workspace_id, slug)
      )`);
      db.exec(`INSERT INTO skills_new (${columns}) SELECT ${columns} FROM skills`);
      db.exec("DROP TABLE skills");
      db.exec("ALTER TABLE skills_new RENAME TO skills");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** Devices from before they had a role: the ones already running agents' VMs do that. */
function migrateNodeRoles(db: Database.Database) {
  db.prepare(`UPDATE nodes SET role = 'vms' WHERE role IS NULL AND EXISTS (SELECT 1 FROM computers c WHERE c.node_id = nodes.id AND c.kind = 'vm')`).run();
}

/** Devices from before they had owners belong to the workspace's first owner. */
function migrateNodeOwners(db: Database.Database) {
  db.prepare(
    `UPDATE nodes SET owner_id = (SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = nodes.workspace_id AND m.role = 'owner' ORDER BY u.created_at LIMIT 1)
     WHERE owner_id IS NULL`,
  ).run();
}

/**
 * v0.1 groups were free-text labels on agents sharing groups/<name>/. They become teams that
 * keep that folder, and rules naming a group now name the team.
 */
function migrateGroups(db: Database.Database) {
  const agents = db.prepare("SELECT id, workspace_id, groups_json FROM agents WHERE groups_json != '[]'").all() as { id: string; workspace_id: string; groups_json: string }[];
  db.transaction(() => {
    for (const a of agents) {
      for (const raw of JSON.parse(a.groups_json) as string[]) {
        const name = raw.trim().toLowerCase();
        if (!name) continue;
        let team = db.prepare("SELECT id FROM teams WHERE workspace_id = ? AND name = ?").get(a.workspace_id, name) as { id: string } | undefined;
        if (!team) {
          team = { id: `team_${crypto.randomBytes(9).toString("base64url")}` };
          db.prepare("INSERT INTO teams (id, workspace_id, name, folder, created_at) VALUES (?, ?, ?, ?, ?)").run(team.id, a.workspace_id, name, `groups/${raw.trim()}`, new Date().toISOString());
        }
        db.prepare("INSERT OR IGNORE INTO team_members (team_id, agent_id) VALUES (?, ?)").run(team.id, a.id);
      }
      db.prepare("UPDATE agents SET groups_json = '[]' WHERE id = ?").run(a.id);
    }
    db.prepare("UPDATE OR IGNORE access_rules SET subject = 'team:' || substr(subject, 7) WHERE subject LIKE 'group:%'").run();
    db.prepare("DELETE FROM access_rules WHERE subject LIKE 'group:%'").run();
  })();
}

/** v0.1 shared memory per scope ("grants"); those become access rules on the scope's folder. */
function migrateGrants(db: Database.Database) {
  const rows = db.prepare("SELECT id, workspace_id, scope_json, grantee_json, perms_json, created_at FROM grants").all() as {
    id: string;
    workspace_id: string;
    scope_json: string;
    grantee_json: string;
    perms_json: string;
    created_at: string;
  }[];
  if (!rows.length) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO access_rules (id, workspace_id, path, path_key, subject, level, startup, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
  );
  db.transaction(() => {
    for (const r of rows) {
      const scope = JSON.parse(r.scope_json) as { kind: string; name?: string; id?: string };
      const grantee = JSON.parse(r.grantee_json) as { kind: string; name?: string; id?: string };
      const path = scope.kind === "workspace" ? "shared" : scope.kind === "group" ? `groups/${scope.name}` : `agents/${scope.id}`;
      const subject = grantee.kind === "all_agents" ? "all_agents" : grantee.kind === "group" ? `team:${grantee.name?.toLowerCase()}` : `agent:${grantee.id}`;
      const level = (JSON.parse(r.perms_json) as string[]).includes("write") ? "edit" : "read";
      insert.run(r.id.replace(/^grt_/, "rule_"), r.workspace_id, path, path.toLowerCase(), subject, level, r.created_at);
    }
    db.prepare("DELETE FROM grants").run();
  })();
}

export type Db = Database.Database;
