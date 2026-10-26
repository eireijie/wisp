#!/usr/bin/env node
// `wisp-mcp`: stdio MCP server that gives any harness Wisp's chat, task, memory and file tools.
import { register } from "tsx/esm/api";
register();
await import("../packages/mcp/src/main.ts");
