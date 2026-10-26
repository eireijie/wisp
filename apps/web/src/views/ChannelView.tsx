import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { FlowStrip } from "../components/TeamSteps.tsx";
import { Archive, Bell, BellOff, BellRing, Bot, Workflow, Wrench, Pin, PinOff, Square, SquareTerminal, Star, UserPlus, ArrowDown, Mic, Monitor, Phone, AtSign, Brain, Check, ChevronDown, RotateCcw, Zap, ChevronLeft, ChevronRight, CircleDot, Eye, Plus, Shield, ShieldAlert, Copy, FileText, Pencil, Trash2, GitPullRequest, Hash, Loader2, MessageSquare, MoreHorizontal, Paperclip, Settings2, Smile, SmilePlus, ArrowUp, Users, X } from "lucide-react";
import { parseMentions, type AccessLevel, type Agent, type ContextUsage, type HarnessCatalog, type Message, type MessagePart, type Reaction } from "@wisp/core";
import { api, fileUrl, uploadFile } from "../api.ts";
import { conversationKey, useHandleColors, useHandleNames, useNames, usePrefs, useStore, type ChannelInfo, type LiveRun } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import type { TaskRow } from "./TasksView.tsx";
import { renderMarkdown } from "../markdown.ts";
import { ChannelIcon, ChannelMembers, ChannelSettings, NOTIFY, landingChannel, setArchived, setChannelPrefs, type ChannelMember, type ChannelSettingsTab } from "../components/Channels.tsx";
import { EffortSlider, effortName, prettyModel } from "../components/EffortSlider.tsx";
import { DiscussionCard } from "../components/Discussion.tsx";
import { ApprovalCard, ChangeCard, ComputerPart, RoutineChip } from "../components/AgentCards.tsx";
import { AgentAvatar, Button, agentVar, clockTime, EmojiPicker, Empty, Field, harnessLabel, Input, Menu, Modal, Pill, Popover, StatusDot, UserAvatar, cx } from "../components/ui.tsx";
import { AgentPill } from "../components/AgentPill.tsx";
import { CallScreen } from "../voice/CallScreen.tsx";
import { takeDraft } from "../draft.ts";
import { AgentPanel, type AgentPanelTab } from "../components/AgentPanel.tsx";
import { slashQuery, useAgentCommands, useSlashMenu, type SlashItem } from "../components/SlashMenu.tsx";
import { ActivityPill } from "../components/ActivityPill.tsx";
import { RightPane } from "../components/RightPane.tsx";
import { workSummary } from "../components/agentActivity.ts";
import { useFeature } from "../features.ts";
import { openDm } from "../openDm.ts";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];

/** What's open in the pane beside the chat (a thread comes from the route instead). */
type Side = { kind: "agent"; agentId: string; tab: AgentPanelTab } | { kind: "members" };

/** The DM's own agent panel stays open across DMs once you open it. */
function storedDmPanel(): AgentPanelTab | null {
  try {
    return (localStorage.getItem("wisp.agentPanel") as AgentPanelTab | null) || null;
  } catch {
    return null;
  }
}

