import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHub } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.WARREN_DATA_DIR ?? path.join(here, "../../../data"));
const webDir = path.resolve(process.env.WARREN_WEB_DIR ?? path.join(here, "../../web/dist"));
const port = Number(process.env.PORT ?? 4747);
const host = process.env.HOST ?? "0.0.0.0";

const { app } = await buildHub({ dataDir, webDir, logger: true });
await app.listen({ port, host });
app.log.info(`Warren hub on http://localhost:${port} (data: ${dataDir})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => app.close().then(() => process.exit(0)));
