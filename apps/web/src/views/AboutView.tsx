import { useCallback, useEffect, useState } from "react";
import { Brain, Check, ChevronLeft, ExternalLink, Pencil, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { Button, Empty, IconButton, Input, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";

type Kind = "preference" | "plan" | "did" | "detail";

interface Item {
  path: string;
  kind: Kind;
  text: string;
  by: string | null;
  source: string | null;
  messageId: string | null;
  channelId: string | null;
  created: string | null;
  updated: string | null;
  pinned: boolean;
  status: string | null;
  due: string | null;
  date: string | null;
}

interface Profile {
  person: { id: string; name: string };
  level: string;
  items: Item[];
}

const TABS: { kind: Kind; label: string; add: string; empty: string }[] = [
  { kind: "preference", label: "Preferences", add: "e.g. Prefers short answers with examples", empty: "How you like things done: tone, tools, formats." },
  { kind: "plan", label: "Plans", add: "e.g. Launch the beta", empty: "What you're planning to do, with due dates. Agents mark them done." },
  { kind: "did", label: "Activity", add: "e.g. Finished the onboarding redesign", empty: "What you did, day by day." },
  { kind: "detail", label: "Details", add: "e.g. My cofounder is Sam", empty: "Small things you've mentioned: people, setups, dates." },
];

/**
 * What agents have learned about a person. Every agent reads this before it works, and the
 * person can correct, pin or remove anything.
 */
export function AboutView({ onBack }: { onBack?: () => void }) {
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const [userId, setUserId] = useState(me.user.id);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Kind>("preference");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [due, setDue] = useState("");
  const [addKind, setAddKind] = useState<Kind>("preference");

  const load = useCallback(() => api<Profile>("GET", `/api/memory/profile?user=${encodeURIComponent(userId)}`).then(setProfile, (e) => setError(e.message)), [userId]);
  useEffect(() => {
    setProfile(null);
    load();
  }, [load]);

  const remember = async (body: object) => {
    setError(null);
    try {
      const r = await api<{ saved: boolean; similar?: Item[] }>("POST", "/api/memory/remember", { about: userId, ...body });
      if (!r.saved) setError(`Already saved: "${r.similar?.[0]?.text}". Edit that one instead.`);
      await load();
      return r.saved;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const forget = async (i: Item) => {
    if (!confirm(`Delete “${i.text}”? Git history keeps the old version.`)) return;
    setError(null);
    try {
      await api("DELETE", `/api/vault/note?path=${encodeURIComponent(i.path)}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const items = profile?.items.filter((i) => i.kind === tab) ?? [];
  const current = TABS.find((t) => t.kind === tab)!;
  const isMe = userId === me.user.id;
  const canEdit = profile ? profile.level === "edit" || profile.level === "manage" : false;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <Brain size={17} className="text-accent-text" />
        <h1 className="text-lg font-bold tracking-tight flex-1 truncate">{isMe ? "About you" : `About ${profile?.person.name ?? "…"}`}</h1>
        {me.role === "owner" && members.length > 1 && (
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="h-8 rounded-lg border border-line bg-panel px-2 text-sm" aria-label="Whose memory">
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.user.id ? "You" : m.name}
              </option>
            ))}
          </select>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-4 md:px-6 py-5 space-y-5">
          <p className="text-base font-medium text-ink">{isMe ? "What helpers should know about you" : `What helpers should know about ${profile?.person.name ?? "them"}`}</p>
          <p className="text-sm text-muted">
            What agents have learned about {isMe ? "you" : profile?.person.name}. Every agent reads this before it works, so you don't have to repeat yourself. Fix or delete anything; it applies from the next message.{" "}
            {profile && (
              <a className="text-accent-text hover:underline" href="#/vault">
                It's plain notes in Memory, in the folder with {isMe ? "your" : "their"} name.
              </a>
            )}
          </p>

          <p className="text-sm text-muted">
            How Wisp itself behaves (like which key sends a message) is in{" "}
            <a className="text-accent-text hover:underline" href={href({ view: "settings", page: "preferences" })}>
              Settings → App behavior
            </a>
            . Your name and time zone are in{" "}
            <a className="text-accent-text hover:underline" href={href({ view: "settings", page: "profile" })}>
              Profile
            </a>
            . Everything here is saved as notes in{" "}
            <a className="text-accent-text hover:underline" href={href({ view: "vault", path: null })}>
              Memory
            </a>
            .
          </p>

          {canEdit && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!draft.trim()) return;
                if (await remember({ kind: addKind, text: draft.trim(), ...(addKind === "plan" && due ? { due } : {}) })) {
                  setDraft("");
                  setDue("");
                }
              }}
            >
              <Input
                className="flex-1 min-w-48"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={isMe ? "What would you like your helper to remember? e.g. I like short answers with an example" : TABS.find((t) => t.kind === addKind)!.add}
                aria-label="What would you like your helper to remember?"
              />
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value as Kind)}
                aria-label="Category"
                className="h-9 rounded-lg border border-line bg-panel px-2 text-sm"
              >
                {TABS.map((t) => (
                  <option key={t.kind} value={t.kind}>
                    {t.label}
                  </option>
                ))}
              </select>
              {addKind === "plan" && <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-40" aria-label="Due date" />}
              <Button variant="primary" disabled={!draft.trim()}>
                Remember this
              </Button>
            </form>
          )}

          <div className="flex gap-1 overflow-x-auto" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.kind}
                role="tab"
                aria-selected={tab === t.kind}
                onClick={() => { setTab(t.kind); setAddKind(t.kind); }}
                className={cx("h-8 px-3 rounded-lg text-sm whitespace-nowrap", tab === t.kind ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}
              >
                {t.label}
                <span className="ml-1.5 text-faint tabular-nums">{profile?.items.filter((i) => i.kind === t.kind && (t.kind !== "plan" || i.status === "active")).length ?? ""}</span>
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-bad">{error}</p>}

          {!profile ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <Empty icon={<Brain />} title={`No ${current.label.toLowerCase()} yet`}>
              <p>{current.empty}</p>
              <p>Agents add these as you talk with them, and you can add your own above.</p>
            </Empty>
          ) : tab === "did" ? (
            <Journal items={items} />
          ) : (
            <div className="rounded-xl border border-line divide-y divide-line">
              {[...items]
                .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.status === "done" || a.status === "dropped") - Number(b.status === "done" || b.status === "dropped"))
                .map((i) => (
                  <ItemRow key={i.path} item={i} canEdit={canEdit} onSave={(body) => remember({ kind: i.kind, replaces: i.path, ...body })} onForget={() => forget(i)} />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Origin({ item }: { item: Item }) {
  const when = item.updated ?? item.created;
  return (
    <span className="text-xs text-muted">
      {item.by ? <>by {item.by}</> : "added"}
      {when && /^\d{4}-\d{2}-\d{2}T/.test(when) ? <> · {timeAgo(when)}</> : when ? <> · {when}</> : null}
      {item.source && (
        <>
          {" "}
          · from{" "}
          {item.channelId ? (
            <a className="text-accent-text hover:underline" href={`#/c/${item.channelId}${item.messageId ? `/t/${item.messageId}` : ""}`}>
              {item.source}
            </a>
          ) : (
            item.source
          )}
        </>
      )}
    </span>
  );
}

function ItemRow({ item, canEdit, onSave, onForget }: { item: Item; canEdit: boolean; onSave: (body: object) => Promise<boolean>; onForget: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [due, setDue] = useState(item.due ?? "");
  const closed = item.status === "done" || item.status === "dropped";
  return (
    <div className="px-4 py-3">
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          {item.kind === "plan" && <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-44" aria-label="Due date" />}
          <div className="flex gap-2">
            <Button className="h-8" variant="primary" onClick={async () => (await onSave({ text, ...(item.kind === "plan" ? { due: due || null } : {}) })) && setEditing(false)}>
              Save
            </Button>
            <Button className="h-8" variant="ghost" onClick={() => (setEditing(false), setText(item.text))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className={cx("text-[15px]", closed && "line-through text-muted")}>{item.text}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {item.pinned && (
                <Pill tone="accent">
                  <Pin size={10} /> pinned
                </Pill>
              )}
              {item.kind === "plan" && <Pill tone={item.status === "active" ? "info" : "neutral"}>{item.status ?? "active"}</Pill>}
              {item.due && <Pill tone="warn">due {item.due}</Pill>}
              <Origin item={item} />
            </div>
          </div>
          {canEdit && (
            <div className="flex shrink-0 items-center">
              {item.kind === "plan" && (
                <IconButton onClick={() => onSave({ status: closed ? "active" : "done" })} icon={closed ? <RotateCcw size={15} /> : <Check size={15} />} label={closed ? "Reopen" : "Mark done"} />
              )}
              <IconButton onClick={() => onSave({ pinned: !item.pinned })} icon={item.pinned ? <PinOff size={15} /> : <Pin size={15} />} label={item.pinned ? "Unpin" : "Pin"} title={item.pinned ? "Unpin" : "Pin: always loaded first"} />
              <IconButton onClick={() => setEditing(true)} icon={<Pencil size={15} />} label="Edit" />
              <IconButton onClick={onForget} icon={<Trash2 size={15} />} label="Delete" tone="danger" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What you did, a day at a time. Each day is one note you can edit in Memory. */
function Journal({ items }: { items: Item[] }) {
  const days = [...new Set(items.map((i) => i.date ?? ""))].sort().reverse();
  return (
    <div className="space-y-4">
      {days.map((d) => {
        const entries = items.filter((i) => (i.date ?? "") === d);
        return (
          <div key={d}>
            <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-muted">
              {d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "Undated"}
              <a href={`#/vault/${entries[0].path}`} className="ml-auto inline-flex items-center gap-1 normal-case font-normal text-accent-text hover:underline">
                Edit day <ExternalLink size={11} />
              </a>
            </div>
            <div className="rounded-xl border border-line divide-y divide-line">
              {entries.map((i, n) => (
                <div key={n} className="px-4 py-2.5">
                  <div className="text-[15px]">{i.text}</div>
                  {i.by && <div className="text-xs text-muted">by {i.by}</div>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
