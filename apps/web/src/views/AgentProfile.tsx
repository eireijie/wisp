import { Suspense, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon, Loader2, MessageSquarePlus, Plus } from "lucide-react";
import type { AccessLevel, Agent } from "@bubble-ai/core";
import { api, fileUrl } from "../api.ts";
import { colorGradient, setAgentBackground, shownColor, useAgentBackground, usePhotoSrc, type ChatBackground } from "../chatBackground.ts";
import { useStore } from "../store.ts";
import { href, go, type AgentTab } from "../router.ts";
import { liveShape } from "../liveShape.ts";
import { useFeatures } from "../features.ts";
import { useAppearance } from "../theme.ts";
import { lazyView } from "../lazy.tsx";
import { openDm } from "../openDm.ts";
import { useDevices, whoCanAsk } from "../devices.ts";
import { setChannelPrefs } from "../components/Channels.tsx";
import { FilePreview } from "../components/FilePreview.tsx";
import { fileKind } from "../components/fileKind.ts";
import { stopRuns, workDetail } from "../components/ActivityPill.tsx";
import { minutesSince, runStartedAt } from "../components/agentActivity.ts";
import { effortName } from "../components/EffortSlider.tsx";
import { cx, timeAgo } from "../components/ui.tsx";
import { VoicePicker, recommendVoices } from "../voice/VoicePicker.tsx";
import { deviceVoices, ELEVEN_VOICES, OPENAI_VOICES } from "../voice/providers.ts";
import { LANGUAGES, SPEEDS, setCallPrefs, speedLabel, useCallPrefs } from "../voice/prefs.ts";
import { MemoryGraph, type GraphData, type GraphNode } from "../components/MemoryGraph.tsx";
import { useBackgroundSheet } from "../components/BackgroundSheet.tsx";
import { CARD, InPlace, Line, Toggle } from "./AgentSections.tsx";
import { runsOnDevice } from "./AgentComputer.tsx";

/**
 * The profile (round 11, board 12): one short list, no tabs. Every other address opens a part over it
 * with a back arrow: Edit (#/agents/<id>/settings) holds the name, look, background, voice and brain;
 * the short list's rows open Library, Computer, Apps and skills, Routines and Memory; "Full profile"
 * (more) holds everything else. Old addresses keep working: each lands on its part.
 */
export const PART_PARENT: Partial<Record<AgentTab, AgentTab>> = {
  settings: "overview",
  notes: "overview",
  library: "overview",
  screen: "overview",
  computer: "overview",
  device: "overview",
  apps: "overview",
  skills: "overview",
  routines: "overview",
  more: "overview",
  look: "settings",
  wallpaper: "settings",
  voice: "settings",
  model: "settings",
  harness: "settings",
  role: "settings",
  effort: "more",
  memory: "more",
  soul: "more",
  instructions: "more",
  watches: "more",
  access: "more",
  connect: "more",
  background: "more",
  runs: "more",
  permissions: "more",
};
export const PROFILE_PARTS: readonly AgentTab[] = Object.keys(PART_PARENT) as AgentTab[];

/** Where an address lands in the profile: the part open over the short list (null for the list itself). */
export function profilePlace(tab: AgentTab | null | undefined): { part: AgentTab | null } {
  if (!tab || tab === "overview" || tab === "remove") return { part: null };
  return { part: PROFILE_PARTS.includes(tab) ? tab : null };
}

const ACCESS_LABEL: Record<AccessLevel, string> = { "read-only": "Read only", edit: "Can edit files", full: "Full access" };

