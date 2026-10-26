import { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Eye, Link2, Loader2, Lock, Monitor, MoreHorizontal, Pause, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { HARNESSES, OwnRemoteDesktop, REMOTE_APPS, REMOTE_APP_IDS, formatRustdeskId, remoteDesktopLink, runsInVm, type Agent, type DeviceRole, type HarnessInfo, type RemoteApp } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { osName, useDevices } from "../devices.ts";
import { useFeature } from "../features.ts";
import { CreateAgent } from "./CreateAgent.tsx";
import { RuntimeRow, HowToInstall } from "./settings/runtimes.tsx";
import { Toggle } from "./settings/parts.tsx";
import { BackToComputers, deviceStatus } from "./ComputersParts.tsx";
import { DeviceIcon, connectionLine, type NodeInfo } from "./deviceBits.tsx";
import { AgentAvatar, Button, CopyBlock, Empty, Field, Input, Loader, Menu, Pill, StatusChip, cx, timeAgo } from "../components/ui.tsx";

/**
 * One device: the agents that run on it and what each works on, its own screen, and the rest of
 * its settings folded away. Only agents that run on a device can use its screen.
 */
export function DevicePage({ nodeId }: { nodeId: string }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
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
        <Button onClick={() => go({ view: "computers", computerId: null })}>Back to computers</Button>
      </Empty>
    );

  const remove = async () => {
    if (!confirm(`Remove ${n.name}? Its token stops working.`)) return;
    try {
      await api("DELETE", `/api/nodes/${n.id}`);
      go({ view: "computers", computerId: null });
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
  const busyUpdate = n.update?.state === "updating" || n.update?.state === "restarting";
  const st = deviceStatus(n);
  const canManage = n.mine || isOwner;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 px-4 md:px-6 pt-5 pb-3 flex items-center gap-3 safe-top">
        <BackToComputers />
        <DeviceIcon online={n.online} />
        <div className="flex-1 min-w-0">
          <h1 className="t-title truncate">{n.name}</h1>
          <div className="text-[13px] text-faint truncate">{[n.mine ? "You" : n.ownerName ? `${n.ownerName}'s` : null, n.capabilities ? osName(n.capabilities.platform) : null].filter(Boolean).join(" · ")}</div>
        </div>
        <Pill tone={st.tone}>
          {n.paused && st.label === "Paused" && <Pause size={11} />}
          {st.label}
        </Pill>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl p-4 md:px-6 md:pb-8 space-y-3.5">
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          {n.paused && (
            <p className="rounded-2xl bg-card px-4 py-3 text-sm text-muted">
              Paused at the device. Resume it there with <code>wisp node resume</code>.
            </p>
          )}
          {!n.online && canManage && <OfflineHelp node={n} onChanged={refresh} />}
          {n.update?.state && n.update.state !== "idle" && <UpdateStatus node={n} />}
          <RoleSection node={n} onChange={refresh} />
          <AgentsHere node={n} onAdd={() => setCreating(true)} />
          {n.mine && <YourScreen node={n} />}
          {n.mine && remoteDesktop && <RemoteDesktop node={n} onChange={refresh} />}
          <Harnesses node={n} />
          {canManage && (
            <section className="rounded-3xl bg-card divide-y divide-line overflow-hidden">
              {isOwner && n.online && (
                <button disabled={busyUpdate} onClick={update} className="w-full text-left px-4 py-3.5 flex items-center gap-3 hover:bg-hover disabled:opacity-50">
                  <Download size={18} className="text-muted shrink-0" />
                  <span className="flex-1">
                    <span className="block text-body font-medium">{busyUpdate ? "Updating…" : "Update Wisp"}</span>
                    <span className="block text-xs text-faint">Get the latest Wisp on this device and restart it</span>
                  </span>
                </button>
              )}
              <button onClick={remove} className="w-full text-left px-4 py-3.5 flex items-center gap-3 hover:bg-hover text-bad">
                <Trash2 size={18} className="shrink-0" />
                <span className="flex-1">
                  <span className="block text-body font-medium">Remove device</span>
                  <span className="block text-xs text-faint">Its token stops working.</span>
                </span>
              </button>
            </section>
          )}
          {n.mine && (
            <p className="px-1 text-xs text-muted">
              At {n.name}: <code>wisp node screen code</code> picks a new screen code, and <code>wisp node pause</code> stops everything there until <code>wisp node resume</code>.
            </p>
          )}
        </div>
      </div>
      {creating && <CreateAgentHere nodeId={n.id} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** What the device does for agents, and who else may add agents and VMs to it. */
const ROLE_ROWS: { id: DeviceRole; title: string; body: string }[] = [
  { id: "vms", title: "Runs VMs", body: "Agents get their own virtual computer here" },
  { id: "screen", title: "Lets agents use its screen", body: "Agents ask before they take over your screen" },
  { id: "headless", title: "Headless", body: "Agents work in the background only" },
];

function RoleSection({ node: n, onChange }: { node: NodeInfo; onChange: () => void }) {
  const patch = async (body: object) => {
    await api("PATCH", `/api/nodes/${n.id}`, body).catch((err) => alert((err as Error).message));
    onChange();
  };
  return (
    <section className="rounded-3xl bg-card p-4 space-y-3">
      <h2 className="font-semibold text-body">What this device does for agents</h2>
      <div role="radiogroup" aria-label={`What ${n.name} does for agents`} className="space-y-2">
        {ROLE_ROWS.map((r) => {
          const on = n.role === r.id;
          return (
            <button key={r.id} type="button" role="radio" aria-checked={on} disabled={!n.mine} onClick={() => void patch({ role: r.id })} className={cx("w-full text-left rounded-2xl border px-4 py-3 flex items-center gap-3 disabled:cursor-default", on ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-hover")}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">{r.title}</span>
                <span className="block text-xs text-muted">{r.body}</span>
              </span>
              {on && <Check size={18} className="text-accent-text shrink-0" />}
            </button>
          );
        })}
        {!n.role && !n.mine && <p className="text-xs text-muted">No job chosen yet</p>}
      </div>
      <div className="flex items-center gap-3 pt-1">
        <span className="flex-1">
          <span className="block text-sm font-medium">{n.mine ? "Share with the organization" : n.shared ? "Shared" : "Private"}</span>
          <span className="block text-xs text-muted">{n.mine ? "Let others in the organization add agents and VMs here" : n.shared ? "Anyone in the organization can add agents and VMs here." : `Only ${n.ownerName ?? "its owner"} can add agents and VMs here.`}</span>
        </span>
        {n.mine ? <Toggle on={n.shared} onChange={(shared) => void patch({ shared })} label="Let others in the organization add agents and VMs here" /> : n.shared ? <Users size={16} className="text-muted" /> : <Lock size={16} className="text-muted" />}
      </div>
    </section>
  );
}

/** How to bring an offline device back, and a button to look again. */
function OfflineHelp({ node: n, onChanged }: { node: NodeInfo; onChanged: () => void }) {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await api("POST", `/api/nodes/${n.id}/refresh`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    onChanged();
    setChecking(false);
  };
  const steps = ["Turn it on and wake it up", "Make sure it is on the same Wi-Fi, or Away from home is on", n.lastSeen ? "Open Wisp on it if it is not running" : "Open Wisp on it and pick Join my Wisp"];
  return (
    <section className="rounded-3xl bg-card p-4 space-y-3">
      <div>
        <h2 className="font-semibold text-body">{n.name} is offline</h2>
        <p className="text-sm text-muted">{connectionLine(n, timeAgo)}. Agents on it are paused until it is back.</p>
      </div>
      <h3 className="text-xs font-semibold text-faint">To bring it back</h3>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-3 rounded-2xl bg-panel border border-line px-3.5 py-2.5 text-sm">
            <span className="size-6 shrink-0 rounded-full bg-chip grid place-items-center text-xs font-medium">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <Button onClick={check} disabled={checking}>
        <RefreshCw size={14} className={cx(checking && "animate-spin")} /> Check again
      </Button>
    </section>
  );
}

/** Where an update is: getting the latest, restarting, or failed. */
function UpdateStatus({ node: n }: { node: NodeInfo }) {
  const failed = n.update?.state === "failed";
  return (
    <section className="rounded-3xl bg-card p-4 space-y-1.5" role="status">
      <h2 className="font-semibold text-body flex items-center gap-2">
        {!failed && <Loader2 size={15} className="animate-spin text-muted" />}
        {failed ? "Update failed" : `Updating Wisp on ${n.name}`}
      </h2>
      <p className={cx("text-sm whitespace-pre-wrap", failed ? "text-bad" : "text-muted")}>{n.update?.message || (failed ? "Try again from this page." : "Getting the latest Wisp and restarting it. Agents on this device pause for a moment, then pick up where they left off.")}</p>
    </section>
  );
}

/** The agent tools this device can run, with Install for the ones Wisp can install. */
function Harnesses({ node: n }: { node: NodeInfo }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [howTo, setHowTo] = useState<HarnessInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const installed = new Map((n.harnesses ?? []).map((h) => [h.id, h.version]));
  const list = HARNESSES.filter((h) => h.protocol !== "mcp");
  const install = async (h: HarnessInfo) => {
    setBusy(h.id);
    setError(null);
    setNote(null);
    try {
      await api("POST", `/api/nodes/${n.id}/install`, { harness: h.id });
      setNote(`${h.label} is installed on ${n.name}. Sign it in there before agents use it: ${h.login ?? h.binary}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setChecking(true);
    await api("POST", `/api/nodes/${n.id}/refresh`).catch((e) => setError((e as Error).message));
    await new Promise((r) => setTimeout(r, 2500));
    setChecking(false);
  };
  return (
    <section className="rounded-3xl bg-card overflow-hidden">
      <div className="px-4 pt-4 pb-1 flex items-center gap-2">
        <h2 className="font-semibold text-body flex-1">Agent harnesses</h2>
        <Button variant="ghost" onClick={refresh} disabled={checking || !n.online}>
          <RefreshCw size={14} className={cx(checking && "animate-spin")} /> Refresh
        </Button>
      </div>
      {error && <p className="px-4 pb-2 text-sm text-bad whitespace-pre-wrap">{error}</p>}
      {note && <p className="mx-4 mb-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
      <div className="divide-y divide-line">
        {list.map((h) => (
          <RuntimeRow key={h.id} h={h} device={n} version={installed.get(h.id)} busy={busy === h.id} onInstall={() => void install(h)} onHowTo={() => setHowTo(h)} />
        ))}
      </div>
      {howTo && <HowToInstall h={howTo} device={n} onClose={() => setHowTo(null)} />}
    </section>
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

/** What to put in each kind of field, and an example. */
const FIELD_HINT = {
  id: { label: "Its ID", placeholder: "123 456 789" },
  address: { label: "Computer name or address", placeholder: "shop-pc.local or 192.168.1.20" },
  link: { label: "Link", placeholder: "https://…" },
} as const;

/**
 * The Remote desktop mod: how its owner reaches this device from anywhere. RustDesk (set up at the
 * device), or the app they already use, by its ID, address or link. Never a password. Its owner's alone.
 */
function RemoteDesktop({ node: n, onChange }: { node: NodeInfo; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [showRustdesk, setShowRustdesk] = useState(false);
  const rustdesk = n.capabilities?.rustdesk;
  const own = n.remoteDesktop;
  const save = async (remoteDesktop: OwnRemoteDesktop | null) => {
    await api("PATCH", `/api/nodes/${n.id}`, { remoteDesktop });
    setEditing(false);
    onChange();
  };
  const remove = () => {
    if (confirm(`Stop showing ${own ? REMOTE_APPS[own.app].label : "this app"} here? The app itself isn't changed.`)) void save(null).catch((e) => alert((e as Error).message));
  };
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h2 className="font-semibold text-sm">Remote desktop</h2>
      {rustdesk && <RemoteRow label="RustDesk" value={formatRustdeskId(rustdesk.id)} copy={rustdesk.id} link={`rustdesk://${encodeURIComponent(rustdesk.id)}`} note="Use the password you set in RustDesk. Wisp never sees it." />}
      {own && !editing && <RemoteRow label={own.app === "other" && own.name ? own.name : REMOTE_APPS[own.app].label} value={REMOTE_APPS[own.app].field === "id" ? formatRustdeskId(own.value) : own.value} copy={own.value} link={remoteDesktopLink(own)} onChange={() => setEditing(true)} onRemove={remove} />}
      {editing ? (
        <OwnAppForm node={n} current={own ?? null} onSave={save} onCancel={() => setEditing(false)} />
      ) : !rustdesk && !own ? (
        showRustdesk ? (
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-muted">Run this at {n.name}. It asks before installing RustDesk, then shows its ID here.</p>
            <CopyBlock text="wisp node rustdesk" />
            <button className="text-xs text-muted hover:text-ink" onClick={() => setShowRustdesk(false)}>
              Back
            </button>
          </div>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-muted">Reach {n.name} from anywhere.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button onClick={() => setShowRustdesk(true)} className="rounded-xl border-2 border-accent/60 p-3 text-left hover:bg-hover">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Download size={15} /> Set up RustDesk
                </div>
                <p className="mt-0.5 text-xs text-muted">Free and open source. {n.name} installs it after asking you there.</p>
              </button>
              <button onClick={() => setEditing(true)} className="rounded-xl border border-line p-3 text-left hover:bg-hover">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Link2 size={15} /> I already use one
                </div>
                <p className="mt-0.5 text-xs text-muted">{n.capabilities?.remoteApps?.length ? `${n.capabilities.remoteApps.map((a) => REMOTE_APPS[a as RemoteApp]?.label ?? a).join(", ")} ${n.capabilities.remoteApps.length === 1 ? "is" : "are"} on ${n.name}.` : "TeamViewer, AnyDesk, Chrome Remote Desktop, Windows Remote Desktop, VNC…"}</p>
              </button>
            </div>
          </>
        )
      ) : (
        !own && (
          <button className="mt-2 text-xs text-muted hover:text-ink" onClick={() => setEditing(true)}>
            Add another app you use
          </button>
        )
      )}
    </section>
  );
}

/** One way in: the app, the device's ID or address in it, Copy, and Open where the app has a link. */
function RemoteRow({ label, value, copy, link, note, onChange, onRemove }: { label: string; value: string; copy: string; link: string | null; note?: string; onChange?: () => void; onRemove?: () => void }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    await navigator.clipboard.writeText(copy).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mt-2 pt-2 first-of-type:pt-0 border-t first-of-type:border-t-0 border-line">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-36">
          <div className="text-xs text-muted">{label}</div>
          <div className="font-mono text-base tabular-nums break-all">{value}</div>
        </div>
        <Button onClick={doCopy}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy"}
        </Button>
        {link && (
          <a href={link} target={link.startsWith("https:") ? "_blank" : undefined} rel="noopener noreferrer" className="inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-full bg-accent text-accent-ink text-sm font-medium whitespace-nowrap hover:bg-accent/90">
            <ExternalLink size={15} /> Open
          </a>
        )}
        {(onChange || onRemove) && (
          <Menu
            align="right"
            items={[...(onChange ? [{ label: "Change", onSelect: onChange }] : []), ...(onRemove ? [{ label: "Remove", danger: true, onSelect: onRemove }] : [])]}
            trigger={(open, toggle) => (
              <button className={cx("p-1.5 rounded-md text-muted hover:bg-hover hover:text-ink", open && "bg-hover text-ink")} aria-label={`More for ${label}`} onClick={toggle}>
                <MoreHorizontal size={16} />
              </button>
            )}
          />
        )}
      </div>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** Which app, and the device's ID, address or link in it. Apps found on the device come first. */
function OwnAppForm({ node: n, current, onSave, onCancel }: { node: NodeInfo; current: OwnRemoteDesktop | null; onSave: (r: OwnRemoteDesktop) => Promise<void>; onCancel: () => void }) {
  const found = (n.capabilities?.remoteApps ?? []).filter((a): a is RemoteApp => a in REMOTE_APPS);
  const order = [...found, ...REMOTE_APP_IDS.filter((a) => !found.includes(a))];
  const [app, setApp] = useState<RemoteApp>(current?.app ?? order[0]);
  const [value, setValue] = useState(current?.value ?? "");
  const [name, setName] = useState(current?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = FIELD_HINT[REMOTE_APPS[app].field];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // IDs are often copied with spaces ("123 456 789")
    const v = REMOTE_APPS[app].field === "id" ? value.replace(/\s+/g, "") : value.trim();
    const r = { app, value: v, ...(app === "other" && name.trim() ? { name: name.trim() } : {}) };
    const check = OwnRemoteDesktop.safeParse(r);
    if (!check.success) return setError(check.error.issues[0]?.message ?? "Check what you entered.");
    setBusy(true);
    setError(null);
    try {
      await onSave(check.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <Field label="App">
        <select value={app} onChange={(e) => setApp(e.target.value as RemoteApp)} className="h-9 w-full rounded-xl border border-input bg-panel px-3 text-sm text-ink">
          {order.map((a) => (
            <option key={a} value={a}>
              {REMOTE_APPS[a].label}
              {found.includes(a) ? ` (on ${n.name})` : ""}
            </option>
          ))}
        </select>
      </Field>
      {app === "other" && (
        <Field label="Its name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Parsec" maxLength={60} />
        </Field>
      )}
      <Field label={field.label} hint={app === "chrome" ? "From remotedesktop.google.com/access, or leave it at that page." : undefined}>
        <Input value={value} onChange={(e) => (setValue(e.target.value), setError(null))} placeholder={app === "chrome" ? "https://remotedesktop.google.com/access" : field.placeholder} autoFocus />
      </Field>
      <p className="text-xs text-muted">Only you see this. Keep the app's password in your password manager; Wisp never asks for it.</p>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !value.trim()}>
          Save
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
