import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { type AccessRule } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, mayLeave } from "../router.ts";
import { Menu, AgentAvatar, cx } from "../components/ui.tsx";
import { AccessDialog, folderPaths } from "../components/AccessDialog.tsx";
import { type GraphData, type GraphKind } from "../components/MemoryGraph.tsx";
import { MemoryGraphView } from "./MemoryGraphView.tsx";
import { MemoryHome } from "./MemoryHome.tsx";
import { AboutView } from "./AboutView.tsx";
import { AccessRulesDialog } from "./memory/Access.tsx";
import { StorageDialog } from "./memory/Storage.tsx";
import { NewNoteDialog } from "./memory/NoteDialogs.tsx";
import { NoteView } from "./memory/NoteView.tsx";
import { ActivityFeed, FolderView } from "./memory/Panels.tsx";
import { Sidebar, buildTree, sidebarIcons, type Hit, type NoteMeta } from "./memory/Sidebar.tsx";
import { MemoryDialog, Overline, Cards, PhoneBar, Radio, folderSteps, isNotePath, keepMine, pillPrimary, useFolderLabel, useIsPhone } from "./memory/parts.tsx";

const norm = (s: string) => s.trim().replace(/\.md$/i, "").toLowerCase();
const base = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");

type Panel = { view: "graph"; kind?: GraphKind; select?: string } | { view: "activity" } | { view: "about" } | null;

function snippetHtml(s: string) {
  const esc = s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return esc.replace(/\*\*(.+?)\*\*/g, '<mark class="bg-info/30 text-ink rounded px-0.5">$1</mark>');
}

/**
 * Memory: a folder tree and a note side by side on desktops; pages that take turns on phones.
 * Home, folders, notes (read, edit, history, who wrote what), the graph, activity, About you,
 * who can see what, and where memory is stored.
 */
