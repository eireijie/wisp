import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { ComputersView, activityDot, computerState, stateColor } from "./ComputersView.tsx";

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

/** The detail view's element tree, without rendering components: every element, depth-first. */
function walk(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node);
    walk(node.props.children, out);
  }
  return out;
}
function detail(controller: unknown = null) {
  useStore.setState((s) => ({ computers: s.computers.map((c) => ({ ...c, controller: controller as ComputerInfo["controller"] })) }));
  const element = ComputersView({ computerId: "computer", teach: null }) as any;
  return walk(element.type(element.props));
}
const byTestId = (nodes: any[], id: string) => nodes.find((n) => n.props?.["data-testid"] === id);

describe("computer focus layout", () => {
  it("has no side aside and no title header row, only the screen with a floating name chip", () => {
    const nodes = detail();
    expect(nodes.some((n) => n.type === "aside")).toBe(false);
    expect(nodes.some((n) => String(n.props?.className ?? "").includes("t-title"))).toBe(false);
    expect(byTestId(nodes, "name-chip")).toBeTruthy();
    expect(nodes.some((n) => n.props?.["aria-label"] === "Details")).toBe(true);
  });

  it("while watching shows the Watching pill and no tools or amber frame", () => {
    const nodes = detail();
    expect(byTestId(nodes, "watching-pill")).toBeTruthy();
    expect(byTestId(nodes, "control-toolbar")).toBeUndefined();
    expect(byTestId(nodes, "control-frame")).toBeUndefined();
  });

  it("while in control shows the toolbar and the amber frame instead of the pill", () => {
    const nodes = detail({ kind: "user", id: "me", since: new Date().toISOString() });
    expect(byTestId(nodes, "control-toolbar")).toBeTruthy();
    expect(byTestId(nodes, "control-frame")).toBeTruthy();
    expect(byTestId(nodes, "watching-pill")).toBeUndefined();
    const labels = walk(byTestId(nodes, "control-toolbar")).map((n) => n.props?.["aria-label"]);
    expect(labels).toEqual(expect.arrayContaining(["Teach a task", "Clipboard", "Files", "Keys", "Screenshot"]));
  });
});

describe("status colors", () => {
  const now = new Date().toISOString();
  const base = { id: "c", kind: "vm", agents: [], online: true, controller: null, status: "running" } as unknown as ComputerInfo;
  const color = (c: Partial<ComputerInfo>, meId = "me") => {
    const full = { ...base, ...c } as ComputerInfo;
    return stateColor(computerState(full, meId, [], () => "Sam"), full, full.controller?.id === meId);
  };
  it("working is blue, ready is green, a problem is red", () => {
    expect(color({})).toBe("var(--st-online)");
    expect(color({ activity: { text: "Opening a page", at: now } } as never)).toBe("var(--st-working)");
    expect(color({ status: "starting" } as never)).toBe("var(--st-working)");
    expect(color({ status: "error" } as never)).toBe("var(--st-problem)");
  });
  it("you, someone else, or a call for help is amber", () => {
    expect(color({ controller: { kind: "user", id: "me", since: now } } as never)).toBe("var(--st-needs)");
    expect(color({ controller: { kind: "user", id: "sam", since: now } } as never)).toBe("var(--st-needs)");
    expect(color({ help: { agentId: "a", request: "log in", at: now } } as never)).toBe("var(--st-needs)");
  });
  it("offline or paused is gray, and offline wins over help and control", () => {
    expect(color({ online: false })).toBe("var(--status-idle)");
    expect(color({ online: false, help: { agentId: "a", request: "x", at: now }, controller: { kind: "user", id: "me", since: now } } as never)).toBe("var(--status-idle)");
    expect(color({ paused: true } as never)).toBe("var(--status-idle)");
    expect(color({ status: "stopped" } as never)).toBe("var(--status-idle)");
  });
  it("working computers are not warn-toned", () => {
    const state = computerState({ ...base, activity: { text: "x", at: now } } as unknown as ComputerInfo, "me", [], () => "Sam");
    expect(state).toMatchObject({ working: true, tone: "info" });
  });
  it("colors activity lines by what happened", () => {
    expect(activityDot("Took control")).toBe("var(--st-needs)");
    expect(activityDot("Handed it back")).toBe("var(--st-online)");
    expect(activityDot("Handed back")).toBe("var(--st-online)");
    expect(activityDot("Opened the live view")).toBe("var(--accent-computers)");
    expect(activityDot("Wrong code entered")).toBe("var(--status-idle)");
  });
});
