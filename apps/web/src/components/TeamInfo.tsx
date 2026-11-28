import { noChartLine, agentRulesOf } from "./channel-rules.ts";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, PenLine, Play, Plus, X } from "lucide-react";
import { hasSteps, workSteps, type AccessLevel, type Agent, type ChannelNotify, type ChannelTeam } from "@bubble-ai/core";
import { api } from "../api.ts";
import { go, href } from "../router.ts";
import { useNames, useStore, type ChannelInfo } from "../store.ts";
import { ChannelMembers, ChannelPins, NOTIFY, PlainChartDialog, isProtected, leaveChannel, setArchived, setChannelPrefs, toGeneral, type ChannelMember, type ChannelSettingsTab } from "./Channels.tsx";
import { ChatAvatar } from "./ChatList.tsx";
import { TeamIconDialog } from "./TeamIcon.tsx";
import { AgentAvatar, Button, Modal, cx } from "./ui.tsx";
import { prettyModel, effortName } from "./EffortSlider.tsx";
import { Toggle } from "../views/settings/parts.tsx";
import { HowLines, linesText, useFlowLines } from "../team/How.tsx";
import { nextText, whenText } from "../team/ScheduleForm.tsx";
import { TeamEditSession } from "../team/SessionLazy.tsx";
import { lazyView } from "../lazy.tsx";
import { teamAgentIds } from "../team/flow.ts";
import { copyText } from "../clipboard.ts";

// the builder's file, fetched only when a team is saved as a template
const SaveTemplate = lazyView(() => import("../team/Builder.tsx").then((m) => m.SaveTemplate));

/** The tabs the old info page had. The chat still asks for one by name; each now opens a sheet of the panel. */
export type InfoTab = "about" | "agents" | "members" | "pins";

/** What the panel shows: the team itself ("details"), or the sheet one of its rows opens. */
export type TeamSheet = "details" | "who" | "how" | "schedule" | "knows" | "more" | "rules" | "pins";
const SHEETS: Record<Exclude<TeamSheet, "details">, string> = { who: "Who's on it", how: "How it works", schedule: "Schedule", knows: "Memory", more: "More", rules: "Team rules", pins: "Pinned messages" };
const SHEET_OF_TAB: Record<InfoTab, TeamSheet> = { about: "details", agents: "who", members: "who", pins: "pins" };
/** A sheet opened from More goes back to More. */
const parentOf = (s: TeamSheet): TeamSheet => (s === "rules" || s === "pins" ? "more" : "details");

const CARD = "overflow-hidden rounded-[12px] bg-card divide-y divide-line";
const ROW = "flex min-h-[46px] w-full items-center gap-3 px-3.5 text-left text-[14px] hover:bg-hover disabled:hover:bg-transparent";
const NO_TEAM: ChannelTeam = { nodes: [], edges: [] };

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

/** "3 agents, 1 person". */
export function teamCount(channel: ChannelInfo, members: ChannelMember[] | null): string {
  if (!members) return `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`;
  const a = members.filter((m) => m.kind === "agent").length;
  const p = members.length - a;
  return [a ? `${a} ${a === 1 ? "agent" : "agents"}` : "", p ? `${p} ${p === 1 ? "person" : "people"}` : ""].filter(Boolean).join(", ") || "No one yet";
}

/** "wisp" from "git@github.com:you/wisp.git" or a path. */
export const repoName = (repo: string): string => repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || repo;

/** What the Schedule row says: when the team runs by itself. */
export function scheduleLine(team: Pick<ChannelTeam, "steps"> | null | undefined): string {
  const all = (team?.steps ?? []).filter((s) => s.kind === "schedule");
  if (!all.length) return "None";
  const on = all.filter((s) => s.enabled !== false);
  if (!on.length) return "Off";
  return `${whenText(on[0])}${on.length > 1 ? ` +${on.length - 1}` : ""}`;
}

/** What the Knows row says: its notes folder and its repo, by name. */
export function knowsLine(team: Pick<ChannelTeam, "folder" | "repo"> | null | undefined): string {
  return [team?.folder ? "Notes" : "", team?.repo ? `${repoName(team.repo)} repo` : ""].filter(Boolean).join(", ") || "Nothing yet";
}

