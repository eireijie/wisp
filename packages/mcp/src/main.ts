#!/usr/bin/env -S npx tsx
import { envVar } from "@wisp/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WispClient } from "@wisp/sdk";
import { createWispMcp } from "./server.ts";

/**
 * wisp-mcp: stdio MCP server.
 *   WISP_URL    hub URL (default http://localhost:4747)
 *   WISP_TOKEN  agent token, or node token together with WISP_AGENT
 *   WISP_AGENT  agent id when using a node token
 */
const url = envVar("URL") ?? "http://localhost:4747";
const token = envVar("TOKEN");
if (!token) {
  console.error("wisp-mcp: set WISP_TOKEN (create one in Wisp under Agent → Connect)");
  process.exit(1);
}

const server = await createWispMcp(new WispClient({ url, token, agentId: envVar("AGENT") }));
await server.connect(new StdioServerTransport());
