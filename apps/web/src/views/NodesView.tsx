import { originReach, shareOrigin, useAccess } from "../access.ts";
import { desktopOs, downloadsFor } from "../downloads.ts";
import { useEffect, useState } from "react";
import { ChevronLeft, Download, Lock, Monitor, MoreHorizontal, Pause, Plus, Server, Trash2, Users } from "lucide-react";
import type { DeviceCapabilities, DeviceRole } from "@wisp/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { useDesktopInfo } from "../desktop.ts";
import { Toggle } from "./settings/parts.tsx";
import { AgentAvatar, Button, CopyBlock, DeviceInstall, Empty, Field, Input, Menu, Modal, Pill, cx, timeAgo } from "../components/ui.tsx";

interface NodeInfo {
  id: string;
  name: string;
  ownerName: string | null;
  mine: boolean;
  shared: boolean;
  /** what it does for agents; null until its owner chooses */
  role: DeviceRole | null;
  paused: boolean;
  capabilities: DeviceCapabilities | null;
  online: boolean;
  lastSeen: string | null;
  agents: string[];
  /** the Wisp version it runs; null for devices from before updates */
  version: { commit: string | null; date: string | null } | null;
  update: { state: "idle" | "updating" | "restarting" | "failed"; message: string } | null;
}

/** "Connected" while online; otherwise when it was last seen. Never both, so it can't contradict the pill. */
export function connectionLine(n: { online: boolean; lastSeen: string | null }, ago: (iso: string) => string): string {
  if (n.online) return "Connected";
  return n.lastSeen ? `Last seen ${ago(n.lastSeen)}` : "Never connected";
}

/** What we can say about the device's own screen. Offline means unknown, whatever we saw last time. */
export function screenLine(n: { online: boolean; capabilities: DeviceCapabilities | null }): string {
  const last = n.capabilities?.screen;
  if (n.online && last) return "";
  if (n.online) return "Its screen: not checked yet.";
  const base = "Its screen: unknown until it connects.";
  if (!last) return base;
  return `${base} (Last time: ${last.ok ? "on" : "off"}.)`;
}

export { isLocalOnlyHost } from "../loopback.ts";

/** What to tell someone about a device that is not connected; null while it is connected. */
export function notConnectedLine(n: { online: boolean; lastSeen: string | null }): string | null {
  if (n.online) return null;
  return n.lastSeen ? "This device was connected before but is offline now." : "This device hasn't connected yet.";
}

/**
 * Shown on a device that is not connected: one line, with the how-to folded away until asked for.
 * One that never connected can get a fresh connection code here, so a lost code or a failed setup
 * is never a dead end; inside the Wisp app it's one button that makes this computer that device.
 */
