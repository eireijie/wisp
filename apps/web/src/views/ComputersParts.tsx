import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Cloud, Download, Hand, Laptop, Lock, Monitor, MoreHorizontal, Pause, Plus, Smartphone, Trash2 } from "lucide-react";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href, useRoute } from "../router.ts";
import { osName, useDevices, type DeviceInfo } from "../devices.ts";
import { AddDeviceDialog } from "../components/AddDevice.tsx";
import { ScreenThumb, WorkingBadge } from "../components/Screen.tsx";
import { AgentAvatar, Button, Menu, Modal, Pill, cx, timeAgo } from "../components/ui.tsx";
import { useComputerState } from "./computerState.ts";
import type { NodeInfo } from "./deviceBits.tsx";
import { AddComputer } from "./ComputersView.tsx";

// --- grouping -----------------------------------------------------------------------------------

export interface DeviceGroup {
  device: DeviceInfo;
  computers: ComputerInfo[];
}

/** Each Wisp device with the agent computers that live on it, then everything else (cloud computers). */
export function groupComputers(devices: DeviceInfo[], computers: ComputerInfo[]): { devices: DeviceGroup[]; cloud: ComputerInfo[] } {
  const ids = new Set(devices.map((d) => d.id));
  return {
    devices: devices.map((device) => ({ device, computers: computers.filter((c) => c.kind !== "orgo" && c.nodeId === device.id).sort((a, b) => Number(a.kind === "device") - Number(b.kind === "device")) })),
    cloud: computers.filter((c) => c.kind === "orgo" || !ids.has(c.nodeId ?? "")),
  };
}

/** "3 of 4 online": devices and cloud computers. */
export function onlineCount(devices: DeviceInfo[], cloud: ComputerInfo[]): { online: number; total: number } {
  return { online: devices.filter((d) => d.online).length + cloud.filter((c) => c.online).length, total: devices.length + cloud.length };
}

/** The pill on a device: Online, Offline, Paused, or where its update is. */
export function deviceStatus(n: Pick<DeviceInfo, "online" | "paused"> & { update?: NodeInfo["update"] }): { label: string; tone: "ok" | "neutral" | "warn" | "info" | "bad" } {
  if (n.update?.state === "updating" || n.update?.state === "restarting") return { label: "Updating", tone: "info" };
  if (n.update?.state === "failed") return { label: "Update failed", tone: "bad" };
  if (!n.online) return { label: "Offline", tone: "neutral" };
  if (n.paused) return { label: "Paused", tone: "warn" };
  return { label: "Online", tone: "ok" };
}

function agentsOn(c: ComputerInfo, agents: Agent[]) {
  return agents.filter((a) => c.agents.includes(a.id));
}

const dot = (tone: string) => (tone === "ok" ? "var(--status-online)" : tone === "info" || tone === "accent" ? "var(--status-working)" : tone === "warn" ? "var(--status-paused)" : tone === "bad" ? "var(--status-error)" : "var(--status-idle)");

// --- shared bits ----------------------------------------------------------------------------------

/** Phones that get this person's notifications (the hub knows a count, not names). */
export function usePhones(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    api<{ devices?: number }>("GET", "/api/me/push").then((r) => setN(r.devices ?? 0), () => {});
  }, []);
  return n;
}

/** The one Add flow: a chooser, then the device dialog or the agent-computer dialog. */
export function useAddFlow(): { start: () => void; element: ReactNode } {
  const [step, setStep] = useState<null | "choose" | "device" | "computer">(null);
  const devices = useDevices();
  const element = (
    <>
      {step === "choose" && <AddChooser onClose={() => setStep(null)} onPick={setStep} />}
      {step === "device" && <AddDeviceDialog onClose={() => setStep(null)} />}
      {step === "computer" && devices && <AddComputerLazy devices={devices} onClose={() => setStep(null)} />}
    </>
  );
  return { start: () => setStep("choose"), element };
}

function AddComputerLazy({ devices, onClose }: { devices: DeviceInfo[]; onClose: () => void }) {
  return <AddComputer devices={devices} onClose={onClose} onCreated={(c) => (onClose(), go({ view: "computers", computerId: c.id }))} />;
}

