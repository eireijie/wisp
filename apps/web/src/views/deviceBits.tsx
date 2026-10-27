import { Server } from "lucide-react";
import type { DeviceCapabilities, DeviceRole, OwnRemoteDesktop } from "@wisp/core";
import { cx } from "../components/ui.tsx";

export interface NodeInfo {
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
  /** the remote desktop app its owner uses to reach it; only they get it */
  remoteDesktop?: OwnRemoteDesktop | null;
  harnesses?: { id: string; version: string | null }[];
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

/** The device's tile: a server that lights up and pulses while it's connected. */
export function DeviceIcon({ online }: { online: boolean }) {
  return (
    <div className={cx("relative size-11 shrink-0 rounded-xl grid place-items-center transition-colors", online ? "bg-accent-computers/16 text-accent-computers" : "bg-hover text-faint")}>
      <Server size={19} />
      <span className="absolute -bottom-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full bg-panel">
        {online && <span className="absolute size-2.5 rounded-full motion-safe:animate-ping" style={{ background: "var(--status-online)", opacity: 0.6 }} />}
        <span className="relative size-2.5 rounded-full" style={{ background: online ? "var(--status-online)" : "var(--status-idle)" }} />
      </span>
    </div>
  );
}
