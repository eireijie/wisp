import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronLeft, ExternalLink, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href } from "../router.ts";
import { Empty, Input, Menu, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { Cards, Overline, PhoneBar, pill, pillDanger, pillPrimary, useIsPhone } from "./memory/parts.tsx";

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
export function AboutView({ onBack, embedded }: { onBack?: () => void; embedded?: boolean }) {
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

  const phone = useIsPhone();
  const addRef = useRef<HTMLInputElement>(null);
  const subtitle = isMe ? "What your helpers should know about you. Agents add these as you talk with them." : `What helpers should know about ${profile?.person.name ?? "them"}.`;
  const owner = me.role === "owner" && members.length > 1;
  const who = owner && (
    <label className="inline-flex items-center gap-2 h-11 px-4 rounded-full border border-control-line bg-control text-sm font-medium">
      Whose memory:
      <select value={userId} onChange={(e) => setUserId(e.target.value)} className="bg-transparent outline-none font-medium" aria-label="Whose memory">
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === me.user.id ? "You" : m.name}
          </option>
        ))}
      </select>
    </label>
  );
  const sorted = [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.status === "done" || a.status === "dropped") - Number(b.status === "done" || b.status === "dropped"));
  const list = (xs: Item[]) => (
    <Cards>
      {xs.map((i) => (
        <ItemRow key={i.path} item={i} canEdit={canEdit} phone={phone} onSave={(body) => remember({ kind: i.kind, replaces: i.path, ...body })} onForget={() => forget(i)} />
      ))}
    </Cards>
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {phone ? (
        <PhoneBar title={isMe ? "About you" : `About ${profile?.person.name ?? "…"}`} onBack={onBack} trailing={canEdit ? (
          <button className="circle" aria-label="Add something" onClick={() => addRef.current?.focus()}>
            <Plus size={20} />
          </button>
        ) : undefined} />
      ) : !embedded ? (
        <header className="shrink-0 h-[72px] px-6 flex items-center gap-2">
          {onBack && (
            <button className="circle circle-sm" onClick={onBack} aria-label="Back">
              <ChevronLeft size={20} />
            </button>
          )}
          <span className="flex-1 text-[14px] text-muted">Memory</span>
        </header>
      ) : (
        <div className="shrink-0 h-[72px] px-6 flex items-center text-[14px] font-medium">Memory</div>
      )}
      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-28">
        <div className="mx-auto max-w-[720px]">
          {!phone && (
            <div className="mt-2 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="t-title">{isMe ? "About you" : `About ${profile?.person.name ?? "…"}`}</h2>
                <p className="mt-1 text-sm text-muted">{subtitle}</p>
              </div>
            </div>
          )}
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] -mx-4 px-4 md:mx-0 md:px-0 flex-1" role="tablist">
              {TABS.map((t) => (
                <button key={t.kind} role="tab" aria-selected={tab === t.kind} onClick={() => { setTab(t.kind); setAddKind(t.kind); }} className={cx("h-10 px-4 rounded-full text-[14px] font-medium whitespace-nowrap shrink-0", tab === t.kind ? "bg-accent text-accent-ink" : "bg-card text-ink/85 hover:bg-hover")}>
                  {t.label}
                  <span className="ml-1.5 opacity-60 tabular-nums">{profile?.items.filter((i) => i.kind === t.kind && (t.kind !== "plan" || i.status === "active")).length ?? ""}</span>
                </button>
              ))}
            </div>
            {!phone && who}
          </div>
          {phone && who && <div className="mt-3">{who}</div>}

          {canEdit && (
            <form
              className="mt-4 rounded-3xl bg-card p-3 flex flex-wrap items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!draft.trim()) return;
                if (await remember({ kind: addKind, text: draft.trim(), ...(addKind === "plan" && due ? { due } : {}) })) {
                  setDraft("");
                  setDue("");
                }
              }}
            >
              <input
                ref={addRef}
                className="flex-1 min-w-48 h-10 bg-transparent px-2 text-body outline-none placeholder:text-faint"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={isMe ? "What would you like your helper to remember?" : TABS.find((t) => t.kind === addKind)!.add}
                aria-label="What would you like your helper to remember?"
              />
              <select value={addKind} onChange={(e) => setAddKind(e.target.value as Kind)} aria-label="Category" className="h-9 rounded-full bg-chip px-3 text-[13px] font-medium outline-none">
                {TABS.map((t) => (
                  <option key={t.kind} value={t.kind}>
                    {t.label}
                  </option>
                ))}
              </select>
              {addKind === "plan" && <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-9 rounded-full bg-chip px-3 text-[13px] outline-none" aria-label="Due date" />}
              <button className={pillPrimary} disabled={!draft.trim()}>
                Add
              </button>
            </form>
          )}
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}

          {!profile ? (
            <p className="mt-6 text-sm text-muted px-1">Loading…</p>
          ) : items.length === 0 ? (
            <div className="mt-6">
              <Empty icon={<Brain />} title={`No ${current.label.toLowerCase()} yet`}>
                <p>{current.empty}</p>
                <p>Agents add these as you talk with them, and you can add your own above.</p>
              </Empty>
            </div>
          ) : tab === "did" ? (
            <Journal items={items} />
          ) : tab === "plan" ? (
            <>
              {sorted.some((i) => i.status !== "done" && i.status !== "dropped") && (
                <>
                  <Overline>Coming up</Overline>
                  {list(sorted.filter((i) => i.status !== "done" && i.status !== "dropped"))}
                </>
              )}
              {sorted.some((i) => i.status === "done" || i.status === "dropped") && (
                <>
                  <Overline>Done</Overline>
                  {list(sorted.filter((i) => i.status === "done" || i.status === "dropped"))}
                </>
              )}
            </>
          ) : (
            <>
              <Overline>{current.label}</Overline>
              {list(sorted)}
            </>
          )}
          <p className="mt-4 px-1 text-xs text-muted leading-relaxed">
            Every helper reads this before it works, so you don't have to repeat yourself. Edit or delete anything that is wrong; it applies from the next message. It's saved as plain notes in{" "}
            <a className="text-accent-text underline underline-offset-2" href={href({ view: "vault", path: null })}>
              Memory
            </a>
            . How Wisp itself behaves is in{" "}
            <a className="text-accent-text underline underline-offset-2" href={href({ view: "settings", page: "preferences" })}>
              Settings
            </a>
            , and your name and time zone are in{" "}
            <a className="text-accent-text underline underline-offset-2" href={href({ view: "settings", page: "profile" })}>
              Profile
            </a>
            .
          </p>
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

