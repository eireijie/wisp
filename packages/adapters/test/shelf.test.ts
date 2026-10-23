import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanShelf, serverItem } from "../src/index.ts";

let home: string;
const write = (rel: string, text: string) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "warren-shelf-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("what the harnesses on a device already have", () => {
  it("finds skills and MCP servers in Claude Code, Codex and Hermes, without their secrets", async () => {
    write(".claude/settings.json", "{}");
    write(".claude/skills/pdf/SKILL.md", skill("pdf", "Work with PDF files"));
    write(".claude.json", JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_realtokenrealtokenrealtoken12" } }, linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_secretsecretsecret" } } } }));
    write(
      ".codex/config.toml",
      `model = "gpt-6"\n\n[mcp_servers.docs]\nurl = "https://developers.openai.com/mcp"\n\n[mcp_servers.db]\ncommand = "uvx"\nargs = ["postgres-mcp", "--dsn=postgres://u:s3cret@h/db"]\n\n[mcp_servers.db.env]\nPGPASSWORD = "hunter2"\nREGION = "us"\n\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n`,
    );
    write(".codex/skills/linear/SKILL.md", skill("linear", "Manage Linear issues"));
    write(".hermes/config.yaml", "model:\n  default: x\nmcp_servers:\n  notes:\n    url: https://notes.example.com/mcp?token=abc123\n");
    write(".hermes/skills/research/arxiv/SKILL.md", skill("arxiv", "Search papers"));

    const items = await scanShelf({ home });
    const by = (k: string) => items.find((i) => i.key === k);
    expect(items.map((i) => i.key).sort()).toEqual(["claude-code:mcp:github", "claude-code:mcp:linear", "claude-code:skill:pdf", "codex:mcp:db", "codex:mcp:docs", "codex:skill:linear", "hermes:mcp:notes", "hermes:skill:arxiv"]);
    expect(by("claude-code:skill:pdf")).toMatchObject({ kind: "skill", name: "pdf", description: "Work with PDF files" });
    expect(by("claude-code:mcp:github")).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], secrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    expect(by("claude-code:mcp:linear")).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp", headers: ["Authorization"] });
    expect(by("codex:mcp:db")).toMatchObject({ command: "uvx", args: ["postgres-mcp", "--dsn={{DSN}}"], env: { REGION: "us" } });
    expect(by("codex:mcp:db")?.secrets?.sort()).toEqual(["DSN", "PGPASSWORD"]);
    expect(by("hermes:mcp:notes")).toMatchObject({ url: "https://notes.example.com/mcp?token={{TOKEN}}", secrets: ["TOKEN"] });
    // nothing secret leaves the device
    expect(JSON.stringify(items)).not.toMatch(/ghp_real|lin_api|hunter2|abc123|s3cret/);
  });

  it("finds nothing on a device without harnesses", async () => {
    expect(await scanShelf({ home })).toEqual([]);
  });

  it("skips servers that are off or have nothing to run", () => {
    expect(serverItem("hermes", "x", { command: "x", enabled: false }, "")).toBeNull();
    expect(serverItem("claude-code", "x", { command: "x", disabled: true }, "")).toBeNull();
    expect(serverItem("codex", "x", { url: "file:///etc/passwd" }, "")).toBeNull();
  });
});
