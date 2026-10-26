import { useMemo, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronDown, ChevronRight, Clock, ExternalLink, FileText, Folder, Lock, Plus, Search, Share2, User, Users, X, Eye } from "lucide-react";
import { Popover, UserAvatar, AgentAvatar, cx } from "../../components/ui.tsx";
import { useStore } from "../../store.ts";
import { baseName, folderSteps, useFolderLabel } from "./parts.tsx";

export interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  updatedAt: number;
}
export interface Hit {
  path: string;
  title: string;
  snippet: string;
}

export type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; note?: NoteMeta; count: number };

/** Folders and notes as a tree. agents/<id> and people/<id> are each a top folder of their own ("Ghosty's notes"). */
export function buildTree(notes: NoteMeta[], meId?: string): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: new Map(), count: 0 };
  for (const n of notes) {
    const parts = folderSteps(n.path.split("/").slice(0, -1).join("/"));
    const segs = [...parts, baseName(n.path)];
    let cur = root;
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join("/");
      if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: p, children: new Map(), count: 0 });
      cur = cur.children.get(seg)!;
      if (i < segs.length - 1) cur.count++;
      if (i === segs.length - 1) cur.note = n;
    });
  }
  // built-in folders first: Shared, your own notes, helpers' notes, other people, teams, groups, then your own folders A to Z
  const rank = (n: TreeNode) => {
    if (n.note) return 99;
    if (n.name === "shared") return 0;
    if (meId && n.name === `people/${meId}`) return 1;
    if (n.name.startsWith("agents/")) return 2;
    if (n.name.startsWith("people/")) return 3;
    if (n.name === "teams") return 4;
    if (n.name === "groups") return 5;
    return 50;
  };
  return [...root.children.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Find a folder node by its path. */
export function findNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const n of tree) {
    if (n.path === path) return n;
    if (!n.note && path.startsWith(n.path + "/")) {
      const f = findNode([...n.children.values()], path);
      if (f) return f;
    }
  }
  return null;
}

type TreeProps = { active: string | null; onOpen: (p: string) => void; onFolder: (p: string) => void; label: (seg: string) => string; onShare: (dir: string) => void; ruled: Set<string> };

function SharedMark({ path, ruled }: { path: string; ruled: Set<string> }) {
  return ruled.has(path.toLowerCase()) ? (
    <span title="Custom access set here" className="shrink-0 text-faint">
      <Users size={12} />
    </span>
  ) : null;
}

function TreeItem({ node, depth, ...rest }: TreeProps & { node: TreeNode; depth: number }) {
  const { active, onOpen, onFolder, label, onShare, ruled } = rest;
  const [open, setOpen] = useState(depth < 1 && node.name === "shared" ? true : !!active?.startsWith(node.path + "/"));
  const pad = { paddingLeft: 10 + depth * 16 };
  if (node.note)
    return (
      <button onClick={() => onOpen(node.path)} style={pad} aria-current={node.path === active ? "page" : undefined} className={cx("w-full text-left pr-3 h-10 rounded-2xl flex items-center gap-2.5 text-[14px]", node.path === active ? "bg-card text-ink font-semibold" : "text-ink/85 hover:bg-hover")}>
        <span className="w-3.5 shrink-0" />
        <FileText size={15} strokeWidth={1.8} className="shrink-0 text-faint" />
        <span className="truncate">{node.name}</span>
        <SharedMark path={node.path} ruled={ruled} />
      </button>
    );
  const kids = [...node.children.values()].sort((a, b) => Number(!!a.note) - Number(!!b.note) || a.name.localeCompare(b.name));
  return (
    <div>
      <div className={cx("group flex items-center rounded-2xl pr-2 hover:bg-hover", active === node.path && "bg-card")} style={pad}>
        <button
          onClick={() => {
            setOpen(!open);
            if (!open) onFolder(node.path);
          }}
          aria-expanded={open}
          className="flex-1 min-w-0 h-10 flex items-center gap-2.5 text-left text-[14px]"
        >
          <ChevronRight size={14} className={cx("text-faint transition-transform shrink-0", open && "rotate-90")} />
          <Folder size={15} strokeWidth={1.8} className="text-faint shrink-0" />
          <span className={cx("truncate", depth === 0 && "font-semibold")}>{label(node.name)}</span>
          <SharedMark path={node.path} ruled={ruled} />
        </button>
        <button onClick={() => onShare(node.path)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-muted hover:text-ink" title="Who can see this folder" aria-label={`Who can see ${label(node.name)}`}>
          <Share2 size={13} />
        </button>
        <span className="ml-1 text-xs text-faint tabular-nums">{node.count}</span>
      </div>
      {open && kids.map((k) => <TreeItem key={k.path} node={k} depth={depth + 1} {...rest} />)}
    </div>
  );
}

export function Tree({ notes, ...rest }: TreeProps & { notes: NoteMeta[] }) {
  const meId = useStore((s) => s.me?.user.id);
  const top = useMemo(() => buildTree(notes, meId), [notes, meId]);
  return (
    <div role="tree" aria-label="Memory folders" className="px-2">
      {top.map((n) => (
        <TreeItem key={n.path} node={n} depth={0} {...rest} />
      ))}
    </div>
  );
}

/** "View as you" with a list of helpers: owners see memory the way an agent does. */
export function ViewAsPicker({ viewAs, onChange }: { viewAs: string | null; onChange: (v: string | null) => void }) {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => `agent:${a.id}` === viewAs);
  const row = (selected: boolean, icon: ReactNode, text: string, pick: () => void, close: () => void) => (
    <button
      key={text}
      onClick={() => {
        pick();
        close();
      }}
      className="w-full h-11 px-3 rounded-xl flex items-center gap-3 text-[14px] text-left hover:bg-hover"
    >
      {icon}
      <span className="flex-1">{text}</span>
      {selected && <Check size={15} className="text-info" />}
    </button>
  );
  return (
    <Popover
      up={false}
      className="w-60 p-1.5"
      trigger={(open, toggle) => (
        <button onClick={toggle} aria-expanded={open} aria-label="View memory as" className="w-full h-10 px-3 rounded-2xl flex items-center gap-2.5 text-[14px] text-info hover:bg-hover">
          <Eye size={15} />
          <span className="flex-1 text-left truncate">{agent ? `View as ${agent.name}` : "View as you"}</span>
          <ChevronDown size={14} className="text-muted" />
        </button>
      )}
    >
      {(close) => (
        <div role="listbox" aria-label="View memory as">
          <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">View memory as</div>
          {row(!viewAs, <User size={16} className="text-muted" />, "You", () => onChange(null), close)}
          {agents.map((a) => row(viewAs === `agent:${a.id}`, <AgentAvatar agent={a} size={20} interactive={false} />, a.name, () => onChange(`agent:${a.id}`), close))}
        </div>
      )}
    </Popover>
  );
}

