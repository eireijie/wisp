import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Bonjour } from "bonjour-service";
import { advertiseWisp, stableHubId } from "../src/discovery.ts";

afterEach(() => vi.useRealTimers());
describe("Wisp LAN discovery", () => {
  it("advertises the shared contract, updates its name and cleans up", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-discovery-"));
    try {
      let name: string | undefined;
      const service = () => Object.assign(new EventEmitter(), { destroyed: false, stop: vi.fn((cb: () => void) => cb()) });
      const published: ReturnType<typeof service>[] = [];
      const publish = vi.fn((_config: unknown) => { const s = service(); published.push(s); return s; });
      const destroy = vi.fn((cb: () => void) => cb()), unpublishAll = vi.fn((cb: () => void) => cb());
      const stop = advertiseWisp(dir, 4747, () => name, undefined, () => ({ publish, destroy, unpublishAll }) as unknown as Bonjour);
      const id = stableHubId(dir);
      expect(stableHubId(dir)).toBe(id);
      expect(publish).toHaveBeenCalledWith({ name: `Wisp-${id}`, type: "wisp", protocol: "tcp", port: 4747, txt: { v: "1", id, name: "Your Wisp", host: os.hostname() } });
      name = "Yug's Wisp";
      vi.advanceTimersByTime(4000);
      expect(published[0].stop).toHaveBeenCalledOnce();
      expect(published[0].destroyed).toBe(true);
      expect(publish.mock.calls[1][0]).toMatchObject({ txt: { id, name } });
      await stop(); await stop();
      expect(unpublishAll).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(8000); expect(publish).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
