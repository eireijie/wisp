import type { ReactNode } from "react";
import {
  BookOpen,
  Bug,
  Calculator,
  CalendarCheck,
  ChevronLeft,
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
import { AgentAvatar, HARNESS_LABELS, cx } from "./ui.tsx";

/** Icons the connector and skill catalogs name. */
const ICONS: Record<string, LucideIcon> = {
  BookOpen, Bug, Calculator, CalendarCheck, ClipboardList, Clock, Cloud, CloudCog, CreditCard, Database, Download, FileText, FolderOpen, GitBranch, GitPullRequest, Github, Globe,
  HardDrive, Inbox, KeyRound, ListOrdered, Mail, MessageSquare, MousePointerClick, Network, NotebookPen, NotebookText, Plug, Radar, Rocket, Scale, Search, Server, Sheet, Smile,
  SquareKanban, Telescope, Trello, Wand2, Zap,
};

export function CatalogIcon({ name, size = 18, fallback = Plug }: { name?: string; size?: number; fallback?: LucideIcon }) {
  const I = (name && ICONS[name]) || fallback;
  return <I size={size} />;
}

/** A tile for a catalog icon. */
export function IconTile({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("size-9 shrink-0 rounded-lg bg-accent-soft text-accent-text grid place-items-center", className)}>{children}</span>;
}

/** Title, one line on what the page is for, and an action. */
export function ShopHeader({ title, onBack, action }: { title: string; onBack?: () => void; action?: ReactNode }) {
  return (
    <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
      {onBack && (
        <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
          <ChevronLeft size={22} />
        </button>
      )}
      <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">{title}</h1>
      {action}
    </header>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-full sm:w-72">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-lg border border-input bg-transparent pl-9 pr-3 text-sm outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30"
      />
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="flex items-center gap-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx("relative h-9 px-2 text-sm font-medium", value === t.id ? "text-ink after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-ink")}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-xs text-faint tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Pick which agents get something. `note` explains, per agent, a caveat (e.g. its harness isn't wired yet). */
export function AgentPicker({ agents, value, onChange, note, disabled }: { agents: Agent[]; value: string[]; onChange: (ids: string[]) => void; note?: (a: Agent) => string | null; disabled?: boolean }) {
  if (!agents.length) return <p className="text-sm text-muted">No agents yet. Add one from the Agents page first.</p>;
  const all = agents.every((a) => value.includes(a.id));
  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button type="button" className="text-xs text-muted hover:text-ink disabled:opacity-50" disabled={disabled} onClick={() => onChange(all ? [] : agents.map((a) => a.id))}>
          {all ? "Clear" : "Select all"}
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line">
        {agents.map((a) => {
          const on = value.includes(a.id);
          const n = note?.(a);
          return (
            <label key={a.id} className={cx("flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-hover/60", disabled && "pointer-events-none opacity-60")}>
              <input type="checkbox" checked={on} disabled={disabled} onChange={() => onChange(on ? value.filter((x) => x !== a.id) : [...value, a.id])} />
              <AgentAvatar agent={a} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{a.name}</span>
                <span className="block text-xs text-muted truncate">
                  @{a.handle} · {HARNESS_LABELS[a.harness]}
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
