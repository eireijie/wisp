import { describe, expect, it } from "vitest";
import { agentRunsOn, defaultRunsOn, runsOnChoices, runsOnCreate, runsOnMove, type DeviceInfo } from "./devices.ts";

const dev = (id: string, o: Partial<DeviceInfo> = {}): DeviceInfo => ({ id, name: id, online: true, agents: [], mine: true, ...o });
const shared = { id: "vm1", nodeId: "mac", config: { shared: true } } as never;
const ownVm = { id: "vm2", nodeId: "mac", config: {} } as never;

describe("Runs on (round 16, board 16c)", () => {
  const devices = [dev("mac", { name: "Sam's MacBook", capabilities: { platform: "darwin" } as never }), dev("mini", { name: "Living room Mac mini", online: false }), dev("pc", { name: "Office PC", capabilities: { platform: "win32" } as never }), dev("theirs", { mine: false, shared: false })];

  it("lists the shared computer, then the devices this person can use, online ones first", () => {
    const c = runsOnChoices(devices, [shared]);
    expect(c.map((x) => [x.label, x.sub])).toEqual([
      ["Shared computer", "Always on · on Sam's MacBook"],
      ["Sam's MacBook", "Mac · online"],
      ["Office PC", "Windows · online"],
      ["Living room Mac mini", "Offline"],
    ]);
    // no shared computer yet: just the devices
    expect(runsOnChoices(devices, []).map((x) => x.key)).toEqual(["d:mac", "d:pc", "d:mini"]);
    // someone else's device they shared, with their name
    expect(runsOnChoices([dev("x", { name: "Rae's PC", mine: false, shared: true, ownerName: "Rae" })], [])[0].sub).toBe("Rae's · online");
  });

  it("starts where the defaults would put it", () => {
    const c = runsOnChoices(devices, [shared]);
    expect(defaultRunsOn(c, { computer: "shared", nodeId: "pc" }, true)?.key).toBe("shared");
    // a member's agents never go on the shared computer by default
    expect(defaultRunsOn(c, { computer: "shared", nodeId: "pc" }, false)?.key).toBe("d:pc");
    expect(defaultRunsOn(c, { computer: "device", nodeId: null }, true)?.key).toBe("d:mac");
    expect(defaultRunsOn([], null, true)).toBeNull();
  });

  it("says where an agent runs and what moving it sends", () => {
    expect(agentRunsOn({ nodeId: "mac", computerId: "vm1" }, [shared])).toBe("shared");
    expect(agentRunsOn({ nodeId: "pc", computerId: null }, [shared])).toBe("d:pc");
    expect(agentRunsOn({ nodeId: null, computerId: null }, [])).toBeNull();
    const [toShared, , toPc] = runsOnChoices(devices, [shared]);
    expect(runsOnCreate(toShared.to)).toEqual({ nodeId: "mac", computerId: "vm1" });
    expect(runsOnCreate(toPc.to)).toEqual({ nodeId: "pc" });
    // off the shared computer, or away from its own computer's device: it runs on the device itself
    expect(runsOnMove({ nodeId: "mac", computerId: "vm1" }, toPc.to, [shared])).toEqual({ nodeId: "pc", computerId: null, settings: { runIn: "device" } });
    expect(runsOnMove({ nodeId: "mac", computerId: "vm2" }, toPc.to, [ownVm])).toEqual({ nodeId: "pc", computerId: null, settings: { runIn: "device" } });
    expect(runsOnMove({ nodeId: "mac", computerId: null }, toPc.to, [])).toEqual({ nodeId: "pc" });
    expect(runsOnMove({ nodeId: "pc", computerId: null }, toShared.to, [shared])).toEqual({ nodeId: "mac", computerId: "vm1" });
  });
});
