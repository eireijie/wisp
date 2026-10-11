import { useEffect, useState } from "react";
import { ChevronLeft, Plus, Server, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { Button, CopyBlock, Empty, Field, Input, Modal, cx, timeAgo } from "../components/ui.tsx";

interface NodeInfo {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string | null;
  agents: string[];
}

export function NodesView({ onBack }: { onBack?: () => void }) {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => api<NodeInfo[]>("GET", "/api/nodes").then(setNodes);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-14 shrink-0 px-3 md:px-5 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="font-semibold flex-1">Devices</h1>
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
            {nodes?.map((n) => (
              <div key={n.id} className="rounded-xl border border-line p-4 flex items-center gap-4">
                <div className={cx("size-10 rounded-xl grid place-items-center", n.online ? "bg-accent-soft text-accent" : "bg-hover text-faint")}>
                  <Server size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium flex items-center gap-2">
                    {n.name}
                    <span className={cx("text-xs rounded-full px-2 py-0.5", n.online ? "bg-accent-soft text-accent" : "bg-hover text-muted")}>{n.online ? "online" : "offline"}</span>
                  </div>
                  <div className="text-xs text-muted truncate">
                    {n.agents.length ? n.agents.map((h) => "@" + h).join(", ") : "No agents assigned"}
                    {n.lastSeen && ` · last seen ${timeAgo(n.lastSeen)}`}
                  </div>
                </div>
                <button
                  className="p-2 rounded-md hover:bg-hover text-muted hover:text-bad"
                  title="Remove device"
                  onClick={async () => {
                    if (!confirm(`Remove ${n.name}? Its token stops working.`)) return;
                    await api("DELETE", `/api/nodes/${n.id}`);
                    refresh();
                  }}
                >
                  <Trash2 size={16} />
                </button>
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

function CreateNode({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={token ? "Start the device" : "Add a device"} onClose={onClose} wide={!!token}>
      {token ? (
        <div className="space-y-4 text-sm">
          <p>
            On <b>{name}</b>, with the Warren repo checked out, run this once. The token is saved locally so later starts are just <code>warren node start</code>.
          </p>
          <CopyBlock text={`warren node start --hub ${location.origin} --token ${token} --name "${name}"`} />
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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prox-agents-1" required />
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
