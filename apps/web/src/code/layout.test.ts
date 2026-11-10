import { describe, expect, it } from "vitest";
import { layout, leaves, neighbor, newSession, removePane, restore, setRatio, splitPane, type Leaf } from "./layout.ts";

const pane = (key: string): Leaf => ({ kind: "pane", key, computerId: "c", session: key });

describe("the Code workspace's layout", () => {
  it("splits side by side and stacked, and places every pane", () => {
    let root = splitPane(null, "", "row", pane("a"));
    root = splitPane(root, "a", "row", pane("b"));
    root = splitPane(root, "b", "col", pane("c"));
    expect(leaves(root).map((l) => l.key)).toEqual(["a", "b", "c"]);
    const { panes, dividers } = layout(root);
    expect(panes.map((p) => [p.leaf.key, p.rect])).toEqual([
      ["a", { x: 0, y: 0, w: 0.5, h: 1 }],
      ["b", { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
      ["c", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    ]);
    expect(dividers.map((d) => [d.dir, d.at])).toEqual([
      ["row", 0.5],
      ["col", 0.5],
    ]);
  });

  it("moves between panes the way they sit", () => {
    let root = splitPane(pane("a"), "a", "row", pane("b"));
    root = splitPane(root, "b", "col", pane("c"));
    expect(neighbor(root, "a", "right")).toBe("b");
    expect(neighbor(root, "c", "up")).toBe("b");
    expect(neighbor(root, "c", "left")).toBe("a");
    expect(neighbor(root, "a", "left")).toBeNull();
  });

  it("closing a pane gives its room to its sibling; dividers resize within limits", () => {
    let root = splitPane(pane("a"), "a", "row", pane("b"));
    root = splitPane(root, "b", "col", pane("c"));
    expect(removePane(root, "b")).toEqual({ kind: "split", dir: "row", ratio: 0.5, a: pane("a"), b: pane("c") });
    expect(removePane(pane("a"), "a")).toBeNull();
    const r = setRatio(root, [], 0.99);
    expect(r && r.kind === "split" && r.ratio).toBeCloseTo(0.88);
    const inner = setRatio(root, [1], 0.3);
    expect(inner && inner.kind === "split" && inner.b.kind === "split" && inner.b.ratio).toBe(0.3);
  });

  it("names new shells so they never collide on a computer", () => {
    expect(newSession("Yug Mac", "c", [pane("yug-1")].map((l) => ({ ...l, session: "yug-1" })))).toBe("yug-2");
    expect(newSession("codex", "c", [])).toBe("codex-1");
  });

  it("restores what was saved, drops what's broken, and brings older pane lists along", () => {
    const saved = { tabs: [{ id: "t1", root: { kind: "split", dir: "row", ratio: 7, a: pane("a"), b: { kind: "junk" } }, focus: "zz" }], active: "nope" };
    const w = restore(saved, null, () => "x");
    expect(w.active).toBe("t1");
    expect(w.tabs[0].root).toEqual(pane("a"));
    expect(w.tabs[0].focus).toBe("a");
    const old = restore(null, [pane("a"), pane("b"), pane("c")], () => "t");
    expect(leaves(old.tabs[0].root).map((l) => l.key)).toEqual(["a", "b", "c"]);
    expect(restore(null, null, () => "t").tabs).toEqual([{ id: "t", root: null, focus: null }]);
  });
});
