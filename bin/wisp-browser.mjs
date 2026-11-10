#!/usr/bin/env node
// The browser tools of an agent whose computer may be off: starts the computer on first use.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../apps/node/src/computers/browser-proxy.ts");
await main();
