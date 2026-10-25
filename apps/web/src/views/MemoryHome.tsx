import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, FilePlus, PencilLine, Search, X } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { AgentAvatar, GhostMark, UserAvatar, cx, timeAgo } from "../components/ui.tsx";
import { GRAPH_KINDS, MemoryGraph, kindColor, kindLabel, type GraphData, type GraphKind } from "../components/MemoryGraph.tsx";
import { useSimple } from "../experience.tsx";

interface Change {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: { path: string; change: "added" | "modified" | "deleted" | "renamed"; from?: string }[];
}
interface Hit {
  path: string;
  title: string;
  snippet: string;
}

const VERB = { added: "added", modified: "edited", deleted: "deleted", renamed: "moved" } as const;

/** The front page of Memory: find a note, see what changed and who changed it, and the notes everything links to. */
export function MemoryHome({
  graph,
  visible,
  where,
  snippetHtml,
  onOpen,
  onGraph,
  onActivity,
  onNew,
  footer,
}: {
  graph: GraphData | null;
  /** notes the person (or the agent they're viewing as) can open */
  visible: Set<string> | null;
  where: (path: string) => string;
  snippetHtml: (s: string) => string;
  onOpen: (path: string) => void;
  onGraph: (kind?: GraphKind) => void;
  onActivity: () => void;
  onNew?: () => void;
  footer: ReactNode;
}) {
  const simple = useSimple();
  const agents = useStore((s) => s.agents);
  const memoryVersion = useStore((s) => s.memoryVersion);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(query)}&limit=12`).then(setHits, () => setHits([])), 150);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    api<Change[]>("GET", "/api/vault/changes?limit=40").then(setChanges, () => setChanges([]));
  }, [memoryVersion]);

  const seen = (p: string) => !visible || visible.has(p);
  const shownHits = hits?.filter((h) => seen(h.path));
  const recent = (changes ?? [])
    .map((c) => ({ ...c, files: c.files.filter((f) => f.change === "deleted" || seen(f.path)) }))
    .filter((c) => c.files.length)
    .slice(0, 7);
  const notes = graph?.nodes.filter((n) => n.path) ?? [];
  const hubs = [...notes].filter((n) => n.inbound > 0).sort((a, b) => b.inbound - a.inbound || b.links - a.links).slice(0, 6);
  const maxIn = hubs[0]?.inbound ?? 1;
  const counts = new Map<GraphKind, number>();
  for (const n of notes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  const lastChange = changes?.[0]?.date;

  /** Who made a change: an agent (by its @handle), Obsidian, Wisp itself, or a person. */
  const who = (author: string) => {
    const agent = author.startsWith("@") ? agents.find((a) => `@${a.handle}` === author) : undefined;
    if (agent) return { name: agent.name, kind: simple ? "helper" : "agent", avatar: <AgentAvatar agent={agent} size={28} interactive={false} /> };
    if (author === "Edited in Obsidian") return { name: "Obsidian", kind: "on disk", avatar: <span className="size-7 rounded-full bg-chip grid place-items-center text-muted"><PencilLine size={14} /></span> };
    if (author === "Wisp" || author === "Warren") return { name: "Wisp", kind: null, avatar: <span className="size-7 rounded-full bg-chip grid place-items-center text-muted"><GhostMark size={16} /></span> };
    return { name: author, kind: "person", avatar: <UserAvatar name={author} size={28} /> };
  };

  return (
    <div className="h-full overflow-y-auto @container">
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 md:py-10 space-y-8">
        {/* find anything */}
        <section className="space-y-4">
          <div>
            <p className="text-xs text-muted tabular-nums">
              {graph ? `${notes.length} ${notes.length === 1 ? "note" : "notes"} · ${graph.edges.length} ${graph.edges.length === 1 ? "link" : "links"}` : " "}
              {lastChange ? ` · last change ${timeAgo(lastChange)}` : ""}
            </p>
            <h2 className="mt-1 text-2xl md:text-[28px] font-semibold tracking-tight">What your team remembers</h2>
          </div>
          <div className="relative">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shownHits?.[0]) onOpen(shownHits[0].path);
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search every note…"
              aria-label="Search memory"
              className="h-12 w-full rounded-full border border-input bg-panel pl-11 pr-10 text-[15px] shadow-panel outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30"
            />
            {query && (
              <button className="absolute right-4 top-1/2 -translate-y-1/2 text-faint hover:text-ink" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={16} />
              </button>
            )}
          </div>
          {shownHits && (
            <div className="rounded-2xl border border-line bg-panel overflow-hidden">
              {shownHits.length ? (
                shownHits.map((h) => (
                  <button key={h.path} onClick={() => onOpen(h.path)} className="w-full text-left px-4 py-2.5 hover:bg-hover border-b border-line last:border-0 block">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium truncate">{h.title}</span>
                      <span className="text-xs text-faint truncate">{where(h.path)}</span>
                    </div>
                    <div className="text-xs text-muted line-clamp-2" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
                  </button>
                ))
              ) : (
                <p className="px-4 py-3 text-sm text-muted">No notes match “{query}”.</p>
              )}
            </div>
          )}
        </section>

        {/* where notes live */}
        {graph && notes.length > 0 && (
          <section className="flex flex-wrap gap-2" aria-label="Folders">
            {GRAPH_KINDS.filter((k) => counts.get(k)).map((k) => (
              <button key={k} onClick={() => onGraph(k)} className="group inline-flex items-center gap-2 h-9 rounded-full border border-line bg-panel pl-3 pr-3.5 text-sm hover:border-input hover:bg-hover transition-colors" title={`See ${kindLabel(k, simple).toLowerCase()} in the graph`}>
                <span className="size-2.5 rounded-full" style={{ background: kindColor(k) }} />
                <span className="font-medium">{kindLabel(k, simple)}</span>
                <span className="text-muted tabular-nums">{counts.get(k)}</span>
              </button>
            ))}
          </section>
        )}

        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* who changed what */}
          <section className="space-y-3 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold flex-1">Recent changes</h3>
              <button onClick={onActivity} className="text-sm text-muted hover:text-ink inline-flex items-center gap-1">
                All activity <ArrowRight size={14} />
              </button>
            </div>
            {!changes ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : recent.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted space-y-3">
                <p>Nothing written yet. Notes you and your {simple ? "helpers" : "agents"} write show up here.</p>
                {onNew && (
                  <button onClick={onNew} className="inline-flex items-center gap-1.5 text-ink font-medium hover:underline">
                    <FilePlus size={15} /> Write the first note
                  </button>
                )}
              </div>
            ) : (
              <ol className="relative space-y-1">
                {recent.map((c) => {
                  const w = who(c.author);
                  return (
                    <li key={c.hash} className="flex gap-3 rounded-2xl px-3 py-2.5 hover:bg-hover/70">
                      <div className="pt-0.5">{w.avatar}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 text-sm">
                          <span className="font-medium truncate">{w.name}</span>
                          {w.kind && <span className="text-[11px] text-faint">{w.kind}</span>}
                          <span className="ml-auto text-xs text-faint shrink-0">{timeAgo(c.date)}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-sm">
                          {c.files.slice(0, 3).map((f) => (
                            <span key={f.path} className="min-w-0 max-w-full truncate text-muted">
                              {VERB[f.change]}{" "}
                              <button disabled={f.change === "deleted"} onClick={() => onOpen(f.path)} className={cx(f.change === "deleted" ? "line-through" : "text-ink hover:underline underline-offset-2")}>
                                {title(f.path)}
                              </button>
                            </span>
                          ))}
                          {c.files.length > 3 && <span className="text-faint">+{c.files.length - 3} more</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <div className="space-y-6 min-w-0">
            {/* a way into the graph */}
            <section>
              <button onClick={() => onGraph()} className="group block w-full text-left rounded-2xl border border-line bg-panel overflow-hidden hover:border-input transition-colors" aria-label="Open the graph">
                <div className="relative h-52 bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-size-[18px_18px] pointer-events-none">
                  {graph && graph.nodes.length > 0 ? <MemoryGraph graph={graph} variant="preview" className="absolute inset-0" label="Preview of the memory graph" /> : <div className="absolute inset-0 grid place-items-center text-sm text-faint">No notes yet</div>}
                </div>
                <div className="flex items-center gap-2 px-4 py-3 border-t border-line">
                  <div className="flex-1">
                    <div className="font-semibold">Graph</div>
                    <div className="text-xs text-muted">See how every note links together</div>
                  </div>
                  <ArrowRight size={16} className="text-muted group-hover:translate-x-0.5 transition-transform" />
                </div>
              </button>
            </section>

            {/* the notes everything points to */}
            {hubs.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-semibold">Most linked</h3>
                <ul className="space-y-0.5">
                  {hubs.map((n) => (
                    <li key={n.id}>
                      <button onClick={() => onOpen(n.path!)} className="w-full text-left rounded-xl px-3 py-2 hover:bg-hover flex items-center gap-3">
                        <span className="size-2.5 rounded-full shrink-0" style={{ background: kindColor(n.kind) }} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm font-medium">{n.title}</span>
                          <span className="block truncate text-xs text-faint">{where(n.path!)}</span>
                        </span>
                        <span className="w-16 shrink-0 flex items-center gap-1.5" title={`${n.inbound} ${n.inbound === 1 ? "note links" : "notes link"} here`}>
                          <span className="h-1.5 rounded-full bg-chip flex-1 overflow-hidden">
                            <span className="block h-full rounded-full" style={{ width: `${(n.inbound / maxIn) * 100}%`, background: kindColor(n.kind) }} />
                          </span>
                          <span className="text-xs text-muted tabular-nums w-4 text-right">{n.inbound}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>

        <footer className="rounded-2xl bg-bg border border-line px-5 py-4 text-sm text-muted space-y-2">{footer}</footer>
      </div>
    </div>
  );
}

const title = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");
