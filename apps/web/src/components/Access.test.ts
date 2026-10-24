import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorOrigin, enableTailscale } from "./Access.tsx";
import { useAccessStore, type AccessInfo } from "../access.ts";
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
const base: AccessInfo = {
  publicUrl: "https://wisp.tail.ts.net",
  lan: [],
  download: "https://tailscale.com/download",
  hubPlatform: "darwin",
  tailscale: { state: "running", dnsName: "wisp.tail.ts.net", serving: true, funnel: false },
};
const original = useAccessStore.getState();
beforeEach(() => vi.stubGlobal("window", { open: vi.fn() }));
afterEach(() => {
  useAccessStore.setState(original);
  vi.unstubAllGlobals();
});

describe("public connector address", () => {
  it("never offers a private Tailscale Serve address to external apps", () => {
    expect(connectorOrigin(base)).toBeNull();
    expect(connectorOrigin(base, { protocol: "https:", hostname: "wisp.tail.ts.net", origin: base.publicUrl! })).toBeNull();
  });
  it("uses HTTPS from Funnel, Cloudflare, or an existing public domain", () => {
    expect(connectorOrigin({ ...base, tailscale: { ...base.tailscale, funnel: true } })).toBe(base.publicUrl);
    expect(connectorOrigin({ ...base, cloudflare: { enabled: true, publicUrl: "https://wisp.example/" } })).toBe("https://wisp.example");
    expect(connectorOrigin(null, { protocol: "https:", hostname: "wisp.example", origin: "https://wisp.example" })).toBe("https://wisp.example");
    expect(connectorOrigin(null, { protocol: "http:", hostname: "localhost", origin: "http://localhost:4747" })).toBeNull();
    expect(connectorOrigin(null, { protocol: "https:", hostname: "192.168.1.5", origin: "https://192.168.1.5" })).toBeNull();
    expect(connectorOrigin(null, { protocol: "https:", hostname: "my-mac.local", origin: "https://my-mac.local" })).toBeNull();
  });
});
describe("reach setup", () => {
  it("turns on Serve for devices and Funnel for connected apps", async () => {
    const act = vi.fn(async (action: string) => ({ ...base, tailscale: { ...base.tailscale, funnel: action === "funnel" } }));
    useAccessStore.setState({ refresh: vi.fn(async () => ({ ...base, tailscale: { ...base.tailscale, serving: false } })), act });
    await expect(enableTailscale(true)).resolves.toBe(true);
    expect(act.mock.calls.map(([action]) => action)).toEqual(["serve", "funnel"]);
    act.mockClear();
    await expect(enableTailscale()).resolves.toBe(true);
    expect(act.mock.calls.map(([action]) => action)).toEqual(["serve"]);
  });
  it("opens Tailscale sign-in and waits before claiming setup is complete", async () => {
    const act = vi.fn(async () => ({ ...base, tailscale: { ...base.tailscale, authUrl: "https://login.tailscale.com" } }));
    useAccessStore.setState({ refresh: vi.fn(async () => ({ ...base, tailscale: { ...base.tailscale, state: "needs-login" as const } })), act });
    await expect(enableTailscale()).resolves.toBe(false);
    expect(act).toHaveBeenCalledExactlyOnceWith("login");
    expect(window.open).toHaveBeenCalledWith("https://login.tailscale.com", "_blank", "noopener,noreferrer");
  });
  it("handles an older Wisp without the reach API", async () => {
    useAccessStore.setState({ refresh: vi.fn(async () => null) });
    await expect(enableTailscale()).rejects.toThrow("isn't available yet");
  });
});
