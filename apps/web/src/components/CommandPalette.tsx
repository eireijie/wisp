import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, Bot, CornerDownLeft, FileText, Hash, MessageSquare, Plus, Search, Server, Settings } from "lucide-react";
import type { Agent, Channel, Message } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, cx } from "./ui.tsx";

interface Results {
  channels: Channel[];
  agents: Agent[];
  messages: (Message & { channelName: string })[];
  notes: { path: string; title: string; snippet: string }[];
}

type Kind = "Note" | "Task" | "Routine" | "Message" | "Agent" | "Channel" | "Page";

interface Row {
  key: string;
  group: string;
  kind: Kind;
  icon: ReactNode;
  label: ReactNode;
  /** muted second line: a short preview and where the result lives */
  sub?: string;
  /** raw detail for the tooltip only (never shown) */
  tip?: string;
  run: () => void;
}

export interface Lookup {
  people: Record<string, string>;
  agents: Record<string, string>;
  teams: Record<string, string>;
}

const ID_TOKEN = /\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b/g;

/** Internal ids look like usr_yN7fNNXTN6NP: a short prefix and a random tail with a digit or capital. */
function stripIds(text: string): string {
  return text.replace(ID_TOKEN, (m) => (/[0-9A-Z]/.test(m.slice(m.indexOf("_") + 1)) ? "" : m));
}

/** One clean line for a result: no Markdown, search highlights, ids, paths or agent-only instructions. */
export function cleanPreview(text: string, max = 140): string {
  const kept = (text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[[^\]]*\]\s*$/.test(l) && !/^\s*\[(system|meta|internal)\b/i.test(l))
    .join("\n");
  let t = kept
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|[\s(])[*_]+(?=\S)/g, "$1")
    .replace(/(\S)[*_]+(?=[\s).,;:!?]|$)/g, "$1")
    .replace(/`+/g, "")
    // agent-only hints that can trail a task message
    .replace(/This is task\s+\S+\.?/gi, " ")
    .replace(/When finished, report back[^.]*\.?/gi, " ")
    // vault paths, then bare ids
    .replace(/\b(?:people|agents|teams|groups|shared)\/[\w./-]+/gi, " ")
    .replace(/\b(?:[\w-]+\/)+[\w-]+\.md\b/gi, " ");
  t = stripIds(t).replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

/** "dinner-preferences.md" becomes "Dinner preferences". */
function humanize(name: string): string {
  const t = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** Where a note lives, in words: "Memory › Shared › Dinner preferences". */
export function noteLocation(path: string, title: string, lookup: Lookup): string {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? "";
  const last = cleanPreview(title, 60) || humanize(file) || "Note";
  const crumbs = ["Memory"];
  const [top, id, ...rest] = parts;
  if (top === "shared") crumbs.push("Shared", ...[id, ...rest].filter(Boolean).map(humanize));
  else if (top === "people") crumbs.push((id && lookup.people[id]) || "A person", ...rest.map(humanize));
  else if (top === "agents") crumbs.push(id && lookup.agents[id] ? `@${lookup.agents[id]}` : "An agent", ...rest.map(humanize));
  else if (top === "teams") crumbs.push((id && lookup.teams[id]) || "A team", ...rest.map(humanize));
  else if (top === "groups") crumbs.push("Groups", ...[id, ...rest].filter(Boolean).map(humanize));
  else crumbs.push(...parts.map(humanize));
  if (crumbs[crumbs.length - 1] !== last) crumbs.push(last);
  return crumbs.join(" › ");
}

/** What a message result is: one that hands out a task, one about a routine, or just a message. */
export function messageKind(m: Pick<Message, "parts">): "Task" | "Routine" | "Message" {
  const parts = m.parts ?? [];
  if (parts.some((p) => p.type === "task")) return "Task";
  if (parts.some((p) => p.type === "routine")) return "Routine";
  return "Message";
}

/** "DM with @maya" or "#general". DM channel names end with the agent id. */
export function messageLocation(channelName: string, agentHandles: Record<string, string>): string {
  if (!channelName.startsWith("dm:")) return `#${channelName}`;
  const handle = agentHandles[channelName.slice(channelName.lastIndexOf(":") + 1)];
  return handle ? `DM with @${handle}` : "Direct message";
}

function KindChip({ kind }: { kind: Kind }) {
  return <span className="shrink-0 rounded border border-line bg-chip px-1.5 text-[10px] font-medium leading-4 text-muted">{kind}</span>;
}

