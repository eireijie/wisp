import { describe, expect, it } from "vitest";
import { isTopOverlay, registerOverlay, topOverlay } from "../src/overlays.ts";

describe("overlay stack", () => {
  it("only the last overlay opened is on top, and closing hands the keyboard back", () => {
    const builder = Symbol("builder"), modal = Symbol("modal"), palette = Symbol("palette");
    const offBuilder = registerOverlay(builder, "builder");
    expect(topOverlay()).toBe("builder");
    const offModal = registerOverlay(modal, "modal");
    expect(topOverlay()).toBe("modal");
    expect(isTopOverlay(builder)).toBe(false);
    const offPalette = registerOverlay(palette, "palette");
    expect(isTopOverlay(modal)).toBe(false);
    expect(isTopOverlay(palette)).toBe(true);
    offModal(); // closed out of order
    expect(isTopOverlay(palette)).toBe(true);
    offPalette();
    expect(topOverlay()).toBe("builder");
    offBuilder();
    expect(topOverlay()).toBeNull();
  });
});
