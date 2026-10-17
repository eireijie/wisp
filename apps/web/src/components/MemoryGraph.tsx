import { useEffect, useRef } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import { motionReduced } from "../theme.ts";

/** One note in the memory graph, as /api/vault/graph returns it. Ghosts are links to notes nobody wrote yet. */
export interface GraphNode {
  id: string;
  path: string | null;
  title: string;
  kind: GraphKind;
  type: string | null;
  tags: string[];
  updatedAt: number | null;
  links: number;
  inbound: number;
}
export interface GraphEdge {
  source: string;
  target: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export type GraphKind = "shared" | "people" | "agents" | "teams" | "groups" | "other" | "ghost";

export const GRAPH_KINDS: GraphKind[] = ["shared", "people", "agents", "teams", "groups", "other", "ghost"];

/** What each folder kind is called; Simple mode says "helpers", not "agents". */
export function kindLabel(kind: GraphKind, simple: boolean): string {
  return { shared: "Shared", people: "People", agents: simple ? "Helpers" : "Agents", teams: "Teams", groups: "Groups", other: "Your folders", ghost: "Not written yet" }[kind];
}
export const kindColor = (kind: GraphKind) => `var(--kind-${kind})`;

/** The note and everything linked to it, either way: the "connected notes" beside an open note. */
export function neighbourhood(graph: GraphData, id: string, depth = 1): GraphData {
  const keep = new Set([id]);
  for (let d = 0; d < depth; d++) {
    // one step at a time: notes found in this step wait for the next one
    const step = new Set(keep);
    for (const e of graph.edges) {
      if (step.has(e.source)) keep.add(e.target);
      if (step.has(e.target)) keep.add(e.source);
    }
  }
  return { nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

type SimNode = SimulationNodeDatum & { id: string; n: GraphNode; r: number };
type SimLink = { source: SimNode; target: SimNode };
type Colors = Record<GraphKind | "ink" | "muted" | "faint" | "accent" | "panel", string>;

/**
 * A force-directed drawing of how notes link, on a canvas. Drag the background to pan, scroll or
 * pinch to zoom, drag a note to move it. Hovering a note lights up its neighbours; clicking opens
 * it. On touch screens the first tap picks a note (`onSelect`) and the second opens it.
 *
 * `variant`: "full" for the Graph page; "local" for the small map beside a note (labels always
 * on, no pan or zoom so the page still scrolls); "preview" for a still thumbnail.
 */
export function MemoryGraph({
  graph,
  variant = "full",
  active,
  selected,
  focus,
  onOpen,
  onSelect,
  zoom,
  className,
  label = "Graph of how notes link to each other",
}: {
  graph: GraphData;
  variant?: "full" | "local" | "preview";
  /** the note that's open: drawn with a ring */
  active?: string | null;
  /** a note picked in the graph: its neighbours stay lit */
  selected?: string | null;
  /** move the view to this note; change `n` to move there again */
  focus?: { id: string; n: number } | null;
  onOpen?: (node: GraphNode) => void;
  onSelect?: (node: GraphNode | null) => void;
  /** filled with a function the zoom buttons call: in, out, or back to everything */
  zoom?: React.MutableRefObject<((how: "in" | "out" | "fit") => void) | null>;
  className?: string;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // everything the drawing needs lives in one ref, so pointer handlers and the simulation share it without re-rendering
  const s = useRef({
    nodes: [] as SimNode[],
    links: [] as SimLink[],
    byId: new Map<string, SimNode>(),
    near: new Map<string, Set<string>>(),
    hubs: new Set<string>(),
    sim: null as Simulation<SimNode, undefined> | null,
    cam: { x: 0, y: 0, k: 1 },
    size: { w: 0, h: 0 },
    userMoved: false,
    hover: null as string | null,
    selected: null as string | null,
    active: null as string | null,
    colors: null as Colors | null,
    frame: 0,
    draw: () => {},
  });
  const props = useRef({ onOpen, onSelect, variant });
  props.current = { onOpen, onSelect, variant };

  s.current.selected = selected ?? null;
  s.current.active = active ?? null;

  // the drawing itself
  useEffect(() => {
    const st = s.current;
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const readColors = () => {
      const css = getComputedStyle(el);
      const v = (name: string) => css.getPropertyValue(name).trim();
      st.colors = Object.fromEntries([...GRAPH_KINDS.map((k) => [k, v(`--kind-${k}`)]), ["ink", v("--ink")], ["muted", v("--muted")], ["faint", v("--faint")], ["accent", v("--info")], ["panel", v("--panel")]]) as Colors;
    };
    readColors();
    // light/dark and theme changes repaint with the new colours
    const themeWatch = new MutationObserver(() => {
      readColors();
      st.draw();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });

    const paint = () => {
      st.frame = 0;
      const { w, h } = st.size;
      const dpr = window.devicePixelRatio || 1;
      const c = st.colors!;
      const { x: tx, y: ty, k } = st.cam;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 + tx), dpr * (h / 2 + ty));
      const focusId = st.hover ?? st.selected;
      const lit = focusId ? new Set([focusId, ...(st.near.get(focusId) ?? [])]) : null;

      ctx.lineCap = "round";
      for (const l of st.links) {
        const on = !!focusId && (l.source.id === focusId || l.target.id === focusId);
        ctx.globalAlpha = on ? 0.9 : lit ? 0.07 : l.target.n.kind === "ghost" ? 0.25 : 0.4;
        ctx.strokeStyle = on ? c.accent : c.faint;
        ctx.lineWidth = (on ? 1.8 : 1) / k;
        ctx.beginPath();
        ctx.moveTo(l.source.x!, l.source.y!);
        ctx.lineTo(l.target.x!, l.target.y!);
        ctx.stroke();
      }

      for (const sn of st.nodes) {
        const { n, r } = sn;
        const x = sn.x!;
        const y = sn.y!;
        ctx.globalAlpha = lit && !lit.has(sn.id) ? 0.18 : 1;
        const color = c[n.kind] || c.other;
        ctx.beginPath();
        shape(ctx, n.type, x, y, r);
        if (n.kind === "ghost" || n.type === "reference") {
          ctx.fillStyle = c.panel;
          ctx.fill();
          ctx.setLineDash(n.kind === "ghost" ? [2 / k, 2 / k] : []);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5 / k;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
        if (sn.id === st.active || sn.id === focusId) {
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5 / k + 1, 0, Math.PI * 2);
          ctx.strokeStyle = sn.id === st.active ? c.ink : c.accent;
          ctx.lineWidth = 1.5 / k;
          ctx.stroke();
        }
      }

      // names: always in the small map; otherwise the busiest notes, whatever is lit, and everything once zoomed in
      const fontPx = props.current.variant === "full" ? 12 : 11;
      ctx.font = `500 ${fontPx / k}px "Inter Variable", Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      for (const sn of st.nodes) {
        // the small map names the open note and its best-linked neighbours; hover names the rest
        const show = props.current.variant === "local" ? (lit ? lit.has(sn.id) : sn.id === st.active || st.hubs.has(sn.id)) : lit ? lit.has(sn.id) : k > 1.5 || (st.hubs.has(sn.id) && k > 0.45);
        if (!show) continue;
        const text = sn.n.title.length > 28 ? sn.n.title.slice(0, 27) + "…" : sn.n.title;
        const ly = sn.y! + sn.r + 3 / k;
        ctx.globalAlpha = lit && !lit.has(sn.id) ? 0.25 : 1;
        ctx.strokeStyle = c.panel;
        ctx.lineWidth = 3.5 / k;
        ctx.strokeText(text, sn.x!, ly);
        ctx.fillStyle = sn.id === focusId || sn.id === st.active ? c.ink : c.muted;
        ctx.fillText(text, sn.x!, ly);
      }
      ctx.globalAlpha = 1;
    };
    st.draw = () => {
      if (!st.frame) st.frame = requestAnimationFrame(paint);
    };

    const resize = new ResizeObserver(() => {
      const r = wrap.current!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      st.size = { w: r.width, h: r.height };
      el.width = Math.max(1, Math.round(r.width * dpr));
      el.height = Math.max(1, Math.round(r.height * dpr));
      if (!st.userMoved) fit(st);
      paint();
    });
    resize.observe(wrap.current!);
    return () => {
      themeWatch.disconnect();
      resize.disconnect();
      cancelAnimationFrame(st.frame);
      st.frame = 0;
      st.sim?.stop();
    };
  }, []);

  // (re)build the simulation when the notes change, keeping notes that stay where they were
  useEffect(() => {
    const st = s.current;
    const old = st.byId;
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = old.get(n.id);
      const r = n.kind === "ghost" ? 3.5 : 4.5 + Math.sqrt(n.links) * 2.1;
      return { id: n.id, n, r, x: prev?.x, y: prev?.y, vx: prev?.vx, vy: prev?.vy };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = graph.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)! }));
    const near = new Map<string, Set<string>>();
    const add = (a: string, b: string) => near.set(a, (near.get(a) ?? new Set()).add(b));
    for (const l of links) {
      add(l.source.id, l.target.id);
      add(l.target.id, l.source.id);
    }
    // new notes start beside a neighbour that already has a place
    for (const sn of nodes) {
      if (sn.x !== undefined) continue;
      const anchor = [...(near.get(sn.id) ?? [])].map((id) => byId.get(id)!).find((x) => x.x !== undefined);
      if (anchor) {
        sn.x = anchor.x! + (Math.random() - 0.5) * 30;
        sn.y = anchor.y! + (Math.random() - 0.5) * 30;
      }
    }
    const local = variant !== "full";
    // the notes named without hovering: the busiest ones (in the small map, the open note's busiest neighbours)
    const busiest = nodes
      .filter((n) => n.n.kind !== "ghost" && (local ? !!active && near.get(active)?.has(n.id) : n.n.links > 1))
      .sort((a, b) => b.n.links - a.n.links);
    Object.assign(st, { nodes, links, byId, near, hubs: new Set(busiest.slice(0, local ? 5 : Math.max(6, Math.round(nodes.length / 8))).map((n) => n.id)) });
    // the open note sits in the middle of its own map
    const centre = local && active ? byId.get(active) : undefined;
    if (centre) {
      centre.fx = 0;
      centre.fy = 0;
    }

    st.sim?.stop();
    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).distance((l) => (local ? 54 : 34) + (l.source.r + l.target.r) * 1.5))
      .force("charge", forceManyBody<SimNode>().strength(local ? -260 : -150).distanceMax(local ? 300 : 520))
      .force("collide", forceCollide<SimNode>((d) => d.r + (local ? 14 : 4)))
      // notes with no links drift off forever without a firmer pull to the middle
      .force("x", forceX<SimNode>(0).strength((d) => (near.has(d.id) ? (local ? 0.09 : 0.05) : 0.2)))
      .force("y", forceY<SimNode>(0).strength((d) => (near.has(d.id) ? (local ? 0.09 : 0.05) : 0.2)))
      .stop();
    // settle most of the way before the first frame, so nothing flies in from nowhere
    const reduced = motionReduced() || variant === "preview";
    const warm = old.size && nodes.every((n) => old.has(n.id)) ? 0 : reduced ? 300 : 90;
    for (let i = 0; i < warm; i++) sim.tick();
    if (!st.userMoved || local) fit(st);
    sim.on("tick", () => {
      if (!st.userMoved || local) fit(st);
      st.draw();
    });
    st.sim = sim;
    if (!reduced) sim.alpha(warm ? 0.3 : 0.5).restart();
    st.draw();
    return () => {
      sim.stop();
    };
  }, [graph, variant]);

  // redraw for highlight changes made from outside (a search pick, the open note)
  useEffect(() => {
    s.current.draw();
  }, [selected, active]);

  useEffect(() => {
    if (!zoom) return;
    const st = s.current;
    zoom.current = (how) => {
      if (how === "fit") {
        st.userMoved = false;
        const before = { ...st.cam };
        fit(st);
        const to = st.cam;
        st.cam = before;
        return animateCam(st, to);
      }
      const k = Math.max(0.15, Math.min(5, st.cam.k * (how === "in" ? 1.4 : 1 / 1.4)));
      st.userMoved = true;
      animateCam(st, { k, x: (st.cam.x * k) / st.cam.k, y: (st.cam.y * k) / st.cam.k });
    };
    return () => {
      zoom.current = null;
    };
  }, [zoom]);

  // fly to a note picked in the search
  useEffect(() => {
    const st = s.current;
    const target = focus && st.byId.get(focus.id);
    if (!target) return;
    st.userMoved = true;
    const to = { k: Math.max(st.cam.k, 1.6), x: 0, y: 0 };
    to.x = -target.x! * to.k;
    to.y = -target.y! * to.k;
    animateCam(st, to);
  }, [focus]);

  // pointer: pan, zoom, drag, hover, tap
  useEffect(() => {
    const st = s.current;
    const el = canvas.current!;
    const interactive = variant === "full";
    const toWorld = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: (cx - r.left - st.size.w / 2 - st.cam.x) / st.cam.k, y: (cy - r.top - st.size.h / 2 - st.cam.y) / st.cam.k };
    };
    const nodeAt = (cx: number, cy: number): SimNode | null => {
      const p = toWorld(cx, cy);
      let best: SimNode | null = null;
      let bestD = Infinity;
      const slop = (variant === "full" ? 6 : 10) / st.cam.k;
      for (const n of st.nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < n.r + slop && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    const tap = (n: SimNode | null, touch: boolean) => {
      const { onOpen, onSelect } = props.current;
      if (!n) return onSelect?.(null);
      if (touch && onSelect && st.selected !== n.id) return onSelect(n.n);
      onSelect?.(n.n);
      onOpen?.(n.n);
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { node: SimNode; x0: number; y0: number; moved: boolean } | null = null;
    let pan: { x0: number; y0: number; cx: number; cy: number; moved: boolean } | null = null;
    let pinch: { d0: number; k0: number } | null = null;

    const setHover = (id: string | null) => {
      if (st.hover === id) return;
      st.hover = id;
      el.style.cursor = id ? "pointer" : interactive ? "grab" : "default";
      st.draw();
    };

    const down = (e: PointerEvent) => {
      if (!interactive) return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d0: Math.hypot(a!.x - b!.x, a!.y - b!.y), k0: st.cam.k };
        drag = null;
        pan = null;
        return;
      }
      const n = nodeAt(e.clientX, e.clientY);
      if (n) drag = { node: n, x0: e.clientX, y0: e.clientY, moved: false };
      else pan = { x0: e.clientX, y0: e.clientY, cx: st.cam.x, cy: st.cam.y, moved: false };
      if (!n) el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === "mouse") setHover(nodeAt(e.clientX, e.clientY)?.id ?? null);
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        zoomAt(st, el, mid.x, mid.y, (pinch.k0 * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.d0);
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
        drag.moved = true;
        st.userMoved = true;
        const p = toWorld(e.clientX, e.clientY);
        drag.node.fx = p.x;
        drag.node.fy = p.y;
        st.sim?.alphaTarget(0.25).restart();
      } else if (pan) {
        if (!pan.moved && Math.hypot(e.clientX - pan.x0, e.clientY - pan.y0) < 4) return;
        pan.moved = true;
        st.userMoved = true;
        st.cam.x = pan.cx + e.clientX - pan.x0;
        st.cam.y = pan.cy + e.clientY - pan.y0;
        st.draw();
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        return;
      }
      const touch = e.pointerType !== "mouse";
      if (drag) {
        if (!drag.moved) tap(drag.node, touch);
        drag.node.fx = null;
        drag.node.fy = null;
        st.sim?.alphaTarget(0);
      } else if (pan && !pan.moved) tap(null, touch);
      drag = null;
      pan = null;
      el.style.cursor = st.hover ? "pointer" : "grab";
    };
    const wheel = (e: WheelEvent) => {
      if (!interactive) return;
      e.preventDefault();
      st.userMoved = true;
      zoomAt(st, el, e.clientX, e.clientY, st.cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    };
    // the small map: a click (or tap) on a note opens it; the page keeps scrolling normally
    const click = (e: MouseEvent) => {
      if (interactive) return;
      const n = nodeAt(e.clientX, e.clientY);
      if (n) props.current.onOpen?.(n.n);
    };
    const leave = () => setHover(null);
    el.style.cursor = interactive ? "grab" : "default";
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("click", click);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("click", click);
    };
  }, [variant]);

  return (
    <div ref={wrap} className={className ?? "relative"}>
      <canvas ref={canvas} role="img" aria-label={label} className="absolute inset-0 size-full" style={{ touchAction: variant === "full" ? "none" : "auto" }} />
    </div>
  );
}

type State = { nodes: SimNode[]; cam: { x: number; y: number; k: number }; size: { w: number; h: number }; draw: () => void; userMoved: boolean };

/** Frame every note in view. */
function fit(st: State) {
  const { w, h } = st.size;
  if (!w || !h || !st.nodes.length) return;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const n of st.nodes) {
    x0 = Math.min(x0, n.x! - n.r);
    y0 = Math.min(y0, n.y! - n.r);
    x1 = Math.max(x1, n.x! + n.r);
    y1 = Math.max(y1, n.y! + n.r);
  }
  // room for the names, which hang below and to both sides of the dots
  const [px, py] = w < 400 ? [26, 18] : [84, 40];
  const k = Math.max(0.15, Math.min(2.2, (w - px * 2) / Math.max(1, x1 - x0), (h - py * 2 - 14) / Math.max(1, y1 - y0)));
  st.cam = { k, x: (-(x0 + x1) / 2) * k, y: (-(y0 + y1) / 2) * k - 6 };
}

function zoomAt(st: State, el: HTMLElement, cx: number, cy: number, k: number) {
  const r = el.getBoundingClientRect();
  const nk = Math.max(0.15, Math.min(5, k));
  const px = cx - r.left - st.size.w / 2;
  const py = cy - r.top - st.size.h / 2;
  // keep the point under the cursor still
  st.cam.x = px - ((px - st.cam.x) * nk) / st.cam.k;
  st.cam.y = py - ((py - st.cam.y) * nk) / st.cam.k;
  st.cam.k = nk;
  st.draw();
}

function animateCam(st: State, to: { x: number; y: number; k: number }) {
  if (motionReduced()) {
    st.cam = to;
    return st.draw();
  }
  const from = { ...st.cam };
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / 420);
    const e = 1 - Math.pow(1 - p, 3);
    st.cam = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
    st.draw();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A note's shape says its front matter `type`: projects are squares, decisions diamonds, references rings, the rest dots. */
function shape(ctx: CanvasRenderingContext2D, type: string | null, x: number, y: number, r: number) {
  if (type === "project") {
    const a = r * 0.9;
    ctx.roundRect(x - a, y - a, a * 2, a * 2, r * 0.35);
  } else if (type === "decision") {
    const a = r * 1.2;
    ctx.moveTo(x, y - a);
    ctx.lineTo(x + a, y);
    ctx.lineTo(x, y + a);
    ctx.lineTo(x - a, y);
    ctx.closePath();
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
}
