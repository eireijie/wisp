import { describe, expect, it, vi } from "vitest";
import type { ComputerInfo } from "../store.ts";
import type { DeviceInfo } from "../devices.ts";

vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
const { groupComputers, onlineCount, deviceStatus } = await import("./ComputersParts.tsx");

const device = (id: string, online = true): DeviceInfo => ({ id, name: id, online, agents: [] });
const computer = (id: string, kind: ComputerInfo["kind"], nodeId: string | null, online = true) => ({ id, kind, nodeId, online, agents: [] }) as unknown as ComputerInfo;

describe("the merged Computers page", () => {
  it("nests each device's computers under it, its own screen last, and puts cloud computers apart", () => {
    const g = groupComputers([device("mac"), device("pc", false)], [computer("screen", "device", "mac"), computer("vm", "vm", "mac"), computer("cloud", "orgo", null)]);
    expect(g.devices[0].computers.map((c) => c.id)).toEqual(["vm", "screen"]);
    expect(g.devices[1].computers).toEqual([]);
    expect(g.cloud.map((c) => c.id)).toEqual(["cloud"]);
  });
  it("counts devices and cloud computers that are online", () => {
    const g = groupComputers([device("mac"), device("pc", false)], [computer("cloud", "orgo", null)]);
    expect(onlineCount([device("mac"), device("pc", false)], g.cloud)).toEqual({ online: 2, total: 3 });
  });
  it("names a device's state", () => {
    expect(deviceStatus({ online: true })).toEqual({ label: "Online", tone: "ok" });
    expect(deviceStatus({ online: false })).toEqual({ label: "Offline", tone: "neutral" });
    expect(deviceStatus({ online: true, paused: true }).label).toBe("Paused");
    expect(deviceStatus({ online: true, update: { state: "restarting", message: "" } }).label).toBe("Updating");
    expect(deviceStatus({ online: true, update: { state: "failed", message: "" } }).label).toBe("Update failed");
  });
});
