import { useEffect, useMemo, useState } from "react";
import { Bot, Cloud, Download, Laptop, Loader2, MessageSquare, Monitor, Plus, Shuffle } from "lucide-react";
import { defaultAppearance, randomAppearance, type GhostAppearance } from "@warren/core/src/appearance.ts";
import { Ghost } from "../components/Ghost.tsx";
import { HARNESSES, soulTemplate, type Agent, type DiscoveredAgent } from "@warren/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, type AgentTab } from "../router.ts";
import { AgentDetail, type NodeInfo } from "./AgentSettings.tsx";
import { computerKindLabel } from "../devices.ts";
import { TEMPLATES, type AgentTemplate } from "../templates.ts";
import { AgentAvatar, Button, Empty, Field, HARNESS_LABELS, Input, Modal, Pill, Textarea, cx } from "../components/ui.tsx";

export function AgentsView({ agentId, tab }: { agentId: string | null; tab: AgentTab | null }) {
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const [creating, setCreating] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
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
      <header className="h-14 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        <h1 className="font-semibold flex-1">Agents</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Add agent
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <Empty icon={<Bot />} title="Add your first agent">
            <p>Give it a job and a computer. Claude Code, Codex, Hermes, Gemini CLI, OpenCode, Goose and other agents all work here, share its channels and memory, and use their computers like you would.</p>
            {canEdit && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Add agent
              </Button>
            )}
          </Empty>
        ) : (
          <div className="max-w-5xl px-4 md:px-6 py-5">
            <div className="flex items-center gap-1 mb-3" role="tablist">
              {(["all", "online", "offline"] as const).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={cx("h-8 px-3 rounded-lg text-sm capitalize", filter === f ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}>
                  {f}
                  <span className="ml-1.5 text-faint tabular-nums">{f === "all" ? agents.length : agents.filter((a) => (f === "online" ? a.status !== "offline" : a.status === "offline")).length}</span>
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-line divide-y divide-line overflow-hidden">
              {shown.map((a) => {
                const device = nodes.find((n) => n.id === a.nodeId);
                return (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-3 hover:bg-hover">
                    <a href={`#/agents/${a.id}/overview`} className="flex items-center gap-3 min-w-0 flex-1">
                      <AgentAvatar agent={a} size={44} live />
                      <span className="min-w-0">
                        <span className="block font-medium truncate">
                          {a.name} <span className="text-muted font-normal">@{a.handle}</span>
                        </span>
                        <span className="block text-xs text-muted truncate">
                          {HARNESS_LABELS[a.harness]} · {device ? device.name : "no device"} · {computers.find((c) => c.id === a.computerId)?.name ?? (a.settings.headless ? "headless" : "no computer")}
                        </span>
                      </span>
                    </a>
                    <span className="hidden sm:flex items-center gap-1.5 shrink-0">
                      {a.groups.slice(0, 2).map((g) => (
                        <Pill key={g} tone="accent">
                          {g}
                        </Pill>
                      ))}
                      <Pill tone={a.status === "online" ? "ok" : a.status === "busy" ? "info" : "neutral"}>{a.status}</Pill>
                    </span>
                    <Button variant="ghost" onClick={() => openDm(a.id)} aria-label={`Message ${a.name}`}>
                      <MessageSquare size={15} /> <span className="hidden md:inline">Message</span>
                    </Button>
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

/** The computer a new agent gets: a new VM or screen on its device, one that exists, or none. */
type ComputerChoice = { kind: "vm" } | { kind: "screen" } | { kind: "existing"; id: string } | { kind: "later" } | { kind: "headless" };

function defaultComputer(node: NodeInfo | undefined, computers: ComputerInfo[]): ComputerChoice {
  if (node?.capabilities?.vm.ok) return { kind: "vm" };
  const screen = computers.find((c) => c.kind === "device" && c.nodeId === node?.id);
  if (screen) return { kind: "existing", id: screen.id };
  if (node?.capabilities?.screen.ok) return { kind: "screen" };
  if (computers[0]) return { kind: "existing", id: computers[0].id };
  return { kind: "later" };
}

/** Make the chosen computer (if it's new) and return its id; null for none. */
async function resolveComputer(choice: ComputerChoice, nodeId: string, agentName: string): Promise<string | null> {
  if (choice.kind === "existing") return choice.id;
  if (choice.kind === "vm") return (await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId, name: `${agentName}'s desk`, cpus: 2, memoryGb: 4 })).id;
  if (choice.kind === "screen") return (await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId })).id;
  return null;
}

function ComputerPicker({ value, onChange, node, nodes }: { value: ComputerChoice; onChange: (c: ComputerChoice) => void; node: NodeInfo | undefined; nodes: NodeInfo[] }) {
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const screenExists = computers.some((c) => c.kind === "device" && c.nodeId === node?.id);
  const opt = (c: ComputerChoice, icon: React.ReactNode, title: string, body: string, disabled?: boolean) => {
    const selected = value.kind === c.kind && (c.kind !== "existing" || (value.kind === "existing" && value.id === c.id));
    return (
      <button type="button" key={c.kind === "existing" ? c.id : c.kind} disabled={disabled} onClick={() => onChange(c)} className={cx("rounded-xl border p-2.5 text-left flex gap-2.5 disabled:opacity-45 disabled:pointer-events-none", selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}>
        <span className="size-7 shrink-0 rounded-lg bg-chip grid place-items-center text-muted">{icon}</span>
        <span className="min-w-0">
          <span className="block text-sm font-medium truncate">{title}</span>
          <span className="block text-[11px] text-muted leading-tight">{body}</span>
        </span>
      </button>
    );
  };
  return (
    <div>
      <div className="text-sm font-medium mb-1">Computer</div>
      <p className="text-xs text-muted mb-2">Where it works: it opens apps and websites there, and you can watch and take over.</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {node && opt({ kind: "vm" }, <Monitor size={15} />, `New VM on ${node.name}`, node.capabilities?.vm.ok ? "Its own Linux desktop. Doesn't touch your screen." : (node.capabilities?.vm.detail ?? "Connect the device to check"), !node.capabilities?.vm.ok)}
        {node && !screenExists && opt({ kind: "screen" }, <Laptop size={15} />, `${node.name}'s own screen`, node.capabilities?.screen.ok === false ? node.capabilities.screen.detail : "It uses the device itself.", node.capabilities?.screen.ok === false)}
        {computers.map((c) =>
          opt({ kind: "existing", id: c.id }, c.kind === "orgo" ? <Cloud size={15} /> : c.kind === "vm" ? <Monitor size={15} /> : <Laptop size={15} />, c.name, `${computerKindLabel(c, nodes)}${c.agents.length ? `, shared with ${agents.filter((a) => c.agents.includes(a.id)).map((a) => "@" + a.handle).join(", ")}` : ""}`),
        )}
        {opt({ kind: "later" }, <Plus size={15} />, "Choose later", "Pick one on its Computer tab.")}
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={value.kind === "headless"} onChange={(e) => onChange(e.target.checked ? { kind: "headless" } : defaultComputer(node, computers))} />
        Run it headless: no computer, so no apps or websites
      </label>
    </div>
  );
}

function CreateAgent({ nodes, onClose }: { nodes: NodeInfo[]; onClose: () => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const computers = useStore((s) => s.computers);
  const [tab, setTab] = useState<"new" | "import">("new");
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [harness, setHarness] = useState("claude-code");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [nodeId, setNodeId] = useState(nodes.find((n) => n.online)?.id ?? nodes[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");
  const [computer, setComputer] = useState<ComputerChoice>(() => defaultComputer(nodes.find((n) => n.id === nodeId), computers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the new agent's ghost follows its handle until you shuffle
  const [shuffled, setShuffled] = useState<GhostAppearance | null>(null);
  const node = nodes.find((n) => n.id === nodeId);
  const installed = new Set((node?.harnesses ?? []).map((h) => h.id));

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);
  const look = shuffled ?? defaultAppearance(handle || slug(name) || "new-agent");
  const declared = (node?.harnesses ?? []).filter((h) => h.id.startsWith("acp:"));
  const harnesses = [...HARNESSES.filter((h) => h.id !== "custom"), ...declared.map((h) => ({ id: h.id, label: h.id.slice(4), protocol: "acp" as const, note: "Declared on this device", binary: "" })), HARNESSES.find((h) => h.id === "custom")!];

  const pickTemplate = (t: AgentTemplate | null) => {
    setTemplate(t);
    if (!t) return;
    setName(t.name);
    if (!handleEdited) setHandle(slug(t.name.split(" ")[0]));
    setInstructions(t.instructions);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const finalHandle = handle || slug(name);
      const computerId = await resolveComputer(computer, nodeId, name);
      // a job's voice replaces the default voice lines
      const soul = template ? soulTemplate(name, finalHandle).replace(/## Voice\n(?:- .*\n?)*/, `## Voice\n- ${template.voice}\n`) : undefined;
      const a = await api<Agent>("POST", "/api/agents", {
        harness,
        name,
        handle: finalHandle,
        nodeId: nodeId || null,
        computerId,
        instructions,
        soul,
        settings: { ...(shuffled ? { appearance: shuffled } : {}), ...(computer.kind === "headless" ? { headless: true } : {}) },
      });
      await Promise.all([refreshAgents(), useStore.getState().refreshComputers()]);
      onClose();
      go({ view: "agents", agentId: a.id, tab: "overview" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add an agent" onClose={onClose} wide>
      <div className="flex gap-1 mb-4" role="tablist">
        {(
          [
            ["new", "New agent"],
            ["import", "Bring in an existing agent"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("h-8 px-3 rounded-lg text-sm", tab === t ? "bg-hover text-ink font-medium" : "text-muted hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "import" ? (
        <ImportAgent nodes={nodes} onClose={onClose} />
      ) : (
        <form className="space-y-5" onSubmit={submit}>
          <div>
            <div className="text-sm font-medium mb-2">Give it a job</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => pickTemplate(null)} className={cx("h-8 px-3 rounded-full border text-sm", !template ? "border-ink bg-ink text-panel" : "border-line hover:bg-hover")}>
                Blank
              </button>
              {TEMPLATES.map((t) => (
                <button type="button" key={t.id} title={t.blurb} onClick={() => pickTemplate(t)} className={cx("h-8 px-3 rounded-full border text-sm", template?.id === t.id ? "border-ink bg-ink text-panel" : "border-line hover:bg-hover")}>
                  {t.emoji} {t.name}
                </button>
              ))}
            </div>
            {template && <p className="mt-2 text-xs text-muted">{template.blurb}</p>}
          </div>
          <div>
            <div className="text-sm font-medium mb-2">Harness</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {harnesses.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  onClick={() => setHarness(h.id)}
                  className={cx("rounded-xl border p-2.5 text-left flex items-start gap-2", harness === h.id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}
                >
                  <AgentAvatar agent={{ harness: h.id as Agent["harness"], name: h.id }} size={22} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{HARNESS_LABELS[h.id]}</div>
                    <div className="text-[11px] text-muted leading-tight">{installed.has(h.id) ? `Installed on ${node?.name}` : h.protocol === "mcp" ? "Joins through warren-mcp" : h.note}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-2xl bg-bg p-3">
            <Ghost look={look} size={64} label="New agent's ghost" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{name || "Your new agent"}</div>
              <div className="text-muted">You can change its look anytime.</div>
            </div>
            <Button type="button" variant="ghost" onClick={() => setShuffled(randomAppearance())}>
              <Shuffle size={15} /> Shuffle
            </Button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!handleEdited) setHandle(slug(e.target.value));
                }}
                placeholder="Atlas"
                required
              />
            </Field>
            <Field label="Handle" hint="Used to @mention it.">
              <Input
                value={handle}
                onChange={(e) => {
                  setHandle(slug(e.target.value));
                  setHandleEdited(true);
                }}
                placeholder="atlas"
                required
              />
            </Field>
          </div>
          <Field label="Device" hint={nodes.length ? "Where its harness runs." : "No devices yet. You can add one later under Devices."}>
            <select
              value={nodeId}
              onChange={(e) => {
                setNodeId(e.target.value);
                setComputer(defaultComputer(nodes.find((n) => n.id === e.target.value), computers));
              }}
              className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm"
            >
              <option value="">Decide later</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} {n.online ? "(online)" : "(offline)"}
                </option>
              ))}
            </select>
          </Field>
          <ComputerPicker value={computer} onChange={setComputer} node={node} nodes={nodes} />
          <Field label="Instructions (optional)">
            <Textarea rows={template ? 5 : 3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What is this agent responsible for?" />
          </Field>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />} Add agent
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Agents that already live on a device (Hermes, OpenClaw, Claude Code subagents): bring them in with their soul and notes. */
function ImportAgent({ nodes, onClose }: { nodes: NodeInfo[]; onClose: () => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const found = useMemo(() => nodes.flatMap((n) => (n.discovered ?? []).map((d) => ({ node: n, d }))), [nodes]);
  const [pick, setPick] = useState<{ node: NodeInfo; d: DiscoveredAgent } | null>(null);
  const [handle, setHandle] = useState("");
  const [computer, setComputer] = useState<ComputerChoice>({ kind: "later" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);

  const choose = (x: { node: NodeInfo; d: DiscoveredAgent }) => {
    setPick(x);
    setHandle(slug(x.d.name.split(/[\s']/)[0]) || "agent");
    setComputer(defaultComputer(x.node, computers));
  };

  if (!found.length)
    return (
      <div className="space-y-3 text-sm text-muted">
        <p>No existing agents found on your devices. Warren looks for Hermes profiles, OpenClaw workspaces, Claude Code subagents (~/.claude/agents) and OpenCode agents when a device connects.</p>
        <p>
          Already running an agent somewhere else? Add it as a new agent and connect it with <b>Create connection token</b> on its Connect tab.
        </p>
        <div className="flex justify-end gap-2">
          {nodes
            .filter((n) => n.online)
            .slice(0, 1)
            .map((n) => (
              <Button key={n.id} onClick={() => api("POST", `/api/nodes/${n.id}/discover`).catch(() => {})}>
                Look again on {n.name}
              </Button>
            ))}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line divide-y divide-line">
        {found.map((x) => {
          const taken = agents.some((a) => a.nodeId === x.node.id && a.harness === x.d.harness && a.name === x.d.name);
          return (
            <button key={`${x.node.id}:${x.d.key}`} onClick={() => choose(x)} className={cx("w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-hover", pick?.d.key === x.d.key && pick.node.id === x.node.id && "bg-accent-soft")}>
              <AgentAvatar agent={{ harness: x.d.harness, name: x.d.name }} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">
                  {x.d.name} <span className="font-normal text-muted">· {HARNESS_LABELS[x.d.harness]} on {x.node.name}</span>
                </span>
                <span className="block text-xs text-muted truncate">
                  {[x.d.description, x.d.hasSoul && "has a soul", x.d.memoryCount ? `${x.d.memoryCount} note${x.d.memoryCount === 1 ? "" : "s"}` : null, x.d.model].filter(Boolean).join(" · ")}
                </span>
              </span>
              {taken && <Pill>already here</Pill>}
            </button>
          );
        })}
      </div>
      {pick && (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const computerId = await resolveComputer(computer, pick.node.id, pick.d.name);
              const a = await api<Agent>("POST", "/api/agents/import", { nodeId: pick.node.id, key: pick.d.key, handle, computerId, headless: computer.kind === "headless" });
              await Promise.all([refreshAgents(), useStore.getState().refreshComputers()]);
              onClose();
              go({ view: "agents", agentId: a.id, tab: "overview" });
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Handle" hint={`Its soul, instructions and notes are copied into Warren's memory. ${pick.d.path}`}>
            <Input value={handle} onChange={(e) => setHandle(slug(e.target.value))} required />
          </Field>
          <ComputerPicker value={computer} onChange={setComputer} node={pick.node} nodes={nodes} />
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Bring in {pick.d.name}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
