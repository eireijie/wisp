import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Apple, Blocks, BookOpen, ChevronDown, FolderPlus, Ghost as GhostIcon, HardDrive, LayoutGrid, LifeBuoy, ListChecks, ListTodo, MessageSquarePlus, PanelLeft, Plus, Search, SquareTerminal, Store, Users } from "lucide-react";
import { useReadyChecklist } from "../onboarding.ts";
import type { FeatureKey, Section } from "@wisp/core";
import { useFeatures } from "../features.ts";
import { useStore, useInboxCount } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import { openDm } from "../openDm.ts";
import { ComputersIcon, InboxIcon, WispGhost } from "./icons.tsx";
import { OrgSwitcher, useOrgs } from "./OrgSwitcher.tsx";
import { Menu, PopBadge, cx } from "./ui.tsx";
import { ChatAvatar, ChatMenu, startNewAgent, type Chat } from "./ChatList.tsx";
import { SectionDialog } from "./Channels.tsx";
import { SIDEBAR, SIDEBAR_CLOSE_MS, SIDEBAR_EASE, SIDEBAR_OPEN_MS, dragWidth, loadSidebar, saveSidebar, settle, stepWidth, type SidebarState } from "../sidebarWidth.ts";

/** Where the Chats item goes: the chat you were last in, else the newest one. Remembered per page load. */
let lastChat: string | null = null;
export function rememberChat(id: string | null) {
  if (id) lastChat = id;
}
export function chatsTarget(): string {
  const { channels } = useStore.getState();
  const id = lastChat && channels.some((c) => c.id === lastChat) ? lastChat : null;
  return id ? href({ view: "chat", channelId: id, threadId: null }) : href({ view: "chats" });
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
    <a href={desktop ? href({ view: "settings", page: null }) : href({ view: "you" })} aria-label="You and settings" title="You and settings" className="circle relative font-semibold text-ink" style={{ width: size, height: size, fontSize: 13 }}>
      {initialsOf(me.user.name)}
      {elsewhere && <span className="absolute right-0 bottom-0 size-3 rounded-full bg-badge border-2 border-app" aria-label="New messages in another workspace" />}
    </a>
  );
}

/**
 * What mods add to the sidebar while they're on: "rail" items sit under Computers on desktops,
 * "more" items go in More. A mod adds its entry here instead of its own check in the rail.
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
export function useMoreItems(guest: boolean, size = 16, withAgents = false): { label: string; icon: ReactNode; to: Route }[] {
  const features = useFeatures();
  const icon = { size, strokeWidth: 1.8 };
  return [
    ...(withAgents ? [{ label: "All agents", icon: <GhostIcon {...icon} />, to: { view: "agents", agentId: null } as Route }] : []),
    { label: "Memory", icon: <BookOpen {...icon} />, to: { view: "vault", path: null } },
    ...(!guest && features.tasks ? [{ label: "Tasks", icon: <ListTodo {...icon} />, to: { view: "tasks" } as Route }] : []),
    ...(!guest ? modNav(features, "more").map((m) => ({ label: m.label, icon: m.icon(size), to: m.to })) : []),
    ...(!guest ? [{ label: "Marketplace", icon: <Store {...icon} />, to: { view: "marketplace" } as Route }, { label: "Mods", icon: <Blocks {...icon} />, to: { view: "mods" } as Route }] : []),
    { label: "Help", icon: <LifeBuoy {...icon} />, to: { view: "help" } },
  ];
}

/** Rows and tools share one shape: full width with words when wide, a 44px square as icons. */
const ROW = "relative flex shrink-0 items-center whitespace-nowrap rounded-[6px] text-left text-[14px] outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/40";
const shape = (wide: boolean, tall = false) => (wide ? cx("mx-2 gap-2.5 px-2", tall ? "h-[34px]" : "h-8") : "mx-[10px] h-10 w-11 justify-center");