/** ⌘K / Ctrl+K: jump anywhere, search messages and memory, or run an action. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [setOpen]);

  return open ? <Palette onClose={() => setOpen(false)} /> : null;
}

function Palette({ onClose }: { onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setResults(null);
    const t = setTimeout(() => api<Results>("GET", `/api/search?q=${encodeURIComponent(q)}`).then(setResults, () => {}), 120);
    return () => clearTimeout(t);
  }, [q]);

  const openDm = async (agentId: string) => {
    const existing = channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
    const ch = existing ?? (await api<{ id: string }>("POST", `/api/dm/${agentId}`));
    if (!existing) await useStore.getState().refreshChannels();
    go({ view: "chat", channelId: ch.id, threadId: null });
  };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const needle = q.trim().toLowerCase();
    const lookup: Lookup = {
      people: Object.fromEntries(members.map((m) => [m.id, m.name])),
      agents: Object.fromEntries(agents.map((a) => [a.id, a.handle])),
      teams: Object.fromEntries(teams.map((t) => [t.id, t.name])),
    };
    const chans = results ? results.channels : channels.filter((c) => c.kind === "channel" && c.joined).slice(0, 6);
    for (const c of chans)
      out.push({ key: `c:${c.id}`, group: "Channels", kind: "Channel", icon: <Hash size={15} />, label: c.name, sub: cleanPreview(c.topic ?? "") || undefined, run: () => go({ view: "chat", channelId: c.id, threadId: null }) });
    const ags = results ? results.agents : agents.slice(0, 6);
    for (const a of ags)
      out.push({
        key: `a:${a.id}`,
        group: "Agents",
        kind: "Agent",
        icon: <AgentAvatar agent={a} size={18} badge={false} />,
        label: (
          <>
            {a.name} <span className="text-faint">@{a.handle}</span>
          </>
        ),
        sub: "Send a direct message",
        run: () => openDm(a.id),
      });
    for (const m of results?.messages ?? []) {
      const kind = messageKind(m);
      out.push({
        key: `m:${m.id}`,
        group: "Messages",
        kind,
        icon: <MessageSquare size={15} />,
        label: cleanPreview(m.body, 100) || `Untitled ${kind.toLowerCase()}`,
        sub: messageLocation(m.channelName, lookup.agents),
        run: () => go({ view: "chat", channelId: m.channelId, threadId: m.threadId }),
      });
    }
    for (const n of results?.notes ?? []) {
      const preview = cleanPreview(n.snippet);
      out.push({
        key: `n:${n.path}`,
        group: "Notes",
        kind: "Note",
        icon: <FileText size={15} />,
        label: cleanPreview(n.title, 80) || humanize(n.path.split("/").pop() ?? "") || "Untitled note",
        sub: [preview, noteLocation(n.path, n.title, lookup)].filter(Boolean).join(" · "),
        tip: n.path,
        run: () => go({ view: "vault", path: n.path }),
      });
    }
    const actions: Row[] = [
      { key: "x:agent", group: "Pages", kind: "Page", icon: <Plus size={15} />, label: "Add an agent", run: () => go({ view: "agents", agentId: null }) },
      { key: "x:vault", group: "Pages", kind: "Page", icon: <BookOpen size={15} />, label: "Open memory", run: () => go({ view: "vault", path: null }) },
      { key: "x:devices", group: "Pages", kind: "Page", icon: <Server size={15} />, label: "Devices", run: () => go({ view: "nodes" }) },
      { key: "x:settings", group: "Pages", kind: "Page", icon: <Settings size={15} />, label: "Settings", run: () => go({ view: "settings" }) },
      { key: "x:agents", group: "Pages", kind: "Page", icon: <Bot size={15} />, label: "Manage agents", run: () => go({ view: "agents", agentId: null }) },
    ];
    out.push(...actions.filter((a) => !needle || String(a.label).toLowerCase().includes(needle)));
    return out;
  }, [q, results, channels, agents, members, teams]);

  useEffect(() => {
    setSel(0);
  }, [rows.length, q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    r.run();
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search everything" className="w-full max-w-xl rounded-2xl border border-line bg-panel shadow-panel overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-13 border-b border-line">
          <Search size={17} className="text-faint" />
          <input
            autoFocus
            role="combobox"
            aria-label="Search everything"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[sel] ? `palette-opt-${sel}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search channels, agents, messages and notes…"
            className="flex-1 bg-transparent outline-none text-[15px] h-12 placeholder:text-faint"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, rows.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              if (e.key === "Enter") (e.preventDefault(), choose(rows[sel]));
            }}
          />
          <kbd className="text-[11px] text-faint">esc</kbd>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="max-h-[55vh] overflow-y-auto py-1.5">
          {rows.length === 0 && <p className="px-4 py-8 text-sm text-muted text-center">Nothing found for “{q}”.</p>}
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? (lastGroup = r.group) : null;
            return (
              <div key={r.key} role="presentation">
                {header && (
                  <div role="presentation" className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                    {header}
                  </div>
                )}
                <button
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  tabIndex={-1}
                  title={r.tip}
                  data-index={i}
                  onMouseMove={() => setSel(i)}
                  onClick={() => choose(r)}
                  className={cx("w-full px-4 flex items-center gap-3 text-sm text-left", r.sub ? "py-1.5 min-h-[44px]" : "h-10", i === sel && "bg-hover")}
                >
                  <span className="text-muted shrink-0 grid place-items-center w-5">{r.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="min-w-0 truncate flex items-center gap-1">{r.label}</span>
                      <KindChip kind={r.kind} />
                    </span>
                    {r.sub && <span className="block truncate text-xs text-muted">{r.sub}</span>}
                  </span>
                  {i === sel && <CornerDownLeft size={13} className="text-faint shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
