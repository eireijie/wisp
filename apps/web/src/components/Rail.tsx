import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { STOPS, TOTAL, seenCount } from "../tour.ts";
import { createPortal } from "react-dom";
import { Apple, Bell, BookOpen, Building2, Check, ChevronLeft, ChevronRight, ExternalLink, FolderPlus, Sparkles, HardDrive, LayoutGrid, LifeBuoy, ListTodo, Compass, MessageSquarePlus, Search, SquareTerminal, Store, Users } from "lucide-react";
import { PlaceIcon, PlusLine, type PlaceKey } from "./r11Icons.tsx";
import { BubbleIcon } from "./icons.tsx";
import { GITHUB_URL } from "@bubble-ai/core";
import { startTour } from "./tour/tourRun.ts";
import { useReadyChecklist } from "../onboarding.ts";
import type { FeatureKey, Section } from "@bubble-ai/core";
import { api } from "../api.ts";
import { useFeatures } from "../features.ts";
import { useStore, useInboxCount, usePrefs } from "../store.ts";
import { liveShape } from "../liveShape.ts";
import { machinesOn, useDevices } from "../devices.ts";
import { go, href, SETTINGS_PAGES, type Route } from "../router.ts";
import { openDm } from "../openDm.ts";
import { ComputersIcon } from "./icons.tsx";
import { NewOrgDialog, OrgList, useOrgs } from "./OrgSwitcher.tsx";
import { Menu, cx } from "./ui.tsx";
import { ChatAvatar, chatPreviewLine, startNewAgent, type Chat, type PreviewLine } from "./ChatList.tsx";
import { BLUE_DOT, RailChatMenu, SideList, newSideSection, useSideLayout } from "./SideList.tsx";
import { placeChats } from "../sidebarLayout.ts";
import { SIDEBAR, SIDEBAR_CLOSE_MS, SIDEBAR_EASE, SIDEBAR_OPEN_MS, SIDEBAR_TOGGLE, dragWidth, loadSidebar, saveSidebar, settle, stepWidth, type SidebarState } from "../sidebarWidth.ts";

/** Where the Chats item goes, and what desktops open on: the chat you were last in, kept on this device. */
const LAST_CHAT_KEY = "bubble.last-chat";
let lastChat: string | null = null;
export function rememberChat(id: string | null) {
  if (!id || id === lastChat) return;
  lastChat = id;
  try {
    localStorage.setItem(LAST_CHAT_KEY, id);
  } catch {}
}
function keptChat(): string | null {
  if (lastChat) return lastChat;
  try {
    return localStorage.getItem(LAST_CHAT_KEY);
  } catch {
    return null;
  }
}
export function chatsTarget(): string {
  const id = homeChat(useStore.getState().channels, false);
  return id ? href({ view: "chat", channelId: id, threadId: null }) : href({ view: "chats" });
}

/**
 * The chat desktops open on (#/): the one you were last in when it's still there, else (with
 * `newest`) the chat or team with the newest message. Null when there is none.
 */
