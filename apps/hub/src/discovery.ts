import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bonjour } from "bonjour-service";

/** Independent of workspace names and addresses, and kept across restarts. */
export function stableHubId(dataDir: string): string {
  const file = path.join(dataDir, "hub-id");
  fs.mkdirSync(dataDir, { recursive: true });
  try { fs.writeFileSync(file, crypto.randomUUID(), { flag: "wx", mode: 0o600 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return fs.readFileSync(file, "utf8").trim();
}

/** DNS-SD's type is wisp + tcp; bonjour adds the underscores on the wire. */
export function advertiseWisp(dataDir: string, port: number, workspaceName: () => string | undefined, onError: (error: Error) => void = () => {}, create = () => new Bonjour({}, onError)) {
  const id = stableHubId(dataDir), bonjour = create();
  let name = workspaceName() ?? "Your Wisp";
  const publish = () => bonjour.publish({ name: `Wisp-${id}`, type: "wisp", protocol: "tcp", port, txt: { v: "1", id, name, host: os.hostname() } });
  let service = publish();
  service.on("error", onError);
  const refresh = setInterval(() => {
    const next = workspaceName() ?? "Your Wisp";
    if (next !== name) {
      name = next;
      service.destroyed = true;
      service.stop(() => {
        if (stopped) return;
        service = publish();
        service.on("error", onError);
      });
    }
  }, 4000);
  refresh.unref();
  let stopped = false;
  let stopping: Promise<void> | null = null;
  return () => stopping ??= new Promise<void>((resolve) => {
    stopped = true;
    clearInterval(refresh);
    bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
  });
}
