import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, ChevronLeft, ChevronRight, ClipboardList, Cloud, Eye, FolderOpen, Hand, Info, Keyboard, Laptop, Loader2, Lock, Monitor, MoreHorizontal, Play, Power, Server, Trash2, Upload, Video, X } from "lucide-react";
import { type Actor, type Agent, type PageElement } from "@wisp/core";
import { api, uploadFile } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { isTopOverlay, toBody, useOverlay } from "../overlays.ts";
import { computerKindLabel, osName, usableDevices, useDevices, vmAvailabilityNote, type DeviceInfo } from "../devices.ts";
import { ComputersHome, ComputersShell } from "./ComputersParts.tsx";
import { DevicePage } from "./DevicePage.tsx";
import { LiveScreen, ScreenThumb, WorkingBadge, type LiveScreenHandle, type ScreenInput } from "../components/Screen.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { ClipboardPanel, FilesPanel, remotePlatform, saveScreenshot, sendFiles, useClipboardSync } from "../components/ComputerSync.tsx";
import { AgentAvatar, Button, Field, Input, Menu, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";

export { computerState, useComputerState, KIND_ICON, stateColor, activityDot } from "./computerState.ts";
import { useComputerState, KIND_ICON, stateColor, activityDot } from "./computerState.ts";
import { PulseDots } from "../components/ChatList.tsx";

export function ComputersView({ computerId, teach, deviceId }: { computerId: string | null; teach: string | null; deviceId?: string | null }) {
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const devices = useDevices();
  const selected = computers.find((c) => c.id === computerId);

  const [computersChecked, setComputersChecked] = useState(false);
  useEffect(() => {
    if (me?.role !== "guest") void Promise.resolve(useStore.getState().refreshComputers()).finally(() => setComputersChecked(true));
  }, [me?.role]);

  if (me?.role === "guest") return null;

  // one device: its role, agents, screen, remote desktop, tools
  if (deviceId && !computerId) return <ComputersShell><DevicePage nodeId={deviceId} /></ComputersShell>;

  if (computerId) {
    if (!selected)
      return (
        <ComputersShell>
          <div className="flex-1 grid place-items-center text-sm text-muted text-center px-4">{computersChecked ? <p>That computer is gone. <a className="text-accent-text hover:underline" href={href({ view: "computers", computerId: null })}>See your computers</a></p> : "Loading…"}</div>
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
  const [details, setDetails] = useState(false);
  const [panel, setPanel] = useState<"files" | "clipboard" | null>(null);
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
  const [keys, setKeys] = useState(false);
  const [typed, setTyped] = useState("");
  const [handing, setHanding] = useState(false);
  const act = (action: object) => api("POST", `/api/computers/${c.id}/act`, { action }).catch((e) => setError((e as Error).message));

  const statusColor = stateColor(state, c, mine);
  const statusText = mine ? "You're in control" : state.label;
  // while you drive, the lead agent waits: say so (kept short; the full line is the tooltip)
  const pausedNote = mine && lead ? `${lead.name} is paused` : null;
  const pausedFull = lead ? `You are in control. ${lead.name} is paused. Agents get it back when you hand it back or stop using it.` : "You are in control.";
  const infoBtn = (cls: string) => (
    <button data-details-btn type="button" onClick={() => setDetails((d) => !d)} aria-label="Details" aria-expanded={details} aria-haspopup="dialog" className={cx("m-press shrink-0 rounded-full grid place-items-center text-accent-computers hover:bg-accent-computers/16", details && "bg-accent-computers/16", cls)}>
      <Info size={17} />
    </button>
  );
  const moreMenu = (size: string) => canEdit && (
    <Menu
      align="right"
      trigger={(_o, t) => (
        <button onClick={t} className={cx("m-press shrink-0 rounded-full grid place-items-center hover:bg-hover text-ink", size)} aria-label="More">
          <MoreHorizontal size={18} />
        </button>
      )}
      items={[
        { label: "Rename", onSelect: () => setRenaming(true) },
        // when you're only watching, the tools live here
        ...(!mine && !teacher && canControl ? [{ label: "Teach a task", icon: <Video size={14} />, onSelect: () => setPickTeach(true) }] : []),
        ...(!mine && !teacher && canTransfer ? [{ label: "Clipboard", icon: <ClipboardList size={14} />, onSelect: () => toggle("clipboard") }, { label: "Files", icon: <FolderOpen size={14} />, onSelect: () => toggle("files") }] : []),
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
  );
  const back = (size: string) => (
    <a href={href({ view: "computers", computerId: null })} className={cx("m-press shrink-0 rounded-full grid place-items-center hover:bg-hover", size)} aria-label="Back to Computers">
      <ChevronLeft size={19} />
    </a>
  );
  const statusDot = <span className={cx("size-[7px] rounded-full shrink-0", state.working && !mine && "motion-safe:animate-pulse")} style={{ background: statusColor }} />;
  // what the agents are doing, or just "Watching"
  const watchText = state.working ? (
    <>
      <PulseDots />
      <span className="truncate">
        {lead?.name ?? "An agent"} is working · {c.activity?.text ?? "Working"}
      </span>
    </>
  ) : c.help ? (
    <span className="truncate">
      <span className="font-medium">{agents.find((a) => a.id === c.help!.agentId)?.name ?? "An agent"} needs you.</span> Take over to help.
    </span>
  ) : c.controller ? (
    <span className="truncate">{state.label}</span>
  ) : canControl ? (
    <>
      <Eye size={14} className="shrink-0 text-muted" /> <span>Watching</span>
      <span className="hidden sm:inline truncate font-normal text-muted">· click the screen to take control</span>
    </>
  ) : (
    <span className="truncate">{state.label}</span>
  );
  const takeBtn = canControl && !mine && !teacher && (
    <button disabled={busy || !!c.controller} onClick={() => void control(true)} className="m-press shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-ink text-panel text-sm font-medium disabled:opacity-50">
      <Hand size={14} /> Take control
    </button>
  );
  const handBtn = mine && !teacher && (
    <button disabled={busy} onClick={() => setHanding(true)} className="m-press shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full bg-ink text-panel text-sm font-medium disabled:opacity-50">
      <Hand size={14} /> Hand back{lead ? <span className="hidden 2xl:inline"> to {lead.name}</span> : null}
    </button>
  );
  const tool = (label: string, icon: ReactNode, color: string, onClick: () => void, active?: boolean, title?: string) => (
    <button key={label} type="button" data-overlay-ignore onClick={onClick} aria-label={label} aria-pressed={active} title={title ?? label} className={cx("m-press h-8 min-w-8 px-2 2xl:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-sm font-medium hover:bg-hover", active && "bg-hover")}>
      <span className={color}>{icon}</span>
      <span className="hidden 2xl:inline">{label}</span>
    </button>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col safe-top safe-bottom">
      {/* phone: a small header; the desktop chip floats on the screen instead */}
      <header className="md:hidden shrink-0 flex items-center gap-2 px-3 pt-3 pb-2">
        {back("size-11")}
        {lead ? <AgentAvatar agent={lead} size={26} live /> : <Icon size={20} className="text-accent-computers shrink-0" />}
        <h1 className="text-base font-semibold truncate min-w-0 flex-1">{c.name}</h1>
        {infoBtn("size-11")}
        {moreMenu("size-11")}
      </header>

      {teacher && <TeachBar agent={teacher} computer={c} screen={screen} />}

      {!teacher && c.help && (
        <div className="shrink-0 mx-2 mb-2 rounded-xl border border-st-needs bg-card px-4 py-3 flex flex-wrap items-center gap-3" role="status">
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
      {error && <p className="shrink-0 mx-3 mb-2 text-sm text-bad">{error}</p>}
      {c.status === "error" && c.statusText && <p className="shrink-0 mx-3 mb-2 text-sm text-bad">{c.statusText}</p>}

      {/* on short phones the page scrolls, so Take control / Hand back stays reachable */}
      <div className="flex-1 min-h-0 p-2 flex flex-col gap-2 overflow-y-auto md:overflow-visible">
        {/* desktop: one slim bar above the screen, so nothing ever covers the remote screen */}
        <div className="hidden md:flex shrink-0 items-center gap-2 h-10 px-1" data-testid="screen-bar">
          <div className="flex items-center gap-2 min-w-0" data-testid="name-chip">
            {back("size-8")}
            {lead ? <AgentAvatar agent={lead} size={24} live /> : <Icon size={18} className="text-accent-computers shrink-0" />}
            <span className="font-semibold text-sm truncate min-w-0 max-w-[8rem] xl:max-w-[14rem]" title={c.name}>{c.name}</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium shrink-0 whitespace-nowrap" role="status" title={mine ? pausedFull : undefined} style={{ color: mine || c.help ? statusColor : undefined }}>
              {statusDot}
              <span className={cx("max-lg:sr-only", !(mine || c.help) && "text-muted")}>{statusText}</span>
              {pausedNote && <span className="hidden 2xl:inline font-normal text-muted">· {pausedNote}</span>}
            </span>
            {infoBtn("size-8")}
            {moreMenu("size-8")}
          </div>

          {mine && !teacher && (
            <div className="flex items-center gap-0.5 shrink-0 ml-auto" role="toolbar" aria-label="Computer tools" data-testid="control-toolbar">
              {canControl && tool("Teach a task", <Video size={16} />, "text-tool-teach", () => setPickTeach(true), false, "Do a task once while an agent watches; it saves it as a routine")}
              {canTransfer && tool("Clipboard", <ClipboardList size={16} />, "text-tool-clip", () => toggle("clipboard"), panel === "clipboard", "Clipboard: copy and paste between it and this device")}
              {canTransfer && tool("Files", <FolderOpen size={16} />, "text-tool-files", () => toggle("files"), panel === "files", "Files: download from it, upload to it")}
              {tool("Keys", <Keyboard size={16} />, "text-tool-keys", () => setKeys((k) => !k), keys)}
              {c.online && !c.paused && tool("Screenshot", <Camera size={16} />, "text-tool-shot", () => void saveScreenshot(c).catch((e) => setError(e.message)))}
              <span className="hidden md:block w-px h-5 bg-line mx-1" aria-hidden="true" />
              <span className="hidden md:inline-flex">{handBtn}</span>
            </div>
          )}
          {sync.note && <span className="min-w-0 truncate text-xs text-muted" role="status">{sync.note}</span>}
          {!mine && !teacher && (
            <div className="flex items-center gap-2.5 min-w-0 ml-auto text-sm font-medium" role="status" data-testid="watching-pill">
              {watchText}
              {takeBtn}
            </div>
          )}
        </div>

        {sync.note && <span className="md:hidden shrink-0 truncate text-xs text-muted" role="status">{sync.note}</span>}

        {/* the panels and Keys sit beside the screen (not inside its keyboard capture), so local copy and paste in them stays local */}
        <div className="relative flex-1 min-h-[220px] md:min-h-[280px] rounded-xl overflow-hidden bg-black border border-line">
        <div
          className="absolute inset-0"
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
          <LiveScreen
            ref={screen}
            computer={c}
            control={mine}
            noRing
            raiseNote
            onInput={teacher ? (i) => screen.current && teachSink.current?.(i) : undefined}
            onTakeControl={canControl && !c.controller && !teacher ? () => void control(true) : undefined}
            onActivity={() => {
              // VNC input skips the hub, so say now and then that you're still using it
              if (Date.now() - touched.current < 15_000) return;
              touched.current = Date.now();
              void api("POST", `/api/computers/${c.id}/control`, { take: true }).catch(() => {});
            }}
          />

          {/* the amber frame says the desk is yours */}
          {mine && <div className="absolute inset-0 z-10 rounded-xl border-2 border-st-needs pointer-events-none" data-testid="control-frame" />}

          {dropping && (
            <div className="absolute inset-0 z-30 rounded-xl border-2 border-dashed border-info bg-info/15 grid place-items-center pointer-events-none">
              <span className="inline-flex items-center gap-2 rounded-full bg-black/70 text-white px-4 h-10 text-sm font-medium">
                <Upload size={16} /> Drop to send to {c.name}'s Desktop
              </span>
            </div>
          )}


        </div>

          {panel && (
            <FloatingPanel
              label={panel === "files" ? "Files" : "Clipboard"}
              onClose={() => setPanel(null)}
              className="m-panel fixed inset-x-0 bottom-0 top-auto max-h-[70vh] z-40 md:absolute md:inset-x-auto md:right-3 md:top-3 md:bottom-auto md:w-80 md:max-h-[calc(100%-5rem)] overflow-y-auto text-sm bg-panel text-ink border border-line rounded-t-[16px] md:rounded-xl p-4 shadow-panel"
              testId="float-panel"
            >
              {panel === "files" ? <FilesPanel computer={c} onClose={() => setPanel(null)} refresh={filesChanged} onSent={sync.flash} /> : <ClipboardPanel computer={c} mine={mine} platform={platform} onClose={() => setPanel(null)} />}
            </FloatingPanel>
          )}
        </div>

        {mine && keys && !teacher && (
          <FloatingPanel
            label="Keys"
            onClose={() => setKeys(false)}
            as="form"
            className="shrink-0 glass rounded-xl p-2 flex flex-col gap-2 w-full m-menu"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed) return;
              void act({ action: "type", text: typed });
              setTyped("");
            }}
          >
            <div className="flex items-center gap-2">
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type on computer" aria-label="Type on computer" className="flex-1 min-w-0" />
              <Button type="submit" disabled={!typed}>
                Send
              </Button>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto [&>button]:shrink-0">
              {[["Return", "Enter"], ["Tab", "Tab"], ["Escape", "Escape"], ["Delete", "Backspace"]].map(([label, key]) => (
                <Button key={label} type="button" onClick={() => void act({ action: "key", keys: key })}>
                  {label}
                </Button>
              ))}
            </div>
          </FloatingPanel>
        )}


        {/* phone: status and the one big action under the screen */}
        {!teacher && (
          <div className="md:hidden shrink-0 flex items-center gap-2 min-h-11 pb-[5.5rem]" role="status">
            <span className="flex-1 min-w-0 inline-flex items-center gap-2 h-9 px-3 rounded-full bg-card text-sm font-medium">
              {mine ? (
                <>
                  {statusDot} <span className="truncate" title={pausedFull}><span style={{ color: statusColor }}>You're in control</span>{pausedNote && <span className="font-normal text-muted"> · {pausedNote}</span>}</span>
                </>
              ) : (
                watchText
              )}
            </span>
            {mine ? handBtn : takeBtn}
          </div>
        )}
      </div>

      {details && <DetailsBubble anchor={findInfoButton} onClose={() => setDetails(false)} computer={c} state={state} statusColor={statusColor} device={device} on={on} />}

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
  );
}

/** Move focus into an overlay when it opens and back to where it came from (or the fallback) when it closes. */
function useFocusScope(ref: React.RefObject<HTMLElement | null>, fallback?: () => HTMLElement | null) {
  useEffect(() => {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>("input, textarea, select, button, a[href]") ?? el)?.focus({ preventScroll: true });
    return () => {
      const back = from && from !== document.body && from.isConnected ? from : (fallback?.() ?? null);
      back?.focus({ preventScroll: true });
    };
  }, []);
}

/**
 * Clipboard, Files and Keys: floating panels over the screen. They sit on the overlay stack, so
 * Escape and a click outside close the top one, and focus moves in and then back. Their buttons
 * (data-overlay-ignore) and menus handle their own clicks.
 */
function FloatingPanel({ label, onClose, as: Tag = "aside", className, testId, children, onSubmit }: { label: string; onClose: () => void; as?: "aside" | "form"; className: string; testId?: string; children: ReactNode; onSubmit?: (e: React.FormEvent) => void }) {
  const id = useMemo(() => Symbol(`computer-${label}`), [label]);
  const ref = useRef<HTMLElement>(null);
  useOverlay(id, "modal");
  useFocusScope(ref);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!isTopOverlay(id)) return;
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.("[data-overlay-ignore], [role=menu], [role=dialog]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isTopOverlay(id)) return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [id]);
  const props = { ref: ref as never, tabIndex: -1, "aria-label": label, className: cx(className, "outline-none"), "data-testid": testId, onSubmit };
  return Tag === "form" ? <form {...props}>{children}</form> : <aside {...props}>{children}</aside>;
}

/** The visible Details button (the phone header's or the desktop chip's). */
function findInfoButton(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("[data-details-btn]")].find((b) => b.offsetParent !== null) ?? null;
}

/** The Details bubble: a small popover under the info button. Escape or a click outside closes it. */
function DetailsBubble({ anchor, onClose, computer: c, state, statusColor, device, on }: { anchor: () => HTMLElement | null; onClose: () => void; computer: ComputerInfo; state: { label: string }; statusColor: string; device?: DeviceInfo; on: Agent[] }) {
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const id = useMemo(() => Symbol("computer-details"), []);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; arrow: number } | null>(null);
  const [closing, setClosing] = useState(false);
  useOverlay(id, "modal");
  useFocusScope(ref, anchor);
  const close = () => {
    setClosing(true);
    setTimeout(onClose, 160);
  };
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor()?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(300, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      const next = { top: r.bottom + 10, left, arrow: r.left + r.width / 2 - left };
      setPos((cur) => (cur && cur.top === next.top && cur.left === next.left && cur.arrow === next.arrow ? cur : next));
    };
    place();
    window.addEventListener("resize", place);
    // the button moves when the layout around it does (a help banner appears, the pane resizes)
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    for (let el: HTMLElement | null = anchor(); el; el = el.parentElement) ro?.observe(el);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, []);
  // capture phase on the window: the screen swallows pointer and key events before they bubble
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!isTopOverlay(id)) return;
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor()?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isTopOverlay(id)) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [id]);
  const rows: [string, ReactNode][] = [
    ["Kind", c.kind === "vm" ? "Virtual computer" : c.kind === "orgo" ? "Cloud computer" : "Your own screen"],
    [
      "Status",
      <span key="s" className="inline-flex items-center gap-1.5" style={{ color: statusColor }}>
        <span className="size-[7px] rounded-full" style={{ background: statusColor }} /> {state.label}
      </span>,
    ],
    ["In control", c.controller ? (c.controller.id === me.user.id ? "You" : (members.find((m) => m.id === c.controller!.id)?.name ?? "Someone")) : "No one"],
  ];
  return toBody(
    <div
      ref={ref}
      role="dialog"
      aria-label="Details"
      tabIndex={-1}
      data-closing={closing || undefined}
      style={pos ? { position: "fixed", top: pos.top, left: pos.left, width: Math.min(300, window.innerWidth - 16), transformOrigin: `${pos.arrow}px 0` } : { position: "fixed", visibility: "hidden", top: 0, left: 0, width: 300 }}
      className="m-menu glass z-[100] rounded-xl text-sm text-ink outline-none"
    >
      {pos && <span aria-hidden="true" className="absolute -top-[6px] size-3 rotate-45 border-l border-t border-control-line" style={{ left: pos.arrow - 6, background: "var(--glass-bg)" }} />}
      <div className="p-3 space-y-3 max-h-[min(70vh,560px)] overflow-y-auto">
      <div className="space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3">
            <span className="text-muted">{k}</span>
            <span className="ml-auto text-right">{v}</span>
          </div>
        ))}
        {c.nodeId && (
          <a href={href({ view: "computers", computerId: null, deviceId: c.nodeId })} onClick={close} className="flex items-center gap-3 -mx-1.5 px-1.5 py-0.5 rounded-lg hover:bg-hover">
            <span className="text-muted">Lives on</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-accent-computers">
              <Laptop size={14} /> {device?.name ?? "A device"} <ChevronRight size={14} className="text-faint" />
            </span>
          </a>
        )}
      </div>
      {c.kind === "device" && <OwnScreen computer={c} />}
      <div className="border-t border-line pt-2 space-y-1">
        {on.length ? (
          on.map((a) => (
            <a key={a.id} href={href({ view: "agents", agentId: a.id, tab: "computer" })} onClick={close} className="flex items-center gap-2 rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-hover">
              <AgentAvatar agent={a} size={22} live />
              <span className="min-w-0 flex-1 truncate">
                {a.name} <span className="text-muted">@{a.handle}</span>
              </span>
              <span className="text-xs text-faint">{a.status === "busy" ? "working" : "runs here"}</span>
            </a>
          ))
        ) : (
          <p className="text-xs text-muted">No agents yet. Give an agent this computer on its page (Agents → Computer). Agents that share a computer share its files, browser and sign-ins.</p>
        )}
      </div>
      <ActivityLog computer={c} />
      </div>
    </div>,
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
    <section className="rounded-lg bg-card border border-line p-2.5 space-y-1">
      <h3 className="font-semibold text-sm flex items-center gap-1.5">
        <Lock size={13} className="text-accent-computers" /> Your own screen
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
  const [all, setAll] = useState(false);
  if (!log?.length) return null;
  const shown = all ? log.slice(0, 50) : log.slice(0, 3);
  return (
    <section className="border-t border-line pt-2 space-y-1.5" aria-label="Activity">
      <ol className={cx("space-y-1.5 text-sm", all && "max-h-56 overflow-y-auto")}>
        {shown.map((l, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="size-[7px] rounded-full shrink-0 translate-y-[-1px] self-center" style={{ background: activityDot(l.text) }} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {l.actor.id === "system" ? (
                // things that happened on their own (wrong codes) read as a sentence
                <span className="text-muted">{l.text}</span>
              ) : (
                <>
                  <span className="font-medium">{who(l.actor)}</span> <span className="text-muted">{l.text.charAt(0).toLowerCase() + l.text.slice(1)}</span>
                </>
              )}
            </span>
            <span className="text-faint text-xs shrink-0 tabular-nums">{timeAgo(l.at)}</span>
          </li>
        ))}
      </ol>
      {log.length > 3 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="text-sm text-accent-computers font-medium hover:underline">
          {all ? "Fewer" : "All activity"}
        </button>
      )}
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
            <Field label="What's the task called?">
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