export function homeChat(channels: { id: string; kind: string; joined?: boolean; archivedAt?: string | null; last?: { at: string } | null; createdAt: string }[], newest = true): string | null {
  const kept = keptChat();
  const open = (c: (typeof channels)[number]) => !c.archivedAt && (c.kind !== "channel" || c.joined);
  if (kept && channels.some((c) => c.id === kept && open(c))) return kept;
  if (!newest) return null;
  let best: { id: string; at: number } | null = null;
  for (const c of channels) {
    if (!open(c)) continue;
    const at = Date.parse(c.last?.at ?? c.createdAt);
    if (!best || at > best.at) best = { id: c.id, at };
  }
  return best?.id ?? null;
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** You: your initials on a glass circle. On desktops it opens Settings; on phones, the You page. */
export function UserAvatarButton({ size, desktop }: { size?: number; desktop?: boolean }) {
  size ??= desktop ? 38 : 44;
  const me = useStore((s) => s.me)!;
  const { orgs } = useOrgs();
  const elsewhere = orgs.some((o) => o.unread && !o.current && o.id !== me.workspace.id);
  return (
    <a href={desktop ? href({ view: "settings", page: null }) : href({ view: "you" })} aria-label="You and settings" title="You and settings" data-tour="you" className="lg grid shrink-0 place-items-center rounded-full font-semibold" style={{ width: size, height: size, fontSize: 13 }}>
      <span>{initialsOf(me.user.name)}</span>
      {elsewhere && <span className="absolute right-0 bottom-0 z-[2] size-3 rounded-full bg-badge border-2 border-app" aria-label="New messages in another workspace" />}
    </a>
  );
}

/**
 * What mods add to the app's places while they're on. On desktops every entry sits in the menu
 * behind your picture; "more" items also go in More on phones. A mod adds its entry here instead
 * of its own check in the sidebar.
 */
const MOD_NAV: { feature: FeatureKey; place: "rail" | "more"; label: string; icon: (size: number) => ReactNode; to: Route; views: Route["view"][] }[] = [
  { feature: "code", place: "rail", label: "Code", icon: (size) => <SquareTerminal size={size} strokeWidth={1.8} />, to: { view: "code" }, views: ["code"] },
  { feature: "storage", place: "more", label: "Storage", icon: (size) => <HardDrive size={size} strokeWidth={1.8} />, to: { view: "settings", page: "storage" }, views: [] },
  { feature: "apple", place: "more", label: "Apple", icon: (size) => <Apple size={size} strokeWidth={1.8} />, to: { view: "settings", page: "apple" }, views: [] },
];

function modNav(features: Record<FeatureKey, boolean>, place: "rail" | "more") {
  return MOD_NAV.filter((m) => m.place === place && features[m.feature]);
}

/** The views More opens, so More shows active on them. */
export const MORE_VIEWS: Route["view"][] = ["more", "vault", "tasks", "marketplace", "connectors", "skills", "mods", "help", "agents"];

/** What More holds, the same on desktops and phones. */
export function useMoreItems(guest: boolean, size = 16, withAgents = false, withRail = false): { label: string; icon: ReactNode; to: Route }[] {
  const features = useFeatures();
  const icon = { size, strokeWidth: 1.8 };
  return [
    ...(withAgents ? [{ label: "All agents", icon: <BubbleIcon {...icon} />, to: { view: "agents", agentId: null } as Route }] : []),
    { label: "Memory", icon: <BookOpen {...icon} />, to: { view: "vault", path: null } },
    ...(!guest && features.tasks ? [{ label: "Tasks", icon: <ListTodo {...icon} />, to: { view: "tasks" } as Route }] : []),
    ...(!guest ? [...(withRail ? modNav(features, "rail") : []), ...modNav(features, "more")].map((m) => ({ label: m.label, icon: m.icon(size), to: m.to })) : []),
    ...(!guest ? [{ label: "Connect apps", icon: <Store {...icon} />, to: { view: "marketplace" } as Route }] : []),
    { label: "Help", icon: <LifeBuoy {...icon} />, to: { view: "help" } },
  ];
}

/** A row of the wide sidebar (60px, a big wisp, a rounded tile when it's the open one), and its square on the rail. Hover eases in; a press gives a little. */
const ITEM = "relative flex h-[60px] w-full items-center gap-3 rounded-[12px] px-2 text-left text-[16px] outline-none transition-[background-color,transform] duration-150 ease-out active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
// the narrow rail (100px): a 56px agent in a 64px highlight leaves 18px either side, like the 20px around the window buttons
const TILE = "relative grid size-[64px] place-items-center rounded-[16px] outline-none transition-[background-color,transform] duration-150 ease-out active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";

/** How many notes the Memory vault holds (the pill at the foot), fetched again when notes change. */
function useNoteCount(guest: boolean): number | null {
  const version = useStore((s) => s.memoryVersion);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (guest) return;
    let on = true;
    api<unknown[]>("GET", "/api/vault/notes").then((all) => on && setN(all.length), () => {});
    return () => {
      on = false;
    };
  }, [guest, version]);
  return n;
}

/** A small violet dot that breathes while an agent is working. */
function WorkDot({ corner }: { corner?: boolean }) {
  return <span aria-hidden className={cx("side-pulse shrink-0 rounded-full bg-wisp", corner ? "absolute bottom-[4px] right-[4px] size-[7px] box-content border-2 border-sidebar" : "size-[6px]")} />;
}

/**
 * A floating panel drawn on the page itself, because the sidebar clips what's inside it.
 * An outside click, Escape or a window resize closes it. It appears at once.
 */
function Float({ at, role, label, className, onClose, children }: { at: CSSProperties; role: "menu" | "dialog"; label: string; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : e.type === "resize" || !ref.current?.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
    };
  }, []);
  return createPortal(
    <div ref={ref} role={role} aria-label={label} style={{ position: "fixed", ...at }} className={cx("pop-glass z-[100]", className)}>
      {children}
    </div>,
    document.body,
  );
}

