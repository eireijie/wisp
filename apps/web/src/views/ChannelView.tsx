import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { FlowStrip } from "../team/Runs.tsx";
import { Archive, Bot, ChevronLeft, ChevronRight, Check, CircleDot, Eye, FileText, GitPullRequest, Brain, ArrowDown, ArrowUp, AtSign, Camera, Loader2, Mic, MessageSquare, MoreHorizontal, Monitor, Paperclip, Phone, Plus, RotateCcw, Shield, ShieldAlert, SquareTerminal, UserPlus, Users, X, Zap, ChevronDown, Hash, Info, AudioLines, CornerUpLeft, Pin, ListChecks, Square, ArrowRightLeft } from "lucide-react";
import { parseMentions, type AccessLevel, type Agent, type ContextUsage, type HarnessCatalog, type Message, type MessagePart } from "@wisp/core";
import { api, fileUrl, uploadFile } from "../api.ts";
import { conversationKey, useHandleColors, useHandleNames, useNames, usePrefs, useStore, type ChannelInfo, type LiveRun } from "../store.ts";
import { go, href, type Route } from "../router.ts";
import type { TaskRow } from "./TasksView.tsx";
import { renderMarkdown } from "../markdown.ts";
import { ChannelSettings, NOTIFY, landingChannel, setArchived, setChannelPrefs, type ChannelSettingsTab } from "../components/Channels.tsx";
import { ChatAvatar } from "../components/ChatList.tsx";
import { EffortSlider, effortName, prettyModel } from "../components/EffortSlider.tsx";
import { DiscussionCard } from "../components/Discussion.tsx";
import { ApprovalCard, ChangeCard, ChatCard, ComputerPart, RoutineChip } from "../components/AgentCards.tsx";
import { AgentAvatar, Menu, Modal, Pill, Popover, StatusDot, UserAvatar, clockTime, cx, harnessLabel } from "../components/ui.tsx";
import { AgentPill } from "../components/AgentPill.tsx";
import { CallScreen } from "../voice/CallScreen.tsx";
import { takeDraft } from "../draft.ts";
import { AgentPanel, type AgentPanelTab } from "../components/AgentPanel.tsx";
import { slashQuery, useAgentCommands, useSlashMenu, type SlashItem } from "../components/SlashMenu.tsx";
import { ActivityPill, runActivity, stopRuns } from "../components/ActivityPill.tsx";
import { RightPane } from "../components/RightPane.tsx";
import { workKind, workSummary } from "../components/agentActivity.ts";
import { ActionSheet, ActionToolbar, DeleteMessageDialog, EditMessageDialog, useLongPress, useMessageActionList } from "../components/MessageActions.tsx";
import { NotifyDialog, TeamInfo, type InfoTab } from "../components/TeamInfo.tsx";
import { useFeature } from "../features.ts";
import { useDevices } from "../devices.ts";
import { isGrouped, needsStamp, snippetOf, stampLabel, toolLine } from "../chatFormat.ts";
import { openDm } from "../openDm.ts";

/** What's open in the pane beside the chat (a thread comes from the route instead). */
type Side = { kind: "agent"; agentId: string; tab: AgentPanelTab } | { kind: "info"; tab: InfoTab };

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
  const names = useNames();
  const voice = useFeature("voice");
  const [calling, setCalling] = useState(!!route.call);
  const [callSlot, setCallSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setCalling(!!route.call); }, [route.channelId, route.call]);
  const [settings, setSettings] = useState<ChannelSettingsTab | null>(null);

  const channel = channels.find((c) => c.id === route.channelId) ?? (route.channelId ? undefined : landingChannel(channels));
  const dmAgentId = channel?.kind === "dm" ? channel.name.split(":").pop()! : null;
  // the pane beside the chat: an agent's details or the team's info page
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
  const toggleInfo = () => (side?.kind === "info" && !route.threadId ? setSide(null) : openSide({ kind: "info", tab: "about" }));

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

  if (!channel) return <div className="flex-1 grid place-items-center text-sm text-muted">{route.channelId ? "Team not found" : "No teams yet"}</div>;

  const dmAgent = dmAgentId ? names.agent(dmAgentId) : undefined;
  const sideAgent = !route.threadId && side?.kind === "agent" ? names.agent(side.agentId) : undefined;
  const dmPanel = sideAgent && dmAgent && sideAgent.id === dmAgent.id ? (side as Extract<Side, { kind: "agent" }>).tab : null;
  const infoOpen = side?.kind === "info" && !route.threadId && channel.kind === "channel";

  return (
    <div className="flex-1 min-h-0 flex">
      <div className={cx("flex-1 min-w-0 flex flex-col", route.threadId && "hidden lg:flex")}>
        <header className="shrink-0 px-3 md:px-6 h-[4.75rem] md:h-20 grid grid-cols-[1fr_auto_1fr] items-center gap-2 safe-top box-content">
          <div className="flex items-center">
            {onBack && (
              <span className="md:hidden">
                <button className="circle" onClick={onBack} aria-label="Back to chats">
                  <ChevronLeft size={22} strokeWidth={2} />
                </button>
              </span>
            )}
          </div>
          {dmAgent ? (
            // the agent lives here, in the middle, and nowhere else in its DM
            <AgentPill agent={dmAgent} open={dmPanel === "details"} onClick={() => (dmPanel === "details" ? setSide(null) : openAgent(dmAgent.id, "details"))} />
          ) : (
            <TeamPill channel={channel} open={infoOpen} onClick={toggleInfo} />
          )}
          <div className="flex items-center justify-end gap-2">
            {dmAgent?.computerId && (
              <span className="max-md:hidden">
                <button onClick={() => (dmPanel === "computer" ? setSide(null) : openAgent(dmAgent.id, "computer"))} className={cx("circle", dmPanel === "computer" && "bg-hover")} aria-label={`${dmAgent.name}'s computer`} title={`${dmAgent.name}'s computer`}>
                  <Monitor size={18} />
                </button>
              </span>
            )}
            {dmAgent && voice && !calling && (
              <span className="max-md:hidden">
                <button onClick={() => setCalling(true)} className="circle" aria-label={`Call ${dmAgent.name}`} title={`Call ${dmAgent.name}`}>
                  <Phone size={18} />
                </button>
              </span>
            )}
            {dmAgent && <DmContext agentId={dmAgent.id} channelId={channel.id} />}
            {channel.kind === "channel" && (
              <span className="max-md:hidden">
                <button onClick={toggleInfo} aria-pressed={infoOpen} className={cx("circle", infoOpen && "bg-hover")} aria-label="Team info" title="Team info">
                  <Users size={18} />
                </button>
              </span>
            )}
            {dmAgent ? (
              <DmMore agent={dmAgent} channelId={channel.id} onDetails={() => openAgent(dmAgent.id, "details")} onComputer={() => openAgent(dmAgent.id, "computer")} onCall={voice ? () => setCalling(true) : undefined} />
            ) : (
              <TeamMore channel={channel} onInfo={(tab) => openSide({ kind: "info", tab })} onSettings={setSettings} />
            )}
          </div>
        </header>
        <div ref={setCallSlot} />
        <SoloAgent.Provider value={dmAgent?.id ?? null}>
          <MessageList messageId={!route.threadId ? route.messageId : undefined} channel={channel} readMark={readMark?.channelId === channel.id ? readMark.at : null} onAddAgent={() => setSettings("team")} onMembers={() => openSide({ kind: "info", tab: "members" })} />
        </SoloAgent.Provider>
        {channel.archivedAt ? <ArchivedBar channel={channel} /> : <Composer channelId={channel.id} agentId={dmAgent?.id} placeholder={dmAgent ? `Ask ${dmAgent.name}` : `Message ${channel.name}`} onDetails={openAgent} onCall={dmAgent && voice && !calling ? () => setCalling(true) : undefined} />}
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
      {infoOpen && side?.kind === "info" && <TeamInfo channel={channel} tab={side.tab} onTab={(tab) => setSide({ kind: "info", tab })} onClose={() => setSide(null)} onSettings={setSettings} />}
      {calling && dmAgent && <CallScreen key={`${channel.id}:${dmAgent.id}`} agent={dmAgent} channelId={channel.id} barSlot={callSlot} onClose={() => { setCalling(false); if (route.call) go({ view: "chat", channelId: channel.id, threadId: null }); }} />}
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

/** A team's name in a pill at the top of its chat, with its agents' ghosts; opens its info page. */
function TeamPill({ channel, open, onClick }: { channel: ChannelInfo; open: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-expanded={open} aria-label={`${channel.name}. Team info`} className={cx("h-[52px] md:h-[46px] max-w-[min(20rem,60vw)] rounded-full border border-control-line bg-control pl-3 pr-5 inline-flex items-center gap-2.5 text-[17px] md:text-[16px] font-semibold hover:bg-hover", open && "bg-hover")}>
      <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={30} />
      <span className="min-w-0 text-left leading-tight">
        <span className="block truncate">{channel.name}</span>
        {channel.archivedAt && <span className="block text-[12px] font-normal text-muted">Archived</span>}
      </span>
    </button>
  );
}

/** The "…" of a team: its info page, notifications, pins and the team editor. */
function TeamMore({ channel, onInfo, onSettings }: { channel: ChannelInfo; onInfo: (tab: InfoTab) => void; onSettings: (t: ChannelSettingsTab) => void }) {
  const [notify, setNotify] = useState(false);
  return (
    <>
      <Menu
        align="right"
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} className="circle" aria-label="More" title="More">
            <MoreHorizontal size={20} />
          </button>
        )}
        items={[
          { label: "Team info", icon: <Info size={17} />, onSelect: () => onInfo("about") },
          { label: `Notifications: ${NOTIFY[channel.notify].label}`, icon: <Bot size={17} />, onSelect: () => setNotify(true) },
          { label: channel.pinnedIds.length ? `Pinned messages · ${channel.pinnedIds.length}` : "Pinned messages", icon: <Hash size={17} />, onSelect: () => onInfo("pins") },
          { label: "How the team works", icon: <Users size={17} />, onSelect: () => onSettings("team") },
          "divider",
          { label: channel.starred ? "Unpin from the top" : "Pin to the top", icon: <Check size={17} />, onSelect: () => void setChannelPrefs(channel, { starred: !channel.starred }) },
        ]}
      />
      {notify && <NotifyDialog channel={channel} onClose={() => setNotify(false)} />}
    </>
  );
}

