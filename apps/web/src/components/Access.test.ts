import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awayEnabled, connectorOrigin, enableTailscale } from "./Access.tsx";
import { linkReach, useAccessStore, type AccessInfo } from "../access.ts";
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
    expect(connectorOrigin({ ...base, cloudflare: { state: "running", url: "https://wisp.example/", error: null } })).toBe("https://wisp.example");
    expect(connectorOrigin(null, { protocol: "https:", hostname: "wisp.example", origin: "https://wisp.example" })).toBe("https://wisp.example");
    expect(connectorOrigin(null, { protocol: "http:", hostname: "localhost", origin: "http://localhost:4747" })).toBeNull();
    expect(connectorOrigin(null, { protocol: "https:", hostname: "192.168.1.5", origin: "https://192.168.1.5" })).toBeNull();
    expect(connectorOrigin(null, { protocol: "https:", hostname: "my-mac.local", origin: "https://my-mac.local" })).toBeNull();
  });
  it.each(["missing", "stopped", "starting", "error"] as const)("doesn't share a Cloudflare address while %s", (state) => {
    const info: AccessInfo = { ...base, publicUrl: null, cloudflare: { state, url: "https://wisp.example", error: null } };
    expect(connectorOrigin(info)).toBeNull();
    expect(awayEnabled(info)).toBe(false);
  });
  it("recognizes a running Cloudflare tunnel even before its address is known", () => {
    const info: AccessInfo = { ...base, publicUrl: null, cloudflare: { state: "running", url: null, error: null } };
    expect(awayEnabled(info)).toBe(true);
    expect(connectorOrigin(info)).toBeNull();
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

describe("linkReach", () => {
  it("tells who can open a link to this Wisp", () => {
    expect(linkReach("http://192.168.1.20:4747/join/x", base)).toBe("wifi");
    expect(linkReach("http://wisp.local:4747", base)).toBe("wifi");
    expect(linkReach(null, base)).toBe("wifi");
    expect(linkReach("https://wisp.tail.ts.net/join/x", base)).toBe("tailscale");
    expect(linkReach("https://wisp.tail.ts.net/join/x", { ...base, tailscale: { ...base.tailscale, funnel: true } })).toBe("anywhere");
    expect(linkReach("https://wisp.example.com/join/x", base)).toBe("anywhere");
    expect(linkReach("http://203.0.113.9:4747/join/x", base)).toBe("anywhere");
  });
});
