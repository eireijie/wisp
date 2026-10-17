import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BookOpen, MessageSquare, ChevronRight, Cpu, Eye, ExternalLink, Ghost as GhostIcon, Hand, LayoutGrid, ListChecks, Loader2, Maximize2, Minimize2, Monitor, Phone, Plug, ScrollText, Server, Shield, Sparkles, Video, X } from "lucide-react";
import { harnessLabel, type Agent } from "@warren/core";
import { soulPath } from "@warren/core/src/soul.ts";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href, type AgentTab } from "../router.ts";
import { Advanced, useSimple } from "../experience.tsx";
import { openDm } from "../openDm.ts";
import { agentReadiness, useDevices, type DeviceInfo } from "../devices.ts";
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
  { id: "soul", label: "Personality", body: "How it talks and what it values", icon: <Sparkles size={16} /> },
  { id: "instructions", label: "Instructions", body: "How it should work", icon: <ScrollText size={16} /> },
  { id: "model", label: "Model", body: "Model, effort and fast mode", icon: <Cpu size={16} /> },
  { id: "device", label: "Device", body: "Where its harness runs", icon: <Server size={16} /> },
  { id: "computer", label: "Computer", body: "Which computer it uses", icon: <Monitor size={16} /> },
  { id: "routines", label: "Routines", body: "Tasks it does on a schedule", icon: <ListChecks size={16} /> },
  { id: "permissions", label: "Permissions", body: "What it may do without asking", icon: <Shield size={16} /> },
  { id: "connect", label: "Connect", body: "Apps and connectors", icon: <Plug size={16} /> },
  { id: "runs", label: "Activity", body: "Everything it's done lately", icon: <Activity size={16} /> },
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
  const devices = useDevices();
  const readiness = agentReadiness(agent, devices);
  const simple = useSimple();
  const next = simple ? setupNextStep(agent, devices) : null;
  const device = devices?.find((d) => d.id === agent.nodeId);
  type Row = [string, ReactNode];
  const statusRow: Row = ["Status", <span className="inline-flex flex-wrap items-center justify-end gap-1.5"><span className="capitalize">{status.label}</span>{!readiness.ready && <SetupIncomplete problem={readiness.problem} />}</span>];
  const deviceRow: Row = ["Device", device ? device.name : "None yet"];
  const computerRow: Row = ["Computer", computer ? computer.name : agent.settings.headless ? "None (headless)" : "None yet"];
  const harnessRow: Row = ["Harness", HARNESS_LABELS[agent.harness]];
  const modelRow: Row = ["Model", agent.model ? `${prettyModel(agent.model)}${agent.settings.effort ? ` · ${effortName(agent.settings.effort)}` : ""}${agent.settings.fast ? " · Fast" : ""}` : "Default"];
  const accessRow: Row = ["Access", ACCESS_LABEL[agent.settings.access ?? "edit"]];
  const tail: Row[] = [...(agent.groups.length ? [["Teams", agent.groups.join(", ")] as Row] : []), ["Handle", `@${agent.handle}`], ["Joined", timeAgo(agent.createdAt)]];
  const technical: Row[] = [harnessRow, modelRow, accessRow];
  const table = (list: Row[]) => (
    <dl className="rounded-2xl bg-panel border border-line divide-y divide-line text-sm">
      {list.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3 px-4 py-2.5">
          <dt className="text-muted w-20 shrink-0">{k}</dt>
          <dd className="min-w-0 flex-1 truncate text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div className="space-y-4">
      {agent.settings.roleNotes && <p className="text-sm text-muted whitespace-pre-wrap">{agent.settings.roleNotes}</p>}
      {simple ? table([statusRow, deviceRow, computerRow, ...tail]) : table([statusRow, ...technical, deviceRow, computerRow, ...tail])}
      {simple && (
        <Advanced title="Technical details">
          {table(technical)}
        </Advanced>
      )}
      {!readiness.ready && (
        <p className="rounded-xl border border-line bg-panel px-3 py-2 text-xs text-muted">
          Setup incomplete: {readiness.problem}. Messages to {agent.name} will wait until that's fixed.
          {next && (
            <span className="mt-1 block">
              What to do: {next.text}{" "}
              <a href={next.href} className="text-accent-text underline">
                {next.action}
              </a>
            </span>
          )}
        </p>
      )}
      <Button className="w-full" onClick={() => void openDm(agent.id)}>
        <MessageSquare size={15} /> Send a test message
      </Button>
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

/** The one thing to do about an unfinished helper, in plain words. Mirrors agentReadiness's order of checks; null when ready. */
export function setupNextStep(agent: Pick<Agent, "id" | "nodeId" | "harness" | "name">, devices: DeviceInfo[] | null): { text: string; href: string; action: string } | null {
  if (agentReadiness(agent, devices).ready) return null;
  if (!agent.nodeId) return { text: `Choose the computer that runs ${agent.name}.`, href: href({ view: "agents", agentId: agent.id, tab: "device" }), action: "Choose a device" };
  const device = devices?.find((d) => d.id === agent.nodeId);
  if (!device) return null;
  if (!device.online) return { text: `Open Warren on ${device.name} so it reconnects. Messages wait until then.`, href: href({ view: "nodes" }), action: "See devices" };
  if (device.paused) return { text: `${device.name} is paused. Resume it on that computer.`, href: href({ view: "nodes" }), action: "See devices" };
  return { text: `Install ${harnessLabel(agent.harness)} on ${device.name}.`, href: href({ view: "settings", page: "runtimes" }), action: "Install it" };
}

/** "Setup incomplete · my-mac is offline": what's still missing before it can answer. */
export function SetupIncomplete({ problem }: { problem: string | null }) {
  return <Pill tone="warn">{problem ? `Setup incomplete · ${problem}` : "Setup incomplete"}</Pill>;
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

/**
 * The computer, big. Click the screen to take control; it's yours (blue ring) until you hand it
 * back, leave it alone for a while, or the agent needs it after you've stopped using it.
 */
function ComputerFullscreen({ agent, computer: c, onClose }: { agent: Agent; computer: ComputerInfo; onClose: () => void }) {
  const me = useStore((s) => s.me);
  const state = useComputerState(c);
  const [error, setError] = useState<string | null>(null);
  const mine = !!me && c.controller?.id === me.user.id;
  const canControl = me?.role !== "guest" && c.online && !c.paused;
  const someoneElse = !!c.controller && !mine;
  const touched = useRef(0);

  const control = async (take: boolean) => {
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/control`, { take });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // while you work on it, tell the hub now and then that you're still there (VNC input skips the hub)
  const activity = () => {
    if (Date.now() - touched.current < 15_000) return;
    touched.current = Date.now();
    void api("POST", `/api/computers/${c.id}/control`, { take: true }).catch(() => {});
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
      <div className="shrink-0 relative flex items-center gap-2 pb-3 min-h-11 text-white">
        <AgentAvatar agent={agent} size={26} live />
        <span className="font-medium truncate">{c.name}</span>
        {!mine && (state.working ? <WorkingBadge text={c.activity?.text ?? "Working"} /> : <Pill tone={state.tone}>{state.label}</Pill>)}
        {mine && (
          <div className="absolute left-1/2 top-0 -translate-x-1/2 inline-flex items-center gap-2 rounded-full bg-info text-white pl-3.5 pr-1 h-9 text-sm font-medium shadow-panel" role="status">
            <Hand size={15} /> You are in control
            <button onClick={() => control(false)} className="h-7 px-3 rounded-full bg-white/20 hover:bg-white/30 text-xs font-medium">
              Hand back
            </button>
          </div>
        )}
        {canControl && !someoneElse && (
          <button onClick={() => go({ view: "computers", computerId: c.id, teach: agent.id })} className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-white/20 text-sm font-medium hover:bg-white/10" title={`Do a task once while ${agent.name} watches; it saves it as a routine`}>
            <Video size={15} /> Teach a task
          </button>
        )}
        <button onClick={close} className={cx(!(canControl && !someoneElse) && "ml-auto", "size-9 rounded-full hover:bg-white/10 grid place-items-center")} aria-label="Exit full screen" title="Exit full screen">
          <Minimize2 size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <LiveScreen computer={c} control={mine} onTakeControl={canControl && !someoneElse ? () => void control(true) : undefined} onActivity={activity} />
      </div>
      <div className="shrink-0 mt-3 text-center text-sm text-white/70 min-h-5">
        {c.help ? (
          <span>
            <span className="font-medium text-white">{agent.name} needs you:</span> {c.help.request}
            {mine ? " Hand back when you're done." : " Click the screen to take control."}
          </span>
        ) : mine ? (
          `${agent.name} gets it back if you hand it back or stop using it.`
        ) : someoneElse ? (
          state.label
        ) : canControl ? (
          <span className="inline-flex items-center gap-1.5">
            <Eye size={14} /> Watching · click the screen to take control
          </span>
        ) : null}
      </div>
      {error && <p className="shrink-0 mt-1 text-center text-sm text-bad">{error}</p>}
    </div>
  );
}
