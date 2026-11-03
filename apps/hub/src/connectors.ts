import { BUILTIN_SKILLS, BUILTIN_SKILL_SLUGS, catalogConnector, connectorSlug, fillTemplate, isMasked, maskSecret, type Connector, type ConnectorKind, type ConnectorSpec, type Skill, type SkillSource } from "@wisp/core";
import { id, now } from "./auth.ts";
import type { Db } from "./db.ts";
import { ConnectorAuth } from "./connector-auth.ts";

/**
 * Connectors (MCP servers and secrets agents can use) and skills (SKILL.md instructions agents
 * can follow), with which agents have each. SQL for both lives here, apart from the main store.
 */

type ConnectorRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: ConnectorKind;
  catalog_id: string | null;
  command: string | null;
  args_json: string;
  url: string | null;
  headers_json: string;
  env_json: string;
  enabled: number;
  all_agents: number;
  created_by: string | null;
  created_at: string;
};

export interface ConnectorInput {
  name: string;
  kind: ConnectorKind;
  catalogId?: string | null;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
  allAgents?: boolean;
}

/** A header value is a secret unless it only fills in `{{KEY}}`s (then the secret lives in env). */
const literalHeader = (v: string) => !/\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(v);

/** Values a catalog entry says aren't secret (a folder, a team ID, a URL). */
const plainFields = (catalogId: string | null) => new Set((catalogConnector(catalogId ?? "")?.fields ?? []).filter((f) => !f.secret).map((f) => f.key));

export class ConnectorStore {
  /** sign-ins to remote MCP servers */
  readonly auth: ConnectorAuth;

  constructor(readonly db: Db) {
    this.auth = new ConnectorAuth(db);
  }

  /** A remote connector's address with its values filled in, as agents reach it. */
  serverUrl(connectorId: string): string | null {
    const r = this.row(connectorId);
    return r?.kind === "mcp-http" && r.url ? fillTemplate(r.url, JSON.parse(r.env_json)) : null;
  }

  /** A connector's own values, secrets in the clear: for the hub itself (watches), never for an API answer. */
  values(connectorId: string): Record<string, string> | null {
    const r = this.row(connectorId);
    return r?.enabled ? (JSON.parse(r.env_json) as Record<string, string>) : null;
  }

