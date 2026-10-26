import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileText, Folder, Plus, Search, X } from "lucide-react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { cx, timeAgo } from "../../components/ui.tsx";
import { pathLabel } from "../../components/AccessDialog.tsx";
import { Cards, Overline, PhoneBar, folderSteps, noteName, pillPrimary, useFolderLabel, useIsPhone, whoIs } from "./parts.tsx";
import { buildTree, findNode, type Hit, type NoteMeta } from "./Sidebar.tsx";
import type { Change } from "../MemoryHome.tsx";

const VERB = { added: "wrote", modified: "edited", deleted: "deleted", renamed: "moved" } as const;

/** Who changed what across memory you can see, newest first. */
export function ActivityFeed({ onOpen, onBack, filterAuthors }: { onOpen: (p: string) => void; onBack: () => void; filterAuthors?: boolean }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const phone = useIsPhone();
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [author, setAuthor] = useState("");
  const [all, setAll] = useState<string[]>([]);
  useEffect(() => {
    api<Change[]>("GET", `/api/vault/changes?limit=100${author ? `&author=${encodeURIComponent(author)}` : ""}`).then(
      (c) => {
        setChanges(c);
        if (!author) setAll([...new Set(c.map((x) => x.author))]);
      },
      () => setChanges([]),
    );
  }, [author]);
  const day = (iso: string) => {
    const d = new Date(iso);
    const n = new Date();
    const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
    return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  };
  const groups = useMemo(() => {
    const out: { day: string; items: Change[] }[] = [];
    for (const c of changes ?? []) {
      const d = day(c.date);
      const last = out[out.length - 1];
      if (last?.day === d) last.items.push(c);
      else out.push({ day: d, items: [c] });
    }
    return out;
  }, [changes]);
  void filterAuthors;
  const chip = (value: string, text: string, avatar?: React.ReactNode) => (
    <button key={value} onClick={() => setAuthor(value)} aria-pressed={author === value} className={cx("h-10 px-4 rounded-full inline-flex items-center gap-2 text-[14px] font-medium whitespace-nowrap transition-colors", author === value ? "bg-accent text-accent-ink" : "bg-card text-ink/85 hover:bg-hover")}>
      {avatar}
      {text}
    </button>
  );
  const row = (c: Change) => {
    const w = whoIs(c.author, agents, members, 36);
    return (
      <div key={c.hash} className="px-4 py-3 flex items-start gap-3">
        {w.avatar}
        <div className="flex-1 min-w-0">
          <p className="text-[15px] leading-snug">
            <b>{w.name}</b>{" "}
            {c.files.slice(0, 3).map((f, i) => (
              <span key={f.path}>
                {i === 0 ? VERB[f.change] : ", "}{" "}
                <button disabled={f.change === "deleted"} onClick={() => onOpen(f.path)} className={cx(f.change === "deleted" ? "line-through text-muted" : "text-accent-text underline underline-offset-2")} title={pathLabel(f.path, agents, members)}>
                  {f.path.split("/").pop()}
                </button>
              </span>
            ))}
            {c.files.length > 3 && <span className="text-muted"> and {c.files.length - 3} more</span>}
          </p>
          <p className="text-xs text-muted mt-0.5 md:hidden">{timeAgo(c.date)}</p>
        </div>
        <span className="hidden md:block text-xs text-muted shrink-0 pt-1">{timeAgo(c.date)}</span>
      </div>
    );
  };
  return (
    <div className="h-full flex flex-col min-h-0">
      {phone && <PhoneBar title="Recent changes" onBack={onBack} />}
      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-28">
        <div className="mx-auto max-w-[720px]">
          {!phone && <h2 className="t-title mt-6">Recent changes</h2>}
          <div className="mt-3 flex gap-2 overflow-x-auto [scrollbar-width:none] -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap" role="group" aria-label="Filter by author">
            {chip("", "Everyone")}
            {[...new Set([author, ...all].filter(Boolean))].map((a) => {
              const w = whoIs(a, agents, members, 18);
              return chip(a, w.name, w.avatar);
            })}
          </div>
          {!changes ? (
            <p className="mt-6 text-sm text-muted px-1">Loading…</p>
          ) : changes.length === 0 ? (
            <p className="mt-6 text-sm text-muted px-1">No changes yet.</p>
          ) : phone ? (
            groups.map((g) => (
              <section key={g.day}>
                <Overline>{g.day}</Overline>
                <Cards>{g.items.map(row)}</Cards>
              </section>
            ))
          ) : (
            <Cards className="mt-4">{changes.map(row)}</Cards>
          )}
        </div>
      </div>
    </div>
  );
}

