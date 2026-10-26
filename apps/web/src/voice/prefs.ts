import { useSyncExternalStore } from "react";

/** What a person sets for their own calls (the panel in the call). Kept on this device. */
export interface CallPrefs {
  /** playback speed of the agent's voice, 1 is normal */
  speed: number;
  /** a language tag for listening ("fr-FR"), empty to follow the browser */
  language: string;
  /** show the "Reading main.ts" line while the agent works */
  showActivity: boolean;
}
export const DEFAULT_CALL_PREFS: CallPrefs = { speed: 1, language: "", showActivity: true };
export const SPEEDS = [0.8, 1, 1.25, 1.5];
const KEY = "wisp-call-prefs";
let cache: CallPrefs | null = null;
const listeners = new Set<() => void>();

export function callPrefs(): CallPrefs {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CallPrefs>;
    cache = {
      speed: SPEEDS.includes(raw.speed as number) ? (raw.speed as number) : 1,
      language: typeof raw.language === "string" ? raw.language : "",
      showActivity: raw.showActivity !== false,
    };
  } catch { cache = { ...DEFAULT_CALL_PREFS }; }
  return cache;
}
export function setCallPrefs(patch: Partial<CallPrefs>) {
  cache = { ...callPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private window: the choice lasts until reload */ }
  listeners.forEach((l) => l());
}
export function useCallPrefs(): CallPrefs {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => { listeners.delete(cb); }), callPrefs, () => DEFAULT_CALL_PREFS);
}

/** "1x", "1.25x" */
export const speedLabel = (speed: number) => `${speed}x`;

/** The line under the timer for each phase. `paused` is a call that was running and lost its microphone. */
export function phaseLabel(phase: string, paused: boolean): string {
  if (paused) return "Paused";
  switch (phase) {
    case "connecting": return "Calling…";
    case "muted": return "Muted";
    case "listening": case "hearing": return "Listening";
    case "thinking": return "Thinking";
    case "working": return "Working";
    case "speaking": return "Speaking";
    default: return "Can't connect";
  }
}

export function clock(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
