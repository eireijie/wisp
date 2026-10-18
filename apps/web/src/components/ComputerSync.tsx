import { useEffect, useRef, useState } from "react";
import { ArrowUp, ClipboardCopy, Download, ExternalLink, File, Folder, FolderPlus, Home, Loader2, RefreshCw, Send, Upload, X } from "lucide-react";
import { MAX_TRANSFER_BYTES, type FolderListing } from "@warren/core";
import { api, getToken, ApiError } from "../api.ts";
import type { ComputerInfo } from "../store.ts";
import type { DeviceInfo } from "../devices.ts";
import { Button, Textarea, cx } from "./ui.tsx";

/**
 * Keeping a computer in step with the device you're on: its clipboard, its files, and what you
 * drop on its screen. Used by the computer's desk (ComputersView).
 */

export type RemotePlatform = "mac" | "windows" | "linux";

/** What the computer runs, for its keyboard shortcuts: VMs and cloud computers are Linux. */
export function remotePlatform(c: ComputerInfo, devices: DeviceInfo[] | null): RemotePlatform {
  if (c.kind !== "device") return "linux";
  const p = devices?.find((d) => d.id === c.nodeId)?.capabilities?.platform;
  return p === "darwin" ? "mac" : p === "win32" ? "windows" : "linux";
}

/** The computer's own shortcut for copy, cut or paste: ⌘ on a Mac, Ctrl elsewhere (Shift kept, for terminals). */
export function shortcutFor(platform: RemotePlatform, key: "c" | "x" | "v", shift = false): string {
  return [platform === "mac" ? "cmd" : "ctrl", shift && "shift", key].filter(Boolean).join("+");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Send files to a folder on the computer, one at a time; returns where each went. */
export async function sendFiles(computerId: string, folder: string, files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (f.size > MAX_TRANSFER_BYTES) throw new Error(`${f.name} is bigger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB`);
    const r = await api<{ path: string }>("POST", `/api/computers/${computerId}/files?folder=${encodeURIComponent(folder)}`, undefined, {
      raw: f,
      headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(f.name) },
    });
    out.push(r.path);
  }
  return out;
}

/** Save a blob on this device under `name`. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function authedBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? res.statusText, res.status);
  }
  return res.blob();
}

/** Download a file from the computer to this device. */
export async function downloadFile(computerId: string, path: string) {
  const name = path.split(/[/\\]/).pop() || "file";
  saveBlob(await authedBlob(`/api/computers/${computerId}/files/download?path=${encodeURIComponent(path)}`), name);
}

/** Save what the screen shows right now to this device. */
export async function saveScreenshot(c: ComputerInfo) {
  const blob = await authedBlob(`/api/computers/${c.id}/screen?maxAge=1000`);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
  saveBlob(blob, `${c.name} ${stamp}.jpg`);
}

// --- copy and paste while you're in control ------------------------------------------------------------

const SYNC_KEY = "warren.clipboardSync";

export function clipboardSyncOn(): boolean {
  try {
    return localStorage.getItem(SYNC_KEY) !== "off";
  } catch {
    return true;
  }
}

function setClipboardSync(on: boolean) {
  try {
    localStorage.setItem(SYNC_KEY, on ? "on" : "off");
  } catch {}
}

/** What's on this device's clipboard, from the paste the browser is about to do (no permission needed), or by asking. */
function localPaste(): Promise<string | null> {
  return new Promise((resolve) => {
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      clearTimeout(timer);
      resolve(e.clipboardData?.getData("text/plain") ?? null);
    };
    const timer = setTimeout(() => {
      document.removeEventListener("paste", onPaste, true);
      navigator.clipboard?.readText().then(resolve, () => resolve(null)) ?? resolve(null);
    }, 200);
    document.addEventListener("paste", onPaste, { capture: true, once: true });
  });
}

/**
 * While you're in control, copy and paste work across: ⌘/Ctrl+V pastes what you copied on this
 * device, and ⌘/Ctrl+C or X on the computer puts its copy on this device's clipboard too. The
 * shortcut is sent as the computer's own (⌘ on a Mac, Ctrl elsewhere) whichever device you're on.
 */
export function useClipboardSync(c: ComputerInfo, active: boolean, platform: RemotePlatform) {
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** the text we last put on, or saw on, the computer's clipboard */
  const known = useRef<string | null>(null);
  const flash = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2600);
  };
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);

  const press = (keys: string) => api("POST", `/api/computers/${c.id}/act`, { action: { action: "key", keys } });

  const paste = async (keys: string) => {
    const text = await localPaste();
    try {
      if (text && text !== known.current) {
        await api("PUT", `/api/computers/${c.id}/clipboard`, { text });
        known.current = text;
        flash("Pasted from this device");
      }
      await press(keys);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const copy = async (keys: string) => {
    try {
      await press(keys);
      await new Promise((r) => setTimeout(r, 350));
      const { text } = await api<{ text: string }>("GET", `/api/computers/${c.id}/clipboard`);
      if (!text || text === known.current) return;
      known.current = text;
      await navigator.clipboard.writeText(text);
      flash("Copied to this device too");
    } catch {
      // the copy still happened on the computer; this device's clipboard just didn't get it
    }
  };

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!active || !clipboardSyncOn() || e.altKey || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== "c" && k !== "x" && k !== "v") return;
    // this shortcut doesn't reach the screen as it is: the computer gets its own once the clipboard is ready
    e.stopPropagation();
    const keys = shortcutFor(platform, k, e.shiftKey);
    if (k === "v") void paste(keys); // the browser's own paste goes ahead, so localPaste can read it
    else {
      e.preventDefault();
      void copy(keys);
    }
  };

  return { onKeyDownCapture, note, flash };
}