/** A folder: its folders and notes, with a search that stays inside it. */
export function FolderView({ path, notes, onOpen, onFolder, onNew, onBack, canNew }: { path: string; notes: NoteMeta[]; onOpen: (p: string) => void; onFolder: (p: string) => void; onNew: () => void; onBack: () => void; canNew: boolean }) {
  const phone = useIsPhone();
  const label = useFolderLabel();
  const meId = useStore((s) => s.me?.user.id);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const tree = useMemo(() => buildTree(notes, meId), [notes, meId]);
  const node = findNode(tree, path);
  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(query)}&limit=40`).then((r) => setHits(r.filter((h) => h.path.startsWith(path + "/"))), () => setHits([])), 150);
    return () => clearTimeout(t);
  }, [query, path]);
  const steps = folderSteps(path);
  const kids = node ? [...node.children.values()] : [];
  const subfolders = kids.filter((k) => !k.note).sort((a, b) => a.name.localeCompare(b.name));
  const files = kids.filter((k) => k.note).sort((a, b) => b.note!.updatedAt - a.note!.updatedAt);
  const name = label(steps[steps.length - 1] ?? "");
  const back = steps.length > 1 ? () => onFolder(steps.slice(0, -1).join("/")) : onBack;
  return (
    <div className="h-full flex flex-col min-h-0">
      {phone && <PhoneBar title={name} onBack={back} />}
      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-32">
        <div className="mx-auto max-w-[720px]">
          <nav className="mt-3 md:mt-6 flex flex-wrap items-center gap-1.5 text-[14px] text-muted" aria-label="Folder path">
            <button onClick={onBack} className="hover:text-ink">
              Memory
            </button>
            {steps.map((s, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <ChevronRight size={13} className="text-faint" />
                <button onClick={() => onFolder(steps.slice(0, i + 1).join("/"))} className={i === steps.length - 1 ? "text-ink font-medium" : "hover:text-ink"}>
                  {label(s)}
                </button>
              </span>
            ))}
          </nav>
          {!phone && <h2 className="t-title mt-3">{name}</h2>}
          <div className="relative mt-4">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this folder…" aria-label="Search this folder" className="h-12 w-full rounded-full border border-control-line bg-control pl-11 pr-10 text-[15px] outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30" />
            {query && (
              <button className="absolute right-4 top-1/2 -translate-y-1/2 text-faint" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </div>
          {hits ? (
            <Cards className="mt-4">
              {hits.length ? (
                hits.map((h) => (
                  <button key={h.path} onClick={() => onOpen(h.path)} className="w-full text-left px-4 py-3 hover:bg-hover/60">
                    <div className="font-medium truncate">{h.title}</div>
                    <div className="text-xs text-muted truncate">{h.path}</div>
                  </button>
                ))
              ) : (
                <p className="px-4 py-3 text-sm text-muted">No matches here.</p>
              )}
            </Cards>
          ) : (
            <>
              {subfolders.length > 0 && (
                <section>
                  <Overline>Folders</Overline>
                  <Cards>
                    {subfolders.map((f) => (
                      <button key={f.path} onClick={() => onFolder(f.path)} className="w-full text-left px-4 min-h-12 flex items-center gap-3 hover:bg-hover/60">
                        <Folder size={20} strokeWidth={1.7} className="text-muted" />
                        <span className="flex-1 truncate text-[15px]">{f.name}</span>
                        <span className="text-muted text-[15px] tabular-nums">{f.count}</span>
                        <ChevronRight size={16} className="text-faint" />
                      </button>
                    ))}
                  </Cards>
                </section>
              )}
              {files.length > 0 && (
                <section>
                  <Overline>Notes</Overline>
                  <Cards>
                    {files.map((f) => (
                      <button key={f.path} onClick={() => onOpen(f.path)} className="w-full text-left px-4 py-2.5 min-h-12 flex items-center gap-3 hover:bg-hover/60">
                        <FileText size={20} strokeWidth={1.7} className="text-muted" />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-[15px] font-medium">{f.name}</span>
                          <span className="block text-xs text-muted">{timeAgo(new Date(f.note!.updatedAt).toISOString())}</span>
                        </span>
                        <ChevronRight size={16} className="text-faint" />
                      </button>
                    ))}
                  </Cards>
                </section>
              )}
              {!node && <p className="mt-6 text-sm text-muted px-1">Nothing in this folder you can see.</p>}
            </>
          )}
        </div>
      </div>
      {canNew && (
        <div className="fixed md:absolute inset-x-0 bottom-8 md:bottom-8 flex justify-center pointer-events-none z-20">
          <button onClick={onNew} className={cx(pillPrimary, "h-12 px-6 pointer-events-auto shadow-lg")}>
            <Plus size={18} /> New note
          </button>
        </div>
      )}
    </div>
  );
}

export { noteName };
