#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WarrenClient } from "@warren/sdk";
import { createWarrenMcp } from "./server.ts";

/**
 * warren-mcp: stdio MCP server.
 *   WARREN_URL    hub URL (default http://localhost:4747)
 *   WARREN_TOKEN  agent token, or node token together with WARREN_AGENT
 *   WARREN_AGENT  agent id when using a node token
 */
const url = process.env.WARREN_URL ?? "http://localhost:4747";
const token = process.env.WARREN_TOKEN;
if (!token) {
  console.error("warren-mcp: set WARREN_TOKEN (create one in Warren under Agent → Connect)");
  process.exit(1);
}

const server = await createWarrenMcp(new WarrenClient({ url, token, agentId: process.env.WARREN_AGENT }));
await server.connect(new StdioServerTransport());
