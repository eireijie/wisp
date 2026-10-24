import { useEffect, useState } from "react";
import { AppWindow, Globe, Monitor, Plus, Smartphone } from "lucide-react";
import { api } from "../../api.ts";
import { useAccess, useAccessStore, type AccessInfo } from "../../access.ts";
import { canApproveJoin, loadMcpClients, unavailable, type McpClient } from "../../join.ts";
import { useStore } from "../../store.ts";
import { useDevices } from "../../devices.ts";
import { href } from "../../router.ts";
import { AddDeviceDialog } from "../../components/AddDevice.tsx";
import { AwayFromHome, awayEnabled, connectorOrigin, enableTailscale } from "../../components/Access.tsx";
import { Button, CopyBlock } from "../../components/ui.tsx";
import { Card, Row, Toggle } from "./parts.tsx";

export function DevicesPage() {
  const devices = useDevices(3000);
  const info = useAccess(3000);
  const failed = useAccessStore((s) => s.failed);
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [adding, setAdding] = useState(false);
  const [setupAway, setSetupAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = awayEnabled(info);
  const cloudflare = info?.cloudflare?.state === "running";
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(unavailable(e, "Away from home"));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    if (cloudflare) {
      await api("POST", "/api/reach/cloudflare", { action: "stop" });
      await useAccessStore.getState().refresh(true);
    } else if (info?.tailscale.serving) {
      if (info.tailscale.funnel) await useAccessStore.getState().act("unfunnel");
      await useAccessStore.getState().act("unserve");
    } else throw new Error("This Wisp already uses a public address.");
  };
  return (
    <>
      <header className="mb-7 flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Devices</h2>
        {allowed && (
          <Button onClick={() => setAdding(true)}>
            <Plus size={15} />
            Add a device
          </Button>
        )}
      </header>
      <Card>
        {!devices && (
          <p role="status" className="p-4 text-sm text-muted">
            Checking your devices…
          </p>
        )}
        {devices?.length === 0 && <p className="p-5 text-sm text-muted">Add your phone or another computer to your Wisp.</p>}
        {devices?.map((device) => (
          <div key={device.id} className="flex items-center gap-3 px-4 py-4">
            <Monitor size={22} className="text-muted shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{device.name}</span>
              <span className="block text-xs text-muted mt-1">{device.paused ? "Paused" : device.online ? "Connected" : "Offline"}</span>
            </span>
            <span className="text-xs text-muted">{device.mine ? "Yours" : device.ownerName}</span>
          </div>
        ))}
      </Card>
      <div className="mt-3 flex justify-between gap-3 text-xs text-muted">
        <a href={href({ view: "settings", page: "security" })} className="hover:text-ink inline-flex items-center gap-1">
          <Smartphone size={13} />
          Phone sign-ins
        </a>
        <a href={href({ view: "nodes" })} className="hover:text-ink">
          Manage computers
        </a>
      </div>
      <section className="mt-8 border-t border-line pt-3">
        <Row
          label={
            <span className="flex items-center gap-2">
              <Globe size={18} />
              Away from home
            </span>
          }
          hint={on ? (cloudflare ? "On, with Cloudflare" : info?.tailscale.serving ? "On, with Tailscale" : "On, with your public address") : "Only at home for now"}
        >
          <Toggle label="Away from home" on={on} disabled={!allowed || busy} onChange={(value) => (value ? setSetupAway(true) : void run(turnOff))} />
        </Row>
        {setupAway && (
          <div className="px-4 py-4">
            <AwayFromHome onDone={() => setSetupAway(false)} />
          </div>
        )}
        {!info && failed && (
          <p role="status" className="px-4 text-sm text-muted">
            Away from home isn't available yet.
          </p>
        )}
        {error && (
          <p role="alert" className="px-4 mt-2 text-sm text-bad">
            {error}
          </p>
        )}
      </section>
      <McpConnections info={info} allowed={allowed} />
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export function McpConnections({ info, allowed }: { info: AccessInfo | null; allowed: boolean }) {
  const origin = connectorOrigin(info);
  const [clients, setClients] = useState<McpClient[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    setClients(null);
    if (!allowed) return;
    let alive = true;
    const load = () =>
      loadMcpClients().then(
        (list) => {
          if (alive) {
            setClients(list);
            setError(null);
          }
        },
        (e) => {
          if (alive) setError(unavailable(e, "Connected apps"));
        },
      );
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [allowed]);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      if (on) {
        const ready = await enableTailscale(true);
        if (!ready) setHint("Finish setting up Tailscale, then turn this on again.");
      } else if (info?.tailscale.funnel) await useAccessStore.getState().act("unfunnel");
      else if (info?.cloudflare?.state === "running") {
        await api("POST", "/api/reach/cloudflare", { action: "stop" });
        await useAccessStore.getState().refresh(true);
      } else throw new Error("This Wisp uses a public address; disconnect apps below to remove their access.");
    } catch (e) {
      setError(unavailable(e, "Connected apps"));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async (client: McpClient) => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/api/mcp/clients/${encodeURIComponent(client.id)}`);
      setClients((list) => list?.filter((c) => c.id !== client.id) ?? null);
    } catch (e) {
      setError(unavailable(e, "Connected apps"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-5 border-t border-line pt-3">
      <Row
        label={
          <span className="flex items-center gap-2">
            <AppWindow size={18} />
            Grok, ChatGPT and Claude
          </span>
        }
        hint="Talk to your agents from their apps."
      >
        <Toggle label="Grok, ChatGPT and Claude" on={!!origin} disabled={!allowed || busy} onChange={(value) => void toggle(value)} />
      </Row>
      <div className="px-4 pt-3 space-y-3">
        {origin && (
          <>
            <CopyBlock text={`${origin}/mcp`} />
            <p className="text-xs text-muted">In Grok: Connectors → Add custom connector → paste.</p>
          </>
        )}
        {clients !== null && (
          <div className="pt-3">
            <h3 className="text-xs font-medium text-muted mb-2">Connected apps</h3>
            {clients.length === 0 ? (
              <p className="text-sm text-muted">No apps connected yet.</p>
            ) : (
              <div className="divide-y divide-line">
                {clients.map((client) => (
                  <div key={client.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="text-sm min-w-0">
                      <span className="font-medium">{client.name}</span>
                      {client.agentName && <span className="text-muted"> acts as {client.agentName}</span>}
                    </span>
                    <Button disabled={busy} onClick={() => void disconnect(client)}>
                      Disconnect
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {hint && (
        <p role="status" className="px-4 mt-3 text-sm text-muted">
          {hint}
        </p>
      )}
      {hint && info && (
        <a href={info.tailscale.authUrl ?? info.download} target="_blank" rel="noreferrer" className="inline-block px-4 mt-3 text-sm underline">
          {info.tailscale.state === "missing" ? "Install Tailscale" : "Open Tailscale sign-in"}
        </a>
      )}
      {error && (
        <p role="alert" className="px-4 mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