function AddChooser({ onClose, onPick }: { onClose: () => void; onPick: (s: "device" | "computer") => void }) {
  const row = (icon: ReactNode, title: string, body: string, to: "device" | "computer") => (
    <button type="button" onClick={() => onPick(to)} className="w-full text-left rounded-2xl bg-card hover:bg-hover border border-line p-4 flex items-center gap-3">
      <span className="size-10 shrink-0 rounded-xl bg-chip grid place-items-center text-ink">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-sm text-muted">{body}</span>
      </span>
      <ChevronRight size={18} className="text-faint shrink-0" />
    </button>
  );
  return (
    <Modal title="Add" onClose={onClose}>
      <div className="space-y-3 pt-1">
        {row(<Laptop size={20} strokeWidth={1.8} />, "Add a device or phone", "A device is a computer running Wisp, or your phone. Scan a QR code or type a join code.", "device")}
        {row(<Monitor size={20} strokeWidth={1.8} />, "Give an agent a computer", "A virtual computer on one of your devices, your own screen, or a cloud computer.", "computer")}
      </div>
    </Modal>
  );
}

/** A glass circle that opens the Add chooser. */
export function AddCircle({ onClick }: { onClick: () => void }) {
  return (
    <button className="circle circle-sm" aria-label="Add" onClick={onClick}>
      <Plus size={18} strokeWidth={2} />
    </button>
  );
}

// --- the page ----------------------------------------------------------------------------------------

