import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { ConfirmDialog } from "../components/InboxParts.tsx";
import { agentColor, cx, timeAgo } from "../components/ui.tsx";
import { useStore } from "../store.ts";
import type { TaskRow } from "../views/TasksView.tsx";
import type { CodeTask } from "./data.ts";

/**
 * Review: what a task's branch changed, its files and its checks, with Merge and Send back.
 * It slides in only when asked for (the Review button, ⌘⇧1–3), so the panes stay roomy.
 */

export type ReviewTab = "changes" | "files" | "checks";

interface ChangedFile {
  path: string;
  add: number;
  del: number;
  status: string;
}
interface Diff {
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
  ahead: number;
  uncommitted: boolean;
}
interface Check {
  name: string;
  ok: boolean;
  output: string;
  ms: number;
}

/** The pieces of a task that have a branch of their own (reviews share their builder's). */
export function branchesOf(task: CodeTask): TaskRow[] {
  return task.family.filter((t) => !!t.branch && !t.reviewOf);
}

/** "diff --git a/x b/x" chunks, by file. */
function splitPatch(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = [];
      out.set(m[2], cur);
      continue;
    }
    if (cur && !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) cur.push(line);
  }
  return out;
}

export function ReviewPanel({ task, tab, setTab, version }: { task: CodeTask; tab: ReviewTab; setTab: (t: ReviewTab) => void; version: number }) {
  const branches = branchesOf(task);
  const [branchTask, setBranchTask] = useState<string | null>(branches[0]?.id ?? null);
  const piece = branches.find((b) => b.id === branchTask) ?? branches[0];
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    if (!piece) return;
    let gone = false;
    setError(null);
    api<Diff>("GET", `/api/tasks/${piece.id}/review/diff`).then(
      (d) => {
        if (gone) return;
        setDiff(d);
        setFile((f) => (f && d.files.some((x) => x.path === f) ? f : (d.files[0]?.path ?? null)));
      },
      (err) => !gone && (setDiff(null), setError((err as Error).message)),
    );
    return () => {
      gone = true;
    };
  }, [piece?.id, version]);

  // J / K: next and previous changed file
  useEffect(() => {
    if (tab !== "changes" || !diff?.files.length) return;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest(".xterm") || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      if (e.key !== "j" && e.key !== "k") return;
      const i = diff.files.findIndex((f) => f.path === file);
      const n = Math.max(0, Math.min(diff.files.length - 1, i + (e.key === "j" ? 1 : -1)));
      setFile(diff.files[n].path);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [tab, diff, file]);

  const tabs: { id: ReviewTab; label: string; badge?: string; warn?: boolean }[] = [
    { id: "changes", label: "Changes", badge: diff?.files.length ? String(diff.files.length) : undefined },
    { id: "files", label: "Files" },
    { id: "checks", label: "Checks" },
  ];

  return (
    <aside aria-label="Review" className="m-panel flex w-[392px] shrink-0 flex-col border-l border-white/[.06] bg-[#0f0f11] max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-auto">
      <div role="tablist" className="flex h-12 shrink-0 items-end gap-[18px] border-b border-white/[.06] px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx("h-[34px] border-b-2 px-0.5 text-[12.5px] transition-[color,border-color] duration-200", tab === t.id ? "border-[#f2f2f4] text-[#f2f2f4]" : "border-transparent text-[#a1a1aa] hover:text-[#f2f2f4]")}
          >
            {t.label}
            {t.badge && <span className="ml-1.5 rounded-lg bg-[#26262b] px-[5px] text-[10.5px] text-[#a1a1aa]">{t.badge}</span>}
          </button>
        ))}
      </div>
      {branches.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-2.5">
          {branches.map((b) => (
            <BranchChip key={b.id} t={b} twice={branches.filter((x) => x.toAgentId === b.toAgentId).length > 1} on={b.id === piece?.id} onPick={() => setBranchTask(b.id)} />
          ))}
        </div>
      )}
      {!piece ? (
        <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">No branch yet: the work hasn't started on one.</p>
      ) : tab === "changes" ? (
        <Changes task={task} piece={piece} diff={diff} error={error} file={file} setFile={setFile} />
      ) : tab === "files" ? (
        <Files piece={piece} diff={diff} version={version} />
      ) : (
        <Checks task={task} piece={piece} />
      )}
    </aside>
  );
}

function BranchChip({ t, on, onPick, twice }: { t: TaskRow; on: boolean; onPick: () => void; twice: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === t.toAgentId));
  return (
    <button type="button" onClick={onPick} title={t.branch ?? undefined} className={cx("flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors", on ? "border-white/25 bg-white/[.06] text-[#f2f2f4]" : "border-white/[.08] text-[#a1a1aa] hover:text-[#f2f2f4]")}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: agentColor(agent) }} />
      {agent?.name ?? "agent"}
      {/* an agent with two branches: which one */}
      {twice && <span className="max-w-[120px] truncate text-[#8e8e96]">{t.title.replace(/^Review: /, "")}</span>}
    </button>
  );
}