export function VaultView({ path, onBack }: { path: string | null; onBack?: () => void }) {
  const phone = useIsPhone();
  const label = useFolderLabel();
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [everything, setEverything] = useState<NoteMeta[] | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const searchGeneration = useRef(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [creating, setCreating] = useState<{ dir: string; name?: string } | null>(null);
  const [sharing, setSharing] = useState<{ path: string; folder: boolean } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [pickingAs, setPickingAs] = useState(false);
  // owners can look at memory the way one agent sees it
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [ruled, setRuled] = useState<Set<string>>(new Set());
  // a note just created here opens straight into editing; NoteView remounts per path, so the intent lives here
  const pendingEdit = useRef<string | null>(null);
  const meId = useStore((s) => s.me?.user.id);
  const agents = useStore((s) => s.agents);
  const isOwner = useStore((s) => s.me?.role === "owner");
  // notes changed in Obsidian (or pushed from another computer): reload the list
  const memoryVersion = useStore((s) => s.memoryVersion);
  const asAgent = agents.find((a) => `agent:${a.id}` === viewAs);

  const refresh = useCallback(async () => {
    const as = viewAs ? `?as=${encodeURIComponent(viewAs)}` : "";
    const [list, rules, links, all] = await Promise.all([
      api<NoteMeta[]>("GET", `/api/vault/notes${as}`),
      api<AccessRule[]>("GET", "/api/access/rules").catch(() => []),
      api<GraphData>("GET", `/api/vault/graph${as}`).catch(() => null),
      viewAs ? api<NoteMeta[]>("GET", "/api/vault/notes").catch(() => null) : Promise.resolve(null),
    ]);
    setNotes(list);
    setEverything(all ?? list);
    setGraph(links);
    setRuled(new Set(rules.map((r) => r.path.toLowerCase())));
  }, [viewAs]);
  useEffect(() => {
    refresh();
  }, [refresh, memoryVersion]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => api<Hit[]>("GET", `/api/vault/search?q=${encodeURIComponent(query)}&limit=30`).then((r) => generation === searchGeneration.current && setHits(r), () => {}), 150);
    return () => {
      searchGeneration.current++;
      clearTimeout(t);
    };
    // the list reloads after a note is made, changed or deleted: search again so no stale hit stays
  }, [query, notes]);
  // while viewing as an agent, only show hits it could open
  const visibleHits = useMemo(() => (hits && viewAs && notes ? hits.filter((h) => notes.some((n) => n.path === h.path)) : hits), [hits, viewAs, notes]);

  // opening a note from the graph or Activity leaves them
  useEffect(() => {
    setPanel(null);
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

  const where = (p: string) => {
    const dir = p.split("/").slice(0, -1).join("/");
    return dir ? folderSteps(dir).map((s) => label(s)).join(" / ") : "Top folder";
  };
  const openPath = (p: string) => {
    if (p === path) setPanel(null);
    go({ view: "vault", path: p });
  };
  const show = (next: Panel) => mayLeave() && setPanel(next);
  const goHome = () => {
    if (!mayLeave()) return;
    setPanel(null);
    if (path) go({ view: "vault", path: null });
  };
  const isNote = !!path && isNotePath(path);
  const folder = path && !isNote ? path : null;
  const newNoteDir = isNote ? path!.split("/").slice(0, -1).join("/") : folder ? folder : keepMine(meId);
  /** A note that's linked to but not written yet: write it next to the first note that links to it. */
  const writeMissing = (title: string) => {
    const from = graph?.edges.find((e) => e.target === `ghost:${title}`)?.source;
    setCreating({ dir: from ? from.split("/").slice(0, -1).join("/") : newNoteDir, name: title });
  };
  const folders = useMemo(() => (everything ? folderPaths(everything) : []), [everything]);
  const canNew = !viewAs;

  // who a helper can't see: the top folders missing from its list
  const hidden = useMemo(() => {
    if (!viewAs || !notes || !everything) return null;
    const have = new Set(buildTree(notes, meId).map((n) => n.path));
    const gone = buildTree(everything, meId).filter((n) => !n.note && !have.has(n.path));
    return { count: gone.length, names: gone.map((n) => label(n.name)) };
  }, [viewAs, notes, everything, meId, label]); // eslint-disable-line react-hooks/exhaustive-deps

  const links = [
    { key: "graph", label: "Graph", icon: sidebarIcons.graph, onClick: () => show({ view: "graph" }) },
    { key: "activity", label: "Recent changes", icon: sidebarIcons.activity, onClick: () => show({ view: "activity" }) },
    { key: "access", label: "Who can see and edit what", icon: sidebarIcons.access, onClick: () => setRulesOpen(true) },
    { key: "about", label: "About you", icon: sidebarIcons.about, onClick: () => show({ view: "about" }) },
    { key: "storage", label: "Obsidian and storage", icon: sidebarIcons.storage, onClick: () => setStorageOpen(true) },
  ];
  const moreMenu = (
    <Menu
      align="right"
      trigger={(_o, toggle) => (
        <button onClick={toggle} className="circle" aria-haspopup="menu" aria-label="More in Memory" title="More">
          <MoreHorizontal size={20} />
        </button>
      )}
      items={[
        { label: "Refresh", icon: <RefreshCw size={16} />, onSelect: () => api("POST", "/api/vault/sync").then(refresh) },
        "divider",
        ...links.map((l) => ({ label: l.label, icon: l.icon, onSelect: l.onClick })),
      ]}
    />
  );
  const newButton = canNew && (
    <button className={cx(pillPrimary, "h-11")} onClick={() => setCreating({ dir: newNoteDir })} title="Write a new note here">
      <Plus size={16} /> New note
    </button>
  );
  const asChip = isOwner && agents.length > 0 && (
    <button onClick={() => setPickingAs(true)} className="h-10 px-4 rounded-full border border-control-line bg-control inline-flex items-center gap-2 text-[14px] font-medium">
      <Eye size={15} /> {asAgent ? `View as ${asAgent.name}` : "View as you"}
    </button>
  );

  // ---- what fills the page ------------------------------------------------------------------
  const page = (() => {
    if (panel?.view === "activity") return <ActivityFeed onOpen={openPath} onBack={() => setPanel(null)} />;
    if (panel?.view === "about") return <AboutView embedded onBack={phone ? () => setPanel(null) : undefined} />;
    if (panel?.view === "graph")
      return (
        <div className="h-full flex flex-col min-h-0">
          {phone && <PhoneBar title="Graph" onBack={() => setPanel(null)} trailing={moreMenu} />}
          <div className="flex-1 min-h-0">
            <MemoryGraphView key={`${viewAs}:${panel.kind ?? ""}:${panel.select ?? ""}`} graph={graph} initialKind={panel.kind} initialSelect={panel.select} where={where} onOpen={openPath} onWrite={viewAs ? undefined : writeMissing} />
          </div>
        </div>
      );
    if (isNote)
      return (
        <NoteView
          key={path}
          path={path!}
          pendingEdit={pendingEdit}
          resolve={resolve}
          graph={graph}
          where={where}
          folders={folders}
          readOnly={!!viewAs}
          onChanged={refresh}
          onShare={() => setSharing({ path: path!, folder: false })}
          onGraph={(p) => show({ view: "graph", select: p })}
          onStorage={() => setStorageOpen(true)}
          onBack={() => go({ view: "vault", path: path!.split("/").slice(0, -1).join("/") || null })}
          onOpenFolder={(d) => go({ view: "vault", path: d })}
        />
      );
    if (folder)
      return <FolderView path={folder} notes={notes ?? []} onOpen={openPath} onFolder={(p) => go({ view: "vault", path: p })} onNew={() => setCreating({ dir: folder })} onBack={() => go({ view: "vault", path: null })} canNew={canNew} />;
    return (
      <div className="h-full flex flex-col min-h-0">
        {phone && <PhoneBar title="Memory" onBack={onBack ?? (() => go({ view: "more" }))} trailing={moreMenu} />}
        <div className="flex-1 min-h-0">
          <MemoryHome
            graph={graph}
            notes={notes}
            hiddenFolders={hidden ? { count: hidden.count, name: asAgent?.name ?? "this helper" } : null}
            where={where}
            snippetHtml={snippetHtml}
            onOpen={openPath}
            onFolder={(p) => go({ view: "vault", path: p })}
            onGraph={(kind) => show({ view: "graph", kind })}
            onActivity={() => show({ view: "activity" })}
            onNew={canNew ? () => setCreating({ dir: newNoteDir }) : undefined}
            viewAs={asChip || undefined}
            actions={
              <>
                {newButton}
                {moreMenu}
              </>
            }
          />
        </div>
      </div>
    );
  })();

  const sideActive = panel?.view === "graph" ? "graph" : panel?.view === "activity" ? "activity" : panel?.view === "about" ? "about" : null;

  return (
    <div className="flex-1 min-h-0 flex">
      {!phone && (
        <Sidebar
          notes={notes}
          query={query}
          setQuery={setQuery}
          hits={visibleHits}
          snippetHtml={snippetHtml}
          active={isNote ? path : folder}
          onOpen={openPath}
          onFolder={(p) => go({ view: "vault", path: p })}
          onShare={(dir) => setSharing({ path: dir, folder: true })}
          ruled={ruled}
          onNew={() => setCreating({ dir: newNoteDir })}
          canNew={canNew}
          viewAs={viewAs}
          setViewAs={setViewAs}
          canViewAs={isOwner && agents.length > 0}
          panel={sideActive}
          links={links}
        />
      )}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col" aria-label="Memory">
        {viewAs && asAgent && (
          <div role="status" className="mx-4 md:mx-6 mt-3 rounded-2xl bg-info/20 px-4 py-2.5 text-sm flex items-center gap-3">
            <AgentAvatar agent={asAgent} size={22} interactive={false} />
            <span className="flex-1 min-w-0">
              Viewing as <b>@{asAgent.handle}</b>. Only the notes it can read are listed.{hidden && hidden.names.length > 0 ? ` ${hidden.names.slice(0, 3).join(" and ")} ${hidden.names.length === 1 ? "is" : "are"} hidden.` : ""}
            </span>
            <button className={cx(pillPrimary, "h-9 px-4")} onClick={() => setViewAs(null)}>
              Stop
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0">{page}</div>
      </section>

      {creating !== null && (
        <NewNoteDialog
          initial={creating.dir}
          initialName={creating.name}
          folders={folders}
          onClose={() => setCreating(null)}
          onCreated={async (p, hasBody) => {
            setCreating(null);
            await refresh();
            if (!hasBody) pendingEdit.current = p;
            openPath(p);
          }}
        />
      )}
      {sharing && <AccessDialog path={sharing.path} folder={sharing.folder} onClose={() => setSharing(null)} onChanged={refresh} />}
      {rulesOpen && <AccessRulesDialog onClose={() => setRulesOpen(false)} />}
      {storageOpen && <StorageDialog onClose={() => setStorageOpen(false)} />}
      {pickingAs && <ViewAsDialog viewAs={viewAs} total={everything?.length ?? 0} visible={notes?.length ?? 0} hiddenNames={hidden?.names ?? []} onClose={() => setPickingAs(false)} onPick={(v) => (setViewAs(v), setPickingAs(false))} />}
    </div>
  );
}

/** Phones: pick a helper to see memory as; shows how many notes it can read once chosen. */
function ViewAsDialog({ viewAs, total, visible, hiddenNames, onClose, onPick }: { viewAs: string | null; total: number; visible: number; hiddenNames: string[]; onClose: () => void; onPick: (v: string | null) => void }) {
  const agents = useStore((s) => s.agents);
  const [sel, setSel] = useState<string | null>(viewAs);
  const picked = agents.find((a) => `agent:${a.id}` === sel);
  return (
    <MemoryDialog
      title="View memory as"
      onClose={onClose}
      footer={
        <button className={cx(pillPrimary, "h-12 px-6")} onClick={() => onPick(sel)}>
          <Eye size={17} /> {picked ? `View as ${picked.name}` : "View as you"}
        </button>
      }
    >
      <Overline>Helper</Overline>
      <Cards>
        <button onClick={() => setSel(null)} className="w-full min-h-12 px-4 flex items-center gap-3 text-left hover:bg-hover/60">
          <span className="flex-1 text-body">You</span>
          <Radio on={!sel} />
        </button>
        {agents.map((a) => (
          <button key={a.id} onClick={() => setSel(`agent:${a.id}`)} className="w-full min-h-12 px-4 flex items-center gap-3 text-left hover:bg-hover/60">
            <AgentAvatar agent={a} size={30} interactive={false} />
            <span className="flex-1 text-body">{a.name}</span>
            <Radio on={sel === `agent:${a.id}`} />
          </button>
        ))}
      </Cards>
      {picked && sel === viewAs && total > 0 && (
        <>
          <Overline>Result</Overline>
          <div className="rounded-3xl bg-card px-4 py-3.5">
            <p className="font-medium">
              {picked.name} can read {visible} of {total} notes
            </p>
            {hiddenNames.length > 0 && <p className="mt-1 text-sm text-muted">{hiddenNames.join(" and ")} stay hidden.</p>}
          </div>
        </>
      )}
    </MemoryDialog>
  );
}
