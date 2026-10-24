import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { SETTINGS_HARNESSES, redactServer, type ShelfItem } from "@wisp/core";
import { harnessConfigPath, parseToml, readHarnessSettings, type HarnessHomes } from "./harness-config.ts";

/**
 * What each harness on this device already has that Warren could share with other agents: its
 * skills (read with the harness settings, so `harness_skill` finds them by the same id) and its MCP
 * servers, with secret values left out (see redactServer). Shown under "On your devices".
 */
export async function scanShelf(h: HarnessHomes = {}): Promise<ShelfItem[]> {
  const out: ShelfItem[] = [];
  for (const harness of SETTINGS_HARNESSES as readonly string[]) {
    const file = harnessConfigPath(harness, h);
    if (!file) continue;
    const settings = await readHarnessSettings(harness, h).catch(() => null);
    for (const s of settings?.skills ?? []) {
      if (!s.enabled) continue;
      out.push({ key: `${harness}:skill:${s.id}`, harness, kind: "skill", name: s.name.slice(0, 120), ...(s.description ? { description: s.description } : {}), path: path.dirname(file) });
    }
    const servers = await mcpServers(harness, h).catch(() => []);
    for (const [name, v] of servers) {
      const item = serverItem(harness, name, v, harness === "claude-code" ? claudeStatePath(h) : file);
      if (item) out.push(item);
    }
  }
  return out.slice(0, 1000);
}

type Server = { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown; transport?: unknown; headers?: unknown; http_headers?: unknown; enabled?: unknown; disabled?: unknown };

const claudeStatePath = (h: HarnessHomes) => {
  const home = h.home ?? os.homedir();
  const dir = h.claudeDir ?? (h.home ? undefined : process.env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude");
  return path.join(dir === path.join(home, ".claude") ? home : dir, ".claude.json");
};

/** A harness's MCP servers, by name, straight from its config. */
async function mcpServers(harness: string, h: HarnessHomes): Promise<[string, Server][]> {
  if (harness === "claude-code") {
    const state = JSON.parse(await fs.readFile(claudeStatePath(h), "utf8")) as { mcpServers?: Record<string, Server> };
    return Object.entries(state.mcpServers ?? {});
  }
  // only these three keep MCP servers in a file whose shape Warren reads here
  if (harness !== "hermes" && harness !== "codex") return [];
  const text = await fs.readFile(harnessConfigPath(harness, h)!, "utf8");
  if (harness === "hermes") {
    const cfg = (yaml.load(text) ?? {}) as { mcp_servers?: Record<string, Server> };
    return Object.entries(cfg.mcp_servers ?? {});
  }
  // codex: [mcp_servers.<name>] tables, with [mcp_servers.<name>.env] beside them
  const doc = parseToml(text);
  const servers = new Map<string, Record<string, unknown>>();
  for (const e of doc.entries) {
    if (e.arrayIndex || e.table[0] !== "mcp_servers" || e.table.length < 2) continue;
    const s = servers.get(e.table[1]) ?? {};
    servers.set(e.table[1], s);
    if (e.table.length === 2) s[e.key] = e.value;
    else if (e.table.length === 3 && (e.table[2] === "env" || e.table[2] === "http_headers")) s[e.table[2]] = { ...((s[e.table[2]] as object) ?? {}), [e.key]: e.value };
  }
  return [...servers.entries()];
}

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, string> => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number").map(([k, x]) => [k, String(x)])) : {});

/** One server as the shelf shows it, or null when it's turned off or can't be used elsewhere. */
export function serverItem(harness: string, name: string, v: Server, where: string): ShelfItem | null {
  if (v.enabled === false || v.disabled === true) return null;
  const key = `${harness}:mcp:${name}`.slice(0, 300);
  const nice = name.slice(0, 120);
  if (typeof v.url === "string" && /^https?:\/\//i.test(v.url)) {
    const r = redactServer({ url: v.url });
    if (!r.url) return null;
    const headers = Object.keys({ ...record(v.headers), ...record(v.http_headers) }).slice(0, 30);
    return { key, harness, kind: "mcp", name: nice, path: where, transport: "http", url: r.url, ...(headers.length ? { headers } : {}), ...(r.secrets.length ? { secrets: r.secrets } : {}) };
  }
  if (typeof v.command !== "string" || !v.command.trim()) return null;
  const r = redactServer({ command: v.command, args: strs(v.args), env: record(v.env) });
  return { key, harness, kind: "mcp", name: nice, path: where, transport: "stdio", command: v.command, args: r.args ?? [], ...(Object.keys(r.env).length ? { env: r.env } : {}), ...(r.secrets.length ? { secrets: r.secrets.slice(0, 50) } : {}) };
}
