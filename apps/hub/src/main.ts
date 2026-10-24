import os from "node:os";
import { migrateHome, migrateDataDir } from "../../node/src/migrate-home.ts";
import { envVar } from "@wisp/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_CODE, underKeeper, watchForUpdates } from "@wisp/update";
import { buildHub } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = migrateHome({ home: os.homedir(), log: console.log });
const dataDir = path.resolve(migrateDataDir(envVar("DATA_DIR") ?? envVar("DEFAULT_DATA_DIR") ?? path.join(home.dir, "data"), console.log));
const webDir = path.resolve(envVar("WEB_DIR") ?? path.join(here, "../../web/dist"));
const port = Number(process.env.PORT ?? 4747);
const host = process.env.HOST ?? "0.0.0.0";

const { app } = await buildHub({ dataDir, webDir, logger: true });
await app.listen({ port, host });
app.log.info(`Wisp hub on http://localhost:${port} (data: ${dataDir})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));

// an update (from Settings, a device sharing this folder, or `wisp update`) restarts the hub
const kept = underKeeper();
watchForUpdates(() => {
  if (!kept) return app.log.warn("Wisp was updated; restart the hub to use the new version");
  app.log.info("Wisp was updated; restarting");
  app.close().then(() => process.exit(RESTART_CODE));
});
