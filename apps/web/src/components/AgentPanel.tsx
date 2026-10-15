import { useEffect, useState, type ReactNode } from "react";
import { Activity, BookOpen, ChevronRight, Cpu, Eye, ExternalLink, Ghost as GhostIcon, Hand, HandMetal, LayoutGrid, ListChecks, Loader2, Maximize2, Minimize2, Monitor, Phone, Plug, ScrollText, Server, Shield, Sparkles, X } from "lucide-react";
import type { Agent } from "@warren/core";
import { soulPath } from "@warren/core/src/soul.ts";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, type AgentTab } from "../router.ts";
import { useComputerState } from "../views/ComputersView.tsx";
import { LiveScreen, WorkingBadge } from "./Screen.tsx";
import { Ghost } from "./Ghost.tsx";
import { prettyModel, effortName } from "./EffortSlider.tsx";
import { AgentAvatar, AGENT_STATUS, Button, HARNESS_LABELS, Pill, cx, timeAgo } from "./ui.tsx";

export type AgentPanelTab = "details" | "computer" | "settings";

const ACCESS_LABEL = { "read-only": "Read only", edit: "Can edit files", full: "Full access" } as const;

/** Every section of the agent's full page, so nothing is more than two clicks from the chat. */
const SECTIONS: { id: AgentTab; label: string; body: string; icon: ReactNode }[] = [
  { id: "look", label: "Look", body: "Its ghost's shape and colors", icon: <GhostIcon size={16} /> },
  { id: "soul", label: "Soul", body: "Personality and what it remembers about itself", icon: <Sparkles size={16} /> },
  { id: "instructions", label: "Instructions", body: "How it should work", icon: <ScrollText size={16} /> },
  { id: "model", label: "Model", body: "Model, effort and fast mode", icon: <Cpu size={16} /> },
  { id: "device", label: "Device", body: "Where its harness runs", icon: <Server size={16} /> },
  { id: "computer", label: "Computer", body: "Which computer it uses", icon: <Monitor size={16} /> },
  { id: "routines", label: "Routines", body: "Tasks it does on a schedule", icon: <ListChecks size={16} /> },
  { id: "permissions", label: "Permissions", body: "What it may do without asking", icon: <Shield size={16} /> },
  { id: "connect", label: "Connect", body: "Apps and connectors", icon: <Plug size={16} /> },
  { id: "runs", label: "Runs", body: "Everything it's done lately", icon: <Activity size={16} /> },
];

/**
 * The agent beside its DM: who it is, its computer live, and the way into every setting. Kept
 * to three tabs so the chat stays the main thing.
 */
export function AgentPanel({ agent, tab, onTab, onClose, onCall }: { agent: Agent; tab: AgentPanelTab; onTab: (t: AgentPanelTab) => void; onClose: () => void; onCall: () => void }) {
  const tabs: { id: AgentPanelTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "computer", label: "Computer" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <aside className="fixed inset-0 z-40 bg-bg lg:static lg:z-auto lg:w-[380px] shrink-0 border-l border-line flex flex-col min-h-0 safe-top" aria-label={`${agent.name}'s details`}>
      <div className="flex justify-end gap-1.5 px-3 pt-3">
        <button onClick={() => go({ view: "agents", agentId: agent.id, tab: "overview" })} className="size-9 rounded-full border border-line grid place-items-center text-muted hover:text-ink hover:bg-hover" aria-label="Open its full page" title="Open its full page">
          <ExternalLink size={16} />
        </button>
        <button onClick={onClose} className="size-9 rounded-full border border-line grid place-items-center text-muted hover:text-ink hover:bg-hover" aria-label="Close" title="Close">
          <X size={17} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
        <div className="flex flex-col items-center text-center pt-1">
          <AgentAvatar agent={agent} size={84} live />
          <h2 className="mt-3 text-xl font-semibold">{agent.name}</h2>
          <RoleLabel agent={agent} />
        </div>
        <nav className="mt-5 flex justify-center gap-1" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)} className={cx("h-9 px-3.5 rounded-full text-sm", tab === t.id ? "bg-chip text-ink font-medium" : "text-muted hover:text-ink")}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="mt-5">
          {tab === "details" && <Details agent={agent} onCall={onCall} />}
          {tab === "computer" && <ComputerTab agent={agent} />}
          {tab === "settings" && <SettingsTab agent={agent} />}
        </div>
      </div>
    </aside>
  );
}

