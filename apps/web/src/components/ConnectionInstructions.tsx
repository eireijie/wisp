import { useState } from "react";
import { CopyBlock, cx } from "./ui.tsx";

/** The same invitation configuration in onboarding and the agent's Connect tab. */
export function ConnectionInstructions({
  token,
  harness,
}: {
  token: string;
  harness: string;
}) {
  const [format, setFormat] = useState(
    harness === "claude-code"
      ? "claude"
      : harness === "codex"
        ? "codex"
        : "json",
  );
  const hub = location.origin;
  // Shell and TOML use their own quoting rules; hub URLs can contain special characters.
  const shell = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const config =
    format === "claude"
      ? `claude mcp add warren --env WARREN_URL=${shell(hub)} --env WARREN_TOKEN=${shell(token)} -- warren-mcp`
      : format === "codex"
        ? `[mcp_servers.warren]\ncommand = "warren-mcp"\nenv = { WARREN_URL = ${JSON.stringify(hub)}, WARREN_TOKEN = ${JSON.stringify(token)} }`
        : JSON.stringify(
            {
              mcpServers: {
                warren: {
                  command: "warren-mcp",
                  env: { WARREN_URL: hub, WARREN_TOKEN: token },
                },
              },
            },
            null,
            2,
          );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        On the agent's machine, install Warren from this repository and run{" "}
        <code className="text-ink">npm install && npm link</code> to make{" "}
        <code className="text-ink">warren-mcp</code> available. Then add this
        configuration to its MCP settings and restart the session.
      </p>
      <div
        className="flex flex-wrap gap-1"
        role="tablist"
        aria-label="Connection format"
      >
        {[
          ["claude", "Claude Code"],
          ["codex", "Codex"],
          ["json", "Other MCP clients"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={format === id}
            onClick={() => setFormat(id)}
            className={cx(
              "rounded-lg px-3 py-2 text-xs font-medium",
              format === id ? "bg-chip text-ink" : "text-muted hover:bg-hover",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <CopyBlock text={config} />
      <p className="text-xs text-muted">
        This configuration contains the agent's connection token. Copy it before
        closing; you can create a new token on its Connect tab.
      </p>
    </div>
  );
}
