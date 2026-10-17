import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, FilePlus, Folder, Pencil, Trash2, GitCommitHorizontal, History, House, RefreshCw, ScanEye, Search, Share2, UserPen, Users, X, PanelLeft } from "lucide-react";
import { personDir, type AccessRule, type MemoryLevel } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, guardLeaving, href, mayLeave } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { Button, Empty, Field, Input, Menu, Modal, cx, timeAgo } from "../components/ui.tsx";
import { AccessDialog, pathLabel } from "../components/AccessDialog.tsx";
import { Advanced, useSimple } from "../experience.tsx";
import { obsidianLink, onHubMachine, useMemoryStorage } from "../obsidian.ts";
import { MemoryGraph, kindColor, kindLabel, neighbourhood, type GraphData, type GraphKind } from "../components/MemoryGraph.tsx";
import { MemoryGraphView } from "./MemoryGraphView.tsx";
import { MemoryHome } from "./MemoryHome.tsx";

interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  updatedAt: number;
}
interface Note extends NoteMeta {
  content: string;
  frontmatter: Record<string, string | string[]>;
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
  const simple = useSimple();
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  // phones start on the Memory home; the file list is a tap away
  const [showTree, setShowTree] = useState(() => !window.matchMedia("(max-width: 767px)").matches);
  // what fills the page instead of a note: the graph, or who changed what
  const [panel, setPanel] = useState<{ view: "graph"; kind?: GraphKind } | { view: "activity" } | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [creating, setCreating] = useState<{ dir: string; name?: string } | null>(null);
  const [sharing, setSharing] = useState<{ path: string; folder: boolean } | null>(null);
  // owners can look at memory the way one agent sees it
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [ruled, setRuled] = useState<Set<string>>(new Set());
  // a note just created here opens straight into editing; NoteReader remounts per path, so the intent lives here
  const pendingEdit = useRef<string | null>(null);
  const meId = useStore((s) => s.me?.user.id);
  const agents = useStore((s) => s.agents);
  const isOwner = useStore((s) => s.me?.role === "owner");
  // notes changed in Obsidian (or pushed from another computer): reload the list
  const memoryVersion = useStore((s) => s.memoryVersion);

