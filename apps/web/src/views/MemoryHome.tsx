import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FilePlus, Folder, Plus, Search, X } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { timeAgo } from "../components/ui.tsx";
import { MemoryGraph, kindColor, type GraphData, type GraphKind } from "../components/MemoryGraph.tsx";
import { Cards, Overline, pillPrimary, whoIs, useFolderLabel } from "./memory/parts.tsx";
import { buildTree, type Hit, type NoteMeta } from "./memory/Sidebar.tsx";

export interface Change {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: { path: string; change: "added" | "modified" | "deleted" | "renamed"; from?: string }[];
}

const title = (p: string) => p.split("/").pop()!;

/** The front page of Memory: find a note, folders, what changed and who changed it, and the notes everything links to. */
export function MemoryHome({
  graph,
  notes,
  hiddenFolders,
  where,
  snippetHtml,
  onOpen,
  onFolder,
  onGraph,
  onActivity,
  onNew,
  viewAs,
  actions,
}: {
  graph: GraphData | null;
  /** notes the person (or the agent they're viewing as) can open */
  notes: NoteMeta[] | null;
  /** how many folders the helper being viewed can't see (shown as a note under Folders) */
  hiddenFolders?: { count: number; name: string } | null;
  where: (path: string) => string;
  snippetHtml: (s: string) => string;
  onOpen: (path: string) => void;
  onFolder: (path: string) => void;
  onGraph: (kind?: GraphKind) => void;
  onActivity: () => void;
  onNew?: () => void;
  /** the "View as you" control, which phones show under the search */
  viewAs?: ReactNode;
  /** the buttons in the top corner (New note, the more menu) */
  actions?: ReactNode;
}) {
  const memoryVersion = useStore((s) => s.memoryVersion);
  const meId = useStore((s) => s.me?.user.id);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const label = useFolderLabel();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);

  const visible = useMemo(() => (notes ? new Set(notes.map((n) => n.path)) : null), [notes]);
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
    .slice(0, 5);
  const folders = useMemo(() => buildTree(notes ?? [], meId).filter((n) => !n.note), [notes, meId]);
  const noteNodes = graph?.nodes.filter((n) => n.path) ?? [];
  const hubs = [...noteNodes].filter((n) => n.inbound > 0).sort((a, b) => b.inbound - a.inbound || b.links - a.links).slice(0, 6);

  return (
    <div className="h-full overflow-y-auto @container">
      <div className="max-w-[1000px] mx-auto px-4 md:px-10 pt-2 md:pt-6 pb-32 md:pb-12">
        {actions && <div className="hidden md:flex items-center justify-end gap-2 mb-2">{actions}</div>}
        <h2 className="text-[28px] md:text-[34px] font-bold tracking-tight">What your team remembers</h2>
        <div className="relative mt-4">
          <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shownHits?.[0]) onOpen(shownHits[0].path);
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search every note…"
            aria-label="Search memory"
            className="h-12 md:h-[52px] w-full rounded-full border border-control-line bg-control pl-11 pr-10 text-[15px] outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30"
          />
          {query && (
            <button className="absolute right-4 top-1/2 -translate-y-1/2 text-faint hover:text-ink" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>
        {shownHits && (
          <Cards className="mt-3">
            {shownHits.length ? (
              shownHits.map((h) => (
                <button key={h.path} onClick={() => onOpen(h.path)} className="w-full text-left px-5 py-3 hover:bg-hover block">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium truncate">{h.title}</span>
                    <span className="text-xs text-faint truncate">{where(h.path)}</span>
                  </div>
                  <div className="text-xs text-muted line-clamp-2" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
                </button>
              ))
            ) : (
              <p className="px-5 py-3 text-sm text-muted">No notes match “{query}”.</p>
            )}
          </Cards>
        )}
        {viewAs && <div className="md:hidden mt-3">{viewAs}</div>}

        {/* where notes live */}
        {notes && notes.length > 0 && (
          <section aria-label="Folders">
            <Overline>Folders</Overline>
            <div className="hidden md:grid grid-cols-2 xl:grid-cols-4 gap-3">
              {folders.slice(0, 8).map((f) => (
                <button key={f.path} onClick={() => onFolder(f.path)} className="text-left rounded-3xl bg-card p-4 hover:bg-hover/60 transition-colors min-h-[104px] flex flex-col">
                  <Folder size={18} strokeWidth={1.8} className="text-muted" />
                  <span className="mt-auto pt-3 font-semibold truncate">{label(f.name)}</span>
                  <span className="text-xs text-muted">
                    {f.count} {f.count === 1 ? "note" : "notes"}
                  </span>
                </button>
              ))}
            </div>
            <Cards className="md:hidden">
              {folders.map((f) => (
                <button key={f.path} onClick={() => onFolder(f.path)} className="w-full text-left px-4 min-h-14 flex items-center gap-3 hover:bg-hover/60">
                  <Folder size={20} strokeWidth={1.7} className="text-muted shrink-0" />
                  <span className="flex-1 truncate text-[16px]">{label(f.name)}</span>
                  <span className="text-muted text-[15px] tabular-nums">{f.count}</span>
                  <ChevronRight size={16} className="text-faint" />
                </button>
              ))}
            </Cards>
            {hiddenFolders && hiddenFolders.count > 0 && (
              <p className="mt-2 px-1 text-xs text-muted">
                {hiddenFolders.count} {hiddenFolders.count === 1 ? "folder" : "folders"} hidden from {hiddenFolders.name}
              </p>
            )}
          </section>
        )}

        <div className="mt-2 grid gap-x-6 @3xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          {/* who changed what */}
          <section className="min-w-0">
            <Overline
              action={
                <button onClick={onActivity} className="normal-case tracking-normal text-[13px] font-medium text-accent-text underline underline-offset-2">
                  All activity
                </button>
              }
            >
              Recent changes
            </Overline>
            {!changes ? (
              <p className="text-sm text-muted px-1">Loading…</p>
            ) : recent.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-line p-6 text-center text-sm text-muted space-y-3">
                <p>Nothing written yet. Notes you and your helpers write show up here.</p>
                {onNew && (
                  <button onClick={onNew} className="inline-flex items-center gap-1.5 text-ink font-medium hover:underline">
                    <FilePlus size={15} /> Write the first note
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {recent.map((c) => {
                  const w = whoIs(c.author, agents, members, 32);
                  const f = c.files[0]!;
                  return (
                    <button key={c.hash} disabled={f.change === "deleted"} onClick={() => onOpen(f.path)} className="w-full text-left rounded-3xl bg-card px-4 py-3 flex items-center gap-3 hover:bg-hover/60 transition-colors">
                      {w.avatar}
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-semibold text-[15px]">
                          {title(f.path)}
                          {c.files.length > 1 && <span className="text-faint font-normal"> +{c.files.length - 1}</span>}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {w.name} · {timeAgo(c.date)}
                        </span>
                      </span>
                      <ChevronRight size={16} className="text-faint md:hidden" />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <div className="min-w-0">
            {/* a way into the graph */}
            <section>
              <Overline>Graph</Overline>
              <button onClick={() => onGraph()} className="block w-full text-left rounded-3xl bg-card overflow-hidden hover:bg-hover/60 transition-colors" aria-label="Open the graph">
                <div className="relative h-40 bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-size-[18px_18px] pointer-events-none">
                  {graph && graph.nodes.length > 0 ? <MemoryGraph graph={graph} variant="preview" className="absolute inset-0" label="Preview of the memory graph" /> : <div className="absolute inset-0 grid place-items-center text-sm text-faint">No notes yet</div>}
                  <span className="absolute left-4 bottom-3 text-[13px] font-medium text-ink/85">See how every note links together</span>
                </div>
              </button>
            </section>
          </div>
        </div>

        {/* the notes everything points to */}
        {hubs.length > 0 && (
          <section>
            <Overline>Most linked</Overline>
            <div className="flex flex-wrap gap-2">
              {hubs.map((n) => (
                <button key={n.id} onClick={() => onOpen(n.path!)} className="h-9 px-3.5 rounded-full bg-chip text-[13px] font-medium hover:bg-hover inline-flex items-center gap-1.5" title={`${n.inbound} ${n.inbound === 1 ? "note links" : "notes link"} here`}>
                  <span className="size-2 rounded-full" style={{ background: kindColor(n.kind) }} />
                  {n.title} <span className="text-muted tabular-nums">{n.inbound}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      {onNew && (
        <div className="md:hidden fixed inset-x-0 bottom-8 flex justify-center pointer-events-none z-20">
          <button onClick={onNew} className={`${pillPrimary} h-12 px-6 pointer-events-auto shadow-lg`}>
            <Plus size={18} /> New note
          </button>
        </div>
      )}
    </div>
  );
}

