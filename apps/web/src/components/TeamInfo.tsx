import { useEffect, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Bell, Check, ChevronRight, Gauge, LogOut, Pencil, Pin, Plus, Trash2, Workflow, X } from "lucide-react";
import { hasSteps, type AccessLevel, type Agent } from "@wisp/core";
import { api } from "../api.ts";
import { go } from "../router.ts";
import { useNames, useStore, type ChannelInfo } from "../store.ts";
import { AnswerSelect, AboutChannel, ChannelAgents, ChannelMembers, ChannelPins, NOTIFY, leaveChannel, setArchived, setChannelPrefs, toGeneral, type ChannelMember, type ChannelSettingsTab } from "./Channels.tsx";
import { ChatAvatar } from "./ChatList.tsx";
import { TeamIconDialog } from "./TeamIcon.tsx";
import { MoreOptions } from "./MoreOptions.tsx";
import { RightPane } from "./RightPane.tsx";
import { AgentAvatar, Modal, StatusDot, cx } from "./ui.tsx";
import { prettyModel, effortName } from "./EffortSlider.tsx";
import { HowLines, useFlowLines } from "../team/How.tsx";
import { TeamEditSession } from "../team/Session.tsx";

export type InfoTab = "about" | "agents" | "members" | "pins";
const TABS: { id: InfoTab; label: string }[] = [
  { id: "about", label: "About" },
  { id: "agents", label: "Agents" },
  { id: "members", label: "Members" },
  { id: "pins", label: "Pins" },
];

