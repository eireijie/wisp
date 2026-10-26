import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { HARNESSES, harnessInfo, harnessLabel, runsInVm, type HarnessInfo } from "@wisp/core";
import { api } from "../../api.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../../devices.ts";
import { href } from "../../router.ts";
import { CopyBlock, Menu } from "../../components/ui.tsx";
import { Add, Badge, Dlg, Item, Label, Panel, Pick, Prim, Sec, Tile } from "../../components/MarketParts.tsx";
import { PageHeader } from "./parts.tsx";

/** A harness on a neutral tile with a plain line icon (never a brand mark or a letter). */
function Mark() {
  return (
    <Tile size={40}>
      <Bot size={20} strokeWidth={1.7} />
    </Tile>
  );
}

/** Ask the device to look again at what it has, then wait a moment for it to answer. */
async function checkAgain(deviceId: string) {
  await api("POST", `/api/nodes/${deviceId}/refresh`);
  await new Promise((r) => setTimeout(r, 2500));
}

/** Install a harness on a device through Wisp (npm ones), or show how to do it by hand. */
function useInstall(device: DeviceInfo | undefined) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [device?.id]);
  const install = async (h: HarnessInfo) => {
    if (!device) return;
    setBusy(h.id);
    setError(null);
    setNote(null);
    try {
      await api("POST", `/api/nodes/${device.id}/install`, { harness: h.id });
      setNote(`${h.label} is installed on ${device.name}. Sign it in before agents use it.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, note, install };
}

/** One harness on a device: whether it's installed, and the button that installs it. */
export function RuntimeRow({ h, device, version, busy, onInstall, onHowTo }: { h: HarnessInfo; device: DeviceInfo; version: string | null | undefined; busy: boolean; onInstall: () => void; onHowTo: () => void }) {
  const ready = version !== undefined;
  const npm = !!h.install?.npm;
  return (
    <Item
      icon={<Mark />}
      title={h.label}
      sub={ready ? (version ? `Version ${version}` : "Installed") : "Not on this device"}
      right={
        ready ? (
          <Badge tone="green">Installed</Badge>
        ) : npm && device.mine ? (
          <Add onClick={onInstall} disabled={busy || !device.online} title={device.online ? `npm install -g ${h.install!.npm}` : `${device.name} is offline`}>
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Installing…
              </>
            ) : (
              "Install"
            )}
          </Add>
        ) : (
          <Add onClick={onHowTo}>How to install</Add>
        )
      }
    />
  );
}

/** The sheet that installs a harness on a device (Settings → Harnesses → Install a harness). */
export function InstallHarness({ device, onClose }: { device: DeviceInfo; onClose: () => void }) {
  const devices = useDevices(3000);
  const live = devices?.find((d) => d.id === device.id) ?? device;
  const { busy, error, note, install } = useInstall(live);
  const [checking, setChecking] = useState(false);
  const [howTo, setHowTo] = useState<HarnessInfo | null>(null);
  const installed = new Map((live.harnesses ?? []).map((h) => [h.id, h.version]));
  const onDevice = HARNESSES.filter((h) => h.protocol !== "mcp");
  return (
    <Dlg title="Install a harness" sub={`On ${device.name}`} onClose={onClose}>
      <Panel>
        {onDevice.map((h) => (
          <RuntimeRow key={h.id} h={h} device={live} version={installed.get(h.id)} busy={busy === h.id} onInstall={() => install(h)} onHowTo={() => setHowTo(h)} />
        ))}
      </Panel>
      <p className="px-1 text-sm text-faint">Wisp installs it on that computer and asks you before it runs anything.</p>
      {note && <p className="rounded-2xl bg-ok/10 px-4 py-3 text-sm text-ok">{note}</p>}
      {error && <p className="whitespace-pre-wrap text-sm text-bad">{error}</p>}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 px-1 text-sm text-muted hover:text-ink disabled:opacity-50"
        disabled={checking || !live.online}
        onClick={async () => {
          setChecking(true);
          await checkAgain(live.id).catch(() => {});
          setChecking(false);
        }}
      >
        <RefreshCw size={14} className={checking ? "animate-spin" : undefined} /> Refresh
      </button>
      {howTo && <HowToInstall h={howTo} device={live} onClose={() => setHowTo(null)} />}
    </Dlg>
  );
}

/**
 * The agent tools (harnesses) each device can run, like a runtime manager: which are ready, which
 * need installing (Wisp installs npm ones itself, on its owner's say-so), and how to sign them in.
 */
export function RuntimesPage() {
  const devices = useDevices(4000);
  const usable = useMemo(() => usableDevices(devices ?? []), [devices]);
  const [pick, setPick] = useState<string>("");
  const device = usable.find((d) => d.id === pick) ?? usable.find((d) => d.online) ?? usable[0];
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const { busy, error, note, install } = useInstall(device);
  const [howTo, setHowTo] = useState<HarnessInfo | null>(null);
  const [adding, setAdding] = useState(false);

  const installed = new Map((device?.harnesses ?? []).map((h) => [h.id, h.version]));
  const declared = (device?.harnesses ?? []).filter((h) => h.id.startsWith("acp:"));
  const onDevice = HARNESSES.filter((h) => h.protocol !== "mcp");
  const anywhere = HARNESSES.filter((h) => h.protocol === "mcp");

  const check = async () => {
    if (!device) return;
    setChecking(true);
    setCheckError(null);
    try {
      await checkAgain(device.id);
    } catch (e) {
      setCheckError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <PageHeader title="Agent runtimes">The AI tools, like Claude Code or Codex, each device can run for agents.</PageHeader>
      {devices === null ? (
        <p className="text-sm text-muted">Loading devices…</p>
      ) : !device ? (
        <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
          No devices of yours yet.{" "}
          <a className="text-accent-text hover:underline" href={href({ view: "computers", computerId: null })}>
            Connect one
          </a>{" "}
          to see what it can run.
        </p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            {usable.length > 1 ? (
              <Pick label="Device" value={device.id} onChange={setPick}>
                {usable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? "" : " (offline)"}
                  </option>
                ))}
              </Pick>
            ) : (
              <span className="text-base font-medium">{device.name}</span>
            )}
            <Badge tone={device.online ? "green" : "grey"}>{device.online ? "Online" : "Offline"}</Badge>
            <span className="flex-1" />
            <Sec onClick={check} disabled={checking || !device.online}>
              <RefreshCw size={15} className={checking ? "animate-spin" : undefined} /> Check again
            </Sec>
          </div>
          {(error || checkError) && <p className="whitespace-pre-wrap text-sm text-bad">{error ?? checkError}</p>}
          {note && <p className="rounded-2xl bg-ok/10 px-4 py-3 text-sm text-ok">{note}</p>}
          <section className="space-y-2">
            <Label>On this device</Label>
            {!device.mine && <p className="px-1 text-sm text-muted">{device.ownerName ?? "Its owner"} installs harnesses here.</p>}
            <Panel>
              {onDevice.map((h) => (
                <div key={h.id} className="flex items-center">
                  <div className="min-w-0 flex-1">
                    <RuntimeRow h={h} device={device} version={installed.get(h.id)} busy={busy === h.id} onInstall={() => install(h)} onHowTo={() => setHowTo(h)} />
                  </div>
                  <Menu
                    align="right"
                    trigger={(_o, t) => (
                      <button onClick={t} className="mr-3 grid size-9 place-items-center rounded-full text-muted hover:bg-hover" aria-label={`More for ${h.label}`} title={`More for ${h.label}`}>
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                    items={[
                      ...(h.login ? [{ label: `Copy sign-in command: ${h.login}`, icon: <Copy size={14} />, onSelect: () => void navigator.clipboard?.writeText(h.login!.replace(/ \(.*\)$/, "")) }] : []),
                      { label: "How to install", onSelect: () => setHowTo(h) },
                    ]}
                  />
                </div>
              ))}
              {declared.map((d) => (
                <Item key={d.id} icon={<Mark />} title={harnessLabel(d.id)} sub={`Added on ${device.name} · ${d.version ?? "ready"}`} right={<Badge tone="green">Ready</Badge>} />
              ))}
              <Item icon={<Tile size={40}><Plus size={20} strokeWidth={1.7} /></Tile>} title="Add runtime" sub="Any agent that speaks ACP" onClick={() => setAdding(true)} />
            </Panel>
          </section>
        </div>
      )}
      <section className="mt-8 space-y-2">
        <Label>Inside your agents' VMs</Label>
        <p className="px-1 text-sm text-faint">Every VM comes with these, so an agent can run entirely inside its computer. Sign each in once per VM, on the agent's Computer tab.</p>
        <Panel>
          {HARNESSES.filter((h) => runsInVm(h.id)).map((h) => (
            <Item key={h.id} icon={<Mark />} title={h.label} sub={h.note} right={<Badge tone="green">In every VM</Badge>} />
          ))}
        </Panel>
      </section>
      <section className="mt-8 space-y-2">
        <Label>Connect from anywhere</Label>
        <p className="px-1 text-sm text-faint">Agents that run somewhere Wisp doesn't start them join through wisp-mcp: add the agent, then make a connection token on its Connect tab.</p>
        <Panel>
          {anywhere.map((h) => (
            <Item key={h.id} icon={<Mark />} title={h.label} sub={h.note} right={<Badge>Through MCP</Badge>} />
          ))}
        </Panel>
      </section>
      {howTo && <HowToInstall h={howTo} device={device} onClose={() => setHowTo(null)} />}
      {adding && <AddRuntime device={device} onClose={() => setAdding(false)} />}
    </>
  );
}

export function HowToInstall({ h, device, onClose }: { h: HarnessInfo; device: DeviceInfo | undefined; onClose: () => void }) {
  const info = harnessInfo(h.id)?.install;
  return (
    <Dlg title={`Install ${h.label}`} sub={`On ${device?.name ?? "the device"}, in a terminal`} onClose={onClose}>
      <div className="space-y-4 text-sm">
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
      </div>
      <div className="flex justify-end">
        <Prim onClick={onClose} className="max-sm:w-full">
          Done
        </Prim>
      </div>
    </Dlg>
  );
}

/** Any agent that speaks ACP can run here; it's added at the device, so the hub can never make a device run something new. */
function AddRuntime({ device, onClose }: { device: DeviceInfo | undefined; onClose: () => void }) {
  const snippet = `"harnesses": {
  "acp:my-agent": { "label": "My agent", "command": "my-agent", "args": ["acp"] }
}`;
  return (
    <Dlg title="Add a runtime" onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p>
          Any agent that speaks the Agent Client Protocol (ACP) can run in Wisp. Add it on {device?.name ?? "the device"}, in <code>~/.wisp/node.json</code>:
        </p>
        <CopyBlock text={snippet} />
        <p className="text-muted">
          Then restart <code>wisp node</code> (or press Check again). It shows up here and in Add agent. It's added at the device on purpose: nobody can make a device run a new program from Wisp.
        </p>
        <p className="text-muted">Running an agent somewhere else entirely? Add it as an agent and connect it with wisp-mcp from its Connect tab.</p>
      </div>
      <div className="flex justify-end">
        <Prim onClick={onClose} className="max-sm:w-full">
          Done
        </Prim>
      </div>
    </Dlg>
  );
}
