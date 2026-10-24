import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_CODE, underKeeper, watchForUpdates } from "@warren/update";
import { advertiseWisp } from "./discovery.ts";
import { buildHub } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.WARREN_DATA_DIR ?? path.join(here, "../../../data"));
const webDir = path.resolve(process.env.WARREN_WEB_DIR ?? path.join(here, "../../web/dist"));
const port = Number(process.env.PORT ?? 4747);
const host = process.env.HOST ?? "0.0.0.0";

const { app, hub } = await buildHub({ dataDir, webDir, logger: true });
let stopDiscovery: () => void | Promise<void> = () => {};
app.addHook("onListen", async () => {
  const address = app.server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  stopDiscovery = advertiseWisp(dataDir, listeningPort, () => hub.store.firstWorkspace()?.name, (error) => app.log.warn({ error }, "Wisp discovery is unavailable"));
});
app.addHook("preClose", async () => { await stopDiscovery(); });
await app.listen({ port, host });
app.log.info(`Wisp on http://localhost:${port} (data: ${dataDir})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));

// an update (from Settings, a device sharing this folder, or `warren update`) restarts the hub
const kept = underKeeper();
watchForUpdates(() => {
  if (!kept) return app.log.warn("Warren was updated; restart the hub to use the new version");
  app.log.info("Warren was updated; restarting");
  app.close().then(() => process.exit(RESTART_CODE));
});
