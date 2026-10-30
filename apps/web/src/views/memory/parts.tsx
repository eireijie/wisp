import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, PencilLine, X } from "lucide-react";
import { personDir, type Agent } from "@wisp/core";
import { useStore, type Member } from "../../store.ts";
import { AgentAvatar, GhostMark, Modal, UserAvatar, cx } from "../../components/ui.tsx";

/** Phone-width screens: pages take turns, with a back circle on top. */
export function useIsPhone() {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export const baseName = (p: string) => p.split("/").pop()!;
export const noteName = (p: string) => baseName(p).replace(/\.md$/i, "");
export const isNotePath = (p: string) => /\.md$/i.test(p);

/** A capsule button like the mockups: a glass-ish control, or the filled primary. */
export const pill = "inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-full border border-control-line bg-control text-sm font-medium text-ink whitespace-nowrap transition-colors hover:bg-hover disabled:opacity-50 disabled:pointer-events-none outline-none focus-visible:ring-3 focus-visible:ring-ring/40";
export const pillPrimary = "inline-flex items-center justify-center gap-1.5 h-10 px-5 rounded-full bg-accent text-accent-ink text-sm font-medium whitespace-nowrap transition-colors hover:bg-accent/90 disabled:opacity-50 disabled:pointer-events-none outline-none focus-visible:ring-3 focus-visible:ring-ring/40";
export const pillDanger = "inline-flex items-center justify-center gap-1.5 h-10 px-5 rounded-full bg-bad text-white text-sm font-medium whitespace-nowrap transition-colors hover:opacity-90 disabled:opacity-50 outline-none";
export const field = "h-11 w-full rounded-2xl border border-control-line bg-control px-4 text-body text-ink outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30";

/** The little uppercase label above a group of cards. */
export function Overline({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-6 px-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted">
      <span className="flex-1">{children}</span>
      {action}
    </div>
  );
}

/** A rounded card holding rows divided by hairlines. */
export function Cards({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-3xl bg-card overflow-hidden divide-y divide-line", className)}>{children}</div>;
}

export function Radio({ on, square }: { on: boolean; square?: boolean }) {
  return (
    <span aria-hidden className={cx("size-6 shrink-0 grid place-items-center border-2", square ? "rounded-md" : "rounded-full", on ? "bg-info border-info text-white" : "border-faint/60")}>
      {on && (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
    </span>
  );
}

/** The phone page header: a back circle, the name in a pill, and one more circle. */
export function PhoneBar({ title, onBack, trailing, close }: { title: string; onBack?: () => void; trailing?: ReactNode; close?: boolean }) {
  return (
    <header className="shrink-0 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 flex items-center gap-3">
      {onBack ? (
        <button onClick={onBack} className="circle" aria-label={close ? "Close" : "Back"}>
          {close ? <X size={20} /> : <ChevronLeft size={22} />}
        </button>
      ) : (
        <span className="size-[52px]" />
      )}
      <h1 className="flex-1 min-w-0 flex justify-center">
        <span className="truncate max-w-full h-11 px-5 inline-flex items-center rounded-full border border-control-line bg-control text-body font-medium">{title}</span>
      </h1>
      {trailing ?? <span className="size-[52px]" />}
    </header>
  );
}

/** A dialog: centered card on desktops, a sheet from the bottom on phones. Title and a close circle on top. */
export function MemoryDialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <Modal title={title} onClose={onClose} headerless wide={wide} className="sm:max-w-[560px]! rounded-t-[16px]! sm:rounded-xl! max-h-[94vh]! bg-panel">
      <div className="flex items-center gap-3 pt-5 pb-3 sticky top-0 bg-panel z-10">
        <h2 className="t-title flex-1">{title}</h2>
        <button onClick={onClose} className="circle" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      {children}
      {footer && <div className="mt-6 flex justify-center sm:justify-end gap-2">{footer}</div>}
    </Modal>
  );
}

/** A confirmation: icon, question, one red action and a way out. */
export function ConfirmCard({ icon, title, children, action, keep = "Keep it", onAction, onClose, busy }: { icon: ReactNode; title: string; children: ReactNode; action: string; keep?: string; onAction: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Modal title={title} onClose={onClose} headerless className="sm:max-w-[420px]! rounded-xl! m-4 sm:m-0 self-center">
      <div className="pt-6">
        <span className="size-12 rounded-2xl bg-bad/15 text-bad grid place-items-center">{icon}</span>
        <h2 className="t-title mt-4">{title}</h2>
        <div className="mt-2 text-body text-muted leading-relaxed">{children}</div>
        <div className="mt-5 space-y-2.5">
          <button onClick={onAction} disabled={busy} className={cx(pillDanger, "w-full h-12")}>
            {action}
          </button>
          <button onClick={onClose} className={cx(pill, "w-full h-12 bg-card")}>
            {keep}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Who made a change: an agent (by its @handle), Obsidian, Wisp itself, or a person. */
export function whoIs(author: string, agents: Agent[], members: Member[], size = 28): { name: string; avatar: ReactNode; agent?: Agent } {
  const agent = author.startsWith("@") ? agents.find((a) => `@${a.handle}` === author) : agents.find((a) => a.name === author);
  if (agent) return { name: agent.name, agent, avatar: <AgentAvatar agent={agent} size={size} interactive={false} /> };
  if (author === "Edited in Obsidian")
    return { name: "Obsidian", avatar: <span className="shrink-0 rounded-full bg-chip grid place-items-center text-muted" style={{ width: size, height: size }}><PencilLine size={size * 0.5} /></span> };
  if (author === "Wisp" || author === "Warren")
    return { name: "Wisp", avatar: <span className="shrink-0 rounded-full bg-chip grid place-items-center text-muted" style={{ width: size, height: size }}><GhostMark size={size * 0.55} /></span> };
  return { name: author, avatar: <UserAvatar name={author} size={size} /> };
}

/** "agents/agt_x" → "Ghosty's notes", "people/<me>" → "My notes", plain folders as written. */
export function useFolderLabel() {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const meId = useStore((s) => s.me?.user.id);
  return (seg: string): string => {
    const m = seg.match(/^(agents|people)\/(.+)$/);
    if (m) {
      if (m[1] === "agents") {
        const a = agents.find((x) => x.id === m[2]);
        return a ? `${a.name}'s notes` : m[2]!;
      }
      if (m[2] === meId) return "My notes";
      const p = members.find((x) => x.id === m[2]);
      return p ? `${p.name}'s notes` : m[2]!;
    }
    const top: Record<string, string> = { shared: "Shared", teams: "Teams", groups: "Groups", people: "People", agents: "Agents" };
    return top[seg] ?? seg;
  };
}

/** A path's folders, with "agents/<id>" and "people/<id>" kept as one step ("Ghosty's notes"). */
export function folderSteps(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  if ((parts[0] === "agents" || parts[0] === "people") && parts.length > 1) return [`${parts[0]}/${parts[1]}`, ...parts.slice(2)];
  return parts;
}

export const keepMine = (meId: string | undefined) => (meId ? personDir(meId) : "shared");
