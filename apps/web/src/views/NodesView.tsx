import { useEffect, useState } from "react";
import { Bot, ChevronLeft, Download, Lock, Monitor, Pause, Plus, Server, Trash2, Users } from "lucide-react";
import type { DeviceCapabilities, DeviceRole } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { ConnectWithApp, ConnectWithCommand } from "../components/ConnectWithApp.tsx";
import { Button, DeviceInstall, Empty, Field, IconButton, Input, Modal, Pill, cx, timeAgo } from "../components/ui.tsx";

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
  /** the Warren version it runs; null for devices from before updates */
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

/** Opened on the computer running the hub itself, so the address only works there. */
export function isLocalOnlyHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) || hostname.endsWith(".localhost");
}

/** What to tell someone about a device that is not connected; null while it is connected. */
export function notConnectedLine(n: { online: boolean; lastSeen: string | null }): string | null {
  if (n.online) return null;
  return n.lastSeen ? "This device was connected before but is offline now." : "This device hasn't connected yet.";
}

/** Shown on a device that is not connected: a fresh connection code, then the app (no Terminal) or a command. */
function ConnectDevice({ node: n }: { node: NodeInfo }) {
  const line = notConnectedLine(n);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!line) return null;
  if (code)
    return (
      <div className="mt-3 ml-14 space-y-3 text-sm">
        <p className="font-medium">Connect {n.name}</p>
        <ConnectWithApp name={n.name} token={code} connected={n.online} />
        <ConnectWithCommand name={n.name} token={code} />
      </div>
    );
  return (
    <div className="mt-3 ml-14 rounded-lg border border-line bg-panel p-3 space-y-2 text-sm">
      <p className="font-medium">Connect this device</p>
      <p className="text-muted">{line}</p>
      <p className="text-xs text-muted">A connection code lets the Warren app on that computer join as {n.name}. Get a new one here whenever you need it.</p>
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setCode((await api<{ token: string }>("POST", `/api/nodes/${n.id}/token`)).token);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Get a new connection code
      </Button>
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}

