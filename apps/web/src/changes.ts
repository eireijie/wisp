import { useEffect, useState } from "react";
import type { Allowance, Change } from "@warren/core";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

/** One fetch per version, shared by every change card on screen. */
const cache = new Map<number, Promise<Change[]>>();

/** What agents changed for you (settings, mods), newest first; stays current through "changes_changed". */
export function useChanges(): Change[] | null {
  const version = useStore((s) => s.changesVersion);
  const [list, setList] = useState<Change[] | null>(null);
  useEffect(() => {
    let p = cache.get(version);
    if (!p) {
      cache.clear();
      cache.set(version, (p = api<Change[]>("GET", "/api/changes").catch(() => [])));
    }
    let live = true;
    p.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [version]);
  return list;
}

export const undoChange = (id: string) => api("POST", `/api/changes/${id}/undo`);

/** Today's background usage against your allowance, across every agent. */
export function useAllowance(): [Allowance | null, (dailyTokens: number | null) => Promise<void>] {
  const version = useStore((s) => s.backgroundVersion);
  const [a, setA] = useState<Allowance | null>(null);
  useEffect(() => {
    let live = true;
    api<Allowance>("GET", "/api/background/allowance").then(
      (x) => live && setA(x),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [version]);
  const save = async (dailyTokens: number | null) => setA(await api<Allowance>("PUT", "/api/background/allowance", { dailyTokens }));
  return [a, save];
}

/** The amounts people pick from, smallest first; null = no limit. */
export const ALLOWANCE_LEVELS: { label: string; tokens: number | null }[] = [
  { label: "Low", tokens: 300_000 },
  { label: "Medium", tokens: 1_000_000 },
  { label: "High", tokens: 3_000_000 },
  { label: "No limit", tokens: null },
];

/** 340k, 1.2M */
export const tokensText = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);

/** "34% of today's allowance", or what was used when there's no limit. */
export function allowanceText(a: Allowance): string {
  if (!a.dailyTokens) return `${tokensText(a.todayTokens)} used today`;
  return `${Math.min(100, Math.round((a.todayTokens / a.dailyTokens) * 100))}% of today's allowance`;
}
