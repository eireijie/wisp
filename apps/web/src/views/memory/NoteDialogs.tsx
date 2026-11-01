import { useState } from "react";
import { Check, Folder, Trash2 } from "lucide-react";
import { personDir } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { Cards, ConfirmCard, MemoryDialog, Overline, Radio, field, pillPrimary, noteName, useFolderLabel, folderSteps } from "./parts.tsx";
import { cx } from "../../components/ui.tsx";

/** A folder as words: "Shared / projects", "Ghosty's notes / plans". */
export function useFolderWords() {
  const label = useFolderLabel();
  return (dir: string) => (dir ? folderSteps(dir).map((s) => label(s)).join(" / ") : "Top folder");
}

/** Where a new note can go, with who will see it. */
export function useKeepChoices() {
  const agents = useStore((s) => s.agents);
  const meId = useStore((s) => s.me?.user.id);
  return [
    { value: "shared", label: "Shared", hint: "Everyone sees it" },
    ...(meId ? [{ value: personDir(meId), label: "My notes", hint: "Private to you" }] : []),
    ...agents.map((a) => ({ value: `agents/${a.id}`, label: `${a.name}'s notes`, hint: `Private to ${a.name}` })),
  ];
}

/** Pick a folder: the usual places, then any folder that already holds notes, or a new one by name. */
export function FolderChoice({ value, onChange, folders, current, hints = true }: { value: string; onChange: (dir: string) => void; folders: string[]; current?: string; hints?: boolean }) {
  const choices = useKeepChoices();
  const words = useFolderWords();
  const known = new Set(choices.map((c) => c.value));
  const extra = folders.filter((f) => !known.has(f));
  const isOther = !!value && !known.has(value) && !extra.includes(value);
  const [other, setOther] = useState(isOther);
  const rows = [...choices.map((c) => ({ ...c, label: c.label })), ...extra.map((f) => ({ value: f, label: words(f), hint: "" }))];
  return (
    <div>
      <Cards>
        {rows.map((c) => (
          <button key={c.value} type="button" onClick={() => (setOther(false), onChange(c.value))} aria-pressed={value === c.value && !other} className="w-full min-h-12 px-4 py-2 flex items-center gap-3 text-left hover:bg-hover/60">
            <Folder size={19} strokeWidth={1.7} className="text-muted shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-body truncate">{c.label}</span>
              {current === c.value ? <span className="block text-xs text-muted">Current folder</span> : hints && c.hint ? <span className="block text-xs text-muted">{c.hint}</span> : null}
            </span>
            <Radio on={value === c.value && !other} />
          </button>
        ))}
      </Cards>
      <p className="mt-2 px-1 text-xs text-muted">Pick one or type a new name to make a folder.</p>
      {other ? (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="shared/ideas" aria-label="Folder path" className={cx(field, "mt-2")} autoFocus />
      ) : (
        <button type="button" onClick={() => setOther(true)} className="mt-2 px-1 text-body font-medium text-accent-text underline underline-offset-2">
          Other folder…
        </button>
      )}
    </div>
  );
}

const cleanDir = (d: string) => d.trim().replace(/^\/+|\/+$/g, "");

