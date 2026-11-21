import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR, clampWidth, dragWidth, loadSidebar, saveSidebar, settle, stepWidth } from "../src/sidebarWidth.ts";

function fakeStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), clear: () => data.clear(), key: () => null, length: 0 };
}

describe("docked sidebar width", () => {
  it("follows the pointer between the narrowest and widest", () => {
    expect(dragWidth(300)).toBe(300);
    expect(dragWidth(150)).toBe(SIDEBAR.min);
    expect(dragWidth(900)).toBe(SIDEBAR.max);
    expect(dragWidth(250.6)).toBe(251);
  });

  it("snaps to icons under the snap point", () => {
    expect(dragWidth(SIDEBAR.snap - 1)).toBe(SIDEBAR.rail);
    expect(dragWidth(10)).toBe(SIDEBAR.rail);
    expect(dragWidth(-40)).toBe(SIDEBAR.rail);
    expect(dragWidth(SIDEBAR.snap)).toBe(SIDEBAR.min);
  });

  it("stays where a drag leaves it, and icons keep the last full width", () => {
    const s = { width: 300, collapsed: false };
    expect(settle(s, 340)).toEqual({ width: 340, collapsed: false });
    expect(settle(s, SIDEBAR.rail)).toEqual({ width: 300, collapsed: true });
  });

  it("moves 16px per arrow key and collapses past the narrowest", () => {
    expect(stepWidth({ width: 260, collapsed: false }, 1)).toEqual({ width: 276, collapsed: false });
    expect(stepWidth({ width: SIDEBAR.max, collapsed: false }, 1)).toEqual({ width: SIDEBAR.max, collapsed: false });
    expect(stepWidth({ width: SIDEBAR.min, collapsed: false }, -1)).toEqual({ width: SIDEBAR.min, collapsed: true });
    expect(stepWidth({ width: 300, collapsed: true }, 1)).toEqual({ width: SIDEBAR.min, collapsed: false });
    expect(stepWidth({ width: 300, collapsed: true }, -1)).toEqual({ width: 300, collapsed: true });
  });

  it("clamps junk to a sane width", () => {
    expect(clampWidth(NaN)).toBe(SIDEBAR.default);
    expect(clampWidth(5)).toBe(SIDEBAR.min);
  });

  describe("remembered on this device", () => {
    beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
    afterEach(() => vi.unstubAllGlobals());

    it("defaults to 260 and open", () => expect(loadSidebar()).toEqual({ width: SIDEBAR.default, collapsed: false }));

    it("survives a reload", () => {
      saveSidebar({ width: 333, collapsed: true });
      expect(loadSidebar()).toEqual({ width: 333, collapsed: true });
    });

    it("ignores a broken or out-of-range saved value", () => {
      localStorage.setItem("wisp.sidebar", "{not json");
      expect(loadSidebar()).toEqual({ width: SIDEBAR.default, collapsed: false });
      localStorage.setItem("wisp.sidebar", JSON.stringify({ width: 9000, collapsed: "yes" }));
      expect(loadSidebar()).toEqual({ width: SIDEBAR.max, collapsed: false });
    });

    it("still works when storage throws (private windows)", () => {
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
      expect(loadSidebar()).toEqual({ width: SIDEBAR.default, collapsed: false });
      expect(() => saveSidebar({ width: 300, collapsed: false })).not.toThrow();
    });
  });
});
