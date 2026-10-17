import { describe, expect, it, vi } from "vitest";
import { connectionLine, isLocalOnlyHost, notConnectedLine, screenLine } from "../src/views/NodesView.tsx";

vi.mock("../src/theme.ts", () => ({ motionReduced: () => false }));

const ago = (iso: string) => `ago(${iso})`;

describe("connectionLine", () => {
  it("says Connected when online, without a last-seen time", () => {
    expect(connectionLine({ online: true, lastSeen: "2026-01-01T00:00:00Z" }, ago)).toBe("Connected");
  });
  it("says when an offline device was last seen", () => {
    expect(connectionLine({ online: false, lastSeen: "x" }, ago)).toBe("Last seen ago(x)");
  });
  it("says Never connected when it never was", () => {
    expect(connectionLine({ online: false, lastSeen: null }, ago)).toBe("Never connected");
  });
});

describe("screenLine", () => {
  const on = { screen: { ok: true } } as never;
  const off = { screen: { ok: false, off: true } } as never;
  it("is unknown when offline, even with old capabilities", () => {
    expect(screenLine({ online: false, capabilities: null })).toBe("Its screen: unknown until it connects.");
    expect(screenLine({ online: false, capabilities: on })).toContain("unknown until it connects");
    expect(screenLine({ online: false, capabilities: on })).toContain("Last time: on");
    expect(screenLine({ online: false, capabilities: off })).toContain("Last time: off");
  });
  it("defers to the capability text when online and known", () => {
    expect(screenLine({ online: true, capabilities: on })).toBe("");
  });
  it("says not checked yet when online but nothing reported", () => {
    expect(screenLine({ online: true, capabilities: null })).toBe("Its screen: not checked yet.");
  });
});

describe("notConnectedLine", () => {
  it("distinguishes never connected from offline", () => {
    expect(notConnectedLine({ online: false, lastSeen: null })).toBe("This device hasn't connected yet.");
    expect(notConnectedLine({ online: false, lastSeen: "x" })).toBe("This device was connected before but is offline now.");
    expect(notConnectedLine({ online: true, lastSeen: "x" })).toBeNull();
  });
  it("knows local-only hosts", () => {
    expect(isLocalOnlyHost("localhost")).toBe(true);
    expect(isLocalOnlyHost("warren.example.com")).toBe(false);
  });
});
