import { useState, type CSSProperties } from "react";
import { Check, ChevronDown, Link2, Plus } from "lucide-react";
import { useStore } from "../store.ts";
import { createOrg, joinOrg, orgInitials, orgSummary, orgTone, switchOrg, type Org } from "../orgs.ts";
import { Button, Field, GhostMark, Input, Modal, Popover, cx } from "./ui.tsx";

/**
 * An organization's tile: Warren's ghost for your first (personal) one, initials on a tile in a
 * color that comes from its id for the rest.
 */
export function OrgTile({ org, home, size = 40, round }: { org: Pick<Org, "id" | "name">; home?: boolean; size?: number; round?: boolean }) {
  const style: CSSProperties = { width: size, height: size, borderRadius: round ? size / 2 : size * 0.35, fontSize: Math.max(10, size * 0.36) };
  if (home)
    return (
      <span className="shrink-0 grid place-items-center bg-ink text-panel" style={style} aria-hidden>
        <GhostMark size={size * 0.55} />
      </span>
    );
  return (
    <span className="shrink-0 grid place-items-center font-extrabold text-white" style={{ ...style, background: `var(--org-${orgTone(org.id)})` }} aria-hidden>
      {orgInitials(org.name)}
    </span>
  );
}

/** Your organizations and which one is open; the first one the hub lists is your own (it gets the ghost). */
export function useOrgs(): { orgs: Org[]; current: Org | null; homeId: string | null } {
  const orgs = useStore((s) => s.orgs) ?? [];
  const me = useStore((s) => s.me);
  const current = orgs.find((o) => o.current) ?? orgs.find((o) => o.id === me?.workspace.id) ?? null;
  return { orgs, current, homeId: orgs[0]?.id ?? null };
}

/**
 * The organization's name at the top of the sidebar (or the Chats screen on phones). It opens a
 * menu of every organization you're in, plus New organization and Join with an invite link.
 */
export function OrgSwitcher({ large }: { large?: boolean }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const connected = useStore((s) => s.connected);
  const { orgs, current, homeId } = useOrgs();
  const [dialog, setDialog] = useState<"new" | "join" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sub = orgSummary({ members: Math.max(1, members.length), agents: agents.length });

  const pick = async (o: Org, close: () => void) => {
    if (o.current || o.id === me.workspace.id) return close();
    setBusy(o.id);
    try {
      await switchOrg(o.id);
    } catch (e) {
      setBusy(null);
      alert(`Couldn't switch: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <Popover
        up={false}
        className="w-72 p-1.5"
        trigger={(open, toggle) => (
          <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className={cx("w-full min-w-0 flex items-center gap-2 rounded-xl px-2 text-left hover:bg-side-hover", large ? "h-12" : "h-11", open && "bg-side-active")}>
            {large && current && <OrgTile org={current} home={current.id === homeId} size={32} />}
            <span className="flex-1 min-w-0">
              <span className={cx("block font-extrabold truncate", large ? "text-xl leading-tight" : "text-[15px]")}>{me.workspace.name}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                {!connected && <span className="size-1.5 rounded-full bg-faint animate-pulse" title="Reconnecting…" />}
                <span className="truncate">{connected ? sub : "Reconnecting…"}</span>
              </span>
            </span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        )}
      >
        {(close) => (
          <div role="menu" aria-label="Switch organization" className="flex flex-col gap-0.5">
            {orgs.map((o) => {
              const isCurrent = o.current || o.id === me.workspace.id;
              return (
                <button key={o.id} role="menuitem" disabled={!!busy} onClick={() => void pick(o, close)} className="flex items-center gap-2.5 h-12 px-2.5 rounded-xl text-left hover:bg-hover disabled:opacity-60">
                  <span className="relative">
                    <OrgTile org={o} home={o.id === homeId} size={30} />
                    {o.unread && !isCurrent && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-bad ring-2 ring-panel" aria-label="New messages" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-bold truncate">{o.name}</span>
                    <span className="block text-xs text-muted truncate">{busy === o.id ? "Switching…" : orgSummary(o)}</span>
                  </span>
                  {isCurrent && <Check size={16} strokeWidth={2.4} className="shrink-0" aria-label="Current" />}
                </button>
              );
            })}
            <div className="h-px bg-line mx-1.5 my-1" />
            <button role="menuitem" onClick={() => (close(), setDialog("new"))} className="flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-sm font-bold text-left hover:bg-hover">
              <Plus size={16} /> New organization
            </button>
            <button role="menuitem" onClick={() => (close(), setDialog("join"))} className="flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-sm font-bold text-left hover:bg-hover">
              <Link2 size={16} /> Join with an invite link
            </button>
          </div>
        )}
      </Popover>
      {dialog === "new" && <NewOrgDialog onClose={() => setDialog(null)} />}
      {dialog === "join" && <JoinOrgDialog onClose={() => setDialog(null)} />}
    </>
  );
}

/** Name it, make it, and you're in it. */
export function NewOrgDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [start, setStart] = useState<"simple" | "everything">("simple");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New organization" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await createOrg(name, start);
          } catch (err) {
            setBusy(false);
            setError((err as Error).message);
          }
        }}
      >
        <p className="text-sm text-muted">A separate place with its own agents, channels and memory. You can switch between organizations any time.</p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" maxLength={60} />
        </Field>
        <Field label="Start with" hint={start === "simple" ? "Just chat, agents and memory. Turn on more in Mods." : "Every feature on: teams, tasks, routines, voice and more."}>
          <div role="radiogroup" aria-label="Start with" className="flex rounded-xl bg-chip p-0.5">
            {(
              [
                ["simple", "Simple"],
                ["everything", "Advanced"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={start === id} onClick={() => setStart(id)} className={cx("flex-1 h-8 rounded-[10px] text-[13px] font-semibold", start === id ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Paste the link someone sent you (or just its code). */
export function JoinOrgDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Join with an invite link" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!code.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await joinOrg(code);
          } catch (err) {
            setBusy(false);
            setError((err as Error).message);
          }
        }}
      >
        <p className="text-sm text-muted">Paste the invite link someone sent you, or its code. You'll keep the organizations you're already in.</p>
        <Field label="Invite link or code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://…/#/join/…" />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!code.trim() || busy}>
            {busy ? "Joining…" : "Join"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
