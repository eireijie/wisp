import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as (() => (() => void) | void)[],
  setMode: vi.fn(), setTheme: vi.fn(), setTextSize: vi.fn(), setReduceMotion: vi.fn(),
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useEffect: (fn: () => (() => void) | void) => { fixture.effects.push(fn); },
  useState: (value: any) => [typeof value === "function" ? value() : value, vi.fn()],
  useRef: (value: any) => ({ current: value }),
}));
vi.mock("../store.ts", () => ({ useStore: (select: (s: any) => any) => select({ agents: [], approvals: {}, computers: [], connected: false }) }));
vi.mock("../api.ts", () => ({ getToken: () => null }));
vi.mock("../theme.ts", () => ({ useMotionReduced: () => false, THEMES: [{ id: "mono" }, { id: "iris" }],
  setMode: fixture.setMode, setTheme: fixture.setTheme, setTextSize: fixture.setTextSize, setReduceMotion: fixture.setReduceMotion,
}));
vi.mock("../components/Ghost.tsx", () => ({ Ghost: () => null }));
vi.mock("../components/ui.tsx", () => ({ agentVar: () => ({}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.effects.length = 0; });

describe("open buddy appearance", () => {
  it("applies later appearance changes and clears them when storage is cleared", async () => {
    const window = new EventTarget();
    const values = new Map([["wisp.mode", "dark"], ["wisp.theme", "iris"], ["wisp.textSize", "large"], ["wisp.motion", "reduce"]]);
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
    vi.stubGlobal("document", { documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });
    const { BuddyView } = await import("./BuddyView.tsx");
    BuddyView();
    const dispose = fixture.effects[0]();
    const storage = (key: string | null) => window.dispatchEvent(Object.assign(new Event("storage"), { key }));
    try {
      for (const key of values.keys()) storage(key);
      expect(fixture.setMode).toHaveBeenLastCalledWith("dark");
      expect(fixture.setTheme).toHaveBeenLastCalledWith("iris");
      expect(fixture.setTextSize).toHaveBeenLastCalledWith("large");
      expect(fixture.setReduceMotion).toHaveBeenLastCalledWith(true);
      values.clear();
      storage(null);
      expect(fixture.setMode).toHaveBeenLastCalledWith("system");
      expect(fixture.setTheme).toHaveBeenLastCalledWith("mono");
      expect(fixture.setTextSize).toHaveBeenLastCalledWith("default");
      expect(fixture.setReduceMotion).toHaveBeenLastCalledWith(false);
    } finally { dispose?.(); }
    vi.clearAllMocks();
    storage("wisp.theme");
    expect(fixture.setTheme).not.toHaveBeenCalled();
  });
});