async function patchChannel(channel: ChannelInfo, body: Record<string, unknown>) {
  await api("PATCH", `/api/channels/${channel.id}`, body);
  await useStore.getState().refreshChannels();
}

/**
 * A team in the pane beside its chat: 310 px, pushing the chat, the same slot and look as an
 * agent's panel. Its ghosts (click to set an image), name and one line of what it is for, then
 * one card of rows: Who's on it, How it works, Schedule, Knows, More. Each opens a sheet in place.
 */
export function TeamInfo({ channel, tab, onClose }: { channel: ChannelInfo; tab: InfoTab; onTab: (t: InfoTab) => void; onClose: () => void; onSettings: (t: ChannelSettingsTab) => void }) {
  return (
    <aside aria-label={`${channel.name} info`} className="m-details fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-panel safe-top lg:relative lg:inset-auto lg:z-auto lg:w-[310px] lg:shrink-0 lg:border-l lg:border-line">
      {/* its own 310 px, so nothing reflows while the pane opens */}
      <div className="flex min-h-0 flex-1 flex-col lg:w-[310px]">
        <TeamPanel channel={channel} sheet={SHEET_OF_TAB[tab] ?? "details"} onClose={onClose} />
      </div>
    </aside>
  );
}

/** The panel's header and sheets, without the pane around them (the chat's side pane and the settings sheet both hold one). */
export function TeamPanel({ channel, sheet: initial = "details", onClose }: { channel: ChannelInfo; sheet?: TeamSheet; onClose: () => void }) {
  const [sheet, setSheet] = useState<TeamSheet>(initial);
  useEffect(() => setSheet(initial), [initial]);
  const members = useChannelMembers(channel);
  const names = useNames();
  const role = useStore((s) => s.me?.role);
  const canManage = role === "owner" || role === "member";
  const canEdit = canManage && !channel.archivedAt;
  const [icon, setIcon] = useState(false);
  // "Rename" in More goes back to the top with the name being edited
  const [renaming, setRenaming] = useState(false);
  const team = channel.settings.team;
  const stepped = hasSteps(team);
  const steps = stepped ? workSteps(team?.steps ?? []).length : 0;
  const leadId = team?.nodes.find((n) => n.lead)?.agentId ?? (team ? teamAgentIds(team)[0] : undefined) ?? channel.settings.defaultAgentId;
  const lead = leadId ? names.agent(leadId) : undefined;
  const agentNames = (members ?? []).filter((m) => m.kind === "agent").map((m) => m.name);
  const back = () => setSheet(parentOf(sheet));

  return (
    <>
      <div className="relative flex h-14 shrink-0 items-center justify-between px-3">
        {sheet === "details" ? (
          <span />
        ) : (
          <button type="button" onClick={back} className="circle circle-sm" aria-label={`Back to ${sheet === "rules" || sheet === "pins" ? "More" : channel.name}`}>
            <ChevronLeft size={18} />
          </button>
        )}
        {sheet !== "details" && <h2 className="pointer-events-none absolute inset-x-12 truncate text-center text-[14px] font-semibold">{SHEETS[sheet]}</h2>}
        <button type="button" onClick={onClose} className="circle circle-sm" aria-label="Close panel">
          <X size={16} />
        </button>
      </div>
      <div key={sheet} className={cx("min-h-0 flex-1 overflow-y-auto px-3.5 pb-6", sheet !== "details" && "m-panel")}>
        {sheet === "details" && (
          <>
            <div className="flex flex-col items-center gap-1 pb-4 text-center">
              {canEdit ? (
                <button type="button" onClick={() => setIcon(true)} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Team picture. Click to set an image">
                  <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={64} />
                </button>
              ) : (
                <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={64} />
              )}
              <NameLabel channel={channel} canEdit={canEdit} rename={renaming} onRenameStarted={() => setRenaming(false)} />
              <div className="max-w-full [&_input]:text-center">
                <TopicLabel channel={channel} canEdit={canEdit} />
              </div>
              {channel.archivedAt && <span className="text-[12px] text-muted">Archived</span>}
            </div>
            <div className={cx(CARD, "m-details-cards")}>
              <PanelRow label="Who's on it" value={agentNames.length ? agentNames.join(", ") : teamCount(channel, members)} onClick={() => setSheet("who")} />
              <PanelRow label="How it works" value={stepped ? `${steps} ${steps === 1 ? "step" : "steps"}` : team?.nodes.length ? "Lead and helpers" : "No steps"} onClick={() => setSheet("how")} />
              <PanelRow label="Schedule" value={scheduleLine(team)} onClick={() => setSheet("schedule")} />
              <PanelRow label="Memory" value={knowsLine(team)} onClick={() => setSheet("knows")} />
              <PanelRow label="More" onClick={() => setSheet("more")} />
            </div>
            {lead && <p className="m-details-cards px-1 pt-3 text-[13px] leading-5 text-muted">Or ask {lead.name} to change any of it.</p>}
          </>
        )}
        {sheet === "who" && <ChannelMembers channel={channel} canManage={canManage} onClose={onClose} />}
        {sheet === "how" && <HowSheet channel={channel} canEdit={canEdit} agentCount={agentNames.length} />}
        {sheet === "schedule" && <ScheduleSheet channel={channel} canEdit={canEdit} />}
        {sheet === "knows" && <KnowsSheet channel={channel} canEdit={canEdit} />}
        {sheet === "more" && <MoreSheet channel={channel} members={members} canManage={canManage} onSheet={setSheet} onClose={onClose} onRename={() => (setRenaming(true), setSheet("details"))} />}
        {sheet === "rules" && <RulesSheet channel={channel} canEdit={canEdit} />}
        {sheet === "pins" && <ChannelPins channel={channel} onClose={onClose} />}
      </div>
      {icon && <TeamIconDialog channel={channel} onClose={() => setIcon(false)} />}
    </>
  );
}

