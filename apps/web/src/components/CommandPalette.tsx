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

interface Row {
  key: string;
  group: string;
  icon: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  run: () => void;
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
    const chans = results ? results.channels : channels.filter((c) => c.kind === "channel" && c.joined).slice(0, 6);
    for (const c of chans) out.push({ key: `c:${c.id}`, group: "Channels", icon: <Hash size={15} />, label: c.name, hint: c.topic, run: () => go({ view: "chat", channelId: c.id, threadId: null }) });
    const ags = results ? results.agents : agents.slice(0, 6);
    for (const a of ags)
      out.push({
        key: `a:${a.id}`,
        group: "Agents",
        icon: <AgentAvatar agent={a} size={18} badge={false} />,
        label: (
          <>
            {a.name} <span className="text-faint">@{a.handle}</span>
          </>
        ),
        hint: "Message",
        run: () => openDm(a.id),
      });
    for (const m of results?.messages ?? [])
      out.push({
        key: `m:${m.id}`,
        group: "Messages",
        icon: <MessageSquare size={15} />,
        label: <span className="truncate">{m.body.slice(0, 120)}</span>,
        hint: m.channelName.startsWith("dm:") ? "DM" : `#${m.channelName}`,
        run: () => go({ view: "chat", channelId: m.channelId, threadId: m.threadId }),
      });
    for (const n of results?.notes ?? []) out.push({ key: `n:${n.path}`, group: "Memory", icon: <FileText size={15} />, label: n.title, hint: n.path, run: () => go({ view: "vault", path: n.path }) });
    const actions: Row[] = [
      { key: "x:agent", group: "Actions", icon: <Plus size={15} />, label: "Add an agent", run: () => go({ view: "agents", agentId: null }) },
      { key: "x:vault", group: "Actions", icon: <BookOpen size={15} />, label: "Open memory", run: () => go({ view: "vault", path: null }) },
      { key: "x:devices", group: "Actions", icon: <Server size={15} />, label: "Devices", run: () => go({ view: "nodes" }) },
      { key: "x:settings", group: "Actions", icon: <Settings size={15} />, label: "Settings", run: () => go({ view: "settings" }) },
      { key: "x:agents", group: "Actions", icon: <Bot size={15} />, label: "Manage agents", run: () => go({ view: "agents", agentId: null }) },
    ];
    out.push(...actions.filter((a) => !needle || String(a.label).toLowerCase().includes(needle)));
    return out;
  }, [q, results, channels, agents]);

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
      <div role="dialog" aria-label="Search everything" className="w-full max-w-xl rounded-2xl border border-line bg-panel shadow-panel overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-13 border-b border-line">
          <Search size={17} className="text-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search channels, agents, messages and memory…"
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
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1.5">
          {rows.length === 0 && <p className="px-4 py-8 text-sm text-muted text-center">Nothing found for “{q}”.</p>}
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? (lastGroup = r.group) : null;
            return (
              <div key={r.key}>
                {header && <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{header}</div>}
                <button
                  data-index={i}
                  onMouseMove={() => setSel(i)}
                  onClick={() => choose(r)}
                  className={cx("w-full px-4 h-10 flex items-center gap-3 text-sm text-left", i === sel && "bg-hover")}
                >
                  <span className="text-muted shrink-0 grid place-items-center w-5">{r.icon}</span>
                  <span className="min-w-0 flex-1 truncate flex items-center gap-1">{r.label}</span>
                  {r.hint && <span className="text-xs text-faint truncate max-w-[40%]">{r.hint}</span>}
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
