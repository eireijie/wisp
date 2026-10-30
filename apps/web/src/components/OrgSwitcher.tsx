import { useState } from "react";
import { Building2, Check, Link2, Plus } from "lucide-react";
import { useStore } from "../store.ts";
import { createOrg, joinOrg, orgSummary, switchOrg, type Org } from "../orgs.ts";
import { Button, Field, Input, Modal, cx } from "./ui.tsx";

/** An organization's tile: a neutral rounded square with a line building, never a colored letter. */
export function OrgTile({ size = 36 }: { org?: Pick<Org, "id" | "name">; home?: boolean; size?: number; round?: boolean }) {
  return (
    <span className="shrink-0 grid place-items-center bg-chip text-muted" style={{ width: size, height: size, borderRadius: size * 0.3 }} aria-hidden>
      <Building2 size={size * 0.55} strokeWidth={1.7} />
    </span>
  );
}

/** Your organizations and which one is open; the first one the hub lists is your own. */
export function useOrgs(): { orgs: Org[]; current: Org | null; homeId: string | null } {
  const orgs = useStore((s) => s.orgs) ?? [];
  const me = useStore((s) => s.me);
  const current = orgs.find((o) => o.current) ?? orgs.find((o) => o.id === me?.workspace.id) ?? null;
  return { orgs, current, homeId: orgs[0]?.id ?? null };
}

const ROLE = { owner: "Owner", member: "Member", guest: "Guest" } as const;

/**
 * Every organization you're in (the open one has a blue check), New organization, and a field to
 * join one with an invite link or code. Shown as a popover beside the rail on desktops and as a
 * sheet on phones.
 */
export function OrgList({ onDone, onNewOrg }: { onDone: () => void; onNewOrg?: () => void }) {
  const me = useStore((s) => s.me)!;
  const { orgs } = useOrgs();
  const [busy, setBusy] = useState<string | null>(null);
  const [newOrg, setNewOrg] = useState(false);
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a hub without organizations lists none: then it's just this one
  const list: Pick<Org, "id" | "name" | "role" | "current" | "unread">[] = orgs.length ? orgs : [{ id: me.workspace.id, name: me.workspace.name, role: me.role, current: true, unread: false }];

  const pick = async (o: (typeof list)[number]) => {
    if (o.current || o.id === me.workspace.id) return onDone();
    setBusy(o.id);
    try {
      await switchOrg(o.id);
    } catch (e) {
      setBusy(null);
      alert(`Couldn't switch: ${(e as Error).message}`);
    }
  };
  const join = async () => {
    if (!code.trim() || joining) return;
    setJoining(true);
    setError(null);
    try {
      await joinOrg(code);
    } catch (e) {
      setJoining(false);
      setError((e as Error).message);
    }
  };

  const row = "w-full flex items-center gap-3 min-h-11 px-3.5 rounded-xl text-left text-body hover:bg-hover";
  return (
    <div role="menu" aria-label="Switch organization" className="py-1.5">
      <div className="px-3.5 pt-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-faint">Organizations</div>
      {list.map((o) => {
        const isCurrent = o.current || o.id === me.workspace.id;
        return (
          <button key={o.id} role="menuitem" disabled={!!busy} onClick={() => void pick(o)} className={cx(row, "min-h-[54px] disabled:opacity-60")}>
            <span className="relative">
              <OrgTile size={36} />
              {o.unread && !isCurrent && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-badge ring-2 ring-panel" aria-label="New messages" />}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-medium truncate">{o.name}</span>
              <span className="block text-xs text-faint truncate">{busy === o.id ? "Switching…" : ROLE[o.role]}</span>
            </span>
            {isCurrent && <Check size={18} strokeWidth={2.2} className="shrink-0 text-badge" aria-label="Current" />}
          </button>
        );
      })}
      <div className="h-px bg-line mx-2 my-1.5" />
      <button role="menuitem" onClick={() => (onNewOrg ? onNewOrg() : setNewOrg(true))} className={row}>
        <Plus size={20} strokeWidth={1.7} className="text-muted" />
        <span className="flex-1">New organization</span>
      </button>
      <div className={cx(row, "hover:bg-transparent pointer-events-none")}>
        <Link2 size={20} strokeWidth={1.7} className="text-muted" />
        <span className="flex-1">Join with an invite link</span>
      </div>
      <form
        className="px-2.5 pb-1.5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Invite link or code" placeholder="https://…/#/join/…" className="flex-1 min-w-0 h-10 rounded-full bg-chip px-4 text-sm outline-none placeholder:text-faint border border-control-line focus:border-ring" />
        <button disabled={!code.trim() || joining} className="h-10 px-5 rounded-full bg-accent text-accent-ink text-sm font-medium disabled:opacity-50">
          {joining ? "Joining…" : "Join"}
        </button>
      </form>
      {error && <p className="px-3.5 pb-2 text-sm text-bad">{error}</p>}
      {newOrg && <NewOrgDialog onClose={() => setNewOrg(false)} />}
    </div>
  );
}

/** The organization list in a dialog, opened from "Switch organization" in the desktop avatar menu. */
export function OrgSwitcherDialog({ onClose }: { onClose: () => void }) {
  // New organization is its own dialog, a sibling of this one rather than a child: both are portaled.
  const [newOrg, setNewOrg] = useState(false);
  if (newOrg) return <NewOrgDialog onClose={onClose} />;
  return (
    <Modal title="Switch organization" onClose={onClose}>
      <div className="-mx-2">
        <OrgList onDone={onClose} onNewOrg={() => setNewOrg(true)} />
      </div>
    </Modal>
  );
}

/** Name it, make it, and you're in it. */
export function NewOrgDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
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
            await createOrg(name);
          } catch (err) {
            setBusy(false);
            setError((err as Error).message);
          }
        }}
      >
        <p className="text-sm text-muted">A separate place with its own agents, teams and memory. You can switch between organizations any time.</p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Studio" maxLength={60} />
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