/** One row of the panel: its label, the current value, a chevron (or another icon at the end, for an action). */
function PanelRow({ label, value, onClick, danger, end }: { label: string; value?: ReactNode; onClick?: () => void; danger?: boolean; end?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={ROW}>
      <span className={cx("shrink-0 font-medium", danger && "text-bad")}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[13px] text-muted">{value}</span>
      {end ?? (!danger && <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />)}
    </button>
  );
}

/** A row whose value is picked from a list: the row shows it, a native select (so keyboards and screen readers work) sits over it. */
function PickRow({ label, value, shown, options, onPick, disabled }: { label: string; value: string; shown: string; options: { value: string; label: string }[]; onPick: (v: string) => void; disabled?: boolean }) {
  return (
    <label className={cx(ROW, "relative", disabled && "hover:bg-transparent")}>
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[13px] text-muted">{shown}</span>
      {!disabled && <ChevronRight size={15} className="shrink-0 text-faint" aria-hidden />}
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A row with a switch at the end. */
function SwitchRow({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex min-h-[46px] items-center gap-3 px-3.5 text-[14px]">
      <span className="min-w-0 flex-1 font-medium">{label}</span>
      <Toggle on={on} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** The team's name with a faint pencil after it; click it (or Rename in More) to rename the team. */
function NameLabel({ channel, canEdit, rename, onRenameStarted }: { channel: ChannelInfo; canEdit: boolean; rename?: boolean; onRenameStarted?: () => void }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (rename) (setEditing(true), onRenameStarted?.());
  }, [rename, onRenameStarted]);
  const [value, setValue] = useState(channel.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(channel.name), [channel.name]);
  const save = async () => {
    const name = value.trim();
    setEditing(false);
    if (!name || name === channel.name) return setValue(channel.name);
    try {
      await patchChannel(channel, { name });
      setError(null);
    } catch (e) {
      setValue(channel.name);
      setError((e as Error).message);
    }
  };
  const cls = "mt-2 max-w-full truncate text-[19px] font-semibold leading-[26px]";
  if (!canEdit || isProtected(channel)) return <h2 className={cls}>{channel.name}</h2>;
  return (
    <>
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => (e.key === "Enter" ? (e.currentTarget as HTMLInputElement).blur() : e.key === "Escape" && (e.stopPropagation(), setValue(channel.name), setEditing(false)))}
          maxLength={80}
          aria-label="Team name"
          className={cx(cls, "w-56 rounded-[10px] bg-transparent px-2 text-center outline-none shadow-[inset_0_0_0_1.5px_var(--ink)]")}
        />
      ) : (
        <h2 className={cls}>
          <button type="button" onClick={() => setEditing(true)} title="Rename" aria-label={`${channel.name}. Rename`} className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 hover:bg-hover">
            <span className="truncate">{channel.name}</span>
            <PenLine size={15} strokeWidth={1.8} className="shrink-0 text-faint" aria-hidden />
          </button>
        </h2>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </>
  );
}

/** What the team is for, in one line, edited in place. */
function TopicLabel({ channel, canEdit }: { channel: ChannelInfo; canEdit: boolean }) {
  const [value, setValue] = useState(channel.topic);
  useEffect(() => setValue(channel.topic), [channel.id, channel.topic]);
  const save = async () => {
    const topic = value.trim();
    if (topic === channel.topic) return;
    await patchChannel(channel, { topic }).catch(() => setValue(channel.topic));
  };
  if (!canEdit) return channel.topic ? <div className="text-sm text-muted">{channel.topic}</div> : null;
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      placeholder="What it is for"
      aria-label="What it is for"
      maxLength={250}
      className="h-6 w-64 max-w-full rounded-md bg-transparent px-1.5 text-sm text-muted outline-none placeholder:text-faint hover:bg-hover focus:bg-hover focus:text-ink"
    />
  );
}

