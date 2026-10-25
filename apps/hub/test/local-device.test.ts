import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHub } from "../src/app.ts";
import type { Hub } from "../src/hub.ts";
import { GRANT_FILE, REQUEST_FILE, grantLocalDevice, localName } from "../src/local-device.ts";

let dir: string;
let base: string;
let hub: Hub;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wisp-local-device-"));
  const built = await buildHub({ dataDir: dir, setupCode: false });
  hub = built.hub;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  close = () => built.app.close();
});

afterAll(async () => {
  await close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the hub's own computer as a device", () => {
  it("names the computer without its .local suffix", () => {
    expect(localName("Alexs-MacBook-Air.local")).toBe("Alexs-MacBook-Air");
    expect(localName("")).toBe("This computer");
  });

  it("waits for an owner, then registers this computer as their device and hands over a working token", async () => {
    writeFileSync(path.join(dir, REQUEST_FILE), JSON.stringify({ name: "home-mac" }));
    // nobody to give it to yet
    expect(grantLocalDevice(hub, dir, 4747)).toBe(false);
    const setup = await fetch(`${base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "me@example.com", name: "Me", password: "password123", workspaceName: "Home" }) }).then((r) => r.json());
    expect(grantLocalDevice(hub, dir, 4747)).toBe(true);
    expect(existsSync(path.join(dir, REQUEST_FILE))).toBe(false);
    const grant = JSON.parse(readFileSync(path.join(dir, GRANT_FILE), "utf8"));
    expect(grant).toMatchObject({ hub: "http://127.0.0.1:4747", name: "home-mac" });
    // it's the owner's device
    const nodes = await fetch(`${base}/api/nodes`, { headers: { authorization: `Bearer ${setup.token}` } }).then((r) => r.json());
    expect(nodes).toEqual([expect.objectContaining({ name: "home-mac", mine: true })]);
    // and the token connects as that device
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(base.replace("http", "ws") + "/ws/node", { headers: { authorization: `Bearer ${grant.token}` } });
    const welcomed = await new Promise<boolean>((resolve) => {
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString()).type === "welcome"));
      ws.on("close", () => resolve(false));
      ws.on("error", () => resolve(false));
    });
    ws.close();
    expect(welcomed).toBe(true);
    // answered once: a second check does nothing
    expect(grantLocalDevice(hub, dir, 4747)).toBe(false);
  });
});
