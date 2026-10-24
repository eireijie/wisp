import { useState, type ReactNode } from "react";
import { Bell, BellOff, Blocks, BookOpen, ChevronDown, ChevronLeft, ChevronRight, CircleUser, FolderPlus, Ghost, Hand, Inbox, LifeBuoy, ListChecks, LogOut, Monitor, Moon, MoreHorizontal, Palette, Pencil, Plus, Search, Server, Settings, ShieldQuestion, SlidersHorizontal, Sparkles, Store, Sun, SunMoon, Trash2, UserPlus } from "lucide-react";
import type { Agent, Section } from "@warren/core";
import { api } from "../api.ts";
import { useInboxCount, useStore, useWaitingOnYou, type ChannelInfo } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import { logout } from "../App.tsx";
import { setupProgress, useDismissed, useOnboarding } from "../onboarding.ts";
import { useAppearance } from "../theme.ts";
import { useFeature } from "../features.ts";
import { ChannelIcon, ChannelMenu, SectionDialog } from "./Channels.tsx";
import { OrgSwitcher } from "./OrgSwitcher.tsx";
import { AgentAvatar, Menu, StatusDot, UserAvatar, agentVar, cx } from "./ui.tsx";
import { openDm } from "../openDm.ts";

const COLLAPSE_KEY = "warren.sidebar.collapsed";
const loadCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const ROLE_LABEL = { owner: "Owner", member: "Member", guest: "Guest" } as const;

/** Open the New agent screen from anywhere (the sidebar's +, ⌘K). */
export function startNewAgent() {
  useStore.setState({ newAgentOpen: true });
  go({ view: "agents", agentId: null });
}

/**
 * The sidebar, top to bottom: the organization (a switcher), search-or-create, the main pages
 * (Inbox, Agents, Computers, Memory), your agents, starred channels, sections and channels, and
 * you at the bottom with Settings. Everything else (Tasks, Devices, Connected apps,
 * Skills, About you, Help) is a click away on the Agents page, in Settings, or in ⌘K. On phones
 * the same lists are the Chats screen (variant "page") with larger touch targets.
 */