/** A card of one-line rows with a small heading over it (and, at its right, a small action such as Hide). */
function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5">
      {title && (
        <div className="flex items-baseline justify-between px-1">
          <h3 className="text-[11.5px] font-semibold text-muted">{title}</h3>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// --- Activity -----------------------------------------------------------------

interface RunRow {
  id: string;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  channelId: string;
  threadId: string | null;
  channelName: string | null;
  channelKind: string | null;
  trigger: string | null;
  /** "background" for a check the agent made on its own; an empty trigger alone can also mean a DM the viewer can't see */
  kind?: string | null;
  /** a failure in plain words, when the hub recognised it (the harness needs signing in on its device) */
  hint?: string | null;
}

/** A run's status in plain words. */
export function runStatusLabel(status: string): string {
  const known: Record<string, string> = { queued: "Waiting to start", running: "Working", done: "Done", failed: "Didn't finish", cancelled: "Stopped" };
  return known[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

/** A readable name for a run, from the body of the message that woke the agent ("" when there's no message to show). */
export function runTitle(trigger: string | null): string {
  const text = (trigger ?? "").trim();
  if (!text) return "";
  const body = text.replace(/^(?:@[\w.-]+\s*)+/, "");
  const task = body.match(/^New task \*\*(.+?)\*\*/);
  if (task) return `Task: ${task[1]}`;
  const routine = body.match(/^Run the routine \*\*(.+?)\*\*/);
  if (routine) return `Routine: ${routine[1]}`;
  const learn = body.match(/^I just showed you how to \*\*(.+?)\*\*/);
  if (learn) return `Learning: ${learn[1]}`;
  const line = (body.split("\n").find((l) => l.trim()) ?? "")
    .replace(/\*\*|`/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return "Message";
  return line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line;
}

/** How long a run took, in words ("under a second", "12 seconds", "3 minutes"). */
export function tookFor(ms: number): string {
  const secs = Math.round(Math.max(0, ms) / 1000);
  if (secs < 1) return "under a second";
  if (secs < 60) return secs === 1 ? "1 second" : `${secs} seconds`;
  const mins = Math.round(secs / 60);
  return mins === 1 ? "1 minute" : `${mins} minutes`;
}

const RUN_DOT: Record<string, string> = { done: "var(--status-online)", failed: "var(--status-error)", running: "var(--status-working)", queued: "var(--status-paused)", cancelled: "var(--status-idle)" };

/** What it is on right now, with Stop; nothing while it rests. */
export function WorkingNow({ agent, className }: { agent: Agent; className?: string }) {
  const live = useStore(liveShape);
  const agents = useStore((s) => s.agents);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const runsNow = Object.values(live).filter((r) => r.agentId === agent.id);
  const run = runsNow.at(-1);
  const since = runsNow.length ? Math.min(...runsNow.map((r) => runStartedAt(r.runId))) : null;
  if (!run && agent.status !== "busy") return null;
  return (
    <div className={cx(CARD, "flex min-h-[44px] items-center gap-3 px-3 text-[13.5px]", className)} role="status">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-st-working" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {run ? workDetail(run, agents) : "Working"}
        {since ? <span className="text-muted"> · {minutesSince(since)}</span> : null}
      </span>
      {runsNow.length > 0 && canEdit && (
        <button type="button" onClick={() => void stopRuns(runsNow)} className="shrink-0 text-[13px] font-medium text-ink hover:underline">
          Stop
        </button>
      )}
    </div>
  );
}

/** Its voice: Automatic, or one of a short list for this engine, and the speed. All voices (with Listen) are one row further. */
export function VoiceChat({ agent }: { agent: Agent }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const prefs = useCallPrefs();
  const [engine, setEngine] = useState<"device" | "openai" | "elevenlabs">("device");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api<{ speak: "device" | "openai" | "elevenlabs" }>("GET", "/api/voice/settings").then((s) => alive && setEngine(s.speak), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const choices = voiceChoices(engine);
  const chosen = agent.settings.voice?.[engine] ?? "";
  const name = chosen ? (choices.find((c) => c.id === chosen)?.label ?? voiceName(engine, chosen)) : "Automatic";
  const pick = async (id: string) => {
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { voice: { ...agent.settings.voice, [engine]: id || undefined } } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const language = LANGUAGES.find(([tag]) => tag === prefs.language)?.[1] ?? "Auto-detect";
  return (
    <div className={CARD}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-[44px] w-full items-center gap-3 px-3.5 text-left text-[14px] outline-none hover:bg-hover focus-visible:bg-hover">
        <span className="flex-1">Voice</span>
        <span className="truncate text-[13px] text-muted">
          {name} · {speedLabel(prefs.speed)}
        </span>
        <ChevronDown size={14} className={cx("shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 px-3.5 py-3">
          <div role="radiogroup" aria-label="Voice" className="flex flex-wrap gap-1.5">
            {[{ id: "", label: "Automatic" }, ...choices].map((c) => (
              <button key={c.id || "auto"} type="button" role="radio" aria-checked={c.id === chosen} onClick={() => void pick(c.id)} className={cx("h-8 rounded-full px-3 text-[13px]", c.id === chosen ? "bg-ink text-panel" : "bg-hover text-ink hover:bg-chip")}>
                {c.label}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Speed" className="flex items-center gap-1.5">
            <span className="mr-1 text-[13px] text-muted">Speed</span>
            {SPEEDS.map((sp) => (
              <button key={sp} type="button" role="radio" aria-checked={prefs.speed === sp} onClick={() => setCallPrefs({ speed: sp })} className={cx("h-7 rounded-full px-2.5 text-[12.5px] tabular-nums", prefs.speed === sp ? "bg-ink text-panel" : "bg-hover hover:bg-chip")}>
                {speedLabel(sp)}
              </button>
            ))}
          </div>
          <a href={href({ view: "agents", agentId: agent.id, tab: "voice" })} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
            All voices, with Listen <ChevronRight size={13} aria-hidden />
          </a>
          {error && <p className="text-[13px] text-bad">{error}</p>}
        </div>
      )}
      <label className="relative flex min-h-[44px] items-center gap-3 px-3.5 text-[14px] hover:bg-hover">
        <span className="flex-1">Language</span>
        <span className="truncate text-[13px] text-muted">{language}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
        <select aria-label="Language" value={prefs.language} onChange={(e) => setCallPrefs({ language: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0">
          {LANGUAGES.map(([tag, label]) => (
            <option key={tag} value={tag}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** A short list of voices for the engine: this device's best few for the person's language, or the service's own. */
function voiceChoices(engine: "device" | "openai" | "elevenlabs"): { id: string; label: string }[] {
  if (engine === "openai") return OPENAI_VOICES.map((v) => ({ id: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
  if (engine === "elevenlabs") return ELEVEN_VOICES.map((v) => ({ id: v.id, label: v.name }));
  const language = typeof navigator === "undefined" ? "en" : navigator.language || "en";
  return recommendVoices(deviceVoices(), language, 5).map((v) => ({ id: v.voiceURI, label: v.name.replace(/\s*\(.*$/, "") }));
}
function voiceName(engine: "device" | "openai" | "elevenlabs", id: string): string {
  if (engine === "device") return (deviceVoices().find((v) => v.voiceURI === id)?.name ?? id).replace(/\s*\(.*$/, "");
  if (engine === "elevenlabs") return ELEVEN_VOICES.find((v) => v.id === id)?.name ?? "Custom";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Its recent runs, each opening the chat it was in; one that didn't finish has Try again (More › Recent runs). */
export function RecentRuns({ agent }: { agent: Agent }) {
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<RunRow[]>("GET", `/api/agents/${agent.id}/runs?limit=50`).then(setRuns, () => setRuns([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  const retry = async (r: RunRow) => {
    setError(null);
    try {
      await api("POST", `/api/runs/${r.id}/retry`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (runs === null) return <p className="px-1 text-[13px] text-muted">Loading…</p>;
  if (runs.length === 0) return <p className="px-1 text-[13px] text-muted">Nothing yet</p>;
  return (
    <div className="space-y-2">
      <div className={CARD}>
        {runs.map((r) => {
          const why = r.hint || r.error;
          const took = r.finishedAt ? tookFor(new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) : null;
          const where = r.channelKind === "dm" ? "Chat" : r.channelName ? `#${r.channelName}` : "";
          const title = r.kind === "background" ? "Background check" : runTitle(r.trigger) || "Message";
          return (
            <div key={r.id} className="flex min-h-[46px] items-center gap-3 px-3.5 py-2 text-[14px]">
              <span className="size-2 shrink-0 rounded-full" style={{ background: RUN_DOT[r.status] ?? RUN_DOT.cancelled }} title={runStatusLabel(r.status)} aria-label={runStatusLabel(r.status)} />
              <span className="min-w-0 flex-1">
                <a href={`#/c/${r.channelId}${r.threadId ? `/t/${r.threadId}` : ""}`} title={[where, took ? `took ${took}` : null, `run ${r.id}`].filter(Boolean).join(" · ")} className="block truncate hover:underline">
                  {title}
                </a>
                {why && <span className="block truncate text-[12.5px] text-bad">{why.replace(/`/g, "")}</span>}
              </span>
              {r.status === "failed" && r.channelName !== null && canEdit && (
                <button type="button" className="shrink-0 text-[13px] font-medium text-ink hover:underline" onClick={() => void retry(r)}>
                  Try again
                </button>
              )}
              <span className="w-[64px] shrink-0 text-right text-[13px] text-muted">{timeAgo(r.createdAt)}</span>
            </div>
          );
        })}
      </div>
      {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
    </div>
  );
}

// --- Memory -------------------------------------------------------------------

/** Its own notes in the memory graph (its folder, not its personality), with the notes they link to so the lines show. */
export function agentGraph(agentId: string, graph: GraphData): GraphData {
  const own = (n: GraphNode) => !!n.path && n.path.startsWith(`agents/${agentId}/`) && !/\/(SOUL|About)\.md$/.test(n.path);
  const keep = new Set(graph.nodes.filter(own).map((n) => n.id));
  if (keep.size === 0) return { nodes: [], edges: [] };
  for (const e of graph.edges) {
    if (keep.has(e.source)) keep.add(e.target);
    if (keep.has(e.target)) keep.add(e.source);
  }
  return { nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

/** Memory (board ProfileSide): a small map of the notes it made or saved, its two newest, and the way to all of them. */
export function MemoryTab({ agent }: { agent: Agent }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  useEffect(() => {
    let on = true;
    api<GraphData>("GET", "/api/vault/graph").then(
      (g) => on && setGraph(agentGraph(agent.id, g)),
      () => on && setGraph({ nodes: [], edges: [] }),
    );
    api<NoteRow[]>("GET", "/api/vault/notes").then(
      (n) => on && setNotes(n.filter((x) => x.path.startsWith(`agents/${agent.id}/`) && !/\/(SOUL|About)\.md$/.test(x.path)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))),
      () => on && setNotes([]),
    );
    return () => {
      on = false;
    };
  }, [agent.id]);
  const recent = (notes ?? []).slice(0, 2);
  return (
    <div className="space-y-4">
      <div className={cx(CARD, "relative h-[210px]")}>
        {!graph ? (
          <p className="grid h-full place-items-center text-[13px] text-muted">Loading…</p>
        ) : graph.nodes.length === 0 ? (
          <p className="grid h-full place-items-center px-6 text-center text-[13px] text-muted">{agent.name} hasn't saved any notes yet</p>
        ) : (
          <MemoryGraph graph={graph} variant="local" label={`${agent.name}'s notes and how they link`} onOpen={(n) => n.path && go({ view: "vault", path: n.path })} className="absolute inset-1.5" />
        )}
      </div>
      <Section title="Recent notes">
        <div className={CARD}>
          {recent.map((n) => (
            <Line key={n.path} label={n.title || n.path.split("/").pop()!.replace(/\.md$/, "")} value={n.updatedAt ? timeAgo(new Date(n.updatedAt).toISOString()) : undefined} onClick={() => go({ view: "vault", path: n.path })} />
          ))}
          <Line label={`Open all of ${agent.name}'s memory`} to={`#/vault/agents/${agent.id}`} />
        </div>
      </Section>
    </div>
  );
}

// --- Library ------------------------------------------------------------------

interface NoteRow {
  path: string;
  title?: string;
  updatedAt?: number;
}
interface SharedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploaderKind: string;
  uploaderId: string;
  createdAt: string;
}
type LibraryItem = { kind: "note"; key: string; name: string; at: number; path: string } | { kind: "file"; key: string; name: string; at: number; id: string };

/** Its files: the notes in its memory folder (not its personality) and the files it sent in chats, newest first. */
export function libraryItems(agentId: string, notes: NoteRow[], files: SharedFile[]): LibraryItem[] {
  const own = notes
    .filter((n) => n.path.startsWith(`agents/${agentId}/`) && !/\/(SOUL|About)\.md$/.test(n.path))
    .map((n): LibraryItem => ({ kind: "note", key: `n:${n.path}`, name: n.title || n.path.split("/").pop()!, at: n.updatedAt ?? 0, path: n.path }));
  const sent = files.filter((f) => f.uploaderKind === "agent" && f.uploaderId === agentId).map((f): LibraryItem => ({ kind: "file", key: `f:${f.id}`, name: f.name, at: Date.parse(f.createdAt) || 0, id: f.id }));
  return [...own, ...sent].sort((a, b) => b.at - a.at);
}

/** Its files as a grid: what's in its memory folder and what it shared in chats. A click opens one. */
export function LibraryTab({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let on = true;
    Promise.all([api<NoteRow[]>("GET", "/api/vault/notes").catch(() => []), api<SharedFile[]>("GET", "/api/files").catch(() => [])]).then(([notes, files]) => on && setItems(libraryItems(agent.id, notes, files)));
    return () => {
      on = false;
    };
  }, [agent.id]);
  if (!items) return <p className="px-1 text-[13px] text-muted">Loading…</p>;
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="px-1 text-[13px] text-muted">No files yet</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={() => (it.kind === "note" ? go({ view: "vault", path: it.path }) : setPreview({ id: it.id, name: it.name }))}
              className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-card p-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Thumb item={it} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{it.name.replace(/\.md$/, "")}</span>
                <span className="block truncate text-[12px] text-muted">{it.at ? timeAgo(new Date(it.at).toISOString()) : it.kind === "note" ? "Note" : "File"}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <Line label={`${agent.name}'s memory folder`} to={`#/vault/agents/${agent.id}`} />
      {preview && <FilePreview id={preview.id} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** A tile's picture: an image file shows itself; anything else a plain line icon. */
function Thumb({ item }: { item: LibraryItem }) {
  const image = item.kind === "file" && fileKind(item.name) === "image";
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!image || item.kind !== "file") return;
    let url: string | null = null;
    let gone = false;
    fileUrl(item.id).then(
      (u) => (gone ? URL.revokeObjectURL(u) : setSrc((url = u))),
      () => {},
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [image, item]);
  return (
    <span className="grid h-[84px] place-items-center overflow-hidden rounded-[8px] bg-hover text-faint">
      {src ? <img src={src} alt="" className="size-full object-cover" /> : image ? <ImageIcon size={24} strokeWidth={1.6} /> : <FileText size={24} strokeWidth={1.6} />}
    </span>
  );
}

// --- Voice --------------------------------------------------------------------

const CallOptions = lazyView(() => import("../voice/CallScreen.tsx").then((m) => m.CallOptions));

/** How it sounds: its voice (each with Listen), saved as you pick; then calls' language and speed. */
export function VoiceTab({ agent }: { agent: Agent }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [voice, setVoice] = useState(agent.settings.voice ?? {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setVoice(agent.settings.voice ?? {}), [agent.settings.voice]);
  const pick = async (next: NonNullable<Agent["settings"]["voice"]>) => {
    setVoice(next);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { voice: next } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      <VoicePicker agent={agent} value={voice} onChange={(v) => void pick(v)} onLevel={() => {}} bare />
      {error && <p className="px-1 text-[13px] text-bad">{error}</p>}
      <Section title="Calls">
        <div className="rounded-[12px] bg-card p-3.5">
          <Suspense fallback={null}>
            <CallOptions />
          </Suspense>
        </div>
      </Section>
    </div>
  );
}

// --- Background -----------------------------------------------------------------

/**
 * Its chat's background (board ProfileSide): None, Photo or Colour, the current one ringed. Photo
 * opens the file picker, then the preview sheet; Colour opens the sheet. Nothing is saved until Set.
 */
export function BackgroundTab({ agent }: { agent: Agent }) {
  // its own background, or null while it follows the person's default (Settings)
  const bg = useAgentBackground(agent.id);
  const photo = usePhotoSrc(bg);
  const dark = useAppearance().resolvedMode === "dark";
  const [error, setError] = useState<string | null>(null);
  const sheet = useBackgroundSheet({ agent, name: agent.name, current: bg, onSet: (next) => setAgentBackground(agent.id, next) });
  const save = async (next: ChatBackground | null) => {
    setError(null);
    try {
      await setAgentBackground(agent.id, next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const kind = bg?.kind ?? null;
  const options = [
    { id: "none" as const, name: "None", style: undefined, face: "bg-hover", pick: () => void save({ kind: "none" }) },
    { id: "photo" as const, name: "Photo", style: photo ? { background: `center / cover no-repeat url("${photo}")` } : undefined, face: "bg-panel", pick: sheet.openPhoto },
    {
      id: "color" as const,
      name: "Colour",
      style: { background: bg?.kind === "color" ? colorGradient(shownColor(bg.color, dark), dark) : "conic-gradient(#74d0f7, #a98bf5, #de7699, #f4a582, #f8d97a, #bfe09a, #74d0f7)" },
      face: "",
      pick: sheet.openColour,
    },
  ];
  return (
    <div className="pt-1.5">
      <div className="flex justify-center gap-3.5" role="radiogroup" aria-label={`${agent.name}'s chat background`}>
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={kind === o.id} onClick={o.pick} className="group flex flex-col items-center gap-[7px] outline-none">
            <span className={cx("grid size-[84px] place-items-center rounded-full text-muted transition-shadow", o.face, kind === o.id ? "shadow-[0_0_0_3px_var(--ink)]" : "shadow-[inset_0_0_0_1px_var(--line)] group-hover:shadow-[0_0_0_3px_var(--line)] group-focus-visible:shadow-[0_0_0_3px_var(--line)]")} style={o.style}>
              {o.id === "photo" && !photo && (sheet.busy ? <Loader2 size={22} className="animate-spin" /> : <Plus size={22} strokeWidth={1.8} />)}
            </span>
            <span className="text-[12.5px] font-medium text-ink">{o.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-center text-[12.5px] text-muted">You see it before it's set.</p>
      {bg && (
        <p className="mt-1 text-center text-[12.5px] text-faint">
          {agent.name}'s chat only ·{" "}
          <button type="button" onClick={() => void save(null)} className="underline-offset-2 hover:text-ink hover:underline">
            Use the default
          </button>
        </p>
      )}
      {(error || sheet.error) && <p className="mt-3 text-center text-[13px] text-bad">{error || sheet.error}</p>}
      {sheet.node}
    </div>
  );
}

const listNames = (names: string[]) => (names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`);

/**
 * More: every setting the short list leaves out, one row each, each opening its part. Nothing that
 * was in the profile before is lost: effort, memory, personality, instructions, what it does,
 * watches, background checks, who can message, notifications, connections, voice, files, recent
 * runs, and Remove.
 */
export function MoreTab({ agent }: { agent: Agent }) {
  const features = useFeatures();
  const devices = useDevices();
  const me = useStore((s) => s.me);
  const members = useStore((s) => s.members);
  const dm = useStore((s) => s.channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`)));
  const [watching, setWatching] = useState<string[] | null>(null);
  useEffect(() => {
    api<{ watches: { label: string; agentIds: string[] }[] }>("GET", "/api/watches").then((r) => setWatching(r.watches.filter((w) => w.agentIds.includes(agent.id)).map((w) => w.label)), () => setWatching([]));
  }, [agent.id]);
  const to = (t: AgentTab) => href({ view: "agents", agentId: agent.id, tab: t });
  const device = devices?.find((d) => d.id === agent.nodeId);
  const headless = runsOnDevice(agent.harness);
  // "Only you", "Anyone", or the people picked: whose messages wake it
  const respond = whoCanAsk(agent, device);
  const mine = agent.settings.createdBy ? agent.settings.createdBy === me?.user.id : me?.role === "owner";
  const picked = (agent.settings.respondPeople ?? []).map((id) => members.find((m) => m.id === id)?.name).filter(Boolean);
  const who = respond === "anyone" ? "Anyone" : respond === "people" ? (picked.length ? `${mine ? "You, " : ""}${picked.join(", ")}` : "Picked people") : mine ? "Only you" : "Only its creator";
  return (
    <div className="space-y-2.5">
      <div className={CARD}>
        <Line label="What it does" value={agent.settings.role || undefined} to={to("role")} />
        <Line label="Personality" to={to("soul")} />
        <Line label="Instructions" to={to("instructions")} />
        <Line label="Permissions" value={ACCESS_LABEL[agent.settings.access ?? "edit"]} to={to("permissions")} />
        <Line label="Where it runs" to={to("computer")} />
        <Line label="Memory settings" to={to("memory")} />
        {headless && <Line label="Effort" value={agent.settings.effort ? effortName(agent.settings.effort) : "Default"} to={to("effort")} />}
      </div>
      <div className={CARD}>
        <Line label="Watches" value={watching && watching.length > 0 ? listNames(watching) : undefined} to={to("watches")} />
        {features.background && <Line label="Background checks" to={to("background")} />}
        <Line label="Who can message" value={who} to={to("access")} />
        <Line label="Notifications" grow>
          <Toggle label={`Notifications from ${agent.name}`} on={dm ? dm.notify !== "mute" : true} disabled={!dm} onChange={(v) => dm && void setChannelPrefs(dm, { notify: v ? "default" : "mute" })} />
        </Line>
        <Line label="Connections" to={to("connect")} />
      </div>
      <div className={CARD}>
        <Line label="Voice and calls" to={to("voice")} />
        <Line label="Files" to={to("library")} />
        <Line label="Recent runs" to={to("runs")} />
      </div>
      <a href={to("remove")} className={cx(CARD, "flex min-h-[44px] items-center justify-center text-[14px] font-medium text-bad hover:bg-hover")}>
        Remove {agent.name}
      </a>
    </div>
  );
}

/** What it does: the one line under its name in lists (More › What it does). */
export function RolePart({ agent }: { agent: Agent }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  return (
    <div className={cx(CARD, "px-3.5 py-2")}>
      {canEdit ? (
        <InPlace look="bare"
          value={agent.settings.role ?? ""}
          onSave={async (role) => {
            await api("PATCH", `/api/agents/${agent.id}`, { settings: { role } });
            await refreshAgents();
          }}
          label="What it does"
          placeholder="What it does, in a few words"
          maxLength={60}
          className="h-9 w-full text-[14px]"
        />
      ) : (
        <p className="py-1.5 text-[14px]">{agent.settings.role || "Nothing written yet"}</p>
      )}
    </div>
  );
}

/** In Watches: ask it, in its chat, to keep an eye on something new. */
export function WatchSomething({ agent }: { agent: Agent }) {
  return (
    <div className={CARD}>
      <Line label="Watch something new" icon={<MessageSquarePlus size={16} />} onClick={() => void openDm(agent.id, "Keep an eye on ")} />
    </div>
  );
}