function Changes({ task, piece, diff, error, file, setFile }: { task: CodeTask; piece: TaskRow; diff: Diff | null; error: string | null; file: string | null; setFile: (f: string) => void }) {
  const chunks = useMemo(() => (diff ? splitPatch(diff.patch) : new Map<string, string[]>()), [diff]);
  const builder = useStore((s) => s.agents.find((a) => a.id === piece.toAgentId));
  const reviews = task.family.filter((t) => t.reviewOf === piece.id);
  const lines = file ? (chunks.get(file) ?? []) : [];
  if (error) return <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">{error}</p>;
  if (!diff) return <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">Loading…</p>;
  return (
    <div className="m-fade-in flex min-h-0 flex-1 flex-col">
      {diff.files.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">No changes on {piece.branch} yet.</p>
      ) : (
        <>
          <div className="flex max-h-[34%] shrink-0 flex-col gap-px overflow-y-auto px-2 pb-1.5 pt-2.5">
            {diff.files.map((f) => (
              <button key={f.path} type="button" onClick={() => setFile(f.path)} className={cx("flex items-center gap-2 rounded-md px-2 py-[5px] text-left transition-colors", f.path === file ? "bg-white/[.06]" : "hover:bg-white/[.03]")}>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.path}</span>
                {f.add > 0 && <span className="font-mono text-[11px] text-[#3fb950]">+{f.add}</span>}
                {f.del > 0 && <span className="font-mono text-[11px] text-[#ff7b72]">−{f.del}</span>}
              </button>
            ))}
          </div>
          <div className="mx-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[.07] bg-[#0b0b0d]">
            <div className="flex shrink-0 justify-between border-b border-white/[.06] px-2.5 py-1.5 text-[12px] text-[#a1a1aa]">
              <span className="truncate">{file?.split("/").pop()}</span>
              <span className="shrink-0">
                by {builder?.name ?? "agent"} · {timeAgo(piece.updatedAt)}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11.5px] leading-[1.65]">
              {lines.map((l, i) => (
                <div key={i} className={cx("whitespace-pre px-2.5", l.startsWith("+") ? "bg-[#3fb950]/10 text-[#aff5b4]" : l.startsWith("-") ? "bg-[#ff7b72]/10 text-[#ffc1bc]" : l.startsWith("@@") ? "text-[#6aa2ff]" : "text-[#a1a1aa]")}>
                  {l || " "}
                </div>
              ))}
              {diff.truncated && <div className="px-2.5 py-2 text-[#8e8e96]">The rest is too long to show here.</div>}
            </div>
            {reviews.filter((r) => r.result).slice(-1).map((r) => <ReviewNote key={r.id} r={r} />)}
          </div>
          {diff.uncommitted && <p className="mx-3 mt-2 text-[11.5px] text-[#8e8e96]">Includes changes {builder?.name ?? "the agent"} hasn't committed yet.</p>}
        </>
      )}
      <Actions task={task} piece={piece} empty={diff.files.length === 0 && diff.ahead === 0} />
    </div>
  );
}

function ReviewNote({ r }: { r: TaskRow }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === r.toAgentId));
  return (
    <div className="m-2.5 rounded-md border px-2.5 py-2 text-[12px] leading-[1.45]" style={{ borderColor: `${agentColor(agent)}59` }}>
      <b style={{ color: agentColor(agent) }}>{agent?.name ?? "Reviewer"}</b> <span className="text-[#a1a1aa]">review</span>
      <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[#d4d4d8]">{r.result}</div>
    </div>
  );
}

