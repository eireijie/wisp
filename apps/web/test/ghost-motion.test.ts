import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Message } from "@warren/core";
import type { ChannelInfo } from "../src/store.ts";
import { boundPet, chatPet, petBounds, petLoop, petTarget, sidebarPet } from "../src/ghostRoam.ts";
import { gazeTarget, ghostPointer, refreshGhostGaze, registerGhost } from "../src/ghostGaze.ts";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => motion.reduced }));
afterEach(() => { motion.reduced = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared ghost gaze", () => {
  function page() {
    const window = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800 });
    const document = Object.assign(new EventTarget(), { documentElement: new EventTarget(), hidden: false });
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const flush = () => {
      let count = 0;
      while (frames.size && count++ < 150) {
        const next = [...frames.values()];
        frames.clear();
        next.forEach((fn) => fn(count * 16));
      }
      expect(frames.size).toBe(0);
    };
    const pointer = (type: string, pointerType = "mouse", x = 180, y = 150) => window.dispatchEvent(Object.assign(new Event(type), { pointerType, clientX: x, clientY: y }));
    const ghost = (offscreen = false, facing = 1) => {
      const node = () => ({ setAttribute: vi.fn() });
      const pupil = node(), shine = node(), body = node();
      const face = { ...node(), querySelectorAll: (selector: string) => selector === "[data-ghost-pupil]" ? [pupil] : [shine] };
      const root = { getBoundingClientRect: () => ({ left: 100, top: offscreen ? 1000 : 100, width: 40, height: 40, right: 140, bottom: offscreen ? 1040 : 140 }), closest: () => ({ dataset: { petFacing: String(facing) } }) };
      return { face, body, pupil, shine, stop: registerGhost({ root, face, body } as unknown as Parameters<typeof registerGhost>[0]) };
    };
    return { window, document, frames, flush, pointer, ghost };
  }

  it("clamps distant gaze, strengthens previews and tilts only nearby", () => {
    expect(gazeTarget(10000, -10000, 40)).toEqual([4.5, -3, 2.2, -2.2, 0]);
    expect(gazeTarget(0, 0, 16)).toEqual([0, 0, 0, 0, 0]);
    expect(gazeTarget(20, 5, 40)[4]).toBeGreaterThan(0);
    expect(gazeTarget(70, 20, 40, true)[0]).toBeGreaterThan(gazeTarget(70, 20, 40)[0]);
  });

  it("shares one passive listener and one settling frame loop, then cleans up", () => {
    const p = page();
    const add = vi.spyOn(p.window, "addEventListener"), remove = vi.spyOn(p.window, "removeEventListener");
    const a = p.ghost(), b = p.ghost(), hidden = p.ghost(true);
    try {
      expect(add.mock.calls.filter(([name]) => name === "pointermove")).toHaveLength(1);
      expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });
      p.pointer("pointermove");
      p.pointer("pointermove");
      expect(p.frames.size).toBe(1);
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).not.toBe("translate(0 0)");
      expect(b.face.setAttribute.mock.lastCall).toEqual(a.face.setAttribute.mock.lastCall);
      expect(a.pupil.setAttribute.mock.lastCall?.[1]).not.toBe("translate(0 0)");
      expect(a.shine.setAttribute.mock.lastCall?.[1]).toContain("translate(-");
      expect(hidden.face.setAttribute).not.toHaveBeenCalled();
      p.document.documentElement.dispatchEvent(new Event("pointerleave"));
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).toBe("translate(0 0)");
    } finally { a.stop(); b.stop(); hidden.stop(); }
    expect(remove.mock.calls.filter(([name]) => name === "pointermove")).toHaveLength(1);
    expect(p.frames.size).toBe(0);
  });

  it("glances at touch taps for 1.2 seconds and stops for hidden pages or reduced motion", () => {
    vi.useFakeTimers();
    const p = page(), a = p.ghost();
    try {
      p.flush();
      p.pointer("pointermove", "touch");
      expect(ghostPointer().active).toBe(false);
      p.pointer("pointerdown", "touch");
      p.flush();
      p.document.documentElement.dispatchEvent(Object.assign(new Event("pointerleave"), { pointerType: "touch" }));
      expect(ghostPointer().active).toBe(true);
      vi.advanceTimersByTime(1200);
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).toBe("translate(0 0)");
      p.pointer("pointermove");
      p.flush();
      motion.reduced = true;
      refreshGhostGaze();
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).toBe("translate(0 0)");
      motion.reduced = false;
      p.pointer("pointermove");
      p.document.hidden = true;
      p.document.dispatchEvent(new Event("visibilitychange"));
      expect(p.frames.size).toBe(0);
      expect(a.body.setAttribute.mock.lastCall?.[1]).toBe("rotate(0 60 85)");
      expect(ghostPointer().active).toBe(false);
    } finally { a.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("looks toward the pointer even when the roaming wrapper faces left", () => {
    const p = page(), a = p.ghost(false, -1);
    try {
      p.pointer("pointermove", "mouse", 140, 120);
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).toContain("translate(-");
      expect(a.body.setAttribute.mock.lastCall?.[1]).toBe("rotate(-2.5 60 85)");
      p.window.dispatchEvent(new Event("blur"));
      p.flush();
      expect(a.face.setAttribute.mock.lastCall?.[1]).toBe("translate(0 0)");
    } finally { a.stop(); }
  });
});

