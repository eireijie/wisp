import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useAccessStore, type AccessInfo } from "../../access.ts";
import { connectorBlocker, enableTailscale } from "../../components/Access.tsx";
import { DevicesPage, McpConnections } from "./devices.tsx";

vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: vi.fn(), useEffect: vi.fn() }));
vi.mock("../../api.ts", () => ({ api: vi.fn() }));
vi.mock("../../access.ts", async (original) => {
  const actual = await original<typeof import("../../access.ts")>();
  return {
    ...actual,
    useAccess: () => actual.useAccessStore.getState().info,
    useAccessStore: Object.assign((select: (s: ReturnType<typeof actual.useAccessStore.getState>) => unknown) => select(actual.useAccessStore.getState()), actual.useAccessStore),
  };
});
vi.mock("../../components/Access.tsx", async (original) => ({ ...(await original<typeof import("../../components/Access.tsx")>()), enableTailscale: vi.fn() }));
vi.mock("../../theme.ts", () => ({ motionReduced: () => false }));
vi.mock("../../devices.ts", () => ({ useDevices: () => [] }));
vi.mock("../../store.ts", () => ({ useStore: (select: (s: any) => any) => select({ me: { role: "owner" } }) }));
const info: AccessInfo = {
  publicUrl: "https://wisp.tail.ts.net",
  lan: [],
  download: "",
  hubPlatform: "darwin",
  tailscale: { state: "running", dnsName: "wisp.tail.ts.net", serving: true, funnel: true },
};
let states: any[];
const original = useAccessStore.getState();
function render(access: AccessInfo | null = info, page = false) {
  let index = 0;
  vi.mocked(useState).mockImplementation((): [any, any] => {
    const current = index++;
    return [
      states[current],
      (value: any) => {
        states[current] = typeof value === "function" ? value(states[current]) : value;
      },
    ];
  });
  return page ? DevicesPage() : McpConnections({ info: access, allowed: true });
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return [node.props?.children, node.props?.label]
    .flat(Infinity)
    .map((child) => find(child, predicate))
    .find(Boolean);
}
beforeEach(() => {
  states = [null, false, null, null, false];
  vi.mocked(api).mockReset();
  vi.mocked(useEffect).mockReset();
  vi.mocked(enableTailscale).mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  useAccessStore.setState(original);
});

