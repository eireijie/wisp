#!/usr/bin/env node
// `warren` CLI: connect a device to a hub. Runs the TypeScript source through tsx; `warren node
// start` runs under the keeper so it restarts itself after an update.
const cli = new URL("../apps/node/src/cli.ts", import.meta.url);
const [cmd, sub] = process.argv.slice(2);

if (cmd === "node" && sub === "start") {
  const { keep } = await import("./keeper.mjs");
  keep(cli);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(cli.href);
}
