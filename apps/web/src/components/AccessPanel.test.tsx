import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { api } from "../api.ts";
import { useAccessStore, type AccessInfo } from "../access.ts";
import { AwayFromHome } from "./Access.tsx";

vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: vi.fn(), useEffect: vi.fn() }));
vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../access.ts", async (original) => {
  const actual = await original<typeof import("../access.ts")>();
  return {
    ...actual,
    useAccess: () => actual.useAccessStore.getState().info,
    useAccessStore: Object.assign((select: (s: ReturnType<typeof actual.useAccessStore.getState>) => unknown) => select(actual.useAccessStore.getState()), actual.useAccessStore),
  };
});
vi.mock("../store.ts", () => ({ useStore: (select: (s: any) => any) => select({ me: { role: "owner" } }) }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));

const original = useAccessStore.getState();
const info: AccessInfo = {
  publicUrl: null, lan: [], download: "", hubPlatform: "darwin",
  tailscale: { state: "missing", dnsName: null, serving: false, funnel: false },
  cloudflare: { state: "stopped", url: null, error: null },
};
let states: any[];
function render(onDone = vi.fn()) {
  let index = 0;
  vi.mocked(useState).mockImplementation((): [any, any] => {
    const current = index++;
    return [states[current], (value: any) => { states[current] = typeof value === "function" ? value(states[current]) : value; }];
  });
  return AwayFromHome({ onDone });
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, predicate)).find(Boolean);
}
beforeEach(() => {
  states = ["cloudflare", "  cloudflare-setup-code  ", false, null, null];
  useAccessStore.setState({ info });
  vi.mocked(api).mockReset();
});
afterEach(() => useAccessStore.setState(original));

describe("Cloudflare setup", () => {
  it.each(["starting", "running"] as const)("posts the start action and handles the %s response", async (state) => {
    const next: AccessInfo = { ...info, cloudflare: { state, url: state === "running" ? "https://wisp.example" : null, error: null } };
    vi.mocked(api).mockResolvedValue(next);
    const onDone = vi.fn();
    find(render(onDone), (n) => n.props?.onClick && [n.props.children].flat().includes("Turn it on")).props.onClick();
    await Promise.resolve();
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/reach/cloudflare", { action: "start", token: "cloudflare-setup-code" });
    expect(useAccessStore.getState().info).toEqual(next);
    expect(states[1]).toBe("");
    expect(onDone).toHaveBeenCalledTimes(state === "running" ? 1 : 0);
    if (state === "starting") expect(states[4]).toBe("Cloudflare is connecting…");
  });
});
