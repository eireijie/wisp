import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueToken } from "./auth.ts";
import type { Hub } from "./hub.ts";

/**
 * The hub's own computer as a device, without tokens: `warren service install node --local` (the
 * installer runs it) leaves a request next to the hub's data, and once the organization has an
 * owner the hub registers this computer as their device and writes back where and how to connect.
 * The device service, waiting on the same computer, picks that up and connects.
 */
export const REQUEST_FILE = "local-device.request";
export const GRANT_FILE = "local-device.json";

export interface LocalDeviceGrant {
  hub: string;
  token: string;
  name: string;
}

/** This computer's name for the device list ("Yugs-MacBook-Air.local" → "Yugs-MacBook-Air"). */
export const localName = (host = os.hostname()) => host.replace(/\.(local|lan|home)$/i, "").slice(0, 80) || "This computer";

/** Answer a waiting request, if there is one and an owner to give the device to. True when a device was made. */
export function grantLocalDevice(hub: Hub, dataDir: string, port = Number(process.env.PORT ?? 4747)): boolean {
  const request = path.join(dataDir, REQUEST_FILE);
  const grant = path.join(dataDir, GRANT_FILE);
  if (!fs.existsSync(request) || fs.existsSync(grant)) return false;
  const ws = hub.store.firstWorkspace();
  const owner = ws ? hub.store.members(ws.id).find((m) => m.role === "owner") : undefined;
  if (!ws || !owner) return false;
  let name = localName();
  try {
    const asked = JSON.parse(fs.readFileSync(request, "utf8")) as { name?: unknown };
    if (typeof asked.name === "string" && asked.name.trim()) name = asked.name.trim().slice(0, 80);
  } catch {}
  const node = hub.store.createNode(ws.id, name, owner.id);
  const body: LocalDeviceGrant = { hub: `http://127.0.0.1:${port}`, token: issueToken(hub.store.db, "node", node.id, ws.id, name), name };
  fs.writeFileSync(grant, JSON.stringify(body, null, 2), { mode: 0o600 });
  fs.rmSync(request, { force: true });
  return true;
}

/** Keep answering: now, and every few seconds (a request can come before or after the first account). */
export function watchLocalDevice(hub: Hub, dataDir: string): () => void {
  const check = () => {
    try {
      grantLocalDevice(hub, dataDir);
    } catch {}
  };
  check();
  const t = setInterval(check, 3000);
  t.unref();
  return () => clearInterval(t);
}