describe("Grok, ChatGPT and Claude settings", () => {
  it("shows the exact connector instructions at a public HTTPS address", () => {
    const tree = render();
    expect(find(tree, (n) => n.props?.text === `${info.publicUrl}/mcp`)).toBeTruthy();
    expect(find(tree, (n) => n.props?.children === "In Grok: Connectors → Add custom connector → paste.")).toBeTruthy();
  });
  it("hides both the client list and errors for a 404", async () => {
    render();
    vi.mocked(api).mockRejectedValue({ status: 404 });
    const effect = vi.mocked(useEffect).mock.calls[0][0];
    const cleanup = effect();
    await Promise.resolve();
    await Promise.resolve();
    const tree = render();
    expect(api).toHaveBeenCalledWith("GET", "/api/mcp/clients");
    expect(find(tree, (n) => n.type === "h3" && n.props?.children === "Connected apps")).toBeUndefined();
    expect(states[2]).toBeNull();
    if (typeof cleanup === "function") cleanup();
  });
  it("explains a private address instead of offering it, and opens the door only after a confirm", async () => {
    const tailnetOnly = { ...info, tailscale: { ...info.tailscale, funnel: false } };
    let tree = render(tailnetOnly);
    expect(find(tree, (n) => n.props?.text?.endsWith("/mcp"))).toBeUndefined();
    expect(find(tree, (n) => n.type === "p" && [n.props.children].flat().join("").includes("only on your devices with Tailscale"))).toBeTruthy();
    vi.mocked(enableTailscale).mockResolvedValue(true);
    find(tree, (n) => n.props?.label === "Grok, ChatGPT and Claude").props.onChange(true);
    expect(enableTailscale).not.toHaveBeenCalled();
    tree = render(tailnetOnly);
    expect(find(tree, (n) => n.type === "p" && n.props.children === "Anyone on the internet can reach this address, but only apps you approve can use it. The rest of Wisp stays private.")).toBeTruthy();
    find(tree, (n) => n.props?.children === "Cancel").props.onClick();
    expect(states[4]).toBe(false);
    expect(enableTailscale).not.toHaveBeenCalled();
    states[4] = true;
    find(render(tailnetOnly), (n) => n.props?.children === "Turn on").props.onClick();
    await Promise.resolve();
    expect(enableTailscale).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("shares the door's address with a note to approve on a Tailscale device, and closes just the door", async () => {
    const door: AccessInfo = { ...info, connectorUrl: "https://wisp.tail.ts.net:8443", tailscale: { ...info.tailscale, funnel: false, connectors: true } };
    const tree = render(door);
    expect(find(tree, (n) => n.props?.text === "https://wisp.tail.ts.net:8443/mcp")).toBeTruthy();
    expect(find(tree, (n) => n.props?.children === "Approve it on a device with Tailscale on.")).toBeTruthy();
    const act = vi.fn(async () => info);
    useAccessStore.setState({ act });
    find(tree, (n) => n.props?.label === "Grok, ChatGPT and Claude").props.onChange(false);
    await Promise.resolve();
    expect(act).toHaveBeenCalledExactlyOnceWith("unconnectors");
  });
  it("says why apps can't connect at home", () => {
    expect(connectorBlocker(null)).toMatch(/works only at home, so they can't reach it yet/);
    expect(connectorBlocker(info)).toBeNull();
  });
  it("turns Funnel off when the switch is disabled", async () => {
    const act = vi.fn(async () => info);
    useAccessStore.setState({ act });
    find(render(), (n) => n.props?.label === "Grok, ChatGPT and Claude").props.onChange(false);
    await Promise.resolve();
    expect(act).toHaveBeenCalledExactlyOnceWith("unfunnel");
  });
  it.each(["away", "apps"])("stops Cloudflare with a POST action from the %s switch", async (switchName) => {
    const access: AccessInfo = { ...info, publicUrl: null, cloudflare: { state: "running", url: "https://wisp.example", error: null }, tailscale: { ...info.tailscale, serving: false, funnel: false } };
    const refresh = vi.fn(async () => info);
    useAccessStore.setState({ info: access, refresh });
    if (switchName === "away") states = [false, false, false, null];
    vi.mocked(api).mockResolvedValue(info);
    const tree = render(access, switchName === "away");
    if (switchName === "apps") expect(find(tree, (n) => n.props?.text === "https://wisp.example/mcp")).toBeTruthy();
    find(tree, (n) => n.props?.label === (switchName === "away" ? "Away from home" : "Grok, ChatGPT and Claude") && n.props?.onChange).props.onChange(false);
    await Promise.resolve();
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", "/api/reach/cloudflare", { action: "stop" });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([null, { ...info, publicUrl: null, tailscale: { ...info.tailscale, serving: false, funnel: false } }])("loads and disconnects apps with no public origin (%j)", async (access) => {
    const client = { id: "app/1", name: "Grok" };
    render(access);
    vi.mocked(api).mockResolvedValueOnce([client]);
    const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(api).toHaveBeenCalledExactlyOnceWith("GET", "/api/mcp/clients");
    const tree = render(access);
    expect(find(tree, (n) => n.props?.text?.endsWith("/mcp"))).toBeUndefined();
    expect(find(tree, (n) => n.props?.label === "Grok, ChatGPT and Claude" && n.props?.onChange).props.on).toBe(false);
    expect(find(tree, (n) => n.type === "h3" && n.props?.children === "Connected apps")).toBeTruthy();
    vi.mocked(api).mockResolvedValueOnce({});
    find(tree, (n) => n.props?.children === "Disconnect").props.onClick();
    await Promise.resolve();
    expect(api).toHaveBeenLastCalledWith("DELETE", "/api/mcp/clients/app%2F1");
    expect(states[0]).toEqual([]);
    if (typeof cleanup === "function") cleanup();
  });
  it("disconnects an app and updates the list after success", async () => {
    states[0] = [{ id: "app/1", name: "Grok" }];
    const tree = render();
    vi.mocked(api).mockResolvedValue({});
    find(tree, (n) => n.props?.children === "Disconnect").props.onClick();
    await Promise.resolve();
    expect(api).toHaveBeenCalledExactlyOnceWith("DELETE", "/api/mcp/clients/app%2F1");
    expect(states[0]).toEqual([]);
  });
});
