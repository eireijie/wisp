import { useEffect, useState, type ReactNode } from "react";
import { ListTodo, Plug, Plus, Search, Wand2 } from "lucide-react";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { href, type AgentTab } from "../router.ts";
import { useFeatures } from "../features.ts";
import { AgentDetail, type NodeInfo } from "./AgentSettings.tsx";
import { agentReadiness, useDevices } from "../devices.ts";
import { SetupIncomplete, setupNextStep } from "../components/AgentPanel.tsx";
import { workingLine } from "../components/agentActivity.ts";
import { effortName, prettyModel } from "../components/EffortSlider.tsx";
import { UserAvatarButton } from "../components/Rail.tsx";
import { AgentAvatar, harnessLabel, cx } from "../components/ui.tsx";
import { openDm } from "../openDm.ts";

import { CreateAgent } from "./CreateAgent.tsx";
export { freeHandle, importFound } from "./CreateAgent.tsx";

/** The Agents tab: everyone on your team of agents as cards. Open one for its page; Message starts a chat. */
export function AgentsView({ agentId, tab }: { agentId: string | null; tab: AgentTab | null }) {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const me = useStore((s) => s.me);
  const [creating, setCreating] = useState(false);
  const [bringing, setBringing] = useState(false);
  const features = useFeatures();
  // "New agent" from the + menu or ⌘K opens it here
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  useEffect(() => {
    if (!newAgentOpen) return;
    useStore.setState({ newAgentOpen: false });
    if (me?.role !== "guest") setCreating(true);
  }, [newAgentOpen, me?.role]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const devices = useDevices();
  const [q, setQ] = useState("");
  useEffect(() => {
    api<NodeInfo[]>("GET", "/api/nodes").then(setNodes);
  }, [agents]);
  const selected = agents.find((a) => a.id === agentId);
  const canEdit = me?.role !== "guest";

  if (selected) return <AgentDetail key={selected.id} agent={selected} nodes={nodes} tab={tab} />;

  const needle = q.trim().toLowerCase();
  const shown = agents.filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.handle.toLowerCase().includes(needle));
  /** "Working · Reading main.ts", "Idle", "Offline" */
  const state = (a: (typeof agents)[number]): { text: string; working: boolean } => {
    const run = Object.values(live).find((r) => r.agentId === a.id);
    if (run) return { text: workingLine(run.last?.name, !!run.text), working: true };
    if (a.status === "busy") return { text: "Working", working: true };
    if (a.status !== "offline" && a.signIn) return { text: `Needs sign-in · ${harnessLabel(a.harness)} on ${a.signIn.where}`, working: false };
    return { text: a.status === "offline" ? "Offline" : "Idle", working: false };
  };
  const line = (a: (typeof agents)[number]) => [harnessLabel(a.harness), a.model ? prettyModel(a.model) : "Automatic", a.settings.effort ? effortName(a.settings.effort) : null].filter(Boolean).join(" · ");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* phones: you and + on top, then the big title; desktops: the title and the actions side by side */}
      <header className="md:hidden shrink-0 flex items-center justify-between px-[18px] pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <UserAvatarButton size={52} />
        {canEdit && (
          <button onClick={() => setCreating(true)} className="circle" aria-label="New agent">
            <Plus size={22} strokeWidth={2} />
          </button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto @container">
        <div className="max-w-3xl mx-auto px-[22px] md:px-8 pt-2 md:pt-7 pb-28 md:pb-10">
          <div className="flex items-center gap-3 mb-5">
            <h1 className="t-title flex-1">Agents</h1>
            <label className="hidden md:flex items-center gap-2 h-10 w-56 rounded-full bg-card px-3.5 text-faint">
              <Search size={16} strokeWidth={2} className="shrink-0" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search agents" className="flex-1 min-w-0 bg-transparent outline-none text-body text-ink placeholder:text-faint" />
            </label>
            {canEdit && (
              <button onClick={() => setBringing(true)} className="hidden md:inline-flex h-10 px-4 items-center rounded-full bg-control border border-control-line text-sm font-medium hover:bg-hover">
                Bring in
              </button>
            )}
            {canEdit && (
              <button onClick={() => setCreating(true)} className="hidden md:inline-flex h-10 px-5 items-center gap-2 rounded-full bg-accent text-accent-ink text-sm font-medium">
                <Plus size={16} strokeWidth={2.2} /> New agent
              </button>
            )}
          </div>

          <div data-stagger className="space-y-3">
            {shown.map((a) => {
              const st = state(a);
              const readiness = agentReadiness(a, devices);
              return (
                <div key={a.id} className="relative rounded-3xl bg-card p-4 flex items-center gap-4 hover:bg-hover transition-colors">
                  <a href={href({ view: "agents", agentId: a.id, tab: "overview" })} className="flex items-center gap-4 min-w-0 flex-1 after:absolute after:inset-0 after:rounded-3xl">
                    <AgentAvatar agent={a} size={56} live />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium truncate">{a.name}</span>
                      <span className="block text-sm text-muted truncate">{line(a)}</span>
                      <span className={cx("flex items-center gap-1.5 text-sm", st.working ? "text-st-working" : "text-faint")}>
                        <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", st.working && "animate-pulse")} style={{ background: st.working ? "var(--st-working)" : a.status === "offline" ? "var(--status-idle)" : a.signIn ? "var(--warn)" : "var(--st-online)" }} />
                        <span className="truncate">{st.text}</span>
                      </span>
                      {!readiness.ready && (
                        <span className="mt-1.5 block">
                          <SetupIncomplete problem={readiness.problem} />
                          <span className="block text-xs text-muted mt-1">{setupNextStep(a, devices)?.text}</span>
                        </span>
                      )}
                    </span>
                  </a>
                  <span className="hidden md:flex gap-2 shrink-0 relative z-10">
                    <button onClick={() => void openDm(a.id)} aria-label={`Message ${a.name}`} className="h-10 px-4 rounded-full bg-control border border-control-line text-sm font-medium hover:bg-hover">
                      Message
                    </button>
                    <a href={href({ view: "agents", agentId: a.id, tab: "overview" })} className="h-10 px-4 rounded-full bg-accent text-accent-ink text-sm font-medium inline-flex items-center">
                      Open
                    </a>
                  </span>
                </div>
              );
            })}
            {agents.length > 0 && shown.length === 0 && <p className="py-6 text-sm text-muted text-center">No agents match.</p>}
            {canEdit && (
              <button onClick={() => setBringing(true)} className="md:hidden w-full rounded-3xl bg-card p-4 min-h-14 text-left">
                <span className="block text-body font-medium">Bring an agent in</span>
                <span className="block text-sm text-muted">Import one, or invite an outside agent</span>
              </button>
            )}
            {agents.length === 0 && (
              <p className="text-sm text-muted px-1">
                Give an agent a job and a computer. Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose and other agents all work here, share its teams and memory, and use their computers like you would.
              </p>
            )}
          </div>

          {/* the pages that live under Agents */}
          <nav aria-label="More about agents" className="mt-8 flex flex-wrap gap-2">
            {features.tasks && <MoreLink to={href({ view: "tasks" })} icon={<ListTodo size={16} />} label="Tasks" />}
            <MoreLink to={href({ view: "skills" })} icon={<Wand2 size={16} />} label="Skills" />
            <MoreLink to={href({ view: "connectors" })} icon={<Plug size={16} />} label="Connected apps" />
          </nav>
        </div>
      </div>
      {creating && <CreateAgent nodes={nodes} onClose={() => setCreating(false)} />}
      {bringing && <CreateAgent bringIn nodes={nodes} onClose={() => setBringing(false)} />}
    </div>
  );
}

function MoreLink({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <a href={to} className="h-10 px-4 rounded-full bg-card inline-flex items-center gap-2 text-sm text-muted hover:text-ink hover:bg-hover">
      <span className="text-accent-agents">{icon}</span>
      {label}
    </a>
  );
}

