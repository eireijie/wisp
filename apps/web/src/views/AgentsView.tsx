import { useEffect, useState, type ReactNode } from "react";
import { Bot, ListTodo, MessageSquare, Plug, Plus, Server, Wand2 } from "lucide-react";
import { api } from "../api.ts";
import { useStore, useTeams } from "../store.ts";
import { go, href, type AgentTab } from "../router.ts";
import { useFeatures } from "../features.ts";
import { AgentDetail, type NodeInfo } from "./AgentSettings.tsx";
import { useSimple } from "../experience.tsx";
import { agentReadiness, useDevices } from "../devices.ts";
import { SetupIncomplete, setupNextStep } from "../components/AgentPanel.tsx";
import { AgentAvatar, Button, Empty, harnessLabel, StatusChip, cx } from "../components/ui.tsx";

import { CreateAgent } from "./CreateAgent.tsx";
export { freeHandle, importFound } from "./CreateAgent.tsx";

export function AgentsView({ agentId, tab }: { agentId: string | null; tab: AgentTab | null }) {
  const agents = useStore((s) => s.agents);
  const teams = useTeams();
  const teamsOf = (agentId: string) => teams.filter((t) => t.members.some((m) => m.agentId === agentId)).map((t) => `#${t.name}`);
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const [creating, setCreating] = useState(false);
  const features = useFeatures();
  // "New agent" from the sidebar or ⌘K opens it here
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  useEffect(() => {
    if (!newAgentOpen) return;
    useStore.setState({ newAgentOpen: false });
    if (me?.role !== "guest") setCreating(true);
  }, [newAgentOpen, me?.role]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const devices = useDevices();
  const simple = useSimple();
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all");
  useEffect(() => {
    api<NodeInfo[]>("GET", "/api/nodes").then(setNodes);
  }, [agents]);
  const selected = agents.find((a) => a.id === agentId);
  const canEdit = me?.role !== "guest";

  if (selected) return <AgentDetail key={selected.id} agent={selected} nodes={nodes} tab={tab} />;

  const shown = agents.filter((a) => (filter === "all" ? true : filter === "online" ? a.status !== "offline" : a.status === "offline"));
  const openDm = async (id: string) => {
    const ch = await api<{ id: string }>("POST", `/api/dm/${id}`);
    await useStore.getState().refreshChannels();
    go({ view: "chat", channelId: ch.id, threadId: null });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        <h1 className="text-lg font-bold tracking-tight flex-1 truncate">Agents</h1>
        {/* the pages that used to sit in the sidebar */}
        <nav aria-label="More about agents" className="flex items-center gap-0.5 overflow-x-auto">
          {features.tasks && <HeaderLink to={href({ view: "tasks" })} icon={<ListTodo size={15} />} label="Tasks" />}
          <HeaderLink to={href({ view: "skills" })} icon={<Wand2 size={15} />} label="Skills" />
          <HeaderLink to={href({ view: "connectors" })} icon={<Plug size={15} />} label="Connected apps" />
          <HeaderLink to={href({ view: "nodes" })} icon={<Server size={15} />} label="Devices" />
        </nav>
      </header>
      <div className="flex-1 overflow-y-auto @container">
        {agents.length === 0 ? (
          <Empty icon={<Bot />} title="Add your first agent">
            <p>Give it a job and a computer. Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose and other agents all work here, share its channels and memory, and use their computers like you would.</p>
            {canEdit && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New agent
              </Button>
            )}
          </Empty>
        ) : (
          <div className="max-w-5xl px-4 md:px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 flex-1 min-w-0" role="tablist">
                {(
                  [
                    ["all", "All"],
                    ["online", "Online"],
                    ["offline", "Offline"],
                  ] as const
                ).map(([f, label]) => (
                  <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={cx("relative h-9 px-2 text-sm font-medium", filter === f ? "text-ink after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-ink")}>
                    {label}
                  </button>
                ))}
              </div>
              {canEdit && (
                <Button onClick={() => setCreating(true)}>
                  <Plus size={16} /> New agent
                </Button>
              )}
            </div>
            <p className="mt-3 mb-1 text-xs text-muted">
              {shown.length} agent{shown.length === 1 ? "" : "s"}
            </p>
            <div className="divide-y divide-line">
              {shown.map((a) => {
                const device = nodes.find((n) => n.id === a.nodeId);
                const readiness = agentReadiness(a, devices);
                const computer = computers.find((c) => c.id === a.computerId)?.name ?? (a.settings.headless ? "headless" : "no computer");
                return (
                  <div key={a.id} className="group flex items-center gap-3 px-2 py-3 hover:bg-hover/60">
                    <a href={`#/agents/${a.id}/overview`} className="flex items-center gap-3 min-w-0 flex-1">
                      <AgentAvatar agent={a} size={32} live />
                      <span className="min-w-0 flex-1 @3xl:flex-none @3xl:w-56">
                        <span className={cx("block text-sm truncate", a.status === "offline" && "text-muted")}>{a.name}</span>
                        <span className="block text-xs text-muted truncate mt-0.5">{["@" + a.handle, ...teamsOf(a.id).slice(0, 2)].join(" · ")}</span>
                        {!readiness.ready && (
                          <span className="mt-1 block">
                            <SetupIncomplete problem={readiness.problem} />
                          </span>
                        )}
                        {!readiness.ready && simple && <span className="block text-xs text-muted mt-1">{setupNextStep(a, devices)?.text}</span>}
                      </span>
                      {/* machine facts in mono, like Paperclip's adapter column */}
                      <span className="hidden @3xl:block w-48 min-w-0 leading-tight">
                        <span className="block truncate font-mono text-xs text-muted">{harnessLabel(a.harness)}</span>
                        <span className="block truncate font-mono text-[11px] text-muted/70">
                          {device ? device.name : "no device"} · {computer}
                        </span>
                      </span>
                    </a>
                    <Button variant="ghost" onClick={() => openDm(a.id)} aria-label={`Chat with ${a.name}`}>
                      <MessageSquare size={15} className="sm:hidden" /> <span className="hidden sm:inline">Chat</span>
                    </Button>
                    <span className="hidden sm:flex w-20 justify-end shrink-0">
                      <StatusChip status={a.status} />
                    </span>
                  </div>
                );
              })}
              {shown.length === 0 && <p className="px-4 py-6 text-sm text-muted text-center">No {filter} agents.</p>}
            </div>
          </div>
        )}
      </div>
      {creating && <CreateAgent nodes={nodes} onClose={() => setCreating(false)} />}
    </div>
  );
}

function HeaderLink({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <a href={to} title={label} className="shrink-0 h-8 px-2 rounded-lg inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink hover:bg-hover">
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </a>
  );
}