// --- panels ---------------------------------------------------------------------------------------------

function PanelHead({ title, onClose, children }: { title: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <h3 className="font-semibold text-sm flex-1 truncate">{title}</h3>
      {children}
      <button onClick={onClose} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}

const isUrl = (t: string) => /^https?:\/\/\S+$/i.test(t.trim());

/** The computer's clipboard, next to yours. */
export function ClipboardPanel({ computer: c, mine, platform, onClose }: { computer: ComputerInfo; mine: boolean; platform: RemotePlatform; onClose: () => void }) {
  const [remote, setRemote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sync, setSync] = useState(clipboardSyncOn);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setRemote((await api<{ text: string }>("GET", `/api/computers/${c.id}/clipboard`)).text);
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [c.id]);

  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setMsg(null);
    try {
      setMsg({ text: await fn() });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  };
  const send = () =>
    run("send", async () => {
      await api("PUT", `/api/computers/${c.id}/clipboard`, { text: draft });
      setRemote(draft);
      return `It's on ${c.name}'s clipboard`;
    });
  const sendAndPaste = () =>
    run("paste", async () => {
      await api("PUT", `/api/computers/${c.id}/clipboard`, { text: draft });
      setRemote(draft);
      await api("POST", `/api/computers/${c.id}/act`, { action: { action: "key", keys: shortcutFor(platform, "v") } });
      return `Pasted into ${c.name}`;
    });
  const openLink = () =>
    run("open", async () => {
      await api("POST", `/api/computers/${c.id}/act`, { action: { action: "open", target: draft.trim() } });
      return `Opened on ${c.name}`;
    });
  const copyHere = () =>
    run("copy", async () => {
      await navigator.clipboard.writeText(remote ?? "");
      return "Copied to this device";
    });
  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

  return (
    <div className="space-y-4">
      <PanelHead title="Clipboard" onClose={onClose} />
      <section className="space-y-2">
        <div className="flex items-center gap-1">
          <h4 className="text-xs font-medium text-muted flex-1">On {c.name}</h4>
          <button onClick={load} disabled={loading} className="p-1 rounded-md hover:bg-hover text-muted" aria-label="Refresh" title="Refresh">
            <RefreshCw size={13} className={cx(loading && "animate-spin")} />
          </button>
        </div>
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel px-2.5 py-2 text-xs min-h-10">{remote === null ? <span className="text-faint">…</span> : remote || <span className="text-faint">Nothing copied there yet</span>}</pre>
        <Button className="w-full" disabled={!remote || !!busy} onClick={copyHere}>
          <ClipboardCopy size={14} /> Copy to this device
        </Button>
      </section>
      <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted">Send to {c.name}</h4>
        <Textarea rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste text or a link here" />
        <div className="flex flex-wrap gap-1.5">
          <Button variant="primary" disabled={!draft || !!busy} onClick={send}>
            {busy === "send" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
          </Button>
          {mine && (
            <Button disabled={!draft || !!busy} onClick={sendAndPaste} title="Puts it on the clipboard there and pastes where the cursor is">
              {busy === "paste" && <Loader2 size={14} className="animate-spin" />} Send and paste
            </Button>
          )}
          {mine && isUrl(draft) && (
            <Button disabled={!!busy} onClick={openLink}>
              <ExternalLink size={14} /> Open there
            </Button>
          )}
        </div>
        {!mine && <p className="text-xs text-muted">Take control to paste it or open links there.</p>}
      </section>
      {msg && <p className={cx("text-xs", msg.bad ? "text-bad" : "text-ok")}>{msg.text}</p>}
      <label className="flex items-start gap-2 rounded-xl border border-line p-3 text-xs cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={sync} onChange={(e) => (setSync(e.target.checked), setClipboardSync(e.target.checked))} />
        <span>
          <span className="block font-medium text-sm">Copy and paste across</span>
          <span className="text-muted">
            While you're in control, {mod}C and {mod}V work between this device and {c.name}. Your browser may ask once to allow clipboard access.
          </span>
        </span>
      </label>
    </div>
  );
}

/** Browse the computer's files: download them here, upload from here (or drop them in). */
export function FilesPanel({ computer: c, onClose, refresh, onSent }: { computer: ComputerInfo; onClose: () => void; refresh?: number; onSent?: (text: string) => void }) {
  const [path, setPath] = useState("~");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hidden, setHidden] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = async (p = path) => {
    setLoading(true);
    setError(null);
    try {
      const l = await api<FolderListing>("GET", `/api/computers/${c.id}/files?path=${encodeURIComponent(p)}`);
      setListing(l);
      setPath(l.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [c.id, refresh]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(files.length === 1 ? `Sending ${files[0].name}…` : `Sending ${files.length} files…`);
    setError(null);
    try {
      await sendFiles(c.id, path, files);
      onSent?.(files.length === 1 ? `Sent ${files[0].name}` : `Sent ${files.length} files`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const download = async (p: string, name: string) => {
    setBusy(`Downloading ${name}…`);
    setError(null);
    try {
      await downloadFile(c.id, p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const mkdir = async () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    try {
      await api("POST", `/api/computers/${c.id}/files/folder`, { folder: path, name });
      setNaming(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = listing?.entries.filter((f) => hidden || !f.name.startsWith(".")) ?? [];
  const hiddenCount = (listing?.entries.length ?? 0) - shown.length;
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const join = (name: string) => (path.endsWith(sep) ? path + name : path + sep + name);
  const home = listing?.home ?? "";
  const crumbs = home && path.startsWith(home) ? ["Home", ...path.slice(home.length).split(/[/\\]/).filter(Boolean)] : path.split(/[/\\]/).filter(Boolean);
  const shortcuts = [
    { label: "Home", path: "~", icon: <Home size={12} /> },
    { label: "Desktop", path: "~/Desktop" },
    { label: "Downloads", path: "~/Downloads" },
    ...(c.kind === "vm" ? [{ label: "Agents' files", path: "~/files" }] : []),
  ];

  return (
    <div
      className={cx("space-y-3 min-h-full rounded-xl", dragging && "ring-2 ring-info ring-offset-4 ring-offset-bg")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <PanelHead title={`Files on ${c.name}`} onClose={onClose}>
        <button onClick={() => load()} disabled={loading} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Refresh" title="Refresh">
          <RefreshCw size={14} className={cx(loading && "animate-spin")} />
        </button>
      </PanelHead>
      <div className="flex flex-wrap gap-1">
        {shortcuts.map((s) => (
          <button key={s.path} onClick={() => load(s.path)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-line text-xs hover:bg-hover">
            {s.icon} {s.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs min-w-0">
        <button onClick={() => listing?.parent && load(listing.parent)} disabled={!listing?.parent || loading} className="p-1 rounded-md hover:bg-hover text-muted disabled:opacity-40 shrink-0" aria-label="Up a folder" title="Up a folder">
          <ArrowUp size={14} />
        </button>
        <span className="truncate text-muted" title={path}>
          {crumbs.join(" / ") || "/"}
        </span>
      </div>
      <div className="flex gap-1.5">
        <Button variant="primary" className="flex-1" disabled={!!busy} onClick={() => input.current?.click()}>
          <Upload size={14} /> Upload here
        </Button>
        <Button disabled={!!busy || naming !== null} onClick={() => setNaming("")} title="New folder" aria-label="New folder">
          <FolderPlus size={14} />
        </Button>
        <input ref={input} type="file" multiple hidden onChange={(e) => (void upload([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </div>
      {naming !== null && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void mkdir();
          }}
        >
          <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(null)} placeholder="Folder name" className="h-8 flex-1 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus:border-ring" />
          <Button className="h-8">Make</Button>
        </form>
      )}
      {busy && (
        <p className="text-xs text-muted flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> {busy}
        </p>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
      <ul className="-mx-1">
        {shown.map((f) => (
          <li key={f.name}>
            <button
              onClick={() => (f.dir ? load(join(f.name)) : download(join(f.name), f.name))}
              disabled={!!busy && !f.dir}
              className="group w-full flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-hover"
              title={f.dir ? `Open ${f.name}` : `Download ${f.name}`}
            >
              {f.dir ? <Folder size={15} className="text-info shrink-0" /> : <File size={15} className="text-muted shrink-0" />}
              <span className={cx("min-w-0 flex-1 truncate text-sm", f.name.startsWith(".") && "text-muted")}>{f.name}</span>
              {!f.dir && <span className="text-xs text-faint tabular-nums shrink-0 group-hover:hidden">{formatSize(f.size)}</span>}
              {!f.dir && <Download size={14} className="text-muted shrink-0 hidden group-hover:block" />}
            </button>
          </li>
        ))}
      </ul>
      {listing && !shown.length && <p className="text-xs text-muted text-center py-4">{hiddenCount ? "Only hidden files here." : "This folder is empty."} Drop files here to send them.</p>}
      {listing && (
        <p className="text-xs text-faint">
          {shown.length > 0 && `${shown.length} item${shown.length === 1 ? "" : "s"} · drop files to send them here`}
          {(hiddenCount > 0 || hidden) && (
            <button onClick={() => setHidden((v) => !v)} className="block mt-1 underline hover:text-muted">
              {hidden ? "Hide hidden files" : `Show ${hiddenCount} hidden`}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
