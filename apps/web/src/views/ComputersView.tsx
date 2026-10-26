import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronRight, ClipboardList, Cloud, Eye, FolderOpen, Hand, Info, Keyboard, Loader2, Lock, Monitor, MoreHorizontal, Play, Power, Server, Trash2, Upload, Video, X } from "lucide-react";
import { type Actor, type Agent, type PageElement } from "@wisp/core";
import { api, uploadFile } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { computerKindLabel, osName, usableDevices, useDevices, vmAvailabilityNote, type DeviceInfo } from "../devices.ts";
import { BackToComputers, ComputersHome, ComputersShell } from "./ComputersParts.tsx";
import { DevicePage } from "./DevicePage.tsx";
import { LiveScreen, ScreenThumb, WorkingBadge, type LiveScreenHandle, type ScreenInput } from "../components/Screen.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { ClipboardPanel, FilesPanel, remotePlatform, saveScreenshot, sendFiles, useClipboardSync } from "../components/ComputerSync.tsx";
import { AgentAvatar, Button, Field, Input, Menu, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";

export { computerState, useComputerState, KIND_ICON } from "./computerState.ts";
import { useComputerState, KIND_ICON } from "./computerState.ts";

export function ComputersView({ computerId, teach, deviceId }: { computerId: string | null; teach: string | null; deviceId?: string | null }) {
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const devices = useDevices();
  const selected = computers.find((c) => c.id === computerId);

  useEffect(() => {
    if (me?.role !== "guest") useStore.getState().refreshComputers();
  }, [me?.role]);

  if (me?.role === "guest") return null;

  // one device: its role, agents, screen, remote desktop, tools
  if (deviceId && !computerId) return <ComputersShell><DevicePage nodeId={deviceId} /></ComputersShell>;

  if (computerId) {
    if (!selected)
      return (
        <ComputersShell>
          <div className="flex-1 grid place-items-center text-sm text-muted">{computers.length ? "That computer is gone." : "Loading…"}</div>
        </ComputersShell>
      );
    return <ComputerDetail key={selected.id} computer={selected} devices={devices} teach={teach} />;
  }

  return <ComputersHome />;
}

// --- adding a computer ------------------------------------------------------------------------------

type Kind = "vm" | "device" | "orgo";

/** The question: what should the helper be able to do? */
export type Capability = "chat" | "vm" | "device";

/** Which kind of computer to create for an answer. "Answer questions only" creates nothing. */
export function capabilityKind(c: Capability | null): Kind | null {
  return c === "vm" || c === "device" ? c : null;
}

/** New VMs are medium unless someone opens the size choice (under More options). */
export const DEFAULT_SIZE = "medium" as const;

/** Whether the Orgo cloud option can be used yet: it needs an API key saved in Settings → Computers. */
export function orgoStatus(orgo: { configured: boolean } | null): "checking" | "needs-key" | "ready" {
  return orgo === null ? "checking" : orgo.configured ? "ready" : "needs-key";
}

/** Pick where a new computer lives. Used on the Computers page and an agent's Computer tab. */
export function AddComputer({ devices, onClose, onCreated, nodeId: preferNode, defaultName }: { devices: DeviceInfo[]; onClose: () => void; onCreated: (c: ComputerInfo) => void; nodeId?: string | null; defaultName?: string }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [capability, setCapability] = useState<Capability | null>(null);
  const usable = usableDevices(devices);
  const [nodeId, setNodeId] = useState(preferNode && usable.some((d) => d.id === preferNode) ? preferNode : (usable.find((d) => d.online)?.id ?? usable[0]?.id ?? ""));
  const [name, setName] = useState(defaultName ?? "");
  const [size, setSize] = useState<"small" | "medium" | "large">(DEFAULT_SIZE);
  const [orgo, setOrgo] = useState<{ configured: boolean } | null>(null);
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ orgo: { configured: boolean } }>("GET", "/api/settings/computers").then((s) => setOrgo(s.orgo), () => setOrgo({ configured: false }));
  }, []);
  const mineOnly = devices.filter((d) => d.mine);
  const choices = kind === "device" ? mineOnly : usable;
  const device = choices.find((d) => d.id === nodeId);
  // picking "your own screen" moves the choice to one of your devices
  useEffect(() => {
    if (kind && !choices.some((d) => d.id === nodeId)) setNodeId(choices.find((d) => d.online)?.id ?? choices[0]?.id ?? "");
  }, [kind]);
  const orgoState = orgoStatus(orgo);
  const SIZES = { small: { cpus: 1, memoryGb: 2, ram: 4, cpu: 1 }, medium: { cpus: 2, memoryGb: 4, ram: 8, cpu: 2 }, large: { cpus: 4, memoryGb: 8, ram: 16, cpu: 4 } };

  const create = async () => {
    if (kind === "orgo" && orgoState !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const s = SIZES[size];
      const body =
        kind === "device"
          ? { kind, nodeId, name: name || undefined }
          : kind === "vm"
            ? { kind, nodeId, name: name || `${device?.name ?? "VM"} desktop`, cpus: s.cpus, memoryGb: s.memoryGb }
            : { kind, name: name || "Cloud computer", ...(existing.trim() ? { computerId: existing.trim() } : { ram: s.ram, cpu: s.cpu }) };
      const c = await api<ComputerInfo>("POST", "/api/computers", body);
      await useStore.getState().refreshComputers();
      onCreated(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const card = (selected: boolean, onPick: () => void, icon: React.ReactNode, title: string, body: string, note?: string, disabled?: boolean) => (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onPick} className={cx("w-full text-left rounded-xl border p-3 flex gap-3 disabled:opacity-60 disabled:cursor-not-allowed", selected ? "border-accent bg-accent-soft" : cx("border-line", !disabled && "hover:bg-hover"))}>
      <span className="size-9 shrink-0 rounded-lg bg-chip grid place-items-center text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
        {note && <span className="block text-xs text-warn mt-0.5">{note}</span>}
      </span>
    </button>
  );
  const option = (k: Kind, icon: React.ReactNode, title: string, body: string, note?: string, disabled?: boolean) => card(kind === k, () => (setCapability(null), setKind(k)), icon, title, body, note, disabled);
  const pickCapability = (c: Capability) => {
    setCapability(c);
    setKind(capabilityKind(c));
  };
  const orgoOption = option(
    "orgo",
    <Cloud size={18} />,
    "An Orgo cloud computer",
    "A Linux desktop in the cloud from orgo.ai that keeps running when your devices are off.",
    orgoState === "checking" ? "Checking your Orgo connection…" : undefined,
    orgoState !== "ready",
  );
  const orgoNeedsKey = orgoState === "needs-key" && (
    <p className="text-xs text-warn">
      Add your Orgo API key in Settings → Computers first.{" "}
      <a href={href({ view: "settings", page: "computers" })} onClick={onClose} className="underline text-accent-text">
        Open Computers settings
      </a>
    </p>
  );

  const chatOnly = capability === "chat";
  const showSizing = kind === "orgo" || kind === "vm";
  const sizeField = (
    <Field label="Size">
      <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
        <option value="small">Small: 1 CPU, {kind === "vm" ? "2" : "4"} GB</option>
        <option value="medium">Medium: 2 CPUs, {kind === "vm" ? "4" : "8"} GB</option>
        <option value="large">Large: 4 CPUs, {kind === "vm" ? "8" : "16"} GB</option>
      </select>
    </Field>
  );

  return (
    <Modal title="Add a computer" onClose={onClose} wide>
      <div className="space-y-4">
        <div className="space-y-2">
          <p id="cap-q" className="text-sm font-medium">What should the helper be able to do?</p>
          <div role="radiogroup" aria-labelledby="cap-q" className="space-y-2">
            {card(capability === "chat", () => pickCapability("chat"), <Hand size={18} />, "Answer questions only", "No desktop needed")}
            {card(capability === "vm", () => pickCapability("vm"), <Monitor size={18} />, "Use apps in its own desktop", "A separate desktop with a web browser, a terminal and files. Your own computer stays untouched.", vmAvailabilityNote(usable))}
            {mineOnly.length > 0 && card(capability === "device", () => pickCapability("device"), <Lock size={18} />, "Use apps on my screen", "Runs on your computer and uses your real screen and apps while you watch. It only does what you ask.")}
          </div>
          <MoreOptions about="a cloud computer (Orgo)">
            <div role="radiogroup" aria-label="Cloud computer" className="space-y-2">
              {orgoOption}
              {orgoNeedsKey}
            </div>
          </MoreOptions>
        </div>

        {chatOnly && (
          <div className="rounded-xl border border-line bg-bg p-3 text-sm space-y-1">
            <p>The helper can chat, write and look things up without a desktop of its own. Nothing will be created.</p>
            <p className="text-muted">
              To set this, open your helper's page and choose Computer.{" "}
              <a href={href({ view: "agents", agentId: null })} onClick={onClose} className="underline text-accent-text">
                Open helpers
              </a>
            </p>
          </div>
        )}

        {kind && kind !== "orgo" && choices.length !== 1 && (
          <Field label="Device" hint={choices.length ? undefined : "Connect a device first under Devices."}>
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
              {choices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({osName(d.capabilities?.platform)}, {d.online ? "online" : "offline"})
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind && kind !== "orgo" && device?.capabilities && (
          <p className={cx("text-xs", (kind === "vm" ? device.capabilities.vm.ok : device.capabilities.screen.ok) ? "text-muted" : "text-bad")}>
            {kind === "device" && device.capabilities.screen.off ? (
              <>
                {device.name}'s screen is off. Only you can turn it on, at that computer: <code>wisp node screen on</code>
              </>
            ) : kind === "vm" ? (
              device.capabilities.vm.detail
            ) : (
              device.capabilities.screen.detail
            )}
          </p>
        )}
        {kind && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "device" ? (device?.name ?? "") : kind === "vm" ? "Research desk" : "Cloud desk"} />
            </Field>
          </div>
        )}
        {showSizing && !existing && (
          <MoreOptions about="size and resources">
            <div className="grid sm:grid-cols-2 gap-3">{sizeField}</div>
          </MoreOptions>
        )}
        {kind === "orgo" && (
          <Field label="Or connect a computer you already have in Orgo" hint="Its ID (a UUID) from the Orgo dashboard. Leave empty to make a new one.">
            <Input value={existing} onChange={(e) => setExisting(e.target.value)} placeholder="Optional" />
          </Field>
        )}
        {kind === "vm" && <p className="text-xs text-muted">The first VM on a device builds its image, which takes a few minutes. Its home folder keeps sign-ins and files between restarts.</p>}
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {chatOnly ? "Close" : "Cancel"}
          </Button>
          {!chatOnly && (
            <Button variant="primary" disabled={!kind || busy || (kind !== "orgo" && !nodeId) || (kind === "orgo" && orgoState !== "ready")} onClick={create}>
              {busy && <Loader2 size={15} className="animate-spin" />} Add computer
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --- one computer, live ---------------------------------------------------------------------------------

function ComputerDetail({ computer: c, devices, teach }: { computer: ComputerInfo; devices: DeviceInfo[] | null; teach: string | null }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const state = useComputerState(c);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickTeach, setPickTeach] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [panel, setPanel] = useState<"info" | "files" | "clipboard" | null>(null);
  const [dropping, setDropping] = useState(false);
  const [filesChanged, setFilesChanged] = useState(0);
  const screen = useRef<LiveScreenHandle>(null);
  const touched = useRef(0);
  const mine = c.controller?.id === me.user.id;
  const canEdit = me.role !== "guest";
  const device = devices?.find((d) => d.id === c.nodeId);
  const canRemove = c.kind === "device" ? c.ownerId === me.user.id : c.kind === "vm" ? me.role === "owner" || !!device?.mine : true;
  const on = agents.filter((a) => c.agents.includes(a.id));
  const teacher = teach ? agents.find((a) => a.id === teach) : undefined;
  const Icon = KIND_ICON[c.kind];

  const control = async (take: boolean, note?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/control`, { take, note });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // leaving the desk gives the computer back, so agents aren't stuck waiting on a closed view
  useEffect(() => () => {
    const current = useStore.getState().computers.find((computer) => computer.id === c.id);
    if (current?.controller?.id === me.user.id) void api("POST", `/api/computers/${c.id}/control`, { take: false }).catch(() => {});
  }, [c.id, me.user.id]);

  // teaching needs control
  useEffect(() => {
    if (teacher && c.online && !c.controller) control(true);
  }, [teacher?.id, c.online]);

  const canControl = canEdit && c.online && !c.paused;
  // moving files and clipboard text doesn't need control, only a computer that's there
  const canTransfer = canEdit && c.online && !c.paused;
  const platform = remotePlatform(c, devices);
  const sync = useClipboardSync(c, mine && !teacher, platform);
  const toggle = (p: NonNullable<typeof panel>) => setPanel((cur) => (cur === p ? null : p));
  const dropOnScreen = async (files: File[]) => {
    sync.flash(files.length === 1 ? `Sending ${files[0].name}…` : `Sending ${files.length} files…`);
    try {
      await sendFiles(c.id, "~/Desktop", files);
      sync.flash(files.length === 1 ? `Sent ${files[0].name} to the Desktop` : `Sent ${files.length} files to the Desktop`);
      setFilesChanged((n) => n + 1);
    } catch (e) {
      sync.flash((e as Error).message);
    }
  };
  const lead = on[0];
  const chip = "inline-flex items-center gap-2 h-[42px] px-4 rounded-full bg-control border border-[var(--control-line)] text-sm font-medium hover:bg-hover disabled:opacity-40";
  const [keys, setKeys] = useState(false);
  const [typed, setTyped] = useState("");
  const [handing, setHanding] = useState(false);
  const act = (action: object) => api("POST", `/api/computers/${c.id}/act`, { action }).catch((e) => setError((e as Error).message));
  const members = useStore((s) => s.members);

  return (
    <ComputersShell>
      <div className="flex-1 min-h-0 flex flex-col safe-top safe-bottom">
        <header className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 md:px-6 pt-5 pb-3">
          <BackToComputers />
          {lead ? <AgentAvatar agent={lead} size={28} live /> : <Icon size={20} className="text-muted shrink-0" />}
          <h1 className="t-title truncate min-w-0 flex-1">{c.name}</h1>
          {mine && !teacher ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-info text-white px-3.5 h-9 text-sm font-medium" role="status">
              <Hand size={15} /> You are in control
            </span>
          ) : state.working ? (
            <WorkingBadge />
          ) : (
            <Pill tone={state.tone}>{state.label}</Pill>
          )}
          {canEdit && (
            <Menu
              align="right"
              trigger={(_o, t) => (
                <button onClick={t} className="circle" aria-label="More">
                  <MoreHorizontal size={18} />
                </button>
              )}
              items={[
                { label: "Rename", onSelect: () => setRenaming(true) },
                ...(c.online && !c.paused ? [{ label: "Save a screenshot", icon: <Camera size={14} />, onSelect: () => void saveScreenshot(c).catch((e) => setError(e.message)) }] : []),
                ...(c.kind !== "device" ? [{ label: c.status === "stopped" ? "Start this computer" : "Stop this computer", icon: c.status === "stopped" ? <Play size={14} /> : <Power size={14} />, onSelect: () => api("POST", `/api/computers/${c.id}/${c.status === "stopped" ? "start" : "stop"}`).catch((e) => setError(e.message)) }] : []),
                ...(canRemove ? ["divider" as const] : []),
                ...(canRemove ? [{
                  label: c.kind === "device" ? "Stop sharing this screen" : "Remove",
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onSelect: async () => {
                    const what = c.kind === "vm" ? "Its VM and everything on it are deleted." : c.kind === "orgo" ? "The Orgo computer is deleted too." : "Agents won't be able to use this device's screen.";
                    if (!confirm(`Remove ${c.name}? ${what}`)) return;
                    await api("DELETE", `/api/computers/${c.id}`);
                    go({ view: "computers", computerId: null });
                  },
                }] : []),
              ]}
            />
          )}
        </header>

        {teacher && <TeachBar agent={teacher} computer={c} screen={screen} />}

        {!teacher && c.help && (
          <div className="shrink-0 mx-4 md:mx-6 mb-3 rounded-2xl border border-accent/40 bg-accent-soft px-4 py-3 flex flex-wrap items-center gap-3" role="status">
            {agents.find((a) => a.id === c.help!.agentId) && <AgentAvatar agent={agents.find((a) => a.id === c.help!.agentId)} size={28} badge={false} />}
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{agents.find((a) => a.id === c.help!.agentId)?.name ?? "An agent"} needs you on this computer: </span>
              {c.help.request}
              <span className="text-muted"> · {timeAgo(c.help.at)}</span>
            </div>
            {canEdit && !mine && (
              <Button variant="primary" onClick={() => control(true)} disabled={busy}>
                <Hand size={15} /> Take over
              </Button>
            )}
            {mine && <span className="text-xs text-muted">When you're done, press Hand back and @{agents.find((a) => a.id === c.help!.agentId)?.handle} picks up from there.</span>}
          </div>
        )}
        {error && <p className="shrink-0 mx-4 md:mx-6 mb-2 text-sm text-bad">{error}</p>}
        {c.status === "error" && c.statusText && <p className="shrink-0 mx-4 md:mx-6 mb-2 text-sm text-bad">{c.statusText}</p>}

        <div className="flex-1 min-h-0 flex gap-5 px-4 md:px-6 pb-4 overflow-y-auto lg:overflow-hidden">
          <div className="flex-1 min-w-0 flex flex-col gap-3.5">
            <div
              className="relative flex-1 min-h-[280px] rounded-3xl overflow-hidden bg-black border border-line"
              onKeyDownCapture={sync.onKeyDownCapture}
              onDragOver={(e) => {
                if (!canTransfer || !e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDropping(true);
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropping(false)}
              onDrop={(e) => {
                setDropping(false);
                if (!canTransfer || !e.dataTransfer.files.length) return;
                e.preventDefault();
                void dropOnScreen([...e.dataTransfer.files]);
              }}
            >
              {dropping && (
                <div className="absolute inset-0 z-10 rounded-3xl border-2 border-dashed border-info bg-info/15 grid place-items-center pointer-events-none">
                  <span className="inline-flex items-center gap-2 rounded-full bg-black/70 text-white px-4 h-10 text-sm font-medium">
                    <Upload size={16} /> Drop to send to {c.name}'s Desktop
                  </span>
                </div>
              )}
              {sync.note && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 max-w-[90%] truncate rounded-full bg-black/75 text-white px-4 h-9 leading-9 text-sm shadow-panel pointer-events-none" role="status">
                  {sync.note}
                </div>
              )}
              <LiveScreen
                ref={screen}
                computer={c}
                control={mine}
                onInput={teacher ? (i) => screen.current && teachSink.current?.(i) : undefined}
                onTakeControl={canControl && !c.controller && !teacher ? () => void control(true) : undefined}
                onActivity={() => {
                  // VNC input skips the hub, so say now and then that you're still using it
                  if (Date.now() - touched.current < 15_000) return;
                  touched.current = Date.now();
                  void api("POST", `/api/computers/${c.id}/control`, { take: true }).catch(() => {});
                }}
              />
            </div>

            <div className="shrink-0 flex items-center gap-2.5 text-sm text-muted min-h-6" role="status">
              {teacher ? (
                `${teacher.name} is watching. Do the task, then press Done.`
              ) : state.working ? (
                <>
                  <span className="flex gap-1" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <i key={i} className="size-1.5 rounded-full bg-muted motion-safe:animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
                    ))}
                  </span>
                  {lead?.name ?? "An agent"} is working · {c.activity?.text ?? "Working"}
                </>
              ) : c.help ? (
                <span>
                  <span className="font-medium text-ink">{agents.find((a) => a.id === c.help!.agentId)?.name ?? "An agent"} needs you.</span>
                  {mine ? " Hand back when you're done." : " Take over to help."}
                </span>
              ) : mine ? (
                `You are in control.${lead ? ` ${lead.name} is paused.` : ""} Agents get it back when you hand it back or stop using it.`
              ) : c.controller ? (
                state.label
              ) : canControl ? (
                <span className="inline-flex items-center gap-1.5">
                  <Eye size={14} /> Watching · click the screen to take control
                </span>
              ) : null}
            </div>

            {!teacher && (
              <div className="shrink-0 flex flex-wrap gap-2.5">
                {mine ? (
                  <button disabled={busy} onClick={() => setHanding(true)} className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-ink text-panel text-sm font-medium disabled:opacity-50">
                    <Hand size={16} /> Hand back{lead ? ` to ${lead.name}` : ""}
                  </button>
                ) : (
                  canControl && (
                    <button disabled={busy || !!c.controller} onClick={() => void control(true)} className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-ink text-panel text-sm font-medium disabled:opacity-50">
                      <Hand size={16} /> Take control
                    </button>
                  )
                )}
                {mine && (
                  <button onClick={() => setKeys((k) => !k)} className={cx(chip, keys && "bg-hover")} aria-expanded={keys}>
                    <Keyboard size={16} /> Keys
                  </button>
                )}
                {canTransfer && (
                  <>
                    <button onClick={() => toggle("clipboard")} className={cx(chip, panel === "clipboard" && "bg-hover")} title="Clipboard: copy and paste between it and this device">
                      <ClipboardList size={16} /> Clipboard
                    </button>
                    <button onClick={() => toggle("files")} className={cx(chip, panel === "files" && "bg-hover")} title="Files: download from it, upload to it">
                      <FolderOpen size={16} /> Files
                    </button>
                  </>
                )}
                {c.online && !c.paused && (
                  <button onClick={() => void saveScreenshot(c).catch((e) => setError(e.message))} className={chip}>
                    <Camera size={16} /> Screenshot
                  </button>
                )}
                {canControl && (
                  <button onClick={() => setPickTeach(true)} className={chip} title="Do a task once while an agent watches; it saves it as a routine">
                    <Video size={16} /> Teach a task
                  </button>
                )}
                <button onClick={() => toggle("info")} className={cx(chip, "lg:hidden", panel === "info" && "bg-hover")} title="Details">
                  <Info size={16} /> Details
                </button>
              </div>
            )}
            {mine && keys && !teacher && (
              <form
                className="shrink-0 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!typed) return;
                  void act({ action: "type", text: typed });
                  setTyped("");
                }}
              >
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type on computer" aria-label="Type on computer" className="flex-1 min-w-40" />
                <Button type="submit" disabled={!typed}>
                  Send
                </Button>
                {[["Return", "Enter"], ["Tab", "Tab"], ["Escape", "Escape"], ["Delete", "Backspace"]].map(([label, key]) => (
                  <Button key={label} type="button" onClick={() => void act({ action: "key", keys: key })}>
                    {label}
                  </Button>
                ))}
              </form>
            )}
          </div>

          {panel && panel !== "info" && (
            <aside className="fixed inset-x-0 bottom-0 top-auto max-h-[70vh] z-40 lg:static lg:max-h-none lg:w-80 shrink-0 overflow-y-auto text-sm bg-panel text-ink border border-line rounded-t-[16px] lg:rounded-3xl p-4 shadow-panel">
              {panel === "files" ? <FilesPanel computer={c} onClose={() => setPanel(null)} refresh={filesChanged} onSent={sync.flash} /> : <ClipboardPanel computer={c} mine={mine} platform={platform} onClose={() => setPanel(null)} />}
            </aside>
          )}
          {(panel === "info" || !panel) && (
            <aside className={cx("shrink-0 overflow-y-auto space-y-4 text-sm text-ink lg:w-[340px] lg:border-l lg:border-line lg:pl-5", panel === "info" ? "fixed inset-x-0 bottom-0 top-auto max-h-[70vh] z-40 lg:static lg:max-h-none bg-panel border border-line rounded-t-[16px] lg:rounded-none lg:border-y-0 lg:border-r-0 p-4 shadow-panel lg:shadow-none" : "hidden lg:block")}>
              <div className="flex items-center lg:hidden">
                <h3 className="font-semibold">Details</h3>
                <button onClick={() => setPanel(null)} className="ml-auto p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close details">
                  <X size={16} />
                </button>
              </div>
              <h3 className="hidden lg:block font-semibold text-sm text-faint">Details</h3>
              <section className="rounded-2xl bg-card divide-y divide-line">
                {[
                  ["Kind", c.kind === "vm" ? "Virtual computer" : c.kind === "orgo" ? "Cloud computer" : "Your own screen"],
                  ["Status", state.label],
                  ["In control", c.controller ? (c.controller.id === me.user.id ? "You" : (members.find((m) => m.id === c.controller!.id)?.name ?? "Someone")) : "No one"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center gap-3 px-4 min-h-[52px]">
                    <span className="flex-1">{k}</span>
                    <span className="text-muted">{v}</span>
                  </div>
                ))}
                {c.nodeId && (
                  <a href={href({ view: "computers", computerId: null, deviceId: c.nodeId })} className="flex items-center gap-3 px-4 min-h-[52px] hover:bg-hover rounded-b-2xl">
                    <span className="flex-1">Lives on</span>
                    <span className="text-muted">{device?.name ?? "A device"}</span>
                    <ChevronRight size={15} className="text-faint" />
                  </a>
                )}
              </section>
              {c.kind === "device" && <OwnScreen computer={c} />}
              <section className="space-y-2">
                <h3 className="font-semibold text-sm text-faint">Agents on this computer</h3>
                {on.length ? (
                  on.map((a) => (
                    <a key={a.id} href={href({ view: "agents", agentId: a.id, tab: "computer" })} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-hover">
                      <AgentAvatar agent={a} size={26} live />
                      <span className="min-w-0 flex-1 truncate">
                        {a.name} <span className="text-muted">@{a.handle}</span>
                      </span>
                      {a.status === "busy" && <Loader2 size={13} className="animate-spin text-muted" />}
                    </a>
                  ))
                ) : (
                  <p className="text-xs text-muted">None yet. Give an agent this computer on its page (Agents → Computer). Agents that share a computer share its files, browser and sign-ins.</p>
                )}
              </section>
              <ActivityLog computer={c} />
            </aside>
          )}
        </div>

        {pickTeach && (
          <Modal title="Who should learn it?" onClose={() => setPickTeach(false)}>
            <div className="space-y-3 text-sm">
              <p className="text-muted">Show an agent how to do something once on this computer. It saves the steps as a routine and can do it on its own next time, on a schedule if you like.</p>
              <div className="space-y-1">
                {(on.length ? on : agents).map((a) => (
                  <button key={a.id} onClick={() => (setPickTeach(false), go({ view: "computers", computerId: c.id, teach: a.id }))} className="w-full flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-hover text-left">
                    <AgentAvatar agent={a} size={28} badge={false} />
                    <span className="flex-1">
                      {a.name} <span className="text-muted">{on.includes(a) ? `on ${c.name}` : `@${a.handle}`}</span>
                    </span>
                    <ChevronRight size={14} className="text-faint" />
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}
        {handing && (
          <HandBack
            agentName={lead?.name}
            busy={busy}
            onClose={() => setHanding(false)}
            onHand={async (note) => {
              await control(false, note);
              setHanding(false);
            }}
          />
        )}
        {renaming && <RenameComputer computer={c} onClose={() => setRenaming(false)} />}
      </div>
    </ComputersShell>
  );
}

/** "Hand back to Ghosty": say what you changed so it doesn't redo or undo it. */
function HandBack({ agentName, busy, onClose, onHand }: { agentName?: string; busy: boolean; onClose: () => void; onHand: (note?: string) => void | Promise<void> }) {
  const [note, setNote] = useState("");
  return (
    <Modal title={`Hand back${agentName ? ` to ${agentName}` : ""}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onHand(note.trim() || undefined);
        }}
      >
        <p className="text-sm text-muted">{agentName ?? "The agent"} picks up where you left off. Tell it what you changed so it does not redo or undo it.</p>
        <Field label="What you did (optional)">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Signed in to the dashboard" autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep control
          </Button>
          <Button variant="primary" disabled={busy}>
            Hand back
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Your own screen: only you, and agents that run on its device, for things you ask them. */
function OwnScreen({ computer: c }: { computer: ComputerInfo }) {
  const agents = useStore((s) => s.agents);
  const here = agents.filter((a) => a.computerId === c.id && a.nodeId === c.nodeId);
  return (
    <section className="rounded-xl border border-line p-3 space-y-1">
      <h3 className="font-semibold text-sm flex items-center gap-1.5">
        <Lock size={13} /> Your own screen
      </h3>
      <p className="text-xs text-muted">Only you can see it. {here.length ? `${here.map((a) => a.name).join(", ")} ${here.length === 1 ? "runs" : "run"} on this device and can use it for things you ask.` : "Only agents that run on this device can use it."}</p>
    </section>
  );
}

/** Who did what on this computer, newest first. */
function ActivityLog({ computer: c }: { computer: ComputerInfo }) {
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  const [log, setLog] = useState<{ actor: Actor; text: string; at: string }[] | null>(null);
  const activityAt = c.activity?.at;
  useEffect(() => {
    api<{ actor: Actor; text: string; at: string }[]>("GET", `/api/computers/${c.id}/log`).then(setLog, () => setLog([]));
  }, [c.id, activityAt, c.controller?.id]);
  const who = (a: Actor) => (a.kind === "agent" ? (agents.find((x) => x.id === a.id)?.name ?? "An agent") : (members.find((m) => m.id === a.id)?.name ?? "Someone"));
  if (!log?.length) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="font-semibold text-sm">Activity</h3>
      <ol className="space-y-1 text-xs max-h-64 overflow-y-auto">
        {log.slice(0, 50).map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-faint shrink-0 tabular-nums w-14">{timeAgo(l.at)}</span>
            <span className="min-w-0">
              {l.actor.id === "system" ? (
                // things that happened on their own (wrong codes) read as a sentence
                <span className="text-muted">{l.text}</span>
              ) : (
                <>
                  <span className="font-medium">{who(l.actor)}</span> <span className="text-muted">{l.text.charAt(0).toLowerCase() + l.text.slice(1)}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The teach bar writes steps here; module-level so LiveScreen's callback stays stable. */
const teachSink: { current: ((i: ScreenInput) => void) | null } = { current: null };

interface Step extends ScreenInput {
  at: number;
  snapshot?: string;
}

const MAX_SNAPSHOTS = 40;

/** "Nova is watching and learning ● 0:04": records what you do, then hands it to the agent. */
function TeachBar({ agent, computer, screen }: { agent: Agent; computer: ComputerInfo; screen: React.RefObject<LiveScreenHandle | null> }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const [steps, setSteps] = useState<Step[]>([]);
  const [narration, setNarration] = useState("");
  const [saving, setSaving] = useState<null | "naming" | "uploading">(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const shots = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    teachSink.current = (i) => {
      const wantShot = ["click", "double_click", "right_click", "drag"].includes(i.kind) || (i.kind === "key" && i.keys === "Enter");
      const snapshot = wantShot && shots.current < MAX_SNAPSHOTS ? (screen.current?.snapshot() ?? undefined) : undefined;
      if (snapshot) shots.current++;
      const at = Date.now() - start;
      setSteps((s) => [...s, { ...i, at, snapshot }]);
      // on a VM, also note which page element it was, so the routine survives layout changes
      if (computer.kind === "vm" && i.x !== undefined && i.y !== undefined && ["click", "double_click", "right_click"].includes(i.kind)) {
        api<{ element: PageElement | null }>("POST", `/api/computers/${computer.id}/act`, { action: { action: "inspect", x: i.x, y: i.y } }).then(
          (r) => r.element && setSteps((s) => s.map((x) => (x.at === at ? { ...x, element: r.element! } : x))),
          () => {},
        );
      }
    };
    return () => {
      teachSink.current = null;
    };
  }, [start, screen, computer.id, computer.kind]);

  const elapsed = Math.floor((now - start) / 1000);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  const finish = async () => {
    setSaving("uploading");
    setError(null);
    try {
      const out = [];
      for (const s of steps) {
        let imageFileId: string | undefined;
        if (s.snapshot) {
          const blob = await (await fetch(s.snapshot)).blob();
          imageFileId = (await uploadFile(new File([blob], `step-${out.length + 1}.jpg`, { type: "image/jpeg" }))).id;
        }
        const { snapshot: _s, ...rest } = s;
        out.push({ ...rest, imageFileId });
      }
      const r = await api<{ id: string }>("POST", "/api/routines/teach", { agentId: agent.id, name: name.trim(), computerId: computer.id, steps: out, durationMs: Date.now() - start, narration: narration.trim() || undefined });
      await api("POST", `/api/computers/${computer.id}/control`, { take: false }).catch(() => {});
      void r;
      go({ view: "agents", agentId: agent.id, tab: "routines" });
    } catch (e) {
      setError((e as Error).message);
      setSaving("naming");
    }
  };

  return (
    <div className="shrink-0 mx-3 md:mx-5 mb-3 rounded-xl border border-line bg-bg px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AgentAvatar agent={agent} size={28} badge={false} live />
        <div className="min-w-48 flex-1">
          <div className="text-sm">
            <span className="font-medium">{agent.name}</span> is watching and learning
          </div>
          <div className="text-xs text-muted">Do the task once, as you normally would. {steps.length} step{steps.length === 1 ? "" : "s"} so far.</div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm tabular-nums">
          <span className="size-2 rounded-full bg-bad animate-pulse" /> {clock}
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            api("POST", `/api/computers/${computer.id}/control`, { take: false }).catch(() => {});
            go({ view: "computers", computerId: computer.id });
          }}
        >
          <X size={15} /> Cancel
        </Button>
        <Button variant="primary" disabled={!steps.length} onClick={() => setSaving("naming")}>
          Done
        </Button>
      </div>
      <Input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Explain anything as you go (optional): what changes each time, where things are…" />
      {saving && (
        <Modal title="Save what you showed" onClose={() => saving !== "uploading" && setSaving(null)}>
          <div className="space-y-3">
            <Field label="What's the task called?" hint={`${agent.name} studies your ${steps.length} steps and writes them up as a routine you can run anytime or on a schedule.`}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly reporting" autoFocus />
            </Field>
            <Field label="Anything else it should know? (optional)">
              <Textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Which parts change each time, where to find inputs, what done looks like…" />
            </Field>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={saving === "uploading"} onClick={() => setSaving(null)}>
                Keep recording
              </Button>
              <Button variant="primary" disabled={!name.trim() || saving === "uploading"} onClick={finish}>
                {saving === "uploading" && <Loader2 size={15} className="animate-spin" />} Teach {agent.name}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RenameComputer({ computer, onClose }: { computer: ComputerInfo; onClose: () => void }) {
  const [name, setName] = useState(computer.name);
  return (
    <Modal title="Rename computer" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          await api("PATCH", `/api/computers/${computer.id}`, { name });
          onClose();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end">
          <Button variant="primary">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/** A small live card for an agent's computer (chat, agent pages). */
export function ComputerMini({ computer, request, showOpen = true, quiet }: { computer: ComputerInfo; request?: string; showOpen?: boolean; quiet?: boolean }) {
  const state = useComputerState(computer);
  return (
    <a href={href({ view: "computers", computerId: computer.id })} className="block max-w-md rounded-2xl border border-line bg-panel p-3 hover:shadow-panel transition-shadow">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-sm flex items-center gap-1.5">
          <Server size={13} className="text-muted" /> Computer
        </span>
        <span className="ml-auto">{state.working ? <WorkingBadge /> : <Pill tone={state.tone}>{state.label}</Pill>}</span>
      </div>
      {request && !quiet && <p className="text-sm mb-2">{request}</p>}
      <ScreenThumb computer={computer} refreshMs={3000} />
      {showOpen && <div className="mt-2 text-xs text-accent-text font-medium">{request && !computer.help ? "Handled ✓" : request ? "Open and take control →" : `Watch ${computer.name} →`}</div>}
    </a>
  );
}
