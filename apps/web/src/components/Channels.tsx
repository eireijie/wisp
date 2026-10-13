import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Hash, LogOut, MoreHorizontal, Pencil, Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import type { Section } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { go } from "../router.ts";
import { AgentAvatar, Button, Field, Input, Menu, Modal, UserAvatar, cx } from "./ui.tsx";

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** "Add a channel": one box to search, join, or create (Buzz-style). */
export function ChannelBrowser({ onClose, sectionId = null }: { onClose: () => void; sectionId?: string | null }) {
  const channels = useStore((s) => s.channels).filter((c) => c.kind === "channel");
  const sections = useStore((s) => s.sections);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "joined">("all");
  const [creating, setCreating] = useState(false);
  const [topic, setTopic] = useState("");
  const [section, setSection] = useState<string | null>(sectionId);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, "");
    return channels
      .filter((c) => (tab === "joined" ? c.joined : true))
      .filter((c) => !needle || c.name.includes(needle) || c.topic.toLowerCase().includes(needle))
      .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  }, [channels, q, tab]);
  const name = slug(q.replace(/^#/, ""));
  const exists = channels.some((c) => c.name === name);

  async function open(id: string, joined: boolean) {
    if (!joined) await api("POST", `/api/channels/${id}/join`);
    await refreshChannels();
    onClose();
    go({ view: "chat", channelId: id, threadId: null });
  }

  async function create() {
    setError(null);
    try {
      const ch = await api<{ id: string }>("POST", "/api/channels", { name, topic, sectionId: section });
      await refreshChannels();
      onClose();
      go({ view: "chat", channelId: ch.id, threadId: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
              if (e.key === "Enter" && name && !exists) setCreating(true);
            }}
          />
        </div>
        <div className="flex gap-4 border-b border-line text-sm" role="tablist">
          {(["all", "joined"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("pb-2 -mb-px border-b-2", tab === t ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
              {t === "all" ? "All channels" : "Joined"}
            </button>
          ))}
        </div>

        {creating ? (
          <div className="rounded-xl border border-line p-4 space-y-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setQ(e.target.value)} autoFocus />
            </Field>
            <Field label="Topic">
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What's this channel for?" />
            </Field>
            {sections.length > 0 && (
              <Field label="Section">
                <SectionSelect sections={sections} value={section} onChange={setSection} />
              </Field>
            )}
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Back
              </Button>
              <Button variant="primary" disabled={!name || exists} onClick={create}>
                Create #{name || "channel"}
              </Button>
            </div>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} className="w-full rounded-xl bg-bg hover:bg-hover px-4 h-12 flex items-center gap-3 text-sm font-medium">
            <span className="size-7 rounded-lg bg-panel border border-line grid place-items-center">
              <Plus size={15} />
            </span>
            {name && !exists ? `Create #${name}` : "Create a new channel"}
          </button>
        )}

        <div className="rounded-xl border border-line divide-y divide-line max-h-[50vh] overflow-y-auto">
          {list.length === 0 && <p className="px-4 py-6 text-sm text-muted text-center">No channels match.</p>}
          {list.map((c) => (
            <button key={c.id} onClick={() => open(c.id, c.joined)} className="w-full text-left px-4 py-3 hover:bg-hover flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium flex items-center gap-1">
                  <Hash size={14} className="text-faint" /> {c.name}
                </div>
                <div className="text-xs text-muted truncate">
                  {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  {c.topic && ` · ${c.topic}`}
                </div>
              </div>
              {c.joined ? (
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

export type ChannelSettingsTab = "about" | "members" | "danger";

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

/** A channel's settings: its name, topic and section; who's in it; and deleting it. */
export function ChannelSettings({ channel, tab: initialTab = "about", onClose }: { channel: ChannelInfo; tab?: ChannelSettingsTab; onClose: () => void }) {
  const role = useStore((s) => s.me?.role);
  const canManage = role === "owner" || role === "member";
  const canDelete = canManage && channel.name !== "general";
  const [tab, setTab] = useState<ChannelSettingsTab>(initialTab === "danger" && !canDelete ? "about" : initialTab);
  const tabs: { id: ChannelSettingsTab; label: string }[] = [
    { id: "about", label: "About" },
    { id: "members", label: `Members · ${channel.memberCount}` },
    ...(canDelete ? [{ id: "danger" as const, label: "Delete" }] : []),
  ];
  return (
    <Modal
      title={
        <span className="flex items-center gap-1">
          <Hash size={16} className="text-faint" />
          {channel.name}
        </span>
      }
      label={`#${channel.name} settings`}
      onClose={onClose}
      wide
    >
      <div className="flex gap-4 border-b border-line text-sm mb-4" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx("pb-2 -mb-px border-b-2", tab === t.id ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "about" && <AboutChannel channel={channel} canManage={canManage} onClose={onClose} />}
      {tab === "members" && <ChannelMembers channel={channel} canManage={canManage} onClose={onClose} />}
      {tab === "danger" && <DeleteChannel channel={channel} onClose={onClose} />}
    </Modal>
  );
}

function AboutChannel({ channel, canManage, onClose }: { channel: ChannelInfo; canManage: boolean; onClose: () => void }) {
  const sections = useStore((s) => s.sections);
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [section, setSection] = useState<string | null>(channel.sectionId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = name !== channel.name || topic !== channel.topic || section !== channel.sectionId;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaving(true);
        try {
          await api("PATCH", `/api/channels/${channel.id}`, { ...(name !== channel.name ? { name } : {}), topic, sectionId: section });
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
      <Field label="Name" hint={channel.name === "general" ? "Everyone in the workspace lands in #general." : "Lowercase, no spaces. Links to the channel keep working after a rename."}>
        <div className="relative">
          <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} required maxLength={80} className="pl-8" />
        </div>
      </Field>
      <Field label="Topic">
        <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What's this channel for?" maxLength={250} />
      </Field>
      <Field label="Sidebar section">
        <SectionSelect sections={sections} value={section} onChange={setSection} />
      </Field>
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

function ChannelMembers({ channel, canManage, onClose }: { channel: ChannelInfo; canManage: boolean; onClose: () => void }) {
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
      <p className="text-xs text-muted">Agents in a channel answer there when someone @mentions them. Anyone in the workspace can still read and join #{channel.name}.</p>
    </div>
  );
}

function DeleteChannel({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const refreshChannels = useStore((s) => s.refreshChannels);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
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
      <div className="rounded-xl border border-line p-4 space-y-2">
        <div className="font-medium flex items-center gap-2 text-bad">
          <Trash2 size={15} /> Delete #{channel.name}
        </div>
        <p className="text-sm text-muted">Every message, thread and discussion in it is deleted for everyone, and agents working here are stopped. Tasks and routines that pointed here keep going without a channel. This can't be undone.</p>
      </div>
      <Field label={`Type ${channel.name} to confirm`}>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={channel.name} autoComplete="off" />
      </Field>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end">
        <Button variant="danger" disabled={typed !== channel.name || busy}>
          Delete channel
        </Button>
      </div>
    </form>
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
          ...(role !== "guest" ? [{ label: "Rename…", icon: <Pencil size={14} />, onSelect: () => setSettings("about") }] : []),
          { label: "Members", icon: <Users size={14} />, onSelect: () => setSettings("members") },
          ...(channel.joined && channel.name !== "general" ? ["divider" as const, { label: "Leave channel", icon: <LogOut size={14} />, onSelect: () => void leaveChannel(channel), danger: true }] : []),
        ]}
      />
      {settings && <ChannelSettings channel={channel} tab={settings} onClose={() => setSettings(null)} />}
    </>
  );
}