/** The left column on desktops: search, view as, the folder tree, and the other places in Memory. */
export function Sidebar({
  notes,
  query,
  setQuery,
  hits,
  snippetHtml,
  active,
  onOpen,
  onFolder,
  onShare,
  ruled,
  onNew,
  canNew,
  viewAs,
  setViewAs,
  canViewAs,
  panel,
  links,
}: {
  notes: NoteMeta[] | null;
  query: string;
  setQuery: (q: string) => void;
  hits: Hit[] | null;
  snippetHtml: (s: string) => string;
  active: string | null;
  onOpen: (p: string) => void;
  onFolder: (p: string) => void;
  onShare: (dir: string) => void;
  ruled: Set<string>;
  onNew: () => void;
  canNew: boolean;
  viewAs: string | null;
  setViewAs: (v: string | null) => void;
  canViewAs: boolean;
  panel: string | null;
  links: { key: string; label: string; icon: ReactNode; onClick: () => void }[];
}) {
  const label = useFolderLabel();
  return (
    <aside className="w-[300px] shrink-0 border-r border-line flex flex-col min-h-0">
      <div className="px-5 pt-5 pb-3 flex items-center gap-3">
        <a href="#/vault" className="flex-1 text-[26px] font-bold tracking-tight leading-none">
          Memory
        </a>
        {canNew && (
          <button onClick={onNew} className="circle circle-sm" aria-label="New note" title="New note">
            <Plus size={18} />
          </button>
        )}
      </div>
      <div className="px-4 pb-1">
        <div className="relative">
          <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search every note…" aria-label="Search memory" className="h-11 w-full rounded-full border border-control-line bg-control pl-10 pr-9 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30" />
          {query && (
            <button className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {canViewAs && (
        <div className="px-3 pt-1">
          <ViewAsPicker viewAs={viewAs} onChange={setViewAs} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto py-1 text-sm">
        {hits ? (
          hits.length ? (
            hits.map((h) => (
              <button key={h.path} onClick={() => onOpen(h.path)} className={cx("w-full text-left px-5 py-2 hover:bg-hover", h.path === active && "bg-card")}>
                <div className="font-medium truncate">{h.title}</div>
                <div className="text-xs text-muted truncate">{h.path}</div>
                <div className="text-xs text-muted line-clamp-2" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
              </button>
            ))
          ) : (
            <p className="px-5 py-2 text-muted">No matches.</p>
          )
        ) : notes ? (
          notes.length ? (
            <Tree notes={notes} active={active} onOpen={onOpen} onFolder={onFolder} label={label} onShare={onShare} ruled={ruled} />
          ) : (
            <p className="px-5 py-2 text-muted">No notes yet.</p>
          )
        ) : (
          <p className="px-5 py-2 text-muted">Loading…</p>
        )}
      </div>
      <nav className="border-t border-line px-3 py-3 space-y-0.5" aria-label="More in Memory">
        {links.map((l) => (
          <button key={l.key} onClick={l.onClick} aria-current={panel === l.key ? "page" : undefined} className={cx("w-full h-10 px-3 rounded-2xl flex items-center gap-3 text-[14px] text-left", panel === l.key ? "bg-card font-semibold" : "text-ink/85 hover:bg-hover")}>
            <span className="text-muted">{l.icon}</span>
            {l.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}

export const sidebarIcons = {
  graph: <Share2 size={16} />,
  activity: <Clock size={16} />,
  access: <Lock size={16} />,
  about: <User size={16} />,
  storage: <ExternalLink size={16} />,
  book: <BookOpen size={16} />,
};