/** How the team works: its steps as plain numbered sentences, and the way into the builder. */
function HowSheet({ channel, canEdit, agentCount }: { channel: ChannelInfo; canEdit: boolean; agentCount: number }) {
  const names = useNames();
  const team = channel.settings.team;
  const stepped = hasSteps(team);
  const lines = useFlowLines(team ?? NO_TEAM);
  const [open, setOpen] = useState<null | "builder" | "chart" | "template">(null);
  const [copied, setCopied] = useState(false);
  const named = (lead: boolean) => (team?.nodes ?? []).filter((n) => !!n.lead === lead).map((n) => names.agent(n.agentId)).filter((a): a is Agent => !!a).map((a) => a.name);
  const leads = named(true);
  const others = named(false);
  const works = team?.nodes.length ? [leads.length ? `${leads.join(" and ")} ${leads.length > 1 ? "lead" : "leads"}.` : "", others.length ? `${others.join(", ")} ${others.length > 1 ? "help" : "helps"}.` : ""].filter(Boolean).join(" ") : noChartLine(agentCount);
  const copy = async () => {
    try {
      await copyText(linesText(lines));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the browser said no */
    }
  };
  const TEXT = "min-h-8 text-[13px] text-muted hover:text-ink";
  return (
    <div className="space-y-3">
      {stepped ? (
        <div className="rounded-[12px] bg-card p-3.5">
          <HowLines lines={lines} />
        </div>
      ) : (
        <p className="px-1 text-[13px] leading-5 text-muted">{works}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-0.5">
        {canEdit && (
          <Button variant="primary" onClick={() => setOpen("builder")}>
            Edit steps
          </Button>
        )}
        {canEdit && stepped && (
          <button type="button" onClick={() => setOpen("template")} className={TEXT}>
            Save as template
          </button>
        )}
        {canEdit && !stepped && (
          <button type="button" onClick={() => setOpen("chart")} className={TEXT}>
            Edit chart
          </button>
        )}
        {stepped && (
          <button type="button" onClick={() => void copy()} className={TEXT}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open === "builder" && <TeamEditSession channel={channel} onClose={() => setOpen(null)} />}
      {open === "chart" && <PlainChartDialog channel={channel} onClose={() => setOpen(null)} />}
      {open === "template" && (
        <Suspense fallback={null}>
          <SaveTemplate channelId={channel.id} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** When the team runs by itself: each schedule on its chart, Run now, and adding one (in the builder, where its arrows are drawn). */
function ScheduleSheet({ channel, canEdit }: { channel: ChannelInfo; canEdit: boolean }) {
  const schedules = (channel.settings.team?.steps ?? []).filter((s) => s.kind === "schedule");
  const [edit, setEdit] = useState<null | { select: string } | { add: true }>(null);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const runNow = async (id: string) => {
    setRunning(id);
    setNote(null);
    try {
      await api("POST", `/api/channels/${channel.id}/schedules/${id}/run`);
      setNote({ id, text: "Started" });
    } catch (e) {
      setNote({ id, text: (e as Error).message });
    } finally {
      setRunning(null);
    }
  };
  return (
    <div className="space-y-3">
      {schedules.length > 0 ? (
        <div className={CARD}>
          {schedules.map((s) => (
            <div key={s.id} className="flex min-h-[50px] items-center gap-1 pr-2">
              <button type="button" disabled={!canEdit} onClick={() => setEdit({ select: s.id })} className="min-w-0 flex-1 px-3.5 py-2 text-left">
                <span className="block truncate text-[14px] font-medium">{whenText(s)}</span>
                <span className="block truncate text-[12px] text-muted">{note?.id === s.id ? note.text : nextText(s)}</span>
              </button>
              {canEdit && (
                <button type="button" disabled={running === s.id} onClick={() => void runNow(s.id)} aria-label={`Run now: ${whenText(s)}`} title="Run now" className="grid size-8 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40">
                  <Play size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="px-1 text-[13px] text-muted">None</p>
      )}
      {canEdit && (
        <div className={CARD}>
          <button type="button" onClick={() => setEdit({ add: true })} className={ROW}>
            <Plus size={16} className="shrink-0 text-muted" aria-hidden />
            <span className="font-medium">Add schedule</span>
          </button>
        </div>
      )}
      {edit && <TeamEditSession channel={channel} select={"select" in edit ? edit.select : null} add={"add" in edit ? "schedule" : null} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** A labelled field in a card: saved when you leave it. */
function FieldRow({ label, value, placeholder, disabled, onSave, trailing, maxLength }: { label: string; value: string; placeholder?: string; disabled?: boolean; onSave: (v: string) => Promise<unknown>; trailing?: ReactNode; maxLength?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex items-center gap-2 px-3.5 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-muted">{label}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() !== value && void onSave(text.trim()).catch(() => setText(value))}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          className="block h-6 w-full bg-transparent text-[14px] outline-none placeholder:text-faint disabled:opacity-60"
        />
      </span>
      {trailing}
    </label>
  );
}

/** What the team knows: the memory folder everyone on it reads and writes, and its code (repo and base branch). */
function KnowsSheet({ channel, canEdit }: { channel: ChannelInfo; canEdit: boolean }) {
  const team = channel.settings.team;
  // these live on the team's chart, so a team has to have one first
  const can = canEdit && !!team?.nodes.length;
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<ChannelTeam>) => {
    setError(null);
    try {
      await patchChannel(channel, { settings: { team: { ...team, ...patch } } });
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };
  const folder = team?.folder ?? "";
  return (
    <div className="space-y-3">
      <div className={CARD}>
        <FieldRow
          label="Memory folder"
          value={folder}
          placeholder="teams/web"
          maxLength={200}
          disabled={!can}
          onSave={(v) => save({ folder: v })}
          trailing={
            folder ? (
              <a href={href({ view: "vault", path: `${folder}/README.md` })} className="shrink-0 text-[13px] font-medium text-ink hover:underline">
                Open
              </a>
            ) : undefined
          }
        />
        <FieldRow label="Repo" value={team?.repo ?? ""} placeholder="git@github.com:you/app.git" maxLength={500} disabled={!can} onSave={(v) => save({ repo: v || null })} />
        <FieldRow label="Branch" value={team?.baseBranch ?? ""} placeholder="main" maxLength={100} disabled={!can} onSave={(v) => save({ baseBranch: v })} />
      </div>
      {canEdit && !team?.nodes.length && <p className="px-1 text-[13px] text-muted">Add steps first.</p>}
      {error && <p className="px-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

/** Notes every agent reads when it works in this team. */
function RulesSheet({ channel, canEdit }: { channel: ChannelInfo; canEdit: boolean }) {
  const saved = channel.settings.instructions ?? "";
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(saved), [saved]);
  const save = async () => {
    if (text === saved) return;
    setError(null);
    try {
      await patchChannel(channel, { settings: agentRulesOf({ ...agentRulesOf(channel.settings), instructions: text }) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        disabled={!canEdit}
        rows={10}
        maxLength={4000}
        aria-label="Team rules"
        placeholder="Keep answers short. Link the doc in shared/launch.md."
        className="block w-full resize-none rounded-[12px] bg-card p-3.5 text-[14px] leading-[22px] outline-none placeholder:text-faint focus:ring-1 focus:ring-ring disabled:opacity-60"
      />
      {error && <p className="px-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

/** The rest of a team: its rules, who answers, pins, who it reports to, what it tells you, and archiving, leaving or deleting it. */
function MoreSheet({ channel, members, canManage, onSheet, onClose, onRename }: { channel: ChannelInfo; members: ChannelMember[] | null; canManage: boolean; onSheet: (s: TeamSheet) => void; onClose: () => void; onRename: () => void }) {
  const names = useNames();
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.channels.find((c) => c.id === channel.id)?.notify ?? channel.notify);
  const canEdit = canManage && !channel.archivedAt;
  const team = channel.settings.team;
  const [dialog, setDialog] = useState<null | "context" | "leave" | "archive" | "delete">(null);
  const [error, setError] = useState<string | null>(null);
  const run = (work: Promise<unknown>) => {
    setError(null);
    work.catch((e) => setError((e as Error).message));
  };
  const rules = agentRulesOf(channel.settings);
  const saveRules = (patch: Partial<typeof rules>) => run(patchChannel(channel, { settings: agentRulesOf({ ...rules, ...patch }) }));
  const answerer = rules.defaultAgentId ? names.agent(rules.defaultAgentId) : undefined;
  const onTeam = new Set((team?.nodes ?? []).map((n) => n.agentId));
  const reportsTo = team?.reportsTo ? names.agent(team.reportsTo) : undefined;
  return (
    <div className="space-y-3">
      {/* how the team works */}
      <div className={CARD}>
        <PanelRow label="Team rules" value={rules.instructions.trim() ? rules.instructions.trim().split("\n")[0] : "None"} onClick={() => onSheet("rules")} />
        {/* a team with a flow chart answers through its leads (How it works shows them); without one, pick who answers */}
        {!team?.nodes.length && (
          <PickRow
            label="Answers"
            value={rules.defaultAgentId ?? ""}
            shown={answerer?.name ?? "Nobody"}
            disabled={!canEdit}
            options={[{ value: "", label: "Nobody: only agents someone @mentions" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
            onPick={(v) => saveRules({ defaultAgentId: v || null })}
          />
        )}
        {!!team?.nodes.length && (
          <PickRow
            label="Reports to"
            value={team.reportsTo ?? ""}
            shown={reportsTo?.name ?? "Nobody"}
            disabled={!canEdit}
            options={[{ value: "", label: "Nobody" }, ...agents.filter((a) => !onTeam.has(a.id) || a.id === team.reportsTo).map((a) => ({ value: a.id, label: a.name }))]}
            onPick={(v) => run(patchChannel(channel, { settings: { team: { ...team, reportsTo: v || null } } }))}
          />
        )}
        <SwitchRow label="Reply in thread" on={rules.replyInThread} disabled={!canEdit} onChange={(replyInThread) => saveRules({ replyInThread })} />
        {!isProtected(channel) && <SwitchRow label="Private" on={channel.private} disabled={!canManage} onChange={(isPrivate) => run(patchChannel(channel, { private: isPrivate }))} />}
      </div>
      {/* you and this chat (its section is set from the sidebar's row menu) */}
      <div className={CARD}>
        <PickRow label="Notify me" value={notify} shown={NOTIFY[notify].label} options={(Object.keys(NOTIFY) as ChannelNotify[]).map((k) => ({ value: k, label: NOTIFY[k].label }))} onPick={(v) => void setChannelPrefs(channel, { notify: v as ChannelNotify })} />
        <PanelRow label="Pinned messages" value={channel.pinnedIds.length ? String(channel.pinnedIds.length) : "None"} onClick={() => onSheet("pins")} />
        <PanelRow label="Context and access" onClick={() => setDialog("context")} />
      </div>
      <div className={CARD}>
        {canEdit && !isProtected(channel) && <PanelRow label="Rename" onClick={onRename} end={<PenLine size={15} strokeWidth={1.8} className="shrink-0 text-faint" aria-hidden />} />}
        {canManage && <PanelRow label={channel.archivedAt ? "Unarchive" : "Archive"} onClick={() => (channel.archivedAt ? run(setArchived(channel, false)) : setDialog("archive"))} />}
        {channel.joined && channel.name !== "general" && <PanelRow label="Leave" onClick={() => setDialog("leave")} />}
        {canManage && <PanelRow danger label="Delete" onClick={() => setDialog("delete")} />}
      </div>
      {error && <p className="px-1 text-xs text-bad">{error}</p>}
      {dialog === "context" && <ContextAccessDialog channel={channel} members={members} onClose={() => setDialog(null)} />}
      {dialog === "leave" && <Confirm title={`Leave ${channel.name}?`} body="You stop getting its messages." action="Leave" onClose={() => setDialog(null)} onConfirm={async () => (await leaveChannel(channel), onClose())} />}
      {dialog === "archive" && <Confirm title={`Archive ${channel.name}?`} body="Nobody can post until it is unarchived. Nothing is deleted." action="Archive" onClose={() => setDialog(null)} onConfirm={() => setArchived(channel, true)} />}
      {dialog === "delete" && (
        <Confirm
          title={`Delete ${channel.name}?`}
          body="Its messages and threads are deleted for everyone. This can't be undone."
          action="Delete"
          danger
          typed={channel.name}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api("DELETE", `/api/channels/${channel.id}`);
            const wasOpen = useStore.getState().activeChannel === channel.id;
            await useStore.getState().refreshChannels();
            onClose();
            if (wasOpen) toGeneral();
          }}
        />
      )}
    </div>
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
      <div className="rounded-[12px] bg-card p-4">
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
      </div>
      <div className={cx(CARD, "mt-3")}>
        {agents.map((m) => {
          const c = ctx[m.id];
          const agent = names.agent(m.id);
          return (
            <button key={m.id} onClick={() => (onClose(), go({ view: "agents", agentId: m.id, tab: "overview" }))} className="flex w-full items-center gap-3 px-4 py-2.5 min-h-[56px] text-left hover:bg-hover">
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
        {!agents.length && <div className="px-4 py-3 text-sm text-muted">No agents here yet</div>}
      </div>
    </Modal>
  );
}

/** Are you sure? `typed`: the name to type first (deleting a team takes its messages with it). */
function Confirm({ title, body, action, danger, typed, onClose, onConfirm }: { title: string; body: string; action: string; danger?: boolean; typed?: string; onClose: () => void; onConfirm: () => Promise<unknown> | unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-muted">{body}</p>
      {typed && <input value={text} onChange={(e) => setText(e.target.value)} placeholder={typed} aria-label={`Type ${typed} to confirm`} autoComplete="off" className="mt-3 h-11 w-full rounded-[12px] border border-line bg-card px-3.5 text-body outline-none placeholder:text-faint focus:border-ring" />}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <button
          type="button"
          disabled={busy || (!!typed && text !== typed)}
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
          className={cx("h-9 rounded-[8px] px-4 text-sm font-semibold disabled:opacity-50", danger ? "bg-bad text-white" : "bg-accent text-accent-ink")}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
