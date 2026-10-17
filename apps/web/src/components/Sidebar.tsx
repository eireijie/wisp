import { useState, type ReactNode } from "react";
import { Bell, BookOpen, LayoutDashboard, Plug, Wand2, Bot, Brain, ChevronDown, CircleUser, FolderPlus, Hand, Hash, ListTodo, LogOut, SlidersHorizontal, UserPlus, Monitor, Moon, MoreHorizontal, Palette, Pencil, Plus, Search, Server, Settings, ShieldQuestion, SquarePen, Sparkles, Sun, SunMoon, Trash2, Users } from "lucide-react";
import type { Agent, Section } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import { logout } from "../App.tsx";
import { isDismissed, useOnboarding } from "../onboarding.ts";
import { useAppearance } from "../theme.ts";
import { ChannelBrowser, ChannelMenu, SectionDialog } from "./Channels.tsx";
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

/**
 * The workspace sidebar, top to bottom: the workspace, Dashboard and quick actions, anything
 * waiting on you, your agents, channels, then everything else under Workspace, and you at the
 * bottom. On phones the same content is the Chats screen (variant "page": agents then channels)
 * with larger touch targets.
 */
export function Sidebar({ route, variant = "sidebar" }: { route: Route; variant?: "sidebar" | "page" }) {
  const me = useStore((s) => s.me)!;
  const channels = useStore((s) => s.channels);
  const sections = useStore((s) => s.sections);
  const agents = useStore((s) => s.agents);
  const connected = useStore((s) => s.connected);
  const setPalette = useStore((s) => s.setPalette);
  const computers = useStore((s) => s.computers);
  const approvals = useStore((s) => s.approvals);
  const [browser, setBrowser] = useState<{ sectionId: string | null } | null>(null);
  const [editing, setEditing] = useState<Section | "new" | null>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const { done } = useOnboarding();
  const { resolvedMode, mode, toggleMode, setMode } = useAppearance();
  const progress = Object.values(done).filter(Boolean).length;
  const steps = Object.keys(done).length;
  const showGetStarted = route.view === "welcome" || (progress < steps && !isDismissed());
  const page = variant === "page";
  const isGuest = me.role === "guest";

  const active = route.view === "chat" ? route.channelId : null;
  const joined = channels.filter((c) => c.kind === "channel" && c.joined);
  const dmFor = (agentId: string) => channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  // what agents are waiting on a person for: approvals, and help on their computers
  // a request to borrow a device is only the owner's to answer
  const pending = Object.values(approvals).filter((a) => a.status === "pending" && (!a.loan || a.loan.ownerId === me?.user.id));
  const helpNeeded = computers.filter((c) => c.help);
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);

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
        <Hash size={16} className="shrink-0 opacity-70" /> <span className="truncate">{c.name}</span>
      </Item>
      <span className={cx("absolute right-3 top-1/2 -translate-y-1/2", !page && "opacity-0 group-hover/ch:opacity-100 focus-within:opacity-100")}>
        <ChannelMenu channel={c} />
      </span>
    </div>
  );

  return (
    <nav className={cx("h-full flex flex-col", !page && "safe-top")}>
      {!page && (
        <div className="h-15 shrink-0 px-4 flex items-center gap-2">
          <WorkspaceTile name={me.workspace.name} />
          <div className="text-sm font-bold truncate flex-1">{me.workspace.name}</div>
          <span className={cx("size-1.5 rounded-full shrink-0", connected ? "bg-ok" : "bg-faint animate-pulse")} title={connected ? "Connected" : "Reconnecting…"} />
        </div>
      )}

      {page && (
        <div className="px-3 pt-2">
          <button onClick={() => setPalette(true)} className="w-full flex items-center gap-2 rounded-lg px-3 h-11 text-[15px] text-muted bg-side-hover">
            <Search size={16} />
            <span className="flex-1 text-left">Search everything</span>
          </button>
        </div>
      )}

      <div className={cx("flex-1 overflow-y-auto pb-4 space-y-3", page ? "pt-3" : "pt-1")}>
        {!page && (
          <div className="space-y-px">
            <Item href={href({ view: "dashboard" })} active={route.view === "dashboard" || (route.view === "chat" && !route.channelId)}>
              <LayoutDashboard size={16} className="shrink-0" /> Dashboard
            </Item>
            {!isGuest && (
              <Item onClick={() => useStore.setState({ newTaskOpen: true })}>
                <SquarePen size={16} className="shrink-0" /> New task
              </Item>
            )}
            <Item onClick={() => setPalette(true)}>
              <Search size={16} className="shrink-0" /> Search
              <kbd className="ml-auto text-[11px] text-faint font-sans">⌘K</kbd>
            </Item>
            {showGetStarted && (
              <Item href={href({ view: "welcome" })} active={route.view === "welcome"}>
                <Sparkles size={16} className="shrink-0" /> Get started
                <span className="ml-auto text-[11px] text-muted tabular-nums">
                  {progress}/{steps}
                </span>
              </Item>
            )}
          </div>
        )}

        {!isGuest && pending.length + helpNeeded.length > 0 && (
          <Group page={page} title="Waiting on you" collapsed={!!collapsed.waiting} onToggle={() => toggleGroup("waiting")}>
            {helpNeeded.map((c) => {
              const a = agents.find((x) => x.id === c.help!.agentId);
              return (
                <Item key={c.id} page={page} href={href({ view: "computers", computerId: c.id })} active={route.view === "computers" && route.computerId === c.id} dot>
                  <Hand size={16} className="shrink-0 text-warn" />
                  <span className="truncate">
                    {a?.name ?? "Agent"}: {c.help!.request}
                  </span>
                </Item>
              );
            })}
            {pending.map((p) => {
              const a = agents.find((x) => x.id === p.agentId);
              return (
                <Item key={p.id} page={page} href={href({ view: "chat", channelId: p.channelId, threadId: p.threadId })} dot>
                  <ShieldQuestion size={16} className="shrink-0 text-warn" />
                  <span className="truncate">
                    {a?.name ?? "Agent"}: {p.summary}
                  </span>
                </Item>
              );
            })}
          </Group>
        )}

        <Group page={page} title="Agents" collapsed={!!collapsed.dms} onToggle={() => toggleGroup("dms")} actions={!isGuest && <IconButton label="Add agent" onClick={() => go({ view: "agents", agentId: null })}><Plus size={14} /></IconButton>}>
          {agents.length === 0 && <p className="px-4 text-xs text-faint">No agents yet.</p>}
          {agents.map((a) => {
            const dm = dmFor(a.id);
            return (
              <Item key={a.id} page={page} agent={a} onClick={() => openDm(a.id)} active={!!dm && active === dm.id} unread={!!dm && dm.unread > 0} count={dm?.unread}>
                {/* the ghost dozes in gray when offline; a dot marks one that's working */}
                <span className="relative shrink-0">
                  <AgentAvatar agent={a} size={page ? 30 : 22} live />
                  {a.status === "busy" && <StatusDot status={a.status} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-sidebar" />}
                </span>
                <span className="truncate">{a.name}</span>
              </Item>
            );
          })}
        </Group>

        {sections.map((s) => {
          const list = joined.filter((c) => c.sectionId === s.id);
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
                    <IconButton label={`Add channel to ${s.name}`} onClick={() => setBrowser({ sectionId: s.id })}>
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
              <IconButton label="Add a channel" onClick={() => setBrowser({ sectionId: null })}>
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
          {joined.filter((c) => !c.sectionId || !sections.some((s) => s.id === c.sectionId)).map(channelRow)}
          <Item page={page} onClick={() => setBrowser({ sectionId: null })}>
            <Plus size={16} className="shrink-0 opacity-70" /> <span className="text-muted">Add channels</span>
          </Item>
        </Group>

        {!page && (
          <Group title="Workspace" collapsed={!!collapsed.workspace} onToggle={() => toggleGroup("workspace")}>
            <Item href={href({ view: "tasks" })} active={route.view === "tasks"}>
              <ListTodo size={16} className="shrink-0" /> Tasks
            </Item>
            <Item href={href({ view: "vault", path: null })} active={route.view === "vault"}>
              <BookOpen size={16} className="shrink-0" /> Memory
            </Item>
            <Item href={href({ view: "computers", computerId: null })} active={route.view === "computers"}>
              <Monitor size={16} className="shrink-0" /> Computers
              {working && <span className="ml-auto size-1.5 rounded-full bg-info animate-pulse" title="An agent is working" />}
            </Item>
            <Item href={href({ view: "nodes" })} active={route.view === "nodes"}>
              <Server size={16} className="shrink-0" /> Devices
            </Item>
            <Item href={href({ view: "agents", agentId: null })} active={route.view === "agents"}>
              <Bot size={16} className="shrink-0" /> Agents
            </Item>
            <Item href={href({ view: "teams", teamId: null })} active={route.view === "teams"}>
              <Users size={16} className="shrink-0" /> Teams
            </Item>
            <Item href={href({ view: "connectors" })} active={route.view === "connectors"}>
              <Plug size={16} className="shrink-0" /> Connectors
            </Item>
            <Item href={href({ view: "skills" })} active={route.view === "skills"}>
              <Wand2 size={16} className="shrink-0" /> Skills
            </Item>
            <Item href={href({ view: "about" })} active={route.view === "about"}>
              <Brain size={16} className="shrink-0" /> About you
            </Item>
          </Group>
        )}

      </div>

      {!page && (
        <div className="shrink-0 px-2 py-2 flex items-center gap-1 safe-bottom">
          <div className="flex-1 min-w-0">
            <Menu
              up
              trigger={(_o, t) => (
                <button onClick={t} className="w-full flex items-center gap-2.5 rounded-lg px-2 h-9 hover:bg-side-hover text-left">
                  <UserAvatar name={me.user.name} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/80">{me.user.name}</span>
                </button>
              )}
              items={[
                { label: "Profile", icon: <CircleUser size={14} />, onSelect: () => go({ view: "settings", page: "profile" }) },
                { label: "Preferences", icon: <SlidersHorizontal size={14} />, onSelect: () => go({ view: "settings", page: "preferences" }) },
                { label: "Notifications", icon: <Bell size={14} />, onSelect: () => go({ view: "settings", page: "notifications" }) },
                { label: "Appearance", icon: <Palette size={14} />, onSelect: () => go({ view: "settings", page: "appearance" }) },
                ...(mode !== "system" ? [{ label: "Match system light or dark", icon: <SunMoon size={14} />, onSelect: () => setMode("system") }] : []),
                "divider",
                { label: `${me.workspace.name} settings`, icon: <Settings size={14} />, onSelect: () => go({ view: "settings", page: "general" }) },
                ...(me.role === "owner" ? [{ label: "Invite people", icon: <UserPlus size={14} />, onSelect: () => go({ view: "settings", page: "people" }) }] : []),
                "divider",
                { label: "Sign out", icon: <LogOut size={14} />, onSelect: logout },
              ]}
            />
          </div>
          <button onClick={toggleMode} className="p-2 rounded-lg text-muted hover:text-ink hover:bg-side-hover" aria-label={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={resolvedMode === "dark" ? "Light mode" : "Dark mode"}>
            {resolvedMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      )}

      {browser && <ChannelBrowser sectionId={browser.sectionId} onClose={() => setBrowser(null)} />}
      {editing && <SectionDialog section={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </nav>
  );
}

/** The workspace's letter on a mint tile: Warren's one accent, like Paperclip's company tile. */
export function WorkspaceTile({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span className="shrink-0 rounded-md grid place-items-center font-semibold bg-accent text-accent-ink" style={{ width: size, height: size, fontSize: size * 0.55 }} aria-hidden>
      {(name.trim()[0] ?? "W").toUpperCase()}
    </span>
  );
}

/** A small mono label (AGENTS, CHANNELS, WORKSPACE); click it to fold the group away. */
function Group({ title, collapsed, onToggle, actions, page, children }: { title: ReactNode; collapsed: boolean; onToggle: () => void; actions?: ReactNode; page?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-px">
      <div className={cx("group px-4 flex items-center gap-1", page ? "h-9" : "h-7")}>
        <button onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-1 font-mono text-[10px] font-medium uppercase tracking-widest text-muted/70 hover:text-ink" aria-expanded={!collapsed}>
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

function Item({ href: to, onClick, active, unread, dot, count, page, agent, children }: { href?: string; onClick?: () => void; active?: boolean; unread?: boolean; dot?: boolean; count?: number; page?: boolean; agent?: Agent; children: ReactNode }) {
  const cls = cx(
    "mx-2 px-2 flex items-center gap-2.5 rounded-lg text-left w-[calc(100%-1rem)] transition-colors",
    page ? "h-11 text-[15px]" : "h-8 text-[13px] font-medium",
    // the open item is tinted mint, or in the agent's own color for a chat with it
    active ? (agent ? "agent-tint text-ink" : "bg-accent-soft text-ink") : "hover:bg-side-active/70 hover:text-ink",
    unread && !active && "font-semibold text-ink",
    !unread && !active && "text-ink/80",
  );
  const inner = (
    <>
      <span className="flex-1 min-w-0 flex items-center gap-2.5">{children}</span>
      {!!count && count > 0 ? (
        <span className="text-[11px] font-semibold bg-accent text-accent-ink rounded-full px-1.5 min-w-5 h-5 grid place-items-center">{count > 99 ? "99+" : count}</span>
      ) : (
        dot && <span className="size-1.5 rounded-full bg-accent shrink-0" />
      )}
    </>
  );
  const style = agent ? agentVar(agent) : undefined;
  return to ? (
    <a href={to} className={cls} style={style} aria-current={active ? "page" : undefined}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className={cls} style={style}>
      {inner}
    </button>
  );
}
