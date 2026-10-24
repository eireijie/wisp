import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Bug,
  Calculator,
  CalendarCheck,
  ClipboardList,
  Clock,
  Cloud,
  CloudCog,
  CreditCard,
  Database,
  Download,
  FileText,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Github,
  Globe,
  HardDrive,
  Inbox,
  KeyRound,
  ListOrdered,
  Mail,
  MessageSquare,
  MousePointerClick,
  Network,
  NotebookPen,
  NotebookText,
  Plug,
  Radar,
  Rocket,
  Scale,
  Search,
  Server,
  Sheet,
  Smile,
  SquareKanban,
  Telescope,
  Trello,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Agent } from "@warren/core";
import { AgentAvatar, harnessLabel, cx } from "./ui.tsx";

/** Icons the connector and skill catalogs name. */
const ICONS: Record<string, LucideIcon> = {
  BookOpen, Bug, Calculator, CalendarCheck, ClipboardList, Clock, Cloud, CloudCog, CreditCard, Database, Download, FileText, FolderOpen, GitBranch, GitPullRequest, Github, Globe,
  HardDrive, Inbox, KeyRound, ListOrdered, Mail, MessageSquare, MousePointerClick, Network, NotebookPen, NotebookText, Plug, Radar, Rocket, Scale, Search, Server, Sheet, Smile,
  SquareKanban, Telescope, Trello, Wand2, Zap,
};

/**
 * An app's real logo on a light tile (the registry's own icon, then its brand's from Simple Icons),
 * trying each address in turn. With none, a plain plug on a quiet tile: never a letter.
 */
export function AppLogo({ srcs, size = 48, className }: { srcs: (string | null | undefined)[]; size?: number; className?: string }) {
  const list = srcs.filter((s): s is string => !!s);
  const key = list.join(" ");
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [key]);
  const src = list[i];
  const radius = Math.round(size * 0.27);
  if (!src)
    return (
      <span className={cx("shrink-0 grid place-items-center bg-chip text-muted", className)} style={{ width: size, height: size, borderRadius: radius }} aria-hidden>
        <Plug size={Math.round(size * 0.42)} strokeWidth={1.8} />
      </span>
    );
  return (
    <span className={cx("shrink-0 grid place-items-center bg-white ring-1 ring-black/5 overflow-hidden", className)} style={{ width: size, height: size, borderRadius: radius }} aria-hidden>
      <img src={src} alt="" loading="lazy" className="object-contain" style={{ width: Math.round(size * 0.56), height: Math.round(size * 0.56) }} onError={() => setI((n) => n + 1)} />
    </span>
  );
}

/** A skill's tile: a plain line icon on a quiet tile (skills aren't brands). */
export function SkillTile({ icon, size = 48 }: { icon: ReactNode; size?: number }) {
  return (
    <span className="shrink-0 grid place-items-center bg-chip text-ink" style={{ width: size, height: size, borderRadius: Math.round(size * 0.27) }} aria-hidden>
      {icon}
    </span>
  );
}

export function CatalogIcon({ name, size = 18, fallback = Plug }: { name?: string; size?: number; fallback?: LucideIcon }) {
  const I = (name && ICONS[name]) || fallback;
  return <I size={size} />;
}

/** A tile for a catalog icon. */
export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("size-9 shrink-0 rounded-lg bg-accent-soft text-accent-text grid place-items-center", className)}>{children}</span>;
}

/** Pick which agents get something. `note` explains, per agent, a caveat (e.g. its harness isn't wired yet). */
export function AgentPicker({ agents, value, onChange, note, disabled, unavailable }: { agents: Agent[]; value: string[]; onChange: (ids: string[]) => void; note?: (a: Agent) => string | null; disabled?: boolean; unavailable?: (a: Agent) => boolean }) {
  if (!agents.length) return <p className="text-sm text-muted">No agents yet. Add one from the Agents page first.</p>;
  // agents that can't take part can't be picked; "all" means all of the rest
  const pickable = unavailable ? agents.filter((a) => !unavailable(a)) : agents;
  const all = pickable.length > 0 && pickable.every((a) => value.includes(a.id));
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button type="button" className="text-xs text-muted hover:text-ink disabled:opacity-50" disabled={disabled || pickable.length === 0} onClick={() => onChange(all ? [] : pickable.map((a) => a.id))}>
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line">
        {agents.map((a) => {
          const on = value.includes(a.id);
          const n = note?.(a);
          // can't be added, but a stale assignment can still be taken off
          const blocked = !on && !!unavailable?.(a);
          return (
            <label key={a.id} className={cx("flex items-center gap-3 px-3 py-2", blocked ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-hover/60", disabled && "pointer-events-none opacity-60")}>
              <input type="checkbox" checked={on} disabled={disabled || blocked} onChange={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])} />
              <AgentAvatar agent={a} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{a.name}</span>
                <span className="block text-xs text-muted truncate">
                  @{a.handle} · {harnessLabel(a.harness)}
                  {n && <span className="text-warn"> · {n}</span>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A row of small agent avatars, for "who has this". */
export function AgentStack({ agents, ids, max = 5 }: { agents: Agent[]; ids: string[]; max?: number }) {
  const shown = ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  if (!shown.length) return <span className="text-xs text-faint">No agents</span>;
  return (
    <span className="inline-flex items-center gap-1" title={shown.map((a) => `@${a.handle}`).join(", ")}>
      <span className="flex -space-x-1.5">
        {shown.slice(0, max).map((a) => (
          <AgentAvatar key={a.id} agent={a} size={22} />
        ))}
      </span>
      {shown.length > max && <span className="text-xs text-muted">+{shown.length - max}</span>}
      {shown.length === 1 && <span className="text-xs text-muted truncate">@{shown[0].handle}</span>}
    </span>
  );
}

/** Like Field, but not a <label>: for groups of controls (a label would forward clicks to the first one). */
export function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
