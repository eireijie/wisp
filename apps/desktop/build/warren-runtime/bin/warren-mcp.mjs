#!/usr/bin/env node
// `warren-mcp`: stdio MCP server that gives any harness Warren's chat, task, memory and file tools.
import { register } from "tsx/esm/api";
register();
await import("../packages/mcp/src/main.ts");
