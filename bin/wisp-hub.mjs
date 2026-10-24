#!/usr/bin/env node
// `wisp-hub`: run the hub server (API, realtime, vault, and the web app), restarting it after updates.
import { keep } from "./keeper.mjs";

keep(new URL("../apps/hub/src/main.ts", import.meta.url));
