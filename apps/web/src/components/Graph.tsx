import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

interface GNode {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

const scopeColor = (p: string) => (p.startsWith("shared/") ? "var(--accent)" : p.startsWith("agents/") ? "#0ea5e9" : "#a855f7");

/** A small force-directed graph of notes and their [[links]], like Obsidian's graph view. */
export function Graph({ active, onOpen, labelFor }: { active: string | null; onOpen: (p: string) => void; labelFor: (p: string) => string }) {
  const [data, setData] = useState<{ nodes: GNode[]; edges: { source: string; target: string }[] } | null>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    api<{ nodes: { id: string; title: string }[]; edges: { source: string; target: string }[] }>("GET", "/api/vault/graph").then((g) => {
      const deg = new Map<string, number>();
      for (const e of g.edges) {
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
      }
      const n = g.nodes.length;
      setData({
        nodes: g.nodes.map((v, i) => ({ ...v, x: Math.cos((i / n) * Math.PI * 2) * 200, y: Math.sin((i / n) * Math.PI * 2) * 200, vx: 0, vy: 0, degree: deg.get(v.id) ?? 0 })),
        edges: g.edges,
      });
    });
  }, []);

  // simple simulation: repulsion + springs + centering, cooled over ~300 frames
  useEffect(() => {
    if (!data) return;
    let frame = 0;
    let raf = 0;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const step = () => {
      const alpha = Math.max(0.02, 1 - frame / 300);
      const ns = data.nodes;
      for (let i = 0; i < ns.length; i++)
        for (let j = i + 1; j < ns.length; j++) {
          const a = ns[i],
            b = ns[j];
          let dx = a.x - b.x,
            dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const f = (2200 / d2) * alpha;
          dx *= f;
          dy *= f;
          a.vx += dx;
          a.vy += dy;
          b.vx -= dx;
          b.vy -= dy;
        }
      for (const e of data.edges) {
        const a = byId.get(e.source),
          b = byId.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 90) / d) * 0.04 * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of ns) {
        if (drag.current?.kind === "node" && drag.current.id === n.id) continue;
        n.vx -= n.x * 0.004 * alpha;
        n.vy -= n.y * 0.004 * alpha;
        n.x += n.vx *= 0.6;
        n.y += n.vy *= 0.6;
      }
      setTick((t) => t + 1);
      if (++frame < 400) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  if (!data) return <div className="p-6 text-sm text-muted">Loading graph…</div>;
  if (!data.nodes.length) return <div className="p-6 text-sm text-muted">No notes yet.</div>;

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const neighbors = new Set<string>();
  if (hover) for (const e of data.edges) if (e.source === hover || e.target === hover) neighbors.add(e.source === hover ? e.target : e.source);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - r.width / 2 - view.x) / view.k, y: (cy - r.top - r.height / 2 - view.y) / view.k };
  };

  return (
    <div className="relative h-full">
      <svg
        ref={svgRef}
        className="w-full h-full touch-none select-none"
        onWheel={(e) => setView((v) => ({ ...v, k: Math.min(4, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const id = (e.target as Element).getAttribute("data-id");
          drag.current = id ? { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0 } : { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
          else {
            const n = byId.get(d.id!)!;
            const w = toWorld(e.clientX, e.clientY);
            n.x = w.x;
            n.y = w.y;
            n.vx = n.vy = 0;
            setTick((t) => t + 1);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.kind === "node" && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) onOpen(d.id!);
        }}
      >
        <g style={{ transform: `translate(50%, 50%) translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {data.edges.map((e, i) => {
            const a = byId.get(e.source),
              b = byId.get(e.target);
            if (!a || !b) return null;
            const lit = hover && (e.source === hover || e.target === hover);
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? "var(--accent)" : "var(--line)"} strokeWidth={lit ? 1.6 : 1} />;
          })}
          {data.nodes.map((n) => {
            const r = 4 + Math.min(n.degree, 10) * 1.2;
            const dim = hover && hover !== n.id && !neighbors.has(n.id);
            return (
              <g key={n.id} opacity={dim ? 0.25 : 1} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} className="cursor-pointer">
                <circle data-id={n.id} cx={n.x} cy={n.y} r={r} fill={scopeColor(n.id)} stroke={n.id === active ? "var(--ink)" : "none"} strokeWidth={2} />
                <text x={n.x} y={n.y + r + 12} textAnchor="middle" fontSize={11} fill="var(--muted)" pointerEvents="none">
                  {labelFor(n.id)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute bottom-3 left-3 text-xs text-muted flex gap-3 bg-panel/80 rounded-md px-2 py-1">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-accent" /> shared
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-sky-500" /> agent
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-purple-500" /> group
        </span>
      </div>
    </div>
  );
}
