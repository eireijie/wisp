import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Cloud, Eye, Hand, Info, Laptop, Loader2, Lock, Minimize2, Monitor, MoreHorizontal, Play, Plus, Power, Server, Trash2, Video, X } from "lucide-react";
import { activeLoan, lentNow, type Actor, type Agent, type PageElement } from "@warren/core";
import { api, uploadFile } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { computerKindLabel, lendLabel, osName, usableDevices, useDevices, vmAvailabilityNote, type DeviceInfo } from "../devices.ts";
import { LiveScreen, ScreenThumb, WorkingBadge, type LiveScreenHandle, type ScreenInput } from "../components/Screen.tsx";
import { Advanced, useSimple } from "../experience.tsx";
import { AgentAvatar, Button, Empty, Field, Input, Menu, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";

/** How a computer is doing, in a word or two, for cards and headers. */
export function computerState(c: ComputerInfo, meId: string | undefined, agents: Agent[], memberName: (id: string) => string): { label: string; tone: "neutral" | "ok" | "warn" | "bad" | "info" | "accent"; working: boolean } {
  if (!c.online) return { label: "Offline", tone: "neutral", working: false };
  if (c.paused) return { label: "Paused at the device", tone: "warn", working: false };
  if (c.status === "starting") return { label: c.statusText || "Starting…", tone: "info", working: false };
  if (c.status === "error") return { label: "Problem", tone: "bad", working: false };
  if (c.controller) return { label: c.controller.id === meId ? "You're in control" : `${memberName(c.controller.id)} is in control`, tone: "accent", working: false };
  const recent = c.activity && Date.now() - new Date(c.activity.at).getTime() < 30_000;
  const busy = agents.some((a) => c.agents.includes(a.id) && a.status === "busy");
  if (recent || (busy && c.activity)) return { label: "Working", tone: "warn", working: true };
  const loan = activeLoan(c);
  if (loan) return { label: `Lent to @${agents.find((a) => a.id === loan.agentId)?.handle ?? "an agent"}`, tone: "accent", working: false };
  return { label: c.status === "stopped" ? "Stopped" : "Ready", tone: "ok", working: false };
}

export function useComputerState(c: ComputerInfo) {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const members = useStore((s) => s.members);
  // re-evaluate "Working" as activity ages
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return computerState(c, me?.user.id, agents, (id) => members.find((m) => m.id === id)?.name ?? "Someone");
}

const KIND_ICON = { device: Laptop, vm: Monitor, orgo: Cloud };

export function ComputersView({ computerId, teach, onBack }: { computerId: string | null; teach: string | null; onBack?: () => void }) {
  const computers = useStore((s) => s.computers);
  const me = useStore((s) => s.me);
  const devices = useDevices();
  const [adding, setAdding] = useState(false);
  const selected = computers.find((c) => c.id === computerId);
  const canEdit = me?.role !== "guest";

  useEffect(() => {
    useStore.getState().refreshComputers();
  }, []);

  if (computerId) {
    if (!selected) return <div className="flex-1 grid place-items-center text-sm text-muted">{computers.length ? "That computer is gone." : "Loading…"}</div>;
    return <ComputerDetail key={selected.id} computer={selected} devices={devices} teach={teach} />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="text-sm font-semibold uppercase tracking-wider flex-1 truncate">Computers</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add computer
          </Button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        {computers.length === 0 ? (
          <Empty icon={<Monitor />} title="Give your agents a computer">
            <p>Agents work on computers the way you do: they open apps and websites, sign in once, and keep their files. You can watch them work and take control anytime.</p>
            <p>Each agent gets its own screen: a VM on one of your devices, or an Orgo cloud computer. Your own screen stays yours.</p>
            {canEdit && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus size={16} /> Add computer
              </Button>
            )}
          </Empty>
        ) : (
          <div className="p-4 md:p-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 max-w-6xl">
            {computers.map((c) => (
              <ComputerCard key={c.id} computer={c} devices={devices} />
            ))}
          </div>
        )}
      </div>
      {adding && devices && <AddComputer devices={devices} onClose={() => setAdding(false)} onCreated={(c) => (setAdding(false), go({ view: "computers", computerId: c.id }))} />}
    </div>
  );
}