function ConnectDevice({ node: n, onChange }: { node: NodeInfo; onChange: () => void }) {
  useAccess();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { inDesktop, info } = useDesktopInfo();
  const line = notConnectedLine(n);
  if (!line) return null;
  const waiting = !n.lastSeen;
  // the app on this computer isn't a device yet, so it can become this one
  const canClaim = waiting && inDesktop && info !== null && !info.device;

  const newCode = async () => {
    setError("");
    const { token } = await api<{ token: string }>("POST", `/api/nodes/${n.id}/token`);
    return token;
  };
  const showCommand = async () => {
    try {
      setToken(await newCode());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const claim = async () => {
    setBusy(true);
    try {
      await window.wispDesktop?.connectDevice({ token: await newCode(), name: n.name });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl bg-hover/60 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-muted">{n.lastSeen ? "Open Wisp on this computer to bring it back." : canClaim ? "Is this that computer?" : "Start Wisp on this computer to connect it."}</p>
        {canClaim && (
          <Button variant="primary" disabled={busy} onClick={claim}>
            {busy ? "Connecting…" : "Connect this computer"}
          </Button>
        )}
        <button className="shrink-0 text-xs font-medium text-ink hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : canClaim ? "Another computer?" : "How?"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      {open && (
        <div className="mt-3 space-y-2 text-xs">
          <p>
            <a className="font-medium underline" href={downloadsFor(desktopOs()).href} target="_blank" rel="noopener noreferrer">
              Get the Wisp app
            </a>
            , choose to join a server, and enter:
          </p>
          <CopyBlock text={shareOrigin()} />
          {originReach(shareOrigin()) !== "anywhere" && <p className="text-muted">This address only works on {originReach(shareOrigin()) === "this-computer" ? "this computer" : "this Wi-Fi"}. For a computer somewhere else, turn on Settings → Devices → Access first.</p>}
          {waiting && <p className="text-muted">Then open Devices there and choose Connect this computer on this card.</p>}
          {waiting &&
            (token ? (
              <DeviceInstall token={token} name={n.name} />
            ) : (
              <p className="text-muted">
                Prefer a command?{" "}
                <button className="font-medium text-ink underline" onClick={showCommand}>
                  Show it
                </button>{" "}
                (it has a new connection code; an older one stops working).
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

/** The device's tile: a server that lights up and pulses while it's connected. */
function DeviceIcon({ online }: { online: boolean }) {
  return (
    <div className={cx("relative size-11 shrink-0 rounded-xl grid place-items-center transition-colors", online ? "bg-accent-soft text-accent-text" : "bg-hover text-faint")}>
      <Server size={19} />
      <span className="absolute -bottom-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-panel">
        {online && <span className="absolute size-2.5 rounded-full motion-safe:animate-ping" style={{ background: "var(--status-online)", opacity: 0.6 }} />}
        <span className="relative size-2.5 rounded-full" style={{ background: online ? "var(--status-online)" : "var(--status-idle)" }} />
      </span>
    </div>
  );
}

/** Who lives on the device, as their ghosts. */
function DeviceAgents({ handles, online }: { handles: string[]; online: boolean }) {
  const all = useStore((s) => s.agents);
  if (!handles.length) return <p className="mt-3 text-xs text-faint">No agents here yet.</p>;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {handles.map((h) => {
        const agent = all.find((a) => a.handle === h);
        return (
          <span key={h} className={cx("inline-flex items-center gap-1.5 rounded-full bg-hover py-0.5 pl-0.5 pr-2.5 text-xs", !online && "opacity-60")}>
            {agent ? <AgentAvatar agent={agent} size={22} live={online} /> : <span className="size-[22px]" />}
            {agent?.name ?? "@" + h}
          </span>
        );
      })}
    </div>
  );
}

export function NodesView({ onBack }: { onBack?: () => void }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [hubCommit, setHubCommit] = useState<string | null>(null);
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const refresh = () => api<NodeInfo[]>("GET", "/api/nodes").then(setNodes);
  useEffect(() => {
    refresh();
    api<{ version: { commit: string | null } }>("GET", "/api/updates").then((u) => setHubCommit(u.version.commit), () => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const update = async (n: NodeInfo) => {
    try {
      await api("POST", `/api/nodes/${n.id}/update`);
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  };
  const remove = async (n: NodeInfo) => {
    if (!confirm(`Remove ${n.name}? Its token stops working.`)) return;
    setRemoveError(null);
    try {
      await api("DELETE", `/api/nodes/${n.id}`);
      await refresh();
    } catch (e) {
      setRemoveError(`Couldn't remove ${n.name}: ${(e as Error).message}`);
    }
  };
  const online = nodes?.filter((n) => n.online).length ?? 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-lg font-bold tracking-tight flex-1 truncate">Devices</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Add device
        </Button>
      </header>
      {removeError && <p role="alert" className="px-4 md:px-6 py-2 text-xs text-bad">{removeError}</p>}
      <div className="flex-1 overflow-y-auto">
        {nodes && nodes.length === 0 ? (
          <Empty icon={<Server />} title="Connect a device">
            <p>A device is any computer that runs agents: a laptop, a server, a VM. It connects out to this hub, so it works behind home routers and firewalls.</p>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> Add device
            </Button>
          </Empty>
        ) : (
          <div className="max-w-3xl p-4 md:p-8 space-y-3">
            {nodes && (
              <p className="text-sm text-muted" title="A device is a computer running Wisp. Agents run on it.">
                {online} of {nodes.length} online
              </p>
            )}
            {nodes?.map((n) => {
              const busy = n.update?.state === "updating" || n.update?.state === "restarting";
              const behind = !!(hubCommit && n.version?.commit && n.version.commit !== hubCommit);
              const canUpdate = isOwner && n.online;
              const menu = [
                ...(canUpdate && !busy ? [{ label: "Update Wisp", icon: <Download size={15} />, onSelect: () => update(n) }] : []),
                ...(n.mine || isOwner ? [{ label: "Remove device", icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(n) }] : []),
              ];
              return (
                <div key={n.id} className="rounded-2xl border border-line bg-panel p-4 transition-shadow hover:shadow-sm">
                  <div className="flex items-center gap-3">
                    <DeviceIcon online={n.online} />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium truncate">{n.name}</span>
                        {n.paused && (
                          <Pill tone="warn">
                            <Pause size={11} /> Paused
                          </Pill>
                        )}
                        {!n.mine && n.ownerName && <span className="text-xs text-muted">{n.ownerName}'s</span>}
                      </div>
                      <div className="text-xs text-muted truncate" title={n.version?.commit ? `Wisp ${n.version.commit}${behind ? ` (hub runs ${hubCommit})` : ""}` : undefined}>
                        {n.online ? "Online" : `Offline · ${connectionLine(n, timeAgo)}`}
                      </div>
                    </div>
                    {canUpdate && (busy || behind) && (
                      <Button variant="ghost" disabled={busy} title="Get the latest Wisp on this device and restart it" onClick={() => update(n)}>
                        <Download size={15} /> {busy ? "Updating…" : "Update"}
                      </Button>
                    )}
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
                  </div>
                  <DeviceAgents handles={n.agents} online={n.online} />
                  {(n.mine || isOwner) && <ConnectDevice node={n} onChange={refresh} />}
                  <DeviceAccess node={n} onChange={refresh} />
                  {n.update?.message && (
                    <p className={cx("mt-3 text-xs whitespace-pre-wrap", n.update.state === "failed" ? "text-bad" : "text-muted")}>
                      {n.update.state !== "idle" && (
                        <span className="mr-2 align-middle">
                          <Pill tone={n.update.state === "failed" ? "bad" : "info"}>{n.update.state === "failed" ? "Update failed" : n.update.state === "restarting" ? "Restarting" : "Updating"}</Pill>
                        </span>
                      )}
                      {n.update.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {creating && (
        <CreateNode
          onClose={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** What the device does for agents. */
const ROLES: Record<DeviceRole, string> = { vms: "Runs agents' VMs", screen: "Lets its agents use its screen", headless: "Runs agents headless" };

/** The device's own screen in two words; the full story goes in the tooltip. */
function screenSummary(n: NodeInfo): { short: string; long: string } {
  const screen = n.capabilities?.screen;
  if (!screen || !n.online) return { short: n.online ? "Screen not checked" : "Screen unknown", long: screenLine(n) };
  if (screen.ok) return { short: "Screen on", long: n.mine ? "Only you can see it, and only agents that run on it can use it." : `It's ${n.ownerName ?? "its owner"}'s alone.` };
  if (screen.off) return { short: "Screen off", long: n.mine ? `Agents use VMs instead. To use it yourself from Wisp, run "wisp node screen on" on ${n.name}.` : "Its own screen is off." };
  return { short: "No screen", long: `Its own screen can't be used: ${screen.detail}` };
}

/** One quiet row of settings: its job, its screen, and who else can use it. Explanations live in tooltips. */
function DeviceAccess({ node: n, onChange }: { node: NodeInfo; onChange: () => void }) {
  const screen = screenSummary(n);
  const patch = async (body: object) => {
    await api("PATCH", `/api/nodes/${n.id}`, body).catch((err) => alert((err as Error).message));
    onChange();
  };
  return (
    <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
      {n.mine ? (
        <select
          aria-label={`What ${n.name} does for agents`}
          value={n.role ?? ""}
          onChange={(e) => patch({ role: e.target.value || null })}
          className={cx("h-7 rounded-md border bg-panel px-1.5 text-xs text-ink", n.role ? "border-line" : "border-accent")}
        >
          {!n.role && <option value="">Choose what it does…</option>}
          {(Object.keys(ROLES) as DeviceRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLES[r]}
            </option>
          ))}
        </select>
      ) : (
        <span>{n.role ? ROLES[n.role] : "No job chosen yet"}</span>
      )}
      <span className="inline-flex items-center gap-1.5 cursor-help" title={screen.long}>
        <Monitor size={13} /> {screen.short}
      </span>
      {n.mine ? (
        <label className="inline-flex items-center gap-2 cursor-pointer" title="Off for a personal computer: agents that run directly on it then only take requests from you.">
          <Toggle on={n.shared} onChange={(shared) => patch({ shared })} label="Let others in the organization add agents and VMs here" />
          Shared with workspace
        </label>
      ) : (
        <span className="inline-flex items-center gap-1.5" title={n.shared ? "Anyone in the organization can add agents and VMs here." : `Only ${n.ownerName ?? "its owner"} can add agents and VMs here.`}>
          {n.shared ? <Users size={13} /> : <Lock size={13} />} {n.shared ? "Shared" : "Private"}
        </span>
      )}
    </div>
  );
}

function CreateNode({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={token ? "Start the device" : "Add a device"} onClose={onClose} wide={!!token}>
      {token ? (
        <div className="space-y-4 text-sm">
          <p>
            On <b>{name}</b>, run this once. It installs Wisp if it isn't there yet and keeps the device connected.
          </p>
          <DeviceInstall token={token} name={name} />
          <p className="text-muted">The token is shown only once. Then assign agents to this device from the Agents page.</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setToken((await api<{ token: string }>("POST", "/api/nodes", { name })).token);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <Field label="Device name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-laptop" required />
          </Field>
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end">
            <Button variant="primary">Create</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