/** Merge (asks first) and Send back with a note. ⌘⇧M and ⌘⇧B reach these from anywhere in Code. */
function Actions({ task, piece, empty }: { task: CodeTask; piece: TaskRow; empty: boolean }) {
  const [asking, setAsking] = useState<"merge" | "back" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const builder = useStore((s) => s.agents.find((a) => a.id === piece.toAgentId));
  useEffect(() => {
    const k = (e: Event) => setAsking((e as CustomEvent<"merge" | "back">).detail);
    window.addEventListener("wisp-code-review", k);
    return () => window.removeEventListener("wisp-code-review", k);
  }, []);
  const merge = async () => {
    setBusy(true);
    try {
      const r = await api<{ output: string }>("POST", `/api/tasks/${piece.id}/merge`);
      setMsg({ ok: true, text: r.output });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };
  const sendBack = async (e: FormEvent) => {
    e.preventDefault();
    const text = note.trim();
    if (!text || !builder || !piece.threadId || !piece.channelId) return;
    setBusy(true);
    try {
      await api("POST", `/api/channels/${piece.channelId}/messages`, { body: `@${builder.handle} Sent back: ${text}`, threadId: piece.threadId });
      setNote("");
      setAsking(null);
      setMsg({ ok: true, text: `Sent back to ${builder.name}.` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  if (piece.mergedAt) return <p className="mt-3 border-t border-white/[.06] px-4 py-3 text-[12.5px] text-[#3fb950]">Merged into {task.team.baseBranch}.</p>;
  return (
    <div className="mt-3 flex shrink-0 flex-col gap-2 border-t border-white/[.06] p-3">
      {asking === "back" ? (
        <form onSubmit={sendBack} className="m-fade-in flex gap-2">
          <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setAsking(null))} placeholder={`What should ${builder?.name ?? "they"} change?`} className="h-7 min-w-0 flex-1 rounded-[7px] border border-white/[.12] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] outline-none focus:border-white/30" />
          <button type="submit" disabled={busy || !note.trim()} className="inline-flex h-7 items-center rounded-[7px] border border-[#f2f2f4] bg-[#f2f2f4] px-2.5 text-[12.5px] font-semibold text-[#0c0c0e] active:scale-[.96] disabled:opacity-40">
            Send
          </button>
        </form>
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={busy || empty} onClick={() => setAsking("merge")} title="⌘⇧M" className="inline-flex h-7 flex-1 items-center justify-center rounded-[7px] border border-[#f2f2f4] bg-[#f2f2f4] px-2.5 text-[12.5px] font-semibold text-[#0c0c0e] transition-[background-color,transform] hover:bg-white active:scale-[.96] disabled:opacity-40">
            Merge into {task.team.baseBranch}
          </button>
          <button type="button" disabled={busy || !builder} onClick={() => setAsking("back")} title="⌘⇧B" className="inline-flex h-7 items-center rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96] disabled:opacity-40">
            Send back
          </button>
        </div>
      )}
      {msg && <p className={cx("m-fade-in whitespace-pre-wrap text-[12px]", msg.ok ? "text-[#a1a1aa]" : "text-[#ff6b6b]")}>{msg.text}</p>}
      {asking === "merge" && (
        <ConfirmDialog title={`Merge ${piece.branch} into ${task.team.baseBranch}?`} body={piece.reviewOf || task.family.some((t) => t.reviewOf === piece.id && t.status === "done") ? "It has been reviewed." : "Nobody has reviewed it yet."} confirm="Merge" keep="Not yet" busy={busy} onConfirm={merge} onClose={() => setAsking(null)} />
      )}
    </div>
  );
}

function Files({ piece, diff, version }: { piece: TaskRow; diff: Diff | null; version: number }) {
  const [tree, setTree] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ file: string; text: string; truncated: boolean; binary: boolean } | null>(null);
  const [shut, setShut] = useState<Set<string>>(new Set());
  useEffect(() => {
    let gone = false;
    api<{ tree: string[] }>("GET", `/api/tasks/${piece.id}/review/files`).then(
      (r) => !gone && setTree(r.tree),
      (err) => !gone && setError((err as Error).message),
    );
    return () => {
      gone = true;
    };
  }, [piece.id, version]);
  const marks = new Map((diff?.files ?? []).map((f) => [f.path, f.status]));
  const view = async (file: string) => {
    try {
      setOpen(await api("GET", `/api/tasks/${piece.id}/review/file?path=${encodeURIComponent(file)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (open)
    return (
      <div className="m-fade-in flex min-h-0 flex-1 flex-col">
        <button type="button" onClick={() => setOpen(null)} className="flex shrink-0 items-center gap-1.5 px-4 py-2.5 text-left text-[12px] text-[#a1a1aa] hover:text-[#f2f2f4]">
          ← <span className="truncate font-mono">{open.file}</span>
        </button>
        <div className="mx-3 mb-3 min-h-0 flex-1 overflow-auto rounded-lg border border-white/[.07] bg-[#0b0b0d] py-1 font-mono text-[11.5px] leading-[1.65]">
          {open.binary ? (
            <p className="px-2.5 py-2 text-[#8e8e96]">Not a text file.</p>
          ) : (
            open.text.split("\n").map((l, i) => (
              <div key={i} className="whitespace-pre px-2.5 text-[#d4d4d8]">
                <span className="mr-2 inline-block w-7 select-none text-right text-[#55555c]">{i + 1}</span>
                {l}
              </div>
            ))
          )}
          {open.truncated && <p className="px-2.5 py-2 text-[#8e8e96]">The rest is too long to show here.</p>}
        </div>
      </div>
    );
  if (error) return <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">{error}</p>;
  if (!tree) return <p className="px-4 py-6 text-[12.5px] text-[#8e8e96]">Loading…</p>;
  // folders first, each opened or closed with a click
  const rows: { path: string; name: string; depth: number; dir: boolean }[] = [];
  const seen = new Set<string>();
  for (const f of tree) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (parts.slice(0, i).some((_, j) => shut.has(parts.slice(0, j + 1).join("/")))) break;
      if (seen.has(p)) continue;
      seen.add(p);
      rows.push({ path: p, name: parts[i], depth: i, dir: i < parts.length - 1 });
    }
  }
  return (
    <div className="m-fade-in min-h-0 flex-1 overflow-y-auto px-2 py-2.5 font-mono text-[12.5px] leading-[1.9]">
      {rows.map((r) => {
        const mark = r.dir ? [...marks.keys()].some((k) => k.startsWith(`${r.path}/`)) ? "•" : "" : (marks.get(r.path) ?? "");
        return (
          <button
            key={r.path}
            type="button"
            onClick={() => (r.dir ? setShut((s) => { const n = new Set(s); if (n.has(r.path)) n.delete(r.path); else n.add(r.path); return n; }) : view(r.path))}
            className="flex w-full items-center gap-1 rounded-[5px] pr-2 text-left transition-colors hover:bg-white/[.04]"
            style={{ paddingLeft: 8 + r.depth * 16 }}
          >
            <span className="w-3 text-[#8e8e96]">{r.dir ? (shut.has(r.path) ? "▸" : "▾") : "·"}</span>
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className={cx("text-[11px]", mark === "A" ? "text-[#3fb950]" : mark === "D" ? "text-[#ff7b72]" : "text-[#ffb340]")}>{mark}</span>
          </button>
        );
      })}
    </div>
  );
}

function Checks({ task, piece }: { task: CodeTask; piece: TaskRow }) {
  const me = useStore((s) => s.me);
  const builder = useStore((s) => s.agents.find((a) => a.id === piece.toAgentId));
  const node = useStore((s) => s.computers.find((c) => c.kind === "device" && c.nodeId === builder?.nodeId));
  const [results, setResults] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // the server checks too; without the device in view, the workspace owner is the likely one
  const mine = !!me && (node ? node.ownerId === me.user.id : me.role === "owner");
  const reviews = task.family.filter((t) => t.reviewOf === piece.id);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResults(await api<Check[]>("POST", `/api/tasks/${piece.id}/review/checks`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const row = (key: string, name: string, note: string, tone: "ok" | "bad" | "run" | "warn" | "idle", body?: string) => (
    <div key={key} className="rounded-lg border border-white/[.07] bg-[#141417]">
      <button type="button" disabled={!body} onClick={() => setOpen((o) => (o === key ? null : key))} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", tone === "run" && "m-code-pulse")} style={{ background: { ok: "#3fb950", bad: "#ff6b5e", run: "#4c9dff", warn: "#ffb340", idle: "#6b6b75" }[tone] }} />
        <span className="flex-1 text-[13px]">{name}</span>
        <span className="font-mono text-[11.5px] text-[#a1a1aa]">{note}</span>
      </button>
      {open === key && body && <pre className="m-fade-in max-h-56 overflow-auto border-t border-white/[.06] px-3 py-2 font-mono text-[11px] leading-[1.5] text-[#a1a1aa]">{body}</pre>}
    </div>
  );
  return (
    <div className="m-fade-in flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2.5">
      {results?.map((c) => row(c.name, c.name.charAt(0).toUpperCase() + c.name.slice(1), c.ok ? `passed · ${Math.round(c.ms / 1000)}s` : "failed", c.ok ? "ok" : "bad", c.output))}
      {running && row("running", "Running checks", "…", "run")}
      {reviews.map((r) => {
        const who = useStore.getState().agents.find((a) => a.id === r.toAgentId);
        return row(r.id, `Review · ${who?.name ?? "reviewer"}`, r.status === "done" ? "done" : r.status === "failed" ? "failed" : "working", r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "run", r.result ?? undefined);
      })}
      {error && <p className="text-[12px] text-[#ff6b6b]">{error}</p>}
      {mine ? (
        <button type="button" disabled={running} onClick={run} className="mt-1 inline-flex h-7 items-center justify-center self-start rounded-[7px] border border-white/[.09] bg-[#1d1d21] px-2.5 text-[12.5px] text-[#f2f2f4] transition-[background-color,transform] hover:bg-[#26262b] active:scale-[.96] disabled:opacity-40">
          {results ? "Run again" : "Run checks"}
        </button>
      ) : (
        !results && <p className="text-[12px] text-[#8e8e96]">Checks run on {builder?.name ?? "the agent"}'s device; its owner starts them.</p>
      )}
    </div>
  );
}