export function Sidebar({ route, variant = "sidebar" }: { route: Route; variant?: "sidebar" | "page" }) {
  const me = useStore((s) => s.me)!;
  const channels = useStore((s) => s.channels);
  const sections = useStore((s) => s.sections);
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const setPalette = useStore((s) => s.setPalette);
  const computers = useStore((s) => s.computers);
  const waiting = useWaitingOnYou();
  const inboxCount = useInboxCount();
  const invite = useFeature("invite");
  const tasksOn = useFeature("tasks");
  const moreViews: Route["view"][] = ["agents", "vault", "tasks", "marketplace", "connectors", "skills", "about", "nodes", "help"];
  const [editing, setEditing] = useState<Section | "new" | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const { done } = useOnboarding();
  const { resolvedMode, mode, toggleMode, setMode } = useAppearance();
  const dismissed = useDismissed();
  const { progress, steps, complete } = setupProgress(done);
  // after "Do this later" an unfinished setup stays reachable, just quieter
  const showGetStarted = route.view === "welcome" || !complete;
  const page = variant === "page";
  const isGuest = me.role === "guest";
  const browse = (sectionId: string | null) => useStore.setState({ channelBrowser: { sectionId } });

  const active = route.view === "chat" ? route.channelId : null;
  // archived channels leave the sidebar; starred ones get their own group at the top
  const joined = channels.filter((c) => c.kind === "channel" && c.joined && !c.archivedAt);
  const starred = joined.filter((c) => c.starred);
  const grouped = joined.filter((c) => !c.starred);
  const dmFor = (agentId: string) => channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  // a channel where an agent is working right now gets a green dot
  const busyChannels = new Set(Object.values(live).map((r) => r.channelId));
  const computerWorking = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);
  const waitingCount = waiting.approvals.length + waiting.help.length;

  const toggleGroup = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {}
  };

  // the "…" menu (rename, members, leave) sits beside the link, not inside it, and shows on hover
  const channelRow = (c: ChannelInfo) => (
    <div key={c.id} className="group/ch relative">
      <Item page={page} href={href({ view: "chat", channelId: c.id, threadId: null })} active={active === c.id} unread={c.unread > 0} dot={c.unread > 0}>
        <ChannelIcon channel={c} size={16} className="shrink-0 opacity-70" /> <span className={cx("truncate", c.notify === "mute" && "opacity-60")}>{c.name}</span>
        {c.notify === "mute" && <BellOff size={12} className="shrink-0 opacity-50" aria-label="Muted" />}
        {busyChannels.has(c.id) && <span className="ml-auto mr-1 size-[7px] rounded-full bg-ok shrink-0 group-hover/ch:opacity-0" title="An agent is working here" aria-label="An agent is working here" />}
      </Item>
      <span className={cx("absolute right-3 top-1/2 -translate-y-1/2", !page && "opacity-0 group-hover/ch:opacity-100 focus-within:opacity-100")}>
        <ChannelMenu channel={c} />
      </span>
    </div>
  );

  return (
    <nav className={cx("h-full flex flex-col", !page && "safe-top")} aria-label="Warren">
      {!page && (
        <div className="shrink-0 px-2 pt-2 flex items-center gap-0.5">
          <div className="flex-1 min-w-0">
            <OrgSwitcher />
          </div>
          <button onClick={() => history.back()} className="size-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-side-hover" aria-label="Back" title="Back">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => history.forward()} className="size-7 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-side-hover" aria-label="Forward" title="Forward">
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      <div className={cx("px-2", page ? "pt-2 px-3" : "pt-2")}>
        <button onClick={() => setPalette(true)} className={cx("w-full flex items-center gap-2.5 text-muted text-left", page ? "rounded-full px-3.5 h-11 text-[15px] bg-side-hover" : "mx-0 rounded-xl px-3 h-10 text-sm bg-panel border border-line hover:border-input")}>
          <Search size={16} className="shrink-0" />
          <span className="flex-1 truncate">Search or create…</span>
          {!page && <kbd className="text-[11px] font-sans text-muted bg-chip rounded-md px-1.5 py-0.5">⌘K</kbd>}
        </button>
      </div>

      <div className={cx("flex-1 overflow-y-auto pb-4 space-y-4", page ? "pt-3" : "pt-3")}>
        {!page && (
          <div className="space-y-px">
            <Item href={href({ view: "dashboard" })} active={route.view === "dashboard" || (route.view === "chat" && !route.channelId)} count={inboxCount} strongCount>
              <Inbox size={16} className="shrink-0" /> Inbox
            </Item>
            {showGetStarted && (
              <Item href={href({ view: "welcome" })} active={route.view === "welcome"}>
                <Sparkles size={16} className="shrink-0" /> {dismissed && !complete ? "Finish setup" : "Get started"}
                <span className="ml-auto text-[11px] text-muted tabular-nums">{dismissed && !complete ? `${progress} of ${steps}` : `${progress}/${steps}`}</span>
              </Item>
            )}
          </div>
        )}

        {/* phones have no Inbox in this list, so what's waiting shows here */}
        {page && waitingCount > 0 && (
          <Group page title="Waiting on you" collapsed={!!collapsed.waiting} onToggle={() => toggleGroup("waiting")}>
            {!isGuest && waiting.help.map((c) => {
              const a = agents.find((x) => x.id === c.help!.agentId);
              return (
                <Item key={c.id} page href={href({ view: "computers", computerId: c.id })} dot>
                  <Hand size={16} className="shrink-0 text-warn" />
                  <span className="truncate">
                    {a?.name ?? "Agent"}: {c.help!.request}
                  </span>
                </Item>
              );
            })}
            {waiting.approvals.map((p) => {
              const a = agents.find((x) => x.id === p.agentId);
              return (
                <Item key={p.id} page href={href({ view: "chat", channelId: p.channelId, threadId: p.threadId })} dot>
                  <ShieldQuestion size={16} className="shrink-0 text-warn" />
                  <span className="truncate">
                    {a?.name ?? "Agent"}: {p.summary}
                  </span>
                </Item>
              );
            })}
          </Group>
        )}

        <Group page={page} title="Your agents" collapsed={!!collapsed.dms} onToggle={() => toggleGroup("dms")} actions={!isGuest && <IconButton label="New agent" onClick={startNewAgent}><Plus size={14} /></IconButton>}>
          {agents.length === 0 && <p className="px-4 text-xs text-faint">No agents yet.</p>}
          {agents.map((a) => {
            const dm = dmFor(a.id);
            const unread = dm?.unread ?? 0;
            return (
              <Item key={a.id} page={page} agent={a} onClick={() => openDm(a.id)} active={!!dm && active === dm.id} unread={unread > 0} count={unread}>
                {/* the ghost dozes in gray when offline; a dot marks one that's working */}
                <span className="relative shrink-0">
                  <AgentAvatar agent={a} size={page ? 30 : 22} live />
                  {a.status === "busy" && <StatusDot status={a.status} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-sidebar" />}
                </span>
                <span className="truncate">{a.name}</span>
                {a.status === "busy" && unread === 0 && <span className="ml-auto text-xs font-semibold text-ok shrink-0">working</span>}
              </Item>
            );
          })}
        </Group>

        {starred.length > 0 && (
          <Group page={page} title="Starred" collapsed={!!collapsed.starred} onToggle={() => toggleGroup("starred")}>
            {starred.map(channelRow)}
          </Group>
        )}

        {sections.map((s) => {
          const list = grouped.filter((c) => c.sectionId === s.id);
          return (
            <Group
              key={s.id}
              page={page}
              title={
                <>
                  {s.emoji && <span className="text-[12px] not-italic">{s.emoji}</span>} {s.name}
                </>
              }
              collapsed={!!collapsed[s.id]}
              onToggle={() => toggleGroup(s.id)}
              actions={
                !isGuest && (
                  <>
                    <IconButton label={`Add channel to ${s.name}`} onClick={() => browse(s.id)}>
                      <Plus size={14} />
                    </IconButton>
                    <Menu
                      align="right"
                      trigger={(_o, t) => (
                        <IconButton label={`${s.name} options`} onClick={t}>
                          <MoreHorizontal size={14} />
                        </IconButton>
                      )}
                      items={[
                        { label: "Rename section", icon: <Pencil size={14} />, onSelect: () => setEditing(s) },
                        {
                          label: "Delete section",
                          icon: <Trash2 size={14} />,
                          danger: true,
                          onSelect: async () => {
                            if (!confirm(`Delete “${s.name}”? Its channels move to Channels.`)) return;
                            await api("DELETE", `/api/sections/${s.id}`);
                          },
                        },
                      ]}
                    />
                  </>
                )
              }
            >
              {list.length ? list.map(channelRow) : <p className="px-4 text-xs text-faint">No channels yet.</p>}
            </Group>
          );
        })}

        <Group
          page={page}
          title="Channels"
          collapsed={!!collapsed.channels}
          onToggle={() => toggleGroup("channels")}
          actions={
            <>
              <IconButton label="New channel" onClick={() => browse(null)}>
                <Plus size={14} />
              </IconButton>
              {!isGuest && (
                <IconButton label="New section" onClick={() => setEditing("new")}>
                  <FolderPlus size={14} />
                </IconButton>
              )}
            </>
          }
        >
          {grouped.filter((c) => !c.sectionId || !sections.some((s) => s.id === c.sectionId)).map(channelRow)}
          <Item page={page} onClick={() => browse(null)}>
            <Plus size={16} className="shrink-0 opacity-70" /> <span className="text-muted">Add channels</span>
          </Item>
        </Group>
      </div>

      {/* the rest of Warren: a short list, and everything else under More */}
      {!page && (
        <div className="shrink-0 pt-2 space-y-px border-t border-line">
          {!isGuest && (
            <Item href={href({ view: "computers", computerId: null })} active={route.view === "computers"}>
              <Monitor size={16} className="shrink-0" /> Computers
              {computerWorking && <span className="ml-auto size-1.5 rounded-full bg-info animate-pulse" title="An agent is working" />}
            </Item>
          )}
          <Item href={href({ view: "mods" })} active={route.view === "mods"}>
            <Blocks size={16} className="shrink-0" /> Mods
          </Item>
          <Item href={href({ view: "settings", page: null })} active={route.view === "settings"}>
            <SlidersHorizontal size={16} className="shrink-0" /> Settings
          </Item>
          <Menu
            up
            trigger={(_o, t) => (
              <Item onClick={t} active={moreViews.includes(route.view)}>
                <MoreHorizontal size={16} className="shrink-0" /> More
              </Item>
            )}
            items={[
              { label: "Agents", icon: <Ghost size={14} />, onSelect: () => go({ view: "agents", agentId: null }) },
              { label: "Memory", icon: <BookOpen size={14} />, onSelect: () => go({ view: "vault", path: null }) },
              ...(tasksOn ? [{ label: "Tasks", icon: <ListChecks size={14} />, onSelect: () => go({ view: "tasks" }) }] : []),
              { label: "Marketplace", icon: <Store size={14} />, onSelect: () => go({ view: "marketplace" }) },
              { label: "About you", icon: <CircleUser size={14} />, onSelect: () => go({ view: "about" }) },
              { label: "Devices", icon: <Server size={14} />, onSelect: () => go({ view: "nodes" }) },
              { label: "Help", icon: <LifeBuoy size={14} />, onSelect: () => go({ view: "help" }) },
            ]}
          />
        </div>
      )}

      {!page && (
        <div className="shrink-0 p-2 safe-bottom">
          <div className="flex items-center gap-1 rounded-xl bg-side-active p-1">
            <div className="flex-1 min-w-0">
              <Menu
                up
                trigger={(_o, t) => (
                  <button onClick={t} className="w-full flex items-center gap-2.5 rounded-lg px-1.5 h-11 hover:bg-side-hover text-left" aria-label="You">
                    <UserAvatar name={me.user.name} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold">{me.user.name}</span>
                      <span className="block truncate text-xs text-muted">{ROLE_LABEL[me.role]}</span>
                    </span>
                  </button>
                )}
                items={[
                  { label: "Profile", icon: <CircleUser size={14} />, onSelect: () => go({ view: "settings", page: "profile" }) },
                  { label: "App behavior", icon: <SlidersHorizontal size={14} />, onSelect: () => go({ view: "settings", page: "preferences" }) },
                  { label: "Notifications", icon: <Bell size={14} />, onSelect: () => go({ view: "settings", page: "notifications" }) },
                  { label: "Appearance", icon: <Palette size={14} />, onSelect: () => go({ view: "settings", page: "appearance" }) },
                  { label: resolvedMode === "dark" ? "Light mode" : "Dark mode", icon: resolvedMode === "dark" ? <Sun size={14} /> : <Moon size={14} />, onSelect: toggleMode },
                  ...(mode !== "system" ? [{ label: "Match system light or dark", icon: <SunMoon size={14} />, onSelect: () => setMode("system") }] : []),
                  "divider",
                  { label: "Organization settings", icon: <Settings size={14} />, onSelect: () => go({ view: "settings", page: "general" }) },
                  ...(me.role === "owner" && invite ? [{ label: "Invite people", icon: <UserPlus size={14} />, onSelect: () => go({ view: "settings", page: "people" }) }] : []),
                  "divider",
                  { label: "Sign out", icon: <LogOut size={14} />, onSelect: logout },
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {editing && <SectionDialog section={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </nav>
  );
}

/** A section heading; click it to fold the group away. */
function Group({ title, collapsed, onToggle, actions, page, children }: { title: ReactNode; collapsed: boolean; onToggle: () => void; actions?: ReactNode; page?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-px">
      <div className={cx("group px-4 flex items-center gap-1", page ? "h-9" : "h-7")}>
        <button onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink" aria-expanded={!collapsed}>
          <span className="truncate flex items-center gap-1">{title}</span>
          <ChevronDown size={12} className={cx("shrink-0 transition-transform opacity-0 group-hover:opacity-100", collapsed && "-rotate-90 opacity-100")} />
        </button>
        <span className={cx("flex items-center", !page && "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>{actions}</span>
      </div>
      {!collapsed && children}
    </section>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="p-1 rounded-md text-muted hover:text-ink hover:bg-side-active" aria-label={label} title={label}>
      {children}
    </button>
  );
}

function Item({ href: to, onClick, active, unread, dot, count, strongCount, page, agent, title, children }: { title?: string; href?: string; onClick?: () => void; active?: boolean; unread?: boolean; dot?: boolean; count?: number; strongCount?: boolean; page?: boolean; agent?: Agent; children: ReactNode }) {
  const cls = cx(
    "mx-2 px-2 flex items-center gap-2.5 rounded-lg text-left w-[calc(100%-1rem)] transition-colors",
    page ? "h-11 text-[15px]" : "h-8 text-[13px] font-medium",
    // the open item is tinted with the accent, or in the agent's own color for a chat with it
    active ? (agent ? "agent-tint text-ink" : "bg-accent-soft text-ink") : "hover:bg-side-active/70 hover:text-ink",
    unread && !active && "font-semibold text-ink",
    !unread && !active && "text-ink/80",
  );
  const inner = (
    <>
      <span className="flex-1 min-w-0 flex items-center gap-2.5">{children}</span>
      {!!count && count > 0 ? (
        <span className={cx("text-[11px] font-semibold rounded-full px-1.5 min-w-5 h-5 grid place-items-center tabular-nums", strongCount ? "bg-ink text-panel" : "bg-accent text-accent-ink")}>{count > 99 ? "99+" : count}</span>
      ) : (
        dot && <span className="size-1.5 rounded-full bg-accent shrink-0" />
      )}
    </>
  );
  const style = agent ? agentVar(agent) : undefined;
  return to ? (
    <a href={to} title={title} className={cls} style={style} aria-current={active ? "page" : undefined}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} title={title} className={cls} style={style}>
      {inner}
    </button>
  );
}
