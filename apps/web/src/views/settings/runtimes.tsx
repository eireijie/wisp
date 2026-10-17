import { useEffect, useMemo, useState } from "react";
import { BookOpen, Copy, Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { HARNESSES, harnessInfo, harnessLabel, runsInVm, type HarnessInfo } from "@warren/core";
import { api } from "../../api.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../../devices.ts";
import { href } from "../../router.ts";
import { Button, CopyBlock, Menu, Modal, Pill, cx } from "../../components/ui.tsx";
import { Card, PageHeader, Section, Select } from "./parts.tsx";
import { HarnessLogo, hasHarnessLogo } from "../../components/HarnessLogo.tsx";

/** A harness's brand mark on a tile, or its monogram when Warren has no logo for it. */
function Mark({ id, label }: { id: string; label: string }) {
  if (hasHarnessLogo(id))
    return (
      <span className="size-9 shrink-0 rounded-lg bg-chip border border-line grid place-items-center text-ink">
        <HarnessLogo harness={id} size={20} />
      </span>
    );
  const letters = label.replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean);
  return <span className="size-9 shrink-0 rounded-lg bg-chip border border-line grid place-items-center text-[13px] font-semibold text-muted">{(letters.length > 1 ? letters[0][0] + letters[1][0] : (letters[0] ?? "?").slice(0, 2)).toUpperCase()}</span>;
}

/**
 * The agent tools (harnesses) each device can run, like a runtime manager: which are ready, which
 * need installing (Warren installs npm ones itself, on its owner's say-so), and how to sign them in.
 */
