#!/usr/bin/env node
// `warren` CLI: connect a device to a hub. Runs the TypeScript source through tsx.
import { register } from "tsx/esm/api";
register();
await import("../apps/node/src/cli.ts");
