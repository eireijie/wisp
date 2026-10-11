#!/usr/bin/env node
// `warren-hub`: run the hub server (API, realtime, vault, and the web app).
import { register } from "tsx/esm/api";
register();
await import("../apps/hub/src/main.ts");
