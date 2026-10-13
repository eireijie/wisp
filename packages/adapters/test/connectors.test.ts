import { describe, expect, it } from "vitest";
import type { ConnectorSpec } from "@warren/core";
import { acpMcpServers, claudeArgs, codexArgs } from "../src/index.ts";

const connectors: ConnectorSpec[] = [
  { name: "github", kind: "mcp-http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer t0k" } },
  { name: "postgres", kind: "mcp-stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://h/db"], env: { PGSSL: "1" } },
  { name: "legacy", kind: "mcp-http", url: "https://example.com/sse" },
  // Warren's own servers can't be replaced by a connector
  { name: "warren", kind: "mcp-stdio", command: "evil" },
];
const warren = { command: "node", args: ["warren-mcp.mjs"], env: { WARREN_TOKEN: "x" } };

describe("connectors reach the harness", () => {
  it("claude: --mcp-config with stdio, http and sse servers, all pre-allowed", () => {
    const a = claudeArgs({ prompt: "", cwd: "/", mcp: warren, connectors });
    const config = JSON.parse(a[a.indexOf("--mcp-config") + 1]);
    expect(config.mcpServers.warren.command).toBe("node");
    expect(config.mcpServers.github).toEqual({ type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer t0k" } });
    expect(config.mcpServers.postgres).toEqual({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://h/db"], env: { PGSSL: "1" } });
    expect(config.mcpServers.legacy.type).toBe("sse");
    expect(a[a.indexOf("--allowedTools") + 1].split(",")).toEqual(["mcp__warren", "mcp__github", "mcp__postgres", "mcp__legacy"]);
  });

  it("claude: connectors alone still produce a config", () => {
    const a = claudeArgs({ prompt: "", cwd: "/", connectors: [connectors[1]] });
    expect(Object.keys(JSON.parse(a[a.indexOf("--mcp-config") + 1]).mcpServers)).toEqual(["postgres"]);
  });

  it("codex: -c mcp_servers overrides", () => {
    const a = codexArgs({ prompt: "", cwd: "/", mcp: warren, connectors });
    expect(a).toEqual(
      expect.arrayContaining([
        'mcp_servers.github.url="https://api.githubcopilot.com/mcp/"',
        'mcp_servers.github.http_headers={Authorization="Bearer t0k"}',
        'mcp_servers.postgres.command="npx"',
        'mcp_servers.postgres.args=["-y","@modelcontextprotocol/server-postgres","postgres://h/db"]',
        'mcp_servers.postgres.env={PGSSL="1"}',
      ]),
    );
    expect(a).not.toContain('mcp_servers.warren.command="evil"');
  });

  it("acp: stdio connectors only", () => {
    const servers = acpMcpServers(warren, undefined, connectors);
    expect(servers.map((s: any) => s.name)).toEqual(["warren", "postgres"]);
    expect(servers[1]).toEqual({ name: "postgres", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://h/db"], env: [{ name: "PGSSL", value: "1" }] });
  });
});
