import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, Bell, BellOff, Bot, Check, Hash, Lock, LogOut, MoreHorizontal, Pencil, Pin, Plus, Search, Star, Trash2, UserPlus, Users, X } from "lucide-react";
import { teamProblem, type Agent, type ChannelNotify, type ChannelSettings as AgentRules, type ChannelTeam, type Section } from "@warren/core";
import { CreateAgent } from "../views/CreateAgent.tsx";
import { useDevices } from "../devices.ts";
import { EMPTY_TEAM, TeamChart, TeamRules, addToTeam, liveTeam } from "./TeamChart.tsx";
import { api } from "../api.ts";
import { useNames, useStore, type ChannelInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { AgentAvatar, Button, Field, Input, Menu, Modal, Textarea, UserAvatar, cx } from "./ui.tsx";
import { Toggle } from "../views/settings/parts.tsx";

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** A channel's icon: a lock for a private one, a hash otherwise. */
export function ChannelIcon({ channel, size = 14, className = "text-faint" }: { channel: Pick<ChannelInfo, "private">; size?: number; className?: string }) {
  return channel.private ? <Lock size={size} className={className} aria-label="Private" /> : <Hash size={size} className={className} />;
}

/** #general stays public and can't be archived or deleted. */
export function isProtected(channel: ChannelInfo) {
  return channel.name === "general";
}

/** Your own settings for a channel: how much it tells you, and whether it's starred. */
export async function setChannelPrefs(channel: ChannelInfo, patch: { notify?: ChannelNotify; starred?: boolean }) {
  const before = useStore.getState().channels.find((c) => c.id === channel.id) ?? channel;
  // show it straight away; the list refresh confirms it
  useStore.setState((s) => ({ channels: s.channels.map((c) => (c.id === channel.id ? { ...c, ...patch, ...(patch.notify === "mute" ? { unread: 0 } : {}) } : c)) }));
  try {
    await api("PUT", `/api/channels/${channel.id}/prefs`, patch);
  } catch (e) {
    useStore.setState((s) => ({ channels: s.channels.map((c) => c.id === channel.id ? {
      ...c,
      ...(patch.starred !== undefined && c.starred === patch.starred ? { starred: before.starred } : {}),
      ...(patch.notify !== undefined && c.notify === patch.notify ? { notify: before.notify, ...(patch.notify === "mute" && c.unread === 0 ? { unread: before.unread } : {}) } : {}),
    } : c) }));
    alert((e as Error).message);
    return;
  }
  await useStore.getState().refreshChannels();
}

export async function setArchived(channel: ChannelInfo, archived: boolean) {
  await api("POST", `/api/channels/${channel.id}/archive`, { archived });
  await useStore.getState().refreshChannels();
}

export const NOTIFY: Record<ChannelNotify, { label: string; body: string }> = {
  all: { label: "Every message", body: "Get a notification whenever an agent posts here." },
  default: { label: "Just what's for me", body: "Answers to what you asked, and agents asking for your OK." },
  mute: { label: "Mute", body: "No unread badge and no notifications. Agents asking for your OK still reach you." },
};

/** "Who answers messages without an @mention?": one agent, or nobody (only @mentioned agents). */
function AnswerSelect({ agents, value, onChange, disabled }: { agents: Agent[]; value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm" aria-label="Who answers messages without an @mention">
      <option value="">Nobody: only agents someone @mentions</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} (@{a.handle})
        </option>
      ))}
    </select>
  );
}

/** The New agent dialog for a team being built: it hands the agent back instead of opening its page. */
export function NewAgentForTeam({ onClose, onCreated }: { onClose: () => void; onCreated: (agent: Agent) => void }) {
  const devices = useDevices(15_000);
  const refreshAgents = useStore((s) => s.refreshAgents);
  if (!devices) return null;
  return (
    <CreateAgent
      nodes={devices}
      onClose={onClose}
      onCreated={async (a) => {
        await refreshAgents();
        onCreated(a);
      }}
    />
  );
}

