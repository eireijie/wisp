import { catalogConnector, connectorSlug, fillTemplate, isMasked, maskSecret, type Connector, type ConnectorKind, type ConnectorSpec, type Skill, type SkillSource } from "@warren/core";
import { id, now } from "./auth.ts";
import type { Db } from "./db.ts";

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
}

/** A header value is a secret unless it only fills in `{{KEY}}`s (then the secret lives in env). */
const literalHeader = (v: string) => !/\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(v);

export class ConnectorStore {
  constructor(readonly db: Db) {}

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
    const plain = new Set((catalogConnector(r.catalog_id ?? "")?.fields ?? []).filter((f) => !f.secret).map((f) => f.key));
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
      agentIds: this.agentIds(r.id),
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
        "INSERT INTO connectors (id, workspace_id, name, kind, catalog_id, command, args_json, url, headers_json, env_json, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        by,
        now(),
      );
    return this.get(cid)!;
  }

  /**
   * Change a connector. In `env` and `headers`, a masked value (as returned on read) keeps what
   * was saved; a key left out is removed.
   */
  update(connectorId: string, patch: Partial<Omit<ConnectorInput, "kind" | "catalogId">>): Connector | undefined {
    const r = this.row(connectorId);
    if (!r) return undefined;
    const keep = (next: Record<string, string> | undefined, prev: Record<string, string>) =>
      next === undefined ? prev : dropBlank(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, isMasked(v) ? (prev[k] ?? "") : v])));
    const env = keep(patch.env, JSON.parse(r.env_json));
    const headers = keep(patch.headers, JSON.parse(r.headers_json));
    this.db
      .prepare("UPDATE connectors SET name = ?, command = ?, args_json = ?, url = ?, headers_json = ?, env_json = ?, enabled = ? WHERE id = ?")
      .run(
        patch.name ?? r.name,
        r.kind === "mcp-stdio" ? (patch.command ?? r.command) : null,
        r.kind === "mcp-stdio" && patch.args ? JSON.stringify(patch.args) : r.args_json,
        r.kind === "mcp-http" ? (patch.url ?? r.url) : null,
        JSON.stringify(r.kind === "mcp-http" ? headers : {}),
        JSON.stringify(env),
        patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
        connectorId,
      );
    return this.get(connectorId);
  }

  remove(connectorId: string) {
    this.db.prepare("DELETE FROM connectors WHERE id = ?").run(connectorId);
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

  /** The agent's enabled connectors, resolved for its device: `{{KEY}}`s filled, secrets in the clear. */
  specsFor(agentId: string): ConnectorSpec[] {
    const rows = this.db
      .prepare("SELECT c.* FROM connectors c JOIN agent_connectors ac ON ac.connector_id = c.id WHERE ac.agent_id = ? AND c.enabled = 1 ORDER BY c.created_at")
      .all(agentId) as ConnectorRow[];
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
    return [`## Your connectors`, `Your owner connected these for you. Use them when they fit the task; never print secret values.`, ...lines].join("\n");
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

  /** A slug not yet used in the workspace. */
  freeSlug(workspaceId: string, base: string): string {
    const taken = new Set((this.db.prepare("SELECT slug FROM skills WHERE workspace_id = ?").all(workspaceId) as { slug: string }[]).map((r) => r.slug));
    let s = base;
    for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
    return s;
  }

  create(workspaceId: string, by: string | null, s: { name: string; slug: string; description: string; source: SkillSource; catalogId?: string | null; tags?: string[]; content: string }): Skill {
    const sid = id("skill");
    const ts = now();
    this.db
      .prepare("INSERT INTO skills (id, workspace_id, name, slug, description, source, catalog_id, tags_json, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sid, workspaceId, s.name, s.slug, s.description, s.source, s.catalogId ?? null, JSON.stringify(s.tags ?? []), s.content, by, ts, ts);
    return this.get(sid)!;
  }

  update(skillId: string, patch: Partial<{ name: string; description: string; tags: string[]; content: string }>): Skill | undefined {
    const s = this.get(skillId);
    if (!s) return undefined;
    this.db
      .prepare("UPDATE skills SET name = ?, description = ?, tags_json = ?, content = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? s.name, patch.description ?? s.description, JSON.stringify(patch.tags ?? s.tags), patch.content ?? s.content, now(), skillId);
    return this.get(skillId);
  }

  remove(skillId: string) {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(skillId);
  }

  attach(skillId: string, agentId: string, on: boolean) {
    if (on) this.db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)").run(agentId, skillId);
    else this.db.prepare("DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?").run(agentId, skillId);
  }

  forAgent(agentId: string): Skill[] {
    return (this.db.prepare("SELECT s.* FROM skills s JOIN agent_skills a ON a.skill_id = s.id WHERE a.agent_id = ? ORDER BY s.name COLLATE NOCASE").all(agentId) as SkillRow[]).map((r) => this.view(r));
  }

  /** The agent's installed skills, for its prompt: what each is for and where to read it. */
  promptSection(agentId: string): string {
    const skills = this.forAgent(agentId);
    if (!skills.length) return "";
    return [
      `## Your skills`,
      `You have these skills: step-by-step instructions for kinds of work. When a request matches one, read its SKILL.md first (memory_read) and follow it.`,
      ...skills.map((s) => `- ${s.name} (me/skills/${s.slug}/SKILL.md): ${s.description}`),
    ].join("\n");
  }
}

function dropBlank(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => k.trim() && v !== ""));
}
