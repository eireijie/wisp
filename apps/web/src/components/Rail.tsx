import { useRef, type ReactNode } from "react";
import { Blocks, BookOpen, Ellipsis, LifeBuoy, ListTodo, Store } from "lucide-react";
import { useFeatures } from "../features.ts";
import { useStore, useInboxCount, useChatsUnread } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import { AgentsIcon, ChatsIcon, ComputersIcon, InboxIcon, WispGhost } from "./icons.tsx";
import { OrgSwitcher, useOrgs } from "./OrgSwitcher.tsx";
import { Menu, PopBadge, cx } from "./ui.tsx";
import { useBounce } from "../motion.ts";

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
    <a href={desktop ? href({ view: "settings", page: null }) : href({ view: "you" })} aria-label="You and settings" title="You and settings" className="circle relative font-medium text-ink/85" style={{ width: size, height: size, fontSize: size * 0.3 }}>
      {initialsOf(me.user.name)}
      {elsewhere && <span className="absolute right-0 bottom-0 size-3 rounded-full bg-badge border-2 border-app" aria-label="New messages in another organization" />}
    </a>
  );
}

function NavItem({ to, label, icon, active, badge, dot, accent }: { to: string; label: string; icon: ReactNode; active: boolean; badge?: number; dot?: boolean; accent: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useBounce(iconRef, active);
  return (
    <a href={to} aria-current={active ? "page" : undefined} className={cx("relative z-[1] w-[68px] h-[52px] rounded-[14px] flex flex-col items-center justify-center gap-[3px] text-[11px]", active ? "text-ink font-medium" : "text-muted font-normal hover:text-ink hover:bg-hover")}>
      <span ref={iconRef} className="m-tab-icon" style={active ? { color: `var(--accent-${accent})` } : undefined}>{icon}</span>
      {label}
      {badge !== undefined && <PopBadge count={badge} label={badge > 99 ? "99+" : String(badge)} className="absolute top-1 right-4 min-w-[17px] h-[17px] px-1 rounded-full text-[10px] font-semibold text-black grid place-items-center tabular-nums" style={{ background: `var(--accent-${accent})` }} />}
      {dot && <span className="absolute top-2 right-6 size-2 rounded-full bg-st-working animate-pulse" aria-label="An agent is working" />}
    </a>
  );
}

/** The views the More menu opens, so the More item shows active on them. */
const MORE_VIEWS: Route["view"][] = ["vault", "tasks", "marketplace", "mods", "help"];

/** More: Memory, Tasks, Marketplace, Mods and Help in a small menu, so Settings only holds things you change. */
function MoreItem({ route, guest }: { route: Route; guest: boolean }) {
  const features = useFeatures();
  const icon = { size: 16, strokeWidth: 1.8 };
  const items = [
    { label: "Memory", icon: <BookOpen {...icon} />, onSelect: () => go({ view: "vault", path: null }) },
    ...(!guest && features.tasks ? [{ label: "Tasks", icon: <ListTodo {...icon} />, onSelect: () => go({ view: "tasks" }) }] : []),
    ...(!guest ? [{ label: "Marketplace", icon: <Store {...icon} />, onSelect: () => go({ view: "marketplace" }) }, { label: "Mods", icon: <Blocks {...icon} />, onSelect: () => go({ view: "mods" }) }] : []),
    { label: "Help", icon: <LifeBuoy {...icon} />, onSelect: () => go({ view: "help" }) },
  ];
  const active = MORE_VIEWS.includes(route.view);
  return (
    <Menu
      items={items}
      trigger={(open, toggle) => (
        <button onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-current={active ? "page" : undefined} className={cx("relative w-[68px] h-[52px] rounded-[14px] flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40", active || open ? "bg-side-active text-ink font-medium" : "text-muted font-normal hover:text-ink hover:bg-hover")}>
          <Ellipsis size={22} strokeWidth={1.8} aria-hidden />
          More
        </button>
      )}
    />
  );
}

/**
 * The slim left rail on desktops: Wisp's ghost on top (it opens the organization switcher),
 * Inbox, Chats, Agents, Computers and More, and you at the bottom (it opens Settings).
 */
export function Rail({ route }: { route: Route }) {
  const me = useStore((s) => s.me)!;
  const computers = useStore((s) => s.computers);
  const inbox = useInboxCount();
  const unreadChats = useChatsUnread();
  const isGuest = me.role === "guest";
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  const index = route.view === "dashboard" ? 0 : route.view === "chat" || route.view === "chats" ? 1 : route.view === "agents" ? 2 : route.view === "computers" && !isGuest ? 3 : -1;
  return (
    <nav aria-label="Wisp" className="w-[80px] shrink-0 flex flex-col items-center gap-1 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
      <OrgSwitcher
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label={`${me.workspace.name}, switch organization`} title={me.workspace.name} className="mb-4 flex text-ink rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
            <WispGhost size={34} />
          </button>
        )}
      />
      {/* the selection slides between items (56px apart); none selected, it fades out */}
      <div className="relative flex flex-col gap-1">
        <span aria-hidden className="m-ind left-0 top-0 w-[68px] h-[52px] rounded-[14px]" style={{ background: `color-mix(in srgb, var(--accent-${["inbox", "chats", "agents", "computers"][Math.max(index, 0)]}) 16%, transparent)`, transform: `translateY(${Math.max(index, 0) * 56}px)`, opacity: index < 0 ? 0 : 1 }} />
        <NavItem to={href({ view: "dashboard" })} label="Inbox" icon={<InboxIcon />} accent="inbox" active={route.view === "dashboard"} badge={inbox} />
        <NavItem to={chatsTarget()} label="Chats" icon={<ChatsIcon />} accent="chats" active={route.view === "chat" || route.view === "chats"} badge={unreadChats} />
        <NavItem to={href({ view: "agents", agentId: null })} label="Agents" icon={<AgentsIcon />} accent="agents" active={route.view === "agents"} />
        {!isGuest && <NavItem to={href({ view: "computers", computerId: null })} label="Computers" icon={<ComputersIcon />} accent="computers" active={route.view === "computers"} dot={working} />}
      </div>
      <MoreItem route={route} guest={isGuest} />
      <span className="flex-1" />
      <UserAvatarButton desktop />
    </nav>
  );
}