  const refresh = useCallback(async () => {
    const as = viewAs ? `?as=${encodeURIComponent(viewAs)}` : "";
    const [list, rules, links] = await Promise.all([api<NoteMeta[]>("GET", `/api/vault/notes${as}`), api<AccessRule[]>("GET", "/api/access/rules").catch(() => []), api<GraphData>("GET", `/api/vault/graph${as}`).catch(() => null)]);
    setNotes(list);
    setGraph(links);
    setRuled(new Set(rules.map((r) => r.path.toLowerCase())));
  }, [viewAs]);
  useEffect(() => {
    refresh();
  }, [refresh, memoryVersion]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(query)}&limit=30`).then(setHits), 150);
    return () => clearTimeout(t);
  }, [query]);
  // while viewing as an agent, only show hits it could open
  const visibleHits = useMemo(() => (hits && viewAs && notes ? hits.filter((h) => notes.some((n) => n.path === h.path)) : hits), [hits, viewAs, notes]);

  // on phones, picking a note hides the tree; opening a note from the graph or Activity leaves them
  useEffect(() => {
    if (path && window.matchMedia("(max-width: 767px)").matches) setShowTree(false);
    setPanel(null);
  }, [path]);
  const visible = useMemo(() => (notes ? new Set(notes.map((n) => n.path)) : null), [notes]);

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

  const openPath = (p: string) => {
    if (p === path) setPanel(null);
    go({ view: "vault", path: p });
  };
  const where = (p: string) => {
    const dir = p.split("/").slice(0, -1);
    // short names: "My notes", "Atlas's notes"; Shared stays "Shared" here
    return (simple && dir.join("/") !== "shared" && friendlyDir(dir.join("/"), meId, agents)) || dir.map((seg, i) => folderLabel(seg, dir[i - 1] ?? "")).join(" / ") || "Top folder";
  };
  const show = (next: typeof panel) => mayLeave() && (setPanel(next), next && window.matchMedia("(max-width: 767px)").matches && setShowTree(false));
  const goHome = () => {
    if (!mayLeave()) return;
    setPanel(null);
    if (path) go({ view: "vault", path: null });
    if (window.matchMedia("(max-width: 767px)").matches) setShowTree(false);
  };
  const newNoteDir = path ? path.split("/").slice(0, -1).join("/") : meId ? personDir(meId) : "shared";
  /** A note that's linked to but not written yet: write it next to the first note that links to it. */
  const writeMissing = (title: string) => {
    const from = graph?.edges.find((e) => e.target === `ghost:${title}`)?.source;
    setCreating({ dir: from ? from.split("/").slice(0, -1).join("/") : newNoteDir, name: title });
  };
  const tab = panel?.view ?? (path ? null : "home");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <button className="p-1.5 rounded-md hover:bg-hover text-muted" onClick={() => setShowTree(!showTree)} aria-label="Toggle file list" title="Toggle file list">
          <PanelLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold uppercase tracking-wider shrink-0 mr-auto">Memory</h1>
        {isOwner && agents.length > 0 && (
          <label className="hidden sm:flex items-center gap-1.5 text-sm text-muted min-w-0" title="See memory the way an agent does">
            <ScanEye size={16} />
            <select value={viewAs ?? ""} onChange={(e) => setViewAs(e.target.value || null)} className="h-8 min-w-0 max-w-40 rounded-lg border border-line bg-panel px-2 text-sm text-ink" aria-label="View memory as">
              <option value="">View as you</option>
              {agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  View as @{a.handle}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav className="flex items-center rounded-full bg-chip p-0.5" aria-label="Memory views">
          {(
            [
              { key: "home", label: "Home", icon: <House size={15} />, onClick: goHome, title: "Search, recent changes and the most linked notes" },
              { key: "graph", label: "Graph", icon: <Share2 size={15} />, onClick: () => show(tab === "graph" ? null : { view: "graph" }), title: "See how notes link together" },
              { key: "activity", label: "Activity", icon: <History size={15} />, onClick: () => show(tab === "activity" ? null : { view: "activity" }), title: "Who changed what, newest first" },
            ] as const
          ).map((t) => (
            <button key={t.key} onClick={t.onClick} title={t.title} aria-label={t.label} aria-current={tab === t.key ? "page" : undefined} className={cx("h-7 rounded-full px-2.5 inline-flex items-center gap-1.5 text-sm font-medium transition-colors", tab === t.key ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
              {t.icon}
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          ))}
        </nav>
        <Button variant="ghost" onClick={() => api("POST", "/api/vault/sync").then(refresh)} title="Look for changes made in Obsidian or on disk">
          <RefreshCw size={16} /> <span className="hidden xl:inline">Refresh</span>
        </Button>
        {!viewAs && (
          <Button variant="default" onClick={() => setCreating({ dir: newNoteDir })} title="Write a new note here">
            <FilePlus size={16} /> <span className="hidden sm:inline">New note</span>
          </Button>
        )}
      </header>

      {viewAs && (
        <div className="px-4 md:px-5 py-2 bg-accent-soft text-sm flex items-center gap-2">
          <ScanEye size={15} className="text-accent-text shrink-0" />
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
                <Tree notes={notes} active={path} onOpen={openPath} label={folderLabel} onShare={(dir) => setSharing({ path: dir, folder: true })} ruled={ruled} />
              ) : (
                <p className="px-4 text-muted">Loading…</p>
              )}
            </div>
          </aside>
        )}

        <div className={cx("flex-1 min-w-0", showTree && "hidden md:block")}>
          {panel?.view === "activity" ? (
            <ActivityFeed onOpen={openPath} />
          ) : panel?.view === "graph" ? (
            <MemoryGraphView key={`${viewAs}:${panel.kind ?? ""}`} graph={graph} initialKind={panel.kind} where={where} onOpen={openPath} onWrite={viewAs ? undefined : writeMissing} />
          ) : path ? (
            <NoteReader key={path} path={path} pendingEdit={pendingEdit} resolve={resolve} folderLabel={folderLabel} graph={graph} where={where} onChanged={refresh} onShare={() => setSharing({ path, folder: false })} />
          ) : (
            <MemoryHome
              graph={graph}
              visible={viewAs ? visible : null}
              where={where}
              snippetHtml={snippetHtml}
              onOpen={openPath}
              onGraph={(kind) => show({ view: "graph", kind })}
              onActivity={() => show({ view: "activity" })}
              onNew={viewAs ? undefined : () => setCreating({ dir: newNoteDir })}
              footer={
                simple ? (
                  <>
                    <p>Every helper has a private folder and everyone shares <b className="text-ink">Shared</b>. Use the share button on a folder or note to choose who can read or change it.</p>
                    <Advanced title="Use another notes app">
                      <p className="text-xs">
                        You can open this memory in <a href={href({ view: "settings", page: "memory" })} className="underline hover:text-ink">Obsidian</a> too.
                      </p>
                    </Advanced>
                  </>
                ) : (
                  <>
                    <p>
                      Every agent has a private folder and everyone shares <b className="text-ink">Shared</b>. Use the share button on a folder or note to choose which agents and people can use it, and which agents load it every time they work.
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="flex-1 min-w-48">It's plain markdown in git, so you can also write in Obsidian.</span>
                      <OpenInObsidian className="h-8" />
                    </p>
                  </>
                )
              }
            />
          )}
        </div>
      </div>

      {creating !== null && (
        <NewNote
          initial={creating.dir}
          initialName={creating.name}
          folders={notes ? [...new Set(notes.map((n) => n.path.split("/").slice(0, -1).join("/")).filter(Boolean))].sort() : []}
          onClose={() => setCreating(null)}
          onCreated={async (p) => {
            setCreating(null);
            await refresh();
            pendingEdit.current = p;
            openPath(p);
          }}
        />
      )}
      {sharing && <AccessDialog path={sharing.path} folder={sharing.folder} onClose={() => setSharing(null)} onChanged={refresh} />}
    </div>
  );
}

function snippetHtml(s: string) {
  const esc = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return esc.replace(/\*\*(.+?)\*\*/g, '<mark class="bg-accent-soft text-ink rounded px-0.5">$1</mark>');
}

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; note?: NoteMeta };

type TreeProps = { active: string | null; onOpen: (p: string) => void; label: (seg: string, parent: string) => string; onShare: (dir: string) => void; ruled: Set<string> };

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
  const { active, onOpen, label, onShare, ruled } = rest;
  const [open, setOpen] = useState(depth < 1 || !!active?.startsWith(node.path + "/"));
  const pad = { paddingLeft: 12 + depth * 14 };
  if (node.note)
    return (
      <button onClick={() => onOpen(node.path)} style={pad} className={cx("w-full text-left pr-3 h-8 flex items-center gap-1.5 truncate", node.path === active ? "bg-accent-soft text-accent-text font-medium" : "hover:bg-hover")}>
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
      </div>
      {open && kids.map((k) => <TreeItem key={k.path} node={k} depth={depth + 1} parent={node.name} {...rest} />)}
    </div>
  );
}

/** A note: read here, with a plain editor for quick fixes (Obsidian is the better place to write). History, who wrote what and who can see it. */
/** Focus the note body with the caret after the last character, once when it appears. */
function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el || el.dataset.focused) return;
  el.dataset.focused = "1";
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

/** A friendly name for a folder you write into ("My notes"), or null when it has none. */
function friendlyDir(dir: string, meId: string | undefined, agents: { id: string; name: string }[]): string | null {
  const d = dir.replace(/^\/+|\/+$/g, "");
  if (d === "shared") return "Shared with everyone";
  if (meId && d === personDir(meId)) return "My notes";
  const a = agents.find((x) => d === `agents/${x.id}`);
  return a ? `${a.name}'s notes` : null;
}