/** True from the width the side pane sits beside the chat (below it, the info page fills the screen). */
function useWide() {
  const q = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export function useChannelMembers(channel: ChannelInfo) {
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  useEffect(() => {
    let live = true;
    api<ChannelMember[]>("GET", `/api/channels/${channel.id}/members`).then((m) => live && setMembers(m), () => live && setMembers(null));
    return () => {
      live = false;
    };
  }, [channel.id, channel.memberCount]);
  return members;
}

/** A grouped list of rows, like the iPhone's. */
function Group({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-3xl bg-card divide-y divide-line">{children}</div>;
}

function Row({ title, value, onClick, icon, danger, disabled, trailing = true }: { title: ReactNode; value?: ReactNode; onClick?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean; trailing?: boolean }) {
  const body = (
    <>
      {icon && <span className={cx("shrink-0", danger ? "text-bad" : "text-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className={cx("block text-body", danger ? "text-bad" : "font-medium")}>{title}</span>
        {value && <span className="block truncate text-[13px] text-muted">{value}</span>}
      </span>
      {onClick && trailing && <ChevronRight size={16} className="shrink-0 text-faint" />}
    </>
  );
  const cls = "flex w-full items-center gap-3 px-4 py-3 min-h-[52px]";
  return onClick ? (
    <button type="button" onClick={onClick} disabled={disabled} className={cx(cls, "hover:bg-hover disabled:opacity-50")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="px-1 pb-1.5 pt-1 text-[13px] font-semibold text-muted">{children}</h3>;
}

/** "3 agents, 1 person". */
export function teamCount(channel: ChannelInfo, members: ChannelMember[] | null): string {
  if (!members) return `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`;
  const a = members.filter((m) => m.kind === "agent").length;
  const p = members.length - a;
  return [a ? `${a} ${a === 1 ? "agent" : "agents"}` : "", p ? `${p} ${p === 1 ? "person" : "people"}` : ""].filter(Boolean).join(", ") || "No one yet";
}

/**
 * A team's info page: About, Agents, Members, Pins, notifications, context and access, and
 * leaving, archiving or deleting it. A pane beside the chat on desktops (a tab for each), a
 * full page on phones (all of it in one scroll). "How the team works" opens the team editor.
 */
export function TeamInfo({ channel, tab, onTab, onClose, onSettings }: { channel: ChannelInfo; tab: InfoTab; onTab: (t: InfoTab) => void; onClose: () => void; onSettings: (t: ChannelSettingsTab) => void }) {
  const wide = useWide();
  const members = useChannelMembers(channel);
  const role = useStore((s) => s.me?.role);
  const canManage = role === "owner" || role === "member";
  const show = (t: InfoTab) => !wide || tab === t;
  const [dialog, setDialog] = useState<null | "notify" | "answers" | "context" | "leave" | "archive" | "delete" | "icon">(null);
  return (
    <RightPane label={`${channel.name} info`} className="!bg-panel">
      <header className="h-[4.5rem] shrink-0 px-4 flex items-center gap-3 border-b border-line safe-top">
        {canManage && !channel.archivedAt ? (
          <button onClick={() => setDialog("icon")} className="shrink-0 rounded-full" aria-label="Change team icon">
            <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={44} />
          </button>
        ) : (
          <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={36} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium leading-tight">{channel.name}</div>
          <div className="truncate text-[13px] text-muted">{teamCount(channel, members)}</div>
        </div>
        <button onClick={onClose} className="circle circle-sm" aria-label="Close">
          <X size={18} />
        </button>
      </header>
      {wide && (
        <div className="shrink-0 px-4 pt-2 flex gap-4 border-b border-line text-sm" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)} className={cx("pb-2 -mb-px border-b-2", tab === t.id ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
              {t.label}
              {t.id === "pins" && channel.pinnedIds.length > 0 && <span className="ml-1 text-faint">{channel.pinnedIds.length}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6 safe-bottom">
        {!wide && (
          <div className="grid grid-cols-3 gap-2">
            <QuickAction icon={<Bell size={18} />} label="Notify" onClick={() => setDialog("notify")} />
            <QuickAction icon={<Pin size={18} />} label="Pins" onClick={() => document.getElementById("team-pins")?.scrollIntoView({ behavior: "smooth" })} />
            <QuickAction icon={<Gauge size={18} />} label="Context" onClick={() => setDialog("context")} />
          </div>
        )}
        {show("about") && <About channel={channel} members={members} canManage={canManage} onSettings={onSettings} onDialog={setDialog} />}
        {show("agents") && <Agents channel={channel} members={members} canManage={canManage} onSettings={onSettings} />}
        {show("members") && (
          <section aria-label="Members">
            <SectionTitle>Members</SectionTitle>
            <ChannelMembers channel={channel} canManage={canManage} onClose={onClose} />
          </section>
        )}
        {show("pins") && (
          <section id="team-pins" aria-label="Pinned messages">
            <SectionTitle>Pinned messages</SectionTitle>
            <ChannelPins channel={channel} onClose={onClose} />
          </section>
        )}
        {(!wide || tab === "about") && (
          <section aria-label="Team">
            <SectionTitle>Team</SectionTitle>
            <Group>
              <Row icon={<Gauge size={18} />} title="Context and access" onClick={() => setDialog("context")} />
              {channel.joined && channel.name !== "general" && <Row icon={<LogOut size={18} />} title="Leave team" onClick={() => setDialog("leave")} />}
              {canManage && <Row icon={channel.archivedAt ? <ArchiveRestore size={18} /> : <Archive size={18} />} title={channel.archivedAt ? "Unarchive team" : "Archive team"} onClick={() => (channel.archivedAt ? void setArchived(channel, false) : setDialog("archive"))} />}
              {canManage && <Row icon={<Trash2 size={18} />} title="Delete team" danger onClick={() => setDialog("delete")} />}
            </Group>
            {!canManage && <p className="mt-2 px-1 text-xs text-muted">Guests can't change teams.</p>}
          </section>
        )}
      </div>
      {dialog === "icon" && <TeamIconDialog channel={channel} onClose={() => setDialog(null)} />}
      {dialog === "notify" && <NotifyDialog channel={channel} onClose={() => setDialog(null)} />}
      {dialog === "answers" && <AnswersDialog channel={channel} onClose={() => setDialog(null)} />}
      {dialog === "context" && <ContextAccessDialog channel={channel} members={members} onClose={() => setDialog(null)} />}
      {dialog === "leave" && (
        <Confirm title={`Leave ${channel.name}?`} body="You will stop getting its messages. You can join again from Browse teams." action="Leave team" onClose={() => setDialog(null)} onConfirm={async () => (await leaveChannel(channel), onClose())} />
      )}
      {dialog === "archive" && (
        <Confirm title={`Archive ${channel.name}?`} body="Nobody can post while it is archived. Its messages and notes stay, and you can unarchive any time." action="Archive team" onClose={() => setDialog(null)} onConfirm={() => setArchived(channel, true)} />
      )}
      {dialog === "delete" && (
        <Confirm
          title={`Delete ${channel.name}?`}
          body="The messages and threads are deleted for everyone. Notes agents saved in memory stay."
          action="Delete team"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api("DELETE", `/api/channels/${channel.id}`);
            const wasOpen = useStore.getState().activeChannel === channel.id;
            await useStore.getState().refreshChannels();
            if (wasOpen) toGeneral();
          }}
        />
      )}
    </RightPane>
  );
}

function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="h-14 rounded-2xl bg-card flex flex-col items-center justify-center gap-0.5 text-[12px] font-medium hover:bg-hover">
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}

function About({ channel, members, canManage, onSettings, onDialog }: { channel: ChannelInfo; members: ChannelMember[] | null; canManage: boolean; onSettings: (t: ChannelSettingsTab) => void; onDialog: (d: "notify" | "answers") => void }) {
  const names = useNames();
  const refresh = useStore((s) => s.refreshChannels);
  const [editing, setEditing] = useState(false);
  const [topic, setTopic] = useState(channel.topic);
  const [busy, setBusy] = useState(false);
  useEffect(() => setTopic(channel.topic), [channel.topic]);
  const team = channel.settings.team;
  const leads = (team?.nodes ?? []).filter((n) => n.lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a);
  const others = (team?.nodes ?? []).filter((n) => !n.lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a);
  const answerer = channel.settings.defaultAgentId ? names.agent(channel.settings.defaultAgentId) : undefined;
  const [building, setBuilding] = useState(false);
  const lines = useFlowLines(team ?? { nodes: [], edges: [] });
  const works = team?.nodes.length
    ? `${leads.length ? `${leads.map((a) => a.name).join(" and ")} ${leads.length > 1 ? "lead" : "leads"}.` : ""}${others.length ? ` ${others.map((a) => a.name).join(", ")} ${hasSteps(team) ? "do the steps" : "help"}.` : ""}`.trim()
    : "Nobody is on the team yet";
  return (
    <section aria-label="About">
      <SectionTitle>About</SectionTitle>
      <Group>
        {editing ? (
          <form
            className="p-3 flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("PATCH", `/api/channels/${channel.id}`, { topic });
                await refresh();
                setEditing(false);
              } catch (err) {
                alert((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input autoFocus value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} aria-label="Topic" placeholder="What's this team for?" className="h-10 min-w-0 flex-1 rounded-xl border border-control-line bg-control px-3 text-sm outline-none focus:border-ring" />
            <button disabled={busy} className="h-10 rounded-full bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => (setTopic(channel.topic), setEditing(false))} className="h-10 rounded-full px-3 text-sm text-muted">
              Cancel
            </button>
          </form>
        ) : (
          <Row title="Topic" value={channel.topic || (canManage ? "Add a topic" : "No topic")} onClick={canManage ? () => setEditing(true) : undefined} />
        )}
        <div aria-label="How the team works" className="px-4 py-3">
          <div className="flex items-center gap-2 text-body font-medium">
            <Workflow size={18} className="text-muted" aria-hidden /> How the team works
          </div>
          <div className="mt-2.5">
            {hasSteps(team) ? <HowLines lines={lines} plain /> : <p className="text-[13px] text-muted">{works}</p>}
          </div>
        </div>
        {canManage && !channel.archivedAt && <Row icon={<Pencil size={18} />} title={hasSteps(team) ? "Edit how it works" : "Set up how it works"} onClick={() => setBuilding(true)} />}
        <Row title="Notifications" value={NOTIFY[channel.notify].label} onClick={() => onDialog("notify")} />
        <Row title="Answers without an @mention" value={team?.nodes.length ? (leads.map((a) => a.name).join(" and ") || "The team") : (answerer?.name ?? "Nobody (@mention an agent)")} onClick={canManage && !team?.nodes.length && !channel.archivedAt ? () => onDialog("answers") : undefined} />
      </Group>
      <MoreOptions className="mt-3">
        <div className="space-y-6 rounded-3xl bg-card p-4">
          <AboutChannel channel={channel} canManage={canManage} onClose={() => {}} />
          <ChannelAgents channel={channel} canManage={canManage && !channel.archivedAt} onClose={() => {}} />
        </div>
      </MoreOptions>
      {members === null && <span className="sr-only">Loading members</span>}
      {building && <TeamEditSession channel={channel} onClose={() => setBuilding(false)} />}
    </section>
  );
}

function Agents({ channel, members, canManage, onSettings }: { channel: ChannelInfo; members: ChannelMember[] | null; canManage: boolean; onSettings: (t: ChannelSettingsTab) => void }) {
  const names = useNames();
  const agents = (members ?? []).filter((m) => m.kind === "agent");
  const nodes = channel.settings.team?.nodes ?? [];
  return (
    <section aria-label="Agents">
      <SectionTitle>Agents</SectionTitle>
      <Group>
        {agents.map((m) => {
          const agent = names.agent(m.id);
          const node = nodes.find((n) => n.agentId === m.id);
          const lead = !!node?.lead;
          return (
            <button key={m.id} onClick={() => go({ view: "agents", agentId: m.id, tab: "overview" })} className="flex w-full items-center gap-3 px-4 py-2.5 min-h-[56px] text-left hover:bg-hover">
              <AgentAvatar agent={agent} size={32} interactive={false} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{m.name}</span>
                <span className="block truncate text-[13px] text-muted">{node?.role ?? (agent?.status === "offline" ? "Offline" : "Works here")}</span>
              </span>
              {lead && <span className="shrink-0 text-[12px] font-medium text-muted">Leads</span>}
              {agent && <StatusDot status={agent.status} />}
              <ChevronRight size={16} className="shrink-0 text-faint" />
            </button>
          );
        })}
        {!agents.length && members && <div className="px-4 py-3 text-sm text-muted">No agents here yet.</div>}
        {canManage && !channel.archivedAt && <Row icon={<Plus size={18} />} title="Add agent" onClick={() => onSettings("team")} />}
      </Group>
    </section>
  );
}

/** Notify me: Every message, Just what's for me, Mute. */
export function NotifyDialog({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const current = useStore((s) => s.channels.find((c) => c.id === channel.id)?.notify ?? channel.notify);
  return (
    <Modal title="Notify me" onClose={onClose}>
      <div role="radiogroup" aria-label="Notify me" className="overflow-hidden rounded-3xl bg-card divide-y divide-line">
        {(Object.keys(NOTIFY) as (keyof typeof NOTIFY)[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={current === k}
            onClick={() => {
              void setChannelPrefs(channel, { notify: k });
              onClose();
            }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">{k === "all" ? "Every message" : k === "default" ? "Just what's for me" : "Mute"}</span>
              <span className="block text-[13px] text-muted">{k === "all" ? "Notify me about all of it" : k === "default" ? "Replies, @mentions and approvals" : "No notifications from this team"}</span>
            </span>
            {current === k && <Check size={17} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function AnswersDialog({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const refresh = useStore((s) => s.refreshChannels);
  const [value, setValue] = useState<string | null>(channel.settings.defaultAgentId);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Answers without an @mention" onClose={onClose}>
      <p className="mb-3 text-sm text-muted">The agent that answers a message nobody @mentions. It joins the team to do it.</p>
      <AnswerSelect agents={agents} value={value} onChange={setValue} />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="h-11 rounded-full border border-control-line bg-control px-5 text-body font-medium">
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("PATCH", `/api/channels/${channel.id}`, { settings: { ...channel.settings, defaultAgentId: value } });
              await refresh();
              onClose();
            } catch (e) {
              alert((e as Error).message);
              setBusy(false);
            }
          }}
          className="h-11 rounded-full bg-accent px-5 text-body font-medium text-accent-ink disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

interface AgentCtx {
  model: string | null;
  effort: string | null;
  access: AccessLevel;
  contextUsed: number | null;
  contextWindow: number | null;
}
const ACCESS_LABEL: Record<AccessLevel, string> = { "read-only": "Read only", edit: "Can edit files", full: "Full access" };

/** How full the conversation is, and what each agent can do here. */
function ContextAccessDialog({ channel, members, onClose }: { channel: ChannelInfo; members: ChannelMember[] | null; onClose: () => void }) {
  const names = useNames();
  const [ctx, setCtx] = useState<Record<string, AgentCtx>>({});
  const agents = (members ?? []).filter((m) => m.kind === "agent");
  useEffect(() => {
    for (const m of agents) api<AgentCtx>("GET", `/api/agents/${m.id}/context?channel=${channel.id}`).then((c) => setCtx((cur) => ({ ...cur, [m.id]: c })), () => {});
  }, [channel.id, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const pcts = Object.values(ctx).flatMap((c) => (c.contextUsed !== null && c.contextWindow ? [Math.min(100, (c.contextUsed / c.contextWindow) * 100)] : []));
  const pct = pcts.length ? Math.max(...pcts) : null;
  const color = pct === null ? "var(--faint)" : pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--ok)";
  return (
    <Modal title="Context and access" onClose={onClose}>
      <SectionTitle>How full is the conversation</SectionTitle>
      <div className="rounded-3xl bg-card p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-body font-medium">Context window</span>
          <span className="text-body font-medium tabular-nums" style={{ color }}>
            {pct === null ? "–" : `${pct < 1 ? "<1" : Math.round(pct)}%`}
          </span>
        </div>
        {pct !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chip">
            <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
          </div>
        )}
        <p className="mt-2 text-[13px] text-muted">Older messages are summarized as it fills up. Shows after each agent's first reply here.</p>
      </div>
      <div className="mt-5" />
      <SectionTitle>What each agent can do here</SectionTitle>
      <Group>
        {agents.map((m) => {
          const c = ctx[m.id];
          const agent = names.agent(m.id);
          return (
            <button
              key={m.id}
              onClick={() => (onClose(), go({ view: "agents", agentId: m.id, tab: "overview" }))}
              className="flex w-full items-center gap-3 px-4 py-2.5 min-h-[56px] text-left hover:bg-hover"
            >
              <AgentAvatar agent={agent} size={32} interactive={false} />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{m.name}</span>
                <span className="block truncate text-[13px] text-muted">{c ? `${c.model ? prettyModel(c.model) : "Automatic"}${c.effort ? ` · ${effortName(c.effort)}` : ""}` : "…"}</span>
              </span>
              <span className="shrink-0 text-[13px] text-muted">{c ? ACCESS_LABEL[c.access] : ""}</span>
              <ChevronRight size={16} className="shrink-0 text-faint" />
            </button>
          );
        })}
        {!agents.length && <div className="px-4 py-3 text-sm text-muted">No agents here yet.</div>}
      </Group>
      <p className="mt-2 px-1 text-xs text-muted">Access is for its computer: Read only, Can edit files, or Full access. Tap an agent to change its model too.</p>
    </Modal>
  );
}

function Confirm({ title, body, action, danger, onClose, onConfirm }: { title: string; body: string; action: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<unknown> | unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-muted">{body}</p>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-4 flex flex-col gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
          className={cx("h-12 rounded-full px-5 text-body font-medium disabled:opacity-50", danger ? "bg-bad text-white" : "bg-accent text-accent-ink")}
        >
          {action}
        </button>
        <button onClick={onClose} className="h-12 rounded-full border border-control-line bg-control px-5 text-body font-medium">
          Cancel
        </button>
      </div>
    </Modal>
  );
}