function useSideChats(): Chat[] {
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  return useMemo(() => {
    const out: Chat[] = [];
    for (const a of agents) {
      const dm = channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${a.id}`));
      out.push({ key: `a:${a.id}`, kind: "dm", channel: dm ?? null, agent: a, name: a.name, at: dm?.last ? Date.parse(dm.last.at) : 0, unread: dm?.unread ?? 0, pinned: !!dm?.starred, muted: dm?.notify === "mute", sectionId: dm?.sectionId ?? null });
    }
    for (const c of channels) {
      if (c.kind !== "channel" || !c.joined || c.archivedAt) continue;
      out.push({ key: `c:${c.id}`, kind: "team", channel: c, agent: null, name: c.name, at: Date.parse(c.last?.at ?? c.createdAt), unread: c.unread, pinned: c.starred, muted: c.notify === "mute", sectionId: c.sectionId });
    }
    return out.sort((x, y) => y.at - x.at || x.name.localeCompare(y.name));
  }, [channels, agents]);
}

/** One group of the sidebar. `plain` has no header; `section` is one the person made. */
export interface SideGroup {
  id: string;
  label: string;
  chats: Chat[];
  plain?: boolean;
  section?: Section;
}

/**
 * The sidebar's groups: Pinned, then every agent and team that's in no section as one list with
 * no header (newest first, the order the chats come in), then the person's own sections. A
 * section shows once it exists, even empty; Pinned and the plain list only when they hold something.
 */
export function sidebarGroups(chats: Chat[], sections: Section[]): SideGroup[] {
  const ids = new Set(sections.map((s) => s.id));
  const groups: SideGroup[] = [
    { id: "pinned", label: "Pinned", chats: chats.filter((c) => c.pinned) },
    { id: "chats", label: "Agents and teams", plain: true, chats: chats.filter((c) => !c.pinned && (!c.sectionId || !ids.has(c.sectionId))) },
    ...sections.map((s) => ({ id: s.id, label: s.name, section: s, chats: chats.filter((c) => !c.pinned && c.sectionId === s.id) })),
  ];
  return groups.filter((g) => !!g.section || g.chats.length > 0);
}

const NO_LINE: PreviewLine = { text: "", working: false };

/** The same line under a name: a row whose words didn't change keeps the line object it had. */
const sameLine = (a: PreviewLine | undefined, b: PreviewLine): a is PreviewLine => !!a && a.text === b.text && a.working === b.working && !a.needs === !b.needs && !a.icon && !b.icon;

/** A chat in the sidebar. It renders again only when its own chat or its line changes, not on every step of dragging the sidebar's edge. */
const SideRow = memo(function SideRow({ chat, chats, wide, active, activeId, line, onNewSection }: { chat: Chat; chats: readonly Chat[]; wide: boolean; active: boolean; activeId: string | null; line: PreviewLine; onNewSection: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const unread = chat.unread > 0;
  const label = `${chat.name}${unread ? `, ${chat.unread} unread` : ""}${line.working ? ", working" : ""}${line.needs ? ", needs you" : ""}`;
  // one blue dot (round 4): it needs you, or there's something unread
  const dot = !!line.needs || unread;
  const cls = cx(wide ? ITEM : TILE, active ? "bg-side-active" : "hover:bg-side-hover");
  const inner = (
    <>
      {wide && <span aria-hidden className="side-dot" style={{ background: dot ? BLUE_DOT : "transparent" }} />}
      {/* agents and teams at one size: every bubble shape fills its box (Bubble.tsx) */}
      <span className={cx("relative grid shrink-0 place-items-center", wide ? "size-[46px]" : "size-[56px]")}>
        <ChatAvatar chat={chat} size={wide ? 46 : 56} />
        {!wide && dot && <span aria-hidden className="side-tile-dot" style={{ background: BLUE_DOT }} />}
      </span>
      {wide && (
        <span className={cx("flex min-w-0 flex-1 flex-col", chat.muted && "opacity-60")}>
          <span className="truncate font-medium leading-[22px] text-ink">{chat.name}</span>
          {line.text && (
            <span className={cx("flex min-w-0 items-center gap-1.5 text-[15px] leading-[21px]", line.working ? "text-wisp-strong" : "text-muted")}>
              {line.working && <WorkDot />}
              {line.icon && <span className="inline-flex shrink-0">{line.icon}</span>}
              <span className={cx("truncate", line.working && "shimmer-text")}>{line.text}</span>
            </span>
          )}
        </span>
      )}
      {!wide && line.working && <WorkDot corner />}
    </>
  );
  const url = chat.channel ? href({ view: "chat", channelId: chat.channel.id, threadId: null }) : undefined;
  return (
    // right-click: the same menu as the wide sidebar, Pin and Unpin included (round 16)
    <div onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY }))}>
      {url ? (
        <a href={url} aria-label={label} title={wide ? undefined : label} aria-current={active ? "page" : undefined} data-bub-host="" className={cls}>{inner}</a>
      ) : (
        <button type="button" onClick={() => chat.agent && void openDm(chat.agent.id)} aria-label={label} title={wide ? undefined : label} data-bub-host="" className={cls}>{inner}</button>
      )}
      {menu && <RailChatMenu chats={chats} chat={chat} at={menu} active={activeId} line={line} onClose={() => setMenu(null)} onNewFolder={onNewSection} />}
    </div>
  );
});

/** The notes Memory held when it was last opened: the strip's dot shows only when new ones arrived since. */
const MEMORY_SEEN_KEY = "bubble.memory.seen-notes";
function useNewNotes(notes: number | null, open: boolean): boolean {
  const [seen, setSeen] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(MEMORY_SEEN_KEY);
      return v == null ? null : Number(v);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (notes == null) return;
    // the first count this device sees is the baseline; opening Memory catches up
    if (seen == null || open) {
      if (seen !== notes) setSeen(notes);
      try {
        localStorage.setItem(MEMORY_SEEN_KEY, String(notes));
      } catch {}
    }
  }, [notes, open, seen]);
  return notes != null && seen != null && notes > seen;
}

/** One place in the strip under search: a line icon with a tooltip (name, count, shortcut) and a dot when there's news. */
export interface StripPlace {
  key: string;
  label: string;
  icon: ReactNode;
  to: string;
  on: boolean;
  /** ⌘1 to ⌘5 */
  shortcut: number;
  /** said after the name in the tooltip: "1 on", "5 notes", "Off" */
  count?: string | null;
  /** a small dot at the corner: green while a computer is on, violet when new notes arrived */
  dot?: "on" | "new" | null;
  tour?: string;
}

/**
 * The places that aren't chats (canvas "Calmer layout", board A1): Computers, Memory, Connect apps,
 * Tasks and Code (when its mod is on), in that order, ⌘1 to ⌘5. Guests get Memory alone.
 */
function places(o: { guest: boolean; tasks: boolean; code: boolean; computersOn: number; notes: number | null; newNotes: boolean; open: Route | null; vaultTo: string }): StripPlace[] {
  const v = o.open?.view;
  const icon = { size: 18, strokeWidth: 1.8 };
  const all: (StripPlace | false)[] = [
    !o.guest && { key: "computers", label: "Computers", icon: <ComputersIcon size={18} />, to: href({ view: "computers", computerId: null }), on: v === "computers", shortcut: 1, count: o.computersOn > 0 ? `${o.computersOn} on` : null, dot: o.computersOn > 0 ? "on" : null, tour: "computers" },
    { key: "memory", label: "Memory", icon: <BookOpen {...icon} />, to: o.vaultTo, on: v === "vault", shortcut: 2, count: o.notes != null ? `${o.notes} ${o.notes === 1 ? "note" : "notes"}` : null, dot: o.newNotes ? "new" : null, tour: "vault" },
    !o.guest && { key: "apps", label: "Connect apps", icon: <LayoutGrid {...icon} />, to: href({ view: "marketplace" }), on: v === "marketplace" || v === "skills" || v === "connectors" || v === "mods", shortcut: 3 },
    // Tasks is a mod: while it's off the icon opens Mods, where it's switched on
    !o.guest && { key: "tasks", label: "Tasks", icon: <ListTodo {...icon} />, to: href(o.tasks ? { view: "tasks" } : { view: "marketplace", app: "m:tasks" }), on: v === "tasks", shortcut: 4, count: o.tasks ? null : "Off" },
    !o.guest && o.code && { key: "code", label: "Code", icon: <SquareTerminal {...icon} />, to: href({ view: "code" }), on: v === "code", shortcut: 5 },
  ];
  return all.filter((p): p is StripPlace => !!p);
}

/**
 * The sidebar's top row of icons: the places less Connect apps, which has its own pill at the
 * bottom of the sidebar (round 8). Exported for the tests.
 */
export function stripPlaces(o: Parameters<typeof places>[0]): StripPlace[] {
  return places(o).filter((p) => p.key !== "apps");
}

/** Where ⌘1 to ⌘5 go: the strip's places by number, or null when that one isn't there. */
export function shortcutTarget(n: number, o: { guest: boolean; tasks: boolean; code: boolean }): string | null {
  const p = places({ ...o, computersOn: 0, notes: null, newNotes: false, open: null, vaultTo: href({ view: "vault", path: null }) }).find((x) => x.shortcut === n);
  return p?.to ?? null;
}

function useMedia(query: string, fallback: boolean): boolean {
  const [on, setOn] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

/**
 * The desktop sidebar (2026-11-22 "Bubble AI, decluttered"): only your agents and teams, like a
 * contacts list, always docked beside the page. Search and the plus at the top right, "Needs you"
 * when something waits, then the rows; your picture (its menu holds everything else) and
 * Computers at the foot. Drag its edge to make it wider or narrower and it stays there; pulled
 * narrow it snaps to a rail of ghosts. ⌘\ collapses and expands it, a double-click on the edge
 * resets it, and the width is remembered on this device.
 */
export function Rail({ route, popup = null }: { route: Route; /** the pop-up open over the page, if any: its place shows as open */ popup?: Route | null }) {
  const me = useStore((s) => s.me)!;
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const people = useStore((s) => s.members);
  const approvals = useStore((s) => s.approvals);
  // who is working where, not the words: a run streaming its reply doesn't redraw the sidebar; only
  // a run starting, changing tools or ending does (liveShape.ts)
  const live = useStore(liveShape);
  const inbox = useInboxCount();
  const prefs = usePrefs();
  const { orgs } = useOrgs();
  const isGuest = me.role === "guest";
  const features = useFeatures();
  const chats = useSideChats();
  const ready = useReadyChecklist();
  // stops of Show me around not seen yet
  const learnSeen = useStore((s) => seenCount(s.me?.prefs.learn, STOPS));
  const toLearn = !isGuest && learnSeen < TOTAL;
  const notes = useNoteCount(isGuest);
  const devices = useDevices(15_000);
  const [orgAt, setOrgAt] = useState<CSSProperties | null>(null);
  const [newOrg, setNewOrg] = useState(false);
  const footRef = useRef<HTMLDivElement>(null);
  // what's open: the pop-up when there is one, else the page
  const open = popup ?? route;
  const newNotes = useNewNotes(notes, open.view === "vault");

  const [side, setSide] = useState<SidebarState>(loadSidebar);
  const roomy = useMedia(`(min-width: ${SIDEBAR.roomy}px)`, true);
  // a small window shows the rail; opening it by hand keeps it open until the window has room again
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (roomy) setPeek(false);
  }, [roomy]);
  const [drag, setDrag] = useState<number | null>(null);
  const [snapping, setSnapping] = useState(false);
  const dragRef = useRef<{ left: number; width: number; moved: boolean } | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => saveSidebar(side), [side]);

  const resting = roomy ? (side.collapsed ? SIDEBAR.rail : side.width) : peek ? side.width : SIDEBAR.rail;
  const width = drag ?? resting;
  const wide = width > SIDEBAR.rail;

  const toggle = () => {
    if (!roomy) setPeek((p) => !p);
    else setSide((s) => ({ ...s, collapsed: !s.collapsed }));
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== "\\" && e.code !== "Backslash")) return;
      e.preventDefault();
      toggleRef.current();
    };
    const asked = () => toggleRef.current();
    window.addEventListener("keydown", key);
    window.addEventListener(SIDEBAR_TOGGLE, asked);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener(SIDEBAR_TOGGLE, asked);
    };
  }, []);

  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(snapTimer.current), []);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = { left: navRef.current?.getBoundingClientRect().left ?? 0, width, moved: false };
    document.body.classList.add("side-resizing");
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = dragWidth(e.clientX - d.left);
    if (!d.moved && next === d.width) return;
    const was = drag ?? d.width;
    d.moved = true;
    // crossing into or out of the rail animates; following the pointer doesn't
    if ((was <= SIDEBAR.rail) !== (next <= SIDEBAR.rail)) {
      setSnapping(true);
      clearTimeout(snapTimer.current);
      snapTimer.current = setTimeout(() => setSnapping(false), SIDEBAR_OPEN_MS + 20);
    }
    setDrag(next);
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    document.body.classList.remove("side-resizing");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    if (d.moved && drag != null) {
      const next = settle(side, drag);
      setSide(next);
      if (!roomy) setPeek(!next.collapsed);
    }
    setDrag(null);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = stepWidth(roomy || peek ? side : { ...side, collapsed: true }, e.key === "ArrowLeft" ? -1 : 1);
      setSide(next);
      if (!roomy) setPeek(!next.collapsed);
    } else if (e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };
  const reset = () => {
    setSide({ width: SIDEBAR.default, collapsed: false });
    if (!roomy) setPeek(true);
  };

  const transition = drag != null && !snapping ? "none" : `width ${wide ? SIDEBAR_OPEN_MS : SIDEBAR_CLOSE_MS}ms ${SIDEBAR_EASE}`;

  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  const active = route.view === "chat" ? route.channelId : null;
  // the rail: pins first, a hairline, then everyone else (no headers)
  const [layout] = useSideLayout(chats);
  const { railChats, railPins } = useMemo(() => {
    const placed = placeChats(layout, chats);
    const byKey = new Map(chats.map((c) => [c.key, c]));
    const pick = (keys: string[]) => keys.map((k) => byKey.get(k)!).filter(Boolean);
    const pins = pick(placed.pins);
    return { railPins: pins.length, railChats: [...pins, ...pick(placed.sections.flatMap((s) => s.keys))] };
  }, [layout, chats]);
  const setWide = () => (roomy ? setSide((s) => ({ ...s, collapsed: false })) : setPeek(true));
  // the line under each name: the same words as the phone's list. A line that reads the same keeps
  // its object, so one agent starting to work redraws its own row, not every row
  const hadLines = useRef(new Map<string, PreviewLine>());
  const lines = useMemo(() => {
    const ctx = { meId: me.user.id, agents, members: people, approvals, clock: prefs.clock };
    const had = hadLines.current;
    return (hadLines.current = new Map(
      chats.map((c) => {
        const line = chatPreviewLine(c, live, ctx);
        const was = had.get(c.key);
        return [c.key, sameLine(was, line) ? was : line];
      }),
    ));
  }, [chats, live, agents, people, approvals, me.user.id, prefs.clock]);
  const elsewhere = orgs.some((o) => o.unread && !o.current && o.id !== me.workspace.id);

  const icon = { size: 18, strokeWidth: 1.8 };
  const place = (label: string, node: ReactNode, to: Route) => ({ label, icon: node, onSelect: () => go(to) });
  const startFolder = () => (wide ? newSideSection() : (setWide(), setTimeout(newSideSection, SIDEBAR_OPEN_MS)));
  // + (round 11): a new agent, team or chat, a folder, and browsing teams
  const addItems = [
    ...(!isGuest ? [{ label: "New agent", icon: <BubbleIcon {...icon} />, onSelect: startNewAgent }] : []),
    ...(!isGuest ? [{ label: "New team", icon: <Users {...icon} />, onSelect: () => useStore.setState({ channelBrowser: { sectionId: null, create: true } }) }] : []),
    { label: "New chat", icon: <MessageSquarePlus {...icon} />, onSelect: () => useStore.setState({ newChatOpen: true }) },
    ...(!isGuest ? [{ label: "New folder", icon: <FolderPlus {...icon} />, onSelect: startFolder }] : []),
    "divider" as const,
    { label: "Browse teams", icon: <Search {...icon} />, onSelect: () => useStore.setState({ channelBrowser: { sectionId: null } }) },
  ];
  const switchWorkspace = () => {
    const r = footRef.current?.getBoundingClientRect();
    setOrgAt({ left: Math.max(8, r?.left ?? 8), bottom: window.innerHeight - (r?.top ?? window.innerHeight) + 6 });
  };
  // More (round 11): everything that isn't one of the five places — the agents list, what needs you,
  // tasks and routines, mods' own pages, help, the tour and the rest of the old account menu
  const moreItems = [
    place("All agents", <BubbleIcon {...icon} />, { view: "agents", agentId: null }),
    ...(!isGuest ? [place(inbox > 0 ? `Needs you · ${inbox > 99 ? "99+" : inbox}` : "Needs you", <Bell {...icon} />, { view: "dashboard" })] : []),
    ...(!isGuest ? [place(features.tasks ? "Tasks and routines" : "Tasks and routines (off)", <ListTodo {...icon} />, features.tasks ? { view: "tasks" } : { view: "marketplace", app: "m:tasks" })] : []),
    ...(!isGuest ? modNav(features, "rail").concat(modNav(features, "more")).map((m) => place(m.label, m.icon(18), m.to)) : []),
    { label: "Browse teams", icon: <Users {...icon} />, onSelect: () => useStore.setState({ channelBrowser: { sectionId: null } }) },
    "divider" as const,
    ...(!isGuest && ready.started && ready.left > 0 ? [place(`Finish setup · ${ready.left} left`, <Compass {...icon} />, { view: "settings", page: "learn" })] : []),
    ...(!isGuest ? [{ label: toLearn ? `Show me around · ${learnSeen} of ${TOTAL}` : "Show me around", icon: <Compass {...icon} />, onSelect: () => startTour(learnSeen >= TOTAL ? 0 : undefined) }] : []),
    place("Help", <LifeBuoy {...icon} />, { view: "help" }),
    place("What's new", <Sparkles {...icon} />, { view: "settings", page: "updates", item: "news" }),
    { label: "Report a problem", icon: <ExternalLink {...icon} />, onSelect: () => window.open(`${GITHUB_URL}/issues`, "_blank", "noreferrer") },
    ...(orgs.length > 1
      ? [
          {
            label: "Switch workspace",
            icon: (
              <span className="relative grid">
                <Building2 {...icon} />
                {elsewhere && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-badge" aria-label="New messages in another workspace" />}
              </span>
            ),
            onSelect: switchWorkspace,
          },
        ]
      : []),
  ];

  const initials = initialsOf(me.user.name);
  const settingsOn = open.view === "settings" && (open.page as string | null) !== "vault";
  const plus = (size: 32 | 40) => (
    <Menu
      up={false}
      align={size === 32 ? "right" : "left"}
      items={addItems}
      trigger={(isOpen, t) => (
        <button type="button" data-tour="new" onClick={t} aria-expanded={isOpen} aria-haspopup="menu" aria-label="New agent, team or chat" title="New" className={cx("lg grid shrink-0 place-items-center rounded-full", size === 32 ? "s32 size-8" : "size-10")}>
          <PlusLine size={16} />
        </button>
      )}
    />
  );

  // the five places (round 11): Chats, Computers, Memory, Marketplace, More
  const computersTo = href({ view: "computers", computerId: null });
  // the vault's own settings page (PR 113) when this build has it; the memory notes otherwise
  const vaultPage = (SETTINGS_PAGES as readonly string[]).includes("vault");
  const vaultTo = vaultPage ? "#/settings/vault" : href({ view: "vault", path: null });
  const vaultOn = vaultPage ? open.view === "settings" && (open.page as string | null) === "vault" : open.view === "vault";
  const onCount = machinesOn(isGuest ? [] : devices, computers);
  const marketOn = open.view === "marketplace" || open.view === "connectors" || open.view === "skills" || open.view === "mods";
  const moreOn = MORE_VIEWS.includes(open.view) && !vaultOn && !marketOn && open.view !== "more";
  const chatsOn = !popup && (route.view === "chat" || route.view === "chats");
  const tabs: { key: PlaceKey; label: string; to?: string; on: boolean; dot?: string | null; count?: string | null }[] = [
    { key: "chats", label: "Chats", to: chatsTarget(), on: chatsOn, dot: inbox > 0 ? BLUE_DOT : null, count: inbox > 0 ? `${inbox} need you` : null },
    ...(!isGuest ? [{ key: "computers" as const, label: "Computers", to: computersTo, on: open.view === "computers", dot: onCount > 0 ? "#30d158" : null, count: onCount > 0 ? `${onCount} on${working ? ", one is working" : ""}` : null }] : []),
    { key: "memory", label: "Memory", to: vaultTo, on: vaultOn, dot: newNotes ? "var(--wisp)" : null, count: notes != null ? `${notes} ${notes === 1 ? "note" : "notes"}` : null },
    ...(!isGuest ? [{ key: "marketplace" as const, label: "Marketplace", to: href({ view: "marketplace" }), on: marketOn }] : []),
    { key: "more", label: "More", on: moreOn },
  ];
  const tabButton = (t: (typeof tabs)[number], i: number) => {
    const inner = (
      <>
        <PlaceIcon place={t.key} />
        {t.dot && <span aria-hidden className="absolute right-[7px] top-[7px] box-content size-[7px] rounded-full border-2 border-[var(--r11-dot-ring)]" style={{ background: t.dot }} />}
        <span aria-hidden className={cx("r11-tip", i === 0 ? "left-0" : i === tabs.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2")}>
          {t.label}
          {t.count ? ` · ${t.count}` : ""}
        </span>
      </>
    );
    const cls = cx("r11-tab group/tip relative grid size-10 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40", t.on ? "bg-side-active text-ink" : "text-muted hover:bg-side-hover hover:text-ink");
    const aria = [t.label, t.count].filter(Boolean).join(", ");
    if (t.key === "more")
      return (
        <Menu
          key={t.key}
          up
          align="right"
          items={moreItems}
          trigger={(isOpen, toggleMenu) => (
            <button type="button" onClick={toggleMenu} aria-expanded={isOpen} aria-haspopup="menu" aria-label={aria} className={cx(cls, isOpen && "bg-side-active text-ink")}>
              {inner}
            </button>
          )}
        />
      );
    return (
      <a key={t.key} href={t.to} aria-label={aria} aria-current={t.on ? "page" : undefined} data-tour={t.key === "computers" ? "computers" : t.key === "memory" ? "vault" : t.key === "marketplace" ? "apps" : undefined} className={cls}>
        {inner}
      </a>
    );
  };

  // the narrow rail: your initials open one menu — your profile and settings, the five places, and Open the sidebar
  const [railMenu, setRailMenu] = useState<null | "main" | "more">(null);
  const youRef = useRef<HTMLButtonElement>(null);
  const railItems: ({ label: string; icon: ReactNode; on?: boolean; onSelect: () => void; muted?: boolean } | "divider")[] =
    railMenu === "more"
      ? moreItems.map((m) => (m === "divider" ? m : { label: m.label, icon: m.icon, onSelect: m.onSelect }))
      : [
          ...tabs.map((t) => ({
            label: t.label,
            icon: <PlaceIcon place={t.key} size={16} />,
            on: t.on,
            onSelect: () => (t.key === "more" ? setRailMenu("more") : t.to && (location.hash = t.to.slice(1))),
          })),
          "divider" as const,
          { label: "Open the sidebar", icon: <ChevronRight size={16} strokeWidth={2} />, muted: true, onSelect: setWide },
        ];

  return (
    <div className="relative z-30 flex shrink-0">
      <nav ref={navRef} aria-label="Bubble AI" data-wide={wide || undefined} className={cx("side side-glass r11-side flex h-full flex-col overflow-hidden", wide ? "px-4 pb-[18px]" : "items-center pb-[18px]")} style={{ width, transition }}>
        {wide ? (
          <>
            {/* the window-button row: your initials and + sit beside the traffic lights */}
            <div className="r11-toprow flex shrink-0 items-center justify-end gap-2" ref={footRef}>
              <button type="button" data-tour="you" onClick={() => go({ view: "settings", page: null })} aria-label="You and settings" title="You and settings" className={cx("lg s32 grid size-8 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold", settingsOn && "is-on")}>
                <span>{initials}</span>
                {elsewhere && <span className="absolute -right-px -top-px z-[2] box-content size-2 rounded-full border-2 border-[var(--r11-dot-ring)] bg-badge" aria-label="New messages in another workspace" />}
              </button>
              {plus(32)}
            </div>
            <div className="side-list -mx-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4">
              <SideList chats={chats} lines={lines} active={active} />
            </div>
            <div className="h-3 shrink-0" />
            <nav aria-label="Places" className="flex shrink-0 justify-between px-1.5">
              {tabs.map(tabButton)}
            </nav>
          </>
        ) : (
          <>
            <div className="r11-railtop shrink-0" />
            {plus(40)}
            <div className="side-list mt-4 flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden py-1">
              {railChats.map((c, i) => (
                <div key={c.key} className="contents">
                  {i === railPins && i > 0 && <div aria-hidden className="my-1 h-px w-8 shrink-0 bg-line" />}
                  <SideRow chat={c} chats={chats} wide={false} active={!!c.channel && c.channel.id === active} activeId={active} line={lines.get(c.key) ?? NO_LINE} onNewSection={startFolder} />
                </div>
              ))}
            </div>
            <div ref={footRef} className="shrink-0 pt-3">
              <button
                ref={youRef}
                type="button"
                data-tour="you"
                onClick={() => setRailMenu((m) => (m ? null : "main"))}
                aria-expanded={!!railMenu}
                aria-haspopup="menu"
                aria-label="Your profile, settings and places"
                title="Everything else"
                className={cx("lg grid size-10 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold", railMenu && "is-ring")}
              >
                <span>{initials}</span>
                {(elsewhere || inbox > 0) && <span aria-hidden className="absolute -right-px -top-px z-[2] box-content size-2 rounded-full border-2 border-[var(--r11-dot-ring)]" style={{ background: elsewhere ? "var(--badge)" : BLUE_DOT }} />}
              </button>
            </div>
          </>
        )}
      </nav>
      {railMenu && !wide && (
        <Float role="menu" label="Everything else" at={{ left: SIDEBAR.rail - 6, bottom: 16 }} className="side-menu w-[236px] p-[5px]" onClose={() => setRailMenu(null)}>
          {railMenu === "main" && (
            <>
              <button type="button" role="menuitem" onClick={() => (setRailMenu(null), go({ view: "settings", page: null }))} className="flex w-full items-center gap-2.5 rounded-[10px] px-[11px] pb-2.5 pt-2 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                <span className="gl grid size-8 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold">{initials}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold">{me.user.name}</span>
                  <span className="block text-[12px] text-muted">Profile and settings</span>
                </span>
              </button>
              <div className="mx-1.5 mb-1 h-px bg-line2" />
            </>
          )}
          {railMenu === "more" && (
            <button type="button" role="menuitem" onClick={() => setRailMenu("main")} className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-[11px] text-left text-[14px] text-muted outline-none hover:bg-hover focus-visible:bg-hover">
              <ChevronLeft size={16} strokeWidth={2} /> More
            </button>
          )}
          {railItems.map((m, i) =>
            m === "divider" ? (
              <div key={`d${i}`} className="mx-1.5 my-1 h-px bg-line2" />
            ) : (
              <button key={m.label} type="button" role="menuitem" onClick={() => (m.label !== "More" && setRailMenu(null), m.onSelect())} className={cx("flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-[11px] text-left text-[14px] outline-none hover:bg-hover focus-visible:bg-hover", m.muted ? "text-muted" : "text-ink")}>
                <span className="grid shrink-0">{m.icon}</span>
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
                {m.on && <Check size={15} strokeWidth={2} className="shrink-0 text-muted" />}
              </button>
            ),
          )}
        </Float>
      )}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR.rail}
        aria-valuemax={SIDEBAR.max}
        aria-valuenow={width}
        tabIndex={0}
        data-drag={drag != null || undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={reset}
        onKeyDown={onKey}
        className="side-edge"
      >
        <span />
      </div>
      {orgAt && (
        <Float role="dialog" label="Workspaces" at={orgAt} className="max-h-[calc(100vh-5rem)] w-[22rem] max-w-[calc(100vw-1rem)] overflow-y-auto" onClose={() => setOrgAt(null)}>
          <OrgList onDone={() => setOrgAt(null)} onNewOrg={() => (setOrgAt(null), setNewOrg(true))} />
        </Float>
      )}
      {newOrg && <NewOrgDialog onClose={() => setNewOrg(false)} />}
    </div>
  );
}