function ItemRow({ item, canEdit, phone, onSave, onForget }: { item: Item; canEdit: boolean; phone: boolean; onSave: (body: object) => Promise<boolean>; onForget: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [due, setDue] = useState(item.due ?? "");
  const closed = item.status === "done" || item.status === "dropped";
  return (
    <div className="px-4 py-3.5">
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          {item.kind === "plan" && <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-44" aria-label="Due date" />}
          <div className="flex gap-2">
            <button className={cx(pillPrimary, "h-9")} onClick={async () => (await onSave({ text, ...(item.kind === "plan" ? { due: due || null } : {}) })) && setEditing(false)}>
              Save
            </button>
            <button className={cx(pill, "h-9")} onClick={() => (setEditing(false), setText(item.text))}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className={cx("text-body font-medium", closed && "line-through text-muted")}>{item.text}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {item.pinned && (
                <Pill tone="accent">
                  <Pin size={10} /> pinned
                </Pill>
              )}
              {item.kind === "plan" && item.status && item.status !== "active" && <Pill tone="neutral">{item.status}</Pill>}
              {item.due && <Pill tone="warn">due {item.due}</Pill>}
              <Origin item={item} />
            </div>
          </div>
          {canEdit &&
            (phone ? (
              <Menu
                align="right"
                trigger={(_o, toggle) => (
                  <button onClick={toggle} className="size-10 grid place-items-center text-muted" aria-label="More for this item">
                    <MoreHorizontal size={20} />
                  </button>
                )}
                items={[
                  ...(item.kind === "plan" ? [{ label: closed ? "Reopen" : "Mark done", icon: closed ? <RotateCcw size={16} /> : <Check size={16} />, onSelect: () => onSave({ status: closed ? "active" : "done" }) }] : []),
                  { label: item.pinned ? "Unpin" : "Pin", icon: item.pinned ? <PinOff size={16} /> : <Pin size={16} />, onSelect: () => onSave({ pinned: !item.pinned }) },
                  { label: "Edit", icon: <Pencil size={16} />, onSelect: () => setEditing(true) },
                  { label: "Delete", icon: <Trash2 size={16} />, danger: true, onSelect: onForget },
                ]}
              />
            ) : (
              <div className="flex shrink-0 items-center gap-2">
                {item.kind === "plan" && (
                  <button className={cx(pill, "h-9 px-3.5")} onClick={() => onSave({ status: closed ? "active" : "done" })}>
                    {closed ? "Reopen" : "Mark done"}
                  </button>
                )}
                <button className="size-9 grid place-items-center rounded-full text-muted hover:bg-hover" onClick={() => onSave({ pinned: !item.pinned })} aria-label={item.pinned ? "Unpin" : "Pin"} title={item.pinned ? "Unpin" : "Pin: always loaded first"}>
                  {item.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button className={cx(pill, "h-9 px-3.5")} onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button className="h-9 px-3.5 rounded-full border border-control-line bg-control text-[14px] font-medium text-bad hover:bg-hover" onClick={onForget}>
                  Delete
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** What you did, a day at a time. Each day is one note you can edit in Memory. */
function Journal({ items }: { items: Item[] }) {
  const days = [...new Set(items.map((i) => i.date ?? ""))].sort().reverse();
  return (
    <div>
      {days.map((d) => {
        const entries = items.filter((i) => (i.date ?? "") === d);
        return (
          <div key={d}>
            <Overline
              action={
                <a href={`#/vault/${entries[0].path}`} className="inline-flex items-center gap-1 normal-case tracking-normal text-[13px] font-medium text-accent-text">
                  Edit day <ExternalLink size={11} />
                </a>
              }
            >
              {d ? new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "Undated"}
            </Overline>
            <Cards>
              {entries.map((i, n) => (
                <div key={n} className="px-4 py-3">
                  <div className="text-body">{i.text}</div>
                  {i.by && <div className="text-xs text-muted">by {i.by}</div>}
                </div>
              ))}
            </Cards>
          </div>
        );
      })}
    </div>
  );
}