export function ChannelView({ route, onBack }: { route: Extract<Route, { view: "chat" }>; onBack?: () => void }) {
  const channels = useStore((s) => s.channels);
  const setActive = useStore((s) => s.setActive);
  const loadChannel = useStore((s) => s.loadChannel);
  const role = useStore((s) => s.me?.role);
  const names = useNames();
  const voice = useFeature("voice");
  const [calling, setCalling] = useState(!!route.call);
  useEffect(() => { setCalling(!!route.call); }, [route.channelId, route.call]);
  const [settings, setSettings] = useState<ChannelSettingsTab | null>(null);

  const channel = channels.find((c) => c.id === route.channelId) ?? (route.channelId ? undefined : landingChannel(channels));
  const dmAgentId = channel?.kind === "dm" ? channel.name.split(":").pop()! : null;
  // the pane beside the chat: an agent's details or the member list
  const [side, setSideState] = useState<Side | null>(null);
  useEffect(() => {
    const tab = dmAgentId ? storedDmPanel() : null;
    setSideState(dmAgentId && tab ? { kind: "agent", agentId: dmAgentId, tab } : null);
  }, [channel?.id, dmAgentId]);
  const setSide = (next: Side | null) => {
    setSideState(next);
    // remember the DM's own panel, so it's there in the next DM too
    if (!dmAgentId) return;
    try {
      if (next?.kind === "agent" && next.agentId === dmAgentId) localStorage.setItem("wisp.agentPanel", next.tab);
      else if (!next) localStorage.removeItem("wisp.agentPanel");
    } catch {}
  };
  /** Open a pane; a thread that's open closes first, since they share the space. */
  const openSide = (next: Side) => {
    if (route.threadId && channel) go({ view: "chat", channelId: channel.id, threadId: null });
    setSide(next);
  };
  const openAgent = (agentId: string, tab: AgentPanelTab = "details") => openSide({ kind: "agent", agentId, tab });
  const toggleMembers = () => (side?.kind === "members" && !route.threadId ? setSide(null) : openSide({ kind: "members" }));

  // where you'd stopped reading when you opened the channel; the "NEW" divider goes there
  const [readMark, setReadMark] = useState<{ channelId: string; at: string | null } | null>(null);

  useEffect(() => {
    if (!route.channelId && channel) go({ view: "chat", channelId: channel.id, threadId: null });
  }, [route.channelId, channel]);

  useEffect(() => {
    if (!channel) return;
    setReadMark({ channelId: channel.id, at: channel.lastReadAt });
    setActive(channel.id);
    void loadChannel(channel.id).catch(() => {});
    return () => {
      setActive(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id, setActive, loadChannel]);

  if (!channel) return <Empty icon={<Hash />} title={route.channelId ? "Team not found" : "No teams yet"} />;

  const dmAgent = dmAgentId ? names.agent(dmAgentId) : undefined;
  const sideAgent = !route.threadId && side?.kind === "agent" ? names.agent(side.agentId) : undefined;
  const dmPanel = sideAgent && dmAgent && sideAgent.id === dmAgent.id ? (side as Extract<Side, { kind: "agent" }>).tab : null;

  return (
    <div className="flex-1 min-h-0 flex">
      <div className={cx("flex-1 min-w-0 flex flex-col", route.threadId && "hidden lg:flex")}>
        <header className={cx("shrink-0 px-4 md:px-6 flex items-center gap-2 safe-top", dmAgent ? "relative h-20" : "h-15 border-b border-line")}>
          {onBack && (
            <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back to chats">
              <ChevronLeft size={22} />
            </button>
          )}
          {dmAgent ? (
            <>
              {/* the agent lives here, in the middle, and nowhere else in its DM */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center pointer-events-none">
                <div className="pointer-events-auto">
                  <AgentPill agent={dmAgent} open={dmPanel === "details"} onClick={() => (dmPanel === "details" ? setSide(null) : openAgent(dmAgent.id, "details"))} />
                </div>
              </div>
              <span className="flex-1" />
            </>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="font-semibold flex items-center gap-1 text-[15px] min-w-0">
                <ChannelIcon channel={channel} size={16} />
                <span className="truncate">{channel.name}</span>
                <button
                  onClick={() => void setChannelPrefs(channel, { starred: !channel.starred })}
                  className={cx("ml-0.5 size-6 rounded-md grid place-items-center hover:bg-hover", channel.starred ? "text-ink" : "text-faint hover:text-ink")}
                  aria-label={channel.starred ? `Unpin #${channel.name}` : `Pin #${channel.name}`}
                  aria-pressed={channel.starred}
                  title={channel.starred ? "Pinned" : "Pin to top"}
                >
                  <Pin size={14} fill={channel.starred ? "currentColor" : "none"} />
                </button>
              </div>
              <ChannelSubtitle channel={channel} onAgents={() => setSettings(channel.settings.team?.nodes.length ? "team" : "agents")} />
            </div>
          )}
          {dmAgent?.computerId && (
            <button onClick={() => (dmPanel === "computer" ? setSide(null) : openAgent(dmAgent.id, "computer"))} className={cx("size-9 rounded-full hover:bg-hover grid place-items-center hover:text-ink", dmPanel === "computer" ? "text-ink bg-hover" : "text-muted")} aria-label={`${dmAgent.name}'s computer`} title={`${dmAgent.name}'s computer`}>
              <Monitor size={18} />
            </button>
          )}
          {dmAgent && voice && <button onClick={() => setCalling(true)} className="size-9 rounded-full hover:bg-hover grid place-items-center text-muted hover:text-ink" aria-label={`Call ${dmAgent.name}`} title={`Call ${dmAgent.name}`}><Phone size={18} /></button>}
          {channel.kind === "channel" && (
            <div className="flex items-center gap-1.5 shrink-0">
              <TeamButton channel={channel} onClick={() => setSettings("team")} />
              <MemberStack channel={channel} open={side?.kind === "members" && !route.threadId} onClick={toggleMembers} />
              {channel.pinnedIds.length > 0 && (
                <button onClick={() => setSettings("pins")} className="h-8 px-2 rounded-lg border border-line text-xs text-muted hover:text-ink inline-flex items-center gap-1" aria-label={`Pinned: ${channel.pinnedIds.length}`} title="Pinned messages">
                  <Pin size={14} /> {channel.pinnedIds.length}
                </button>
              )}
              <NotifyMenu channel={channel} />
              <button onClick={() => setSettings("about")} className="size-8 rounded-lg border border-line text-muted hover:text-ink grid place-items-center" aria-label="Team settings" title="Team settings">
                <Settings2 size={15} />
              </button>
            </div>
          )}
        </header>
        <SoloAgent.Provider value={dmAgent?.id ?? null}>
          <MessageList messageId={!route.threadId ? route.messageId : undefined} channel={channel} readMark={readMark?.channelId === channel.id ? readMark.at : null} onAddAgent={() => setSettings("team")} onMembers={() => openSide({ kind: "members" })} />
        </SoloAgent.Provider>
        {channel.archivedAt ? <ArchivedBar channel={channel} /> : <Composer channelId={channel.id} agentId={dmAgent?.id} placeholder={dmAgent ? `Message ${dmAgent.name}` : `Message #${channel.name}`} onDetails={openAgent} />}
      </div>
      {route.threadId && <ThreadPanel key={route.threadId} messageId={route.messageId} channelId={channel.id} rootId={route.threadId} agentId={dmAgent?.id} />}
      {sideAgent && side?.kind === "agent" && (
        <AgentPanel
          key={sideAgent.id}
          agent={sideAgent}
          tab={side.tab}
          inDm={sideAgent.id === dmAgent?.id}
          onTab={(tab) => setSide({ kind: "agent", agentId: sideAgent.id, tab })}
          onClose={() => setSide(null)}
          onCall={() => (sideAgent.id === dmAgent?.id ? setCalling(true) : void callAgent(sideAgent.id))}
        />
      )}
      {!route.threadId && side?.kind === "members" && channel.kind === "channel" && (
        <RightPane label={`People and agents in #${channel.name}`}>
          <div className="h-15 shrink-0 flex items-center gap-2 px-4 border-b border-line">
            <span className="font-semibold flex-1">Members · {channel.memberCount}</span>
            <button onClick={() => setSide(null)} className="size-8 rounded-lg grid place-items-center text-muted hover:text-ink hover:bg-hover" aria-label="Close panel" title="Close">
              <X size={17} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <ChannelMembers channel={channel} canManage={role === "owner" || role === "member"} onClose={() => setSide(null)} />
          </div>
        </RightPane>
      )}
      {calling && dmAgent && <CallScreen key={`${channel.id}:${dmAgent.id}`} agent={dmAgent} channelId={channel.id} onClose={() => { setCalling(false); if (route.call) go({ view: "chat", channelId: channel.id, threadId: null }); }} />}
      {settings && <ChannelSettings key={settings} channel={channel} tab={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}

/** Call an agent from somewhere other than its DM: open the DM with the call started. */
async function callAgent(agentId: string) {
  await openDm(agentId);
  const dm = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  if (dm) go({ view: "chat", channelId: dm.id, threadId: null, call: true });
}

/**
 * The people and agents in a channel as a stack of faces (ghosts for agents, initials for
 * people) and a count. Opens the member list beside the chat.
 */
function MemberStack({ channel, open, onClick }: { channel: ChannelInfo; open: boolean; onClick: () => void }) {
  const agents = useStore((s) => s.agents);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  useEffect(() => {
    let live = true;
    api<ChannelMember[]>("GET", `/api/channels/${channel.id}/members`).then((m) => live && setMembers(m), () => live && setMembers(null));
    return () => {
      live = false;
    };
  }, [channel.id, channel.memberCount]);
  // people first, like the mockup; then agents
  const faces = [...(members ?? []).filter((m) => m.kind === "user"), ...(members ?? []).filter((m) => m.kind === "agent")].slice(0, 4);
  const count = channel.memberCount;
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className={cx("h-8 pl-1.5 pr-2.5 rounded-full border border-line inline-flex items-center gap-2 hover:bg-hover", open && "bg-hover")}
      title={`${count} ${count === 1 ? "member" : "members"}`}
      aria-label={`Members: ${count}`}
    >
      {faces.length > 0 ? (
        <span className="flex">
          {faces.map((m, i) => (
            // one face on a phone, so the channel's name and who leads it keep their room
            <span key={`${m.kind}:${m.id}`} className={cx("rounded-full ring-2 ring-panel bg-panel", i > 0 && "-ml-1.5 max-sm:hidden")}>
              {m.kind === "agent" ? <AgentAvatar agent={agents.find((a) => a.id === m.id) ?? { name: m.name, handle: m.handle ?? undefined, harness: "custom" }} size={20} interactive={false} /> : <UserAvatar name={m.name} size={20} />}
            </span>
          ))}
        </span>
      ) : (
        <Users size={14} className="text-muted" />
      )}
      <span className="text-xs font-semibold text-muted tabular-nums">{count}</span>
    </button>
  );
}

/** Under a channel's name: its topic, and who answers there when nobody's @mentioned. */
function ChannelSubtitle({ channel, onAgents }: { channel: ChannelInfo; onAgents: () => void }) {
  const names = useNames();
  // nobody answers in an archived channel
  const answerer = channel.settings.defaultAgentId && !channel.archivedAt ? names.agent(channel.settings.defaultAgentId) : undefined;
  const leads = channel.archivedAt ? [] : (channel.settings.team?.nodes ?? []).filter((n) => n.lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a);
  if (!channel.topic && !answerer && !leads.length) return null;
  return (
    <div className="text-xs text-muted truncate">
      {leads.length > 0 ? (
        <button onClick={onAgents} className="hover:text-ink hover:underline" title="The team">
          {leads.map((a) => a.name).join(" and ")} {leads.length > 1 ? "lead" : "leads"} here
        </button>
      ) : answerer && (
        <button onClick={onAgents} className="hover:text-ink hover:underline" title="Who answers here">
          {answerer.name} answers here
        </button>
      )}
      {(leads.length > 0 || answerer) && channel.topic && " · "}
      {channel.topic}
    </div>
  );
}

/** The channel's team, from the header: how many agents are on it, and a green dot while any of them works. */
function TeamButton({ channel, onClick }: { channel: ChannelInfo; onClick: () => void }) {
  const names = useNames();
  const live = useStore((s) => s.live);
  const team = (channel.settings.team?.nodes ?? []).filter((n) => names.agent(n.agentId));
  if (!team.length) return null;
  const busy = new Set(Object.values(live).filter((r) => r.channelId === channel.id).map((r) => r.agentId));
  const working = team.filter((n) => busy.has(n.agentId)).length;
  return (
    <button onClick={onClick} className="h-8 px-2 rounded-lg border border-line text-xs text-muted hover:text-ink inline-flex items-center gap-1.5" aria-label={`Team: ${team.length} agents${working ? `, ${working} working` : ""}`} title={working ? `${working} of the team working` : "The team"}>
      <Workflow size={14} /> {team.length}
      {working > 0 && <span className="size-1.5 rounded-full bg-ok animate-pulse" aria-hidden />}
    </button>
  );
}

/** Your own say in how loud a channel is. */
function NotifyMenu({ channel }: { channel: ChannelInfo }) {
  const icon = channel.notify === "mute" ? <BellOff size={15} /> : channel.notify === "all" ? <BellRing size={15} /> : <Bell size={15} />;
  return (
    <Popover
      align="right"
      up={false}
      className="w-72 p-1.5"
      trigger={(open, toggle) => (
        <button onClick={toggle} aria-expanded={open} className={cx("size-8 rounded-lg border border-line grid place-items-center hover:text-ink", channel.notify === "default" ? "text-muted" : "text-ink")} aria-label={`Notifications: ${NOTIFY[channel.notify].label}`} title={`Notifications: ${NOTIFY[channel.notify].label}`}>
          {icon}
        </button>
      )}
    >
      {(close) => (
        <div role="menu">
          {(Object.keys(NOTIFY) as (keyof typeof NOTIFY)[]).map((k) => (
            <button
              key={k}
              role="menuitemradio"
              aria-checked={channel.notify === k}
              onClick={() => {
                close();
                void setChannelPrefs(channel, { notify: k });
              }}
              className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-hover flex gap-2"
            >
              <span className="w-4 pt-0.5 shrink-0">{channel.notify === k && <Check size={14} />}</span>
              <span>
                <span className="block text-sm font-medium">{NOTIFY[k].label}</span>
                <span className="block text-xs text-muted">{NOTIFY[k].body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Where the composer would be, in an archived channel. */
function ArchivedBar({ channel }: { channel: ChannelInfo }) {
  const canManage = useStore((s) => s.me?.role !== "guest");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="shrink-0 px-3 md:px-5 pb-3 pt-1 safe-bottom">
      <div className="rounded-2xl border border-line bg-bg px-4 py-3 flex items-center gap-3 text-sm">
        <Archive size={16} className="text-muted shrink-0" />
        <span className="flex-1 text-muted">#{channel.name} is archived. You can read and search it, but nobody can post here.</span>
        {canManage && (
          <Button onClick={() => setArchived(channel, false).catch((e) => setError((e as Error).message))}>Unarchive</Button>
        )}
      </div>
      {error && <p className="pt-1 px-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

// --- who you're talking to ----------------------------------------------------------------------

interface AgentContext {
  harness: string;
  harnessVersion: string | null;
  model: string | null;
  modelIsDefault: boolean;
  effort: string | null;
  effortIsDefault: boolean;
  access: AccessLevel;
  fast: boolean;
  fastAvailable: boolean;
  fastDescription: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  lastRunAt: string | null;
}

const ACCESS: Record<AccessLevel, { label: string; body: string }> = {
  "read-only": { label: "Read only", body: "Reads files and answers; changes nothing." },
  edit: { label: "Can edit files", body: "Edits files in its own working folder." },
  full: { label: "Full access", body: "No sandbox. Needs a device started with --allow-full-access." },
};

function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Everything the DM composer shows about its agent: settings, the device's model catalog, and
 * how full this conversation's context is. Refreshes after each reply and on settings changes.
 */
function useAgentContext(agentId: string | undefined, channelId: string, threadId?: string) {
  const agent = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined));
  const messages = useStore((s) => (threadId ? s.threads[threadId] : s.messages[channelId]));
  const [ctx, setCtx] = useState<AgentContext | null>(null);
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(null);
  const lastAgentMsg = [...(messages ?? [])].reverse().find((m) => m.author.kind === "agent")?.id;
  const settingsKey = agent ? `${agent.model}|${agent.settings.effort}|${agent.settings.access}|${agent.settings.fast}|${agent.nodeId}` : "";
  useEffect(() => {
    if (!agentId) return;
    api<AgentContext>("GET", `/api/agents/${agentId}/context?channel=${channelId}${threadId ? `&thread=${threadId}` : ""}`).then(setCtx, () => setCtx(null));
  }, [agentId, channelId, threadId, lastAgentMsg, settingsKey]);
  useEffect(() => {
    if (!agentId) return;
    api<{ catalog: HarnessCatalog | null }>("GET", `/api/agents/${agentId}/models`).then((r) => setCatalog(r.catalog), () => setCatalog(null));
  }, [agentId, agent?.nodeId]);
  return { agent, ctx, catalog };
}

async function patchAgent(agentId: string, body: unknown) {
  await api("PATCH", `/api/agents/${agentId}`, body);
  await useStore.getState().refreshAgents();
}

/** Codex-style permission chip; orange when the agent has full access. */
function AccessControl({ agent, ctx, canEdit }: { agent: Agent; ctx: AgentContext; canEdit: boolean }) {
  const a = ctx.access;
  return (
    <Popover
      className="w-72 p-1.5"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={canEdit ? toggle : undefined}
          title={canEdit ? "Change what it can do" : ACCESS[a].body}
          className={cx("h-8 px-2 rounded-lg inline-flex items-center gap-1.5 text-[13px] font-medium", a === "full" ? "text-accent-text" : "text-muted", canEdit && "hover:bg-hover", open && "bg-hover")}
        >
          {a === "full" ? <ShieldAlert size={15} /> : a === "read-only" ? <Eye size={15} /> : <Shield size={15} />}
          <span className="hidden @lg:inline">{ACCESS[a].label}</span>
        </button>
      )}
    >
      {(close) => (
        <div role="menu">
          <div className="px-2.5 pt-1.5 pb-1 text-[13px] font-semibold text-faint">What {agent.name} can do</div>
          {(Object.keys(ACCESS) as AccessLevel[]).map((k) => (
            <button
              key={k}
              role="menuitemradio"
              aria-checked={a === k}
              onClick={async () => {
                close();
                if (k !== a) await patchAgent(agent.id, { settings: { access: k } });
              }}
              className="w-full text-left rounded-xl px-2.5 py-2 hover:bg-hover flex items-start gap-2.5"
            >
              <span className={cx("mt-0.5", k === "full" ? "text-accent-text" : "text-muted")}>{k === "full" ? <ShieldAlert size={16} /> : k === "read-only" ? <Eye size={16} /> : <Shield size={16} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{ACCESS[k].label}</span>
                <span className="block text-xs text-muted">{ACCESS[k].body}</span>
              </span>
              {a === k && <Check size={15} className="mt-0.5 text-accent-text" />}
            </button>
          ))}
          <a href={`#/agents/${agent.id}/permissions`} onClick={close} className="block px-2.5 py-2 text-xs text-muted hover:text-ink">
            Permission settings →
          </a>
        </div>
      )}
    </Popover>
  );
}

/** Display names the way Codex shows them: "GPT-5.6-Sol" -> "GPT-5.6 Sol". */

/**
 * "GPT-5.6 Sol Extra High ⌄", Codex style. Opens an effort panel (slider, fast mode, reset);
 * the model name in it opens the model list.
 */
function ModelControl({ agent, ctx, catalog, canEdit }: { agent: Agent; ctx: AgentContext; catalog: HarnessCatalog | null; canEdit: boolean }) {
  const current = catalog?.models.find((m) => m.id === ctx.model);
  const label = prettyModel(current?.label ?? ctx.model ?? "Default model");
  return (
    <Popover
      align="right"
      className="w-60 max-w-[calc(100vw-2rem)]"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={canEdit ? toggle : undefined}
          title={`${harnessLabel(ctx.harness) ?? ctx.harness} · ${ctx.model ?? "default model"}${ctx.effort ? ` · ${ctx.effort} effort` : ""}${ctx.fast ? " · fast" : ""}`}
          className={cx("h-8 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[13px] min-w-0", canEdit && "hover:bg-hover", open && "bg-hover")}
        >
          {ctx.fast && ctx.fastAvailable && <Zap size={13} className="text-accent-text fill-accent shrink-0" />}
          <span className="font-medium truncate max-w-24 @sm:max-w-32 @md:max-w-44 @lg:max-w-none">{label}</span>
          {ctx.effort && <span className="text-muted whitespace-nowrap hidden @sm:inline">{effortName(ctx.effort)}</span>}
          {canEdit && <ChevronDown size={14} className="text-faint shrink-0" />}
        </button>
      )}
    >
      {(close) => <ModelPanel agent={agent} ctx={ctx} catalog={catalog} close={close} />}
    </Popover>
  );
}

function ModelPanel({ agent, ctx, catalog, close }: { agent: Agent; ctx: AgentContext; catalog: HarnessCatalog | null; close: () => void }) {
  const [view, setView] = useState<"effort" | "models">("effort");
  const models = catalog?.models ?? [];
  const current = models.find((m) => m.id === ctx.model);
  const levels = current?.efforts ?? catalog?.efforts ?? [];
  // the hub knows what an unset effort resolves to (last run, then device config, then model default)
  const defaultEffort = [ctx.effortIsDefault ? ctx.effort : null, catalog?.defaultEffort, current?.defaultEffort].find((e) => e && levels.includes(e)) ?? levels[Math.floor(levels.length / 2)] ?? "";
  // move the thumb right away; the save follows
  const [effort, setEffort] = useState(agent.settings.effort ?? null);
  const [fast, setFast] = useState(!!agent.settings.fast);
  const shown = effort ?? defaultEffort;
  // the slider reports every level it lands on mid-drag; save once it settles
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveEffort = (level: string | null, delay = 350) => {
    clearTimeout(pending.current);
    setEffort(level);
    pending.current = setTimeout(() => void patchAgent(agent.id, { settings: { effort: level } }), delay);
  };

  if (view === "models")
    return (
      <div className="p-1 max-h-[45vh] overflow-y-auto" role="menu">
        <button onClick={() => setView("effort")} className="w-full px-2 pt-1 pb-1 flex items-center gap-1 text-[11px] text-muted hover:text-ink">
          <ChevronLeft size={12} /> Select model
        </button>
        <ModelItem
          label="Default"
          sub={catalog?.defaultModel ? `Uses ${prettyModel(models.find((m) => m.id === catalog.defaultModel)?.label ?? catalog.defaultModel)}` : "The device's own setting"}
          checked={!agent.model}
          onClick={async () => {
            setView("effort");
            if (agent.model) await patchAgent(agent.id, { model: null });
          }}
        />
        {models.map((m) => (
          <ModelItem
            key={m.id}
            label={prettyModel(m.label)}
            checked={agent.model === m.id}
            onClick={async () => {
              setView("effort");
              if (agent.model === m.id) return;
              // drop an effort the new model doesn't support
              const keep = !agent.settings.effort || !m.efforts || m.efforts.includes(agent.settings.effort);
              if (!keep) setEffort(null);
              await patchAgent(agent.id, { model: m.id, ...(keep ? {} : { settings: { effort: null } }) });
            }}
          />
        ))}
        {agent.model && !models.some((m) => m.id === agent.model) && <ModelItem label={agent.model} sub="Custom model id" checked onClick={() => setView("effort")} />}
        {!catalog && <p className="px-2.5 py-2 text-xs text-muted">Its device hasn't reported models yet. Start the device to see them.</p>}
      </div>
    );

  return (
    <div className="p-2.5 space-y-2">
      <div className="flex items-start gap-1">
        <button
          type="button"
          disabled={!ctx.fastAvailable}
          onClick={async () => {
            setFast(!fast);
            await patchAgent(agent.id, { settings: { fast: !fast } });
          }}
          aria-pressed={fast}
          title={ctx.fastAvailable ? `Fast mode${ctx.fastDescription ? `: ${ctx.fastDescription}` : ""}` : "This model has no fast mode"}
          className={cx("size-6 rounded-full grid place-items-center transition-colors", fast && ctx.fastAvailable ? "bg-accent-soft text-accent-text" : "text-muted hover:text-ink hover:bg-hover", !ctx.fastAvailable && "opacity-40")}
        >
          <Zap size={13} className={cx(fast && ctx.fastAvailable && "fill-accent")} />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-sm font-semibold text-accent-text leading-tight">{shown ? effortName(shown) : "Default"}</div>
          <button onClick={() => setView("models")} className="inline-flex items-center gap-0.5 text-[11px] text-muted hover:text-ink">
            {prettyModel(current?.label ?? ctx.model ?? "Default model")}
            <ChevronRight size={12} />
          </button>
          {(fast && ctx.fastAvailable) || !effort ? (
            <div className="text-[10px] text-faint">
              {!effort && "Default effort"}
              {!effort && fast && ctx.fastAvailable && " · "}
              {fast && ctx.fastAvailable && <span className="text-accent-text">Fast{ctx.fastDescription ? `: ${ctx.fastDescription}` : ""}</span>}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          disabled={!effort}
          onClick={() => saveEffort(null, 0)}
          title="Reset to the default effort"
          aria-label="Reset effort"
          className="size-6 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-hover disabled:opacity-30"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {levels.length > 0 ? (
        <EffortSlider
          size="sm"
          levels={levels}
          value={shown}
          onChange={(l) => saveEffort(l)}
        />
      ) : (
        <p className="text-xs text-muted text-center">This model doesn't offer effort levels.</p>
      )}
      <a href={`#/agents/${agent.id}/model`} onClick={close} className="block text-center text-[11px] text-faint hover:text-ink">
        Model settings
      </a>
    </div>
  );
}

function ModelItem({ label, sub, checked, onClick }: { label: string; sub?: string; checked: boolean; onClick: () => void }) {
  return (
    <button role="menuitemradio" aria-checked={checked} onClick={onClick} className={cx("w-full text-left rounded-md px-2 py-1 flex items-center gap-2", checked ? "bg-hover" : "hover:bg-hover")}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs truncate">{label}</span>
        {sub && <span className="block text-[10px] text-muted truncate">{sub}</span>}
      </span>
      {checked && <Check size={12} className="shrink-0" />}
    </button>
  );
}

/** Claude-style context ring: how full this conversation's context window is. */
function ContextRing({ ctx }: { ctx: AgentContext }) {
  const pct = ctx.contextUsed !== null && ctx.contextWindow ? Math.min(100, (ctx.contextUsed / ctx.contextWindow) * 100) : null;
  const color = pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)";
  const r = 7;
  const c = 2 * Math.PI * r;
  const summary = pct !== null ? `${pct < 1 ? "<1" : Math.round(pct)}% of context used` : ctx.contextWindow ? `${tokens(ctx.contextWindow)} context window` : "Context appears after the first reply";
  return (
    <Popover
      align="right"
      className="w-72 p-3.5"
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} title={summary} aria-label={summary} className={cx("size-8 rounded-lg grid place-items-center hover:bg-hover", open && "bg-hover")}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle cx="9" cy="9" r={r} fill="none" stroke="var(--chip)" strokeWidth="2.6" />
            {pct !== null && <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${(Math.max(pct, 3) / 100) * c} ${c}`} transform="rotate(-90 9 9)" />}
          </svg>
        </button>
      )}
    >
      {() => (
        <div className="space-y-2.5 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">Context window</span>
            {pct !== null && <span className="text-xs tabular-nums" style={{ color }}>{pct < 1 ? "<1" : Math.round(pct)}%</span>}
          </div>
          {pct !== null && (
            <div className="h-1.5 rounded-full bg-chip overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
            </div>
          )}
          <p className="text-muted">
            {ctx.contextUsed !== null ? (
              <>
                <b className="text-ink tabular-nums">{ctx.contextUsed.toLocaleString()}</b>
                {ctx.contextWindow && <> of <b className="text-ink tabular-nums">{ctx.contextWindow.toLocaleString()}</b></>} tokens used in this conversation
                {ctx.model && <> on {ctx.model}</>}.
              </>
            ) : ctx.contextWindow ? (
              <>
                {ctx.model ?? "This model"} has a {ctx.contextWindow.toLocaleString()}-token window. Usage shows up after the first reply.
              </>
            ) : (
              "Usage shows up after the first reply."
            )}
          </p>
          {pct !== null && pct > 60 && <p className="text-xs text-muted">It's getting full. Start a new thread to give the agent a fresh context; its memory carries over.</p>}
        </div>
      )}
    </Popover>
  );
}

/** An agent's answer to /context: how full its conversation is, with a way to shrink it when its harness has one. */
function ContextCard({ usage }: { usage: ContextUsage | null }) {
  const author = useContext(CardAuthor);
  const commands = useAgentCommands(author?.agentId);
  const channelKind = useStore((s) => s.channels.find((c) => c.id === author?.channelId)?.kind);
  const agent = useStore((s) => s.agents.find((a) => a.id === author?.agentId));
  const shrink = commands.find((c) => c.via === "raw" && (c.name === "compact" || c.name === "compress"));
  const used = usage?.contextUsed ?? null;
  const window = usage?.contextWindow ?? null;
  const pct = used !== null && window ? Math.min(100, (used / window) * 100) : null;
  const color = pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)";
  async function run() {
    if (!author || !shrink || !agent) return;
    await api("POST", `/api/channels/${author.channelId}/messages`, { body: `${channelKind === "dm" ? "" : `@${agent.handle} `}/${shrink.name}`, threadId: author.threadId ?? undefined });
  }
  return (
    <div className="mt-1.5 max-w-md rounded-2xl border border-line bg-panel p-3.5 space-y-2.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold tabular-nums">{used !== null ? `${tokens(used)}${window ? ` of ${tokens(window)}` : ""} used` : "Nothing used yet"}</span>
        {usage?.model && <span className="text-xs text-muted truncate">{prettyModel(usage.model)}</span>}
      </div>
      {pct !== null && (
        <div className="h-2 rounded-full bg-chip overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
        </div>
      )}
      {used === null && <p className="text-xs text-muted">This shows up after its first reply here.</p>}
      {shrink && used !== null && (
        <Button className="h-8" onClick={run}>
          {shrink.name === "compact" ? "Compact" : "Compress"}
        </Button>
      )}
    </div>
  );
}

/** Which message a card sits in, for cards that act on their conversation. */
const CardAuthor = createContext<{ agentId: string; channelId: string; threadId: string | null } | null>(null);

// --- message list -------------------------------------------------------------------------------

/** In a DM the agent lives in the pill at the top, so its messages don't repeat its ghost and name. */
const SoloAgent = createContext<string | null>(null);

/** Shared paging, retry and search positioning for a channel or thread. */
function useMessageHistory(channelId: string, threadId: string | undefined, messageId: string | undefined, ref: RefObject<HTMLDivElement | null>, messages: Message[] | undefined) {
  const key = conversationKey(channelId, threadId);
  const earlier = useStore((s) => s.hasEarlier[key]);
  const error = useStore((s) => s.loadErrors[key]);
  const loading = useStore((s) => s.loadingMessages[key]);
  const snapshot = useRef<{ height: number; top: number } | null>(null);
  const prepended = useRef(false);
  const search = useRef({ key: "", pages: 0, found: false });
  const highlight = useRef<(() => void) | null>(null);
  const loadEarlier = async () => {
    if (ref.current) snapshot.current = { height: ref.current.scrollHeight, top: ref.current.scrollTop };
    try { await useStore.getState().loadEarlier(channelId, threadId); } catch { snapshot.current = null; }
  };
  useLayoutEffect(() => {
    prepended.current = !!snapshot.current;
    if (ref.current && snapshot.current) ref.current.scrollTop = snapshot.current.top + ref.current.scrollHeight - snapshot.current.height;
    snapshot.current = null;
  }, [messages]);
  useEffect(() => {
    const searchKey = `${key}/${messageId ?? ""}`;
    if (search.current.key !== searchKey) search.current = { key: searchKey, pages: 0, found: false };
    if (!messageId || !messages || loading || error || search.current.found) return;
    const row = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find((el) => el.dataset.messageId === messageId);
    if (row) {
      search.current.found = true;
      row.scrollIntoView({ block: "center" });
      highlight.current?.();
      row.classList.add("bg-accent-soft");
      const timer = setTimeout(() => row.classList.remove("bg-accent-soft"), 2000);
      highlight.current = () => { clearTimeout(timer); row.classList.remove("bg-accent-soft"); };
    } else if (earlier && search.current.pages < 10) {
      search.current.pages++;
      void loadEarlier();
    }
  }, [key, messageId, messages, loading, error, earlier]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlight.current?.(), []);
  const retry = () => {
    const state = useStore.getState();
    if (error?.earlier) void loadEarlier();
    else void (threadId ? state.loadThread(channelId, threadId) : state.loadChannel(channelId)).catch(() => {});
  };
  const controls = <>
    {earlier && <div className="px-5 py-1 text-center"><button className="text-xs text-muted hover:text-ink hover:underline" disabled={loading} onClick={() => void loadEarlier()}>Show earlier messages</button></div>}
    {error && <p role="alert" className="px-5 py-2 text-xs text-bad">Couldn't load messages: {error.message} <button className="underline" disabled={loading} onClick={retry}>Try again</button></p>}
  </>;
  return { controls, error, prepended };
}

function MessageList({ channel, readMark, onAddAgent, onMembers, messageId }: { messageId?: string; channel: ChannelInfo; readMark: string | null; onAddAgent: () => void; onMembers: () => void }) {
  const messages = useStore((s) => s.messages[channel.id]);
  const replyCounts = useStore((s) => s.replyCounts);
  const live = useStore((s) => s.live);
  const me = useStore((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  const history = useMessageHistory(channel.id, undefined, messageId, ref, messages);
  const dividerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newSince, setNewSince] = useState(0);
  const positioned = useRef<string | null>(null);
  const lastCount = useRef(0);
  const runs = Object.values(live).filter((r) => r.channelId === channel.id && !r.threadId && (r.text || r.usedComputer));
  const inThreads = Object.values(live).filter((r) => r.channelId === channel.id && r.threadId);

  // first message from someone else after where you'd read up to
  const firstNew = useMemo(() => {
    if (!messages || !readMark) return null;
    return messages.find((m) => m.createdAt > readMark && m.author.id !== me?.user.id && m.author.id !== "system")?.id ?? null;
  }, [messages, readMark, me]);

  // on open: jump to the NEW divider (or the bottom); afterwards stick to the bottom if you're there
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !messages) return;
    if (positioned.current !== channel.id) {
      positioned.current = channel.id;
      lastCount.current = messages.length;
      if (dividerRef.current) dividerRef.current.scrollIntoView({ block: "center" });
      else el.scrollTop = el.scrollHeight;
      return;
    }
    if (history.prepended.current) { history.prepended.current = false; lastCount.current = messages.length; return; }
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (added > 0) setNewSince((n) => n + added);
  }, [messages, runs.map((r) => r.text.length).join(), channel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setNewSince(0);
    setAtBottom(true);
  }, [channel.id]);

  if (!messages) return <div className="flex-1 grid place-items-center text-sm text-muted">{history.error ? history.controls : "Loading…"}</div>;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={ref}
        className="h-full overflow-y-auto pt-4 pb-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setAtBottom(bottom);
          if (bottom) setNewSince(0);
        }}
      >
        {history.controls}
        {!history.error && messages.length < 100 && <ChannelIntro channel={channel} empty={!messages.some((m) => m.author.id !== "system")} onAddAgent={onAddAgent} onMembers={onMembers} />}
        {messages.map((m, i) => (
          <div key={m.id}>
            {m.id === firstNew && (
              <div ref={dividerRef} className="flex items-center gap-3 px-5 my-2 text-[11px] font-semibold tracking-wide text-accent-text">
                <span className="h-px flex-1 bg-accent/40" /> NEW <span className="h-px flex-1 bg-accent/40" />
              </div>
            )}
            <MessageItem m={m} grouped={isGrouped(messages[i - 1], m) && m.id !== firstNew} replies={replyCounts[m.id]} working={inThreads.filter((r) => r.threadId === m.id || r.threadPath.includes(m.id))} onReplies={() => go({ view: "chat", channelId: channel.id, threadId: m.id })} />
          </div>
        ))}
        {runs.map((r) => (
          <StreamingItem key={r.runId} run={r} />
        ))}
      </div>
      {!atBottom && (
        <button
          onClick={() => {
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
            setNewSince(0);
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 h-8 px-3 rounded-full bg-panel border border-line shadow-panel text-xs font-medium inline-flex items-center gap-1.5 hover:bg-hover"
        >
          <ArrowDown size={13} /> {newSince > 0 ? `${newSince} new ${newSince === 1 ? "message" : "messages"}` : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

function ChannelIntro({ channel, empty, onAddAgent, onMembers }: { channel: ChannelInfo; empty: boolean; onAddAgent: () => void; onMembers: () => void }) {
  const names = useNames();
  const invite = useFeature("invite");
  const canManage = useStore((s) => s.me?.role !== "guest") && !channel.archivedAt;
  if (channel.kind === "dm") {
    const a = names.agent(channel.name.split(":").pop()!);
    return (
      <div className="px-5 pb-6 pt-6 text-center">
        <p className="text-sm text-muted max-w-md mx-auto">This is the start of your conversation with @{a?.handle}. Messages here always go to {a?.name ?? "it"}; no @mention needed.</p>
      </div>
    );
  }
  const answerer = channel.settings.defaultAgentId ? names.agent(channel.settings.defaultAgentId) : undefined;
  const leads = (channel.settings.team?.nodes ?? []).filter((n) => n.lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a);
  // Buzz-style first steps for a new channel: bring in an agent, add files, invite people
  const cards: { icon: React.ReactNode; title: string; body: string; onClick: () => void }[] = [
    ...(canManage ? [{ icon: <Bot size={18} />, title: "Add agent", body: leads.length ? "Put another agent on the team." : answerer ? `${answerer.name} answers here. Add another.` : "Add agents to this team.", onClick: onAddAgent }] : []),
    ...(!channel.archivedAt ? [{ icon: <Paperclip size={18} />, title: "Add files", body: "Share something to work on.", onClick: () => window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH, { detail: channel.id })) }] : []),
    ...(invite && canManage ? [{ icon: <UserPlus size={18} />, title: "Invite people", body: "Bring someone into this team.", onClick: onMembers }] : []),
  ];
  return (
    <div className="px-5 pb-6 pt-2">
      <div className="size-12 rounded-2xl bg-chip grid place-items-center text-muted">
        <ChannelIcon channel={channel} size={22} className="" />
      </div>
      <h2 className="mt-3 text-xl font-semibold">#{channel.name}</h2>
      <p className="text-sm text-muted">
        {channel.topic ? `${channel.topic.replace(/[.!?]\s*$/, "")}. ` : "This is the start of the team. "}
        {leads.length
          ? `${leads.map((a) => a.name).join(" and ")} ${leads.length > 1 ? "read every new message here, plan it together" : "reads every new message here, plans it"} and hand${leads.length > 1 ? "" : "s"} the work to the team in a thread. @mention an agent to ask it directly.`
          : answerer
            ? `${answerer.name} answers messages here; @mention another agent to ask them instead.`
            : "@mention an agent to bring it in."}{" "}
        New here?{" "}
        <a href="#/welcome" className="text-accent-text font-medium hover:underline">
          Get started
        </a>
      </p>
      {empty && cards.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3 max-w-2xl">
          {cards.map((c) => (
            <button key={c.title} type="button" onClick={c.onClick} className="rounded-2xl border border-line bg-panel px-4 py-3 text-left hover:bg-hover flex flex-col gap-2">
              <span className="size-9 rounded-xl bg-chip grid place-items-center text-muted">{c.icon}</span>
              <span>
                <span className="block text-sm font-semibold">{c.title}</span>
                <span className="block text-xs text-muted">{c.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Add files" on a new channel's intro asks the composer to open its file picker. */
const COMPOSER_ATTACH = "wisp:composer-attach";

function isGrouped(prev: Message | undefined, m: Message) {
  return !!prev && prev.author.kind === m.author.kind && prev.author.id === m.author.id && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && m.author.id !== "system";
}

// --- one message --------------------------------------------------------------------------------

function MessageItem({ m, grouped, replies, onReplies, inThread, working = [] }: { m: Message; grouped?: boolean; replies?: number; onReplies?: () => void; inThread?: boolean; working?: LiveRun[] }) {
  const { clock } = usePrefs();
  const names = useNames();
  const handles = useHandleNames();
  const colors = useHandleColors();
  const html = useMemo(() => (m.body ? renderMarkdown(m.body, { handles, colors }) : ""), [m.body, handles, colors]);
  const cards = useMemo(() => linkCards(m.body), [m.body]);
  // on a phone the actions open with a tap on the message, and close with a tap anywhere else
  const [touched, setTouched] = useState(false);
  const [editing, setEditing] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!touched) return;
    const away = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) setTouched(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [touched]);

  if (m.author.id === "system")
    return (
      <div className="px-5 py-1.5 text-xs text-muted flex items-center gap-2">
        <span className="h-px flex-1 bg-line" />
        {m.parts.map((p, i) => (p.type === "status" || p.type === "notice") && <span key={i}>{p.text}</span>)}
        {/* a step Wisp handed out shows who got it; the brief is on the task */}
        {m.body && (m.parts.some((p) => p.type === "task") ? <span className="shrink-0">{m.body.match(/^@[\w-]+/)?.[0]}</span> : <span className="text-center">{m.body.replace(/\*\*/g, "")}</span>)}
        {m.parts.map((p) => p.type === "routine" && <RoutineChip key={p.routineId} id={p.routineId} />)}
        {m.parts.map((p) => p.type === "task" && <TaskChip key={p.taskId} id={p.taskId} />)}
        <span className="h-px flex-1 bg-line" />
      </div>
    );

  const agent = m.author.kind === "agent" ? names.agent(m.author.id) : undefined;
  const name = agent ? agent.name : (names.member(m.author.id)?.name ?? "Someone");
  const time = clockTime(m.createdAt, clock);
  const solo = useContext(SoloAgent);
  // the DM's own agent already lives in the pill above: no ghost or name on its messages
  const home = !!agent && agent.id === solo;
  const pinned = useStore((s) => !!s.channels.find((c) => c.id === m.channelId)?.pinnedIds.includes(m.id));
  // like Messages: what you wrote sits on the right in your own color, with no name or picture
  const mine = useStore((s) => m.author.kind === "user" && m.author.id === s.me?.user.id);

  return (
    <div
      ref={row}
      data-message-id={m.id}
      className={cx("group relative px-3 md:px-5 flex gap-3", grouped ? "py-0.5" : "pt-2.5 pb-0.5")}
      onClick={(e) => {
        // phones have no hover: a tap on the message shows its actions (buttons and links in it still do their own thing)
        if (!window.matchMedia("(hover: none)").matches) return;
        if ((e.target as HTMLElement).closest("button, a, input, textarea, summary")) return;
        setTouched((t) => !t);
      }}
    >
      {mine ? null : <div className="w-9 shrink-0 pt-0.5">
        {grouped || home ? (
          <span className="hidden group-hover:block text-[10px] text-faint text-right leading-6">{time}</span>
        ) : agent ? (
          <button onClick={() => go({ view: "agents", agentId: agent.id, tab: "overview" })} aria-label={`Open ${agent.name}`}>
            <AgentAvatar agent={agent} size={36} />
          </button>
        ) : (
          <UserAvatar name={name} size={36} />
        )}
      </div>}
      <div className={cx("min-w-0 flex-1", mine && "flex flex-col items-end pl-10 md:pl-16")}>
        {mine && pinned && !grouped && (
          <span className="text-[11px] text-muted inline-flex items-center gap-0.5 mb-0.5">
            <Pin size={11} /> Pinned
          </span>
        )}
        {!grouped && !home && !mine && (
          <div className="flex items-baseline gap-2">
            {/* agents sign their messages in their own color */}
            <span className={cx("font-semibold text-[14.5px]", agent && "agent-ink")} style={agent ? agentVar(agent) : undefined}>
              {name}
            </span>
            {agent && (
              <span className="text-[10.5px] px-1.5 rounded bg-chip text-muted font-semibold" title={`Agent · ${harnessLabel(agent.harness)}`}>
                agent
              </span>
            )}
            <span className="text-xs text-faint">{time}</span>
            {pinned && (
              <span className="text-[11px] text-muted inline-flex items-center gap-0.5">
                <Pin size={11} /> Pinned
              </span>
            )}
          </div>
        )}
        {m.deletedAt ? (
          <div className="text-[15px] text-muted italic">This message was deleted.</div>
        ) : editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          html && !m.parts.some((p) => p.type === "change") && <div className={cx("prose-w text-[15px] bubble", mine ? "me" : "them")} title={mine ? time : undefined} dangerouslySetInnerHTML={{ __html: m.editedAt ? withEditedMark(html, clockTime(m.editedAt, clock)) : html }} />
        )}
        {cards.map((c) => (
          <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="mt-1.5 flex max-w-sm items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2 hover:bg-hover">
            <span className="size-8 rounded-lg bg-chip grid place-items-center text-muted">{c.kind === "PR" ? <GitPullRequest size={16} /> : <CircleDot size={16} />}</span>
            <span className="min-w-0">
              <span className="block text-[11px] text-muted">GitHub · {c.kind === "PR" ? "Pull request" : "Issue"}</span>
              <span className="block text-sm font-medium truncate">
                {c.repo} #{c.num}
              </span>
            </span>
          </a>
        ))}
        <CardAuthor.Provider value={m.author.kind === "agent" ? { agentId: m.author.id, channelId: m.channelId, threadId: m.threadId } : null}>
          <Parts parts={m.parts} body={m.body} />
        </CardAuthor.Provider>
        <Reactions messageId={m.id} reactions={m.reactions ?? []} />
        {(!!replies || working.length > 0) && onReplies && (
          <div className="mt-1 -ml-1 flex flex-wrap items-center gap-1.5">
            {!!replies && (
              <button onClick={onReplies} className="h-6 px-2 rounded-md text-xs font-medium text-accent-text hover:bg-accent-soft inline-flex items-center gap-1">
                <MessageSquare size={13} /> {replies} {replies === 1 ? "reply" : "replies"} <ChevronRight size={12} />
              </button>
            )}
            {working.length > 0 && <ThreadWork runs={working} threadId={m.id} onClick={onReplies} />}
          </div>
        )}
      </div>
      {!m.deletedAt && !editing && <ActionBar m={m} onReply={onReplies} onEdit={() => setEditing(true)} open={touched} onDone={() => setTouched(false)} />}
    </div>
  );
}

/** "(edited)" at the end of the last paragraph, like Slack, rather than on a line of its own. */
function withEditedMark(html: string, at: string) {
  const mark = `<span class="text-[11px] text-faint" title="Edited ${at}"> (edited)</span>`;
  const t = html.trimEnd();
  return t.endsWith("</p>") ? t.slice(0, -4) + mark + "</p>" : t + mark;
}

/** Fix a sent message in place: Enter saves, Esc puts it back. Phones get buttons, since Enter is a newline there. */
function EditBox({ m, onDone }: { m: Message; onDone: () => void }) {
  const [text, setText] = useState(m.body);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  useEffect(() => {
    const el = ta.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = async () => {
    if (text === m.body) return onDone();
    setBusy(true);
    try {
      await api("PATCH", `/api/messages/${m.id}`, { body: text });
      onDone();
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 rounded-xl border border-input bg-panel focus-within:border-accent/60">
      <textarea
        ref={ta}
        rows={1}
        value={text}
        disabled={busy}
        aria-label="Edit message"
        className="block w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") return (e.preventDefault(), onDone());
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        <span className="mr-auto pl-1 text-[11px] text-faint hidden [@media(pointer:fine)]:inline">Enter to save · Esc to cancel</span>
        <Button variant="ghost" className="h-7" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" className="h-7" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** Buzz-style toolbar: quick reactions, picker, reply in thread, more. Shows on hover, on keyboard focus, and (`open`) after a tap on a phone. */
function ActionBar({ m, onReply, onEdit, open, onDone }: { m: Message; onReply?: () => void; onEdit: () => void; open: boolean; onDone: () => void }) {
  const toggleReaction = useStore((s) => s.toggleReaction);
  const channel = useStore((s) => s.channels.find((c) => c.id === m.channelId));
  const canPin = useStore((s) => s.me?.role !== "guest") && channel?.kind === "channel" && !channel.archivedAt;
  const mine = useStore((s) => m.author.kind === "user" && m.author.id === s.me?.user.id);
  const owner = useStore((s) => s.me?.role === "owner");
  const writable = !channel?.archivedAt;
  const remove = () => {
    onDone();
    if (!confirm(mine ? "Delete this message? This can't be undone." : "Delete this message from someone else? This can't be undone.")) return;
    void api("DELETE", `/api/messages/${m.id}`).catch((e) => alert((e as Error).message));
  };
  const pinned = !!channel?.pinnedIds.includes(m.id);
  const [picker, setPicker] = useState(false);
  const react = (emoji: string) => {
    toggleReaction(m.id, emoji);
    onDone();
  };
  return (
    <div className={cx("absolute right-4 -top-3.5 z-10 items-center rounded-lg border border-line bg-panel shadow-panel p-0.5", picker || open ? "flex" : "hidden group-hover:flex group-focus-within:flex")}>
      {QUICK_REACTIONS.map((e) => (
        <button key={e} onClick={() => react(e)} className="size-7 rounded-md hover:bg-hover text-[15px] leading-none" aria-label={`React ${e}`}>
          {e}
        </button>
      ))}
      <div className="relative">
        <button onClick={() => setPicker(!picker)} className="size-7 rounded-md hover:bg-hover grid place-items-center text-muted" aria-label="Add reaction">
          <SmilePlus size={15} />
        </button>
        {picker && (
          <div className="absolute right-0 top-full mt-1 z-20 rounded-xl border border-line bg-panel shadow-panel" onMouseLeave={() => setPicker(false)}>
            <EmojiPicker
              onPick={(e) => {
                setPicker(false);
                react(e);
              }}
            />
          </div>
        )}
      </div>
      {onReply && (
        <button onClick={() => (onDone(), onReply())} className="size-7 rounded-md hover:bg-hover grid place-items-center text-muted" aria-label="Reply in thread" title="Reply in thread">
          <MessageSquare size={15} />
        </button>
      )}
      <Menu
        align="right"
        trigger={(_o, t) => (
          <button onClick={t} className="size-7 rounded-md hover:bg-hover grid place-items-center text-muted" aria-label="More">
            <MoreHorizontal size={15} />
          </button>
        )}
        items={[
          { label: "Copy text", icon: <Copy size={14} />, onSelect: () => (navigator.clipboard?.writeText(m.body), onDone()) },
          ...(canPin ? [{ label: pinned ? "Unpin" : "Pin to team", icon: pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => (void api(pinned ? "DELETE" : "PUT", `/api/messages/${m.id}/pin`).catch((e) => alert((e as Error).message)), onDone()) }] : []),
          ...(mine && writable ? [{ label: "Edit", icon: <Pencil size={14} />, onSelect: () => (onDone(), onEdit()) }] : []),
          ...((mine || owner) && writable ? [{ label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: remove }] : []),
        ]}
      />
    </div>
  );
}

function Reactions({ messageId, reactions }: { messageId: string; reactions: Reaction[] }) {
  const me = useStore((s) => s.me);
  const toggleReaction = useStore((s) => s.toggleReaction);
  const names = useNames();
  if (!reactions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => {
        const mine = r.actors.some((a) => a.kind === "user" && a.id === me?.user.id);
        const who = r.actors.map((a) => names.actorName(a.kind, a.id)).join(", ");
        return (
          <button
            key={r.emoji}
            onClick={() => toggleReaction(messageId, r.emoji)}
            title={`${who} reacted ${r.emoji}`}
            className={cx("h-6 px-1.5 rounded-full border text-xs inline-flex items-center gap-1 tabular-nums", mine ? "border-accent/50 bg-accent-soft text-accent-text" : "border-line bg-panel hover:bg-hover text-muted")}
          >
            <span className="text-[13px] leading-none">{r.emoji}</span> {r.actors.length}
          </button>
        );
      })}
    </div>
  );
}

/** GitHub PR and issue links get a small card, like Buzz. Parsed locally; nothing is fetched. */
function linkCards(body: string) {
  const out: { url: string; repo: string; num: string; kind: "PR" | "Issue" }[] = [];
  for (const m of body.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g)) {
    if (!out.some((c) => c.url === m[0])) out.push({ url: m[0], repo: m[1], num: m[3], kind: m[2] === "pull" ? "PR" : "Issue" });
  }
  return out.slice(0, 3);
}

function Parts({ parts, body = "" }: { parts: MessagePart[]; body?: string }) {
  const tools = parts.filter((p) => p.type === "tool_call");
  const files = parts.filter((p) => p.type === "file");
  const status = parts.filter((p) => p.type === "status");
  const { toolCalls } = usePrefs();
  const [open, setOpen] = useState(toolCalls === "expanded");
  const summary = useMemo(() => workSummary(tools.flatMap((t) => (t.type === "tool_call" ? [{ name: t.name, input: t.input }] : []))), [parts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {parts.map((p) => p.type === "discussion" && <DiscussionCard key={p.discussionId} id={p.discussionId} />)}
      {parts.map((p, i) => p.type === "computer" && <ComputerPart key={`c${i}`} computerId={p.computerId} request={p.request} />)}
      {parts.map((p) => p.type === "approval" && <ApprovalCard key={p.approvalId} id={p.approvalId} />)}
      {parts.map((p) => p.type === "routine" && <RoutineChip key={p.routineId} id={p.routineId} />)}
      {parts.map((p) => p.type === "task" && <TaskChip key={p.taskId} id={p.taskId} />)}
      {parts.map((p, i) => p.type === "context" && <ContextCard key={`x${i}`} usage={p.usage} />)}
      {parts.map((p) => p.type === "change" && <ChangeCard key={p.changeId} id={p.changeId} fallback={body} />)}
      {parts.map((p, i) => p.type === "notice" && <div key={`n${i}`} className="mt-1 text-xs text-muted whitespace-pre-wrap">{p.text}</div>)}
      {files.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {files.map((f) => f.type === "file" && <FileChip key={f.fileId} id={f.fileId} name={f.name} />)}
        </div>
      )}
      {status.map((s, i) => s.type === "status" && <div key={i} className={cx("mt-1", s.text === "Voice message" ? "text-[11px] text-faint inline-flex items-center gap-1" : "text-sm text-bad")}>{s.text === "Voice message" && <Mic size={11} />}{s.text}</div>)}
      <Remembered tools={tools} />
      {tools.length > 0 && toolCalls !== "hidden" && (
        <div className="mt-1.5">
          {/* one line of what it did, like "Searched the web · read 6 pages"; opens the tool calls */}
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="max-w-full h-7 px-2.5 rounded-lg border border-line bg-bg text-[13px] text-muted hover:text-ink hover:bg-hover inline-flex items-center gap-2">
            <SquareTerminal size={13} className="shrink-0" />
            <span className="truncate">{summary}</span>
            <ChevronRight size={13} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
          </button>
          {open && (
            <div className="mt-1 space-y-1">
              {tools.map(
                (t, i) =>
                  t.type === "tool_call" && (
                    <details key={i} className="rounded-lg border border-line bg-bg text-xs">
                      <summary className="px-2 py-1 cursor-pointer font-mono">{prettyTool(t.name)}</summary>
                      <pre className="px-2 pb-2 overflow-x-auto whitespace-pre-wrap break-all text-muted">
                        {JSON.stringify(t.input, null, 2)}
                        {t.output !== undefined && `\n→ ${typeof t.output === "string" ? t.output : JSON.stringify(t.output, null, 2)}`}
                      </pre>
                    </details>
                  ),
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const prettyTool = (n: string) => n.replace(/^mcp__(?:wisp|warren)__/, "").replace(/^mcp__/, "").replace(/^(?:wisp|warren)\./, "");

const KIND_LABEL: Record<string, string> = { preference: "preference", plan: "plan", did: "what you did", detail: "detail" };

/** What the agent saved about someone during this reply, so you can see (and fix) it right where it happened. */
function Remembered({ tools }: { tools: MessagePart[] }) {
  const saved = tools.flatMap((t) => {
    if (t.type !== "tool_call" || prettyTool(t.name) !== "memory_remember") return [];
    const out = typeof t.output === "string" ? t.output : JSON.stringify(t.output ?? "");
    if (/Not saved|Error/i.test(out)) return [];
    const input = (t.input ?? {}) as { kind?: string; text?: string; status?: string };
    const path = out.match(/(people\/[^\s"\\]+?\.md)/)?.[1] ?? null;
    const text = input.text ?? (input.status ? `marked a plan ${input.status}` : "updated a memory");
    return [{ kind: input.kind ?? "", text, path }];
  });
  if (!saved.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {saved.map((r, i) => (
        <a
          key={i}
          href={r.path ? `#/vault/${r.path}` : "#/about"}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-accent-soft/50 px-2.5 h-7 text-xs hover:bg-accent-soft"
          title="Saved to memory. Open it to edit or delete."
        >
          <Brain size={13} className="text-accent-text shrink-0" />
          <span className="text-muted shrink-0">Remembered{KIND_LABEL[r.kind] ? ` ${KIND_LABEL[r.kind]}` : ""}:</span>
          <span className="truncate">{r.text}</span>
        </a>
      ))}
    </div>
  );
}

function FileChip({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(name);
  useEffect(() => {
    if (!isImage) return;
    let u: string | null = null;
    fileUrl(id).then((x) => setUrl((u = x)), () => {});
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [id, isImage]);
  const open = async () => {
    const u = url ?? (await fileUrl(id));
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    a.click();
  };
  if (isImage && url) return <img src={url} alt={name} onClick={open} className="max-h-64 max-w-full rounded-xl border border-line cursor-pointer" />;
  return (
    <button onClick={open} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm hover:bg-hover">
      <FileText size={16} className="text-muted" /> {name}
    </button>
  );
}

/** An agent's reply as it streams in, before it's posted. */
function StreamingItem({ run }: { run: LiveRun }) {
  const names = useNames();
  const handles = useHandleNames();
  const colors = useHandleColors();
  const agent = names.agent(run.agentId);
  const html = useMemo(() => renderMarkdown(run.text, { handles, colors }), [run.text, handles, colors]);
  const computerId = agent?.computerId;
  const home = useContext(SoloAgent) === run.agentId;
  return (
    <div className="px-3 md:px-5 pt-2.5 flex gap-3">
      <div className="w-9 shrink-0 pt-0.5">{!home && <AgentAvatar agent={agent} size={36} live />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {!home && <span className="font-semibold text-[14.5px]">{agent?.name ?? "Agent"}</span>}
          <span className="text-xs text-faint">{run.text ? "writing…" : "working…"}</span>
        </div>
        {html && <div className="prose-w text-[15px] bubble them opacity-70" dangerouslySetInnerHTML={{ __html: html }} />}
        {run.usedComputer && computerId && <ComputerPart computerId={computerId} />}
      </div>
    </div>
  );
}

// --- thread -------------------------------------------------------------------------------------

function ThreadPanel({ channelId, rootId, agentId, messageId }: { channelId: string; rootId: string; agentId?: string; messageId?: string }) {
  const root = useStore((s) => s.messages[channelId]?.find((m) => m.id === rootId) ?? s.roots[rootId] ?? Object.values(s.threads).flat().find((m) => m.id === rootId));
  const removed = useStore((s) => s.removedRoots[rootId]);
  const replies = useStore((s) => s.threads[rootId]);
  const replyCounts = useStore((s) => s.replyCounts);
  const live = useStore((s) => s.live);
  const loadThread = useStore((s) => s.loadThread);
  const ref = useRef<HTMLDivElement>(null);
  const history = useMessageHistory(channelId, rootId, messageId, ref, replies);
  const streaming = Object.values(live).filter((r) => r.channelId === channelId && r.threadId === rootId && (r.text || r.usedComputer));
  const below = Object.values(live).filter((r) => r.channelId === channelId && r.threadPath.includes(rootId));

  useEffect(() => {
    void loadThread(channelId, rootId).catch(() => {});
  }, [channelId, rootId, loadThread]);
  useLayoutEffect(() => {
    if (history.prepended.current) { history.prepended.current = false; return; }
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [replies?.length, streaming.map((r) => r.text.length).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => go({ view: "chat", channelId, threadId: null });
  // a sub-thread goes back to the thread it branched off from
  const parent = root?.threadId ?? null;
  const open = (id: string) => go({ view: "chat", channelId, threadId: id });
  return (
    <RightPane label={parent ? "Sub-thread" : "Thread"}>
      <header className="h-15 shrink-0 px-3 flex items-center gap-2 border-b border-line">
        <button onClick={parent ? () => open(parent) : close} className={cx("p-1.5 rounded-md hover:bg-hover", !parent && "lg:hidden")} aria-label={parent ? "Back to the thread it came from" : "Back"} title={parent ? "Back to the thread it came from" : undefined}>
          <ChevronLeft size={20} />
        </button>
        <span className="font-semibold flex-1 min-w-0 truncate">{parent ? "Sub-thread" : "Thread"}</span>
        <button onClick={close} className="hidden lg:block p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close thread">
          <X size={18} />
        </button>
      </header>
      {!parent && <FlowStrip channelId={channelId} threadId={rootId} />}
      <div ref={ref} className="flex-1 overflow-y-auto py-3">
        {history.controls}
        {removed && <p role="status" className="px-5 py-2 text-xs text-muted">This message was deleted.</p>}
        {!removed && root && <MessageItem m={root} inThread />}
        <div className="flex items-center gap-3 px-5 py-2 text-xs text-muted">
          {history.error ? "" : replies ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : "Loading…"}
          <span className="h-px flex-1 bg-line" />
        </div>
        {replies?.map((m, i) => (
          <MessageItem key={m.id} m={m} grouped={isGrouped(replies[i - 1], m)} inThread replies={replyCounts[m.id]} working={below.filter((r) => r.threadId === m.id || r.threadPath.includes(m.id))} onReplies={() => open(m.id)} />
        ))}
        {streaming.map((r) => (
          <StreamingItem key={r.runId} run={r} />
        ))}
      </div>
      {!removed && <Composer channelId={channelId} threadId={rootId} agentId={agentId} placeholder="Reply…" />}
    </RightPane>
  );
}

/** Who's working in a thread (or a sub-thread of it), on the thread's row: their ghosts and "Ada is working". */
function ThreadWork({ runs, threadId, onClick }: { runs: LiveRun[]; threadId: string; onClick: () => void }) {
  const names = useNames();
  const ids = [...new Set(runs.map((r) => r.agentId))];
  const agents = ids.map((id) => names.agent(id)).filter((a): a is Agent => !!a);
  if (!agents.length) return null;
  const deeper = runs.every((r) => r.threadId !== threadId);
  const who = agents.length === 1 ? agents[0].name : agents.length === 2 ? `${agents[0].name} and ${agents[1].name}` : `${agents[0].name} and ${agents.length - 1} more`;
  return (
    <button onClick={onClick} className="h-6 pl-1 pr-2 rounded-full bg-chip hover:bg-hover text-xs inline-flex items-center gap-1.5" title={deeper ? "Working in a sub-thread" : "Working in this thread"}>
      <span className="flex">
        {agents.slice(0, 3).map((a, i) => (
          <span key={a.id} className={cx("rounded-full ring-2 ring-chip", i > 0 && "-ml-1.5")}>
            <AgentAvatar agent={a} size={16} live interactive={false} />
          </span>
        ))}
      </span>
      <span className="size-1.5 rounded-full bg-ok animate-pulse" aria-hidden />
      <span>
        <span className="font-medium">{who}</span> {agents.length === 1 ? "is" : "are"} working{deeper ? " in a sub-thread" : ""}
      </span>
    </button>
  );
}

// --- task hand-off card -------------------------------------------------------------------------

const taskCache = new Map<string, Promise<TaskRow[]>>();

function taskState(t: TaskRow): { label: string; tone: "neutral" | "info" | "ok" | "bad" } {
  if (t.status === "done") return { label: "Done", tone: "ok" };
  if (t.status === "failed") return t.result?.startsWith("Cancelled") ? { label: "Cancelled", tone: "neutral" } : { label: "Failed", tone: "bad" };
  if (t.status === "in_progress") return { label: "Working", tone: "info" };
  return { label: "To do", tone: "neutral" };
}

/** A hand-off message's task: title, who has it, where it stands, and a way into Tasks. */
function TaskChip({ id }: { id: string }) {
  const version = useStore((s) => s.tasksVersion);
  const agents = useStore((s) => s.agents);
  const [task, setTask] = useState<TaskRow | null>(null);
  useEffect(() => {
    const key = String(version);
    let p = taskCache.get(key);
    if (!p) {
      taskCache.clear();
      taskCache.set(key, (p = api<TaskRow[]>("GET", "/api/tasks").catch(() => [])));
    }
    let live = true;
    p.then((list) => live && setTask(list.find((t) => t.id === id) ?? null));
    return () => {
      live = false;
    };
  }, [id, version]);
  if (!task) return null;
  const agent = task.toAgentId ? agents.find((a) => a.id === task.toAgentId) : undefined;
  const st = taskState(task);
  return (
    <div className="mt-1.5 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-panel pl-3 pr-1 h-8 text-xs">
      <span className="font-medium truncate">{task.title}</span>
      {agent && (
        <span className="text-muted inline-flex items-center gap-1 shrink-0">
          <AgentAvatar agent={agent} size={16} badge={false} /> {agent.name}
        </span>
      )}
      <Pill tone={st.tone}>{st.label}</Pill>
      <a href={href({ view: "tasks" })} className="shrink-0 rounded-full px-2 h-6 inline-flex items-center text-accent-text hover:bg-hover">
        Open in Tasks
      </a>
    </div>
  );
}

// --- composer -----------------------------------------------------------------------------------

interface ComposerDraft {
  text: string;
  files: { id: string; name: string }[];
  uploading: number;
  sending: boolean;
  error: string | null;
}
const emptyComposerDraft: ComposerDraft = { text: "", files: [], uploading: 0, sending: false, error: null };
const composerDrafts = new Map<string, ComposerDraft>();
const draftListeners = new Set<() => void>();
const subscribeDrafts = (onChange: () => void) => {
  draftListeners.add(onChange);
  return () => { draftListeners.delete(onChange); };
};

function useComposerDraft(channelId: string, threadId?: string) {
  const key = JSON.stringify([channelId, threadId ?? null]);
  const get = () => composerDrafts.get(key) ?? emptyComposerDraft;
  const draft = useSyncExternalStore(subscribeDrafts, get, get);
  const update = (change: (draft: ComposerDraft) => ComposerDraft) => {
    composerDrafts.set(key, change(get()));
    draftListeners.forEach((notify) => notify());
  };
  return [draft, update, get] as const;
}

export function Composer({ channelId, threadId, agentId, placeholder, onDetails }: { channelId: string; threadId?: string; agentId?: string; placeholder: string; onDetails?: (agentId: string) => void }) {
  const { sendWith } = usePrefs();
  const agents = useStore((s) => s.agents);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const { agent: dmAgent, ctx, catalog } = useAgentContext(agentId, channelId, threadId);
  const live = useStore((s) => s.live);
  const [{ text, files, uploading, sending, error }, updateDraft, getDraft] = useComposerDraft(channelId, threadId);
  const setText = (value: string) => updateDraft((d) => ({ ...d, text: value }));
  const setFiles = (value: ComposerDraft["files"]) => updateDraft((d) => ({ ...d, files: value }));
  const [pick, setPick] = useState(0);
  const [emoji, setEmoji] = useState(false);
  const [caret, setCaret] = useState(0);
  const [nobodyAsked, setNobodyAsked] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // in a thread, who's working in it (or a sub-thread of it); at the top, everyone in the channel
  const working = Object.values(live).filter((r) => r.channelId === channelId && (!threadId || r.threadId === threadId || r.threadPath.includes(threadId)));
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId));
  const leads = channel?.kind === "channel" ? (channel.settings.team?.nodes ?? []).filter((n) => n.lead).map((n) => agents.find((a) => a.id === n.agentId)).filter((a): a is Agent => !!a) : [];

  // a quiet line about where this will land: no mention in a channel, or an offline agent that was asked
  const mentioned = text.trim() ? parseMentions(text).map((h) => agents.find((a) => a.handle === h)).filter((a): a is Agent => !!a) : [];
  // the agent that answers this channel's un-@mentioned messages, if it has one
  const answerer = channel?.kind === "channel" && channel.settings.defaultAgentId ? agents.find((a) => a.id === channel.settings.defaultAgentId) : undefined;
  const offline = mentioned.find((a) => a.status === "offline") ?? (channel?.kind === "dm" && text.trim() ? dmAgent?.status === "offline" ? dmAgent : undefined : undefined);
  const hint = offline
    ? `${offline.name} is offline; it will answer when its device reconnects.`
    : // in a thread, a plain reply can go back to the agent that started it, so only say this at the top level
      channel && channel.kind !== "dm" && !threadId && text.trim() && !mentioned.length
      ? leads.length
        ? `${leads.map((a) => a.name).join(" and ")} ${leads.length > 1 ? "will plan it together, then hand out the work" : "will take it and hand out the work"}.`
        : answerer
        ? `${answerer.name} will answer. @mention another agent to ask them instead.`
        : `Posting to #${channel.name}. @mention an agent to ask it.`
      : null;

  // a "ask someone" shortcut for the hint line, in channels (not DMs or threads) that have agents and nobody answering by default
  const canAsk = !!channel && channel.kind !== "dm" && !threadId && agents.length > 0 && !mentioned.length && !answerer && !leads.length;
  function ask() {
    if (agents.length === 1) {
      const m = `@${agents[0].handle}`;
      if (!new RegExp(`^\\s*${m}(\\s|$)`).test(text)) setText(`${m} ${text}`);
      requestAnimationFrame(() => {
        const at = m.length + 1;
        ta.current?.focus();
        ta.current?.setSelectionRange(at, at);
        setCaret(at);
      });
    } else {
      // an "@" at the caret brings up the mention picker
      insert(text && !/\s$/.test(text.slice(0, ta.current?.selectionStart ?? text.length)) ? " @" : "@");
    }
  }
  useEffect(() => setNobodyAsked(false), [channelId]);
  useEffect(() => {
    if (mentioned.length) setNobodyAsked(false);
  }, [mentioned.length]);

  // @mention autocomplete for the word under the cursor
  const word = text.slice(0, caret).match(/(?:^|\s)@([\w-]*)$/)?.[1];
  const suggestions = word !== undefined ? agents.filter((a) => a.handle.startsWith(word.toLowerCase()) || a.name.toLowerCase().startsWith(word.toLowerCase())).slice(0, 6) : [];

  // "/" at the start of the message: what each agent here can do (Esc hides it until the text changes)
  const [slashHidden, setSlashHidden] = useState<string | null>(null);
  const slashText = text.slice(0, caret);
  const slash = useSlashMenu({ query: slashHidden === slashText ? null : slashQuery(slashText), channel, dmAgent, agents });
  function pickCommand(item: SlashItem) {
    const next = slash.textFor(item);
    setText(next + text.slice(caret).replace(/^\S*/, "").trimStart());
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }

  // words handed over from elsewhere (Home's "Try asking…") prefill the box once, ready to edit or send
  useEffect(() => {
    if (threadId) return;
    const draft = takeDraft(channelId);
    if (draft) {
      setText(draft);
      ta.current?.focus();
    }
  }, [channelId, threadId]);

  // "Add files" on the channel intro opens this composer's file picker
  useEffect(() => {
    if (threadId) return;
    const open = (e: Event) => {
      if ((e as CustomEvent<string>).detail === channelId) fileInput.current?.click();
    };
    window.addEventListener(COMPOSER_ATTACH, open);
    return () => window.removeEventListener(COMPOSER_ATTACH, open);
  }, [channelId, threadId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  function insert(s: string) {
    const el = ta.current;
    const at = el?.selectionStart ?? text.length;
    const next = text.slice(0, at) + s + text.slice(el?.selectionEnd ?? at);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + s.length, at + s.length);
      setCaret(at + s.length);
    });
  }

  function complete(handle: string) {
    const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${handle} `);
    setText(before + text.slice(caret));
    setPick(0);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  }

  async function send() {
    const current = getDraft();
    if (current.uploading || current.sending || (!current.text.trim() && !current.files.length)) return;
    const body = current.text;
    const attached = current.files;
    const unasked = !!channel && channel.kind !== "dm" && !threadId && agents.length > 0 && !answerer && !leads.length && !parseMentions(body).length;
    setNobodyAsked(false);
    updateDraft((d) => ({ ...d, text: "", files: [], sending: true, error: null }));
    try {
      await api("POST", `/api/channels/${channelId}/messages`, { body, threadId, fileIds: attached.map((f) => f.id) });
      setNobodyAsked(unasked);
    } catch (e) {
      // Restore into this conversation, keeping anything typed while the send was in flight.
      updateDraft((d) => ({ ...d, text: body && d.text ? `${body}\n${d.text}` : body || d.text, files: attached, error: (e as Error).message }));
    } finally {
      updateDraft((d) => ({ ...d, sending: false }));
    }
  }

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    const current = getDraft();
    if (current.sending) {
      updateDraft((d) => ({ ...d, error: "Wait for the message to send before attaching files." }));
      return;
    }
    const selected = Array.from(list).slice(0, Math.max(0, 20 - current.files.length - current.uploading));
    let remaining = selected.length;
    updateDraft((d) => ({ ...d, uploading: d.uploading + remaining, error: selected.length < list.length ? "Attach up to 20 files per message." : null }));
    try {
      for (const f of selected) {
        const up = await uploadFile(f, channelId);
        remaining--;
        updateDraft((d) => ({ ...d, uploading: d.uploading - 1, files: [...d.files, { id: up.id, name: up.name }] }));
      }
    } catch (e) {
      updateDraft((d) => ({ ...d, error: (e as Error).message }));
    } finally {
      updateDraft((d) => ({ ...d, uploading: d.uploading - remaining }));
    }
  }

  return (
    // @container: the toolbar fits itself to the composer's own width (a DM next to an open thread is narrow on a wide screen)
    <div className="shrink-0 px-3 md:px-5 pb-2 pt-1 safe-bottom @container flex flex-col">
      {/* who's working here and on what (Buzz's activity bar); Stop and details are in its popover */}
      {working.length > 0 && (
        <div className="pb-2 flex">
          <ActivityPill runs={working} onDetails={(id) => (onDetails ? onDetails(id) : go({ view: "agents", agentId: id, tab: "overview" }))} onThread={(id) => go({ view: "chat", channelId, threadId: id })} hereThread={threadId ?? null} />
        </div>
      )}
      {/* the message box floats on glass, like the iPhone app's */}
      <div className="glass relative rounded-[1.75rem]" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), attach(e.dataTransfer.files))}>
        {slash.open && !suggestions.length && slash.render(pickCommand)}
        {suggestions.length > 0 && (
          <div className="glass absolute bottom-full mb-2 left-0 w-72 rounded-2xl p-1 z-10" role="listbox">
            {suggestions.map((a, i) => (
              <button
                key={a.id}
                role="option"
                aria-selected={i === pick % suggestions.length}
                onMouseDown={(e) => (e.preventDefault(), complete(a.handle))}
                className={cx("w-full px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-sm text-left", i === pick % suggestions.length && "bg-hover")}
              >
                <AgentAvatar agent={a} size={24} badge={false} />
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted truncate">@{a.handle}</span>
                <StatusDot status={a.status} className="ml-auto" />
              </button>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="px-3 pt-2.5 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span key={f.id} className="text-xs rounded-full bg-chip px-2.5 py-1 flex items-center gap-1">
                <FileText size={12} /> {f.name}
                <button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (slash.open && !suggestions.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") return (e.preventDefault(), slash.move(e.key === "ArrowDown" ? 1 : -1));
              if (e.key === "Escape") return (e.preventDefault(), setSlashHidden(slashText));
              if (slash.current && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing))) {
                e.preventDefault();
                return pickCommand(slash.current);
              }
            }
            if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
              e.preventDefault();
              return complete(suggestions[pick % suggestions.length].handle);
            }
            if (suggestions.length && e.key === "ArrowDown") return (e.preventDefault(), setPick(pick + 1));
            if (suggestions.length && e.key === "ArrowUp") return (e.preventDefault(), setPick(Math.max(0, pick - 1)));
            // phones: Enter is a newline and the send button sends. Otherwise Enter sends, or
            // ⌘/Ctrl+Enter does when the person picked that (Settings → Preferences)
            const fine = window.matchMedia("(pointer: fine)").matches;
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && fine && (sendWith === "mod-enter" ? mod : true)) {
              e.preventDefault();
              send();
            }
          }}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2 min-w-0">
          <Popover
            className="w-56 p-1.5"
            trigger={(open, toggle) => (
              <ToolButton label="Add" onClick={toggle} active={open}>
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={19} />}
              </ToolButton>
            )}
          >
            {(close) => (
              <div role="menu">
                <ComposerMenuItem icon={<Paperclip size={15} />} label="Attach files" onClick={() => (close(), fileInput.current?.click())} />
                <ComposerMenuItem icon={<AtSign size={15} />} label="Mention an agent" onClick={() => (close(), insert(text && !/\s$/.test(text.slice(0, ta.current?.selectionStart ?? text.length)) ? " @" : "@"))} />
                <ComposerMenuItem icon={<Smile size={15} />} label="Emoji" onClick={() => (close(), setEmoji(true))} />
              </div>
            )}
          </Popover>
          <div className="relative">
            {emoji && (
              <div className="glass absolute bottom-full mb-2 left-0 z-20 rounded-2xl" onMouseLeave={() => setEmoji(false)}>
                <EmojiPicker
                  onPick={(e) => {
                    setEmoji(false);
                    insert(e);
                  }}
                />
              </div>
            )}
          </div>
          {dmAgent && ctx && <AccessControl agent={dmAgent} ctx={ctx} canEdit={canEdit} />}
          <span className="flex-1" />
          {dmAgent && ctx && (
            <>
              <ModelControl agent={dmAgent} ctx={ctx} catalog={catalog} canEdit={canEdit} />
              <ContextRing ctx={ctx} />
            </>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (attach(e.target.files), (e.target.value = ""))} />
          <button
            onClick={send}
            disabled={!!uploading || sending || (!text.trim() && !files.length)}
            className="ml-1 size-9 shrink-0 rounded-full bg-accent text-accent-ink grid place-items-center disabled:bg-chip disabled:text-faint transition-colors"
            aria-label="Send"
          >
            <ArrowUp size={17} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <div className="min-h-6 pt-1 px-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {error && <span className="text-bad">{error}</span>}
        {!error && hint && <span className="text-muted">{hint}</span>}
        {!error && canAsk && (
          <button type="button" onClick={ask} className="text-accent-text hover:underline">
            {agents.length === 1 ? `Ask ${agents[0].name}` : "Ask an agent"}
          </button>
        )}
        {!error && nobodyAsked && !hint && <span className="text-muted">Nobody was asked. @mention a helper to get an answer.</span>}
      </div>
    </div>
  );
}

function ComposerMenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="w-full px-2.5 h-9 rounded-xl flex items-center gap-2.5 text-sm hover:bg-hover">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}

function ToolButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cx("size-8 rounded-lg hover:bg-hover text-muted hover:text-ink grid place-items-center", active && "bg-hover text-ink")} aria-label={label} title={label}>
      {children}
    </button>
  );
}