/** "Add a channel": one box to search, join, or create (Buzz-style). Creating is two steps: what it's for, then its team. */
export function ChannelBrowser({ onClose, sectionId = null }: { onClose: () => void; sectionId?: string | null }) {
  const channels = useStore((s) => s.channels).filter((c) => c.kind === "channel");
  const sections = useStore((s) => s.sections);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "joined" | "archived">("all");
  const [step, setStep] = useState<"browse" | "about" | "team">("browse");
  const [topic, setTopic] = useState("");
  const [section, setSection] = useState<string | null>(sectionId);
  const [isPrivate, setPrivate] = useState(false);
  const [team, setTeam] = useState<ChannelTeam>(EMPTY_TEAM);
  const [newAgent, setNewAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivedCount = channels.filter((c) => c.archivedAt).length;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    return channels
      .filter((c) => (tab === "archived" ? !!c.archivedAt : !c.archivedAt && (tab === "joined" ? c.joined : true)))
      .filter((c) => !needle || c.name.includes(needle) || c.topic.toLowerCase().includes(needle))
      .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  }, [channels, q, tab]);
  const name = slug(q.replace(/^#/, ""));
  const exists = channels.some((c) => c.name === name);
  const problem = teamProblem(team);

  async function open(id: string, joined: boolean) {
    if (!joined) await api("POST", `/api/channels/${id}/join`);
    await refreshChannels();
    onClose();
    go({ view: "chat", channelId: id, threadId: null });
  }

  async function create() {
    if (problem || busy) return;
    setError(null);
    setBusy(true);
    try {
      const ch = await api<{ id: string }>("POST", "/api/channels", { name, topic, sectionId: section, private: isPrivate, settings: { team, replyInThread: true } });
      await refreshChannels();
      onClose();
      go({ view: "chat", channelId: ch.id, threadId: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // making an agent for the team: its own dialog, then back to the chart with the agent on it
  if (newAgent)
    return (
      <NewAgentForTeam
        onClose={() => setNewAgent(false)}
        onCreated={(a) => {
          setTeam((t) => addToTeam(t, a.id));
          setNewAgent(false);
        }}
      />
    );

  if (step === "about")
    return (
      <Modal title="New channel" onClose={onClose} wide>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name && !exists) setStep("team");
          }}
        >
          <Steps at={1} />
          <Field label="Name" hint={exists ? `#${name} already exists.` : undefined}>
            <div className="relative">
              <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <Input value={name} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="e.g. launch" className="pl-8" />
            </div>
          </Field>
          <Field label="Description" hint="The agents read this too, so say what the channel is for.">
            <Textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} maxLength={250} placeholder="e.g. Plan and ship the new website" />
          </Field>
          {sections.length > 0 && (
            <Field label="Section">
              <SectionSelect sections={sections} value={section} onChange={setSection} />
            </Field>
          )}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="font-medium flex items-center gap-1.5">
                <Lock size={13} /> Private
              </span>
              <span className="block text-xs text-muted">Only people and agents you add can see it.</span>
            </span>
            <Toggle on={isPrivate} onChange={setPrivate} label="Private channel" />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setStep("browse")}>
              Back
            </Button>
            <Button variant="primary" disabled={!name || exists}>
              Next: its team <ArrowRight size={15} />
            </Button>
          </div>
        </form>
      </Modal>
    );

  if (step === "team")
    return (
      <Modal title={`#${name}: its team`} label={`The team for #${name}`} onClose={onClose} className="sm:max-w-5xl!">
        <div className="space-y-4">
          <Steps at={2} />
          <p className="text-sm text-muted">Pick who works in #{name}. Drag agents onto the chart, make one or more of them leads, and draw an arrow from each agent to whoever it hands work to.</p>
          <TeamChart team={team} onChange={setTeam} onCreateAgent={() => setNewAgent(true)} />
          <details className="rounded-xl bg-bg px-3.5 py-2.5">
            <summary className="text-sm font-medium cursor-pointer">How the team works</summary>
            <TeamRules className="mt-2" />
          </details>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStep("about")}>
              <ArrowLeft size={15} /> Back
            </Button>
            <Button variant="primary" disabled={!!problem || busy} onClick={create} title={problem ?? undefined}>
              Create #{name}
            </Button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="Add a channel" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or create a channel"
            className="pl-9 h-10"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name && !exists) setStep("about");
            }}
          />
        </div>
        <div className="flex gap-4 border-b border-line text-sm" role="tablist">
          {(["all", "joined", ...(archivedCount ? ["archived" as const] : [])] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("pb-2 -mb-px border-b-2", tab === t ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
              {t === "all" ? "All channels" : t === "joined" ? "Joined" : `Archived · ${archivedCount}`}
            </button>
          ))}
        </div>

        <button onClick={() => setStep("about")} className="w-full rounded-xl bg-bg hover:bg-hover px-4 h-12 flex items-center gap-3 text-sm font-medium">
          <span className="size-7 rounded-lg bg-panel border border-line grid place-items-center">
            <Plus size={15} />
          </span>
          {name && !exists ? `Create #${name}` : "Create a new channel"}
        </button>

        <div className="rounded-xl border border-line divide-y divide-line max-h-[50vh] overflow-y-auto">
          {list.length === 0 && <p className="px-4 py-6 text-sm text-muted text-center">No channels match.</p>}
          {list.map((c) => (
            <button key={c.id} onClick={() => open(c.id, c.joined)} className="w-full text-left px-4 py-3 hover:bg-hover flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium flex items-center gap-1">
                  <ChannelIcon channel={c} /> {c.name}
                  {c.archivedAt && <span className="ml-1 text-[11px] font-normal text-muted rounded bg-chip px-1.5">Archived</span>}
                </div>
                <div className="text-xs text-muted truncate">
                  {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  {c.topic && ` · ${c.topic}`}
                </div>
              </div>
              {c.archivedAt ? (
                <span className="text-xs text-muted">Read only</span>
              ) : c.joined ? (
                <span className="text-xs text-muted inline-flex items-center gap-1">
                  <Check size={13} /> Joined
                </span>
              ) : (
                <span className="text-xs font-medium text-accent-text">Join</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** "Step 1 of 2" for making a channel. */
function Steps({ at }: { at: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label={`Step ${at} of 2`}>
      {["Name and description", "Its team"].map((label, i) => (
        <li key={label} className={cx("flex items-center gap-2", i + 1 === at ? "text-ink font-medium" : "text-muted")}>
          {i > 0 && <span className="h-px w-6 bg-line" />}
          <span className={cx("size-5 rounded-full grid place-items-center text-[11px] font-semibold", i + 1 <= at ? "bg-ink text-panel" : "bg-chip text-muted")}>{i + 1 < at ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function SectionSelect({ sections, value, onChange }: { sections: Section[]; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
      <option value="">Channels (no section)</option>
      {sections.map((s) => (
        <option key={s.id} value={s.id}>
          {s.emoji} {s.name}
        </option>
      ))}
    </select>
  );
}

const SECTION_EMOJI = ["🐇", "🛠️", "🚀", "📣", "🎨", "🧪", "📊", "💬", "🌱", "🔒", "🤖", "⭐"];

/** Create or rename a sidebar section. */
export function SectionDialog({ section, onClose }: { section?: Section; onClose: () => void }) {
  const [name, setName] = useState(section?.name ?? "");
  const [emoji, setEmoji] = useState(section?.emoji ?? "🐇");
  const [error, setError] = useState<string | null>(null);
  const refresh = useStore((s) => s.refreshSections);
  return (
    <Modal title={section ? "Edit section" : "New section"} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (section) await api("PATCH", `/api/sections/${section.id}`, { name, emoji });
            else await api("POST", "/api/sections", { name, emoji });
            await refresh();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product" required maxLength={40} />
        </Field>
        <div>
          <div className="text-sm font-medium mb-1.5">Emoji</div>
          <div className="flex flex-wrap gap-1">
            {SECTION_EMOJI.map((x) => (
              <button type="button" key={x} onClick={() => setEmoji(x)} className={cx("size-9 rounded-lg text-lg", emoji === x ? "bg-accent-soft ring-2 ring-accent" : "hover:bg-hover")} aria-pressed={emoji === x}>
                {x}
              </button>
            ))}
            <button type="button" onClick={() => setEmoji("")} className={cx("h-9 px-2 rounded-lg text-xs text-muted", !emoji ? "bg-accent-soft ring-2 ring-accent" : "hover:bg-hover")}>
              None
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end">
          <Button variant="primary">{section ? "Save" : "Create section"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- channel settings -----------------------------------------------------------------------------

/** Someone in a channel, as GET /api/channels/:id/members returns them. */
export interface ChannelMember {
  kind: "user" | "agent";
  id: string;
  name: string;
  handle: string | null;
  role: string | null;
}

export type ChannelSettingsTab = "about" | "team" | "agents" | "members" | "pins" | "danger";

/** Back to #general (after leaving or deleting the channel you were in). */
function toGeneral() {
  const general = useStore.getState().channels.find((c) => c.kind === "channel" && c.name === "general");
  go({ view: "chat", channelId: general?.id ?? null, threadId: null });
}

/** Leave a channel; if you were looking at it, go back to #general. */
export async function leaveChannel(channel: ChannelInfo) {
  await api("POST", `/api/channels/${channel.id}/leave`);
  await useStore.getState().refreshChannels();
  if (useStore.getState().activeChannel === channel.id) toGeneral();
}

/** A channel's settings: its name and topic; how agents behave in it; who's in it; pins; archiving and deleting. */
export function ChannelSettings({ channel: initial, tab: initialTab = "about", onClose }: { channel: ChannelInfo; tab?: ChannelSettingsTab; onClose: () => void }) {
  const role = useStore((s) => s.me?.role);
  // follow the live channel, so pins and members update while the dialog is open
  const channel = useStore((s) => s.channels.find((c) => c.id === initial.id)) ?? initial;
  const canManage = role === "owner" || role === "member";
  const canRemove = canManage && !isProtected(channel);
  const [tab, setTab] = useState<ChannelSettingsTab>(initialTab === "danger" && !canRemove ? "about" : initialTab);
  // the team being edited lives here, so it survives a trip to the New agent dialog
  const agents = useStore((s) => s.agents);
  const [team, setTeam] = useState<ChannelTeam>(() => liveTeam(channel.settings.team, agents) ?? EMPTY_TEAM);
  const [newAgent, setNewAgent] = useState(false);
  const tabs: { id: ChannelSettingsTab; label: string }[] = [
    { id: "about", label: "About" },
    { id: "team", label: "Team" },
    { id: "agents", label: "Agents" },
    { id: "members", label: `Members · ${channel.memberCount}` },
    { id: "pins", label: channel.pinnedIds.length ? `Pins · ${channel.pinnedIds.length}` : "Pins" },
    ...(canRemove ? [{ id: "danger" as const, label: channel.archivedAt ? "Archived" : "Archive" }] : []),
  ];
  if (newAgent)
    return (
      <NewAgentForTeam
        onClose={() => setNewAgent(false)}
        onCreated={(a) => {
          setTeam((t) => addToTeam(t, a.id));
          setNewAgent(false);
        }}
      />
    );
  return (
    <Modal
      title={
        <span className="flex items-center gap-1">
          <ChannelIcon channel={channel} size={16} />
          {channel.name}
        </span>
      }
      label={`#${channel.name} settings`}
      onClose={onClose}
      wide
      className={tab === "team" ? "sm:max-w-5xl!" : undefined}
    >
      <div className="flex gap-4 border-b border-line text-sm mb-4" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx("pb-2 -mb-px border-b-2", tab === t.id ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "about" && <AboutChannel channel={channel} canManage={canManage} onClose={onClose} />}
      {tab === "team" && <ChannelTeamTab channel={channel} team={team} onChange={setTeam} canManage={canManage && !channel.archivedAt} onCreateAgent={() => setNewAgent(true)} onClose={onClose} />}
      {tab === "agents" && <ChannelAgents channel={channel} canManage={canManage && !channel.archivedAt} onClose={onClose} />}
      {tab === "members" && <ChannelMembers channel={channel} canManage={canManage} onClose={onClose} />}
      {tab === "pins" && <ChannelPins channel={channel} onClose={onClose} />}
      {tab === "danger" && <ArchiveOrDelete channel={channel} onClose={onClose} />}
    </Modal>
  );
}

function AboutChannel({ channel, canManage, onClose }: { channel: ChannelInfo; canManage: boolean; onClose: () => void }) {
  const sections = useStore((s) => s.sections);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [section, setSection] = useState<string | null>(channel.sectionId);
  const [isPrivate, setPrivate] = useState(channel.private);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = name !== channel.name || topic !== channel.topic || section !== channel.sectionId || isPrivate !== channel.private;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
          await api("PATCH", `/api/channels/${channel.id}`, { ...(name !== channel.name ? { name } : {}), topic, sectionId: section, ...(isPrivate !== channel.private ? { private: isPrivate } : {}) });
          await refreshChannels();
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={!canManage} className="space-y-4">
      <Field label="Name" hint={channel.name === "general" ? "Everyone in the organization lands in #general, so it keeps its name." : "Lowercase, no spaces. Links to the channel keep working after a rename."}>
        <div className="relative">
          <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} required maxLength={80} className="pl-8" disabled={channel.name === "general"} />
        </div>
      </Field>
      <Field label="Topic">
        <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What's this channel for?" maxLength={250} />
      </Field>
      <Field label="Sidebar section">
        <SectionSelect sections={sections} value={section} onChange={setSection} />
      </Field>
      {!isProtected(channel) && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="font-medium flex items-center gap-1.5">
              <Lock size={13} /> Private
            </span>
            <span className="block text-xs text-muted">{isPrivate ? "Only its members (and organization owners) can see it." : "Anyone in the organization can find and join it."}</span>
          </span>
          <Toggle on={isPrivate} onChange={setPrivate} label="Private channel" disabled={!canManage} />
        </label>
      )}
      </fieldset>
      {!canManage && <p className="text-xs text-muted">Guests can't change channels.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex items-center justify-between gap-2 pt-1">
        {channel.joined && channel.name !== "general" ? (
          <Button
            type="button"
            variant="ghost"
            onClick={async () => {
              await leaveChannel(channel);
              onClose();
            }}
          >
            <LogOut size={14} /> Leave channel
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" disabled={!canManage || !changed || !name || saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function ChannelMembers({ channel, canManage, onClose }: { channel: ChannelInfo; canManage: boolean; onClose: () => void }) {
  const me = useStore((s) => s.me);
  const people = useStore((s) => s.members);
  const agents = useStore((s) => s.agents);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ChannelMember[]>("GET", `/api/channels/${channel.id}/members`)
      .then((m) => live && setMembers(m))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
    // the count changes when anyone joins or leaves; reload then too
  }, [channel.id, channel.memberCount]);

  const inChannel = new Set((members ?? []).map((m) => `${m.kind}:${m.id}`));
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  const candidates: ChannelMember[] = needle
    ? [
        ...people.map((p) => ({ kind: "user" as const, id: p.id, name: p.name, handle: null, role: p.role })),
        ...agents.map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, handle: a.handle, role: null })),
      ]
        .filter((c) => !inChannel.has(`${c.kind}:${c.id}`))
        .filter((c) => c.name.toLowerCase().includes(needle) || c.handle?.includes(needle))
        .slice(0, 8)
    : [];

  async function change(method: "PUT" | "DELETE", m: Pick<ChannelMember, "kind" | "id">) {
    setError(null);
    setBusy(`${m.kind}:${m.id}`);
    try {
      setMembers(await api<ChannelMember[]>(method, `/api/channels/${channel.id}/members/${m.kind}/${m.id}`));
      if (method === "PUT") setQ("");
      if (m.kind === "user" && m.id === me?.user.id) await useStore.getState().refreshChannels();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const peopleIn = (members ?? []).filter((m) => m.kind === "user");
  const agentsIn = (members ?? []).filter((m) => m.kind === "agent");
  const agentById = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="relative">
          <UserPlus size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Add people or agents"
            className="pl-9 h-10"
            aria-label="Add people or agents"
            onKeyDown={(e) => {
              if (e.key === "Enter" && candidates[0]) {
                e.preventDefault();
                change("PUT", candidates[0]);
              }
            }}
          />
          {needle && (
            <div className="absolute z-10 left-0 right-0 top-full mt-1 rounded-xl border border-line bg-panel shadow-panel p-1 max-h-64 overflow-y-auto">
              {candidates.length === 0 && <p className="px-3 py-2 text-sm text-muted">No one else matches “{q.trim()}”.</p>}
              {candidates.map((c) => (
                <button key={`${c.kind}:${c.id}`} onClick={() => change("PUT", c)} disabled={!!busy} className="w-full px-2 h-10 rounded-lg flex items-center gap-2.5 text-sm text-left hover:bg-hover">
                  {c.kind === "agent" ? <AgentAvatar agent={agentById(c.id)} size={24} /> : <UserAvatar name={c.name} size={24} />}
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted">{c.kind === "agent" ? `@${c.handle} · agent` : c.role}</span>
                  <Plus size={14} className="ml-auto text-faint" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {!members ? (
        <p className="text-sm text-muted py-6 text-center">Loading members…</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">Nobody's in #{channel.name} right now.</p>
      ) : (
        <div className="space-y-4">
          {[
            { title: "People", list: peopleIn },
            { title: "Agents", list: agentsIn },
          ]
            .filter((g) => g.list.length)
            .map((g) => (
              <div key={g.title}>
                <div className="text-xs font-medium text-muted mb-1.5">
                  {g.title} · {g.list.length}
                </div>
                <div className="rounded-xl border border-line divide-y divide-line">
                  {g.list.map((m) => {
                    const isMe = m.kind === "user" && m.id === me?.user.id;
                    return (
                      <div key={`${m.kind}:${m.id}`} className="px-3 h-12 flex items-center gap-3">
                        {m.kind === "agent" ? <AgentAvatar agent={agentById(m.id) ?? { name: m.name, handle: m.handle ?? undefined, harness: "custom" }} size={28} /> : <UserAvatar name={m.name} size={28} />}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">
                            {m.name}
                            {isMe && <span className="text-muted font-normal"> (you)</span>}
                          </div>
                          <div className="text-xs text-muted truncate">{m.kind === "agent" ? `@${m.handle}` : m.role}</div>
                        </div>
                        {isMe && channel.name !== "general" ? (
                          <Button
                            variant="ghost"
                            className="h-8 text-xs"
                            onClick={async () => {
                              await leaveChannel(channel);
                              onClose();
                            }}
                          >
                            Leave
                          </Button>
                        ) : (
                          canManage && (
                            <button
                              onClick={() => change("DELETE", m)}
                              disabled={busy === `${m.kind}:${m.id}`}
                              className="size-8 rounded-lg grid place-items-center text-muted hover:text-bad hover:bg-hover"
                              aria-label={`Remove ${m.name} from #${channel.name}`}
                              title={`Remove from #${channel.name}`}
                            >
                              <X size={15} />
                            </button>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
      <p className="text-xs text-muted">
        Agents here answer when someone @mentions them{channel.settings.defaultAgentId ? "; the channel's own agent answers everything else (see Agents)" : ""}.{" "}
        {channel.private ? `Only the people and agents listed can see #${channel.name}.` : `Anyone in the organization can still read and join #${channel.name}.`}
      </p>
    </div>
  );
}

/** Who's working on the chart right now, and where: "Working" or "In a thread". */
export function useTeamWork(channelId: string): Record<string, string> {
  const live = useStore((s) => s.live);
  const out: Record<string, string> = {};
  for (const r of Object.values(live)) if (r.channelId === channelId) out[r.agentId] = r.threadId ? "Working in a thread" : "Working";
  return out;
}

/** A channel's team chart: who leads, who hands work to whom. Saving it adds everyone on it to the channel. */
function ChannelTeamTab({ channel, team, onChange, canManage, onCreateAgent, onClose }: { channel: ChannelInfo; team: ChannelTeam; onChange: (t: ChannelTeam) => void; canManage: boolean; onCreateAgent: () => void; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const working = useTeamWork(channel.id);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = liveTeam(channel.settings.team, agents) ?? EMPTY_TEAM;
  const changed = JSON.stringify(team) !== JSON.stringify(saved);
  const problem = team.nodes.length ? teamProblem(team) : null;
  const save = async (next: ChannelTeam | null) => {
    setError(null);
    setSaving(true);
    try {
      await api("PATCH", `/api/channels/${channel.id}`, { settings: { team: next } });
      await refreshChannels();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {saved.nodes.length
          ? `The leads read every new message in #${channel.name} and hand out the work along the arrows.`
          : `#${channel.name} has no team yet, so only agents someone @mentions (or the one under Rules) answer here. Build one: drag agents onto the chart and make one of them a lead.`}
      </p>
      <TeamChart team={team} onChange={canManage ? onChange : undefined} readOnly={!canManage} working={working} onCreateAgent={canManage ? onCreateAgent : undefined} />
      <details className="rounded-xl bg-bg px-3.5 py-2.5">
        <summary className="text-sm font-medium cursor-pointer">How the team works</summary>
        <TeamRules className="mt-2" />
      </details>
      {team.nodes.length > 0 && <TeamMore team={team} onChange={onChange} canManage={canManage} />}
      {!canManage && <p className="text-xs text-muted">{channel.archivedAt ? "This channel is archived." : "Guests can't change channels."}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {canManage && (
        <div className="flex items-center justify-between gap-2">
          {saved.nodes.length > 0 ? (
            <Button variant="ghost" disabled={saving} onClick={() => void save(null)} title="Back to agents answering only when someone @mentions them">
              Remove the team
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" disabled={!changed || !!problem || !team.nodes.length || saving} onClick={() => void save(team)} title={problem ?? undefined}>
            Save team
          </Button>
        </div>
      )}
    </div>
  );
}

/** The rest of a team, out of the way until it's wanted: each agent's role, a shared memory folder, a repo, and who it reports to. */
function TeamMore({ team, onChange, canManage }: { team: ChannelTeam; onChange: (t: ChannelTeam) => void; canManage: boolean }) {
  const names = useNames();
  const agents = useStore((s) => s.agents);
  const set = (patch: Partial<ChannelTeam>) => onChange({ ...team, ...patch });
  const setNode = (agentId: string, patch: { role?: string; roleNotes?: string }) => set({ nodes: team.nodes.map((n) => (n.agentId === agentId ? { ...n, ...patch } : n)) });
  const onTeam = new Set(team.nodes.map((n) => n.agentId));
  const folder = team.folder ?? "";
  return (
    <details className="rounded-xl bg-bg px-3.5 py-2.5">
      <summary className="text-sm font-medium cursor-pointer">More</summary>
      <fieldset disabled={!canManage} className="mt-3 space-y-5">
        <div className="space-y-2">
          <div className="text-sm font-medium">Roles</div>
          {team.nodes.map((n) => {
            const a = names.agent(n.agentId);
            if (!a) return null;
            return (
              <div key={n.agentId} className="grid sm:grid-cols-[10rem_1fr] gap-2 items-start">
                <span className="flex items-center gap-2 min-w-0 h-9 text-sm">
                  <AgentAvatar agent={a} size={22} badge={false} interactive={false} /> <span className="truncate">{a.name}</span>
                </span>
                <div className="space-y-1.5">
                  <Input value={n.role ?? ""} onChange={(e) => setNode(n.agentId, { role: e.target.value })} placeholder="Role, e.g. Backend" aria-label={`${a.name}'s role`} maxLength={60} />
                  {(n.role || n.roleNotes) && <Textarea rows={2} value={n.roleNotes ?? ""} onChange={(e) => setNode(n.agentId, { roleNotes: e.target.value })} placeholder="What it owns and what to send its way. The agent reads this." aria-label={`What ${a.name}'s role owns`} maxLength={4000} />}
                </div>
              </div>
            );
          })}
        </div>
        <Field
          label="Memory folder"
          hint={
            <>
              Everyone on the team reads and writes it.{" "}
              {folder && (
                <a className="text-accent-text hover:underline" href={href({ view: "vault", path: `${folder}/README.md` })}>
                  Open
                </a>
              )}
            </>
          }
        >
          <Input value={folder} onChange={(e) => set({ folder: e.target.value })} placeholder="teams/web" maxLength={200} />
        </Field>
        <div className="grid sm:grid-cols-[1fr_10rem] gap-4">
          <Field label="Code repository" hint="A git URL, or a path on the device the agents run on. Tasks for this team get their own branch and checkout.">
            <Input value={team.repo ?? ""} onChange={(e) => set({ repo: e.target.value || null })} placeholder="git@github.com:you/app.git" maxLength={500} />
          </Field>
          <Field label="Base branch">
            <Input value={team.baseBranch ?? ""} onChange={(e) => set({ baseBranch: e.target.value })} placeholder="main" maxLength={100} />
          </Field>
        </div>
        <Field label="Reports to" hint="An agent outside the team that can see and steer its work.">
          <select value={team.reportsTo ?? ""} onChange={(e) => set({ reportsTo: e.target.value || null })} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="">Nobody</option>
            {agents
              .filter((a) => !onTeam.has(a.id) || a.id === team.reportsTo)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle} ({a.name})
                </option>
              ))}
          </select>
        </Field>
      </fieldset>
    </details>
  );
}

/** How agents behave here: who answers un-@mentioned messages, where they reply, and notes they all follow. */
function ChannelAgents({ channel, canManage, onClose }: { channel: ChannelInfo; canManage: boolean; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [rules, setRules] = useState<AgentRules>(channel.settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = JSON.stringify(rules) !== JSON.stringify(channel.settings);
  const answerer = agents.find((a) => a.id === rules.defaultAgentId);
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
          await api("PATCH", `/api/channels/${channel.id}`, { settings: rules });
          await refreshChannels();
          onClose();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={!canManage} className="space-y-5">
        <Field
          label="Who answers messages without an @mention?"
          hint={
            channel.settings.team?.nodes.length
              ? undefined
              : answerer
              ? `${answerer.name} answers anything nobody @mentions, and joins #${channel.name} to do it. @mention another agent to ask them instead.`
              : "Right now a message only reaches an agent when someone @mentions it. Pick an agent to make this its channel."
          }
        >
          {channel.settings.team?.nodes.length ? (
            <p className="text-sm text-muted">The team's leads read every new message here (see Team), so they answer what nobody @mentions.</p>
          ) : agents.length ? (
            <AnswerSelect agents={agents} value={rules.defaultAgentId} onChange={(v) => setRules({ ...rules, defaultAgentId: v })} />
          ) : (
            <p className="text-sm text-muted">No agents in this organization yet.</p>
          )}
        </Field>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="font-medium">Answer in a thread</span>
            <span className="block text-xs text-muted">Agents reply under the message they're answering, so the channel stays easy to read.</span>
          </span>
          <Toggle on={rules.replyInThread} onChange={(v) => setRules({ ...rules, replyInThread: v })} label="Agents answer in a thread" disabled={!canManage} />
        </label>
        <Field label="Notes for agents here" hint="Every agent reads these when it works in this channel, e.g. which repo to use or how long replies should be.">
          <Textarea value={rules.instructions} onChange={(e) => setRules({ ...rules, instructions: e.target.value })} rows={4} maxLength={4000} placeholder={`e.g. "This is where we plan the launch. Keep answers short and link the doc in shared/launch.md."`} />
        </Field>
        <p className="text-xs text-muted">In a thread, a plain reply goes back to the agent already talking there; no @mention needed.</p>
      </fieldset>
      {!canManage && <p className="text-xs text-muted">{channel.archivedAt ? "This channel is archived." : "Guests can't change channels."}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!canManage || !changed || saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

interface PinRow {
  message: import("@warren/core").Message;
  pinnedBy: import("@warren/core").Actor;
  pinnedAt: string;
}

/** The messages pinned in a channel, newest pin first, each one a way back to where it was said. */
function ChannelPins({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const names = useNames();
  const canPin = useStore((s) => s.me?.role !== "guest") && !channel.archivedAt;
  const [pins, setPins] = useState<PinRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = channel.pinnedIds.join();
  useEffect(() => {
    let live = true;
    api<PinRow[]>("GET", `/api/channels/${channel.id}/pins`)
      .then((p) => live && setPins(p))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [channel.id, key]);
  const who = (a: import("@warren/core").Actor) => (a.kind === "agent" ? names.agent(a.id)?.name : names.member(a.id)?.name) ?? "Someone";
  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!pins) return <p className="text-sm text-muted py-6 text-center">Loading pins…</p>;
  if (!pins.length)
    return (
      <div className="py-8 text-center text-sm text-muted">
        <Pin size={18} className="mx-auto mb-2 text-faint" />
        Nothing pinned yet. Pin a message from its “…” menu so everyone here can find it again.
      </div>
    );
  return (
    <div className="rounded-xl border border-line divide-y divide-line max-h-[55vh] overflow-y-auto">
      {pins.map((p) => (
        <div key={p.message.id} className="px-3 py-2.5 flex gap-3 items-start">
          <button
            className="min-w-0 flex-1 text-left"
            onClick={() => {
              onClose();
              go({ view: "chat", channelId: channel.id, threadId: p.message.threadId });
            }}
          >
            <div className="text-xs text-muted">
              <span className="font-medium text-ink">{who(p.message.author)}</span> · pinned by {who(p.pinnedBy)}
            </div>
            <div className="text-sm line-clamp-3 whitespace-pre-wrap">{p.message.body || "(an attachment)"}</div>
          </button>
          {canPin && (
            <button onClick={() => api("DELETE", `/api/messages/${p.message.id}/pin`).catch((e) => setError((e as Error).message))} className="size-8 shrink-0 rounded-lg grid place-items-center text-muted hover:text-bad hover:bg-hover" aria-label="Unpin" title="Unpin">
              <X size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function ArchiveOrDelete({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line p-4 space-y-3">
        <div className="font-medium flex items-center gap-2">{channel.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />} {channel.archivedAt ? `#${channel.name} is archived` : `Archive #${channel.name}`}</div>
        <p className="text-sm text-muted">
          {channel.archivedAt
            ? "It's read-only and out of everyone's sidebar. Unarchive it to post here again."
            : "It leaves everyone's sidebar and becomes read-only; nothing is deleted and you can still find and search it. Agents working here are stopped. You can unarchive it any time."}
        </p>
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              await setArchived(channel, !channel.archivedAt);
              onClose();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {channel.archivedAt ? "Unarchive channel" : "Archive channel"}
        </Button>
      </div>
      <form
        className="rounded-xl border border-line p-4 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await api("DELETE", `/api/channels/${channel.id}`);
            const wasOpen = useStore.getState().activeChannel === channel.id;
            await refreshChannels();
            onClose();
            if (wasOpen) toGeneral();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="font-medium flex items-center gap-2 text-bad">
          <Trash2 size={15} /> Delete #{channel.name}
        </div>
        <p className="text-sm text-muted">Every message, thread and discussion in it is deleted for everyone, and agents working here are stopped. Tasks and routines that pointed here keep going without a channel. This can't be undone.</p>
        <Field label={`Type ${channel.name} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={channel.name} autoComplete="off" />
        </Field>
        <div className="flex justify-end">
          <Button variant="danger" disabled={typed !== channel.name || busy}>
            Delete channel
          </Button>
        </div>
      </form>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

/**
 * A "…" menu for one channel (Rename, Members, Leave) that opens the settings dialog itself, for
 * places like the sidebar's channel rows. Pass `trigger` to draw your own button.
 */
export function ChannelMenu({ channel, trigger, align = "right" }: { channel: ChannelInfo; trigger?: (open: boolean, toggle: () => void) => ReactNode; align?: "left" | "right" }) {
  const [settings, setSettings] = useState<ChannelSettingsTab | null>(null);
  const role = useStore((s) => s.me?.role);
  if (channel.kind !== "channel") return null;
  return (
    <>
      <Menu
        align={align}
        trigger={
          trigger ??
          ((open, toggle) => (
            <button onClick={toggle} aria-expanded={open} aria-label={`#${channel.name} options`} className="size-6 rounded-md grid place-items-center text-muted hover:text-ink hover:bg-hover">
              <MoreHorizontal size={14} />
            </button>
          ))
        }
        items={[
          { label: channel.starred ? "Unstar" : "Star", icon: <Star size={14} />, onSelect: () => void setChannelPrefs(channel, { starred: !channel.starred }) },
          channel.notify === "mute"
            ? { label: "Unmute", icon: <Bell size={14} />, onSelect: () => void setChannelPrefs(channel, { notify: "default" }) }
            : { label: "Mute", icon: <BellOff size={14} />, onSelect: () => void setChannelPrefs(channel, { notify: "mute" }) },
          "divider" as const,
          ...(role !== "guest" ? [{ label: "Rename…", icon: <Pencil size={14} />, onSelect: () => setSettings("about") }] : []),
          { label: "Agents", icon: <Bot size={14} />, onSelect: () => setSettings("agents") },
          { label: "Members", icon: <Users size={14} />, onSelect: () => setSettings("members") },
          ...(channel.joined && channel.name !== "general" ? ["divider" as const, { label: "Leave channel", icon: <LogOut size={14} />, onSelect: () => void leaveChannel(channel), danger: true }] : []),
          ...(role !== "guest" && !isProtected(channel) && !channel.archivedAt ? [{ label: "Archive…", icon: <Archive size={14} />, onSelect: () => setSettings("danger"), danger: true }] : []),
        ]}
      />
      {/* the sidebar row only shows this button on hover (opacity-0 otherwise), which would hide the dialog too: draw it on the page */}
      {settings && createPortal(<ChannelSettings channel={channel} tab={settings} onClose={() => setSettings(null)} />, document.body)}
    </>
  );
}