/** "Add a label": its role, edited in place. */
function RoleLabel({ agent }: { agent: Agent }) {
  const canEdit = useStore((s) => s.me?.role !== "guest");
  const [value, setValue] = useState(agent.settings.role ?? "");
  useEffect(() => setValue(agent.settings.role ?? ""), [agent.id, agent.settings.role]);
  const save = async () => {
    const role = value.trim();
    if (role === (agent.settings.role ?? "")) return;
    await api("PATCH", `/api/agents/${agent.id}`, { settings: { role } }).catch(() => setValue(agent.settings.role ?? ""));
    await useStore.getState().refreshAgents();
  };
  if (!canEdit) return agent.settings.role ? <div className="text-sm text-muted">{agent.settings.role}</div> : null;
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      placeholder="Add a label"
      aria-label="Its label"
      maxLength={60}
      className="mt-0.5 w-48 bg-transparent text-center text-sm text-muted placeholder:text-faint outline-none focus:text-ink rounded-md hover:bg-hover focus:bg-hover px-2 h-7"
    />
  );
}

function Details({ agent, onCall }: { agent: Agent; onCall: () => void }) {
  const status = AGENT_STATUS[agent.status];
  const computer = useStore((s) => s.computers.find((c) => c.id === agent.computerId));
  const rows: [string, ReactNode][] = [
    ["Status", <span className="capitalize">{status.label}</span>],
    ["Harness", HARNESS_LABELS[agent.harness]],
    ["Model", agent.model ? `${prettyModel(agent.model)}${agent.settings.effort ? ` · ${effortName(agent.settings.effort)}` : ""}${agent.settings.fast ? " · Fast" : ""}` : "Default"],
    ["Access", ACCESS_LABEL[agent.settings.access ?? "edit"]],
    ["Computer", computer ? computer.name : agent.settings.headless ? "None (headless)" : "None yet"],
    ...(agent.groups.length ? [["Teams", agent.groups.join(", ")] as [string, ReactNode]] : []),
    ["Handle", `@${agent.handle}`],
    ["Joined", timeAgo(agent.createdAt)],
  ];
  return (
    <div className="space-y-4">
      {agent.settings.roleNotes && <p className="text-sm text-muted whitespace-pre-wrap">{agent.settings.roleNotes}</p>}
      <dl className="rounded-2xl bg-panel border border-line divide-y divide-line text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3 px-4 py-2.5">
            <dt className="text-muted w-20 shrink-0">{k}</dt>
            <dd className="min-w-0 flex-1 truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onCall}>
          <Phone size={15} /> Call
        </Button>
        <Button onClick={() => go({ view: "vault", path: soulPath(agent.id) })}>
          <BookOpen size={15} /> Memory
        </Button>
      </div>
    </div>
  );
}

function SettingsTab({ agent }: { agent: Agent }) {
  return (
    <div className="rounded-2xl bg-panel border border-line divide-y divide-line overflow-hidden">
      <SettingRow icon={<LayoutGrid size={16} />} label="Overview" body="Everything at a glance" onClick={() => go({ view: "agents", agentId: agent.id, tab: "overview" })} />
      {SECTIONS.map((s) => (
        <SettingRow key={s.id} icon={s.icon} label={s.label} body={s.body} onClick={() => go({ view: "agents", agentId: agent.id, tab: s.id })} />
      ))}
    </div>
  );
}

function SettingRow({ icon, label, body, onClick }: { icon: ReactNode; label: string; body: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-hover">
      <span className="text-muted shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted truncate">{body}</span>
      </span>
      <ChevronRight size={15} className="text-faint shrink-0" />
    </button>
  );
}

// --- computer ------------------------------------------------------------------------------------

function ComputerTab({ agent }: { agent: Agent }) {
  const computer = useStore((s) => s.computers.find((c) => c.id === agent.computerId));
  if (!computer)
    return (
      <div className="rounded-2xl bg-panel border border-line p-6 text-center space-y-3">
        <Monitor size={22} className="mx-auto text-muted" />
        <p className="text-sm text-muted">{agent.settings.headless ? `${agent.name} runs headless, without a screen.` : `${agent.name} doesn't have a computer yet.`}</p>
        <Button onClick={() => go({ view: "agents", agentId: agent.id, tab: "computer" })}>Give it one</Button>
      </div>
    );
  return <ComputerCard agent={agent} computer={computer} />;
}