/** A small violet dot that breathes while an agent or a computer is working. */
function WorkDot({ corner }: { corner?: boolean }) {
  return <span aria-hidden className={cx("side-pulse shrink-0 rounded-full bg-wisp", corner ? "absolute bottom-[5px] right-[7px] size-[7px] box-content border-2 border-sidebar" : "size-[7px]")} />;
}

function Tool({ wide, label, title, icon, active, to, onClick, dot, aria, children, tall }: { wide: boolean; label: string; title?: string; icon: ReactNode; active?: boolean; to?: string; onClick?: () => void; dot?: boolean; aria?: Record<string, unknown>; children?: ReactNode; tall?: boolean }) {
  const cls = cx(ROW, shape(wide, tall ?? true), wide ? "w-[calc(100%-16px)]" : "", active ? "bg-side-active text-ink" : "text-muted hover:bg-side-hover hover:text-ink");
  const inner = (
    <>
      <span className="grid w-[18px] shrink-0 place-items-center" aria-hidden>{icon}</span>
      {wide && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {wide && dot && <WorkDot />}
      {!wide && dot && <WorkDot corner />}
      {children}
    </>
  );
  return to ? (
    <a href={to} aria-label={title ?? label} title={wide ? undefined : label} aria-current={active ? "page" : undefined} className={cls}>{inner}</a>
  ) : (
    <button type="button" onClick={onClick} aria-label={title ?? label} title={wide ? undefined : label} className={cls} {...aria}>{inner}</button>
  );
}

function IconButton({ label, shortcut, onClick, to, children, wide }: { label: string; shortcut?: string; onClick?: () => void; to?: string; children: ReactNode; wide: boolean }) {
  const cls = cx("grid shrink-0 place-items-center rounded-[6px] text-muted outline-none hover:bg-side-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/40", wide ? "size-[30px]" : "h-[34px] w-11");
  const tip = shortcut ? `${label}  ${shortcut}` : label;
  return to ? (
    <a href={to} aria-label={label} title={tip} className={cls}>{children}</a>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} title={tip} className={cls}>{children}</button>
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

/** The sidebar's groups: Pinned, your own sections, then Agents and Teams for the rest. */
export function sidebarGroups(chats: Chat[], sections: Section[]): { id: string; label: string; chats: Chat[]; add?: "agent" | "team" }[] {
  const ids = new Set(sections.map((s) => s.id));
  const loose = chats.filter((c) => !c.pinned && (!c.sectionId || !ids.has(c.sectionId)));
  return [
    { id: "pinned", label: "Pinned", chats: chats.filter((c) => c.pinned) },
    ...sections.map((s) => ({ id: s.id, label: s.name, chats: chats.filter((c) => !c.pinned && c.sectionId === s.id) })),
    { id: "agents", label: "Agents", chats: loose.filter((c) => c.kind === "dm"), add: "agent" as const },
    { id: "teams", label: "Teams", chats: loose.filter((c) => c.kind === "team"), add: "team" as const },
  ].filter((g) => g.chats.length > 0);
}

function SideRow({ chat, wide, active, working, sections, onNewSection }: { chat: Chat; wide: boolean; active: boolean; working: boolean; sections: Section[]; onNewSection: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const unread = chat.unread > 0 && !chat.muted;
  const label = `${chat.name}${chat.unread > 0 ? `, ${chat.unread} unread` : ""}${working ? ", working" : ""}`;
  const cls = cx(ROW, shape(wide), wide ? "w-[calc(100%-16px)]" : "", active ? "bg-side-active text-ink" : cx("hover:bg-side-hover hover:text-ink", unread ? "text-ink" : "text-muted"), unread ? "font-semibold" : "font-medium");
  const inner = (
    <>
      <span className={cx("grid shrink-0 place-items-center", wide ? "size-5" : "size-7")}>
        <ChatAvatar chat={chat} size={wide ? 20 : 28} />
      </span>
      {wide && <span className={cx("min-w-0 flex-1 truncate", chat.muted && "opacity-60")}>{chat.name}</span>}
      {wide && working && <WorkDot />}
      {wide && unread && <span aria-hidden className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-badge px-[5px] text-[11px] font-bold tabular-nums text-badge-ink">{chat.unread > 99 ? "99+" : chat.unread}</span>}
      {wide && chat.unread > 0 && chat.muted && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-faint" />}
      {!wide && unread && <span aria-hidden className="absolute right-[6px] top-[4px] box-content size-[9px] rounded-full border-2 border-sidebar bg-badge" />}
      {!wide && working && <WorkDot corner />}
    </>
  );
  const url = chat.channel ? href({ view: "chat", channelId: chat.channel.id, threadId: null }) : undefined;
  return (
    <div onContextMenu={(e) => chat.channel && (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY }))}>
      {url ? (
        <a href={url} aria-label={label} title={wide ? undefined : label} aria-current={active ? "page" : undefined} className={cls}>{inner}</a>
      ) : (
        <button type="button" onClick={() => chat.agent && void openDm(chat.agent.id)} aria-label={label} title={wide ? undefined : label} className={cls}>{inner}</button>
      )}
      {menu && chat.channel && <ChatMenu chat={chat} channel={chat.channel} at={menu} onClose={() => setMenu(null)} sections={sections} onNewSection={onNewSection} />}
    </div>
  );
}

const COLLAPSE_KEY = "wisp.chats.collapsed";
function useCollapsedGroups(): [Record<string, boolean>, (id: string) => void] {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  return [collapsed, toggle];
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
 * The desktop sidebar (2026-11-21 canvas "Wisp docked sidebar"): always docked beside the page,
 * never over it. Drag its edge to make it wider or narrower and it stays there; under 140px it
 * snaps to icons. ⌘\ or the panel button collapses and expands it, a double-click on the edge
 * resets it, and the width is remembered on this device.
 */
export function Rail({ route }: { route: Route }) {
  const me = useStore((s) => s.me)!;
  const computers = useStore((s) => s.computers);
  const sections = useStore((s) => s.sections);
  const live = useStore((s) => s.live);
  const inbox = useInboxCount();
  const isGuest = me.role === "guest";
  const features = useFeatures();
  const chats = useSideChats();
  const ready = useReadyChecklist();
  const [collapsedGroups, toggleGroup] = useCollapsedGroups();
  const [editing, setEditing] = useState<Section | "new" | null>(null);

  const [side, setSide] = useState<SidebarState>(loadSidebar);
  const roomy = useMedia(`(min-width: ${SIDEBAR.roomy}px)`, true);
  // a small window shows icons; opening it by hand keeps it open until the window has room again
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
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
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
    // crossing into or out of icons animates; following the pointer doesn't
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
  const runs = Object.values(live);
  const isWorking = (c: Chat) => (c.channel ? runs.some((r) => r.channelId === c.channel!.id && (c.kind === "team" || r.agentId === c.agent?.id)) : false) || (c.kind === "dm" && c.agent?.status === "busy");
  const active = route.view === "chat" ? route.channelId : null;
  const groups = sidebarGroups(chats, sections);
  const moreItems = useMoreItems(isGuest, 18, true).map((i) => ({ label: i.label, icon: i.icon, onSelect: () => go(i.to) }));
  const addItems = [
    { label: "New chat", icon: <MessageSquarePlus size={18} strokeWidth={1.8} />, onSelect: () => useStore.setState({ newChatOpen: true }) },
    ...(!isGuest ? [{ label: "New agent", icon: <GhostIcon size={18} strokeWidth={1.8} />, onSelect: startNewAgent }] : []),
    ...(!isGuest ? [{ label: "New team", icon: <Users size={18} strokeWidth={1.8} />, onSelect: () => useStore.setState({ channelBrowser: { sectionId: null, create: true } }) }] : []),
    { label: "Browse teams", icon: <Search size={18} strokeWidth={1.8} />, onSelect: () => useStore.setState({ channelBrowser: { sectionId: null } }) },
    ...(!isGuest ? [{ label: "New section", icon: <FolderPlus size={18} strokeWidth={1.8} />, onSelect: () => setEditing("new") }] : []),
  ];
  const addFor = (kind: "agent" | "team") => (kind === "agent" ? startNewAgent() : useStore.setState({ channelBrowser: { sectionId: null, create: true } }));

  const orgButton = (size: number) => (
    <OrgSwitcher
      trigger={(open, t) => (
        <button onClick={t} aria-expanded={open} aria-haspopup="menu" aria-label={`${me.workspace.name}, switch workspace`} title={wide ? undefined : me.workspace.name} className={cx("flex min-w-0 items-center rounded-[6px] text-ink outline-none hover:bg-side-hover focus-visible:ring-2 focus-visible:ring-ring/40", wide ? "h-8 gap-2 pl-1 pr-1.5" : "h-10 w-11 justify-center")}>
          <WispGhost size={size} />
          {wide && <span className="truncate text-[14px] font-semibold">{me.workspace.name}</span>}
          {wide && <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-faint" aria-hidden />}
        </button>
      )}
    />
  );
  const panelIcon = <PanelLeft size={wide ? 16 : 18} strokeWidth={1.8} />;
  const searchIcon = <Search size={wide ? 16 : 18} strokeWidth={1.8} />;
  const searchTo = href({ view: "chats" });

  return (
    <div className="relative z-30 flex shrink-0">
      <nav ref={navRef} aria-label="Wisp" data-wide={wide || undefined} className="side flex h-full flex-col overflow-hidden border-r border-line bg-sidebar pt-[max(10px,env(safe-area-inset-top))] pb-2.5" style={{ width, transition }}>
        {wide ? (
          <div className="flex h-10 shrink-0 items-center gap-0.5 pl-3 pr-2.5">
            {orgButton(22)}
            <span className="flex-1" />
            <IconButton wide label="All chats and search" to={searchTo}>{searchIcon}</IconButton>
            <IconButton wide label="Collapse sidebar" shortcut={SHORTCUT} onClick={toggle}>{panelIcon}</IconButton>
          </div>
        ) : (
          <div className="flex shrink-0 flex-col items-center gap-1">
            {orgButton(24)}
            <IconButton wide={false} label="Expand sidebar" shortcut={SHORTCUT} onClick={toggle}>{panelIcon}</IconButton>
            <IconButton wide={false} label="All chats and search" to={searchTo}>{searchIcon}</IconButton>
          </div>
        )}

        <div className="mt-1.5">
          <Tool wide={wide} label="Inbox" title={inbox ? `Inbox, ${inbox} waiting` : "Inbox"} icon={<InboxIcon size={18} />} to={href({ view: "dashboard" })} active={route.view === "dashboard"}>
            {wide && inbox > 0 && <span className="shrink-0 text-[12px] tabular-nums text-muted">{inbox > 99 ? "99+" : inbox}</span>}
            {!wide && <PopBadge count={inbox} label={inbox > 99 ? "99+" : String(inbox)} className="absolute left-[25px] top-[5px] box-content grid h-4 min-w-4 place-items-center rounded-full border-2 border-sidebar bg-badge px-1 text-[10px] font-bold tabular-nums text-badge-ink" />}
          </Tool>
        </div>

        <div className="side-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 pt-0.5">
          {groups.map((g, i) => {
            const closed = wide && !!collapsedGroups[g.id];
            return (
              <section key={g.id} aria-label={g.label}>
                {wide ? (
                  <div className="group/sec mx-2 mb-0.5 mt-2.5 flex h-7 items-center pl-2 pr-1">
                    <button type="button" onClick={() => toggleGroup(g.id)} aria-expanded={!closed} className="flex min-w-0 items-center gap-1 rounded text-[12px] font-semibold text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-ring/40">
                      <span className="truncate">{g.label}</span>
                      <ChevronDown size={12} strokeWidth={2.2} aria-hidden className="shrink-0 transition-transform duration-150" style={{ transform: closed ? "rotate(-90deg)" : undefined }} />
                    </button>
                    <span className="flex-1" />
                    {g.add && !isGuest && (
                      <button type="button" onClick={() => addFor(g.add!)} aria-label={g.add === "agent" ? "New agent" : "New team"} title={g.add === "agent" ? "New agent" : "New team"} className="grid size-[22px] place-items-center rounded-[5px] text-muted opacity-0 outline-none hover:bg-side-hover hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover/sec:opacity-100">
                        <Plus size={14} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                ) : (
                  i > 0 && <div className="mx-auto my-2 h-px w-6 bg-line2" aria-hidden />
                )}
                {!closed && (
                  <div className={cx("flex flex-col gap-px", !wide && i === 0 && "mt-2")}>
                    {g.chats.map((c) => (
                      <SideRow key={c.key} chat={c} wide={wide} active={!!c.channel && c.channel.id === active} working={isWorking(c)} sections={sections} onNewSection={() => setEditing("new")} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {wide && !chats.length && <p className="px-4 py-3 text-[13px] text-faint">No chats yet.</p>}
        </div>

        <div className="flex shrink-0 flex-col gap-px border-t border-line pt-2">
          {ready.started && ready.left > 0 && !isGuest && <Tool wide={wide} label="Finish setup" icon={<ListChecks size={18} strokeWidth={1.8} />} to={href({ view: "here" })} active={route.view === "here"} />}
          <Menu up items={addItems} trigger={(open, t) => <Tool wide={wide} label="New agent or team" icon={<Plus size={18} strokeWidth={1.8} />} onClick={t} active={open} aria={{ "aria-expanded": open, "aria-haspopup": "menu" }} />} />
          {!isGuest && <Tool wide={wide} label="Computers" title={working ? "Computers, one is working" : "Computers"} icon={<ComputersIcon size={18} />} to={href({ view: "computers", computerId: null })} active={route.view === "computers"} dot={working} />}
          {!isGuest && modNav(features, "rail").map((m) => <Tool key={m.feature} wide={wide} label={m.label} icon={m.icon(18)} to={href(m.to)} active={m.views.includes(route.view)} />)}
          <Menu up items={moreItems} trigger={(open, t) => <Tool wide={wide} label="Apps, skills and mods" icon={<LayoutGrid size={18} strokeWidth={1.8} />} onClick={t} active={open || MORE_VIEWS.includes(route.view)} aria={{ "aria-expanded": open, "aria-haspopup": "menu" }} />} />
          <a href={href({ view: "settings", page: null })} aria-label="Account and settings" title={wide ? undefined : "Account and settings"} aria-current={route.view === "settings" ? "page" : undefined} className={cx(ROW, "mt-1", wide ? "mx-2 h-11 w-[calc(100%-16px)] gap-2.5 px-1.5" : "mx-[10px] h-11 w-11 justify-center", route.view === "settings" ? "bg-side-active" : "hover:bg-side-hover")}>
            <span className={cx("grid size-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold text-ink", route.view === "settings" ? "border-ink" : "border-line2")}>{initialsOf(me.user.name)}</span>
            {wide && (
              <span className="flex min-w-0 flex-1 flex-col leading-[17px]">
                <span className="truncate font-semibold text-ink">{me.user.name.split(" ")[0]}</span>
                <span className="truncate text-[12px] text-muted">Settings, memory, usage</span>
              </span>
            )}
          </a>
        </div>
      </nav>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR.rail}
        aria-valuemax={SIDEBAR.max}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
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
      {editing && <SectionDialog section={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘\\" : "Ctrl+\\";
