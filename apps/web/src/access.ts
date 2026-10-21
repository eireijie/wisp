import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api.ts";

/** Tailscale on the hub's computer, as GET /api/access reports it (owners get every field). */
export interface TailscaleInfo {
  state: "missing" | "needs-login" | "stopped" | "starting" | "running" | "error";
  dnsName: string | null;
  serving: boolean;
  funnel: boolean;
  ip?: string | null;
  tailnet?: string | null;
  canHttps?: boolean;
  canFunnel?: boolean;
  authUrl?: string | null;
  error?: string | null;
}

export interface AccessInfo {
  /** Tailscale's https address when it serves this hub; null means only this network */
  publicUrl: string | null;
  lan: string[];
  tailscale: TailscaleInfo;
  download: string;
  hubPlatform: string;
}

const isLoopback = (host: string) => /^(localhost|127\.|\[?::1\]?$)/i.test(host);

/** The page is already open at an address other computers can use over https (a cloud hub, a domain, Tailscale). */
export function onPublicAddress(loc: Pick<Location, "protocol" | "hostname"> | undefined = typeof location === "undefined" ? undefined : location): boolean {
  return !!loc && loc.protocol === "https:" && !isLoopback(loc.hostname);
}

export const useAccessStore = create<{ info: AccessInfo | null; failed: boolean; refresh: (fresh?: boolean) => Promise<AccessInfo | null>; act: (action: string) => Promise<AccessInfo> }>((set) => ({
  info: null,
  /** the hub didn't answer (an older hub, or it's down) */
  failed: false,
  refresh: async (fresh = false) => {
    const info = await api<AccessInfo>("GET", `/api/reach${fresh ? "?fresh=1" : ""}`).catch(() => null);
    set(info ? { info, failed: false } : { failed: true });
    return info;
  },
  act: async (action) => {
    const info = await api<AccessInfo>("POST", "/api/reach/tailscale", { action });
    set({ info });
    return info;
  },
}));

/** The hub's addresses and Tailscale status, refreshed every `everyMs` while mounted (0: once). */
export function useAccess(everyMs = 0): AccessInfo | null {
  const info = useAccessStore((s) => s.info);
  const refresh = useAccessStore((s) => s.refresh);
  useEffect(() => {
    refresh();
    if (!everyMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), everyMs);
    return () => clearInterval(t);
  }, [everyMs, refresh]);
  return info;
}

/**
 * The address to put in links others will open (invites, devices joining, install commands):
 * Tailscale's https address when it's on; else the page's own address unless that's this
 * computer's loopback; else the computer's home-network address.
 */
export function shareOrigin(info: AccessInfo | null = useAccessStore.getState().info, loc: Pick<Location, "origin" | "hostname"> = location): string {
  if (info?.publicUrl) return info.publicUrl;
  if (!isLoopback(loc.hostname)) return loc.origin;
  return info?.lan[0] ?? loc.origin;
}

/** Whether a link made from `origin` only works on the home network (or only on this computer). */
export function originReach(origin: string): "anywhere" | "network" | "this-computer" {
  try {
    const u = new URL(origin);
    if (isLoopback(u.hostname)) return "this-computer";
    if (u.protocol === "https:") return "anywhere";
    return "network";
  } catch {
    return "network";
  }
}

const SKIP_KEY = "warren.access.skipped";
/** "Only on this Wi-Fi for now": the setup step counts as done on this browser. */
export function accessSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}
export function skipAccess() {
  try {
    localStorage.setItem(SKIP_KEY, "1");
  } catch {}
}
