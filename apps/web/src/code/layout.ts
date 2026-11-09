/**
 * The Code workspace's layout, tmux-style: tabs, each a tree of splits with a pane at every leaf.
 * Pure functions, so the page can store it, and tests can drive it without a browser.
 */

export interface Leaf {
  kind: "pane";
  key: string;
  computerId: string;
  /** the shell's name on its computer (its tmux session): the same name reattaches */
  session: string;
  /** a harness's CLI it started in (an id from HARNESSES) */
  launch?: string;
}

export interface Split {
  kind: "split";
  /** row: side by side; col: stacked */
  dir: "row" | "col";
  /** the first side's share, 0..1 */
  ratio: number;
  a: Node;
  b: Node;
}

export type Node = Leaf | Split;

export interface Tab {
  id: string;
  root: Node | null;
  focus: string | null;
  /** the focused pane fills the tab */
  zoom?: boolean;
}

export interface Workspace {
  tabs: Tab[];
  active: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** at most this many panes in a tab, and tabs, so it never gets crowded */
export const MAX_PANES = 6;
export const MAX_TABS = 9;
const MIN_RATIO = 0.12;

export const clampRatio = (r: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, Number.isFinite(r) ? r : 0.5));

export function leaves(n: Node | null): Leaf[] {
  if (!n) return [];
  return n.kind === "pane" ? [n] : [...leaves(n.a), ...leaves(n.b)];
}

export function allLeaves(w: Workspace): Leaf[] {
  return w.tabs.flatMap((t) => leaves(t.root));
}

/** Every pane's place in the tab, and every split's divider, as fractions of the tab. */
export function layout(n: Node | null, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: number[] = []): { panes: { leaf: Leaf; rect: Rect }[]; dividers: { path: number[]; dir: "row" | "col"; rect: Rect; at: number }[] } {
  if (!n) return { panes: [], dividers: [] };
  if (n.kind === "pane") return { panes: [{ leaf: n, rect: r }], dividers: [] };
  const ra: Rect = n.dir === "row" ? { ...r, w: r.w * n.ratio } : { ...r, h: r.h * n.ratio };
  const rb: Rect = n.dir === "row" ? { x: r.x + ra.w, y: r.y, w: r.w - ra.w, h: r.h } : { x: r.x, y: r.y + ra.h, w: r.w, h: r.h - ra.h };
  const A = layout(n.a, ra, [...path, 0]);
  const B = layout(n.b, rb, [...path, 1]);
  return { panes: [...A.panes, ...B.panes], dividers: [{ path, dir: n.dir, rect: r, at: n.dir === "row" ? ra.x + ra.w : ra.y + ra.h }, ...A.dividers, ...B.dividers] };
}

/** Split the pane `key` in two: the new pane goes after it (right, or below). */
export function splitPane(n: Node | null, key: string, dir: "row" | "col", add: Leaf): Node {
  if (!n) return add;
  if (n.kind === "pane") return n.key === key ? { kind: "split", dir, ratio: 0.5, a: n, b: add } : n;
  return { ...n, a: splitPane(n.a, key, dir, add), b: splitPane(n.b, key, dir, add) };
}

