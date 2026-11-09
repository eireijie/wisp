import { describe, expect, it } from "vitest";
import { acpIsolationArgs, claudeArgs, codexArgs, codexConfiguredServers, codexIsolation } from "../src/index.ts";

const base = { prompt: "hi", cwd: "/x", mcp: { command: "wisp-mcp", args: [], env: {} } };

describe("personal plugins: Codex", () => {
  const toml = `[plugins."computer-use@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\ncommand="x"\n[mcp_servers.node_repl.env]\nA="1"\n[mcp_servers."my server"]\ncommand="y"\n`;

  it("finds the servers a config sets up, once each", () => {
    expect(codexConfiguredServers(toml)).toEqual(["node_repl", "my server"]);
  });

  it("is off unless asked for: plugins, apps, Computer Use, the notifier and personal servers are switched off", () => {
    for (const input of [base, { ...base, ownPlugins: false }]) {
      const a = codexArgs(input, ["node_repl", "my server"]).join(" ");
      for (const f of ["plugins", "apps", "computer_use", "browser_use", "remote_plugin"]) expect(a).toContain(`features.${f}=false`);
      expect(a).toContain("notify=[]");
      expect(a).toContain("mcp_servers.node_repl.enabled=false");
      expect(a).toContain('mcp_servers."my server".enabled=false');
    }
  });

  it("still gives the run Wisp's own tools, set after the switch-offs", () => {
    const a = codexArgs({ ...base, connectors: [{ name: "node_repl", kind: "mcp-stdio", command: "z", args: [] } as never] }, ["node_repl"]);
    expect(a).toContain(`mcp_servers.wisp.command="wisp-mcp"`);
    expect(a.lastIndexOf("mcp_servers.node_repl.enabled=false")).toBeLessThan(a.lastIndexOf(`mcp_servers.node_repl.command="z"`));
  });

  it("with the switch on, changes nothing", () => {
    const on = codexArgs({ ...base, ownPlugins: true }, ["node_repl"]);
    expect(on.join(" ")).not.toMatch(/features\.|notify|\.enabled=false/);
    expect(on).toEqual(codexArgs({ ...base, ownPlugins: true }));
    expect(codexIsolation([]).length).toBeGreaterThan(0);
  });
});

describe("personal plugins: Claude Code", () => {
  it("off: only the given MCP servers, no user settings (plugins, hooks), no Chrome link", () => {
    const a = claudeArgs(base);
    expect(a).toContain("--strict-mcp-config");
    expect(a.join(" ")).toContain("--setting-sources project,local");
    expect(a).toContain("--no-chrome");
    expect(claudeArgs({ ...base, ownPlugins: false })).toEqual(a);
  });
  it("on: as before", () => {
    const a = claudeArgs({ ...base, ownPlugins: true }).join(" ");
    expect(a).not.toMatch(/strict-mcp-config|setting-sources|no-chrome/);
  });
});

describe("personal plugins: other harnesses", () => {
  it("Gemini: no extensions, only Wisp's servers by name", () => {
    expect(acpIsolationArgs("gemini", base)).toEqual(["-e", "none", "--allowed-mcp-server-names=wisp"]);
  });
  it("harnesses without a known switch get no flags", () => {
    expect(acpIsolationArgs("hermes", base)).toEqual([]);
  });
});