function ComputerCard({ agent, computer: c }: { agent: Agent; computer: ComputerInfo }) {
  const state = useComputerState(c);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asleep = c.online && c.status === "stopped";
  const live = c.online && !c.paused && c.status !== "stopped" && c.status !== "starting";

  const wake = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/start`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {c.help && c.help.agentId === agent.id && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          <span className="font-medium">Needs you: </span>
          {c.help.request}
        </div>
      )}
      <div className="group relative aspect-[16/10] rounded-2xl bg-panel border border-line overflow-hidden">
        {live && !open ? (
          <>
            <LiveScreen computer={c} control={false} compact />
            <button onClick={() => setOpen(true)} className="absolute inset-0" aria-label={`Open ${c.name} full screen`} />
            <span className="pointer-events-none absolute top-2 right-2 size-8 rounded-full bg-black/55 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 size={14} />
            </span>
          </>
        ) : live && open ? (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted">Open full screen</div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            {c.status === "starting" ? (
              <>
                <Loader2 size={22} className="animate-spin text-muted" />
                <p className="text-sm text-muted">{c.statusText || "Waking up…"}</p>
              </>
            ) : (
              <>
                <Ghost look={{ ...(agent.settings.appearance ?? defaultAppearance(agent.handle)), color: "#8d8d8d", color2: undefined, glow: false }} size={56} mood="asleep" ambient={false} label="asleep" />
                <p className="font-medium">{asleep ? "Computer is asleep" : c.paused ? "Paused at its device" : "Computer is offline"}</p>
                {asleep && (
                  <Button onClick={wake} disabled={busy}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null} Wake
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-center gap-2 text-sm text-muted">
        {c.name}'s screen
        {state.working ? <WorkingBadge text={c.activity?.text ?? "Working"} /> : null}
      </div>
      {error && <p className="text-sm text-bad text-center">{error}</p>}
      {open && <ComputerFullscreen agent={agent} computer={c} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The computer, big: watch it, or take control and hand it back. */
function ComputerFullscreen({ agent, computer: c, onClose }: { agent: Agent; computer: ComputerInfo; onClose: () => void }) {
  const me = useStore((s) => s.me);
  const state = useComputerState(c);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = !!me && c.controller?.id === me.user.id;
  const canControl = me?.role !== "guest" && c.online && !c.paused;
  const someoneElse = !!c.controller && !mine;

  const control = async (take: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/control`, { take });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // leaving the big view gives the computer back, so agents aren't stuck waiting on a closed window
  const close = () => {
    if (mine) void api("POST", `/api/computers/${c.id}/control`, { take: false }).catch(() => {});
    onClose();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // while in control, Escape belongs to the remote computer
      if (e.key === "Escape" && !mine) close();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col p-3 md:p-5 safe-top safe-bottom" role="dialog" aria-modal="true" aria-label={`${c.name}'s screen`}>
      <div className="shrink-0 flex items-center gap-2 pb-3 text-white">
        <AgentAvatar agent={agent} size={26} live />
        <span className="font-medium truncate">{c.name}</span>
        {state.working ? <WorkingBadge text={c.activity?.text ?? "Working"} /> : <Pill tone={state.tone}>{state.label}</Pill>}
        <button onClick={close} className="ml-auto size-9 rounded-full hover:bg-white/10 grid place-items-center" aria-label="Exit full screen" title="Exit full screen">
          <Minimize2 size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <LiveScreen computer={c} control={mine} />
      </div>
      {c.help && (
        <p className="shrink-0 mt-3 text-center text-sm text-white/80">
          <span className="font-medium">{agent.name} needs you:</span> {c.help.request}
        </p>
      )}
      {error && <p className="shrink-0 mt-2 text-center text-sm text-bad">{error}</p>}
      <div className="shrink-0 mt-3 flex justify-center">
        <div className="inline-flex items-center gap-1 rounded-full bg-neutral-900/90 border border-white/10 p-1 text-sm text-white">
          {mine ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-3 h-9 text-white/80">
                <Hand size={15} /> You're in control
              </span>
              <button onClick={() => control(false)} disabled={busy} className="inline-flex items-center gap-1.5 px-4 h-9 rounded-full bg-white text-black font-medium disabled:opacity-60">
                <HandMetal size={15} /> Hand back
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 px-3 h-9 text-white/80">
                <Eye size={15} /> {someoneElse ? state.label : "Watching"}
              </span>
              {canControl && (
                <button onClick={() => control(true)} disabled={busy || someoneElse} className="inline-flex items-center gap-1.5 px-4 h-9 rounded-full bg-white text-black font-medium disabled:opacity-60">
                  Take control
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
