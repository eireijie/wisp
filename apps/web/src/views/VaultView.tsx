import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Eye, FilePlus, Folder, FolderPlus, GitCommitHorizontal, History, Network, Pencil, RefreshCw, ScanEye, Search, Trash2, UserPen, Users, X, PanelLeft, Link2 } from "lucide-react";
import type { AccessRule, MemoryLevel } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { Button, Empty, Field, Input, Modal, Pill, cx, timeAgo } from "../components/ui.tsx";
import { AccessDialog, folderPaths, pathLabel } from "../components/AccessDialog.tsx";
import { Graph } from "../components/Graph.tsx";

interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  updatedAt: number;
}
interface Note extends NoteMeta {
  content: string;
  backlinks: string[];
  access: MemoryLevel;
  editedBy: string | null;
  editedAt: string | null;
}
interface BlameBlock {
  hash: string;
  author: string;
  date: string;
  lines: string[];
}
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
interface Commit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

const base = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");
const norm = (s: string) => s.trim().replace(/\.md$/i, "").toLowerCase();

export function VaultView({ path, onBack }: { path: string | null; onBack?: () => void }) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [graph, setGraph] = useState(false);
  const [activity, setActivity] = useState(false);
  const [makingFolder, setMakingFolder] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [sharing, setSharing] = useState<{ path: string; folder: boolean } | null>(null);
  // owners can look at memory the way one agent sees it
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [ruled, setRuled] = useState<Set<string>>(new Set());
  const agents = useStore((s) => s.agents);
  const isOwner = useStore((s) => s.me?.role === "owner");

  const refresh = useCallback(async () => {
    const [list, rules] = await Promise.all([api<NoteMeta[]>("GET", `/api/vault/notes${viewAs ? `?as=${encodeURIComponent(viewAs)}` : ""}`), api<AccessRule[]>("GET", "/api/access/rules").catch(() => [])]);
    setNotes(list);
    setRuled(new Set(rules.map((r) => r.path.toLowerCase())));
  }, [viewAs]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(query)}&limit=30`).then(setHits), 150);
    return () => clearTimeout(t);
  }, [query]);
  // while viewing as an agent, only show hits it could open
  const visibleHits = useMemo(() => (hits && viewAs && notes ? hits.filter((h) => notes.some((n) => n.path === h.path)) : hits), [hits, viewAs, notes]);

  // on phones, picking a note hides the tree
  useEffect(() => {
    if (path && window.matchMedia("(max-width: 767px)").matches) setShowTree(false);
  }, [path]);

  /** Obsidian-style resolution: exact path, then basename (preferring the same top folder). */
  const resolve = useCallback(
    (target: string, from?: string | null): string | null => {
      if (!notes) return null;
      const t = norm(target);
      const exact = notes.find((n) => norm(n.path) === t);
      if (exact) return exact.path;
      const byName = notes.filter((n) => norm(base(n.path)) === t);
      const scope = from?.split("/").slice(0, from.startsWith("shared/") ? 1 : 2).join("/");
      return (scope && byName.find((n) => n.path.startsWith(scope + "/"))?.path) || byName[0]?.path || null;
    },
    [notes],
  );

  const members = useStore((s) => s.members);
  const folderLabel = useCallback(
    (seg: string, parent: string) => {
      if (parent === "agents") {
        const a = agents.find((x) => x.id === seg);
        return a ? `@${a.handle}` : seg;
      }
      if (parent === "people") return members.find((m) => m.id === seg)?.name ?? seg;
      const top: Record<string, string> = { shared: "Shared", agents: "Agents", groups: "Groups", teams: "Teams", people: "People" };
      if (parent === "" && top[seg]) return top[seg];
      return seg;
    },
    [agents, members],
  );

  const openPath = (p: string) => go({ view: "vault", path: p });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-14 shrink-0 px-3 md:px-5 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <button className="p-1.5 rounded-md hover:bg-hover text-muted" onClick={() => setShowTree(!showTree)} aria-label="Toggle file list" title="Toggle file list">
          <PanelLeft size={18} />
        </button>
        <h1 className="font-semibold flex items-center gap-2 flex-1 min-w-0">
          <BookOpen size={17} className="text-accent shrink-0" /> <span className="truncate">Memory vault</span>
        </h1>
        {isOwner && agents.length > 0 && (
          <label className="hidden sm:flex items-center gap-1.5 text-sm text-muted" title="See memory the way an agent does">
            <ScanEye size={16} />
            <select value={viewAs ?? ""} onChange={(e) => setViewAs(e.target.value || null)} className="h-8 rounded-lg border border-line bg-panel px-2 text-sm text-ink" aria-label="View memory as">
              <option value="">View as you</option>
              {agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  View as @{a.handle}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button variant={activity ? "primary" : "ghost"} onClick={() => (setActivity(!activity), setGraph(false))} title="Who changed what, newest first">
          <History size={16} /> <span className="hidden lg:inline">Activity</span>
        </Button>
        <Button variant={graph ? "primary" : "ghost"} onClick={() => (setGraph(!graph), setActivity(false))} title="Graph view">
          <Network size={16} /> <span className="hidden sm:inline">Graph</span>
        </Button>
        <Button variant="ghost" onClick={() => api("POST", "/api/vault/sync").then(refresh)} title="Pick up changes made in Obsidian or on disk">
          <RefreshCw size={16} /> <span className="hidden sm:inline">Sync</span>
        </Button>
        <Button variant="ghost" onClick={() => setMakingFolder(true)} title="New folder">
          <FolderPlus size={16} /> <span className="hidden lg:inline">New folder</span>
        </Button>
        <Button variant="default" onClick={() => setCreating(path ? path.split("/").slice(0, -1).join("/") : "shared")}>
          <FilePlus size={16} /> <span className="hidden sm:inline">New note</span>
        </Button>
      </header>

      {viewAs && (
        <div className="px-4 md:px-5 py-2 bg-accent-soft text-sm flex items-center gap-2">
          <ScanEye size={15} className="text-accent shrink-0" />
          <span className="flex-1">
            Viewing as <b>@{agents.find((a) => `agent:${a.id}` === viewAs)?.handle}</b>: only the notes it can read are listed.
          </span>
          <Button variant="ghost" className="h-7" onClick={() => setViewAs(null)}>
            Stop
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        {showTree && (
          <aside className="w-full md:w-72 shrink-0 border-r border-line flex flex-col bg-bg/50">
            <div className="p-3">
              <div className="relative">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memory…" className="pl-8" />
                {query && (
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 text-faint" onClick={() => setQuery("")} aria-label="Clear search">
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto pb-4 text-sm">
              {visibleHits ? (
                visibleHits.length ? (
                  visibleHits.map((h) => (
                    <button key={h.path} onClick={() => openPath(h.path)} className={cx("w-full text-left px-4 py-2 hover:bg-hover", h.path === path && "bg-accent-soft")}>
                      <div className="font-medium truncate">{h.title}</div>
                      <div className="text-xs text-muted truncate">{h.path}</div>
                      <div className="text-xs text-muted line-clamp-2" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
                    </button>
                  ))
                ) : (
                  <p className="px-4 text-muted">No matches.</p>
                )
              ) : notes ? (
                <Tree notes={notes} active={path} onOpen={openPath} label={folderLabel} onNew={(dir) => setCreating(dir)} onShare={(dir) => setSharing({ path: dir, folder: true })} ruled={ruled} />
              ) : (
                <p className="px-4 text-muted">Loading…</p>
              )}
            </div>
          </aside>
        )}

        <div className={cx("flex-1 min-w-0", showTree && "hidden md:block")}>
          {activity ? (
            <ActivityFeed onOpen={(p) => (setActivity(false), openPath(p))} />
          ) : graph ? (
            <Graph active={path} onOpen={(p) => (setGraph(false), openPath(p))} labelFor={(p) => notes?.find((n) => n.path === p)?.title ?? base(p)} />
          ) : path ? (
            <NoteEditor key={path} path={path} resolve={resolve} onChanged={refresh} folderLabel={folderLabel} onCreate={(dir, name) => setCreating(`${dir}\u0000${name}`)} onShare={() => setSharing({ path, folder: false })} />
          ) : (
            <Empty icon={<BookOpen />} title="Your shared memory">
              <p>Plain markdown with [[wikilinks]], like Obsidian. Every agent has a private folder, everyone shares <b>Shared</b>, and every edit is saved in git history.</p>
              <p>Make any folders you like. Use the share button on a folder or note to choose which agents can read or edit it, and which ones load it every time they work.</p>
            </Empty>
          )}
        </div>
      </div>

      {sharing && <AccessDialog path={sharing.path} folder={sharing.folder} onClose={() => setSharing(null)} onChanged={refresh} />}
      {makingFolder && (
        <NewFolder
          folders={notes ? folderPaths(notes) : []}
          onClose={() => setMakingFolder(false)}
          onCreated={async (dir, readme) => {
            setMakingFolder(false);
            await refresh();
            openPath(readme);
            // right away: who should be able to use it
            setSharing({ path: dir, folder: true });
          }}
        />
      )}
      {creating !== null && (
        <NewNote
          initial={creating}
          folders={notes ? folderPaths(notes) : []}
          onClose={() => setCreating(null)}
          onCreated={async (p) => {
            setCreating(null);
            await refresh();
            openPath(p);
          }}
        />
      )}
    </div>
  );
}

function snippetHtml(s: string) {
  const esc = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return esc.replace(/\*\*(.+?)\*\*/g, '<mark class="bg-accent-soft text-ink rounded px-0.5">$1</mark>');
}

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; note?: NoteMeta };

type TreeProps = { active: string | null; onOpen: (p: string) => void; label: (seg: string, parent: string) => string; onNew: (dir: string) => void; onShare: (dir: string) => void; ruled: Set<string> };

function Tree({ notes, ...rest }: TreeProps & { notes: NoteMeta[] }) {
  const root = useMemo(() => {
    const r: TreeNode = { name: "", path: "", children: new Map() };
    for (const n of notes) {
      const parts = n.path.split("/");
      let cur = r;
      parts.forEach((seg, i) => {
        const p = parts.slice(0, i + 1).join("/");
        if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: p, children: new Map() });
        cur = cur.children.get(seg)!;
        if (i === parts.length - 1) cur.note = n;
      });
    }
    return r;
  }, [notes]);
  // built-in folders first, then your own folders A–Z, then loose notes
  const order = ["shared", "teams", "groups", "people", "agents"];
  const rank = (n: TreeNode) => (n.note ? 99 : order.includes(n.name) ? order.indexOf(n.name) : 50);
  const top = [...root.children.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <div>
      {top.map((n) => (
        <TreeItem key={n.path} node={n} depth={0} parent="" {...rest} />
      ))}
    </div>
  );
}

function SharedMark({ path, ruled }: { path: string; ruled: Set<string> }) {
  return ruled.has(path.toLowerCase()) ? (
    <span title="Custom access set here" className="shrink-0 text-faint">
      <Users size={12} />
    </span>
  ) : null;
}

function TreeItem({ node, depth, parent, ...rest }: TreeProps & { node: TreeNode; depth: number; parent: string }) {
  const { active, onOpen, label, onNew, onShare, ruled } = rest;
  const [open, setOpen] = useState(depth < 1 || !!active?.startsWith(node.path + "/"));
  const pad = { paddingLeft: 12 + depth * 14 };
  if (node.note)
    return (
      <button onClick={() => onOpen(node.path)} style={pad} className={cx("w-full text-left pr-3 h-8 flex items-center gap-1.5 truncate", node.path === active ? "bg-accent-soft text-accent font-medium" : "hover:bg-hover")}>
        <span className="w-3.5" />
        <span className="truncate">{node.note.title !== base(node.path) ? node.note.title : base(node.path)}</span>
        <SharedMark path={node.path} ruled={ruled} />
      </button>
    );
  const kids = [...node.children.values()].sort((a, b) => Number(!!a.note) - Number(!!b.note) || a.name.localeCompare(b.name));
  return (
    <div>
      <div className="group flex items-center hover:bg-hover pr-2" style={pad}>
        <button onClick={() => setOpen(!open)} className="flex-1 min-w-0 h-8 flex items-center gap-1.5 text-left">
          <ChevronRight size={14} className={cx("text-faint transition-transform shrink-0", open && "rotate-90")} />
          <Folder size={14} className="text-faint shrink-0" />
          <span className={cx("truncate", depth === 0 && "font-semibold")}>{label(node.name, parent)}</span>
          <SharedMark path={node.path} ruled={ruled} />
        </button>
        <button onClick={() => onShare(node.path)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-muted hover:text-ink" title="Who can see this folder" aria-label={`Share ${node.path}`}>
          <Users size={13} />
        </button>
        <button onClick={() => onNew(node.path)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-muted hover:text-ink" title="New note here" aria-label="New note here">
          <FilePlus size={13} />
        </button>
      </div>
      {open && kids.map((k) => <TreeItem key={k.path} node={k} depth={depth + 1} parent={node.name} {...rest} />)}
    </div>
  );
}

function NoteEditor({ path, resolve, onChanged, folderLabel, onCreate, onShare }: { path: string; resolve: (t: string, from?: string | null) => string | null; onChanged: () => void; folderLabel: (s: string, p: string) => string; onCreate: (dir: string, name: string) => void; onShare: () => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [side, setSide] = useState<"links" | "history" | "authors" | null>(null);
  const [history, setHistory] = useState<Commit[] | null>(null);
  const [blame, setBlame] = useState<BlameBlock[] | null>(null);
  const [viewing, setViewing] = useState<{ commit: Commit; content: string } | null>(null);
  const agents = useStore((s) => s.agents);
  const handles = useMemo(() => new Set(agents.map((a) => a.handle)), [agents]);

  const load = useCallback(() => {
    setError(null);
    api<Note>("GET", `/api/vault/note?path=${encodeURIComponent(path)}`)
      .then((n) => {
        setNote(n);
        setDraft(n.content);
      })
      .catch((e) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);

  useEffect(() => {
    if (side === "history") api<Commit[]>("GET", `/api/vault/history?path=${encodeURIComponent(path)}`).then(setHistory);
    if (side === "authors") api<BlameBlock[]>("GET", `/api/vault/blame?path=${encodeURIComponent(path)}`).then(setBlame);
  }, [side, path, note]);

  const dirty = note && draft !== note.content;

  const save = useCallback(async () => {
    if (!note || draft === note.content) return;
    setSaving(true);
    try {
      await api("PUT", "/api/vault/note", { path, content: draft });
      setNote({ ...note, content: draft });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [note, draft, path, onChanged]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        setMode((m) => (m === "edit" ? "preview" : "edit"));
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [save]);

  const html = useMemo(() => renderMarkdown(viewing?.content ?? draft, { known: (t) => !!resolve(t, path), handles, stripFrontmatter: true }), [draft, viewing, resolve, path, handles]);

  // wikilink navigation inside the preview
  const onPreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.wikilink!;
    const found = resolve(target, path);
    if (found) go({ view: "vault", path: found });
    else onCreate(path.split("/").slice(0, -1).join("/"), target);
  };

  if (error) return <Empty icon={<BookOpen />} title="Can't open this note">{error}</Empty>;
  if (!note) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const crumbs = path.split("/");
  const readOnly = note.access === "read";
  const outgoing = [...new Set(note.links)].map((l) => ({ target: l, path: resolve(l, path) }));

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-4 md:px-8 py-2 flex items-center gap-2 border-b border-line text-sm">
          <div className="flex-1 min-w-0 flex items-center gap-1 text-muted truncate">
            {crumbs.map((c, i) => (
              <span key={i} className={cx("flex items-center gap-1 truncate", i < crumbs.length - 1 && side && "hidden")}>
                {i > 0 && <ChevronRight size={12} className="text-faint" />}
                <span className={cx(i === crumbs.length - 1 && "text-ink font-medium")}>{i === crumbs.length - 1 ? base(c) : folderLabel(c, crumbs[i - 1] ?? "")}</span>
              </span>
            ))}
            {note.editedBy && !side && (
              <span className="hidden lg:inline ml-2 text-xs text-faint truncate" title={note.editedAt ? new Date(note.editedAt).toLocaleString() : undefined}>
                edited by {note.editedBy}
                {note.editedAt ? ` · ${timeAgo(note.editedAt)}` : ""}
              </span>
            )}
          </div>
          {dirty && (
            <Button variant="primary" onClick={save} disabled={saving} className="h-8">
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
          {readOnly && <Pill>Read only</Pill>}
          <div className={cx("flex rounded-lg border border-line p-0.5", readOnly && "hidden")}>
            <button onClick={() => setMode("preview")} className={cx("px-2 h-7 rounded-md flex items-center gap-1", mode === "preview" ? "bg-hover" : "text-muted")} title="Preview (⌘E)">
              <Eye size={14} />
            </button>
            <button onClick={() => setMode("edit")} className={cx("px-2 h-7 rounded-md flex items-center gap-1", mode === "edit" ? "bg-hover" : "text-muted")} title="Edit (⌘E)">
              <Pencil size={14} />
            </button>
          </div>
          <button onClick={() => setSide(side === "links" ? null : "links")} className={cx("p-1.5 rounded-md hover:bg-hover", side === "links" ? "text-accent" : "text-muted")} title="Links">
            <Link2 size={16} />
          </button>
          <button onClick={() => setSide(side === "authors" ? null : "authors")} className={cx("p-1.5 rounded-md hover:bg-hover", side === "authors" ? "text-accent" : "text-muted")} title="Who wrote what">
            <UserPen size={16} />
          </button>
          <button onClick={() => setSide(side === "history" ? null : "history")} className={cx("p-1.5 rounded-md hover:bg-hover", side === "history" ? "text-accent" : "text-muted")} title="History">
            <GitCommitHorizontal size={16} />
          </button>
          <button onClick={onShare} className="p-1.5 rounded-md hover:bg-hover text-muted" title="Who can see this note">
            <Users size={16} />
          </button>
          <button
            hidden={readOnly}
            onClick={async () => {
              if (!confirm(`Delete ${path}? It stays recoverable in git history.`)) return;
              await api("DELETE", `/api/vault/note?path=${encodeURIComponent(path)}`);
              onChanged();
              go({ view: "vault", path: null });
            }}
            className="p-1.5 rounded-md hover:bg-hover text-muted hover:text-bad"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
        </div>
        {viewing && (
          <div className="px-4 md:px-8 py-2 bg-accent-soft text-sm flex items-center gap-2">
            <span className="flex-1">
              Viewing version from {new Date(viewing.commit.date).toLocaleString()} by {viewing.commit.author}
            </span>
            <Button
              className="h-7"
              hidden={readOnly}
              onClick={() => {
                setDraft(viewing.content);
                setViewing(null);
                setMode("edit");
              }}
            >
              Restore
            </Button>
            <Button variant="ghost" className="h-7" onClick={() => setViewing(null)}>
              Back to current
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {mode === "edit" && !viewing && !readOnly ? (
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck className="w-full h-full resize-none bg-transparent px-4 md:px-8 py-6 font-mono text-[14px] leading-relaxed outline-none" />
          ) : (
            <div onClick={onPreviewClick} className="prose-w max-w-3xl px-4 md:px-8 py-6 text-[15px]" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>

      {side && (
        <aside className="fixed inset-y-0 right-0 z-20 w-80 max-w-full bg-panel lg:static lg:z-auto border-l border-line overflow-y-auto text-sm safe-top">
          <div className="flex items-center justify-between px-4 h-12 border-b border-line">
            <span className="font-semibold">{side === "links" ? "Links" : side === "authors" ? "Who wrote what" : "History"}</span>
            <button onClick={() => setSide(null)} className="p-1 text-muted" aria-label="Close">
              <X size={16} />
            </button>
          </div>
          {side === "authors" ? (
            <div className="py-2">
              {!blame && <p className="px-4 text-muted">Loading…</p>}
              {blame?.length === 0 && <p className="px-4 text-muted">Not saved yet.</p>}
              {withoutFrontmatter(blame ?? [])
                .filter((b) => b.lines.some((l) => l.trim()))
                .map((b, i) => (
                  <div key={i} className="px-4 py-2 border-b border-line last:border-0">
                    <div className="text-xs text-muted mb-1">
                      <b className="text-ink">{b.author}</b> · {timeAgo(b.date)}
                    </div>
                    <div className="text-[13px] whitespace-pre-wrap break-words line-clamp-6">{b.lines.join("\n").trim()}</div>
                  </div>
                ))}
            </div>
          ) : side === "links" ? (
            <div className="p-4 space-y-5">
              <LinkList title="Linked from" items={note.backlinks.map((p) => ({ label: base(p), sub: p, path: p }))} empty="No notes link here yet." />
              <LinkList title="Links to" items={outgoing.map((o) => ({ label: o.target, sub: o.path ?? "not created yet", path: o.path }))} empty="No outgoing links." />
              {note.tags.length > 0 && (
                <div>
                  <div className="text-xs font-semibold uppercase text-muted mb-2">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {note.tags.map((t) => (
                      <span key={t} className="text-xs bg-hover rounded px-1.5 py-0.5">
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-2">
              {!history && <p className="px-4 text-muted">Loading…</p>}
              {history?.map((c, i) => (
                <button
                  key={c.hash}
                  onClick={async () => (i === 0 ? setViewing(null) : setViewing({ commit: c, content: (await api<{ content: string }>("GET", `/api/vault/at?path=${encodeURIComponent(path)}&rev=${c.hash}`)).content }))}
                  className={cx("w-full text-left px-4 py-2 hover:bg-hover", viewing?.commit.hash === c.hash && "bg-accent-soft")}
                >
                  <div className="font-medium truncate">{c.message}</div>
                  <div className="text-xs text-muted">
                    {c.author} · {timeAgo(c.date)}
                    {i === 0 && " · current"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function LinkList({ title, items, empty }: { title: string; items: { label: string; sub: string; path: string | null }[]; empty: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase text-muted mb-2">{title}</div>
      {items.length === 0 && <p className="text-muted">{empty}</p>}
      {items.map((it) => (
        <button key={it.label + it.sub} disabled={!it.path} onClick={() => it.path && go({ view: "vault", path: it.path })} className="w-full text-left rounded-md px-2 py-1.5 hover:bg-hover disabled:hover:bg-transparent">
          <div className={cx("truncate", it.path ? "text-accent" : "text-muted")}>{it.label}</div>
          <div className="text-xs text-muted truncate">{it.sub}</div>
        </button>
      ))}
    </div>
  );
}

function NewNote({ initial, folders, onClose, onCreated }: { initial: string; folders: string[]; onClose: () => void; onCreated: (p: string) => void }) {
  const [dirInit, nameInit] = initial.split("\u0000");
  const agents = useStore((s) => s.agents);
  const [dir, setDir] = useState(dirInit ?? "shared");
  const [name, setName] = useState(nameInit ?? "");
  const [error, setError] = useState<string | null>(null);
  const suggestions = [...new Set(["shared", ...agents.map((a) => `agents/${a.id}`), ...folders])];
  const label = (f: string) => (f === "shared" ? "Shared (everyone)" : (agents.find((a) => f === `agents/${a.id}`) && `@${agents.find((a) => f === `agents/${a.id}`)!.handle} (private)`) || f);
  return (
    <Modal title="New note" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const clean = name.trim().replace(/\.md$/i, "");
          if (!clean) return;
          const folder = dir.trim().replace(/^\/+|\/+$/g, "");
          const p = `${folder ? folder + "/" : ""}${clean}.md`;
          try {
            await api("PUT", "/api/vault/note", { path: p, content: `# ${base(clean)}\n\n`, message: `Create ${p}` });
            onCreated(p);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Folder" hint="Pick one, or type a new name like Projects to make a folder. New folders are private to people until you share them with agents.">
          <Input value={dir} onChange={(e) => setDir(e.target.value)} list="vault-folders" placeholder="Projects" />
          <datalist id="vault-folders">
            {suggestions.map((f) => (
              <option key={f} value={f}>
                {label(f)}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Name" hint="Use slashes for subfolders, e.g. web/launch-plan">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting notes" required />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Create</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Who changed what across memory you can see, newest first. */
function ActivityFeed({ onOpen }: { onOpen: (p: string) => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [author, setAuthor] = useState("");
  useEffect(() => {
    api<Change[]>("GET", `/api/vault/changes?limit=100${author ? `&author=${encodeURIComponent(author)}` : ""}`).then(setChanges, () => setChanges([]));
  }, [author]);
  const authors = useMemo(() => [...new Set(changes?.map((c) => c.author) ?? [])].sort(), [changes]);
  const verb = { added: "added", modified: "edited", deleted: "deleted", renamed: "moved" } as const;
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl px-4 md:px-8 py-5 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold flex-1">Recent changes</h2>
          <select value={author} onChange={(e) => setAuthor(e.target.value)} className="h-8 rounded-lg border border-line bg-panel px-2 text-sm" aria-label="Filter by author">
            <option value="">Everyone</option>
            {[...new Set([author, ...authors].filter(Boolean))].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {!changes ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted">No changes yet.</p>
        ) : (
          <div className="rounded-xl border border-line divide-y divide-line">
            {changes.map((c) => (
              <div key={c.hash} className="px-4 py-2.5 text-sm">
                <div className="flex items-baseline gap-2">
                  <b className="truncate">{c.author}</b>
                  <span className="text-muted truncate flex-1">{c.message}</span>
                  <span className="text-xs text-faint shrink-0">{timeAgo(c.date)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {c.files.map((f) => (
                    <button key={f.path} disabled={f.change === "deleted"} onClick={() => onOpen(f.path)} className={cx("text-xs truncate max-w-full", f.change === "deleted" ? "text-muted line-through" : "text-accent hover:underline")}>
                      {verb[f.change]} {pathLabel(f.path, agents, members)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A folder only exists with a note in it, so a new folder starts with a README saying what it's for. */
function NewFolder({ folders, onClose, onCreated }: { folders: string[]; onClose: () => void; onCreated: (dir: string, readme: string) => void }) {
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New folder" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const clean = name.trim().replace(/^\/+|\/+$/g, "");
          if (!clean) return;
          const dir = [parent.trim().replace(/^\/+|\/+$/g, ""), clean].filter(Boolean).join("/");
          const readme = `${dir}/README.md`;
          try {
            await api("PUT", "/api/vault/note", { path: readme, content: `# ${clean.split("/").pop()}\n\n${about.trim() || "What this folder is for."}\n`, message: `Create folder ${dir}` });
            onCreated(dir, readme);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Projects" required />
        </Field>
        <Field label="Inside" hint="Leave empty for a top-level folder.">
          <Input value={parent} onChange={(e) => setParent(e.target.value)} list="new-folder-parents" placeholder="(top level)" />
          <datalist id="new-folder-parents">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label="What it's for" hint="Saved as the folder's README. Agents that can use the folder read it.">
          <Input value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Notes for my side projects" />
        </Field>
        <p className="text-xs text-muted">Next you'll choose which agents can use it. New folders are visible to people only until you share them.</p>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Create folder</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Blame blocks minus the note's frontmatter, which is bookkeeping rather than writing. */
function withoutFrontmatter(blocks: BlameBlock[]): BlameBlock[] {
  const lines = blocks.flatMap((b) => b.lines);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return blocks;
  let n = 0;
  return blocks
    .map((b) => {
      const keep = b.lines.filter((_, i) => n + i > end);
      n += b.lines.length;
      return { ...b, lines: keep };
    })
    .filter((b) => b.lines.length);
}
