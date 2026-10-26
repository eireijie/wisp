#!/usr/bin/env node
// `warren` CLI: run a hub, or connect a device to one. Runs the TypeScript source through tsx; `warren node
// start` runs under the keeper so it restarts itself after an update.
const cli = new URL("../apps/node/src/cli.ts", import.meta.url);
const [cmd, sub] = process.argv.slice(2);

if (cmd === "node" && sub === "start") {
  const { keep } = await import("./keeper.mjs");
  keep(cli);
} else if (cmd === "hub" && sub === "start") {
  const { keep } = await import("./keeper.mjs");
  keep(new URL("../apps/hub/src/main.ts", import.meta.url), []);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(cli.href);
}
