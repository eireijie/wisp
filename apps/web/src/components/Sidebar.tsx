import { useState, type ReactNode } from "react";
import { BookOpen, Bot, Brain, ChevronRight, FolderPlus, Hand, Hash, LogOut, Monitor, MoreHorizontal, Pencil, Plus, Search, Server, Settings, ShieldQuestion, Sparkles, Trash2, Users } from "lucide-react";
import type { Section } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import { logout } from "../App.tsx";
import { isDismissed, useOnboarding } from "../onboarding.ts";
import { ChannelBrowser, SectionDialog } from "./Channels.tsx";
import { AgentAvatar, Menu, StatusDot, UserAvatar, cx } from "./ui.tsx";

const COLLAPSE_KEY = "warren.sidebar.collapsed";
const loadCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
};

/**
 * The workspace sidebar. On desktop it sits on the tinted window background; on phones the
 * same content is the Chats screen (variant "page") with larger touch targets.
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
  const progress = Object.values(done).filter(Boolean).length;
  const showGetStarted = route.view === "welcome" || (progress < 4 && !isDismissed());
  const page = variant === "page";
  const isGuest = me.role === "guest";

  const active = route.view === "chat" ? route.channelId : null;
  const joined = channels.filter((c) => c.kind === "channel" && c.joined);
  const dmFor = (agentId: string) => channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  // what agents are waiting on a person for: approvals, and help on their computers
  const pending = Object.values(approvals).filter((a) => a.status === "pending");
  const helpNeeded = computers.filter((c) => c.help);
  const working = computers.some((c) => c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000);

  const toggle = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {}
  };

  async function openDm(agentId: string) {
    const existing = dmFor(agentId);
    if (existing) return go({ view: "chat", channelId: existing.id, threadId: null });
    const ch = await api<{ id: string }>("POST", `/api/dm/${agentId}`);
    await useStore.getState().refreshChannels();
    go({ view: "chat", channelId: ch.id, threadId: null });
  }

  const channelRow = (c: ChannelInfo) => (
    <Item key={c.id} page={page} href={href({ view: "chat", channelId: c.id, threadId: null })} active={active === c.id} unread={c.unread > 0} dot={c.unread > 0}>
      <Hash size={15} className="text-faint shrink-0" /> <span className="truncate">{c.name}</span>
    </Item>
  );

  return (
    <nav className={cx("h-full flex flex-col", !page && "safe-top")}>
      {!page && (
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <img src="/icon.svg" alt="" className="size-6" />
          <div className="font-semibold truncate flex-1">{me.workspace.name}</div>
          <span className={cx("size-1.5 rounded-full shrink-0", connected ? "bg-ok" : "bg-faint animate-pulse")} title={connected ? "Connected" : "Reconnecting…"} />
        </div>
      )}

      <div className={cx("px-2", page ? "pt-2" : "pt-1")}>
        <button onClick={() => setPalette(true)} className={cx("w-full flex items-center gap-2 rounded-lg px-2.5 text-muted bg-side-hover hover:bg-side-active", page ? "h-11 text-[15px]" : "h-8 text-[13px]")}>
          <Search size={15} />
          <span className="flex-1 text-left">Search everything</span>
          {!page && <kbd className="text-[11px] text-faint font-sans">⌘K</kbd>}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pt-3 pb-4 space-y-4">
        {!page && (
          <div className="space-y-px">
            {showGetStarted && (
              <Item href={href({ view: "welcome" })} active={route.view === "welcome"}>
                <Sparkles size={15} className="text-accent" /> Get started
                <span className="ml-auto text-[11px] text-muted tabular-nums">{progress}/4</span>
              </Item>
            )}
            <Item href={href({ view: "agents", agentId: null })} active={route.view === "agents"}>
              <Bot size={15} className="text-faint" /> Agents
            </Item>
            <Item href={href({ view: "teams", teamId: null })} active={route.view === "teams"}>
              <Users size={15} className="text-faint" /> Teams
            </Item>
            <Item href={href({ view: "vault", path: null })} active={route.view === "vault"}>
              <BookOpen size={15} className="text-faint" /> Memory
            </Item>
            <Item href={href({ view: "about" })} active={route.view === "about"}>
              <Brain size={15} className="text-faint" /> About you
            </Item>
            <Item href={href({ view: "computers", computerId: null })} active={route.view === "computers"}>
              <Monitor size={15} className="text-faint" /> Computers
              {working && <span className="ml-auto size-1.5 rounded-full bg-warn animate-pulse" title="An agent is working" />}
            </Item>
            <Item href={href({ view: "nodes" })} active={route.view === "nodes"}>
              <Server size={15} className="text-faint" /> Devices
            </Item>
          </div>
        )}

        {!isGuest && pending.length + helpNeeded.length > 0 && (
          <Group page={page} title="Waiting on you" collapsed={!!collapsed.waiting} onToggle={() => toggle("waiting")}>
            {helpNeeded.map((c) => {
              const a = agents.find((x) => x.id === c.help!.agentId);
              return (
                <Item key={c.id} page={page} href={href({ view: "computers", computerId: c.id })} active={route.view === "computers" && route.computerId === c.id} dot>
                  <Hand size={15} className="text-accent shrink-0" />
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
                  <ShieldQuestion size={15} className="text-accent shrink-0" />
                  <span className="truncate">
                    {a?.name ?? "Agent"}: {p.summary}
                  </span>
                </Item>
              );
            })}
          </Group>
        )}

        {sections.map((s) => {
          const list = joined.filter((c) => c.sectionId === s.id);
          return (
            <Group
              key={s.id}
              page={page}
              title={
                <>
                  {s.emoji && <span className="text-[13px]">{s.emoji}</span>} {s.name}
                </>
              }
              collapsed={!!collapsed[s.id]}
              onToggle={() => toggle(s.id)}
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
          onToggle={() => toggle("channels")}
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
            <Plus size={15} className="text-faint" /> <span className="text-muted">Add channels</span>
          </Item>
        </Group>

        <Group page={page} title="Direct messages" collapsed={!!collapsed.dms} onToggle={() => toggle("dms")} actions={!isGuest && <IconButton label="Add agent" onClick={() => go({ view: "agents", agentId: null })}><Plus size={14} /></IconButton>}>
          {agents.length === 0 && <p className="px-4 text-xs text-faint">No agents yet.</p>}
          {agents.map((a) => {
            const dm = dmFor(a.id);
            return (
              <Item key={a.id} page={page} onClick={() => openDm(a.id)} active={!!dm && active === dm.id} unread={!!dm && dm.unread > 0} count={dm?.unread}>
                <span className="relative shrink-0">
                  <AgentAvatar agent={a} size={page ? 30 : 22} badge={false} live />
                  <StatusDot status={a.status} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-sidebar" />
                </span>
                <span className="truncate">{a.name}</span>
              </Item>
            );
          })}
        </Group>
      </div>

      {!page && (
        <div className="p-2 safe-bottom">
          <Menu
            up
            trigger={(_o, t) => (
              <button onClick={t} className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-side-hover text-left">
                <UserAvatar name={me.user.name} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{me.user.name}</span>
                  <span className="block text-xs text-muted truncate">{me.workspace.name}</span>
                </span>
              </button>
            )}
            items={[
              { label: "Settings", icon: <Settings size={14} />, onSelect: () => go({ view: "settings" }) },
              { label: "Computers", icon: <Monitor size={14} />, onSelect: () => go({ view: "computers", computerId: null }) },
              { label: "Devices", icon: <Server size={14} />, onSelect: () => go({ view: "nodes" }) },
              "divider",
              { label: "Sign out", icon: <LogOut size={14} />, onSelect: logout },
            ]}
          />
        </div>
      )}

      {browser && <ChannelBrowser sectionId={browser.sectionId} onClose={() => setBrowser(null)} />}
      {editing && <SectionDialog section={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </nav>
  );
}

function Group({ title, collapsed, onToggle, actions, page, children }: { title: ReactNode; collapsed: boolean; onToggle: () => void; actions?: ReactNode; page?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-px">
      <div className={cx("group px-3 flex items-center gap-1", page ? "h-9" : "h-7")}>
        <button onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink" aria-expanded={!collapsed}>
          <ChevronRight size={13} className={cx("shrink-0 transition-transform", !collapsed && "rotate-90")} />
          <span className="truncate flex items-center gap-1">{title}</span>
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

function Item({ href: to, onClick, active, unread, dot, count, page, children }: { href?: string; onClick?: () => void; active?: boolean; unread?: boolean; dot?: boolean; count?: number; page?: boolean; children: ReactNode }) {
  const cls = cx(
    "mx-2 px-2 flex items-center gap-2 rounded-lg text-left w-[calc(100%-1rem)]",
    page ? "h-11 text-[15px]" : "h-8 text-[13.5px]",
    active ? "bg-side-active text-ink font-medium" : "hover:bg-side-hover",
    unread && !active && "font-semibold text-ink",
    !unread && !active && "text-ink/85",
  );
  const inner = (
    <>
      <span className="flex-1 min-w-0 flex items-center gap-2">{children}</span>
      {!!count && count > 0 ? (
        <span className="text-[11px] font-semibold bg-ink text-panel rounded-full px-1.5 min-w-5 h-5 grid place-items-center">{count > 99 ? "99+" : count}</span>
      ) : (
        dot && <span className="size-1.5 rounded-full bg-ink shrink-0" />
      )}
    </>
  );
  return to ? (
    <a href={to} className={cls}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}