function ComputerCard({ computer: c, devices }: { computer: ComputerInfo; devices: DeviceInfo[] | null }) {
  const agents = useStore((s) => s.agents);
  const state = useComputerState(c);
  const Icon = KIND_ICON[c.kind];
  const on = agents.filter((a) => c.agents.includes(a.id));
  return (
    <a href={href({ view: "computers", computerId: c.id })} className="group rounded-2xl border border-line bg-panel p-3 hover:shadow-panel transition-shadow">
      <div className="flex items-start gap-2 mb-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{c.name}</div>
          <div className="text-xs text-muted flex items-center gap-1">
            <Icon size={12} /> {computerKindLabel(c, devices)}
          </div>
        </div>
        {state.working ? <WorkingBadge /> : <Pill tone={state.tone}>{state.label}</Pill>}
      </div>
      <ScreenThumb computer={c} />
      <div className="mt-2.5 flex items-center gap-2 min-h-7">
        <span className="flex -space-x-1.5">
          {on.slice(0, 5).map((a) => (
            <span key={a.id} className="rounded-full ring-2 ring-panel" title={`@${a.handle}`}>
              <AgentAvatar agent={a} size={24} badge={false} />
            </span>
          ))}
        </span>
        <span className="text-xs text-muted truncate">
          {c.help ? <span className="text-accent-text font-medium">Needs you: {c.help.request}</span> : c.activity && state.working ? c.activity.text : on.length ? on.map((a) => a.name).join(", ") : "No agents yet"}
        </span>
      </div>
    </a>
  );
}

// --- adding a computer ------------------------------------------------------------------------------

type Kind = "vm" | "device" | "orgo";

/** The Simple-mode question: what should the helper be able to do? */
export type Capability = "chat" | "vm" | "device";

/** Which kind of computer to create for an answer. "Answer questions only" creates nothing. */
export function capabilityKind(c: Capability | null): Kind | null {
  return c === "vm" || c === "device" ? c : null;
}

/** New VMs are medium unless someone opens the size choice (under Advanced in Simple mode). */
export const DEFAULT_SIZE = "medium" as const;

/** Whether the Orgo cloud option can be used yet: it needs an API key saved in Settings → Computers. */
export function orgoStatus(orgo: { configured: boolean } | null): "checking" | "needs-key" | "ready" {
  return orgo === null ? "checking" : orgo.configured ? "ready" : "needs-key";
}

