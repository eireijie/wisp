import { shareOrigin, useAccess } from "../access.ts";
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
  useAccess();
  const hub = shareOrigin();
  // Shell and TOML use their own quoting rules; hub URLs can contain special characters.
  const shell = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const config =
    format === "claude"
      ? `claude mcp add wisp --env WISP_URL=${shell(hub)} --env WISP_TOKEN=${shell(token)} -- wisp-mcp`
      : format === "codex"
        ? `[mcp_servers.wisp]\ncommand = "wisp-mcp"\nenv = { WISP_URL = ${JSON.stringify(hub)}, WISP_TOKEN = ${JSON.stringify(token)} }`
        : JSON.stringify(
            {
              mcpServers: {
                wisp: {
                  command: "wisp-mcp",
                  env: { WISP_URL: hub, WISP_TOKEN: token },
                },
              },
            },
            null,
            2,
          );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        On the agent's machine, install Wisp from this repository and run{" "}
        <code className="text-ink">npm install && npm link</code> to make{" "}
        <code className="text-ink">wisp-mcp</code> available. Then add this
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
