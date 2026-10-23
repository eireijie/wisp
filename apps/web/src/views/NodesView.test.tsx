import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { api } from "../api.ts";
import { NodesView } from "./NodesView.tsx";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: vi.fn(), useEffect: vi.fn() }));
vi.mock("../api.ts", () => ({ api: vi.fn() }));
vi.mock("../store.ts", () => ({ useStore: (select: (s: any) => any) => select({ me: { role: "owner" } }) }));
vi.mock("../theme.ts", () => ({ motionReduced: () => false }));
afterEach(() => vi.unstubAllGlobals());

function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (match(node)) return node;
  return [node.props?.children].flat(Infinity).map((child) => find(child, match)).find(Boolean);
}

describe("device removal", () => {
  it("shows a failed removal inline and clears the error on a successful retry", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const node = { id: "device", name: "My Mac", online: true, mine: true, agents: [] };
    const states: any[] = [[node], false, null, null];
    function render() {
      let index = 0;
      vi.mocked(useState).mockImplementation((): [any, any] => {
        const current = index++;
        return [states[current], (value: any) => { states[current] = value; }];
      });
      return NodesView({});
    }
    let tree = render();
    const menu = find(tree, (element) => element.props?.items?.some((item: any) => item.label === "Remove device"));
    const remove = menu.props.items.find((item: any) => item.label === "Remove device").onSelect;
    vi.mocked(api).mockRejectedValueOnce(new Error("Offline"));
    await expect(remove()).resolves.toBeUndefined();
    expect(api).toHaveBeenCalledWith("DELETE", "/api/nodes/device");
    tree = render();
    expect(find(tree, (element) => element.props?.role === "alert")?.props.children).toBe("Couldn't remove My Mac: Offline");
    vi.mocked(api).mockResolvedValueOnce({}).mockResolvedValueOnce([]);
    await remove();
    tree = render();
    expect(find(tree, (element) => element.props?.role === "alert")).toBeUndefined();
    expect(states[0]).toEqual([]);
  });
});
