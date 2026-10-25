import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, Copy, Download, ExternalLink, Eye, Lock, Monitor, MoreHorizontal, Pause, Plus, Trash2 } from "lucide-react";
import { formatRustdeskId, runsInVm, type Agent } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { osName, useDevices } from "../devices.ts";
import { useFeature } from "../features.ts";
import { CreateAgent } from "./CreateAgent.tsx";
import { ConnectDevice, DeviceAccess, DeviceIcon, type NodeInfo } from "./NodesView.tsx";
import { AgentAvatar, Button, CopyBlock, Empty, Loader, Menu, Pill, StatusChip, cx } from "../components/ui.tsx";

/**
 * One device: the agents that run on it and what each works on, its own screen, and the rest of
 * its settings folded away. Only agents that run on a device can use its screen.
 */
export function DevicePage({ nodeId }: { nodeId: string }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const remoteDesktop = useFeature("remoteDesktop");
  const refresh = () => api<NodeInfo[]>("GET", "/api/nodes").then(setNodes, () => setNodes([]));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const n = nodes?.find((x) => x.id === nodeId);
  if (!nodes) return <Loader />;
  if (!n)
    return (
      <Empty icon={<Monitor />} title="That device is gone">
        <Button onClick={() => go({ view: "nodes" })}>Back to devices</Button>
      </Empty>
    );

  const remove = async () => {
    if (!confirm(`Remove ${n.name}? Its token stops working.`)) return;
    try {
      await api("DELETE", `/api/nodes/${n.id}`);
      go({ view: "nodes" });
    } catch (e) {
      setError(`Couldn't remove ${n.name}: ${(e as Error).message}`);
    }
  };
  const update = async () => {
    try {
      await api("POST", `/api/nodes/${n.id}/update`);
    } catch (e) {
      setError((e as Error).message);
    }
    refresh();
  };
  const menu = [
    ...(isOwner && n.online ? [{ label: "Update Wisp", icon: <Download size={15} />, onSelect: update }] : []),
    ...(n.mine || isOwner ? [{ label: "Remove device", icon: <Trash2 size={15} />, danger: true, onSelect: remove }] : []),
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-3 border-b border-line safe-top">
        <a href={href({ view: "nodes" })} className="p-1.5 -ml-1.5 rounded-md hover:bg-hover text-muted" aria-label="Back to devices">
          <ChevronLeft size={20} />
        </a>
        <DeviceIcon online={n.online} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight truncate">{n.name}</h1>
            {n.paused && (
              <span title={`Paused at the device. Resume it there with: wisp node resume`}>
                <Pill tone="warn">
                  <Pause size={11} /> Paused
                </Pill>
              </span>
            )}
          </div>
          <div className="text-xs text-muted truncate">
            {n.capabilities ? `${osName(n.capabilities.platform)} · ` : ""}
            {n.online ? "Online" : "Offline"}
            {!n.mine && n.ownerName ? ` · ${n.ownerName}'s` : ""}
          </div>
        </div>
        {menu.length > 0 && (
          <Menu
            align="right"
            items={menu}
            trigger={(open, toggle) => (
              <button className={cx("p-1.5 rounded-md text-muted hover:bg-hover hover:text-ink", open && "bg-hover text-ink")} aria-label={`More for ${n.name}`} onClick={toggle}>
                <MoreHorizontal size={18} />
              </button>
            )}
          />
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl p-4 md:p-8 space-y-3">
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          {(n.mine || isOwner) && <ConnectDevice node={n} onChange={refresh} />}
          <AgentsHere node={n} onAdd={() => setCreating(true)} />
          {n.mine && <YourScreen node={n} />}
          {n.mine && remoteDesktop && <RemoteDesktop node={n} />}
          <section className="rounded-2xl border border-line bg-panel">
            <button className="w-full px-4 py-3 flex items-center text-sm text-muted hover:text-ink" aria-expanded={more} onClick={() => setMore(!more)}>
              <span className="flex-1 text-left">More</span>
              <ChevronDown size={16} className={cx("transition-transform", more && "rotate-180")} />
            </button>
            {more && (
              <div className="px-4 pb-4 -mt-3">
                <DeviceAccess node={n} onChange={refresh} />
                {n.mine && (
                  <p className="mt-3 text-xs text-muted">
                    At {n.name}: <code>wisp node screen code</code> picks a new screen code, and <code>wisp node pause</code> stops everything there until <code>wisp node resume</code>.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      {creating && <CreateAgentHere nodeId={n.id} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The new-agent dialog, starting on this device. */
function CreateAgentHere({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const devices = useDevices();
  return devices ? <CreateAgent nodes={devices} nodeId={nodeId} onClose={onClose} /> : null;
}

/** What an agent can work on from this device: its screen, a VM here, or nothing. */
type WorksOn = { kind: "screen" } | { kind: "computer"; id: string } | { kind: "new-vm" } | { kind: "none" };

/** The agents whose harness runs on this device, and what each one works on. */
function AgentsHere({ node: n, onAdd }: { node: NodeInfo; onAdd: () => void }) {
  const agents = useStore((s) => s.agents).filter((a) => a.nodeId === n.id);
  const computers = useStore((s) => s.computers);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screen = computers.find((c) => c.kind === "device" && c.nodeId === n.id);
  const vms = computers.filter((c) => c.kind === "vm" && c.nodeId === n.id);
  const canAdd = n.mine || n.shared;

  const set = async (a: Agent, choice: WorksOn) => {
    if (choice.kind === "none" && !confirm(`Run ${a.name} without a computer? It won't be able to use apps or websites.`)) return;
    setBusy(a.id);
    setError(null);
    try {
      if (choice.kind === "none") await api("PATCH", `/api/agents/${a.id}`, { computerId: null, settings: { headless: true } });
      else if (choice.kind === "screen") {
        const c = screen ?? (await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId: n.id }));
        await api("PATCH", `/api/agents/${a.id}`, { computerId: c.id });
      } else if (choice.kind === "new-vm") {
        const c = await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: n.id, name: `${a.name}'s desk`, cpus: 2, memoryGb: 4 });
        // a harness that comes with the VM moves in with it, unless someone already chose where it runs
        await api("PATCH", `/api/agents/${a.id}`, { computerId: c.id, ...(runsInVm(a.harness) && !a.settings.runIn ? { settings: { runIn: "computer" } } : {}) });
      } else await api("PATCH", `/api/agents/${a.id}`, { computerId: choice.id });
      await Promise.all([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm flex-1">Agents on this computer</h2>
        {canAdd && (
          <Button onClick={onAdd}>
            <Plus size={15} /> Add an agent here
          </Button>
        )}
      </div>
      {agents.length ? (
        <ul className="mt-2 divide-y divide-line">
          {agents.map((a) => (
            <li key={a.id} className="py-2.5 flex items-center gap-3">
              <AgentAvatar agent={a} size={28} live={n.online} />
              <a href={href({ view: "agents", agentId: a.id, tab: null })} className="flex-1 min-w-0 text-sm font-medium truncate hover:underline">
                {a.name}
              </a>
              <span className="hidden sm:flex">
                <StatusChip status={a.status} />
              </span>
              {n.mine ? <WorksOnPicker agent={a} node={n} screen={screen} vms={vms} busy={busy === a.id} onPick={(c) => set(a, c)} /> : <span className="text-xs text-muted">{worksOnLabel(a, computers)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No agents here yet.</p>
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <p className="mt-2 text-xs text-muted">Only agents that run here can use this computer{n.mine ? ", and only for things you ask" : ""}.</p>
    </section>
  );
}

function worksOnLabel(a: Agent, computers: ComputerInfo[]): string {
  const c = computers.find((x) => x.id === a.computerId);
  if (c?.kind === "device") return "This screen";
  if (c) return c.name;
  return a.computerId ? "Its owner's screen" : "No computer";
}

/** "This screen", a VM here, a new VM, or no computer; the agent's current one shows first. */
function WorksOnPicker({ agent: a, node: n, screen, vms, busy, onPick }: { agent: Agent; node: NodeInfo; screen: ComputerInfo | undefined; vms: ComputerInfo[]; busy: boolean; onPick: (c: WorksOn) => void }) {
  const computers = useStore((s) => s.computers);
  const current = computers.find((c) => c.id === a.computerId);
  const caps = n.capabilities;
  const value = current?.kind === "device" ? "screen" : current ? current.id : "none";
  // a computer it already has somewhere else (a cloud computer) stays pickable
  const elsewhere = current && current.kind !== "device" && current.nodeId !== n.id ? current : undefined;
  return (
    <select
      aria-label={`What ${a.name} works on`}
      disabled={busy}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        onPick(v === "screen" ? { kind: "screen" } : v === "new-vm" ? { kind: "new-vm" } : v === "none" ? { kind: "none" } : { kind: "computer", id: v });
      }}
      className="h-8 max-w-44 rounded-lg border border-line bg-panel px-2 text-xs text-ink"
    >
      <option value="screen" disabled={!caps?.screen.ok && value !== "screen"}>
        {caps?.screen.ok || value === "screen" ? "This screen" : caps?.screen.off ? "This screen (off)" : "This screen (not available)"}
      </option>
      {vms.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      {elsewhere && <option value={elsewhere.id}>{elsewhere.name}</option>}
      {caps?.vm.ok && <option value="new-vm">New VM</option>}
      <option value="none">No computer</option>
    </select>
  );
}

/** The device's own screen: on or off, its code, who's using it, and a way to watch it. Its owner's alone. */
function YourScreen({ node: n }: { node: NodeInfo }) {
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screen = computers.find((c) => c.kind === "device" && c.nodeId === n.id);
  const caps = n.capabilities?.screen;
  const users = screen ? agents.filter((a) => a.computerId === screen.id) : [];
  const working = users.filter((a) => a.status === "busy");

  const watch = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = screen ?? (await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId: n.id }));
      await useStore.getState().refreshComputers();
      go({ view: "computers", computerId: c.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = !n.online ? "Unknown until it connects" : !caps ? "Not checked yet" : caps.ok ? `On${caps.code ? ` · opens with your ${caps.code === "pin" ? "PIN" : "password"}` : ""}` : caps.off ? "Off" : "Can't be used";
  const detail = !n.online || !caps ? null : caps.ok ? (working.length ? `${working.map((a) => a.name).join(", ")} ${working.length === 1 ? "is" : "are"} using it now.` : users.length ? `${users.map((a) => a.name).join(", ")} can use it.` : "Only you can see it.") : caps.off ? null : caps.detail;

  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h2 className="font-semibold text-sm">Your screen</h2>
      <div className="mt-2 flex items-center gap-3">
        <div className="w-24 h-14 shrink-0 rounded-lg border border-line bg-hover grid place-items-center text-faint">{caps?.code ? <Lock size={17} /> : <Monitor size={17} />}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm">{status}</p>
          {detail && <p className="text-xs text-muted">{detail}</p>}
          {caps?.off && n.online && (
            <p className="text-xs text-muted">
              Turn it on at {n.name}: <code>wisp node screen on</code>
            </p>
          )}
        </div>
        {caps?.ok && n.online && (
          <Button disabled={busy} onClick={watch}>
            <Eye size={15} /> Watch
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </section>
  );
}

/** The Remote desktop mod: RustDesk's ID for this device and a link that opens RustDesk on it. Its owner's alone. */
function RemoteDesktop({ node: n }: { node: NodeInfo }) {
  const [copied, setCopied] = useState(false);
  const rustdesk = n.capabilities?.rustdesk;
  const copy = async () => {
    if (!rustdesk) return;
    await navigator.clipboard.writeText(rustdesk.id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm flex-1">Remote desktop</h2>
        {rustdesk && <Pill>RustDesk</Pill>}
      </div>
      {rustdesk ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-36">
              <div className="text-xs text-muted">ID</div>
              <div className="font-mono text-base tabular-nums">{formatRustdeskId(rustdesk.id)}</div>
            </div>
            <Button onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy ID"}
            </Button>
            <a href={`rustdesk://${encodeURIComponent(rustdesk.id)}`} className="inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-full bg-accent text-accent-ink text-sm font-medium whitespace-nowrap hover:bg-accent/90">
              <ExternalLink size={15} /> Open in RustDesk
            </a>
          </div>
          <p className="mt-2 text-xs text-muted">Use the password you set in RustDesk and saved in your password manager. Wisp never sees it.</p>
        </>
      ) : (
        <div className="mt-2 space-y-2 text-sm">
          <p className="text-muted">Reach {n.name} from anywhere with RustDesk, free and open source. Run this at {n.name}; it asks before installing anything.</p>
          <CopyBlock text="wisp node rustdesk" />
        </div>
      )}
    </section>
  );
}
