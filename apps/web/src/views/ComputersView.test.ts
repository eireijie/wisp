import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { ComputersView } from "./ComputersView.tsx";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../api.ts", () => ({ api: vi.fn(), uploadFile: vi.fn() }));
vi.mock("../store.ts", async (original) => {
  const actual = await original<typeof import("../store.ts")>();
  return { ...actual, useStore: Object.assign((select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => select(actual.useStore.getState()), actual.useStore) };
});
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../devices.ts", () => ({ useDevices: () => [] }));
vi.mock("../components/ComputerSync.tsx", () => ({ remotePlatform: () => "linux", useClipboardSync: () => ({}) }));

const initial = useStore.getState();
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue({});
  vi.mocked(useEffect).mockClear();
  useStore.setState({ me: { user: { id: "me" }, role: "owner" } as never, agents: [], computers: [{ id: "computer", kind: "vm", config: {}, agents: [], online: true, controller: null } as unknown as ComputerInfo] });
});
afterEach(() => useStore.setState(initial, true));

function mount() {
  const element = ComputersView({ computerId: "computer", teach: null }) as any;
  element.type(element.props);
  const effect = vi.mocked(useEffect).mock.calls.find(([, deps]) => deps?.[0] === "computer" && deps?.[1] === "me")![0];
  return effect() as () => void;
}

describe("computer control cleanup", () => {
  it("releases control acquired after mounting when the detail view unmounts", () => {
    const unmount = mount();
    useStore.setState((s) => ({ computers: s.computers.map((c) => ({ ...c, controller: { kind: "user", id: "me", since: new Date().toISOString() } })) }));
    expect(api).not.toHaveBeenCalled();
    unmount();
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/computers/computer/control", { take: false });
  });

  it.each([null, { kind: "user", id: "other" }])("doesn't release a computer the user no longer controls (%j)", (controller) => {
    const unmount = mount();
    useStore.setState((s) => ({ computers: s.computers.map((c) => ({ ...c, controller: controller as ComputerInfo["controller"] })) }));
    unmount();
    expect(api).not.toHaveBeenCalled();
  });
});