/** Pick where a new computer lives. Used on the Computers page and an agent's Computer tab. */
export function AddComputer({ devices, onClose, onCreated, nodeId: preferNode, defaultName }: { devices: DeviceInfo[]; onClose: () => void; onCreated: (c: ComputerInfo) => void; nodeId?: string | null; defaultName?: string }) {
  const simple = useSimple();
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

  const chatOnly = simple && capability === "chat";
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
        {simple ? (
          <div className="space-y-2">
            <p id="cap-q" className="text-sm font-medium">What should the helper be able to do?</p>
            <div role="radiogroup" aria-labelledby="cap-q" className="space-y-2">
              {card(capability === "chat", () => pickCapability("chat"), <Hand size={18} />, "Answer questions only", "No desktop needed")}
              {card(capability === "vm", () => pickCapability("vm"), <Monitor size={18} />, "Use apps in its own desktop", "A separate desktop with a web browser, a terminal and files. Your own computer stays untouched.", vmAvailabilityNote(usable))}
              {mineOnly.length > 0 && card(capability === "device", () => pickCapability("device"), <Lock size={18} />, "Use apps on my screen", "Uses your real screen, apps and files while you watch. You lend it for a while, and it only does what you ask.")}
            </div>
            <Advanced title="Cloud computer (Orgo)">
              <div role="radiogroup" aria-label="Cloud computer" className="space-y-2">
                {orgoOption}
                {orgoNeedsKey}
              </div>
            </Advanced>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Kind of computer" className="space-y-2">
            {option("vm", <Monitor size={18} />, "A VM on one of your devices", "A Debian desktop with Google Chrome, a terminal and files, separate from everything on the device. Agents get their own screen, and your computer stays yours.", vmAvailabilityNote(usable))}
            {mineOnly.length > 0 && option("device", <Lock size={18} />, "Your own screen", "Only you can see it. You lend it to agents for a while when a task needs an app that only lives on your computer, and they use it only for things you ask.")}
            {orgoOption}
            {orgoNeedsKey}
          </div>
        )}

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

        {kind && kind !== "orgo" && !(simple && choices.length === 1) && (
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
                {device.name}'s screen is off. Only you can turn it on, at that computer: <code>warren node screen on</code>
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
            {!simple && kind !== "device" && !existing && sizeField}
          </div>
        )}
        {simple && showSizing && !existing && (
          <Advanced title="Size and resources">
            <div className="grid sm:grid-cols-2 gap-3">{sizeField}</div>
          </Advanced>
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
  const [info, setInfo] = useState(false);
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
  const leave = () => {
    if (mine) void api("POST", `/api/computers/${c.id}/control`, { take: false }).catch(() => {});
    go({ view: "computers", computerId: null });
  };

  // teaching needs control
  useEffect(() => {
    if (teacher && c.online && !c.controller) control(true);
  }, [teacher?.id, c.online]);

  const canControl = canEdit && c.online && !c.paused;
  const lead = on[0];
  const darkBtn = "inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50";

  // The computer opens as its desk: the screen big on a dark backdrop, like the full-screen view.
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#141312] text-white safe-top safe-bottom">
      <header className="shrink-0 relative flex flex-wrap items-center gap-2 px-3 md:px-5 pt-3 pb-3 min-h-14">
        {lead ? <AgentAvatar agent={lead} size={26} live /> : <Icon size={18} className="text-white/70 shrink-0" />}
        <span className="font-medium truncate">{c.name}</span>
        {!mine && (state.working ? <WorkingBadge text={c.activity?.text ?? "Working"} /> : <Pill tone={state.tone}>{state.label}</Pill>)}
        {mine && !teacher && (
          <div className="md:absolute md:left-1/2 md:top-3 md:-translate-x-1/2 inline-flex items-center gap-2 rounded-full bg-info text-white pl-3.5 pr-1 h-9 text-sm font-medium shadow-panel" role="status">
            <Hand size={15} /> You are in control
            <button disabled={busy} onClick={() => control(false)} className="h-7 px-3 rounded-full bg-white/20 hover:bg-white/30 text-xs font-medium">
              Hand back
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {canControl && !teacher && (
            <button onClick={() => setPickTeach(true)} className={cx(darkBtn, "border border-white/20")} title="Do a task once while an agent watches; it saves it as a routine">
              <Video size={15} /> Teach a task
            </button>
          )}
          <button onClick={() => setInfo((v) => !v)} className={cx("size-9 rounded-full grid place-items-center hover:bg-white/10", info && "bg-white/15")} aria-label="Details" title="Details">
            <Info size={18} />
          </button>
          {canEdit && (
            <Menu
              align="right"
              trigger={(_o, t) => (
                <button onClick={t} className="size-9 rounded-full grid place-items-center hover:bg-white/10" aria-label="More">
                  <MoreHorizontal size={18} />
                </button>
              )}
              items={[
                { label: "Rename", onSelect: () => setRenaming(true) },
                ...(c.kind !== "device" ? [{ label: c.status === "stopped" ? "Start" : "Stop", icon: c.status === "stopped" ? <Play size={14} /> : <Power size={14} />, onSelect: () => api("POST", `/api/computers/${c.id}/${c.status === "stopped" ? "start" : "stop"}`).catch((e) => setError(e.message)) }] : []),
                ...(canRemove ? ["divider" as const] : []),
                ...(canRemove ? [{
                  label: c.kind === "device" ? "Stop sharing this screen" : "Delete computer",
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
          <button onClick={leave} className="size-9 rounded-full grid place-items-center hover:bg-white/10" aria-label="Back to computers" title="Back to computers">
            <Minimize2 size={18} />
          </button>
        </div>
      </header>

      <div className="text-ink">
        {teacher && <TeachBar agent={teacher} computer={c} screen={screen} />}

        {!teacher && c.help && (
          <div className="shrink-0 mx-3 md:mx-5 mb-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 flex flex-wrap items-center gap-3">
            {agents.find((a) => a.id === c.help!.agentId) && <AgentAvatar agent={agents.find((a) => a.id === c.help!.agentId)} size={28} badge={false} />}
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{agents.find((a) => a.id === c.help!.agentId)?.name ?? "An agent"} needs you: </span>
              {c.help.request}
              <span className="text-muted"> · {timeAgo(c.help.at)}</span>
            </div>
            {canEdit && !mine && (
              <Button variant="primary" onClick={() => control(true)} disabled={busy}>
                <Hand size={15} /> Take control
              </Button>
            )}
            {mine && <span className="text-xs text-muted">When you're done, press Hand back and @{agents.find((a) => a.id === c.help!.agentId)?.handle} picks up from there.</span>}
          </div>
        )}
        {activeLoan(c) && canEdit && <LoanBanner computer={c} />}
      </div>
      {error && <p className="shrink-0 mx-3 md:mx-5 mb-2 text-sm text-bad">{error}</p>}
      {c.status === "error" && c.statusText && <p className="shrink-0 mx-3 md:mx-5 mb-2 text-sm text-bad">{c.statusText}</p>}

      <div className="flex-1 min-h-0 flex gap-4 px-3 md:px-5">
        <div className="flex-1 min-h-0 min-w-0">
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
        {info && (
          <aside className="fixed inset-x-0 bottom-0 top-auto max-h-[70vh] z-40 lg:static lg:max-h-none lg:w-72 shrink-0 overflow-y-auto space-y-4 text-sm bg-bg text-ink rounded-t-2xl lg:rounded-2xl p-4 shadow-panel">
            <div className="flex items-center lg:hidden">
              <h3 className="font-semibold">Details</h3>
              <button onClick={() => setInfo(false)} className="ml-auto p-1.5 rounded-md hover:bg-hover text-muted" aria-label="Close details">
                <X size={16} />
              </button>
            </div>
            {c.kind === "device" && <LendPanel computer={c} />}
            <section className="rounded-xl border border-line p-3 space-y-1.5">
              <div className="text-xs text-muted">{computerKindLabel(c, devices)}</div>
              <p className="text-muted text-xs">
                {mine
                  ? "You're in control: your mouse and keyboard go to this computer, and agents wait until you hand it back."
                  : c.controller
                    ? "Someone has control; agents are waiting."
                    : c.kind === "device"
                      ? "Take control to use it from here. Agents use it only while you lend it."
                      : "Agents use it on their own. Take control to use it yourself; they pause until you hand it back."}
              </p>
            </section>
            <section className="space-y-2">
              <h3 className="font-semibold text-sm">Agents on this computer</h3>
              {on.length ? (
                on.map((a) => (
                  <a key={a.id} href={href({ view: "agents", agentId: a.id, tab: "computer" })} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
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

      <div className="shrink-0 py-3 px-3 text-center text-sm text-white/70 min-h-11">
        {teacher ? (
          `${teacher.name} is watching. Do the task, then press Done.`
        ) : c.help ? (
          <span>
            <span className="font-medium text-white">{agents.find((a) => a.id === c.help!.agentId)?.name ?? "An agent"} needs you.</span>
            {mine ? " Hand back when you're done." : " Click the screen to take control."}
          </span>
        ) : mine ? (
          "Agents get it back when you hand it back or stop using it."
        ) : c.controller ? (
          state.label
        ) : canControl ? (
          <span className="inline-flex items-center gap-1.5">
            <Eye size={14} /> Watching · click the screen to take control
          </span>
        ) : null}
      </div>

      {pickTeach && (
        <Modal title="Teach a task" onClose={() => setPickTeach(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-muted">Do the task once on this computer while an agent watches. It saves the steps as a routine and can do it on its own next time, on a schedule if you like.</p>
            <div className="space-y-1">
              {(on.length ? on : agents).map((a) => (
                <button key={a.id} onClick={() => (setPickTeach(false), go({ view: "computers", computerId: c.id, teach: a.id }))} className="w-full flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-hover text-left">
                  <AgentAvatar agent={a} size={28} badge={false} />
                  <span className="flex-1">
                    {a.name} <span className="text-muted">@{a.handle}</span>
                  </span>
                  <ChevronRight size={14} className="text-faint" />
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {renaming && <RenameComputer computer={c} onClose={() => setRenaming(false)} />}
    </div>
  );
}

/** "Lent to @hermes until 3:40 PM · Take back": an agent is borrowing this screen. */
function LoanBanner({ computer: c }: { computer: ComputerInfo }) {
  const agents = useStore((s) => s.agents);
  const loan = activeLoan(c);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  // the banner goes away the moment the time is up
  useEffect(() => {
    if (!loan) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, new Date(loan.until).getTime() - Date.now()) + 100);
    return () => clearTimeout(t);
  }, [loan?.until]);
  if (!loan) return null;
  const agent = agents.find((a) => a.id === loan.agentId);
  const takeBack = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/loan/end`);
      await useStore.getState().refreshComputers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 mx-3 md:mx-5 mb-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 flex flex-wrap items-center gap-3">
      {agent && <AgentAvatar agent={agent} size={26} badge={false} />}
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Lent to @{agent?.handle ?? "an agent"}</span> {lendLabel(loan.until)}
        <span className="text-muted"> · it uses your screen only until then</span>
        {error && <span className="text-bad"> · {error}</span>}
      </div>
      <Button disabled={busy} onClick={takeBack}>
        Take back
      </Button>
    </div>
  );
}

const LEND_FOR = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Today", minutes: null as number | null, today: true },
  { label: "Until I stop it", minutes: null as number | null },
];

/** Your own screen: lend it to agents for a while. They use it only for things you ask them. */
function LendPanel({ computer: c }: { computer: ComputerInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lent = lentNow(c);
  const lend = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/computers/${c.id}/lend`, body);
      await useStore.getState().refreshComputers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const untilTonight = () => {
    const end = new Date();
    end.setHours(23, 59, 0, 0);
    return Math.max(1, Math.round((end.getTime() - Date.now()) / 60_000));
  };
  return (
    <section className="rounded-xl border border-line p-3 space-y-2">
      <h3 className="font-semibold text-sm flex items-center gap-1.5">
        <Lock size={13} /> Your own screen
      </h3>
      <p className="text-xs text-muted">Only you can see it. {lent ? `Agents can use it ${lendLabel(c.config.lend?.until ?? null)}, and only for things you ask them.` : "Agents can't use it right now; they work on their own VMs."}</p>
      {lent ? (
        <Button disabled={busy} onClick={() => lend({ off: true })}>
          Stop lending it
        </Button>
      ) : (
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Lend it to agents for</div>
          <div className="flex flex-wrap gap-1.5">
            {LEND_FOR.map((o) => (
              <Button key={o.label} disabled={busy} onClick={() => lend({ minutes: o.today ? untilTonight() : o.minutes })}>
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
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
  }, [c.id, activityAt, c.controller?.id, c.config.lend?.until]);
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
              <span className="font-medium">{who(l.actor)}</span> <span className="text-muted">{l.text.charAt(0).toLowerCase() + l.text.slice(1)}</span>
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

export function useComputer(id: string | null | undefined) {
  const computers = useStore((s) => s.computers);
  return useMemo(() => computers.find((c) => c.id === id), [computers, id]);
}
