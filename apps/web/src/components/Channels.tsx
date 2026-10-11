import { useMemo, useState } from "react";
import { Check, Hash, Plus, Search } from "lucide-react";
import type { Section } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { Button, Field, Input, Modal, cx } from "./ui.tsx";

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
                <span className="text-xs font-medium text-accent">Join</span>
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
