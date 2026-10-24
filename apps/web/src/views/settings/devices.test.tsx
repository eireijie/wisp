import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { useAccessStore, type AccessInfo } from "../../access.ts";
import { enableTailscale } from "../../components/Access.tsx";
import { McpConnections } from "./devices.tsx";

vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: vi.fn(), useEffect: vi.fn() }));
vi.mock("../../api.ts", () => ({ api: vi.fn() }));
vi.mock("../../components/Access.tsx", async (original) => ({ ...(await original<typeof import("../../components/Access.tsx")>()), enableTailscale: vi.fn() }));
vi.mock("../../theme.ts", () => ({ motionReduced: () => false }));
const info: AccessInfo = {
  publicUrl: "https://wisp.tail.ts.net",
  lan: [],
  download: "",
  hubPlatform: "darwin",
  tailscale: { state: "running", dnsName: "wisp.tail.ts.net", serving: true, funnel: true },
};
let states: any[];
const original = useAccessStore.getState();
function render(access = info) {
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
  return McpConnections({ info: access, allowed: true });
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
  states = [null, false, null, null];
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
    expect(find(tree, (n) => n.props?.hint === "Talk to your agents from their apps, and from Grok in your car.")).toBeTruthy();
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
  it("enables Funnel rather than sharing a private Serve address", async () => {
    const tree = render({ ...info, tailscale: { ...info.tailscale, funnel: false } });
    expect(find(tree, (n) => n.props?.text?.endsWith("/mcp"))).toBeUndefined();
    vi.mocked(enableTailscale).mockResolvedValue(true);
    find(tree, (n) => n.props?.label === "Grok, ChatGPT and Claude").props.onChange(true);
    await Promise.resolve();
    expect(enableTailscale).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("turns Funnel off when the switch is disabled", async () => {
    const act = vi.fn(async () => info);
    useAccessStore.setState({ act });
    find(render(), (n) => n.props?.label === "Grok, ChatGPT and Claude").props.onChange(false);
    await Promise.resolve();
    expect(act).toHaveBeenCalledExactlyOnceWith("unfunnel");
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