/** A new note: a title, where to keep it, and what to write. */
export function NewNoteDialog({ initial, initialName = "", folders, onClose, onCreated }: { initial: string; initialName?: string; folders: string[]; onClose: () => void; onCreated: (path: string, hasBody: boolean) => void }) {
  const [dir, setDir] = useState(initial);
  const [name, setName] = useState(initialName);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const clean = name.trim().replace(/\.md$/i, "");
    if (!clean) return;
    const folder = cleanDir(dir);
    const p = `${folder ? folder + "/" : ""}${clean}.md`;
    setBusy(true);
    try {
      await api("PUT", "/api/vault/note", { path: p, content: `# ${noteName(clean)}\n\n${body.trim() ? body.trim() + "\n" : ""}`, message: `Create ${p}` });
      onCreated(p, !!body.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <MemoryDialog
      title="New note"
      onClose={onClose}
      footer={
        <button form="new-note" className={cx(pillPrimary, "h-12 px-7")} disabled={!name.trim() || busy}>
          <Check size={17} /> Create
        </button>
      }
    >
      <form
        id="new-note"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Overline>Title</Overline>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting notes" aria-label="Title" required autoFocus className={field} />
        <Overline>Where to keep it</Overline>
        <FolderChoice value={dir} onChange={setDir} folders={folders} />
        <Overline>Note</Overline>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write something your agents should remember…" aria-label="Note" rows={5} className="w-full rounded-3xl border border-control-line bg-control px-4 py-3 text-body outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30 resize-none" />
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      </form>
    </MemoryDialog>
  );
}

/** Give a note another name, in the same folder. */
export function RenameDialog({ path, onClose, onDone }: { path: string; onClose: () => void; onDone: (to: string) => void }) {
  const [name, setName] = useState(noteName(path));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dir = path.split("/").slice(0, -1).join("/");
  const go = async () => {
    const clean = name.trim().replace(/\.md$/i, "");
    if (!clean) return;
    const to = `${dir ? dir + "/" : ""}${clean}.md`;
    if (to === path) return onClose();
    setBusy(true);
    try {
      await api("POST", "/api/vault/move", { from: path, to });
      onDone(to);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <MemoryDialog
      title="Rename note"
      onClose={onClose}
      footer={
        <button form="rename-note" className={cx(pillPrimary, "h-12 px-7")} disabled={!name.trim() || busy}>
          <Check size={17} /> Rename
        </button>
      }
    >
      <form
        id="rename-note"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <p className="text-sm text-muted mb-3">{path}</p>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="New name" required autoFocus className={field} />
        <p className="mt-2 px-1 text-xs text-muted">Links written as [[{noteName(path)}]] in other notes need the new name too.</p>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      </form>
    </MemoryDialog>
  );
}

/** Move a note to another folder. */
export function MoveDialog({ path, folders, onClose, onDone }: { path: string; folders: string[]; onClose: () => void; onDone: (to: string) => void }) {
  const here = path.split("/").slice(0, -1).join("/");
  const [dir, setDir] = useState(here);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const folder = cleanDir(dir);
    const to = `${folder ? folder + "/" : ""}${path.split("/").pop()}`;
    if (to === path) return onClose();
    setBusy(true);
    try {
      await api("POST", "/api/vault/move", { from: path, to });
      onDone(to);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <MemoryDialog
      title="Move note"
      onClose={onClose}
      footer={
        <button onClick={go} className={cx(pillPrimary, "h-12 px-7")} disabled={busy}>
          <Check size={17} /> Move here
        </button>
      }
    >
      <p className="text-sm text-muted">{path.split("/").pop()}</p>
      <Overline>Move to</Overline>
      <FolderChoice value={dir} onChange={setDir} folders={folders} current={here} hints={false} />
      <p className="mt-3 px-1 text-xs text-muted">Who can see the note changes with the folder it lands in.</p>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </MemoryDialog>
  );
}

/** Are you sure? Deleting keeps the note in history. */
export function DeleteDialog({ path, onClose, onDone }: { path: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmCard
      icon={<Trash2 size={22} />}
      title="Delete this note?"
      action="Delete note"
      busy={busy}
      onClose={onClose}
      onAction={async () => {
        setBusy(true);
        try {
          await api("DELETE", `/api/vault/note?path=${encodeURIComponent(path)}`);
          onDone();
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
    >
      <p>
        {path.split("/").pop()} will be removed from memory. Anything that links to it will point nowhere. It stays recoverable in git history.
      </p>
      {error && <p className="mt-2 text-bad">{error}</p>}
    </ConfirmCard>
  );
}

