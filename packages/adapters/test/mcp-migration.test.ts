import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { migrateMcpConfig } from "../src/mcp-migration.ts";
import { parseToml } from "../src/harness-formats.ts";

describe("legacy MCP entries", () => {
  it("renames our server in JSON and preserves unrelated servers", () => {
    const after = JSON.parse(migrateMcpConfig(JSON.stringify({ mcpServers: { warren: { command: "node", args: ["/repo/bin/warren-mcp.mjs"], env: { WARREN_TOKEN: "secret" } }, other: { command: "other" } } }), "claude-code"));
    expect(after.mcpServers).toEqual({ wisp: { command: "node", args: ["/repo/bin/wisp-mcp.mjs"], env: { WARREN_TOKEN: "secret" } }, other: { command: "other" } });
    expect(migrateMcpConfig(JSON.stringify(after), "claude-code")).toBe(JSON.stringify(after));
  });
  it("removes the stale TOML entry and its child env table when Wisp is already configured", () => {
    const text = '# keep\nmodel="model"\n[mcp_servers.warren]\ncommand="node"\nargs=["/repo/bin/warren-mcp.mjs"]\n[mcp_servers.warren.env]\nWARREN_TOKEN="secret"\n[mcp_servers.wisp]\ncommand="node"\nargs=["/repo/bin/wisp-mcp.mjs"]\n[mcp_servers.other]\nurl="https://other"\n';
    const after = migrateMcpConfig(text, "codex");
    expect(after).not.toContain("warren"); expect(after).toContain("# keep"); expect(after).toContain("https://other");
    expect(parseToml(after).tables.map((t) => t.path)).toEqual([["mcp_servers", "wisp"], ["mcp_servers", "other"]]);
  });
  it("renames the sole TOML entry with quoted table names", () => {
    const after = migrateMcpConfig('[mcp_servers."warren"]\ncommand="node"\nargs=["/repo/bin/warren-mcp.mjs"]\n', "codex");
    expect(after).toContain('[mcp_servers."wisp"]'); expect(after).toContain("wisp-mcp.mjs");
  });
  it("removes only our stale YAML mapping", () => {
    const after = migrateMcpConfig('model: model\nmcp_servers:\n  warren:\n    command: node\n    args: [/repo/bin/warren-mcp.mjs]\n  wisp:\n    command: node\n    args: [/repo/bin/wisp-mcp.mjs]\n  other:\n    url: https://other\n', "hermes");
    expect((yaml.load(after) as any).mcp_servers.warren).toBeUndefined(); expect(after).toContain("https://other");
  });
  it("leaves user servers with an unrelated command untouched", () => {
    for (const [h, text] of [["codex", '[mcp_servers.warren]\ncommand="family-tree"\n'], ["hermes", 'mcp_servers:\n  warren:\n    command: family-tree\n'], ["claude-code", '{"mcpServers":{"warren":{"command":"family-tree"}}}']]) expect(migrateMcpConfig(text, h)).toBe(text);
  });
});