/** Computers and devices as one list: left column on desktops once something is open. */
export function ComputersShell({ children, hideTreeOnPhone = true }: { children: ReactNode; hideTreeOnPhone?: boolean }) {
  void hideTreeOnPhone;
  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="hidden md:flex w-[300px] shrink-0 border-r border-line flex-col min-h-0">
        <ComputerTree />
      </aside>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

function treeRow(key: string, to: string, icon: ReactNode, title: string, sub: string, tone: string, active: boolean, nested: boolean) {
  return (
    <a key={key} href={to} aria-current={active ? "page" : undefined} className={cx("flex items-center gap-3 rounded-2xl px-3 py-2.5 min-h-12 hover:bg-hover", nested && "ml-5", active && "bg-side-active")}>
      <span className="w-[22px] grid place-items-center text-ink">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{title}</span>
        <span className="block text-xs text-faint truncate">{sub}</span>
      </span>
      <span className="size-2 rounded-full shrink-0" style={{ background: dot(tone) }} />
    </a>
  );
}

/** Every device, its computers nested under it, cloud computers, and phones. */
export function ComputerTree() {
  const route = useRoute();
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const me = useStore((s) => s.me);
  const devices = useDevices();
  const phones = usePhones();
  const add = useAddFlow();
  const groups = groupComputers(devices ?? [], computers);
  const activeComputer = route.view === "computers" ? route.computerId : null;
  const activeDevice = route.view === "computers" ? route.deviceId : null;
  const state = (c: ComputerInfo) => {
    const busy = agents.some((a) => c.agents.includes(a.id) && a.status === "busy");
    return !c.online ? { sub: "Offline", tone: "neutral" } : c.controller ? { sub: "In control", tone: "accent" } : busy ? { sub: "Working", tone: "info" } : { sub: "Ready", tone: "ok" };
  };
  const computerRow = (c: ComputerInfo, nested: boolean) => {
    const s = state(c);
    return treeRow(c.id, href({ view: "computers", computerId: c.id }), c.kind === "orgo" ? <Cloud size={18} strokeWidth={1.8} /> : c.kind === "device" ? <Lock size={17} strokeWidth={1.8} /> : <Monitor size={18} strokeWidth={1.8} />, c.kind === "device" ? "Your screen" : c.name, s.sub, s.tone, activeComputer === c.id, nested);
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3.5 pt-6 pb-4 space-y-1">
      <div className="flex items-center justify-between px-2 pb-3">
        <a href={href({ view: "computers", computerId: null })} className="t-title">
          Computers
        </a>
        {me?.role !== "guest" && <AddCircle onClick={add.start} />}
      </div>
      {groups.devices.map(({ device, computers: list }) => {
        const st = deviceStatus(device);
        return (
          <div key={device.id}>
            {treeRow(device.id, href({ view: "computers", computerId: null, deviceId: device.id }), <Laptop size={18} strokeWidth={1.8} />, device.name, [device.mine ? null : (device.ownerName ?? "Shared"), list.length ? `${agentCount(list)} agent${agentCount(list) === 1 ? "" : "s"}` : st.label].filter(Boolean).join(" · "), st.tone, activeDevice === device.id, false)}
            {list.map((c) => computerRow(c, true))}
          </div>
        );
      })}
      {groups.cloud.map((c) => computerRow(c, false))}
      {phones > 0 && treeRow("phones", href({ view: "computers", computerId: null }), <Smartphone size={18} strokeWidth={1.8} />, "Phones", `${phones} get notifications`, "ok", false, false)}
      {add.element}
    </div>
  );
}

function agentCount(list: ComputerInfo[]) {
  return new Set(list.flatMap((c) => c.agents)).size;
}

// --- the overview ---------------------------------------------------------------------------------------

/** One agent computer inside its device's group: live thumbnail, who and what. */
function ComputerCard({ computer: c, agents }: { computer: ComputerInfo; agents: Agent[] }) {
  const state = useComputerState(c);
  const on = agentsOn(c, agents);
  const own = c.kind === "device";
  return (
    <a href={href({ view: "computers", computerId: c.id })} className="rounded-2xl bg-panel border border-line overflow-hidden flex flex-col hover:shadow-panel transition-shadow">
      <ScreenThumb computer={c} className="rounded-none aspect-[16/9]" />
      <div className="px-3.5 py-3 space-y-1">
        <div className="flex items-center gap-2">
          {own ? <Lock size={16} className="text-muted shrink-0" /> : on[0] ? <AgentAvatar agent={on[0]} size={22} badge={false} /> : <Monitor size={16} className="text-muted shrink-0" />}
          <span className="font-medium text-sm truncate flex-1">{own ? "Your screen" : c.name}</span>
          {state.working ? <WorkingBadge /> : <Pill tone={own && state.label === "Ready" ? "neutral" : state.tone}>{own && state.label === "Ready" ? "Shared" : state.label}</Pill>}
        </div>
        <p className="text-[13px] text-muted truncate">{c.help ? <span className="text-accent-text font-medium">Needs you: {c.help.request}</span> : c.activity && state.working ? c.activity.text : own ? "Agents ask before using it" : on.length ? on.map((a) => a.name).join(", ") : "No agents yet"}</p>
      </div>
    </a>
  );
}

/** What the group header's menu can do. */
function useDeviceActions(refresh: () => void) {
  const [error, setError] = useState<string | null>(null);
  const update = async (n: DeviceInfo) => {
    try {
      await api("POST", `/api/nodes/${n.id}/update`);
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  };
  const remove = async (n: DeviceInfo) => {
    if (!confirm(`Remove ${n.name}? It will need approval to join again.`)) return;
    setError(null);
    try {
      await api("DELETE", `/api/nodes/${n.id}`);
      refresh();
    } catch (e) {
      setError(`Couldn't remove ${n.name}: ${(e as Error).message}`);
    }
  };
  return { error, update, remove };
}

export function ComputersHome() {
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const me = useStore((s) => s.me);
  const isOwner = me?.role === "owner";
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const live = useDevices();
  useEffect(() => setDevices(live), [live]);
  const refresh = () => api<DeviceInfo[]>("GET", "/api/nodes").then(setDevices, () => {});
  const actions = useDeviceActions(refresh);
  const phones = usePhones();
  const add = useAddFlow();
  const [later, setLater] = useState<string[]>([]);
  const groups = groupComputers(devices ?? [], computers);
  const count = onlineCount(devices ?? [], groups.cloud);
  const asking = computers.find((c) => c.help && !later.includes(c.id));
  const asker = asking?.help ? agents.find((a) => a.id === asking.help!.agentId) : undefined;
  const empty = devices && devices.length === 0 && computers.length === 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div data-stagger className="max-w-[1120px] mx-auto px-4 md:px-7 pt-6 md:pt-8 pb-8 space-y-5">
          <header className="flex items-center gap-3.5 safe-top">
            <h1 className="t-title">Computers</h1>
            <span className="text-sm text-faint flex-1">{devices ? `${count.online} of ${count.total} online` : ""}</span>
            <Button variant="primary" onClick={add.start} className="h-[42px] px-[18px]">
              <Plus size={16} strokeWidth={2.2} /> Add
            </Button>
          </header>
          {actions.error && (
            <p role="alert" className="text-xs text-bad">
              {actions.error}
            </p>
          )}
          {asking && (
            <div className="rounded-3xl bg-card border border-line p-4 flex flex-wrap items-center gap-3" role="status">
              {asker ? <AgentAvatar agent={asker} size={32} badge={false} /> : <Hand size={20} className="text-muted" />}
              <div className="min-w-0 flex-1 basis-44">
                <div className="text-sm font-medium">{asker?.name ?? "An agent"} needs you on this computer</div>
                <div className="text-sm text-muted">{asking.help!.request}</div>
              </div>
              <Button variant="primary" onClick={() => go({ view: "computers", computerId: asking.id })}>
                Open computer
              </Button>
              <Button variant="ghost" onClick={() => setLater((l) => [...l, asking.id])}>
                Later
              </Button>
            </div>
          )}
          {empty && (
            <div className="rounded-3xl bg-card p-8 text-center space-y-3">
              <Monitor className="mx-auto text-muted" size={28} />
              <h2 className="t-title">Give your agents a computer</h2>
              <p className="text-sm text-muted max-w-md mx-auto">Agents work on computers the way you do: they open apps and websites, sign in once, and keep their files. You can watch them work and take control anytime.</p>
              <Button variant="primary" onClick={add.start}>
                <Plus size={16} /> Add
              </Button>
            </div>
          )}
          {groups.devices.map(({ device, computers: list }) => (
            <DeviceGroupCard key={device.id} device={device as NodeInfo} list={list} agents={agents} isOwner={isOwner} actions={actions} />
          ))}
          {(groups.cloud.length > 0 || phones > 0) && (
            <div className={cx("grid gap-4", groups.cloud.length > 0 && phones > 0 && "md:grid-cols-2")}>
              {groups.cloud.length > 0 && (
                <section className="rounded-3xl bg-card border border-line p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="size-10 rounded-xl bg-chip grid place-items-center">
                      <Cloud size={20} strokeWidth={1.8} />
                    </span>
                    <h2 className="flex-1 font-semibold text-base">Cloud computers</h2>
                  </div>
                  <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                    {groups.cloud.map((c) => (
                      <ComputerCard key={c.id} computer={c} agents={agents} />
                    ))}
                  </div>
                </section>
              )}
              {phones > 0 && (
                <section className="rounded-3xl bg-card border border-line p-4 flex items-center gap-3 self-start">
                  <span className="size-10 rounded-xl bg-chip grid place-items-center">
                    <Smartphone size={20} strokeWidth={1.8} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-base">Phones</span>
                    <span className="block text-[13px] text-faint">{phones} paired · get notifications</span>
                  </span>
                  <Pill tone="ok">Paired</Pill>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      {add.element}
    </div>
  );
}

function DeviceGroupCard({ device: n, list, agents, isOwner, actions }: { device: NodeInfo; list: ComputerInfo[]; agents: Agent[]; isOwner: boolean; actions: ReturnType<typeof useDeviceActions> }) {
  const st = deviceStatus(n);
  const busy = n.update?.state === "updating" || n.update?.state === "restarting";
  const menu = [
    { label: "Open device", icon: <Laptop size={15} />, onSelect: () => go({ view: "computers", computerId: null, deviceId: n.id }) },
    ...(isOwner && n.online && !busy ? [{ label: "Update Wisp", icon: <Download size={15} />, onSelect: () => void actions.update(n) }] : []),
    ...(n.mine || isOwner ? [{ label: "Remove device", icon: <Trash2 size={15} />, danger: true, onSelect: () => void actions.remove(n) }] : []),
  ];
  const count = agentCount(list);
  return (
    <section className="rounded-3xl bg-card border border-line p-4 space-y-3.5">
      <div className="flex items-center gap-3">
        <a href={href({ view: "computers", computerId: null, deviceId: n.id })} className="flex items-center gap-3 min-w-0 flex-1" aria-label={`Open ${n.name}`}>
          <span className="size-10 shrink-0 rounded-xl bg-chip grid place-items-center">
            <Laptop size={20} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-base truncate">{n.name}</span>
            <span className="block text-[13px] text-faint truncate">
              {[n.capabilities ? osName(n.capabilities.platform) : null, !n.mine && n.ownerName ? `${n.ownerName}'s` : null, n.online ? (count ? `runs ${count} agent${count === 1 ? "" : "s"}` : "no agents yet") : n.lastSeen ? `last seen ${timeAgo(n.lastSeen)}` : "never connected"].filter(Boolean).join(" · ")}
            </span>
          </span>
        </a>
        <Pill tone={st.tone}>
          {n.paused && st.label === "Paused" && <Pause size={11} />}
          {st.label}
        </Pill>
        <Menu
          align="right"
          items={menu}
          trigger={(open, toggle) => (
            <button className={cx("circle circle-sm", open && "bg-hover")} aria-label={`${n.name} options`} onClick={toggle}>
              <MoreHorizontal size={16} />
            </button>
          )}
        />
      </div>
      {!n.online && (
        <a href={href({ view: "computers", computerId: null, deviceId: n.id })} className="block rounded-2xl bg-panel border border-line px-3.5 py-3 text-sm text-muted hover:text-ink">
          Not reachable. Tap to bring it back.
        </a>
      )}
      {n.update?.message && n.update.state !== "idle" && <p className={cx("text-xs whitespace-pre-wrap", n.update.state === "failed" ? "text-bad" : "text-muted")}>{n.update.message}</p>}
      {list.length > 0 && (
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => (
            <ComputerCard key={c.id} computer={c} agents={agents} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Header for a detail page on phones: back to the list. */
export function BackToComputers({ label = "Computers" }: { label?: string }) {
  return (
    <a href={href({ view: "computers", computerId: null })} className="md:hidden circle circle-sm shrink-0" aria-label={`Back to ${label}`}>
      <ChevronLeft size={20} />
    </a>
  );
}
