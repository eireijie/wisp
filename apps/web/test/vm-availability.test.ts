import { describe, expect, it } from "vitest";
import { vmAvailabilityNote, type DeviceInfo } from "../src/devices.ts";

const dev = (name: string, online: boolean, vm?: { ok: boolean; detail: string }): DeviceInfo =>
  ({ id: name, name, online, mine: true, agents: [], capabilities: vm ? ({ vm } as DeviceInfo["capabilities"]) : null });

describe("vmAvailabilityNote", () => {
  it("says nothing when some device can run VMs", () => {
    expect(vmAvailabilityNote([dev("a", false), dev("b", true, { ok: true, detail: "ready" })])).toBeUndefined();
  });
  it("asks for a device when there are none", () => {
    expect(vmAvailabilityNote([])).toBe("Connect a device first.");
  });
  it("does not blame missing software while every device is offline", () => {
    expect(vmAvailabilityNote([dev("my-mac", false)])).toBe("Can't check while my-mac is disconnected. Reconnect a device to see what it can run.");
    expect(vmAvailabilityNote([dev("a", false), dev("b", false)])).toContain("while a and b are disconnected");
    expect(vmAvailabilityNote([dev("a", false), dev("b", false), dev("c", false)])).toContain("while a, b and c are disconnected");
  });
  it("uses the device's own reason when an online device reports no VM support", () => {
    expect(vmAvailabilityNote([dev("box", true, { ok: false, detail: "Docker isn't running" })])).toBe("box: Docker isn't running");
    expect(vmAvailabilityNote([dev("box", true, { ok: false, detail: "" })])).toBe("None of your devices can run VMs yet: install Docker on one.");
  });
  it("says it is checking when an online device has not reported yet", () => {
    expect(vmAvailabilityNote([dev("box", true)])).toBe("Checking what box can run…");
  });
});