describe("roaming pet placement", () => {
  it("keeps targets and resized positions inside margins, including tiny containers", () => {
    const bounds = petBounds(240, 64, 36);
    expect(petTarget(bounds, () => 0)).toEqual({ x: 12, y: 8 });
    expect(petTarget(bounds, () => 1)).toEqual({ x: 188, y: 20 });
    expect(boundPet({ x: 999, y: -50 }, bounds)).toEqual({ x: 188, y: 8 });
    expect(petTarget(petBounds(10, 10, 44))).toEqual({ x: 0, y: 0 });
  });

  it("finishes a complete celebration loop in bounds and returns to its starting point", () => {
    const bounds = petBounds(240, 64, 36);
    const start = { x: bounds.maxX, y: bounds.maxY };
    expect(petLoop(start, bounds, 0)).toEqual(start);
    expect(petLoop(start, bounds, 1)).toEqual(start);
    const positions = Array.from({ length: 101 }, (_, i) => petLoop(start, bounds, i / 100));
    positions.forEach((point) => expect(point).toEqual(boundPet(point, bounds)));
    expect(Math.min(...positions.map((p) => p.x))).toBeLessThan(start.x - 10);
    expect(Math.min(...positions.map((p) => p.y))).toBeLessThan(start.y - 10);
  });

  const agents = [{ id: "a", status: "offline" }, { id: "b", status: "online" }] as Agent[];
  const dm = (id: string, date: string) => ({ id, kind: "dm", name: `user:${id}`, lastReadAt: date }) as ChannelInfo;
  it("uses the current or last-read DM, then an online agent, then the first agent", () => {
    expect(sidebarPet(agents, [dm("a", "2026-01-01"), dm("b", "2026-02-01")], "a")?.id).toBe("a");
    expect(sidebarPet(agents, [dm("a", "2026-01-01"), dm("b", "2026-02-01")], null)?.id).toBe("b");
    expect(sidebarPet(agents, [], null)?.id).toBe("b");
    expect(sidebarPet([{ ...agents[0], status: "busy" }, agents[1]], [], null)?.id).toBe("b");
    expect(sidebarPet(agents.slice(0, 1), [], null)?.id).toBe("a");
    expect(sidebarPet([], [], null)).toBeUndefined();
  });

  it("selects the DM agent or the last agent author, ignoring later human messages", () => {
    const messages = [{ author: { kind: "agent", id: "a" } }, { author: { kind: "agent", id: "b" } }, { author: { kind: "user", id: "a" } }] as Message[];
    expect(chatPet(agents, dm("a", ""), messages)?.id).toBe("a");
    expect(chatPet(agents, { kind: "channel", name: "general" }, messages)?.id).toBe("b");
    expect(chatPet(agents, { kind: "channel", name: "general" })).toBeUndefined();
  });
});