/** The context ring in a DM's header (desktops): how full the conversation is. */
function DmContext({ agentId, channelId }: { agentId: string; channelId: string }) {
  const { ctx } = useAgentContext(agentId, channelId);
  if (!ctx) return null;
  return (
    <span className="max-md:hidden">
      <ContextRing ctx={ctx} circle />
    </span>
  );
}

/** The "…" of a DM: the agent's details, its computer, a call, its model and what it may do. */
function DmMore({ agent, channelId, onDetails, onComputer, onCall }: { agent: Agent; channelId: string; onDetails: () => void; onComputer: () => void; onCall?: () => void }) {
  const { ctx, catalog } = useAgentContext(agent.id, channelId);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const [dialog, setDialog] = useState<null | "model" | "access" | "context">(null);
  return (
    <>
      <Menu
        align="right"
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} className="circle" aria-label="More" title="More">
            <MoreHorizontal size={20} />
          </button>
        )}
        items={[
          { label: `About ${agent.name}`, icon: <Info size={17} />, onSelect: onDetails },
          ...(agent.computerId ? [{ label: `${agent.name}'s computer`, icon: <Monitor size={17} />, onSelect: onComputer }] : []),
          ...(onCall ? [{ label: `Call ${agent.name}`, icon: <Phone size={17} />, onSelect: onCall }] : []),
          ...(ctx ? [{ label: "Model and effort", icon: <Zap size={17} />, onSelect: () => setDialog("model") }, { label: "What it can do", icon: <Shield size={17} />, onSelect: () => setDialog("access") }, { label: "Context window", icon: <AudioLines size={17} />, onSelect: () => setDialog("context") }] : []),
        ]}
      />
      {dialog === "model" && ctx && (
        <Modal title={`Model for ${agent.name}`} onClose={() => setDialog(null)}>
          <ModelPanel agent={agent} ctx={ctx} catalog={catalog} close={() => setDialog(null)} />
        </Modal>
      )}
      {dialog === "access" && ctx && (
        <Modal title={`What ${agent.name} can do`} onClose={() => setDialog(null)}>
          <AccessList agent={agent} ctx={ctx} canEdit={canEdit} close={() => setDialog(null)} />
        </Modal>
      )}
      {dialog === "context" && ctx && (
        <Modal title="Context window" onClose={() => setDialog(null)}>
          <ContextBody ctx={ctx} />
        </Modal>
      )}
    </>
  );
}

