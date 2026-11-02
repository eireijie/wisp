import { isLocalOnlyHost } from "./loopback.ts";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api.ts";

/** Tailscale on the hub's computer, as GET /api/reach reports it (owners get every field). */
export interface TailscaleInfo {
  state: "missing" | "needs-login" | "stopped" | "starting" | "running" | "error";
  dnsName: string | null;
  serving: boolean;
  funnel: boolean;
  /** only the paths Grok, ChatGPT and Claude's servers call are public, through Funnel on port 8443 */
  connectors?: boolean;
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
  /** where Grok, ChatGPT and Claude connect while that door is open (missing on older hubs) */
  connectorUrl?: string | null;
  lan: string[];
  tailscale: TailscaleInfo;
  download: string;
  hubPlatform: string;
  /** Optional until Cloudflare reach support is installed. */
  cloudflare?: {
    state: "missing" | "stopped" | "starting" | "running" | "error";
    url: string | null;
    error: string | null;
  };
}


/** The page is already open at an address other computers can use over https (a cloud hub, a domain, Tailscale). */
export function onPublicAddress(loc: Pick<Location, "protocol" | "hostname"> | undefined = typeof location === "undefined" ? undefined : location): boolean {
  if (!loc || loc.protocol !== "https:" || isLocalOnlyHost(loc.hostname)) return false;
  const host = loc.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) return false;
  return !host.includes(":") || !/^(fc|fd|fe[89ab])/i.test(host);
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
  if (!isLocalOnlyHost(loc.hostname)) return loc.origin;
  return info?.lan[0] ?? loc.origin;
}

/** Whether a link made from `origin` only works on the home network (or only on this computer). */
export function originReach(origin: string): "anywhere" | "network" | "this-computer" {
  try {
    const u = new URL(origin);
    if (isLocalOnlyHost(u.hostname)) return "this-computer";
    if (u.protocol === "https:") return "anywhere";
    return "network";
  } catch {
    return "network";
  }
}

/**
 * Who can open a link to this Wisp: anyone, only devices on the same Tailscale account
 * (a .ts.net address without Funnel), or only devices on this Wi-Fi.
 */
export function linkReach(url: string | null | undefined, info: AccessInfo | null): "anywhere" | "tailscale" | "wifi" {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    return "wifi";
  }
  // a cloud server's plain-http public IP still works from anywhere
  if (!onPublicAddress({ protocol: "https:", hostname: u.hostname })) return "wifi";
  return u.hostname.endsWith(".ts.net") && !info?.tailscale.funnel ? "tailscale" : "anywhere";
}

const SKIP_KEY = "wisp.access.skipped";
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
