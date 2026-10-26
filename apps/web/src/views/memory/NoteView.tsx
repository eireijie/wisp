import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bold, Check, ChevronRight, ExternalLink, FolderInput, Hash, History, Link2, List, Lock, Pencil, PencilLine, Share2, Trash2, X, MoreHorizontal } from "lucide-react";
import { type MemoryLevel } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { go, guardLeaving } from "../../router.ts";
import { renderMarkdown } from "../../markdown.ts";
import { Empty, Menu, cx, timeAgo, agentColor } from "../../components/ui.tsx";
import { MoreOptions } from "../../components/MoreOptions.tsx";
import { MemoryGraph, kindColor, kindLabel, neighbourhood, type GraphData, type GraphKind } from "../../components/MemoryGraph.tsx";
import { obsidianLink, onHubMachine, useMemoryStorage } from "../../obsidian.ts";
import { Cards, Overline, PhoneBar, noteName, baseName, pill, pillPrimary, useFolderLabel, folderSteps, whoIs, useIsPhone } from "./parts.tsx";
import { DeleteDialog, MoveDialog, RenameDialog } from "./NoteDialogs.tsx";

export interface Note {
  path: string;
  title: string;
  tags: string[];
  links: string[];
  updatedAt: number;
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
interface Commit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/** The note's text without its front matter and without a first heading that just repeats the title. */
function bodyOnly(content: string, title: string): string {
  let t = content;
  if (t.startsWith("---")) {
    const end = t.indexOf("\n---", 3);
    if (end >= 0) t = t.slice(end + 4).replace(/^\r?\n/, "");
  }
  const m = t.match(/^\s*#\s+(.+?)\s*\r?\n/);
  if (m && m[1]!.trim().toLowerCase() === title.trim().toLowerCase()) t = t.slice(m[0].length);
  return t;
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

/** Focus the note body with the caret after the last character, once when it appears. */
function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el || el.dataset.focused) return;
  el.dataset.focused = "1";
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

/**
 * A note: read here, with a plain editor for quick fixes (Obsidian is the better place to write).
 * Edit, History (with Restore) and Graph, and the actions behind the ⋯: rename, move, who can see it, Obsidian, delete.
 */
export function NoteView({
  path,
  pendingEdit,
  resolve,
  graph,
  where,
  folders,
  readOnly,
  onChanged,
  onShare,
  onGraph,
  onStorage,
  onBack,
  onOpenFolder,
}: {
  path: string;
  pendingEdit: React.MutableRefObject<string | null>;
  resolve: (t: string, from?: string | null) => string | null;
  graph: GraphData | null;
  where: (p: string) => string;
  folders: string[];
  /** looking at memory as a helper: nothing here can be changed */
  readOnly?: boolean;
  onChanged: () => void;
  onShare: () => void;
  onGraph: (path: string) => void;
  onStorage: () => void;
  onBack: () => void;
  onOpenFolder: (dir: string) => void;
}) {
  const phone = useIsPhone();
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mode, setMode] = useState<"read" | "authors">("read");
  const [history, setHistory] = useState<Commit[] | null>(null);
  const [blame, setBlame] = useState<BlameBlock[] | null>(null);
  const [viewing, setViewing] = useState<{ commit: Commit; content: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "move" | "delete" | null>(null);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const memoryVersion = useStore((s) => s.memoryVersion);
  const storage = useMemoryStorage();
  const label = useFolderLabel();
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

  // who wrote it and what changed: loaded with the note so "Written by" is true to its first author
  const loadHistory = () => api<Commit[]>("GET", `/api/vault/history?path=${encodeURIComponent(path)}`).then(setHistory, () => setHistory([]));
  useEffect(() => {
    setHistory(null);
    setBlame(null);
    loadHistory();
  }, [path, note?.editedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode === "authors") api<BlameBlock[]>("GET", `/api/vault/blame?path=${encodeURIComponent(path)}`).then(setBlame, () => setBlame([]));
  }, [mode, path, note?.editedAt]);

  const title = note?.title || noteName(path);
  const html = useMemo(() => renderMarkdown(bodyOnly(viewing?.content ?? note?.content ?? "", title), { known: (t) => !!resolve(t, path), handles, stripFrontmatter: true }), [note, viewing, resolve, path, handles, title]);

  const dirty = !!note && draft !== null && draft !== note.content;
  // edits aren't lost to a stray click: leaving the note asks first
  useEffect(() => {
    if (!dirty) return;
    const unguard = guardLeaving(() => `${baseName(path)} has unsaved changes. Leave without saving them?`);
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

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
    if (!a) return;
    e.preventDefault();
    const found = resolve(a.dataset.wikilink!, path);
    if (found) go({ view: "vault", path: found });
  };

  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);
  const linkedFrom = graph && note ? note.backlinks.filter((p) => byId.has(p)).map((p) => byId.get(p)!) : [];
  const linksTo = (graph?.edges ?? []).filter((e) => e.source === path && !(note?.backlinks ?? []).includes(e.target)).map((e) => byId.get(e.target)!).filter(Boolean);

  if (error)
    return (
      <div className="h-full flex flex-col">
        {phone && <PhoneBar title="Note" onBack={onBack} />}
        <Empty icon={<BookOpen />} title="Can't open this note">
          {error}
        </Empty>
      </div>
    );
  if (!note) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const canEdit = !readOnly && (note.access === "edit" || note.access === "manage");
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      if (draft !== note.content) await api("PUT", "/api/vault/note", { path, content: draft });
      setNote({ ...note, content: draft });
      setDraft(null);
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const restore = async (c: Commit) => {
    try {
      const old = await api<{ content: string }>("GET", `/api/vault/at?path=${encodeURIComponent(path)}&rev=${c.hash}`);
      await api("PUT", "/api/vault/note", { path, content: old.content, message: `Restore the version from ${new Date(c.date).toLocaleString()}` });
      setViewing(null);
      onChanged();
      const fresh = await api<Note>("GET", `/api/vault/note?path=${encodeURIComponent(path)}`);
      setNote(fresh);
      loadHistory();
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const openObsidian = () => {
    if (storage?.path && onHubMachine()) window.location.href = obsidianLink(storage.path, path);
    else onStorage();
  };

  const first = history && history.length ? history[history.length - 1]! : null;
  const author = first?.author ?? note.editedBy;
  const w = author ? whoIs(author, agents, members, 22) : null;
  const type = typeof note.frontmatter?.type === "string" ? note.frontmatter.type : null;
  const kind = graph?.nodes.find((n) => n.id === path)?.kind ?? null;
  const tags = note.tags ?? [];
  const steps = folderSteps(path.split("/").slice(0, -1).join("/"));
  const crumbs = steps.map((s, i) => ({ text: label(s), path: steps.slice(0, i + 1).join("/") }));
  const menu = (
    <Menu
      align="right"
      trigger={(_o, toggle) => (
        <button onClick={toggle} className="circle" aria-haspopup="menu" aria-label="Note actions" title="Note actions">
          <MoreHorizontal size={20} />
        </button>
      )}
      items={[
        ...(canEdit ? [{ label: "Rename", icon: <PencilLine size={17} />, onSelect: () => setDialog("rename") }, { label: "Move to another folder", icon: <FolderInput size={17} />, onSelect: () => setDialog("move") }] : []),
        { label: "Who can see this note", icon: <Lock size={17} />, onSelect: onShare },
        { label: "Open in Obsidian", icon: <ExternalLink size={17} />, onSelect: openObsidian },
        ...(canEdit ? ["divider" as const, { label: "Delete note", icon: <Trash2 size={17} />, danger: true, onSelect: () => setDialog("delete") }] : []),
      ]}
    />
  );

  // ---- editing --------------------------------------------------------------------------
  if (draft !== null) {
    return (
      <Editor
        path={path}
        draft={draft}
        setDraft={setDraft}
        saving={saving}
        dirty={dirty}
        phone={phone}
        where={where(path)}
        onSave={save}
        onCancel={() => setDraft(null)}
      />
    );
  }

  const historyList = (
    <HistoryList history={history} viewing={viewing} canEdit={canEdit} onView={async (c, current) => (current ? setViewing(null) : setViewing({ commit: c, content: (await api<{ content: string }>("GET", `/api/vault/at?path=${encodeURIComponent(path)}&rev=${c.hash}`)).content }))} onRestore={restore} />
  );

  const dialogs = (
    <>
      {dialog === "rename" && (
        <RenameDialog
          path={path}
          onClose={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            onChanged();
            go({ view: "vault", path: to });
          }}
        />
      )}
      {dialog === "move" && (
        <MoveDialog
          path={path}
          folders={folders}
          onClose={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            onChanged();
            go({ view: "vault", path: to });
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog
          path={path}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onChanged();
            go({ view: "vault", path: path.split("/").slice(0, -1).join("/") || null });
          }}
        />
      )}
    </>
  );

  // phones: History is a page of its own, with "Who wrote what" beside it
  if (phone && historyOpen) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <PhoneBar title={mode === "authors" ? "Who wrote what" : "History"} onBack={() => (setHistoryOpen(false), setViewing(null))} trailing={menu} />
        <div className="flex-1 overflow-y-auto px-4 pb-28">
          <Segmented mode={mode} setMode={setMode} labels={["History", "Who wrote what"]} />
          <p className="mt-3 px-1 text-[13px] text-muted">{baseName(path)}</p>
          <div className="mt-2">{mode === "authors" ? <Blame blocks={blame} /> : historyList}</div>
          {viewing && mode !== "authors" && (
            <div className="mt-4">
              <div className="rounded-2xl bg-info/15 px-4 py-2.5 text-sm">Viewing the version from {new Date(viewing.commit.date).toLocaleString()} by {whoIs(viewing.commit.author, agents, members).name}</div>
              <div onClick={onClick} className="prose-w mt-3 text-[16px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
        {dialogs}
      </div>
    );
  }

  const actions = (
    <>
      {canEdit && !viewing && (
        <button className={pill} onClick={() => setDraft(note.content)} title="Edit this note here">
          <Pencil size={15} /> Edit
        </button>
      )}
      <button className={cx(pill, historyOpen && "bg-card")} onClick={() => (setHistoryOpen(!historyOpen), setViewing(null))} aria-pressed={historyOpen}>
        <History size={15} /> {historyOpen ? "Hide history" : "History"}
      </button>
      {!historyOpen && (
        <button className={pill} onClick={() => onGraph(path)}>
          <Share2 size={15} /> Graph
        </button>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {phone ? (
        <PhoneBar title="Note" onBack={onBack} trailing={menu} />
      ) : (
        <div className="shrink-0 h-[72px] px-6 flex items-center gap-2">
          <nav className="flex-1 min-w-0 flex items-center gap-1.5 text-[14px] text-muted overflow-hidden whitespace-nowrap" aria-label="Where this note is">
            {crumbs.map((c) => (
              <span key={c.path} className="flex items-center gap-1.5 min-w-0 shrink-[100]">
                <button onClick={() => onOpenFolder(c.path)} className="truncate hover:text-ink">
                  {c.text}
                </button>
                <ChevronRight size={13} className="text-faint shrink-0" />
              </span>
            ))}
            <span className="text-ink font-semibold truncate">{baseName(path)}</span>
          </nav>
          {actions}
          {menu}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className={cx("mx-auto px-4 md:px-6 pt-2 pb-36 md:pb-12", historyOpen ? "max-w-[560px]" : "max-w-[640px]")}>
            {phone && <p className="px-1 text-[13px] text-muted">{crumbs.map((c) => c.text).join(" / ")}</p>}
            <h2 className="mt-1 text-[30px] md:text-[34px] leading-tight font-bold tracking-tight break-words">{title}</h2>
            <p className="mt-3 px-0.5 flex items-center gap-2 text-[14px] text-muted flex-wrap">
              {w && w.avatar}
              <span>
                {w ? `Written by ${w.name}` : "Not saved yet"}
                {note.editedAt ? ` · edited ${timeAgo(note.editedAt)}` : ""}
              </span>
            </p>
            {(type || tags.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {type && (
                  <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-info/20 text-[13px] font-semibold text-info capitalize">
                    {kind && <span className="size-2 rounded-full" style={{ background: kindColor(kind) }} title={kindLabel(kind)} />}
                    {type}
                  </span>
                )}
                {tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-chip text-[13px] font-medium text-ink/85">
                    <Hash size={12} className="text-muted" /> {t}
                  </span>
                ))}
              </div>
            )}

            {viewing && (
              <div className="mt-4 rounded-2xl bg-info/15 px-4 py-2.5 text-sm flex items-center gap-2">
                <span className="flex-1">
                  Viewing the version from {new Date(viewing.commit.date).toLocaleString()} by {whoIs(viewing.commit.author, agents, members).name}
                </span>
                <button className="font-medium underline underline-offset-2" onClick={() => setViewing(null)}>
                  Back to current
                </button>
              </div>
            )}

            {!phone && !historyOpen ? null : null}
            {mode === "authors" && !phone && historyOpen ? (
              <div className="mt-4">
                <Segmented mode={mode} setMode={setMode} labels={["Read", "Who wrote what"]} />
                <div className="mt-3">
                  <Blame blocks={blame} />
                </div>
              </div>
            ) : (
              <>
                {!phone && historyOpen && (
                  <div className="mt-4">
                    <Segmented mode={mode} setMode={setMode} labels={["Read", "Who wrote what"]} />
                  </div>
                )}
                <div className="mt-4 rounded-3xl md:rounded-none bg-card md:bg-transparent px-5 py-4 md:p-0">
                  <div onClick={onClick} className="prose-w text-[16px] md:text-[15.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              </>
            )}

            {linkedFrom.length > 0 && (
              <section>
                <Overline>Linked from</Overline>
                <NoteLinks items={linkedFrom} where={where} phone={phone} />
              </section>
            )}
            {linksTo.length > 0 && (
              <section>
                <Overline>Links to</Overline>
                <NoteLinks items={linksTo} where={where} phone={phone} />
              </section>
            )}
            <MoreOptions className="mt-6" about="properties and a map of connected notes">
              <Connected path={path} graph={graph} frontmatter={note.frontmatter ?? {}} resolve={(t) => resolve(t, path)} />
            </MoreOptions>
          </div>
        </div>
        {!phone && historyOpen && (
          <aside className="w-[340px] shrink-0 border-l border-line overflow-y-auto px-5 pb-8" aria-label="History">
            <div className="h-16 flex items-center">
              <h3 className="flex-1 text-[19px] font-bold tracking-tight">History</h3>
              <button onClick={() => (setHistoryOpen(false), setViewing(null), setMode("read"))} className="circle circle-sm" aria-label="Close history">
                <X size={16} />
              </button>
            </div>
            {historyList}
          </aside>
        )}
      </div>
      {phone && (
        <div className="fixed inset-x-0 bottom-0 z-20 px-3 pb-8 flex justify-center gap-2 pointer-events-none">
          <div className="pointer-events-auto flex gap-2">{actions}</div>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function Segmented({ mode, setMode, labels }: { mode: "read" | "authors"; setMode: (m: "read" | "authors") => void; labels: [string, string] }) {
  return (
    <div role="tablist" className="p-1 rounded-full bg-card flex gap-1">
      {(["read", "authors"] as const).map((m, i) => (
        <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cx("flex-1 h-10 rounded-full text-[14px] font-semibold transition-colors", mode === m ? "bg-control text-ink shadow-sm border border-control-line" : "text-muted hover:text-ink")}>
          {labels[i]}
        </button>
      ))}
    </div>
  );
}

function HistoryList({ history, viewing, canEdit, onView, onRestore }: { history: Commit[] | null; viewing: { commit: Commit } | null; canEdit: boolean; onView: (c: Commit, current: boolean) => void; onRestore: (c: Commit) => void }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  if (!history) return <p className="text-sm text-muted px-1">Loading…</p>;
  if (!history.length) return <p className="text-sm text-muted px-1">Not saved yet.</p>;
  return (
    <>
      <Cards>
        {history.map((c, i) => {
          const w = whoIs(c.author, agents, members, 34);
          const on = viewing?.commit.hash === c.hash;
          return (
            <div key={c.hash} className={cx("flex items-center gap-3 px-4 py-3", on && "bg-hover")}>
              {w.avatar}
              <button onClick={() => onView(c, i === 0)} className="flex-1 min-w-0 text-left" title="See this version">
                <span className="block truncate text-[15px] font-semibold">{c.message}</span>
                <span className="block text-xs text-muted">
                  {w.name} · {timeAgo(c.date)}
                </span>
              </button>
              {i === 0 ? (
                <span className="h-8 px-3 rounded-full bg-info/25 text-info text-[13px] font-semibold inline-flex items-center">Current</span>
              ) : (
                canEdit && (
                  <button onClick={() => confirm("Bring this version back as a new change? Nothing is lost.") && onRestore(c)} className="h-8 px-3.5 rounded-full border border-control-line bg-control text-[13px] font-semibold hover:bg-hover">
                    Restore
                  </button>
                )
              )}
            </div>
          );
        })}
      </Cards>
      <p className="mt-3 px-1 text-xs text-muted leading-relaxed">Restoring brings back that version as a new change. Nothing is lost.</p>
    </>
  );
}

/** Who wrote what: every stretch of the note beside the person or helper who wrote it. */
function Blame({ blocks }: { blocks: BlameBlock[] | null }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  if (!blocks) return <p className="text-sm text-muted px-1">Loading…</p>;
  const shown = withoutFrontmatter(blocks).filter((b) => b.lines.some((l) => l.trim()));
  if (!shown.length) return <p className="text-sm text-muted px-1">Not saved yet.</p>;
  const tone = (author: string) => {
    const w = whoIs(author, agents, members);
    return w.agent ? agentColor(w.agent) : "var(--faint)";
  };
  const authors = [...new Set(shown.map((b) => b.author))];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-3 px-1 text-[13px] text-muted">
        {authors.map((a) => (
          <span key={a} className="inline-flex items-center gap-1.5">
            {whoIs(a, agents, members, 18).avatar}
            {whoIs(a, agents, members).name}
          </span>
        ))}
      </div>
      <div className="rounded-3xl bg-card overflow-hidden">
        {shown.map((b, i) => {
          const w = whoIs(b.author, agents, members, 18);
          return (
            <div key={i} className="flex gap-3 py-2.5 pr-4 border-l-[3px]" style={{ borderColor: tone(b.author) }}>
              <div className="w-24 shrink-0 pl-3 pt-0.5 flex items-start gap-1.5 text-xs text-muted" title={`${w.name} · ${timeAgo(b.date)}`}>
                {w.avatar}
                <span className="truncate">{w.name}</span>
              </div>
              <div className="flex-1 min-w-0 text-[14px] whitespace-pre-wrap break-words">{b.lines.join("\n").trim()}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NoteLinks({ items, where, phone }: { items: { id: string; path: string | null; title: string; kind: GraphKind }[]; where: (p: string) => string; phone: boolean }) {
  const open = (p: string | null) => p && go({ view: "vault", path: p });
  const sub = (n: { path: string | null; kind: GraphKind }) => (n.path ? where(n.path) : kindLabel("ghost").toLowerCase());
  if (phone)
    return (
      <Cards>
        {items.map((n) => (
          <button key={n.id} disabled={!n.path} onClick={() => open(n.path)} className="w-full text-left px-4 min-h-14 flex items-center gap-3 hover:bg-hover/60">
            <Link2 size={19} strokeWidth={1.7} className="text-muted shrink-0" />
            <span className="flex-1 truncate text-[16px]">{n.title}</span>
            <span className="text-muted text-[15px] truncate max-w-[40%]">{sub(n)}</span>
            <ChevronRight size={16} className="text-faint" />
          </button>
        ))}
      </Cards>
    );
  return (
    <div className="grid grid-cols-2 xl:grid-cols-3 gap-2.5">
      {items.map((n) => (
        <button key={n.id} disabled={!n.path} onClick={() => open(n.path)} className="text-left rounded-3xl bg-card px-4 py-3 hover:bg-hover/60 transition-colors min-w-0">
          <span className="block font-semibold text-[14px] truncate">{n.title}</span>
          <span className="block text-xs text-muted truncate">{sub(n)}</span>
        </button>
      ))}
    </div>
  );
}

/** The note's front matter as properties, and a small map of the notes it's linked with. */
function Connected({ path, graph, frontmatter, resolve }: { path: string; graph: GraphData | null; frontmatter: Record<string, string | string[]>; resolve: (t: string) => string | null }) {
  const local = useMemo(() => {
    if (!graph) return null;
    const one = neighbourhood(graph, path, 1);
    const two = one.nodes.length < 4 ? neighbourhood(graph, path, 2) : one;
    return two.nodes.length <= 12 ? two : one;
  }, [graph, path]);
  const entries = Object.entries(frontmatter).filter(([k, v]) => !["title", "type", "tags"].includes(k) && (Array.isArray(v) ? v.length : v !== ""));
  const value = (v: string) => {
    const link = v.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
    if (!link) return <span className="break-words">{v}</span>;
    const to = resolve(link[1]!);
    return to ? (
      <button onClick={() => go({ view: "vault", path: to })} className="text-accent-text underline underline-offset-2">
        {link[2] ?? link[1]}
      </button>
    ) : (
      <span className="text-muted">{link[2] ?? link[1]}</span>
    );
  };
  const nice = (k: string) => k.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="space-y-4">
      {entries.length > 0 && (
        <dl className="rounded-3xl bg-card px-4 py-3 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-6 gap-y-2 text-sm" aria-label="Properties">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{nice(k)}</dt>
              <dd className="min-w-0 flex flex-wrap items-center gap-1.5">{Array.isArray(v) ? v.map((x, i) => <span key={i}>{value(x)}</span>) : value(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="relative h-56 rounded-3xl bg-card bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-size-[16px_16px] overflow-hidden">
        {local && local.nodes.length > 1 ? (
          <MemoryGraph graph={local} variant="local" active={path} onOpen={(n) => n.path && go({ view: "vault", path: n.path })} className="absolute inset-0" label={`${local.nodes.length - 1} notes linked with this one`} />
        ) : (
          <p className="absolute inset-0 grid place-items-center p-5 text-center text-xs text-muted">{local ? "Not linked to other notes yet. Write [[Note name]] to link one." : "Loading…"}</p>
        )}
      </div>
    </div>
  );
}

/** The plain editor: Markdown in a card, with a few helpers for bold, lists, links and tags. */
function Editor({ path, draft, setDraft, saving, dirty, phone, where, onSave, onCancel }: { path: string; draft: string; setDraft: (s: string) => void; saving: boolean; dirty: boolean; phone: boolean; where: string; onSave: () => void; onCancel: () => void }) {
  const me = useStore((s) => s.me);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  /** Wrap the selection (or put a marker at the caret) and keep the caret in a useful place. */
  const edit = (before: string, after = "", fallback = "") => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const sel = draft.slice(s, e) || fallback;
    const next = draft.slice(0, s) + before + sel + after + draft.slice(e);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  };
  const lineStart = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const s = draft.lastIndexOf("\n", el.selectionStart - 1) + 1;
    setDraft(draft.slice(0, s) + prefix + draft.slice(s));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(el.selectionStart + prefix.length, el.selectionStart + prefix.length);
    });
  };
  const tools = (
    <div className="flex items-center gap-2" role="toolbar" aria-label="Formatting">
      <button type="button" className="circle circle-sm" aria-label="Bold" title="Bold" onClick={() => edit("**", "**", "bold")}>
        <Bold size={16} />
      </button>
      <button type="button" className="circle circle-sm" aria-label="List" title="List" onClick={() => lineStart("- ")}>
        <List size={16} />
      </button>
      <button type="button" className="circle circle-sm" aria-label="Link to a note" title="Link to a note" onClick={() => edit("[[", "]]", "Note name")}>
        <Link2 size={16} />
      </button>
      <button type="button" className="circle circle-sm" aria-label="Heading" title="Heading" onClick={() => lineStart("## ")}>
        <Hash size={16} />
      </button>
    </div>
  );
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className={cx("shrink-0 flex items-center gap-2", phone ? "px-4 pt-4 pb-2 safe-top" : "h-[72px] px-6")}>
        {phone ? (
          <>
            <button className={pill} onClick={onCancel}>
              Cancel
            </button>
            <h1 className="flex-1 text-center text-[15px] font-semibold truncate">{baseName(path)}</h1>
          </>
        ) : (
          <>
            <nav className="flex-1 min-w-0 text-[14px] text-muted truncate">
              {where} <ChevronRight size={13} className="inline text-faint" /> <span className="text-ink font-semibold">{baseName(path)}</span>
            </nav>
            <button className={pill} onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
        <button className={pillPrimary} onClick={onSave} disabled={saving}>
          <Check size={16} /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-8">
        <div className="mx-auto max-w-[640px]">
          {phone && (
            <p className="mb-2 px-1 text-xs text-muted">
              Editing in {where}. Changes are saved as {me?.user.name ?? "you"}.
            </p>
          )}
          {!phone && <div className="mb-3">{tools}</div>}
          <textarea
            ref={(el) => {
              ref.current = el;
              focusAtEnd(el);
            }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            aria-label="Note text"
            className="w-full h-[min(60vh,560px)] resize-none rounded-3xl bg-card px-5 py-4 font-mono text-[14px] leading-relaxed outline-none focus:ring-3 focus:ring-ring/30"
          />
          {!phone && (
            <p className="mt-2 px-1 text-xs text-muted">
              Saved as {me?.user.name ?? "you"}. {dirty ? "Not saved yet." : "Nothing changed yet."}
            </p>
          )}
        </div>
      </div>
      {phone && <div className="shrink-0 px-4 py-3 bg-card/80 backdrop-blur safe-bottom">{tools}</div>}
    </div>
  );
}
