import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, Blocks, Brain, Building2, CornerDownLeft, FileText, Ghost, Hash, Inbox, LifeBuoy, ListTodo, MessageSquare, Monitor, Plug, Plus, Search, Server, Settings, SquarePen, Store, Users, Wand2 } from "lucide-react";
import type { Agent, Channel, Message } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import { go, href } from "../router.ts";
import { openDm } from "../openDm.ts";
import { useFeatures } from "../features.ts";
import { NewOrgDialog } from "./OrgSwitcher.tsx";
import { startNewAgent } from "./ChatList.tsx";
import { chatsTarget } from "./Rail.tsx";
import { AgentAvatar, cx, harnessLabel } from "./ui.tsx";

interface Results {
  channels: Channel[];
  agents: Agent[];
  messages: (Message & { channelName: string })[];
  notes: { path: string; title: string; snippet: string }[];
}

type Kind = "Note" | "Task" | "Routine" | "Message" | "Agent" | "Team" | "Page" | "Action";

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
  /** a keyboard shortcut shown on the right */
  hint?: string;
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
  // pages and create rows say what they are by where they sit
  if (kind === "Page" || kind === "Action") return null;
  return <span className="shrink-0 text-xs text-faint">{kind}</span>;
}

/** ⌘K / Ctrl+K: jump anywhere, search messages and memory, or make something new. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPalette);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useStore.getState().paletteOpen);
        return;
      }
      // ⌘1 Inbox, ⌘2 Chats, ⌘3 Agents, ⌘4 Computers, ⌘, Settings
      const guest = useStore.getState().me?.role === "guest";
      const target = { "1": href({ view: "dashboard" }), "2": chatsTarget(), "3": href({ view: "agents", agentId: null }), "4": guest ? null : href({ view: "computers", computerId: null }), ",": href({ view: "settings", page: null }) }[e.key];
      if (target) {
        e.preventDefault();
        useStore.getState().setPalette(false);
        location.hash = target;
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [setOpen]);

  const [newOrg, setNewOrg] = useState(false);
  return (
    <>
      {open && <Palette onClose={() => setOpen(false)} onNewOrg={() => setNewOrg(true)} />}
      {newOrg && <NewOrgDialog onClose={() => setNewOrg(false)} />}
    </>
  );
}

function Palette({ onClose, onNewOrg }: { onClose: () => void; onNewOrg: () => void }) {
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const teams = useTeams();
  const guest = useStore((s) => s.me?.role) === "guest";
  const features = useFeatures();
  const [q, setQ] = useState(() => useStore.getState().paletteSeed);
  const [results, setResults] = useState<Results | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchGeneration = useRef(0);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!q.trim()) return setResults(null);
    const t = setTimeout(() => api<Results>("GET", `/api/search?q=${encodeURIComponent(q)}`).then((r) => generation === searchGeneration.current && setResults(r), () => {}), 120);
    return () => {
      searchGeneration.current++;
      clearTimeout(t);
    };
  }, [q]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const needle = q.trim().toLowerCase();
    const lookup: Lookup = {
      people: Object.fromEntries(members.map((m) => [m.id, m.name])),
      agents: Object.fromEntries(agents.map((a) => [a.id, a.handle])),
      // a team's memory folder (teams/<name>) shows as its channel
      teams: Object.fromEntries(teams.filter((t) => t.folder.startsWith("teams/")).map((t) => [t.folder.split("/")[1], `#${t.name}`])),
    };
    const chans = results ? results.channels : channels.filter((c) => c.kind === "channel" && c.joined && !c.archivedAt).sort((x, y) => Date.parse(y.last?.at ?? y.createdAt) - Date.parse(x.last?.at ?? x.createdAt)).slice(0, 6);
    for (const c of chans)
      out.push({ key: `c:${c.id}`, group: results ? "Teams" : "Chats", kind: "Team", icon: <Users size={15} />, label: c.name, sub: cleanPreview(c.topic ?? "") || undefined, run: () => go({ view: "chat", channelId: c.id, threadId: null }) });
    const ags = results ? results.agents : agents.slice(0, 6);
    for (const a of ags)
      out.push({
        key: `a:${a.id}`,
        group: results ? "Agents" : "Chats",
        kind: "Agent",
        icon: <AgentAvatar agent={a} size={18} badge={false} />,
        label: (
          <>
            {a.name} <span className="text-faint">@{a.handle}</span>
          </>
        ),
        sub: harnessLabel(a.harness),
        run: () => void openDm(a.id),
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
        run: () => go({ view: "chat", channelId: m.channelId, threadId: m.threadId, messageId: m.id }),
      });
    }
    for (const n of results?.notes ?? []) {
      const preview = cleanPreview(n.snippet);
      out.push({
        key: `n:${n.path}`,
        group: "Memory",
        kind: "Note",
        icon: <FileText size={15} />,
        label: cleanPreview(n.title, 80) || humanize(n.path.split("/").pop() ?? "") || "Untitled note",
        sub: [preview, noteLocation(n.path, n.title, lookup)].filter(Boolean).join(" · "),
        tip: n.path,
        run: () => go({ view: "vault", path: n.path }),
      });
    }
    const create = (key: string, icon: ReactNode, label: string, run: () => void, also = ""): Row & { words: string } => ({ key: `x:${key}`, group: "Create", kind: "Action", icon, label, run, words: `${label} ${also}` });
    const actions = [
      create("chat", <MessageSquare size={15} />, "New chat", () => useStore.setState({ newChatOpen: true }), "talk message direct"),
      ...(!guest ? [create("agent", <Plus size={15} />, "New agent", startNewAgent, "add create helper")] : []),
      ...(!guest ? [create("team", <Users size={15} />, "New team", () => useStore.setState({ channelBrowser: { sectionId: null, create: true } }), "add create browse teams channels group")] : []),
      ...(!guest && features.tasks ? [create("task", <SquarePen size={15} />, "New task", () => useStore.setState({ newTaskOpen: true }), "create assign work")] : []),
      create("org", <Building2 size={15} />, "New organization", onNewOrg, "create workspace"),
    ];
    // every page, including the ones that no longer have a place on the rail
    const pageRow = (key: string, icon: ReactNode, label: string, run: () => void, also = "", hint?: string): Row & { words: string } => ({ key: `p:${key}`, group: "Go to", kind: "Page", icon, label, hint, run, words: `${label} ${also}` });
    const pages = [
      pageRow("inbox", <Inbox size={15} />, "Inbox", () => go({ view: "dashboard" }), "dashboard waiting approvals", "⌘1"),
      pageRow("chats", <MessageSquare size={15} />, "Chats", () => (location.hash = chatsTarget()), "conversations teams", "⌘2"),
      pageRow("agents", <Ghost size={15} />, "Agents", () => go({ view: "agents", agentId: null }), "manage helpers", "⌘3"),
      ...(!guest ? [pageRow("computers", <Monitor size={15} />, "Computers", () => go({ view: "computers", computerId: null }), "screens vm", "⌘4")] : []),
      pageRow("vault", <BookOpen size={15} />, "Memory", () => go({ view: "vault", path: null }), "notes vault"),
      ...(features.tasks ? [pageRow("tasks", <ListTodo size={15} />, "Tasks", () => go({ view: "tasks" }), "work board")] : []),
      pageRow("marketplace", <Store size={15} />, "Marketplace", () => go({ view: "marketplace" }), "apps skills shop connect"),
      pageRow("devices", <Server size={15} />, "Devices", () => go({ view: "nodes" }), "nodes machines"),
      pageRow("connectors", <Plug size={15} />, "Connected apps", () => go({ view: "connectors" }), "connectors mcp gmail slack integrations"),
      pageRow("skills", <Wand2 size={15} />, "Skills", () => go({ view: "skills" }), "shop learn"),
      pageRow("mods", <Blocks size={15} />, "Mods", () => go({ view: "mods" }), "features optional parts"),
      pageRow("about", <Brain size={15} />, "About you", () => go({ view: "about" }), "profile memory"),
      pageRow("help", <LifeBuoy size={15} />, "Help", () => go({ view: "help" }), "support setup"),
      pageRow("settings", <Settings size={15} />, "Settings", () => go({ view: "settings" }), "preferences organization features", "⌘,"),
    ];
    const match = (r: { words: string }) => !needle || r.words.toLowerCase().includes(needle);
    // with nothing typed, making something comes first; while searching, the results do
    if (!needle) return [...actions, ...out, ...pages];
    out.push(...actions.filter(match), ...pages.filter(match));
    return out;
  }, [q, results, channels, agents, members, teams, guest, features, onNewOrg]);

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
    <div className="fixed inset-0 z-50 bg-panel md:bg-black/45 md:flex md:items-start md:justify-center md:p-3 md:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search everything" className="h-full md:h-auto w-full md:max-w-[620px] flex flex-col overflow-hidden bg-panel md:bg-card md:rounded-[24px] md:border md:border-control-line md:shadow-[0_24px_60px_rgb(0_0_0/0.5)] safe-top">
        <div className="flex items-center gap-3 px-[18px] md:px-4 pt-3 md:pt-0 pb-2 md:pb-0 md:h-[60px] md:border-b md:border-line">
          <label className="flex-1 min-w-0 flex items-center gap-2.5 h-[46px] md:h-auto rounded-full bg-card md:bg-transparent px-4 md:px-0 text-faint">
            <Search size={18} strokeWidth={2} className="shrink-0" />
            <input
              autoFocus
              role="combobox"
              aria-label="Search everything"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={rows[sel] ? `palette-opt-${sel}` : undefined}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search or create…"
              className="flex-1 min-w-0 bg-transparent outline-none text-base md:text-[16px] md:h-14 text-ink placeholder:text-faint"
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
                if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, rows.length - 1)));
                if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
                if (e.key === "Enter") (e.preventDefault(), choose(rows[sel]));
              }}
            />
            <kbd className="hidden md:block text-xs font-sans text-faint">esc</kbd>
          </label>
          <button onClick={onClose} className="md:hidden h-11 px-1 text-base text-muted hover:text-ink">
            Cancel
          </button>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="flex-1 md:flex-none md:max-h-[55vh] overflow-y-auto px-2.5 md:px-2 pb-2">
          {rows.length === 0 && <p className="px-4 py-8 text-sm text-muted text-center">Nothing found for “{q}”.</p>}
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? (lastGroup = r.group) : null;
            return (
              <div key={r.key} role="presentation">
                {header && (
                  <div role="presentation" className="px-3 pt-3.5 pb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">
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
                  className={cx("w-full px-3 flex items-center gap-3 text-[15px] text-left rounded-xl", r.sub ? "py-2 min-h-[52px]" : "min-h-11", i === sel && "bg-hover")}
                >
                  <span className="text-muted shrink-0 grid place-items-center w-5">{r.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block min-w-0 truncate">{r.label}</span>
                    {r.sub && <span className="block truncate text-[13px] text-muted">{r.sub}</span>}
                  </span>
                  {r.hint ? <span className="shrink-0 text-xs text-faint">{r.hint}</span> : <KindChip kind={r.kind} />}
                  {i === sel && <CornerDownLeft size={13} className="hidden md:block text-faint shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hidden md:flex items-center gap-4 px-4 h-10 border-t border-line text-xs text-faint">
          <span>↑↓ Move</span>
          <span>↵ Open</span>
        </div>
      </div>
    </div>
  );
}
