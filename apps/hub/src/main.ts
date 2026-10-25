import os from "node:os";
import { migrateHome, migrateDataDir } from "../../node/src/migrate-home.ts";
import { envVar } from "@wisp/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_CODE, underKeeper, watchForUpdates } from "@wisp/update";
import { advertiseWisp } from "./discovery.ts";
import { buildHub } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = migrateHome({ home: os.homedir(), log: console.log });
const dataDir = path.resolve(migrateDataDir(envVar("DATA_DIR") ?? envVar("DEFAULT_DATA_DIR") ?? path.join(home.dir, "data"), console.log));
const webDir = path.resolve(envVar("WEB_DIR") ?? path.join(here, "../../web/dist"));
const port = Number(process.env.PORT ?? 4747);
const host = process.env.HOST ?? "0.0.0.0";

const { app, hub, setupCode } = await buildHub({ dataDir, webDir, logger: true });
let stopDiscovery: () => void | Promise<void> = () => {};
app.addHook("onListen", async () => {
  const address = app.server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  stopDiscovery = advertiseWisp(dataDir, listeningPort, () => hub.store.firstWorkspace()?.name, (error) => app.log.warn({ error }, "Wisp discovery is unavailable"));
});
app.addHook("preClose", async () => { await stopDiscovery(); });
await app.listen({ port, host });
app.log.info(`Wisp on http://localhost:${port} (data: ${dataDir})`);
if (setupCode.code) app.log.info(`Set up Wisp at http://localhost:${port}/#/setup/${setupCode.code} (setup code ${setupCode.code}, also in ${path.join(dataDir, "setup-code")})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));

// an update (from Settings, a device sharing this folder, or `wisp update`) restarts the hub
const kept = underKeeper();
watchForUpdates(() => {
  if (!kept) return app.log.warn("Wisp was updated; restart the hub to use the new version");
  app.log.info("Wisp was updated; restarting");
  app.close().then(() => process.exit(RESTART_CODE));
});