/** Where the composer would be, in an archived team. */
function ArchivedBar({ channel }: { channel: ChannelInfo }) {
  const canManage = useStore((s) => s.me?.role !== "guest");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="shrink-0 px-3 md:px-5 pb-3 pt-1 safe-bottom">
      <div className="mx-auto max-w-2xl rounded-3xl bg-card px-4 py-3 flex items-center gap-3">
        <Archive size={18} className="text-muted shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">This team is archived</span>
          <span className="block text-[13px] text-muted">Nobody can post. Notes stay.</span>
        </span>
        {canManage && (
          <button className="h-10 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" onClick={() => setArchived(channel, false).catch((e) => setError((e as Error).message))}>
            Unarchive
          </button>
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

/** What an agent may do on its computer: read only, edit files, or everything. */
function AccessList({ agent, ctx, canEdit, close }: { agent: Agent; ctx: AgentContext; canEdit: boolean; close: () => void }) {
  const a = ctx.access;
  return (
    <div role="menu">
      <div className="overflow-hidden rounded-3xl bg-card divide-y divide-line">
        {(Object.keys(ACCESS) as AccessLevel[]).map((k) => (
          <button
            key={k}
            role="menuitemradio"
            aria-checked={a === k}
            disabled={!canEdit}
            onClick={async () => {
              close();
              if (k !== a) await patchAgent(agent.id, { settings: { access: k } });
            }}
            className="w-full text-left px-4 py-3 hover:bg-hover flex items-start gap-3 disabled:opacity-60"
          >
            <span className={cx("mt-0.5", k === "full" ? "text-warn" : "text-muted")}>{k === "full" ? <ShieldAlert size={18} /> : k === "read-only" ? <Eye size={18} /> : <Shield size={18} />}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">{ACCESS[k].label}</span>
              <span className="block text-[13px] text-muted">{ACCESS[k].body}</span>
            </span>
            {a === k && <Check size={17} className="mt-0.5" />}
          </button>
        ))}
      </div>
      <a href={`#/agents/${agent.id}/permissions`} onClick={close} className="mt-3 block px-1 text-[13px] text-muted hover:text-ink">
        Permission settings →
      </a>
    </div>
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
          aria-label="Model"
          className={cx("h-8 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[13px] min-w-0 text-muted", canEdit && "hover:bg-hover hover:text-ink", open && "bg-hover")}
        >
          {ctx.fast && ctx.fastAvailable && <Zap size={13} className="text-accent-text fill-accent shrink-0" />}
          <span className="truncate max-w-32 @lg:max-w-48">{label}</span>
          {ctx.effort && <span className="whitespace-nowrap">· {effortName(ctx.effort)}</span>}
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

/** How full this conversation's context window is, in words. */
function ContextBody({ ctx }: { ctx: AgentContext }) {
  const pct = ctx.contextUsed !== null && ctx.contextWindow ? Math.min(100, (ctx.contextUsed / ctx.contextWindow) * 100) : null;
  const color = pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)";
  return (
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
  );
}

/** Claude-style context ring: how full this conversation's context window is. */
function ContextRing({ ctx, circle }: { ctx: AgentContext; circle?: boolean }) {
  const pct = ctx.contextUsed !== null && ctx.contextWindow ? Math.min(100, (ctx.contextUsed / ctx.contextWindow) * 100) : null;
  const color = pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)";
  const r = 7;
  const c = 2 * Math.PI * r;
  const summary = pct !== null ? `${pct < 1 ? "<1" : Math.round(pct)}% of context used` : ctx.contextWindow ? `${tokens(ctx.contextWindow)} context window` : "Context appears after the first reply";
  return (
    <Popover
      align="right"
      up={!circle}
      className="w-72 p-3.5"
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} title={summary} aria-label="Context" className={circle ? cx("circle", open && "bg-hover") : cx("size-8 rounded-lg grid place-items-center hover:bg-hover", open && "bg-hover")}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle cx="9" cy="9" r={r} fill="none" stroke="var(--faint)" strokeOpacity="0.35" strokeWidth="2.6" />
            {pct !== null && <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${(Math.max(pct, 3) / 100) * c} ${c}`} transform="rotate(-90 9 9)" />}
          </svg>
        </button>
      )}
    >
      {() => <ContextBody ctx={ctx} />}
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
    <ChatCard icon={<AudioLines size={13} />} label="Context window">
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-semibold">{pct === null ? "Nothing used yet" : pct < 35 ? "Roughly a third full" : pct < 65 ? "Roughly half full" : pct < 85 ? "Getting full" : "Nearly full"}</span>
        {usage?.model && <span className="text-xs text-muted truncate">{prettyModel(usage.model)}</span>}
      </div>
      {pct !== null && (
        <div className="mt-2 h-2 rounded-full bg-chip overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
        </div>
      )}
      <p className="mt-2 text-[13px] text-muted">{used !== null ? `${tokens(used)}${window ? ` of ${tokens(window)}` : ""} used. Older messages are summarized when it fills up.` : "This shows up after its first reply here."}</p>
      {shrink && used !== null && (
        <button className="mt-2.5 h-10 rounded-full border border-control-line bg-control px-4 text-sm font-semibold" onClick={run}>
          {shrink.name === "compact" ? "Compact" : "Compress"}
        </button>
      )}
    </ChatCard>
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
  // every run working at the top of this chat shows as a bubble, even before it has said anything
  const runs = Object.values(live).filter((r) => r.channelId === channel.id && !r.threadId);
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
  }, [messages, runs.map((r) => `${r.runId}${r.text.length}${r.last?.name ?? ""}`).join(), channel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setNewSince(0);
    setAtBottom(true);
  }, [channel.id]);

  if (!messages) return <div className="flex-1 grid place-items-center text-sm text-muted">{history.error ? history.controls : "Loading…"}</div>;

  const empty = !messages.some((m) => m.author.id !== "system");
  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={ref}
        className="h-full overflow-y-auto pt-2 pb-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setAtBottom(bottom);
          if (bottom) setNewSince(0);
        }}
      >
        <div className="mx-auto w-full max-w-3xl">
        {history.controls}
        {!history.error && empty && !runs.length && <ChannelIntro channel={channel} onAddAgent={onAddAgent} onMembers={onMembers} />}
        {messages.map((m, i) => {
          const stamp = needsStamp(messages[i - 1], m);
          const grouped = !stamp && isGrouped(messages[i - 1], m) && m.id !== firstNew;
          const next = messages[i + 1];
          const last = !next || needsStamp(m, next) || !isGrouped(m, next) || next.id === firstNew;
          return (
            <div key={m.id}>
              {stamp && <TimeDivider at={m.createdAt} />}
              {m.id === firstNew && (
                <div ref={dividerRef} className="flex items-center gap-3 px-5 my-2 text-[11px] font-semibold tracking-wide text-accent-text">
                  <span className="h-px flex-1 bg-accent/40" /> NEW <span className="h-px flex-1 bg-accent/40" />
                </div>
              )}
              <MessageItem m={m} grouped={grouped} last={last} replies={replyCounts[m.id]} working={inThreads.filter((r) => r.threadId === m.id || r.threadPath.includes(m.id))} onReplies={() => go({ view: "chat", channelId: channel.id, threadId: m.id })} />
            </div>
          );
        })}
        {runs.map((r) => (
          <StreamingItem key={r.runId} run={r} />
        ))}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={() => {
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
            setNewSince(0);
          }}
          className="glass absolute bottom-3 left-1/2 -translate-x-1/2 h-9 px-3.5 rounded-full text-xs font-medium inline-flex items-center gap-1.5 hover:bg-hover"
        >
          <ArrowDown size={13} /> {newSince > 0 ? `${newSince} new ${newSince === 1 ? "message" : "messages"}` : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

function TimeDivider({ at }: { at: string }) {
  const { clock } = usePrefs();
  return <div className="px-5 py-3 text-center text-[13px] text-faint">{stampLabel(at, (d) => clockTime(d, clock))}</div>;
}

/** What a brand-new chat says: who you're talking to, or how to get a team going. */
function ChannelIntro({ channel, onAddAgent, onMembers }: { channel: ChannelInfo; onAddAgent: () => void; onMembers: () => void }) {
  const names = useNames();
  const invite = useFeature("invite");
  const canManage = useStore((s) => s.me?.role !== "guest") && !channel.archivedAt;
  const nodes = useDevices();
  if (channel.kind === "dm") {
    const a = names.agent(channel.name.split(":").pop()!);
    const where = a?.nodeId ? nodes?.find((n) => n.id === a.nodeId)?.name : undefined;
    return (
      <div className="px-8 pb-6 pt-10 flex flex-col items-center text-center">
        <AgentAvatar agent={a} size={72} live />
        <h2 className="mt-3 text-lg font-semibold">{a?.name}</h2>
        <p className="mt-1 max-w-xs text-[15px] text-muted">This is the start of your conversation with @{a?.handle}. Ask it anything, or hand it a task.</p>
        {a && <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted"><StatusDot status={a.status} />{a.status === "offline" ? "Offline" : `Ready${where ? ` on ${where}` : ""}`}</p>}
      </div>
    );
  }
  const answerer = channel.settings.defaultAgentId ? names.agent(channel.settings.defaultAgentId) : undefined;
  const leads = (channel.settings.team?.nodes ?? []).filter((n) => n.lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a);
  const cards: { icon: React.ReactNode; title: string; body: string; onClick: () => void }[] = [
    ...(canManage ? [{ icon: <Bot size={18} />, title: "Add agent", body: leads.length || answerer ? "Put another agent on the team" : "Pick who answers here", onClick: onAddAgent }] : []),
    ...(!channel.archivedAt ? [{ icon: <Paperclip size={18} />, title: "Add files", body: "Share notes and documents", onClick: () => window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH, { detail: channel.id })) }] : []),
    ...(invite && canManage ? [{ icon: <UserPlus size={18} />, title: "Invite people", body: "Bring someone into the team", onClick: onMembers }] : []),
  ];
  return (
    <div className="px-6 pb-6 pt-8 flex flex-col items-center text-center">
      <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={64} />
      <h2 className="mt-3 text-lg font-semibold">{channel.name}</h2>
      <p className="mt-1 max-w-sm text-[15px] text-muted">
        {channel.topic ? `${channel.topic.replace(/[.!?]\s*$/, "")}. ` : "This is the start of the team. "}
        {leads.length
          ? `${leads.map((a) => a.name).join(" and ")} ${leads.length > 1 ? "read" : "reads"} every new message here and hand${leads.length > 1 ? "" : "s"} out the work.`
          : answerer
            ? `${answerer.name} answers messages here. @mention another agent to ask them instead.`
            : "Add the agents who will work here."}
      </p>
      {cards.length > 0 && (
        <div className="mt-5 w-full max-w-sm overflow-hidden rounded-3xl bg-card divide-y divide-line text-left">
          {cards.map((c) => (
            <button key={c.title} type="button" onClick={c.onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
              <span className="size-9 shrink-0 rounded-full bg-chip grid place-items-center text-muted">{c.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold">{c.title}</span>
                <span className="block text-[13px] text-muted">{c.body}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-faint" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Add files" on a new channel's intro asks the composer to open its file picker. */
const COMPOSER_ATTACH = "wisp:composer-attach";
/** A reply started from a message asks that conversation's composer to take focus. */
const COMPOSER_FOCUS = "wisp:composer-focus";

/** Scroll to a message that's on screen and flash it; false when it isn't loaded. */
function flashMessage(id: string): boolean {
  const el = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]")).find((x) => x.dataset.messageId === id);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("bg-accent-soft");
  setTimeout(() => el.classList.remove("bg-accent-soft"), 1600);
  return true;
}

// --- one message --------------------------------------------------------------------------------

/** A hand-off, a note from Wisp, or a person's or agent's message. */
function MessageItem(props: { m: Message; grouped?: boolean; last?: boolean; replies?: number; onReplies?: () => void; inThread?: boolean; composerThread?: string; working?: LiveRun[] }) {
  return props.m.author.id === "system" ? <SystemItem {...props} /> : <PersonMessage {...props} />;
}

function SystemItem({ m, replies, onReplies, working = [] }: { m: Message; replies?: number; onReplies?: () => void; working?: LiveRun[] }) {
  const task = m.parts.find((p) => p.type === "task");
  // a step Wisp handed out: a row that opens the work in its own sub-thread
  if (task && task.type === "task") return <HandoffRow m={m} taskId={task.taskId} replies={replies} working={working} onOpen={onReplies} />;
  return (
    <div className="px-5 py-1.5 text-xs text-muted flex items-center gap-2" data-message-id={m.id}>
      <span className="h-px flex-1 bg-line" />
      {m.parts.map((p, i) => (p.type === "status" || p.type === "notice") && <span key={i}>{p.text}</span>)}
      {m.body && <span className="text-center">{m.body.replace(/\*\*/g, "")}</span>}
      {m.parts.map((p) => p.type === "routine" && <RoutineChip key={p.routineId} id={p.routineId} />)}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function useTask(id: string): TaskRow | null {
  const version = useStore((s) => s.tasksVersion);
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
  return task;
}

/** "› Handed to Pappy · 4 replies · Working": opens the hand-off's own thread. */
function HandoffRow({ m, taskId, replies, working, onOpen }: { m: Message; taskId: string; replies?: number; working: LiveRun[]; onOpen?: () => void }) {
  const task = useTask(taskId);
  const agents = useStore((s) => s.agents);
  const agent = task?.toAgentId ? agents.find((a) => a.id === task.toAgentId) : undefined;
  const st = task ? taskState(task) : null;
  const busy = working.length > 0;
  const state = busy ? "Working" : st?.label;
  return (
    <div className="px-3 md:px-5 pl-[3.25rem] md:pl-[4.25rem] py-1" data-message-id={m.id}>
      <button
        onClick={onOpen}
        title={task?.title}
        className="inline-flex max-w-full items-center gap-2 h-9 rounded-full border border-control-line bg-control pl-3 pr-3.5 text-[13px] hover:bg-hover"
      >
        <ChevronRight size={14} className="shrink-0 text-muted" />
        <span className="truncate">
          Handed to <b className="font-semibold">{agent?.name ?? m.body.match(/^@([\w-]+)/)?.[1] ?? "an agent"}</b>
        </span>
        {!!replies && <span className="shrink-0 text-muted">· {replies} {replies === 1 ? "reply" : "replies"}</span>}
        {state && (
          <span className={cx("shrink-0 inline-flex items-center gap-1", st?.tone === "bad" ? "text-bad" : st?.tone === "ok" ? "text-ok" : "text-muted")}>
            · {busy && <span className="size-1.5 rounded-full bg-ok animate-pulse" aria-hidden />}
            {state}
          </span>
        )}
      </button>
    </div>
  );
}

function PersonMessage({ m, grouped, last = true, replies, onReplies, inThread, composerThread, working = [] }: { m: Message; grouped?: boolean; last?: boolean; replies?: number; onReplies?: () => void; inThread?: boolean; composerThread?: string; working?: LiveRun[] }) {
  const { clock } = usePrefs();
  const names = useNames();
  const handles = useHandleNames();
  const colors = useHandleColors();
  const html = useMemo(() => (m.body ? renderMarkdown(m.body, { handles, colors }) : ""), [m.body, handles, colors]);
  const cards = useMemo(() => linkCards(m.body), [m.body]);
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const agent = m.author.kind === "agent" ? names.agent(m.author.id) : undefined;
  const name = agent ? agent.name : (names.member(m.author.id)?.name ?? "Someone");
  const time = clockTime(m.createdAt, clock);
  const solo = useContext(SoloAgent);
  // the DM's own agent already lives in the pill above: no ghost or name on its messages
  const home = !!agent && agent.id === solo;
  const pinned = useStore((s) => !!s.channels.find((c) => c.id === m.channelId)?.pinnedIds.includes(m.id));
  // like Messages: what you wrote sits on the right in your own color, with no name or picture
  const meId = useStore((s) => s.me?.user.id);
  const mine = m.author.kind === "user" && m.author.id === meId;
  const startsAt = composerThread ?? undefined;
  const actions = useMessageActionList(m, {
    onReply: () => startReply(m, name, startsAt),
    // a message already in a thread opens a sub-thread; the thread's own first message has nowhere deeper to go
    onThread: onReplies,
    onEdit: () => setEditing(true),
    onDelete: () => setDeleting(true),
  });
  const press = useLongPress(() => setSheet(true), !m.deletedAt && actions.length > 0);
  const hasChange = m.parts.some((p) => p.type === "change");
  const quote = m.replyTo;
  const showBubble = !m.deletedAt && (!!html || !!quote) && !hasChange;
  const showAvatar = !mine && !home;

  return (
    <div
      data-message-id={m.id}
      {...press}
      className={cx("msg-press group relative px-3 md:px-5 flex items-end gap-2 rounded-lg transition-colors", mine ? "justify-end" : "justify-start", last ? "pb-1.5" : "pb-[3px]", !grouped && "pt-1")}
    >
      {showAvatar && (
        <div className="w-8 shrink-0 self-end">
          {last &&
            (agent ? (
              <button onClick={() => go({ view: "agents", agentId: agent.id, tab: "overview" })} aria-label={`Open ${agent.name}`}>
                <AgentAvatar agent={agent} size={32} />
              </button>
            ) : (
              <UserAvatar name={name} size={32} />
            ))}
        </div>
      )}
      <div className={cx("min-w-0 flex flex-col max-w-[84%] md:max-w-[36rem]", mine ? "items-end" : "items-start")}>
        {!grouped && !home && !mine && (
          <div className="px-3.5 pb-0.5 text-[12px] text-muted flex items-center gap-1.5" title={agent ? `Agent · ${harnessLabel(agent.harness)}` : undefined}>
            {name}
            {pinned && <Pin size={11} aria-label="Pinned" />}
          </div>
        )}
        {mine && pinned && (
          <span className="text-[11px] text-muted inline-flex items-center gap-0.5 mb-0.5 mr-1">
            <Pin size={11} /> Pinned
          </span>
        )}
        {m.deletedAt ? (
          <div className="bubble them text-[15px] text-muted italic">This message was deleted.</div>
        ) : (
          showBubble && (
            <div className={cx("bubble text-[16px] md:text-[15px]", mine ? "me" : "them")} title={time}>
              {quote && (
                <button
                  type="button"
                  className="quote"
                  onClick={() => {
                    if (!flashMessage(quote.id)) go({ view: "chat", channelId: m.channelId, threadId: m.threadId, messageId: quote.id });
                  }}
                  aria-label="Go to the message this replies to"
                >
                  <b className="block font-semibold">{quote.author.kind === "user" && quote.author.id === meId ? "You" : (quote.author.kind === "agent" ? names.agent(quote.author.id)?.name : names.member(quote.author.id)?.name) ?? "Someone"}</b>
                  <span className="line-clamp-2">{quote.deleted ? "This message was deleted." : quote.snippet}</span>
                </button>
              )}
              {html && <div className="prose-w" dangerouslySetInnerHTML={{ __html: m.editedAt ? withEditedMark(html, clockTime(m.editedAt, clock)) : html }} />}
            </div>
          )
        )}
        {!m.deletedAt &&
          cards.map((c) => (
            <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="mt-1 flex w-full max-w-sm items-center gap-3 rounded-3xl bg-card px-3.5 py-2.5 hover:bg-hover">
              <span className="size-9 rounded-full bg-chip grid place-items-center text-muted">{c.kind === "PR" ? <GitPullRequest size={16} /> : <CircleDot size={16} />}</span>
              <span className="min-w-0">
                <span className="block text-[11px] text-muted">GitHub · {c.kind === "PR" ? "Pull request" : "Issue"}</span>
                <span className="block text-sm font-medium truncate">
                  {c.repo} #{c.num}
                </span>
              </span>
            </a>
          ))}
        {!m.deletedAt && (
          <CardAuthor.Provider value={m.author.kind === "agent" ? { agentId: m.author.id, channelId: m.channelId, threadId: m.threadId } : null}>
            <Parts parts={m.parts} body={m.body} agentName={agent?.name} />
          </CardAuthor.Provider>
        )}
        {(!!replies || working.length > 0) && onReplies && !inThread && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {!!replies && (
              <button onClick={onReplies} className="h-8 px-3 rounded-full border border-control-line bg-control text-[13px] hover:bg-hover inline-flex items-center gap-1.5">
                <MessageSquare size={13} /> {replies} {replies === 1 ? "reply" : "replies"} <ChevronRight size={13} className="text-muted" />
              </button>
            )}
            {working.length > 0 && <ThreadWork runs={working} threadId={m.id} onClick={onReplies} />}
          </div>
        )}
        {(!!replies || working.length > 0) && onReplies && inThread && (
          <button onClick={onReplies} className="mt-1 h-8 px-3 rounded-full border border-control-line bg-control text-[13px] hover:bg-hover inline-flex items-center gap-1.5">
            <MessageSquare size={13} /> {replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Working"} <ChevronRight size={13} className="text-muted" />
          </button>
        )}
      </div>
      {!m.deletedAt && <ActionToolbar actions={actions} side={mine ? "right" : "left"} />}
      {sheet && (
        <ActionSheet
          actions={actions}
          onClose={() => setSheet(false)}
          preview={
            <div className={cx("bubble text-[16px]", mine ? "me" : "them")}>
              <div className="prose-w line-clamp-6" dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />
            </div>
          }
        />
      )}
      {editing && <EditMessageDialog m={m} onClose={() => setEditing(false)} />}
      {deleting && <DeleteMessageDialog m={m} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** "(edited)" at the end of the last paragraph, like Slack, rather than on a line of its own. */
function withEditedMark(html: string, at: string) {
  const mark = `<span class="text-[11px] opacity-60" title="Edited ${at}"> (edited)</span>`;
  const t = html.trimEnd();
  return t.endsWith("</p>") ? t.slice(0, -4) + mark + "</p>" : t + mark;
}

/** GitHub PR and issue links get a small card, like Buzz. Parsed locally; nothing is fetched. */
function linkCards(body: string) {
  const out: { url: string; repo: string; num: string; kind: "PR" | "Issue" }[] = [];
  for (const m of body.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g)) {
    if (!out.some((c) => c.url === m[0])) out.push({ url: m[0], repo: m[1], num: m[3], kind: m[2] === "pull" ? "PR" : "Issue" });
  }
  return out.slice(0, 3);
}

function Parts({ parts, body = "", agentName }: { parts: MessagePart[]; body?: string; agentName?: string }) {
  const tools = parts.filter((p) => p.type === "tool_call");
  const files = parts.filter((p) => p.type === "file");
  const status = parts.filter((p) => p.type === "status");
  const { toolCalls } = usePrefs();
  const [open, setOpen] = useState(toolCalls === "expanded");
  const summary = useMemo(() => workSummary(tools.flatMap((t) => (t.type === "tool_call" ? [{ name: t.name, input: t.input }] : []))), [parts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {parts.map((p) => p.type === "discussion" && <DiscussionCard key={p.discussionId} id={p.discussionId} />)}
      {parts.map((p, i) => p.type === "computer" && <ComputerPart key={`c${i}`} computerId={p.computerId} request={p.request} agentName={agentName} />)}
      {parts.map((p) => p.type === "approval" && <ApprovalCard key={p.approvalId} id={p.approvalId} />)}
      {parts.map((p) => p.type === "routine" && <RoutineChip key={p.routineId} id={p.routineId} />)}
      {parts.map((p) => p.type === "task" && <TaskChip key={p.taskId} id={p.taskId} />)}
      {parts.map((p, i) => p.type === "context" && <ContextCard key={`x${i}`} usage={p.usage} />)}
      {parts.map((p) => p.type === "change" && <ChangeCard key={p.changeId} id={p.changeId} fallback={body} />)}
      {parts.map((p, i) => p.type === "notice" && <div key={`n${i}`} className="mt-1 px-1 text-xs text-muted whitespace-pre-wrap">{p.text}</div>)}
      {files.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {files.map((f) => f.type === "file" && <FileChip key={f.fileId} id={f.fileId} name={f.name} />)}
        </div>
      )}
      {status.map((s, i) => s.type === "status" && <div key={i} className={cx("mt-1 px-1", s.text === "Voice message" ? "text-[11px] text-faint inline-flex items-center gap-1" : "text-sm text-bad")}>{s.text === "Voice message" && <Mic size={11} />}{s.text}</div>)}
      <Remembered tools={tools} />
      {tools.length > 0 && toolCalls !== "hidden" && (
        <div className="mt-1 w-full max-w-md">
          {/* one line of what it did, like "Searched the web · read 6 pages"; opens the tool calls */}
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="max-w-full h-8 px-3 rounded-full border border-control-line bg-control text-[13px] text-muted hover:text-ink hover:bg-hover inline-flex items-center gap-2">
            <SquareTerminal size={13} className="shrink-0" />
            <span className="truncate">{summary}</span>
            <ChevronRight size={13} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
          </button>
          {open && (
            <div className="mt-1.5 overflow-hidden rounded-3xl bg-card divide-y divide-line">
              <div className="px-4 py-2 text-[13px] font-medium text-muted">Ran {tools.length} {tools.length === 1 ? "tool" : "tools"}</div>
              {tools.map(
                (t, i) =>
                  t.type === "tool_call" && (
                    <details key={i} className="text-xs">
                      <summary className="px-4 py-2 cursor-pointer text-[13px]">{toolLine(t.name, t.input)}</summary>
                      <pre className="px-4 pb-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-muted">
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
    <div className="mt-1 flex flex-wrap gap-1.5">
      {saved.map((r, i) => (
        <a
          key={i}
          href={r.path ? `#/vault/${r.path}` : "#/about"}
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-control-line bg-control px-3 h-8 text-[13px] hover:bg-hover"
          title={`Saved to memory${KIND_LABEL[r.kind] ? ` (${KIND_LABEL[r.kind]})` : ""}. Open it to edit or delete.`}
        >
          <Brain size={13} className="text-muted shrink-0" />
          <span className="shrink-0">Remembered</span>
          <span className="text-muted">·</span>
          <span className="truncate text-muted">{r.text}</span>
          <ChevronRight size={13} className="shrink-0 text-faint" />
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
  if (isImage && url) return <img src={url} alt={name} onClick={open} className="max-h-64 max-w-full rounded-3xl cursor-pointer" />;
  return (
    <button onClick={open} className="flex items-center gap-2.5 rounded-2xl bg-card px-3.5 py-2.5 text-sm hover:bg-hover">
      <FileText size={16} className="text-muted" /> {name}
    </button>
  );
}

/** What a run is doing, short: "Reading main.ts", "Editing files", "Thinking…". */
function workLine(run: LiveRun, agents: Agent[]): string {
  const inp = (run.last?.input ?? {}) as Record<string, unknown>;
  const path = [inp.file_path, inp.path, inp.filename, inp.file].find((v) => typeof v === "string") as string | undefined;
  const base = path?.split("/").pop();
  const kind = run.last ? workKind(run.last.name) : null;
  if (base && kind === "read") return `Reading ${base}`;
  if (base && kind === "edit") return `Writing ${base}`;
  if (!run.last && !run.text) return "Thinking…";
  const t = runActivity(run, agents);
  return t.charAt(0).toUpperCase() + t.slice(1) + (/…$/.test(t) ? "" : "…");
}

/** An agent's reply as it streams in, before it's posted: its words so far, then three pulsing dots and what it's doing. */
function StreamingItem({ run }: { run: LiveRun }) {
  const names = useNames();
  const agents = useStore((s) => s.agents);
  const handles = useHandleNames();
  const colors = useHandleColors();
  const agent = names.agent(run.agentId);
  const html = useMemo(() => (run.text ? renderMarkdown(run.text, { handles, colors }) : ""), [run.text, handles, colors]);
  const computerId = agent?.computerId;
  const home = useContext(SoloAgent) === run.agentId;
  return (
    <div className="px-3 md:px-5 pt-1 pb-1.5 flex items-end gap-2">
      {!home && (
        <div className="w-8 shrink-0 self-end">
          <AgentAvatar agent={agent} size={32} live />
        </div>
      )}
      <div className="min-w-0 flex flex-col items-start gap-[3px] max-w-[84%] md:max-w-[36rem]">
        {!home && <div className="px-3.5 pb-0.5 text-[12px] text-muted">{agent?.name ?? "Agent"}</div>}
        {html && <div className="bubble them text-[16px] md:text-[15px]"><div className="prose-w" dangerouslySetInnerHTML={{ __html: html }} /></div>}
        <div role="status" aria-live="polite" aria-label={`${agent?.name ?? "Agent"} is working: ${workLine(run, agents)}`} className="bubble them inline-flex items-center gap-2.5 !py-3">
          <span className="work-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="text-[15px] md:text-[14px] text-muted">{workLine(run, agents)}</span>
        </div>
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
  const streaming = Object.values(live).filter((r) => r.channelId === channelId && r.threadId === rootId);
  const below = Object.values(live).filter((r) => r.channelId === channelId && r.threadPath.includes(rootId));

  useEffect(() => {
    void loadThread(channelId, rootId).catch(() => {});
  }, [channelId, rootId, loadThread]);
  useLayoutEffect(() => {
    if (history.prepended.current) { history.prepended.current = false; return; }
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [replies?.length, streaming.map((r) => `${r.runId}${r.text.length}${r.last?.name ?? ""}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => go({ view: "chat", channelId, threadId: null });
  // a sub-thread goes back to the thread it branched off from
  const parent = root?.threadId ?? null;
  const open = (id: string) => go({ view: "chat", channelId, threadId: id });
  const handoff = root?.author.id === "system" ? root.parts.find((p) => p.type === "task") : undefined;
  return (
    <RightPane label={parent ? "Sub-thread" : handoff ? "Hand-off" : "Thread"} className="!bg-panel">
      {handoff && handoff.type === "task" ? (
        <HandoffHeader taskId={handoff.taskId} runs={[...streaming, ...below]} parent={parent} onBack={parent ? () => open(parent) : close} onClose={close} />
      ) : (
        <ThreadHeader channelId={channelId} parent={parent} onBack={parent ? () => open(parent) : close} onClose={close} />
      )}
      {!parent && <FlowStrip channelId={channelId} threadId={rootId} />}
      <div ref={ref} className="flex-1 overflow-y-auto py-3">
        {history.controls}
        {removed && <p role="status" className="px-5 py-2 text-xs text-muted">This message was deleted.</p>}
        {!removed && root && (handoff && handoff.type === "task" ? <HandoffBrief m={root} taskId={handoff.taskId} /> : <ThreadRoot m={root} composerThread={rootId} />)}
        <div className="flex items-center gap-3 px-5 py-2 text-[13px] text-muted">
          {history.error ? "" : replies ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : "Loading…"}
          <span className="h-px flex-1 bg-line" />
        </div>
        {replies?.map((m, i) => {
          const stamp = needsStamp(replies[i - 1], m);
          const next = replies[i + 1];
          const last = !next || needsStamp(m, next) || !isGrouped(m, next);
          return (
            <div key={m.id}>
              {stamp && i > 0 && <TimeDivider at={m.createdAt} />}
              <MessageItem m={m} grouped={!stamp && isGrouped(replies[i - 1], m)} last={last} inThread composerThread={rootId} replies={replyCounts[m.id]} working={below.filter((r) => r.threadId === m.id || r.threadPath.includes(m.id))} onReplies={() => open(m.id)} />
            </div>
          );
        })}
        {streaming.map((r) => (
          <StreamingItem key={r.runId} run={r} />
        ))}
      </div>
      {!removed && <Composer channelId={channelId} threadId={rootId} agentId={agentId} placeholder={handoff && handoff.type === "task" ? "Reply…" : "Reply…"} />}
    </RightPane>
  );
}

function ThreadHeader({ channelId, parent, onBack, onClose }: { channelId: string; parent: string | null; onBack: () => void; onClose: () => void }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId));
  return (
    <header className="h-[4.5rem] shrink-0 px-3 flex items-center gap-2 border-b border-line safe-top box-content">
      <span className={cx(!parent && "lg:hidden")}>
        <button onClick={onBack} className="circle circle-sm" aria-label={parent ? "Back to the thread it came from" : "Back"} title={parent ? "Back to the thread it came from" : undefined}>
          <ChevronLeft size={20} />
        </button>
      </span>
      <div className="min-w-0 flex-1 px-1">
        <div className="truncate text-[16px] font-semibold leading-tight">{parent ? "Sub-thread" : "Thread"}</div>
        {channel && <div className="truncate text-[13px] text-muted">{channel.kind === "dm" ? "Chat" : channel.name}</div>}
      </div>
      <span className="max-lg:hidden">
        <button onClick={onClose} className="circle circle-sm" aria-label="Close thread">
          <X size={18} />
        </button>
      </span>
    </header>
  );
}

/** A hand-off's own thread: "Handed to Pappy", where it stands, and a way to stop it. */
function HandoffHeader({ taskId, runs, parent, onBack, onClose }: { taskId: string; runs: LiveRun[]; parent: string | null; onBack: () => void; onClose: () => void }) {
  const task = useTask(taskId);
  const agent = useStore((s) => (task?.toAgentId ? s.agents.find((a) => a.id === task.toAgentId) : undefined));
  const st = task ? taskState(task) : null;
  const mine = runs.filter((r) => !agent || r.agentId === agent.id);
  const canStop = useStore((s) => s.me?.role !== "guest") && mine.length > 0;
  return (
    <header className="h-[4.5rem] shrink-0 px-3 flex items-center gap-2 border-b border-line safe-top box-content">
      <span className={cx(!parent && "lg:hidden")}>
        <button onClick={onBack} className="circle circle-sm" aria-label="Back">
          <ChevronLeft size={20} />
        </button>
      </span>
      <div className="min-w-0 flex-1 flex items-center gap-2.5 px-1">
        {agent && <AgentAvatar agent={agent} size={32} live={mine.length > 0} />}
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold leading-tight">Handed to {agent?.name ?? "an agent"}</div>
          <div className={cx("text-[13px]", mine.length ? "text-ok" : st?.tone === "bad" ? "text-bad" : "text-muted")}>{mine.length ? "Working" : (st?.label ?? "")}</div>
        </div>
      </div>
      {canStop && (
        <button onClick={() => void stopRuns(mine)} className="circle circle-sm" aria-label={`Stop ${agent?.name ?? "it"}`} title="Stop">
          <Square size={15} fill="currentColor" />
        </button>
      )}
      <span className="max-lg:hidden">
        <button onClick={onClose} className="circle circle-sm" aria-label="Close thread">
          <X size={18} />
        </button>
      </span>
    </header>
  );
}

/** The top of a hand-off thread: who handed what to whom, and when it started. */
function HandoffBrief({ m, taskId }: { m: Message; taskId: string }) {
  const task = useTask(taskId);
  const { clock } = usePrefs();
  const agents = useStore((s) => s.agents);
  const from = useStore((s) => (task?.from.kind === "agent" ? s.agents.find((a) => a.id === task.from.id)?.name : undefined));
  const to = task?.toAgentId ? agents.find((a) => a.id === task.toAgentId)?.name : undefined;
  const st = task ? taskState(task) : null;
  return (
    <div className="px-3 pb-1">
      <ChatCard icon={<ArrowRightLeft size={13} />} label={`${from ?? "Someone"} handed this to ${to ?? "an agent"}`} className="max-w-none">
        <div className="mt-2 text-[15px] font-semibold leading-snug">{task?.title ?? m.body.replace(/^@[\w-]+\s*/, "")}</div>
        <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
          {st && <Pill tone={st.tone}>{st.label}</Pill>}
          <span>Started {clockTime(m.createdAt, clock)}</span>
        </div>
      </ChatCard>
    </div>
  );
}

/** The first message of a thread, on a card at the top of it. */
function ThreadRoot({ m }: { m: Message; composerThread?: string }) {
  const { clock } = usePrefs();
  const names = useNames();
  const handles = useHandleNames();
  const colors = useHandleColors();
  const html = useMemo(() => (m.body ? renderMarkdown(m.body, { handles, colors }) : ""), [m.body, handles, colors]);
  const meId = useStore((s) => s.me?.user.id);
  const agent = m.author.kind === "agent" ? names.agent(m.author.id) : undefined;
  const mine = m.author.kind === "user" && m.author.id === meId;
  const name = mine ? "You" : agent ? agent.name : (names.member(m.author.id)?.name ?? "Someone");
  return (
    <div className="px-3 pb-1" data-message-id={m.id}>
      <div className="rounded-3xl bg-card px-4 py-3">
        <div className="flex items-center gap-2.5">
          {agent ? <AgentAvatar agent={agent} size={24} interactive={false} /> : <UserAvatar name={names.member(m.author.id)?.name ?? name} size={24} />}
          <span className="text-[14px] font-semibold">{name}</span>
          <span className="text-[13px] text-faint">{clockTime(m.createdAt, clock)}</span>
        </div>
        {m.deletedAt ? (
          <div className="mt-2 text-[15px] italic text-muted">This message was deleted.</div>
        ) : (
          <>
            {html && <div className="prose-w mt-2 text-[15px]" dangerouslySetInnerHTML={{ __html: html }} />}
            <CardAuthor.Provider value={m.author.kind === "agent" ? { agentId: m.author.id, channelId: m.channelId, threadId: m.threadId } : null}>
              <Parts parts={m.parts} body={m.body} agentName={agent?.name} />
            </CardAuthor.Provider>
          </>
        )}
      </div>
    </div>
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
    <button onClick={onClick} className="h-8 pl-1.5 pr-3 rounded-full bg-chip hover:bg-hover text-[13px] inline-flex items-center gap-1.5" title={deeper ? "Working in a sub-thread" : "Working in this thread"}>
      <span className="flex">
        {agents.slice(0, 3).map((a, i) => (
          <span key={a.id} className={cx("rounded-full ring-2 ring-chip", i > 0 && "-ml-1.5")}>
            <AgentAvatar agent={a} size={18} live interactive={false} />
          </span>
        ))}
      </span>
      <span className="work-dots scale-75" aria-hidden>
        <i />
        <i />
        <i />
      </span>
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

/** A task an agent mentions: title, who has it, where it stands, and a way into Tasks. */
function TaskChip({ id }: { id: string }) {
  const agents = useStore((s) => s.agents);
  const task = useTask(id);
  if (!task) return null;
  const agent = task.toAgentId ? agents.find((a) => a.id === task.toAgentId) : undefined;
  const st = taskState(task);
  return (
    <a href={href({ view: "tasks" })} className="block">
      <ChatCard icon={<ListChecks size={13} />} label="Task" className="hover:bg-hover">
        <div className="mt-2 text-[15px] font-semibold leading-snug">{task.title}</div>
        <div className="mt-2 flex items-center gap-2">
          <Pill tone={st.tone}>{st.label}</Pill>
          {agent && (
            <span className="inline-flex items-center gap-1 text-[13px] text-muted">
              <AgentAvatar agent={agent} size={18} badge={false} interactive={false} /> {agent.name}
            </span>
          )}
        </div>
      </ChatCard>
    </a>
  );
}

// --- composer -----------------------------------------------------------------------------------

/** The message a draft replies to: who said it, and a few of their words. */
interface ReplyTarget {
  id: string;
  name: string;
  snippet: string;
}

interface ComposerDraft {
  text: string;
  files: { id: string; name: string; size?: number }[];
  /** files still going up */
  pending: { key: string; name: string; size?: number }[];
  sending: boolean;
  error: string | null;
  replyTo: ReplyTarget | null;
}
const emptyComposerDraft: ComposerDraft = { text: "", files: [], pending: [], sending: false, error: null, replyTo: null };
const composerDrafts = new Map<string, ComposerDraft>();
const draftListeners = new Set<() => void>();
const subscribeDrafts = (onChange: () => void) => {
  draftListeners.add(onChange);
  return () => { draftListeners.delete(onChange); };
};

// Drafts survive a restart: what's typed, attached and replied to is kept per conversation in this browser.
const DRAFTS_KEY = "wisp.drafts";
function storedDraft(key: string): ComposerDraft | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Pick<ComposerDraft, "text" | "files" | "replyTo">>;
    const d = all[key];
    return d ? { ...emptyComposerDraft, text: d.text ?? "", files: d.files ?? [], replyTo: d.replyTo ?? null } : undefined;
  } catch {
    return undefined;
  }
}
function storeDraft(key: string, d: ComposerDraft) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, unknown>;
    if (!d.text.trim() && !d.files.length) delete all[key];
    else all[key] = { text: d.text, files: d.files, replyTo: d.replyTo };
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {}
}

function draftKey(channelId: string, threadId?: string | null) {
  return JSON.stringify([channelId, threadId ?? null]);
}
function readDraft(key: string): ComposerDraft {
  let d = composerDrafts.get(key);
  if (!d) {
    d = storedDraft(key) ?? emptyComposerDraft;
    composerDrafts.set(key, d);
  }
  return d;
}

function useComposerDraft(channelId: string, threadId?: string) {
  const key = draftKey(channelId, threadId);
  const get = () => readDraft(key);
  const draft = useSyncExternalStore(subscribeDrafts, get, get);
  const update = (change: (draft: ComposerDraft) => ComposerDraft) => {
    const next = change(get());
    composerDrafts.set(key, next);
    storeDraft(key, next);
    draftListeners.forEach((notify) => notify());
  };
  return [draft, update, get] as const;
}

/** Reply to a message: the composer of its conversation shows "Replying to …" and takes focus. */
function startReply(m: Message, name: string, threadId?: string) {
  const key = draftKey(m.channelId, threadId);
  const d = readDraft(key);
  const next = { ...d, replyTo: { id: m.id, name, snippet: snippetOf(m) } };
  composerDrafts.set(key, next);
  storeDraft(key, next);
  draftListeners.forEach((notify) => notify());
  window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS, { detail: key }));
}

const fileSize = (n?: number) => (n === undefined ? "" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

/** Speech to text in the message box, where the browser can do it. */
function useDictation(onText: (text: string) => void) {
  const [on, setOn] = useState(false);
  const rec = useRef<{ stop: () => void } | null>(null);
  const Ctor = typeof window !== "undefined" ? ((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) : undefined;
  useEffect(() => () => rec.current?.stop(), []);
  const toggle = () => {
    if (on) return rec.current?.stop();
    if (!Ctor) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new (Ctor as any)();
    r.continuous = true;
    r.interimResults = false;
    r.lang = navigator.language;
    r.onresult = (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
    };
    r.onend = () => {
      setOn(false);
      rec.current = null;
    };
    r.onerror = () => setOn(false);
    rec.current = r;
    setOn(true);
    r.start();
  };
  return { supported: !!Ctor, on, toggle };
}

export function Composer({ channelId, threadId, agentId, placeholder, onDetails, onCall }: { channelId: string; threadId?: string; agentId?: string; placeholder: string; onDetails?: (agentId: string) => void; onCall?: () => void }) {
  const { sendWith } = usePrefs();
  const agents = useStore((s) => s.agents);
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const { agent: dmAgent, ctx, catalog } = useAgentContext(agentId, channelId, threadId);
  const live = useStore((s) => s.live);
  const [{ text, files, pending, sending, error, replyTo }, updateDraft, getDraft] = useComposerDraft(channelId, threadId);
  const uploading = pending.length;
  const setText = (value: string) => updateDraft((d) => ({ ...d, text: value }));
  const setFiles = (value: ComposerDraft["files"]) => updateDraft((d) => ({ ...d, files: value }));
  const [pick, setPick] = useState(0);
  const [caret, setCaret] = useState(0);
  const [nobodyAsked, setNobodyAsked] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const key = draftKey(channelId, threadId);
  // in a thread, who's working in it (or a sub-thread of it); at the top, everyone in the channel
  const working = Object.values(live).filter((r) => r.channelId === channelId && (!threadId || r.threadId === threadId || r.threadPath.includes(threadId)));
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId));
  const leads = channel?.kind === "channel" ? (channel.settings.team?.nodes ?? []).filter((n) => n.lead).map((n) => agents.find((a) => a.id === n.agentId)).filter((a): a is Agent => !!a) : [];
  const dictation = useDictation((t) => t && setText(`${getDraft().text}${getDraft().text && !/\s$/.test(getDraft().text) ? " " : ""}${t}`));

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
        : `Posting to ${channel.name}. @mention an agent to ask it.`
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

  // "Add files" on the channel intro opens this composer's file picker; Reply on a message focuses its box
  useEffect(() => {
    const open = (e: Event) => {
      if (!threadId && (e as CustomEvent<string>).detail === channelId) fileInput.current?.click();
    };
    const focus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) ta.current?.focus();
    };
    window.addEventListener(COMPOSER_ATTACH, open);
    window.addEventListener(COMPOSER_FOCUS, focus);
    return () => {
      window.removeEventListener(COMPOSER_ATTACH, open);
      window.removeEventListener(COMPOSER_FOCUS, focus);
    };
  }, [channelId, threadId, key]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
    el.style.overflowY = el.scrollHeight > 220 ? "auto" : "hidden";
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
    if (current.pending.length || current.sending || (!current.text.trim() && !current.files.length)) return;
    const body = current.text;
    const attached = current.files;
    const quoted = current.replyTo;
    const unasked = !!channel && channel.kind !== "dm" && !threadId && agents.length > 0 && !answerer && !leads.length && !parseMentions(body).length;
    setNobodyAsked(false);
    updateDraft((d) => ({ ...d, text: "", files: [], replyTo: null, sending: true, error: null }));
    try {
      await api("POST", `/api/channels/${channelId}/messages`, { body, threadId, fileIds: attached.map((f) => f.id), ...(quoted ? { replyToId: quoted.id } : {}) });
      setNobodyAsked(unasked);
    } catch (e) {
      // Restore into this conversation, keeping anything typed while the send was in flight.
      updateDraft((d) => ({ ...d, text: body && d.text ? `${body}\n${d.text}` : body || d.text, files: attached, replyTo: d.replyTo ?? quoted, error: (e as Error).message }));
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
    const selected = Array.from(list).slice(0, Math.max(0, 20 - current.files.length - current.pending.length));
    const added = selected.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, size: f.size }));
    updateDraft((d) => ({ ...d, pending: [...d.pending, ...added], error: selected.length < list.length ? "Attach up to 20 files per message." : null }));
    let done = 0;
    try {
      for (const f of selected) {
        const up = await uploadFile(f, channelId);
        const mine = added[done++];
        updateDraft((d) => ({ ...d, pending: d.pending.filter((p) => p.key !== mine.key), files: [...d.files, { id: up.id, name: up.name, size: up.size ?? f.size }] }));
      }
    } catch (e) {
      updateDraft((d) => ({ ...d, error: (e as Error).message }));
    } finally {
      const leftover = added.slice(done).map((a) => a.key);
      if (leftover.length) updateDraft((d) => ({ ...d, pending: d.pending.filter((p) => !leftover.includes(p.key)) }));
    }
  }

  const hasContent = !!text.trim() || files.length > 0 || uploading > 0;
  const showCall = !!onCall && !hasContent && !threadId;
  return (
    // @container: the toolbar fits itself to the composer's own width (a DM next to an open thread is narrow on a wide screen)
    <div className="shrink-0 px-3 md:px-5 pb-3 pt-1 safe-bottom @container w-full max-w-3xl mx-auto flex flex-col">
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (attach(e.target.files), (e.target.value = ""))} />
      <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => (attach(e.target.files), (e.target.value = ""))} />
      {/* who's working here and on what; Stop and details are in its sheet */}
      {working.length > 0 && (
        <div className="pb-2 flex justify-center">
          <ActivityPill runs={working} onDetails={(id) => (onDetails ? onDetails(id) : go({ view: "agents", agentId: id, tab: "overview" }))} onThread={(id) => go({ view: "chat", channelId, threadId: id })} hereThread={threadId ?? null} />
        </div>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-3 rounded-3xl bg-card pl-4 pr-1.5 py-1.5">
          <CornerUpLeft size={15} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-2.5 leading-tight">
            <div className="text-[13px] font-semibold">Replying to {replyTo.name}</div>
            <div className="truncate text-[13px] text-muted">{replyTo.snippet}</div>
          </div>
          <button onClick={() => updateDraft((d) => ({ ...d, replyTo: null }))} className="size-9 shrink-0 rounded-full grid place-items-center text-muted hover:bg-hover hover:text-ink" aria-label="Cancel reply">
            <X size={16} />
          </button>
        </div>
      )}
      {(files.length > 0 || uploading > 0) && (
        <div className="mb-2">
          <div className="px-1 pb-1 text-right text-[12px] text-faint">Draft saved</div>
          <div className="flex flex-wrap gap-2">
            {files.map((f) => (
              <span key={f.id} className="flex min-w-0 max-w-[15rem] items-center gap-2.5 rounded-2xl bg-card py-2 pl-3 pr-1.5">
                <FileText size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium">{f.name}</span>
                  {f.size !== undefined && <span className="block text-[12px] text-muted">{fileSize(f.size)}</span>}
                </span>
                <button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`} className="size-7 shrink-0 rounded-full grid place-items-center text-muted hover:bg-hover">
                  <X size={14} />
                </button>
              </span>
            ))}
            {pending.map((f) => (
              <span key={f.key} className="flex min-w-0 max-w-[15rem] items-center gap-2.5 rounded-2xl bg-card py-2 pl-3 pr-3">
                <Loader2 size={16} className="shrink-0 animate-spin text-muted" />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[13px] font-medium">{f.name}</span>
                  <span className="block text-[12px] text-muted">Uploading</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="relative flex items-end gap-2.5 md:gap-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), attach(e.dataTransfer.files))}>
        {slash.open && !suggestions.length && slash.render(pickCommand)}
        {suggestions.length > 0 && (
          <div className="glass absolute bottom-full mb-2 left-0 w-80 max-w-full rounded-3xl p-1.5 z-10" role="listbox" aria-label="Mention an agent">
            <div className="px-3 pt-1.5 pb-1 text-[13px] font-semibold text-muted">Mention an agent</div>
            {suggestions.map((a, i) => {
              const node = channel?.settings.team?.nodes.find((n) => n.agentId === a.id);
              return (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={i === pick % suggestions.length}
                  onMouseDown={(e) => (e.preventDefault(), complete(a.handle))}
                  className={cx("w-full px-3 py-2 rounded-2xl flex items-center gap-3 text-left", i === pick % suggestions.length && "bg-hover")}
                >
                  <AgentAvatar agent={a} size={28} badge={false} interactive={false} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-[15px] font-medium">{a.name}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {node?.role ?? `@${a.handle}`}
                      {node?.lead ? " · leads" : ""}
                    </span>
                  </span>
                  <StatusDot status={a.status} />
                </button>
              );
            })}
          </div>
        )}
        <Popover
          className="w-60 p-1.5 !rounded-3xl"
          trigger={(open, toggle) => (
            <button type="button" onClick={toggle} aria-label="Attach" aria-expanded={open} title="Attach" className={cx("circle circle-lg", open && "bg-hover")}>
              {uploading ? <Loader2 size={20} className="animate-spin" /> : <Plus size={22} strokeWidth={2} />}
            </button>
          )}
        >
          {(close) => (
            <div role="menu">
              <ComposerMenuItem icon={<Camera size={18} />} label="Photos" onClick={() => (close(), photoInput.current?.click())} />
              <ComposerMenuItem icon={<Paperclip size={18} />} label="Files" onClick={() => (close(), fileInput.current?.click())} />
              {channel?.kind !== "dm" && <ComposerMenuItem icon={<AtSign size={18} />} label="Mention an agent" onClick={() => (close(), insert(text && !/\s$/.test(text.slice(0, ta.current?.selectionStart ?? text.length)) ? " @" : "@"))} />}
            </div>
          )}
        </Popover>
        <div className="flex min-h-[52px] md:min-h-[42px] min-w-0 flex-1 items-end gap-1 rounded-[26px] md:rounded-[21px] border border-control-line bg-control pl-4 md:pl-4 pr-1.5 py-1.5 md:py-[3px] focus-within:border-ring">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={replyTo ? `Reply to ${replyTo.name}` : channel?.kind === "dm" && !threadId ? `${placeholder}, or type / for commands` : placeholder}
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
              if (e.key === "Escape" && replyTo) return (e.preventDefault(), updateDraft((d) => ({ ...d, replyTo: null })));
              // phones: Enter is a newline and the send button sends. Otherwise Enter sends, or
              // ⌘/Ctrl+Enter does when the person picked that (Settings → Preferences)
              const fine = window.matchMedia("(pointer: fine)").matches;
              const mod = e.metaKey || e.ctrlKey;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && fine && (sendWith === "mod-enter" ? mod : true)) {
                e.preventDefault();
                send();
              }
            }}
            className="block min-w-0 flex-1 resize-none bg-transparent py-[11px] md:py-[7px] text-[17px] md:text-[15px] outline-none placeholder:text-faint"
          />
          {dmAgent && ctx && (
            <span className="self-center max-md:hidden">
              <ModelControl agent={dmAgent} ctx={ctx} catalog={catalog} canEdit={canEdit} />
            </span>
          )}
          {!hasContent && dictation.supported && (
            <button type="button" onClick={dictation.toggle} aria-label={dictation.on ? "Stop dictating" : "Dictate"} aria-pressed={dictation.on} title="Dictate" className={cx("size-10 md:size-9 shrink-0 self-center rounded-full grid place-items-center", dictation.on ? "bg-bad/15 text-bad" : "text-muted hover:text-ink")}>
              <Mic size={20} />
            </button>
          )}
          {showCall && (
            <button type="button" onClick={onCall} aria-label={`Call ${dmAgent?.name ?? "agent"}`} title="Call" className="h-11 md:h-9 w-14 md:w-12 shrink-0 self-center rounded-full bg-accent text-accent-ink grid place-items-center md:hidden">
              <AudioLines size={22} />
            </button>
          )}
          {(hasContent || !dictation.supported) && !showCall && (
            <button
              onClick={send}
              disabled={!!uploading || sending || (!text.trim() && !files.length)}
              className="h-11 md:h-9 w-14 md:w-12 shrink-0 self-center rounded-full bg-accent text-accent-ink grid place-items-center disabled:bg-chip disabled:text-faint transition-colors"
              aria-label="Send"
            >
              <ArrowUp size={19} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      {(error || hint || (canAsk && !error) || (nobodyAsked && !hint && !error)) && (
        <div className="pt-1.5 px-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {error && <span className="text-bad">{error}</span>}
          {!error && hint && <span className="text-muted">{hint}</span>}
          {!error && canAsk && (
            <button type="button" onClick={ask} className="text-accent-text hover:underline">
              {agents.length === 1 ? `Ask ${agents[0].name}` : "Ask an agent"}
            </button>
          )}
          {!error && nobodyAsked && !hint && <span className="text-muted">Nobody was asked. @mention a helper to get an answer.</span>}
        </div>
      )}
    </div>
  );
}

function ComposerMenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="w-full px-3 h-12 rounded-2xl flex items-center gap-3 text-[16px] hover:bg-hover">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}
