import type { ReactNode } from "react";
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
  Users,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Agent } from "@wisp/core";
import { AgentAvatar, harnessLabel } from "./ui.tsx";
import { Item, Panel, Switch, Tile } from "./MarketParts.tsx";

/** Icons the connector and skill catalogs name. */
const ICONS: Record<string, LucideIcon> = {
  BookOpen, Bug, Calculator, CalendarCheck, ClipboardList, Clock, Cloud, CloudCog, CreditCard, Database, Download, FileText, FolderOpen, GitBranch, GitPullRequest, Github, Globe,
  HardDrive, Inbox, KeyRound, ListOrdered, Mail, MessageSquare, MousePointerClick, Network, NotebookPen, NotebookText, Plug, Radar, Rocket, Scale, Search, Server, Sheet, Smile,
  SquareKanban, Telescope, Trello, Wand2, Zap,
};

/** A skill's tile: a plain line icon on a quiet tile (skills aren't brands). */
export function SkillTile({ icon, size = 48 }: { icon: ReactNode; size?: number }) {
  return <Tile size={size}>{icon}</Tile>;
}

export function CatalogIcon({ name, size = 18, fallback = Plug }: { name?: string; size?: number; fallback?: LucideIcon }) {
  const I = (name && ICONS[name]) || fallback;
  return <I size={size} />;
}

/**
 * Pick which agents get something: a card with a switch per agent. `note` explains, per agent, a
 * caveat (e.g. its harness isn't wired yet); `unavailable` agents can't be added.
 */
export function AgentPicker({ agents, value, onChange, note, disabled, unavailable, allAgents }: { agents: Agent[]; value: string[]; onChange: (ids: string[]) => void; note?: (a: Agent) => string | null; disabled?: boolean; unavailable?: (a: Agent) => boolean; allAgents?: { on: boolean; onChange: (on: boolean) => void } }) {
  // "All agents" (every agent, and ones made later) replaces the per-agent switches while it's on
  const allRow = allAgents && (
    <Panel>
      <Item icon={<span className="grid size-[30px] place-items-center text-muted"><Users size={18} strokeWidth={1.7} /></span>} title="All agents" right={<Switch on={allAgents.on} label="All agents" disabled={disabled} onChange={allAgents.onChange} />} />
    </Panel>
  );
  if (allAgents?.on) return <div className="space-y-1.5">{allRow}</div>;
  if (!agents.length) return allRow ? <div className="space-y-1.5">{allRow}</div> : <p className="text-sm text-muted">No agents yet. Add one from the Agents page first.</p>;
  // agents that can't take part can't be picked; "all" means all of the rest
  const pickable = unavailable ? agents.filter((a) => !unavailable(a)) : agents;
  const all = pickable.length > 0 && pickable.every((a) => value.includes(a.id));
  return (
    <div className="space-y-1.5">
      {allRow}
      {agents.length > 1 && !allRow && (
        <div className="flex justify-end px-1">
          <button type="button" className="text-[13px] text-muted hover:text-ink disabled:opacity-50" disabled={disabled || pickable.length === 0} onClick={() => onChange(all ? [] : pickable.map((a) => a.id))}>
            {all ? "Clear" : "Select all"}
          </button>
        </div>
      )}
      <Panel className="max-h-72 overflow-y-auto">
        {agents.map((a) => {
          const on = value.includes(a.id);
          const n = note?.(a);
          // can't be added, but a stale assignment can still be taken off
          const blocked = !on && !!unavailable?.(a);
          return (
            <Item
              key={a.id}
              icon={<AgentAvatar agent={a} size={30} />}
              title={a.name}
              sub={
                <>
                  @{a.handle} · {harnessLabel(a.harness)}
                  {n && <span className="text-warn"> · {n}</span>}
                </>
              }
              right={<Switch on={on} label={a.name} disabled={disabled || blocked} onChange={(v) => onChange(v ? [...value, a.id] : value.filter((x) => x !== a.id))} />}
            />
          );
        })}
      </Panel>
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