export function RuntimesPage() {
  const devices = useDevices(4000);
  const usable = useMemo(() => usableDevices(devices ?? []), [devices]);
  const [pick, setPick] = useState<string>("");
  const device = usable.find((d) => d.id === pick) ?? usable.find((d) => d.online) ?? usable[0];
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [howTo, setHowTo] = useState<HarnessInfo | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => setNote(null), [device?.id]);

  const installed = new Map((device?.harnesses ?? []).map((h) => [h.id, h.version]));
  const declared = (device?.harnesses ?? []).filter((h) => h.id.startsWith("acp:"));
  const onDevice = HARNESSES.filter((h) => h.protocol !== "mcp");
  const anywhere = HARNESSES.filter((h) => h.protocol === "mcp");

  const checkAgain = async () => {
    if (!device) return;
    setChecking(true);
    setError(null);
    try {
      await api("POST", `/api/nodes/${device.id}/refresh`);
      await new Promise((r) => setTimeout(r, 2500));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const install = async (h: HarnessInfo) => {
    if (!device) return;
    setBusy(h.id);
    setError(null);
    setNote(null);
    try {
      await api("POST", `/api/nodes/${device.id}/install`, { harness: h.id });
      setNote(`${h.label} is installed on ${device.name}. Sign it in there before agents use it: ${h.login ?? h.binary}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Agent runtimes">The AI tools (like Claude Code or Codex) each of your devices can run for agents. Most people set this up once. Agents on a virtual computer get Claude Code, Codex, Hermes and Kimi CLI built in.</PageHeader>
      {devices === null ? (
        <p className="text-sm text-muted">Loading devices…</p>
      ) : !device ? (
        <p className="text-sm text-muted rounded-xl border border-dashed border-line p-4">
          No devices of yours yet.{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "nodes" })}>
            Connect one
          </a>{" "}
          to see what it can run.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {usable.length > 1 ? (
              <Select label="Device" value={device.id} onChange={setPick}>
                {usable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? "" : " (offline)"}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="text-sm font-medium">{device.name}</span>
            )}
            <Pill tone={device.online ? "ok" : "neutral"}>{device.online ? "Online" : "Offline"}</Pill>
            <span className="flex-1" />
            <Button onClick={checkAgain} disabled={checking || !device.online}>
              <RefreshCw size={14} className={cx(checking && "animate-spin")} /> Check again
            </Button>
          </div>
          {error && <p className="mb-3 text-sm text-bad whitespace-pre-wrap">{error}</p>}
          {note && <p className="mb-3 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
          <Section title="On this device" description={device.mine ? undefined : `${device.ownerName ?? "Its owner"} installs harnesses here.`}>
            <Card>
              {onDevice.map((h) => (
                <RuntimeRow key={h.id} h={h} device={device} version={installed.get(h.id)} busy={busy === h.id} onInstall={() => install(h)} onHowTo={() => setHowTo(h)} />
              ))}
              {declared.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                  <Mark id={d.id} label={d.id.slice(4)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{harnessLabel(d.id)}</div>
                    <div className="text-xs text-muted">Added on {device.name} · {d.version ?? "ready"}</div>
                  </div>
                  <Pill tone="ok">Ready</Pill>
                </div>
              ))}
              <div className="px-4 py-3">
                <Button variant="ghost" onClick={() => setAdding(true)}>
                  <Plus size={15} /> Add runtime
                </Button>
              </div>
            </Card>
          </Section>
        </>
      )}
      <Section title="Inside your agents' VMs" description="Every VM comes with these, so an agent can run entirely inside its computer. Sign each in once per VM, on the agent's Computer tab.">
        <Card>
          {HARNESSES.filter((h) => runsInVm(h.id)).map((h) => (
            <div key={h.id} className="px-4 py-3 flex items-center gap-3">
              <Mark id={h.id} label={h.label} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{h.label}</div>
                <div className="text-xs text-muted">{h.note}</div>
              </div>
              <Pill tone="ok">In every VM</Pill>
            </div>
          ))}
        </Card>
      </Section>
      <Section title="Connect from anywhere" description="Agents that run somewhere Warren doesn't start them join through warren-mcp: add the agent, then make a connection token on its Connect tab.">
        <Card>
          {anywhere.map((h) => (
            <div key={h.id} className="px-4 py-3 flex items-center gap-3">
              <Mark id={h.id} label={h.label} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{h.label}</div>
                <div className="text-xs text-muted">{h.note}</div>
              </div>
              <Pill>Through MCP</Pill>
            </div>
          ))}
        </Card>
      </Section>
      {howTo && <HowToInstall h={howTo} device={device} onClose={() => setHowTo(null)} />}
      {adding && <AddRuntime device={device} onClose={() => setAdding(false)} />}
    </>
  );
}

function RuntimeRow({ h, device, version, busy, onInstall, onHowTo }: { h: HarnessInfo; device: DeviceInfo; version: string | null | undefined; busy: boolean; onInstall: () => void; onHowTo: () => void }) {
  const ready = version !== undefined;
  const npm = !!h.install?.npm;
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <Mark id={h.id} label={h.label} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium flex flex-wrap items-center gap-x-2 gap-y-1">
          {h.label}
          {!ready && <span className="rounded-md bg-chip px-1.5 py-0.5 text-[11px] font-medium text-muted">CLI needed</span>}
        </div>
        <div className="text-xs text-muted truncate">{ready ? (version ?? "Installed") : h.note}</div>
      </div>
      {ready ? (
        <Pill tone="ok">Ready</Pill>
      ) : npm && device.mine ? (
        <Button onClick={onInstall} disabled={busy || !device.online} title={device.online ? `npm install -g ${h.install!.npm}` : `${device.name} is offline`}>
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Installing…
            </>
          ) : (
            "Install"
          )}
        </Button>
      ) : (
        <Button variant="ghost" onClick={onHowTo}>
          How to install
        </Button>
      )}
      <Menu
        align="right"
        trigger={(_o, t) => (
          <button onClick={t} className="p-1.5 rounded-md hover:bg-hover text-muted" aria-label={`More for ${h.label}`} title={`More for ${h.label}`}>
            <MoreHorizontal size={16} />
          </button>
        )}
        items={[
          ...(h.login ? [{ label: `Copy sign-in command: ${h.login}`, icon: <Copy size={14} />, onSelect: () => void navigator.clipboard?.writeText(h.login!.replace(/ \(.*\)$/, "")) }] : []),
          { label: "How to install", icon: <BookOpen size={14} />, onSelect: onHowTo },
        ]}
      />
    </div>
  );
}

function HowToInstall({ h, device, onClose }: { h: HarnessInfo; device: DeviceInfo | undefined; onClose: () => void }) {
  const info = harnessInfo(h.id)?.install;
  return (
    <Modal title={`Install ${h.label}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">On {device?.name ?? "the device"}, in a terminal:</p>
        {info?.npm && <CopyBlock text={`npm install -g ${info.npm}`} />}
        {!info?.npm && info?.command && <CopyBlock text={info.command} />}
        {info?.docs && (
          <p>
            <a className="text-accent-text hover:underline" href={info.docs} target="_blank" rel="noreferrer">
              {h.label}'s install guide
            </a>
          </p>
        )}
        {h.login && (
          <>
            <p className="text-muted">Then sign it in once:</p>
            <CopyBlock text={h.login.replace(/ \(.*\)$/, "")} />
          </>
        )}
        <p className="text-muted">Press Check again when it's done.</p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Any agent that speaks ACP can run here; it's added at the device, so the hub can never make a device run something new. */
function AddRuntime({ device, onClose }: { device: DeviceInfo | undefined; onClose: () => void }) {
  const snippet = `"harnesses": {
  "acp:my-agent": { "label": "My agent", "command": "my-agent", "args": ["acp"] }
}`;
  return (
    <Modal title="Add a runtime" onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p>Any agent that speaks the Agent Client Protocol (ACP) can run in Warren. Add it on {device?.name ?? "the device"}, in <code>~/.warren/node.json</code>:</p>
        <CopyBlock text={snippet} />
        <p className="text-muted">Then restart <code>warren node</code> (or press Check again). It shows up here and in Add agent. It's added at the device on purpose: nobody can make a device run a new program from Warren.</p>
        <p className="text-muted">
          Running an agent somewhere else entirely? Add it as an agent and connect it with warren-mcp from its Connect tab.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
