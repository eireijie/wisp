import { describe, expect, it } from "vitest";
import { connectSteps, joinLink } from "../src/devices.ts";

describe("joinLink", () => {
  it("carries the server address, the connection code and the device name, escaped", () => {
    const link = joinLink("http://192.168.1.20:4747", "wr_node_abc_DEF-123", "Yug's Mac");
    expect(link.startsWith("warren://join?")).toBe(true);
    const q = new URL(link).searchParams;
    expect(q.get("hub")).toBe("http://192.168.1.20:4747");
    expect(q.get("code")).toBe("wr_node_abc_DEF-123");
    expect(q.get("name")).toBe("Yug's Mac");
  });
});

describe("connectSteps", () => {
  it("counts earlier steps as done once a later one is", () => {
    expect(connectSteps({ downloaded: false, opened: false, connected: true })).toEqual({ downloaded: true, opened: true, connected: true });
    expect(connectSteps({ downloaded: false, opened: true, connected: false })).toEqual({ downloaded: true, opened: true, connected: false });
    expect(connectSteps({ downloaded: true, opened: false, connected: false })).toEqual({ downloaded: true, opened: false, connected: false });
  });
});
