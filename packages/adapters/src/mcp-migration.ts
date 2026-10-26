import yaml from "js-yaml";
import { asObject, editJson, parseToml } from "./harness-formats.ts";

/** A user may have an unrelated server named Warren; only migrate our script. */
export function isLegacyMcp(value: unknown): boolean {
  const s = asObject(value);
  return [s.command, ...(Array.isArray(s.args) ? s.args : [])].some((v) => typeof v === "string" && /(?:^|[/\\])(?:warren|wisp)-mcp\.mjs$/.test(v));
}
const rewrite = (v: unknown): unknown => typeof v === "string" ? v.replace(/warren-mcp\.mjs/g, "wisp-mcp.mjs") : Array.isArray(v) ? v.map(rewrite) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)])) : v;

/** Used whenever settings are saved: remove the stale entry or rename it if it's the only one. */
export function migrateMcpConfig(text: string, harness: string): string {
  if (harness === "codex") {
    const doc = parseToml(text);
    const entry = Object.fromEntries(doc.entries.filter((e) => e.table.length === 2 && e.table[0] === "mcp_servers" && e.table[1] === "warren").map((e) => [e.key, e.value]));
    if (!isLegacyMcp(entry)) return text;
    const hasNew = doc.tables.some((t) => t.path[0] === "mcp_servers" && t.path[1] === "wisp");
    const lines = text.split("\n");
    for (let index = doc.tables.length - 1; index >= 0; index--) {
      const table = doc.tables[index];
      if (table.path[0] !== "mcp_servers" || table.path[1] !== "warren") continue;
      const end = doc.tables[index + 1]?.line ?? lines.length;
      if (hasNew) lines.splice(table.line, end - table.line);
      else {
        lines[table.line] = lines[table.line].replace(/warren/, "wisp");
        for (let line = table.line + 1; line < end; line++) lines[line] = lines[line].replace(/warren-mcp\.mjs/g, "wisp-mcp.mjs");
      }
    }
    return lines.join("\n");
  }
  if (harness === "hermes") {
    const servers = asObject(asObject(yaml.load(text)).mcp_servers);
    if (!isLegacyMcp(servers.warren)) return text;
    // These blocks are ordinary YAML mappings; preserve all surrounding comments/settings.
    const lines = text.split("\n");
    const parent = lines.findIndex((l) => /^mcp_servers:\s*(?:#.*)?$/.test(l));
    if (parent < 0) return text;
    const start = lines.findIndex((l, i) => i > parent && /^  (?:warren|"warren"|'warren'):\s*(?:#.*)?$/.test(l));
    if (start < 0) return text;
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s*#/.test(lines[end]) || /^ {3,}/.test(lines[end]))) end++;
    if (servers.wisp) lines.splice(start, end - start);
    else for (let i = start; i < end; i++) lines[i] = lines[i].replace(i === start ? /warren/ : /warren-mcp\.mjs/g, i === start ? "wisp" : "wisp-mcp.mjs");
    return lines.join("\n");
  }
  // Plain JSON harnesses keep servers in one of these well-known containers.
  try {
    const cfg = asObject(JSON.parse(text));
    const maps = [cfg.mcpServers, cfg.mcp_servers, cfg.mcp, asObject(cfg.mcp).servers].map(asObject);
    if (!maps.some((m) => isLegacyMcp(m.warren))) return text;
    return editJson(text, "MCP config", (root) => {
      for (const m of [root.mcpServers, root.mcp_servers, root.mcp, asObject(root.mcp).servers].map(asObject)) {
        if (!isLegacyMcp(m.warren)) continue;
        m.wisp ??= rewrite(m.warren);
        delete m.warren;
      }
    });
  } catch { return text; }
}
