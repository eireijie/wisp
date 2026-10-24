import { useEffect, useState } from "react";
import { isLocalOnlyHost } from "./loopback.ts";
import { api } from "./api.ts";

/** What Settings → Memory knows: where the vault is and how to sync it from another computer. */
export interface MemoryStorage {
  /** the folder on the hub's machine; owners only */
  path: string | null;
  source: "env" | "setting" | "default";
  /** false for organizations other than the first: their memory lives in Wisp's data folder and can't be moved (older hubs leave it out) */
  movable?: boolean;
  setting: string | null;
  pendingRestart: boolean;
  nextPath: string | null;
  restartable: boolean;
  previous: string | null;
  moved: { from: string; to: string; how: "copied" | "merged" | "none"; files: number } | null;
  sync: { allowed: boolean; reason: string | null; urlPath: string; branch: string | null };
  tokens: { id: string; label: string; createdAt: string; lastUsed: string | null }[];
}

/** Is this browser on the same machine as the hub? Only then can obsidian:// reach the vault's folder. */
export const onHubMachine = () => isLocalOnlyHost(window.location.hostname);

/** A link that opens the vault (or one note) in Obsidian on this computer. */
export function obsidianLink(root: string, note?: string): string {
  const clean = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return `obsidian://open?path=${encodeURIComponent(note ? `${clean}/${note}` : clean)}`;
}

export function useMemoryStorage(): MemoryStorage | null {
  const [storage, setStorage] = useState<MemoryStorage | null>(null);
  useEffect(() => {
    api<MemoryStorage>("GET", "/api/memory/storage").then(setStorage, () => {});
  }, []);
  return storage;
}
