import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { VaultView } from "../views/VaultView.tsx";
import { ConnectorsView } from "../views/ConnectorsView.tsx";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(), useState: vi.fn(),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../experience.tsx", () => ({ useSimple: () => false }));
vi.mock("../features.ts", () => ({ useFeatures: () => ({ tasks: true }) }));
vi.mock("../store.ts", () => ({
  useStore: (select: (s: unknown) => unknown) => select({ paletteOpen: true, me: { user: { id: "me" }, role: "owner" }, channels: [], agents: [], members: [] }),
  useTeams: () => [],
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("location", new URL("https://warren.test/"));
  vi.mocked(api).mockReset();
  vi.mocked(useState).mockImplementation((initial?: any): [any, any] => [typeof initial === "function" ? initial() : initial, vi.fn()]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Run just each component's search effect, with controlled state and deferred API responses.
// This exercises the actual debounce and cleanup without requiring a browser DOM.
const cases = [
  { name: "palette", queryIndex: 0, resultIndex: 1, component: () => {
    const element = (CommandPalette() as any).props.children[0];
    return () => element.type(element.props);
  }, result: (name: string) => ({ channels: [], agents: [], messages: [], notes: [{ path: name, title: name, snippet: name }] }) },
  { name: "vault", queryIndex: 1, resultIndex: 2, component: () => () => VaultView({ path: null }), result: (name: string) => [{ path: name, title: name, snippet: name }] },
  { name: "connectors", queryIndex: 1, resultIndex: 7, component: () => () => ConnectorsView({}), result: (name: string) => ({ entries: [{ id: name, name }] }) },
];

describe.each(cases)("$name search", ({ queryIndex, resultIndex, component, result, name }) => {
  function setup() {
    const render = component();
    let query = "older";
    let latest: any = null;
    const requests: { resolve(value: any): void; reject(error: Error): void }[] = [];
    vi.mocked(api).mockImplementation(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
    function search(next: string) {
      query = next;
      let index = 0;
      vi.mocked(useEffect).mockClear();
      vi.mocked(useState).mockImplementation((initial?: any): [any, any] => {
        const current = index++;
        const value = current === queryIndex ? query : typeof initial === "function" ? initial() : initial;
        return [value, ((value: any) => {
          if (current === resultIndex) latest = typeof value === "function" ? value(latest ?? { q: "", entries: null }) : value;
        }) as any];
      });
      render();
      const effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === query)![0];
      return effect() as (() => void) | undefined;
    }
    return { search, requests, latest: () => latest };
  }

  it.each(["success", "error"])("ignores an older response after newer results (%s)", async (outcome) => {
    const h = setup();
    const cleanup = h.search("older");
    await vi.advanceTimersByTimeAsync(400);
    cleanup?.();
    h.search("newer");
    await vi.advanceTimersByTimeAsync(400);
    h.requests[1].resolve(result("newer"));
    await Promise.resolve();
    const latest = h.latest();
    expect(JSON.stringify(latest)).toContain("newer");
    if (outcome === "success") h.requests[0].resolve(result("older"));
    else h.requests[0].reject(new Error("Older request failed"));
    await Promise.resolve();
    expect(h.latest()).toEqual(latest);
  });

  it("ignores a response after clearing the query or closing the view", async () => {
    const h = setup();
    const cleanup = h.search("older");
    await vi.advanceTimersByTimeAsync(400);
    cleanup?.();
    const close = h.search("");
    close?.();
    const cleared = h.latest();
    h.requests[0].resolve(result("older"));
    await Promise.resolve();
    expect(h.latest()).toEqual(cleared);
    if (name !== "connectors") expect(h.latest()).toBeNull();
  });
});
