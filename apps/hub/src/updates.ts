import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { REPO_ROOT, checkForUpdate, run, runUpdate, version, type Runner, type UpdateCheck, type UpdateResult, type Version } from "@wisp/update";
import type { Hub } from "./hub.ts";

/** How long a check for updates is reused before asking GitHub again. */
const CHECK_TTL_MS = 10 * 60_000;
/** A device has this long to pull, install and build before the hub stops waiting. */
const DEVICE_UPDATE_MS = 30 * 60_000;

export interface UpdateState {
  state: "idle" | "updating" | "restarting" | "failed";
  message: string;
  /** progress lines from the current or last update */
  log: string[];
}

const idle = (): UpdateState => ({ state: "idle", message: "", log: [] });

/**
 * Updating the hub and devices from the web app. The work itself is in @wisp/update; this keeps
 * track of what's in progress so the Settings and Devices pages can show it. Finishing an update
 * writes the update marker, and the process restarts itself (see main.ts and the device CLI).
 */
export class Updates {
  /** the hub's checkout and how commands run; tests swap them */
  root = REPO_ROOT;
  runner: Runner = run;
  hub: UpdateState = idle();
  private check: UpdateCheck | null = null;
  private checking: Promise<UpdateCheck> | null = null;
  private devices = new Map<string, Version>();
  private deviceUpdates = new Map<string, UpdateState>();

  constructor(private owner: Hub) {}

  version(): Promise<Version> {
    return version(this.root, this.runner);
  }

  /** What GitHub has that this hub doesn't, reusing a recent answer unless `fresh`. */
  async latest(fresh = false): Promise<UpdateCheck> {
    if (!fresh && this.check && Date.now() - Date.parse(this.check.checkedAt) < CHECK_TTL_MS) return this.check;
    this.checking ??= checkForUpdate(this.root, { runner: this.runner }).finally(() => (this.checking = null));
    return (this.check = await this.checking);
  }

  lastCheck(): UpdateCheck | null {
    return this.check;
  }

  updateHub(): void {
    if (this.hub.state === "updating" || this.hub.state === "restarting") throw new Error("an update is already running");
    this.hub = { state: "updating", message: "Updating…", log: [] };
    runUpdate(this.root, { runner: this.runner, log: (line) => this.hub.log.push(line) }).then(
      (r) => {
        this.check = null;
        this.hub = r.from === r.to ? { state: "idle", message: "Already up to date.", log: this.hub.log } : { state: "restarting", message: `Updated to ${r.to}. Restarting…`, log: this.hub.log };
      },
      (err) => (this.hub = { state: "failed", message: (err as Error).message, log: this.hub.log }),
    );
  }

  // --- devices ------------------------------------------------------------------------------------

  deviceVersion(nodeId: string): Version | null {
    return this.devices.get(nodeId) ?? null;
  }

  deviceUpdate(nodeId: string): UpdateState | null {
    return this.deviceUpdates.get(nodeId) ?? null;
  }

  /** A device said hello; a device that just restarted after an update is done. */
  deviceConnected(nodeId: string, v: Version | undefined) {
    const before = this.devices.get(nodeId);
    if (v) this.devices.set(nodeId, v);
    const u = this.deviceUpdates.get(nodeId);
    if (u?.state === "restarting" && v?.commit && v.commit !== before?.commit) this.deviceUpdates.delete(nodeId);
  }

  updateDevice(nodeId: string): void {
    const cur = this.deviceUpdates.get(nodeId);
    if (cur?.state === "updating" || cur?.state === "restarting") throw new Error("this device is already updating");
    this.deviceUpdates.set(nodeId, { state: "updating", message: "Updating…", log: [] });
    this.owner.computers.nodeRequest(nodeId, (requestId) => ({ type: "update", requestId }), DEVICE_UPDATE_MS).then(
      (res) => {
        const r = res as UpdateResult;
        this.deviceUpdates.set(nodeId, r.from === r.to ? { state: "idle", message: "Already up to date.", log: [] } : { state: "restarting", message: `Updated to ${r.to}. Restarting once its agents are done…`, log: [] });
      },
      (err) => this.deviceUpdates.set(nodeId, { state: "failed", message: (err as Error).message, log: [] }),
    );
  }
}

type Need = (req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean }) => { workspaceId: string } | null;

export function registerUpdateApi(app: FastifyInstance, hub: Hub, { need }: { need: Need }) {
  const { store, updates } = hub;

  /** The hub's version, the last check for updates, and any update in progress. */
  app.get("/api/updates", async (req, reply) => {
    if (!need(req, reply)) return;
    return { version: await updates.version(), check: updates.lastCheck(), update: updates.hub };
  });

  app.post("/api/updates/check", async (req, reply) => {
    if (!need(req, reply)) return;
    return { version: await updates.version(), check: await updates.latest(true), update: updates.hub };
  });

  app.post("/api/updates/hub", async (req, reply) => {
    if (!need(req, reply, { owner: true })) return;
    try {
      updates.updateHub();
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    return { update: updates.hub };
  });

  app.post("/api/nodes/:id/update", async (req, reply) => {
    const c = need(req, reply, { owner: true });
    if (!c) return;
    const node = store.node((req.params as { id: string }).id);
    if (!node || node.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "device not found" });
    if (!hub.isNodeOnline(node.id)) return reply.code(503).send({ error: `${node.name} is offline` });
    try {
      updates.updateDevice(node.id);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    return { update: updates.deviceUpdate(node.id) };
  });
}
