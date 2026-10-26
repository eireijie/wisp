import type { ReactNode } from "react";
import { useStore, useInboxCount } from "../store.ts";
import { href, type Route } from "../router.ts";
import { AgentsIcon, ChatsIcon, ComputersIcon, InboxIcon, WispGhost } from "./icons.tsx";
import { OrgSwitcher, useOrgs } from "./OrgSwitcher.tsx";
import { cx } from "./ui.tsx";

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
export function UserAvatarButton({ size = 44, desktop }: { size?: number; desktop?: boolean }) {
  const me = useStore((s) => s.me)!;
  const { orgs } = useOrgs();
  const elsewhere = orgs.some((o) => o.unread && !o.current && o.id !== me.workspace.id);
  return (
    <a href={desktop ? href({ view: "settings", page: null }) : href({ view: "you" })} aria-label="You and settings" title="You and settings" className="circle relative font-semibold text-[#c7c7cc]" style={{ width: size, height: size, fontSize: size * 0.3 }}>
      {initialsOf(me.user.name)}
      {elsewhere && <span className="absolute right-0 bottom-0 size-3 rounded-full bg-badge border-2 border-app" aria-label="New messages in another organization" />}
    </a>
  );
}

function NavItem({ to, label, icon, active, badge, dot }: { to: string; label: string; icon: ReactNode; active: boolean; badge?: number; dot?: boolean }) {
  return (
    <a href={to} aria-current={active ? "page" : undefined} className={cx("relative w-[60px] h-[58px] rounded-[18px] flex flex-col items-center justify-center gap-1 text-[11px] transition-colors", active ? "bg-card text-ink font-semibold" : "text-muted font-medium hover:text-ink hover:bg-hover")}>
      {icon}
      {label}
      {!!badge && <span className="absolute top-1 right-2.5 min-w-[17px] h-[17px] px-1 rounded-full bg-badge text-badge-ink text-[10px] font-semibold grid place-items-center tabular-nums">{badge > 99 ? "99+" : badge}</span>}
      {dot && <span className="absolute top-2 right-4 size-2 rounded-full bg-ok" aria-label="An agent is working" />}
    </a>
  );
}

/**
 * The slim left rail on desktops: Wisp's ghost on top (it opens the organization switcher),
 * Inbox, Chats, Agents and Computers, and you at the bottom (it opens Settings).
 */
export function Rail({ route }: { route: Route }) {
  const me = useStore((s) => s.me)!;
  const computers = useStore((s) => s.computers);
  const inbox = useInboxCount();
  const isGuest = me.role === "guest";
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  return (
    <nav aria-label="Wisp" className="w-[84px] shrink-0 flex flex-col items-center gap-2 py-5 safe-top">
      <OrgSwitcher
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label={`${me.workspace.name}, switch organization`} title={me.workspace.name} className="mb-[18px] flex text-ink rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
            <WispGhost size={34} />
          </button>
        )}
      />
      <NavItem to={href({ view: "dashboard" })} label="Inbox" icon={<InboxIcon />} active={route.view === "dashboard"} badge={inbox} />
      <NavItem to={chatsTarget()} label="Chats" icon={<ChatsIcon />} active={route.view === "chat" || route.view === "chats"} />
      <NavItem to={href({ view: "agents", agentId: null })} label="Agents" icon={<AgentsIcon />} active={route.view === "agents"} />
      {!isGuest && <NavItem to={href({ view: "computers", computerId: null })} label="Computers" icon={<ComputersIcon />} active={route.view === "computers"} dot={working} />}
      <span className="flex-1" />
      <UserAvatarButton desktop />
    </nav>
  );
}