export function NodesView({ onBack }: { onBack?: () => void }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [hubCommit, setHubCommit] = useState<string | null>(null);
  const isOwner = useStore((s) => s.me)?.role === "owner";
  const refresh = () => api<NodeInfo[]>("GET", "/api/nodes").then(setNodes);
  useEffect(() => {
    refresh();
    api<{ version: { commit: string | null } }>("GET", "/api/updates").then((u) => setHubCommit(u.version.commit), () => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Devices</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Add device
        </Button>
      </header>
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
            <p className="text-sm text-muted">A device is a computer running Warren. Helpers run on it. Add one for each computer you want helpers to use.</p>
            {nodes?.map((n) => (
              <div key={n.id} className="rounded-xl border border-line p-4">
                <div className="flex items-center gap-4">
                  <div className={cx("size-10 rounded-xl grid place-items-center", n.online ? "bg-accent-soft text-accent-text" : "bg-hover text-faint")}>
                    <Server size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium flex flex-wrap items-center gap-2">
                      {n.name}
                      <span className={cx("text-xs rounded-full px-2 py-0.5", n.online ? "bg-accent-soft text-accent-text" : "bg-hover text-muted")}>{n.online ? "Online" : "Offline"}</span>
                      {n.paused && (
                        <Pill tone="warn">
                          <Pause size={11} /> Paused at the device
                        </Pill>
                      )}
                      <span className="text-xs font-normal text-muted">{n.mine ? "Yours" : n.ownerName ? `${n.ownerName}'s` : ""}</span>
                    </div>
                    <div className="text-xs text-muted truncate">
                      {n.agents.length ? n.agents.map((h) => "@" + h).join(", ") : "No helpers yet"}
                      {` · ${connectionLine(n, timeAgo)}`}
                      {n.version?.commit && (
                        <>
                          {" · "}Warren <code>{n.version.commit}</code>
                          {hubCommit && n.version.commit !== hubCommit && <span title={`The hub runs ${hubCommit}`}> (hub: {hubCommit})</span>}
                        </>
                      )}
                    </div>
                  </div>
                  {isOwner && n.online && (
                    <Button
                      title="Get the latest Warren on this device and restart it"
                      aria-label="Update"
                      disabled={n.update?.state === "updating" || n.update?.state === "restarting"}
                      onClick={async () => {
                        try {
                          await api("POST", `/api/nodes/${n.id}/update`);
                        } catch (e) {
                          alert((e as Error).message);
                        }
                        refresh();
                      }}
                    >
                      <Download size={15} /> <span className="hidden sm:inline">Update</span>
                    </Button>
                  )}
                  {(n.mine || isOwner) && (
                    <IconButton
                      icon={<Trash2 size={16} />}
                      label="Remove device"
                      tone="danger"
                      onClick={async () => {
                        if (!confirm(`Remove ${n.name}? Its token stops working.`)) return;
                        await api("DELETE", `/api/nodes/${n.id}`);
                        refresh();
                      }}
                    />
                  )}
                </div>
                {(n.mine || isOwner) && <ConnectDevice node={n} />}
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
            ))}
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

/** Who can use the device: its own screen (only its owner, and only once it's on at the device) and whether others can add agents. */
const ROLES: Record<DeviceRole, string> = { vms: "runs their computers (VMs)", screen: "lends them its own screen", headless: "runs them headless" };

function DeviceAccess({ node: n, onChange }: { node: NodeInfo; onChange: () => void }) {
  const screen = n.capabilities?.screen;
  return (
    <div className="mt-3 pl-14 space-y-1.5 text-xs text-muted">
      <div className="flex items-center gap-2">
        <Bot size={13} className="shrink-0" />
        {n.mine ? (
          <label className="flex items-center gap-2">
            For agents, it
            <select
              aria-label={`What ${n.name} does for agents`}
              value={n.role ?? ""}
              onChange={async (e) => {
                await api("PATCH", `/api/nodes/${n.id}`, { role: e.target.value || null }).catch((err) => alert((err as Error).message));
                onChange();
              }}
              className="h-7 rounded-md border border-line bg-panel px-1.5 text-xs text-ink"
            >
              {!n.role && <option value="">Not chosen yet</option>}
              {(Object.keys(ROLES) as DeviceRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLES[r]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>For agents, it {n.role ? ROLES[n.role] : "has no job chosen yet"}.</span>
        )}
      </div>
      <div className="flex items-start gap-2">
        <Monitor size={13} className="mt-0.5 shrink-0" />
        <span>
          {!screen || !n.online
            ? screenLine(n)
            : screen.ok
              ? n.mine
                ? "Its own screen is on: only you can see it, and agents only while you lend it to them (Computers)."
                : `Its own screen is ${n.ownerName ?? "its owner"}'s alone.`
              : screen.off
                ? n.mine
                  ? <>Its own screen is off. Agents use VMs instead. To use it yourself from Warren, run <code>warren node screen on</code> on {n.name}.</>
                  : "Its own screen is off."
                : `Its own screen can't be used: ${screen.detail}`}
        </span>
      </div>
      {n.mine ? (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={n.shared}
            onChange={async (e) => {
              await api("PATCH", `/api/nodes/${n.id}`, { shared: e.target.checked }).catch((err) => alert((err as Error).message));
              onChange();
            }}
          />
          <span>
            <span className="text-ink">Let others in the workspace add agents and VMs here</span>
            <br />
            Leave this off for a personal computer. Agents that run directly on it then only take requests from you.
          </span>
        </label>
      ) : (
        <div className="flex items-start gap-2">
          {n.shared ? <Users size={13} className="mt-0.5 shrink-0" /> : <Lock size={13} className="mt-0.5 shrink-0" />}
          <span>{n.shared ? "Anyone in the workspace can add agents and VMs here." : `Only ${n.ownerName ?? "its owner"} can add agents and VMs here.`}</span>
        </div>
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
            On <b>{name}</b>, run this once. It installs Warren if it isn't there yet and keeps the device connected.
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