  /** The headers a remote connector sends, values filled in (no sign-in token). */
  serverHeaders(connectorId: string): Record<string, string> {
    const r = this.row(connectorId);
    if (!r) return {};
    const env = JSON.parse(r.env_json) as Record<string, string>;
    return Object.fromEntries(Object.entries(JSON.parse(r.headers_json) as Record<string, string>).map(([k, v]) => [k, fillTemplate(v, env)]).filter(([, v]) => !/\{\{/.test(v)));
  }

  /** Before a run: refresh sign-ins to the agent's remote connectors that are about to expire. */
  async prepare(agentId: string) {
    const ids = this.forAgentRows(agentId)
      .filter((r) => r.enabled && r.kind === "mcp-http" && this.db.prepare("SELECT 1 FROM connector_auth WHERE connector_id = ? AND tokens_json IS NOT NULL").get(r.id))
      .map((r) => r.id);
    await Promise.all(ids.map((cid) => this.auth.fresh(cid, this.serverUrl(cid)!).catch(() => {})));
  }

  private agentIds(connectorId: string): string[] {
    return (this.db.prepare("SELECT agent_id FROM agent_connectors WHERE connector_id = ? ORDER BY agent_id").all(connectorId) as { agent_id: string }[]).map((r) => r.agent_id);
  }

  private row(connectorId: string) {
    return this.db.prepare("SELECT * FROM connectors WHERE id = ?").get(connectorId) as ConnectorRow | undefined;
  }

  /** As people see it: secret values masked. */
  private view(r: ConnectorRow): Connector {
    const env = JSON.parse(r.env_json) as Record<string, string>;
    const headers = JSON.parse(r.headers_json) as Record<string, string>;
    const plain = plainFields(r.catalog_id);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      kind: r.kind,
      catalogId: r.catalog_id,
      command: r.command,
      args: JSON.parse(r.args_json),
      url: r.url,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, literalHeader(v) ? maskSecret(v) : v])),
      // values a catalog entry says aren't secret (a folder, a team ID, a URL) are shown as they are
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, plain.has(k) ? v : maskSecret(v)])),
      enabled: !!r.enabled,
      auth: r.kind === "mcp-http" ? this.auth.status(r.id) : null,
      agentIds: this.agentIds(r.id),
      allAgents: !!r.all_agents,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  list(workspaceId: string): Connector[] {
    return (this.db.prepare("SELECT * FROM connectors WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as ConnectorRow[]).map((r) => this.view(r));
  }

  get(connectorId: string): Connector | undefined {
    const r = this.row(connectorId);
    return r && this.view(r);
  }

  byName(workspaceId: string, name: string) {
    return this.db.prepare("SELECT id FROM connectors WHERE workspace_id = ? AND lower(name) = lower(?)").get(workspaceId, name) as { id: string } | undefined;
  }

  create(workspaceId: string, by: string, c: ConnectorInput): Connector {
    const cid = id("conn");
    this.db
      .prepare(
        "INSERT INTO connectors (id, workspace_id, name, kind, catalog_id, command, args_json, url, headers_json, env_json, enabled, all_agents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        cid,
        workspaceId,
        c.name,
        c.kind,
        c.catalogId ?? null,
        c.kind === "mcp-stdio" ? (c.command ?? null) : null,
        JSON.stringify(c.kind === "mcp-stdio" ? (c.args ?? []) : []),
        c.kind === "mcp-http" ? (c.url ?? null) : null,
        JSON.stringify(c.kind === "mcp-http" ? dropBlank(c.headers ?? {}) : {}),
        JSON.stringify(dropBlank(c.env ?? {})),
        c.enabled === false ? 0 : 1,
        c.allAgents ? 1 : 0,
        by,
        now(),
      );
    return this.get(cid)!;
  }

  /**
   * Change a connector. In `env` and `headers`, a masked value (as returned on read) keeps what
   * was saved; a key left out is removed. Saved secrets belong to the address or command they were
   * given for: when that changes they're gone, along with any sign-in, and only values sent with
   * the change are kept.
   */
  update(connectorId: string, patch: Partial<Omit<ConnectorInput, "kind" | "catalogId">>): Connector | undefined {
    const r = this.row(connectorId);
    if (!r) return undefined;
    const keep = (next: Record<string, string> | undefined, prev: Record<string, string>) =>
      next === undefined ? prev : dropBlank(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, isMasked(v) ? (prev[k] ?? "") : v])));
    const savedEnv = JSON.parse(r.env_json) as Record<string, string>;
    const savedHeaders = JSON.parse(r.headers_json) as Record<string, string>;
    let env = keep(patch.env, savedEnv);
    let headers = keep(patch.headers, savedHeaders);
    // a `{{KEY}}` in the URL means a new value can move it too, so compare where it really goes
    const moved =
      r.kind === "mcp-http"
        ? fillTemplate(patch.url ?? r.url ?? "", env) !== fillTemplate(r.url ?? "", savedEnv)
        : r.kind === "mcp-stdio" && patch.command !== undefined && patch.command !== r.command;
    if (moved) {
      const plain = plainFields(r.catalog_id);
      env = keep(patch.env, Object.fromEntries(Object.entries(savedEnv).filter(([k]) => plain.has(k))));
      headers = keep(patch.headers, Object.fromEntries(Object.entries(savedHeaders).filter(([, v]) => !literalHeader(v))));
      this.auth.forget(connectorId);
    }
    this.db
      .prepare("UPDATE connectors SET name = ?, command = ?, args_json = ?, url = ?, headers_json = ?, env_json = ?, enabled = ?, all_agents = ? WHERE id = ?")
      .run(
        patch.name ?? r.name,
        r.kind === "mcp-stdio" ? (patch.command ?? r.command) : null,
        r.kind === "mcp-stdio" && patch.args ? JSON.stringify(patch.args) : r.args_json,
        r.kind === "mcp-http" ? (patch.url ?? r.url) : null,
        JSON.stringify(r.kind === "mcp-http" ? headers : {}),
        JSON.stringify(env),
        patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
        patch.allAgents === undefined ? r.all_agents : patch.allAgents ? 1 : 0,
        connectorId,
      );
    return this.get(connectorId);
  }

  remove(connectorId: string) {
    this.db.prepare("DELETE FROM connectors WHERE id = ?").run(connectorId);
  }

  /**
   * The agent is moving to a device owned by `newOwner`, at `by`'s request. Secrets it was given only
   * go along if their owner is the one moving it, or owns the device: nobody gets someone else's
   * keys by moving an agent to their own computer.
   */
  leaveBehindOnMove(agentId: string, by: string, newOwner: string | null) {
    const given = this.db.prepare("SELECT c.* FROM connectors c JOIN agent_connectors g ON g.connector_id = c.id WHERE g.agent_id = ?").all(agentId) as ConnectorRow[];
    for (const r of given) if (this.rowHoldsSecrets(r) && r.created_by !== by && r.created_by !== newOwner) this.attach(r.id, agentId, false);
  }

  /** Give exactly these agents the connector. */
  setAgents(connectorId: string, agentIds: string[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_connectors WHERE connector_id = ?").run(connectorId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO agent_connectors (agent_id, connector_id) VALUES (?, ?)");
      for (const a of agentIds) ins.run(a, connectorId);
    })();
  }

  attach(connectorId: string, agentId: string, on: boolean) {
    if (on) this.db.prepare("INSERT OR IGNORE INTO agent_connectors (agent_id, connector_id) VALUES (?, ?)").run(agentId, connectorId);
    else this.db.prepare("DELETE FROM agent_connectors WHERE agent_id = ? AND connector_id = ?").run(agentId, connectorId);
  }

  /**
   * Connectors the agent has: given to it, or on for every agent in its workspace. One on for every
   * agent that holds secrets (values, a literal header, a sign-in) only reaches agents on its
   * creator's own devices (a VM counts as its device), like a model connection.
   */
  private forAgentRows(agentId: string): ConnectorRow[] {
    const rows = this.db
      .prepare(
        "SELECT c.*, (SELECT role FROM memberships m WHERE m.workspace_id = c.workspace_id AND m.user_id = c.created_by) AS creator_role, c.id IN (SELECT connector_id FROM agent_connectors WHERE agent_id = ?) AS given FROM connectors c WHERE c.id IN (SELECT connector_id FROM agent_connectors WHERE agent_id = ?) OR (c.all_agents = 1 AND c.workspace_id = (SELECT workspace_id FROM agents WHERE id = ?)) ORDER BY c.created_at",
      )
      .all(agentId, agentId, agentId) as (ConnectorRow & { given: number; creator_role: string | null })[];
    const deviceOwner = (this.db.prepare("SELECT n.owner_id FROM agents a JOIN nodes n ON n.id = a.node_id WHERE a.id = ?").get(agentId) as { owner_id: string | null } | undefined)?.owner_id ?? null;
    const onCreatorsDevice = (r: ConnectorRow) => !!r.created_by && r.created_by === deviceOwner;
    return rows
      .filter((r) => {
        // a command only runs if an owner added it, or the person whose device it runs on (older ones may not be either)
        if (r.kind === "mcp-stdio" && r.creator_role !== "owner" && !onCreatorsDevice(r)) return false;
        if (r.given || onCreatorsDevice(r)) return true;
        // on for every agent: what runs or holds secrets stays on its creator's devices; a member's can't reach someone else's
        return !this.rowHoldsSecrets(r) && (!deviceOwner || (r.creator_role === "owner" && r.kind !== "mcp-stdio"));
      })
      .map(({ given: _given, creator_role: _role, ...r }) => r);
  }

  /** Whether a connector carries anything secret: a value, a header that isn't only `{{KEY}}`s, or a sign-in. */
  holdsSecrets(connectorId: string): boolean {
    const r = this.row(connectorId);
    return !!r && this.rowHoldsSecrets(r);
  }

  private rowHoldsSecrets(r: ConnectorRow): boolean {
    if (Object.keys(JSON.parse(r.env_json)).length) return true;
    if (Object.values(JSON.parse(r.headers_json) as Record<string, string>).some(literalHeader)) return true;
    return !!this.db.prepare("SELECT 1 FROM connector_auth WHERE connector_id = ? AND tokens_json IS NOT NULL").get(r.id);
  }

  /** The agent's enabled connectors, as people see them. */
  forAgent(agentId: string): Connector[] {
    return this.forAgentRows(agentId)
      .filter((r) => r.enabled)
      .map((r) => this.view(r));
  }

  /** The agent's enabled connectors, resolved for its device: `{{KEY}}`s filled, secrets in the clear. */
  specsFor(agentId: string): ConnectorSpec[] {
    const rows = this.forAgentRows(agentId).filter((r) => r.enabled);
    const used = new Set<string>();
    return rows.map((r) => {
      const env = JSON.parse(r.env_json) as Record<string, string>;
      let name = connectorSlug(r.name);
      for (let i = 2; used.has(name); i++) name = `${connectorSlug(r.name)}-${i}`;
      used.add(name);
      if (r.kind === "mcp-stdio") return { name, kind: r.kind, command: fillTemplate(r.command ?? "", env), args: (JSON.parse(r.args_json) as string[]).map((a) => fillTemplate(a, env)), env };
      if (r.kind === "mcp-http") {
        const headers = Object.fromEntries(
          Object.entries(JSON.parse(r.headers_json) as Record<string, string>)
            .map(([k, v]) => [k, fillTemplate(v, env)] as const)
            // a header whose only value was optional and left empty isn't sent
            .filter(([, v]) => !/\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(v) && v.replace(/^Bearer\s*/i, "").trim() !== ""),
        );
        // signed in: the access token goes along, unless someone set their own Authorization header
        const token = this.auth.accessToken(r.id);
        if (token && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) headers.Authorization = `Bearer ${token}`;
        return { name, kind: r.kind, url: fillTemplate(r.url ?? "", env), headers };
      }
      return { name, kind: r.kind, env };
    });
  }

  /** One line per connector the agent has, for its prompt. */
  promptSection(agentId: string): string {
    const specs = this.specsFor(agentId);
    if (!specs.length) return "";
    const lines = specs.map((s) => (s.kind === "secret" ? `- ${s.name}: set in your environment as ${Object.keys(s.env ?? {}).join(", ")}` : `- ${s.name}: MCP tools (named mcp__${s.name}__… or ${s.name}.…, depending on your harness)`));
    return [`## Your connected apps`, `Your owner connected these for you. Use them when they fit the task; never print secret values.`, ...lines].join("\n");
  }
}

type SkillRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string;
  source: SkillSource;
  catalog_id: string | null;
  tags_json: string;
  content: string;
  all_agents: number;
  learned_by: string | null;
  uses: number;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export class SkillStore {
  constructor(readonly db: Db) {}

  private view(r: SkillRow): Skill {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      source: r.source,
      catalogId: r.catalog_id,
      tags: JSON.parse(r.tags_json),
      content: r.content,
      agentIds: (this.db.prepare("SELECT agent_id FROM agent_skills WHERE skill_id = ? ORDER BY agent_id").all(r.id) as { agent_id: string }[]).map((x) => x.agent_id),
      allAgents: !!r.all_agents,
      learnedBy: r.learned_by,
      uses: r.uses,
      lastUsedAt: r.last_used_at,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(workspaceId: string): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId) as SkillRow[]).map((r) => this.view(r));
  }

  get(skillId: string): Skill | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(skillId) as SkillRow | undefined;
    return r && this.view(r);
  }

  byCatalog(workspaceId: string, catalogId: string): Skill | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND catalog_id = ?").get(workspaceId, catalogId) as SkillRow | undefined;
    return r && this.view(r);
  }

  /** A slug not yet used in the workspace (nor in `reserved`, names "/" already means something else by). */
  freeSlug(workspaceId: string, base: string, reserved: Iterable<string> = []): string {
    const taken = new Set([...BUILTIN_SKILL_SLUGS, ...reserved, ...(this.db.prepare("SELECT slug FROM skills WHERE workspace_id = ?").all(workspaceId) as { slug: string }[]).map((r) => r.slug)]);
    let s = base;
    for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
    return s;
  }

  create(
    workspaceId: string,
    by: string | null,
    s: { name: string; slug: string; description: string; source: SkillSource; catalogId?: string | null; tags?: string[]; content: string; allAgents?: boolean; learnedBy?: string | null },
  ): Skill {
    const sid = id("skill");
    const ts = now();
    this.db
      .prepare("INSERT INTO skills (id, workspace_id, name, slug, description, source, catalog_id, tags_json, content, all_agents, learned_by, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sid, workspaceId, s.name, s.slug, s.description, s.source, s.catalogId ?? null, JSON.stringify(s.tags ?? []), s.content, s.allAgents ? 1 : 0, s.learnedBy ?? null, by, ts, ts);
    return this.get(sid)!;
  }

  update(skillId: string, patch: Partial<{ name: string; description: string; tags: string[]; content: string; allAgents: boolean }>): Skill | undefined {
    const s = this.get(skillId);
    if (!s) return undefined;
    this.db
      .prepare("UPDATE skills SET name = ?, description = ?, tags_json = ?, content = ?, all_agents = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? s.name, patch.description ?? s.description, JSON.stringify(patch.tags ?? s.tags), patch.content ?? s.content, (patch.allAgents ?? s.allAgents) ? 1 : 0, now(), skillId);
    return this.get(skillId);
  }

  /** A run read the skill: count it. */
  used(skillId: string) {
    this.db.prepare("UPDATE skills SET uses = uses + 1, last_used_at = ? WHERE id = ?").run(now(), skillId);
  }

  bySlug(workspaceId: string, slug: string): Skill | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND slug = ?").get(workspaceId, slug) as SkillRow | undefined;
    return r && this.view(r);
  }

  /** The skills an agent learned. */
  learnedBy(workspaceId: string, agentId: string): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND source = 'learned' AND learned_by = ? ORDER BY created_at").all(workspaceId, agentId) as SkillRow[]).map((r) => this.view(r));
  }

  /** Every-agent skills in the workspace. */
  allAgentsIn(workspaceId: string): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND all_agents = 1 ORDER BY name COLLATE NOCASE").all(workspaceId) as SkillRow[]).map((r) => this.view(r));
  }

  remove(skillId: string) {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(skillId);
  }

  attach(skillId: string, agentId: string, on: boolean) {
    if (on) this.db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)").run(agentId, skillId);
    else this.db.prepare("DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?").run(agentId, skillId);
  }

  /** The agent's skills: given to it, or on for every agent in its workspace. */
  forAgent(agentId: string): Skill[] {
    return (
      this.db
        .prepare(
          "SELECT s.* FROM skills s WHERE s.id IN (SELECT skill_id FROM agent_skills WHERE agent_id = ?) OR (s.all_agents = 1 AND s.workspace_id = (SELECT workspace_id FROM agents WHERE id = ?)) ORDER BY s.name COLLATE NOCASE",
        )
        .all(agentId, agentId) as SkillRow[]
    ).map((r) => this.view(r));
  }

  /**
   * The agent's skills, built-in ones first, for its prompt: what each is for and where to read it.
   * With `learn`, it's also asked to save how it did things it'll likely be asked to do again.
   */
  promptSection(agentId: string, opts: { learn?: boolean } = {}): string {
    const skills = [...BUILTIN_SKILLS.map((s) => ({ name: s.name, slug: s.id, description: s.description })), ...this.forAgent(agentId)];
    return [
      `## Your skills`,
      `You have these skills: step-by-step instructions for kinds of work. When a request matches one, read its SKILL.md first (memory_read) and follow it.`,
      ...skills.map((s) => `- ${oneLine(s.name)} (me/skills/${s.slug}/SKILL.md): ${oneLine(s.description)}`),
      opts.learn ? `\n${LEARN_NOTE}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** Text on one line, so a name or description can't add lines of its own to a prompt. */
const oneLine = (s: string) => s.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();

/** How agents learn skills on their own (when the workspace has that on). */
export const LEARN_NOTE =
  "After you finish a task you'd likely be asked to do again (several steps, a particular site or app, the person's preferences), save how with skill_save: short numbered steps with the specifics that mattered and where to stop and ask a person. Before a task, if one of your skills fits, read it and follow it; if the steps changed, save it again under the same name. Never save one-off answers or anything secret (passwords, keys, card numbers).";

/**
 * Whether text looks like it holds a secret: an API key or token (sk-…, ghp_…, Stripe, AWS, Slack,
 * Google, a private key, a JWT), a card number (15–19 digits that pass the Luhn check), or a
 * "password:" / "token:" / "api key:" line. Learned skills can't.
 */
export function holdsSecret(text: string): boolean {
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk_live|sk_test|rk_live)_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|xox[abprs]-|AIza[0-9A-Za-z_-]{35}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  // a line naming a secret and giving it ("password: …", "- **API key** = …", "GitHub token: …")
  if (/^[\s>*-]*(?:\d+[.)]\s*)?(?:\*\*)?(?:[A-Za-z]+\s+){0,3}(?:password|passwd|pwd|passcode|token|api[_ -]?key|secret|pin)(?:\*\*)?\s*[:=]\s*\S/im.test(text)) return true;
  // 15–19 digits, maybe in groups split by one space or dash (shorter numbers are order numbers, timestamps)
  for (const m of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){14,18}(?![\d-])/g)) if (luhn(m[0].replace(/\D/g, ""))) return true;
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function dropBlank(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => k.trim() && v !== ""));
}
