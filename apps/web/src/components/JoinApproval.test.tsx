import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { api, observeEvents } from "../api.ts";
import { JoinApproval } from "./JoinApproval.tsx";

const state = vi.hoisted(() => ({ role: "owner" }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: vi.fn(), useEffect: vi.fn(), useRef: () => ({ current: undefined }) }));
vi.mock("../api.ts", () => ({ api: vi.fn(), observeEvents: vi.fn() }));
vi.mock("../store.ts", () => ({ useStore: (select: (s: unknown) => unknown) => select({ me: { role: state.role, workspace: { id: "wisp" } }, connected: true }) }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));

const request = { id: "join/1", name: "My Mac", kind: "computer" as const, platform: "darwin", code: "001002", createdAt: "2026-10-24" };
let states: any[];
function render() {
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
  return JoinApproval();
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return [node.props?.children]
    .flat(Infinity)
    .map((child) => find(child, predicate))
    .find(Boolean);
}
beforeEach(() => {
  states = [[request], false, null, []];
  state.role = "owner";
  vi.mocked(api).mockReset();
  vi.mocked(useEffect).mockReset();
  vi.mocked(observeEvents).mockReturnValue(vi.fn());
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("global join approval dialog", () => {
  it.each(["member", "guest"])("stays hidden for a %s", (role) => {
    state.role = role;
    expect(render()).toBeNull();
  });
  it.each(["owner", "admin"])("shows the name and formatted code for an %s", (role) => {
    state.role = role;
    const tree = render();
    expect(tree?.props.label).toBe("My Mac wants to join");
    expect(find(tree, (n) => n.props?.children === "001 002")).toBeTruthy();
  });
  it.each([
    ["Approve", "approve"],
    ["Deny", "deny"],
  ])("%s sends one decision and removes the request", async (label, action) => {
    const tree = render();
    const button = find(tree, (n) => n.props?.onClick && [n.props.children].flat().includes(label));
    vi.mocked(api).mockResolvedValue({});
    await button.props.onClick();
    // The UI callback deliberately discards the promise; let its continuation finish.
    await Promise.resolve();
    expect(api).toHaveBeenCalledExactlyOnceWith("POST", `/api/join/requests/join%2F1/${action}`);
    expect(states[0]).toEqual([]);
  });
  it("keeps the code visible after a failed decision for retry", async () => {
    const tree = render();
    const button = find(tree, (n) => n.props?.onClick && [n.props.children].flat().includes("Approve"));
    vi.mocked(api).mockRejectedValue(new Error("Offline"));
    button.props.onClick();
    await Promise.resolve();
    expect(states[0]).toEqual([request]);
    expect(states[2]).toBe("Offline");
  });
  it.each(["Later", "onClose"])("dismisses with %s without deciding and stays hidden after polling and reconnecting", async (close) => {
    const tree = render();
    const effect = vi.mocked(useEffect).mock.calls[0][0];
    vi.mocked(api).mockResolvedValue([request]);
    let cleanup = effect();
    await Promise.resolve();
    if (close === "onClose") tree!.props.onClose();
    else find(tree, (n) => n.props?.children === "Later").props.onClick();
    expect(render()).toBeNull();
    await vi.advanceTimersByTimeAsync(15000);
    expect(render()).toBeNull();
    if (typeof cleanup === "function") cleanup();
    cleanup = effect();
    await Promise.resolve();
    expect(render()).toBeNull();
    expect(states[0]).toEqual([request]);
    expect(vi.mocked(api).mock.calls.every(([method]) => method === "GET")).toBe(true);
    if (typeof cleanup === "function") cleanup();
  });
  it("shows a new request after Later while leaving the earlier request pending", async () => {
    render();
    vi.mocked(api).mockResolvedValue([request]);
    const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    await Promise.resolve();
    find(render(), (n) => n.props?.children === "Later").props.onClick();
    const incoming = { ...request, id: "join/2", name: "My Phone" };
    const listener = vi.mocked(observeEvents).mock.calls.at(-1)![0];
    listener({ type: "join_request", request: incoming });
    expect(render()?.props.label).toBe("My Phone wants to join");
    expect(states[0]).toEqual([request, incoming]);
    if (typeof cleanup === "function") cleanup();
  });
  it.each(["Approve", "Deny"])("explains an ended request when %s returns 404", async (label) => {
    const tree = render();
    vi.mocked(api).mockRejectedValue({ status: 404 });
    find(tree, (n) => n.props?.onClick && [n.props.children].flat().includes(label)).props.onClick();
    await Promise.resolve();
    expect(find(render(), (n) => n.props?.role === "alert").props.children).toBe("This request has ended.");
    expect(states[0]).toEqual([request]);
  });
});