function NoteReader({
  path,
  pendingEdit,
  resolve,
  folderLabel,
  graph,
  where,
  onChanged,
  onShare,
}: {
  path: string;
  pendingEdit: React.MutableRefObject<string | null>;
  resolve: (t: string, from?: string | null) => string | null;
  folderLabel: (s: string, p: string) => string;
  graph: GraphData | null;
  where: (p: string) => string;
  onChanged: () => void;
  onShare: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<"history" | "authors" | null>(null);
  const [history, setHistory] = useState<Commit[] | null>(null);
  const [blame, setBlame] = useState<BlameBlock[] | null>(null);
  const [viewing, setViewing] = useState<{ commit: Commit; content: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // set while editing
  const [saving, setSaving] = useState(false);
  const agents = useStore((s) => s.agents);
  const memoryVersion = useStore((s) => s.memoryVersion);
  const simple = useSimple();
  const meId = useStore((s) => s.me?.user.id);
  const storage = useMemoryStorage();
  const handles = useMemo(() => new Set(agents.map((a) => a.handle)), [agents]);

  useEffect(() => {
    setError(null);
    api<Note>("GET", `/api/vault/note?path=${encodeURIComponent(path)}`).then(
      (n) => {
        setNote(n);
        // a note we just created: start editing once, with the draft from what was saved
        if (pendingEdit.current === path) {
          pendingEdit.current = null;
          if (n.access === "edit" || n.access === "manage") setDraft((d) => d ?? n.content);
        }
      },
      (e) => {
        if (pendingEdit.current === path) pendingEdit.current = null;
        setError(e.message);
      },
    );
  }, [path, memoryVersion, pendingEdit]);

  useEffect(() => {
    if (side === "history") api<Commit[]>("GET", `/api/vault/history?path=${encodeURIComponent(path)}`).then(setHistory);
    if (side === "authors") api<BlameBlock[]>("GET", `/api/vault/blame?path=${encodeURIComponent(path)}`).then(setBlame);
  }, [side, path, note]);

  const html = useMemo(() => renderMarkdown(viewing?.content ?? note?.content ?? "", { known: (t) => !!resolve(t, path), handles, stripFrontmatter: true }), [note, viewing, resolve, path, handles]);

  const dirty = !!note && draft !== null && draft !== note.content;

  // edits aren't lost to a stray click: leaving the note (a tree item, a link, Activity, the tab) asks first
  useEffect(() => {
    if (!dirty) return;
    const unguard = guardLeaving(() => `${base(path)} has unsaved changes. Leave without saving them?`);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unguard();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, path]);

  // wikilink navigation inside the note; links to notes that don't exist yet do nothing
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
    if (!a) return;
    e.preventDefault();
    const found = resolve(a.dataset.wikilink!, path);
    if (found) go({ view: "vault", path: found });
  };

  if (error) return <Empty icon={<BookOpen />} title="Can't open this note">{error}</Empty>;
  if (!note) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const canEdit = note.access === "edit" || note.access === "manage";
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      if (draft !== note.content) await api("PUT", "/api/vault/note", { path, content: draft });
      setNote({ ...note, content: draft });
      setDraft(null);
      setError(null);
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete ${path}? It stays recoverable in git history.`)) return;
    try {
      await api("DELETE", `/api/vault/note?path=${encodeURIComponent(path)}`);
      onChanged();
      go({ view: "vault", path: null });
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const crumbs = path.split("/");
  const dirName = friendlyDir(crumbs.slice(0, -1).join("/"), meId, agents);
  // In Simple mode a folder with a friendly name replaces the whole raw path ("My notes / Title")
  const shown: { key: number; text: string; last: boolean }[] =
    simple && dirName
      ? [{ key: 0, text: dirName, last: false }, { key: 1, text: base(crumbs[crumbs.length - 1]!), last: true }]
      : crumbs.map((c, i) => ({ key: i, text: i === crumbs.length - 1 ? base(c) : folderLabel(c, crumbs[i - 1] ?? ""), last: i === crumbs.length - 1 }));
  const openObsidian = () => {
    if (storage?.path && onHubMachine()) window.location.href = obsidianLink(storage.path, path);
    else go({ view: "settings", page: "memory" });
  };
  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* @container: how much of the path shows depends on this row's own width (the tree and side panel take theirs), not the window's */}
        <div className="@container px-4 md:px-8 py-2 flex items-center gap-2 border-b border-line text-sm">
          {/* the note's name keeps its room: folders give way first (shrink-[100]); narrower rows drop the far folders, then the parent, then "edited by" */}
          <div className="flex-1 min-w-0 flex items-center gap-1 text-muted overflow-hidden whitespace-nowrap">
            {shown.map((c, i) => {
              const last = c.last;
              const parent = i === shown.length - 2;
              const show = last ? "flex" : side ? "hidden" : parent ? "hidden @xl:flex" : "hidden @3xl:flex";
              // a chevron belongs to the crumb before it, so it shows only when that one does
              const chevron = i === 0 ? "hidden" : side ? "hidden" : last ? "hidden @xl:block" : parent ? "hidden @3xl:block" : "block";
              return (
                <span key={c.key} className={cx("items-center gap-1 min-w-0", last ? "shrink" : "shrink-[100]", show)}>
                  <ChevronRight size={12} className={cx("text-faint shrink-0", chevron)} />
                  <span className={cx("truncate", last && "text-ink font-medium whitespace-normal break-words min-w-0 md:whitespace-nowrap md:truncate")}>{c.text}</span>
                </span>
              );
            })}
            {note.editedBy && !side && (
              <span className="hidden @2xl:block ml-2 text-xs text-faint min-w-0 shrink-[100] truncate" title={note.editedAt ? new Date(note.editedAt).toLocaleString() : undefined}>
                edited by {note.editedBy}
                {note.editedAt ? ` · ${timeAgo(note.editedAt)}` : ""}
              </span>
            )}
          </div>
          {draft !== null ? (
            <>
              <Button variant="primary" className="h-8" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" className="h-8" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {!simple && <OpenInObsidian note={path} className="h-8 hidden md:inline-flex border-0 px-2 text-muted hover:text-ink" />}
              {canEdit && !viewing && (
                <Button variant="ghost" className="h-8" onClick={() => setDraft(note.content)} title="Edit this note here">
                  <Pencil size={15} /> <span>Edit</span>
                </Button>
              )}
            </>
          )}
          <div className="hidden md:flex items-center gap-2">
          <button onClick={() => setSide(side === "authors" ? null : "authors")} className={cx("p-1.5 rounded-md hover:bg-hover", side === "authors" ? "text-accent-text" : "text-muted")} title="Who wrote what">
            <UserPen size={16} />
          </button>
          <button onClick={() => setSide(side === "history" ? null : "history")} className={cx("p-1.5 rounded-md hover:bg-hover", side === "history" ? "text-accent-text" : "text-muted")} title="History">
            <GitCommitHorizontal size={16} />
          </button>
          <button onClick={onShare} className="p-1.5 rounded-md hover:bg-hover text-muted" title="Who can see this note">
            <Users size={16} />
          </button>
          {canEdit && draft === null && (
            <button onClick={remove} className="p-1.5 rounded-md hover:bg-hover text-muted hover:text-bad" title="Delete">
              <Trash2 size={16} />
            </button>
          )}
          </div>
          <div className="md:hidden">
            <Menu
              align="right"
              trigger={(_open, toggle) => (
                <Button variant="ghost" className="h-8" onClick={toggle} aria-haspopup="menu">
                  More
                </Button>
              )}
              items={[
                { label: side === "history" ? "Hide history" : "History", onSelect: () => setSide(side === "history" ? null : "history") },
                { label: side === "authors" ? "Hide who wrote what" : "Who wrote what", onSelect: () => setSide(side === "authors" ? null : "authors") },
                { label: "Who can see this note", onSelect: onShare },
                { label: "Open in Obsidian", onSelect: openObsidian },
                ...(canEdit && draft === null ? [{ label: "Delete", danger: true, onSelect: remove }] : []),
              ]}
            />
          </div>
        </div>
        {viewing && (
          <div className="px-4 md:px-8 py-2 bg-accent-soft text-sm flex items-center gap-2">
            <span className="flex-1">
              Viewing version from {new Date(viewing.commit.date).toLocaleString()} by {viewing.commit.author}
            </span>
            <Button variant="ghost" className="h-7" onClick={() => setViewing(null)}>
              Back to current
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {draft !== null ? (
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck ref={focusAtEnd} aria-label="Note text" className="w-full h-full resize-none bg-transparent px-4 md:px-8 py-6 font-mono text-[14px] leading-relaxed outline-none" />
          ) : (
            <div className={cx("px-4 md:px-8 py-6 grid gap-8", !side && "xl:grid-cols-[minmax(0,48rem)_17rem] 2xl:gap-12")}>
              <article className="min-w-0 max-w-3xl">
                {!viewing && <Properties frontmatter={note.frontmatter ?? {}} kind={graph?.nodes.find((n) => n.id === path)?.kind ?? null} resolve={(t) => resolve(t, path)} />}
                <div onClick={onClick} className="prose-w text-[15px]" dangerouslySetInnerHTML={{ __html: html }} />
              </article>
              <Connected path={path} graph={graph} backlinks={note.backlinks} where={where} />
            </div>
          )}
        </div>
      </div>

      {side && (
        <aside className="fixed inset-y-0 right-0 z-20 w-80 max-w-full bg-panel lg:static lg:z-auto border-l border-line overflow-y-auto text-sm safe-top">
          <div className="flex items-center justify-between px-4 h-12 border-b border-line">
            <span className="font-semibold">{side === "authors" ? "Who wrote what" : "History"}</span>
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

/** The note's front matter, laid out as properties: tags as chips, [[links]] you can follow. */
function Properties({ frontmatter, kind, resolve }: { frontmatter: Record<string, string | string[]>; kind: GraphKind | null; resolve: (t: string) => string | null }) {
  const simple = useSimple();
  const entries = Object.entries(frontmatter).filter(([k, v]) => k !== "title" && (Array.isArray(v) ? v.length : v !== ""));
  if (!entries.length) return null;
  const value = (v: string) => {
    const link = v.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
    if (!link) return <span className="break-words">{v}</span>;
    const to = resolve(link[1]!);
    return to ? (
      <button onClick={() => go({ view: "vault", path: to })} className="text-accent-text hover:underline underline-offset-2">
        {link[2] ?? link[1]}
      </button>
    ) : (
      <span className="text-muted">{link[2] ?? link[1]}</span>
    );
  };
  const nice = (k: string) => k.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <dl className="mb-6 rounded-2xl border border-line bg-bg/60 px-4 py-3 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-6 gap-y-2 text-sm" aria-label="Properties">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{nice(k)}</dt>
          <dd className="min-w-0 flex flex-wrap items-center gap-1.5">
            {k === "type" && typeof v === "string" ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2 h-6 text-xs font-medium">
                {kind && <span className="size-2 rounded-full" style={{ background: kindColor(kind) }} title={kindLabel(kind, simple)} />}
                {v}
              </span>
            ) : k === "tags" ? (
              (Array.isArray(v) ? v : [v]).map((t) => (
                <span key={t} className="rounded-full bg-chip px-2 h-6 inline-flex items-center text-xs text-muted">
                  #{t}
                </span>
              ))
            ) : Array.isArray(v) ? (
              v.map((x, i) => (
                <span key={i} className="after:content-[','] after:text-faint last:after:content-none">
                  {value(x)}
                </span>
              ))
            ) : (
              value(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Beside the note: a small map of the notes it's linked with, and the lists of what links here and where it points. */
function Connected({ path, graph, backlinks, where }: { path: string; graph: GraphData | null; backlinks: string[]; where: (p: string) => string }) {
  const simple = useSimple();
  const local = useMemo(() => {
    if (!graph) return null;
    // a sparsely linked note also shows its neighbours' neighbours, while that stays small enough to read
    const one = neighbourhood(graph, path, 1);
    const two = one.nodes.length < 4 ? neighbourhood(graph, path, 2) : one;
    return two.nodes.length <= 12 ? two : one;
  }, [graph, path]);
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);
  const outgoing = (graph?.edges ?? []).filter((e) => e.source === path && !backlinks.includes(e.target)).map((e) => byId.get(e.target)!).filter(Boolean);
  // the graph follows "View as", so a note the viewed agent can't read drops out of these lists too
  const linkedHere = graph ? backlinks.filter((p) => byId.has(p)).map((p) => byId.get(p)!) : [];
  const open = (p: string | null) => p && go({ view: "vault", path: p });
  const Row = ({ n }: { n: { id: string; path: string | null; title: string; kind: GraphKind } }) => (
    <li>
      <button disabled={!n.path} onClick={() => open(n.path)} className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-hover disabled:hover:bg-transparent flex items-center gap-2 min-w-0">
        <span className={cx("size-2 rounded-full shrink-0", n.kind === "ghost" && "border border-dashed")} style={n.kind === "ghost" ? { borderColor: "var(--faint)" } : { background: kindColor(n.kind) }} />
        <span className={cx("truncate text-sm", !n.path && "text-muted")}>{n.title}</span>
        <span className="ml-auto text-xs text-faint truncate max-w-[45%] shrink-0">{n.path ? where(n.path) : kindLabel("ghost", simple).toLowerCase()}</span>
      </button>
    </li>
  );
  return (
    <aside className="min-w-0 space-y-5 xl:sticky xl:top-6 xl:self-start border-t border-line pt-6 xl:border-0 xl:pt-0" aria-label="Connected notes">
      <section>
        <h3 className="text-xs font-semibold text-muted mb-2">Connected notes</h3>
        <div className="relative h-60 rounded-2xl border border-line bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-size-[16px_16px] overflow-hidden">
          {local && local.nodes.length > 1 ? (
            <MemoryGraph graph={local} variant="local" active={path} onOpen={(n) => open(n.path)} className="absolute inset-0" label={`${local.nodes.length - 1} notes linked with this one`} />
          ) : (
            <p className="absolute inset-0 grid place-items-center p-5 text-center text-xs text-muted">
              {local ? "Not linked to other notes yet. Write [[Note name]] to link one." : "Loading…"}
            </p>
          )}
        </div>
      </section>
      {linkedHere.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted mb-1">
            Linked from <span className="text-faint tabular-nums">{linkedHere.length}</span>
          </h3>
          <ul className="-mx-2">{linkedHere.map((n) => <Row key={n.id} n={n} />)}</ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted mb-1">
            Links to <span className="text-faint tabular-nums">{outgoing.length}</span>
          </h3>
          <ul className="-mx-2">{outgoing.map((n) => <Row key={n.id} n={n} />)}</ul>
        </section>
      )}
    </aside>
  );
}

function NewNote({ initial, initialName = "", folders, onClose, onCreated }: { initial: string; initialName?: string; folders: string[]; onClose: () => void; onCreated: (p: string) => void }) {
  const agents = useStore((s) => s.agents);
  const meId = useStore((s) => s.me?.user.id);
  const [dir, setDir] = useState(initial);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const simple = useSimple();
  const choices = [
    ...(meId ? [{ value: personDir(meId), label: "My notes" }] : []),
    { value: "shared", label: "Shared with everyone" },
    ...agents.map((a) => ({ value: `agents/${a.id}`, label: `${a.name}'s notes` })),
  ];
  const known = choices.some((c) => c.value === dir);
  const [other, setOther] = useState(!known && !!dir);
  const selectValue = other ? "__other" : known ? dir : "";
  const suggestions = [...new Set(["shared", ...agents.map((a) => `agents/${a.id}`), ...folders])];
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
        <Field label="Where to keep it">
          <select
            value={selectValue}
            onChange={(e) => {
              if (e.target.value === "__other") setOther(true);
              else {
                setOther(false);
                setDir(e.target.value);
              }
            }}
            className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/30"
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            {!simple && <option value="__other">Other folder…</option>}
            {simple && other && <option value="__other">{friendlyDir(dir, meId, agents) ?? dir}</option>}
          </select>
        </Field>
        {other && (
          <Advanced title="Other folder…">
            <Field label="Folder path" hint="Pick one or type a new name to make a folder.">
              <Input value={dir} onChange={(e) => setDir(e.target.value)} list="vault-folders" placeholder="shared" />
              <datalist id="vault-folders">
                {suggestions.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
          </Advanced>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting notes" required autoFocus />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">Create</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Opens the vault, or one note, in Obsidian. On the same computer as Warren that's a direct link;
 * from anywhere else it leads to the steps for syncing the vault into Obsidian.
 */
function OpenInObsidian({ note, className }: { note?: string; className?: string }) {
  const storage = useMemoryStorage();
  const direct = storage?.path && onHubMachine();
  const label = (
    <>
      <ExternalLink size={15} /> <span className={note ? "sr-only" : undefined}>Open in Obsidian</span>
    </>
  );
  const style = cx("inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium hover:bg-hover whitespace-nowrap", className);
  return direct ? (
    <a href={obsidianLink(storage.path!, note)} className={style} title="Opens this in the Obsidian app on this computer">
      {label}
    </a>
  ) : (
    <a href={href({ view: "settings", page: "memory" })} className={style} title="Steps for using this memory in Obsidian on your computer">
      {label}
    </a>
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
                    <button key={f.path} disabled={f.change === "deleted"} onClick={() => onOpen(f.path)} className={cx("text-xs truncate max-w-full", f.change === "deleted" ? "text-muted line-through" : "text-accent-text hover:underline")}>
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
