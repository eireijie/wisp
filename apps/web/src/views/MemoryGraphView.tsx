import { useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Search, Share2, X } from "lucide-react";
import { Button, cx } from "../components/ui.tsx";
import { GRAPH_KINDS, MemoryGraph, kindColor, kindLabel, type GraphData, type GraphKind, type GraphNode } from "../components/MemoryGraph.tsx";
import { useSimple } from "../experience.tsx";

/** The whole memory as a map: every note you can read, and the links between them. */
export function MemoryGraphView({
  graph,
  initialKind,
  where,
  onOpen,
  onWrite,
}: {
  graph: GraphData | null;
  /** start with only this folder kind showing (from a tile on the Memory home) */
  initialKind?: GraphKind | null;
  /** where a note lives, in words ("Shared", "@atlas", "Sam") */
  where: (path: string) => string;
  onOpen: (path: string) => void;
  /** start writing a note that's linked to but doesn't exist yet */
  onWrite?: (title: string) => void;
}) {
  const simple = useSimple();
  const [hidden, setHidden] = useState<Set<GraphKind>>(() => (initialKind ? new Set(GRAPH_KINDS.filter((k) => k !== initialKind)) : new Set()));
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<GraphNode | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const zoom = useRef<((how: "in" | "out" | "fit") => void) | null>(null);

  const counts = useMemo(() => {
    const c = new Map<GraphKind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);
  const tags = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of graph?.nodes ?? []) for (const t of n.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [graph]);
  const types = useMemo(() => new Set((graph?.nodes ?? []).map((n) => n.type)), [graph]);

  const shown = useMemo<GraphData>(() => {
    if (!graph) return { nodes: [], edges: [] };
    const nodes = graph.nodes.filter((n) => !hidden.has(n.kind) && (!tag || n.tags.includes(tag)));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [graph, hidden, tag]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return shown.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.path?.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)) || b.links - a.links)
      .slice(0, 8);
  }, [query, shown]);

  const pick = (n: GraphNode) => {
    setPicked(n);
    setFocus({ id: n.id, n: Date.now() });
    setQuery("");
  };
  const toggle = (k: GraphKind) => {
    const next = new Set(hidden);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setHidden(next);
  };
  const open = (n: GraphNode) => n.path && onOpen(n.path);

  if (!graph) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const linked = picked ? new Set(graph.edges.flatMap((e) => (e.source === picked.id ? [e.target] : e.target === picked.id ? [e.source] : []))).size : 0;
  return (
    <div className="h-full flex flex-col min-h-0">
      {/* search and filters */}
      <div className="shrink-0 px-3 md:px-5 pt-3 pb-2 flex flex-col gap-2 md:flex-row md:items-center border-b border-line">
        <div className="relative md:w-72">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) pick(matches[0]);
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Find a note in the graph…"
            aria-label="Find a note in the graph"
            className="h-9 w-full rounded-full border border-input bg-panel pl-9 pr-3 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30"
          />
          {matches.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-2xl border border-line bg-panel shadow-panel py-1 overflow-hidden" role="listbox">
              {matches.map((n) => (
                <button key={n.id} role="option" aria-selected={false} onClick={() => pick(n)} className="w-full text-left px-3 py-1.5 hover:bg-hover flex items-center gap-2">
                  <span className="size-2.5 rounded-full shrink-0" style={{ background: kindColor(n.kind) }} />
                  <span className="truncate flex-1">{n.title}</span>
                  <span className="text-xs text-faint truncate max-w-[40%]">{n.path ? where(n.path) : kindLabel("ghost", simple)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] -mx-3 px-3 md:mx-0 md:px-0 md:flex-wrap flex-1" role="group" aria-label="Show folders">
          {GRAPH_KINDS.filter((k) => counts.get(k)).map((k) => {
            const on = !hidden.has(k);
            return (
              <button
                key={k}
                onClick={() => toggle(k)}
                aria-pressed={on}
                className={cx("shrink-0 inline-flex items-center gap-1.5 h-7 rounded-full px-2.5 text-xs font-medium border transition-colors", on ? "border-line bg-panel text-ink" : "border-transparent bg-transparent text-faint line-through")}
              >
                <span className={cx("size-2 rounded-full", k === "ghost" && "ring-1 ring-inset ring-current bg-transparent!")} style={{ background: on ? kindColor(k) : "var(--faint)", color: kindColor(k) }} />
                {kindLabel(k, simple)}
                <span className="text-faint tabular-nums">{counts.get(k)}</span>
              </button>
            );
          })}
          {tags.length > 0 && (
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Only notes with this tag" className="shrink-0 h-7 rounded-full border border-line bg-panel px-2.5 text-xs text-ink">
              <option value="">All tags</option>
              {tags.map(([t, c]) => (
                <option key={t} value={t}>
                  #{t} ({c})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-size-[22px_22px]">
        {shown.nodes.length ? (
          <MemoryGraph
            graph={shown}
            selected={picked?.id}
            focus={focus}
            zoom={zoom}
            onSelect={setPicked}
            onOpen={open}
            className="absolute inset-0"
            label={`Graph of ${shown.nodes.length} notes and ${shown.edges.length} links. Use the search above to find a note.`}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">{graph.nodes.length ? "Nothing matches these filters." : "No notes yet."}</div>
        )}
        {graph.nodes.length > 0 && graph.edges.length === 0 && (
          <p className="absolute top-3 inset-x-3 mx-auto max-w-md rounded-2xl bg-panel/90 border border-line px-4 py-2.5 text-sm text-muted text-center shadow-panel">
            Nothing is linked yet. Write <code className="text-ink">[[Note name]]</code> in a note to link it to another one.
          </p>
        )}

        {/* the picked note */}
        {picked && (
          <div className="absolute left-3 bottom-3 right-16 md:right-auto md:w-80 rounded-2xl border border-line bg-panel/95 backdrop-blur shadow-panel p-3.5">
            <div className="flex items-start gap-2">
              <span className="mt-1.5 size-2.5 rounded-full shrink-0" style={{ background: kindColor(picked.kind) }} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{picked.title}</div>
                <div className="text-xs text-muted truncate">
                  {picked.path ? where(picked.path) : `${kindLabel("ghost", simple)}: other notes link to it`}
                  {picked.type ? ` · ${picked.type}` : ""}
                </div>
              </div>
              <button onClick={() => setPicked(null)} className="p-1 -m-1 text-muted hover:text-ink" aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <span className="text-xs text-muted flex-1">
                <Share2 size={12} className="inline -mt-0.5 mr-1" />
                Linked with {linked} {linked === 1 ? "note" : "notes"}
              </span>
              {picked.path ? (
                <Button variant="primary" className="h-8" onClick={() => open(picked)}>
                  Open
                </Button>
              ) : (
                onWrite && (
                  <Button variant="primary" className="h-8" onClick={() => onWrite(picked.title)}>
                    Write it
                  </Button>
                )
              )}
            </div>
          </div>
        )}

        {/* zoom, and what the shapes mean */}
        <div className="absolute right-3 bottom-3 flex flex-col items-end gap-2">
          {(types.has("project") || types.has("decision") || types.has("reference")) && (
            <div className="hidden md:flex flex-col gap-1 rounded-xl border border-line bg-panel/90 px-2.5 py-2 text-[11px] text-muted">
              {types.has("project") && <Legend shape="rounded-[3px]">Project</Legend>}
              {types.has("decision") && <Legend shape="rotate-45 rounded-[1px] scale-90">Decision</Legend>}
              {types.has("reference") && <Legend shape="rounded-full bg-transparent! ring-[1.5px] ring-inset ring-muted">Reference</Legend>}
            </div>
          )}
          <div className="flex flex-col rounded-xl border border-line bg-panel shadow-panel overflow-hidden">
            <button onClick={() => zoom.current?.("in")} className="size-9 grid place-items-center hover:bg-hover text-muted hover:text-ink" aria-label="Zoom in" title="Zoom in">
              <Plus size={16} />
            </button>
            <button onClick={() => zoom.current?.("out")} className="size-9 grid place-items-center hover:bg-hover text-muted hover:text-ink border-y border-line" aria-label="Zoom out" title="Zoom out">
              <Minus size={16} />
            </button>
            <button onClick={() => zoom.current?.("fit")} className="size-9 grid place-items-center hover:bg-hover text-muted hover:text-ink" aria-label="Show everything" title="Show everything">
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ shape, children }: { shape: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("size-2.5 bg-muted", shape)} />
      {children}
    </span>
  );
}