/** The tree without the pane `key`; its sibling takes the room. */
export function removePane(n: Node | null, key: string): Node | null {
  if (!n) return null;
  if (n.kind === "pane") return n.key === key ? null : n;
  const a = removePane(n.a, key);
  const b = removePane(n.b, key);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

/** Set the ratio of the split at `path` (0 = first side, 1 = second, from the top). */
export function setRatio(n: Node | null, path: number[], ratio: number): Node | null {
  if (!n || n.kind === "pane") return n;
  if (!path.length) return { ...n, ratio: clampRatio(ratio) };
  return path[0] === 0 ? { ...n, a: setRatio(n.a, path.slice(1), ratio)! } : { ...n, b: setRatio(n.b, path.slice(1), ratio)! };
}

/** The pane next to `key` in a direction, the nearest one that lines up with it, if any. */
export function neighbor(n: Node | null, key: string, dir: "left" | "right" | "up" | "down"): string | null {
  const { panes } = layout(n);
  const me = panes.find((p) => p.leaf.key === key)?.rect;
  if (!me) return null;
  const eps = 1e-6;
  const cx = me.x + me.w / 2;
  const cy = me.y + me.h / 2;
  let best: { key: string; d: number } | null = null;
  for (const { leaf, rect } of panes) {
    if (leaf.key === key) continue;
    const ok =
      dir === "left" ? Math.abs(rect.x + rect.w - me.x) < eps && rect.y < me.y + me.h - eps && rect.y + rect.h > me.y + eps
      : dir === "right" ? Math.abs(me.x + me.w - rect.x) < eps && rect.y < me.y + me.h - eps && rect.y + rect.h > me.y + eps
      : dir === "up" ? Math.abs(rect.y + rect.h - me.y) < eps && rect.x < me.x + me.w - eps && rect.x + rect.w > me.x + eps
      : Math.abs(me.y + me.h - rect.y) < eps && rect.x < me.x + me.w - eps && rect.x + rect.w > me.x + eps;
    if (!ok) continue;
    const d = Math.hypot(rect.x + rect.w / 2 - cx, rect.y + rect.h / 2 - cy);
    if (!best || d < best.d) best = { key: leaf.key, d };
  }
  return best?.key ?? null;
}

/** A shell name no other pane on that computer uses: a short stem and a number. */
export function newSession(stem: string, computerId: string, taken: Leaf[]): string {
  const base = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-")[0] || "shell";
  const used = new Set(taken.filter((p) => p.computerId === computerId).map((p) => p.session));
  let n = 1;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function validNode(v: unknown, depth = 0): Node | null {
  if (!v || typeof v !== "object" || depth > 12) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "pane")
    return typeof o.key === "string" && typeof o.computerId === "string" && typeof o.session === "string"
      ? { kind: "pane", key: o.key, computerId: o.computerId, session: o.session, ...(typeof o.launch === "string" ? { launch: o.launch } : {}) }
      : null;
  if (o.kind === "split" && (o.dir === "row" || o.dir === "col")) {
    const a = validNode(o.a, depth + 1);
    const b = validNode(o.b, depth + 1);
    if (!a || !b) return a ?? b;
    return { kind: "split", dir: o.dir, ratio: clampRatio(Number(o.ratio)), a, b };
  }
  return null;
}

/**
 * What was saved on this browser, checked; or the panes from before tabs (a flat list, side by
 * side two at a time) as the first tab; or one empty tab.
 */
export function restore(saved: unknown, oldPanes: unknown, id: () => string): Workspace {
  const s = saved as { tabs?: unknown; active?: unknown } | null;
  if (s && Array.isArray(s.tabs)) {
    const tabs: Tab[] = s.tabs.slice(0, MAX_TABS).flatMap((t: unknown) => {
      const o = t as Record<string, unknown> | null;
      if (!o || typeof o.id !== "string") return [];
      const root = validNode(o.root);
      const keys = leaves(root).map((l) => l.key);
      return [{ id: o.id, root, focus: typeof o.focus === "string" && keys.includes(o.focus) ? o.focus : (keys[0] ?? null), ...(o.zoom === true ? { zoom: true } : {}) }];
    });
    if (tabs.length) return { tabs, active: tabs.some((t) => t.id === s.active) ? (s.active as string) : tabs[0].id };
  }
  const old = Array.isArray(oldPanes) ? (oldPanes.map((p) => validNode({ ...p, kind: "pane" })).filter(Boolean) as Leaf[]) : [];
  let root: Node | null = null;
  // 1, 2 side by side, 3 and 4 below them
  if (old.length === 1) root = old[0];
  else if (old.length >= 2) {
    const top: Node = { kind: "split", dir: "row", ratio: 0.5, a: old[0], b: old[1] };
    const rest = old.slice(2, 4);
    const bottom: Node | null = rest.length === 2 ? { kind: "split", dir: "row", ratio: 0.5, a: rest[0], b: rest[1] } : (rest[0] ?? null);
    root = bottom ? { kind: "split", dir: "col", ratio: 0.5, a: top, b: bottom } : top;
  }
  const tab: Tab = { id: id(), root, focus: leaves(root)[0]?.key ?? null };
  return { tabs: [tab], active: tab.id };
}
