import { afterEach, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function device() {
  const storage = new Map<string, string>();
  const media = { matches: false, addEventListener: vi.fn() };
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => null });
  vi.stubGlobal("MutationObserver", class { observe() {} });
  return { storage, media, root };
}

it("stops JS motion for the setting, OS preference or root attribute independently", async () => {
  const { root, media } = device();
  const theme = await import("../src/theme.ts");
  expect(theme.motionReduced()).toBe(false);
  theme.setReduceMotion(true);
  expect(theme.motionReduced()).toBe(true);
  theme.setReduceMotion(false);
  media.matches = true;
  expect(theme.motionReduced()).toBe(true);
  media.matches = false;
  root.dataset.motion = "reduce";
  expect(theme.motionReduced()).toBe(true);
  delete root.dataset.motion;
  expect(theme.motionReduced()).toBe(false);
});
