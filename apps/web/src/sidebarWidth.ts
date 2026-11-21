/**
 * The desktop sidebar's width (2026-11-21 canvas "Wisp docked sidebar"): always docked, dragged
 * wider or narrower by its edge, and it stays where it's left. Below SNAP it snaps to icons.
 * The width and whether it's collapsed are remembered on this device.
 */
export const SIDEBAR = {
  /** icons only: your ghosts and the line icons */
  rail: 64,
  min: 208,
  max: 400,
  /** double-click the edge */
  default: 260,
  /** dragged under this, it snaps to icons; pulled back past it, it springs to min */
  snap: 140,
  /** arrow keys on the edge */
  step: 16,
  /** windows narrower than this show icons until there's room again (the saved width is kept) */
  roomy: 900,
} as const;

/** Grok Bot-measured motion: opening settles fast-then-slow, closing is quicker. */
export const SIDEBAR_EASE = "cubic-bezier(.165,.84,.44,1)";
export const SIDEBAR_OPEN_MS = 200;
export const SIDEBAR_CLOSE_MS = 100;

const KEY = "wisp.sidebar";

export interface SidebarState {
  /** the width it has when it isn't collapsed */
  width: number;
  collapsed: boolean;
}

export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR.default;
  return Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, Math.round(w)));
}

/** Where the edge lands while dragging, from the pointer's distance to the sidebar's left edge. */
export function dragWidth(x: number): number {
  return x < SIDEBAR.snap ? SIDEBAR.rail : clampWidth(x);
}

/** After a drag ends at `w`: a full width is kept; icons collapse and keep the last full width. */
export function settle(prev: SidebarState, w: number): SidebarState {
  return w <= SIDEBAR.rail ? { width: prev.width, collapsed: true } : { width: clampWidth(w), collapsed: false };
}

/** The arrow keys on the focused edge: 16 px a press, and past the narrowest it collapses. */
export function stepWidth(s: SidebarState, dir: -1 | 1): SidebarState {
  if (s.collapsed) return dir > 0 ? { width: SIDEBAR.min, collapsed: false } : s;
  const next = s.width + dir * SIDEBAR.step;
  if (next < SIDEBAR.min) return { width: s.width, collapsed: true };
  return { width: clampWidth(next), collapsed: false };
}

export function loadSidebar(): SidebarState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SidebarState> | null;
    if (raw && typeof raw === "object") return { width: clampWidth(Number(raw.width ?? SIDEBAR.default)), collapsed: raw.collapsed === true };
  } catch {}
  return { width: SIDEBAR.default, collapsed: false };
}

export function saveSidebar(s: SidebarState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ width: clampWidth(s.width), collapsed: s.collapsed }));
  } catch {}
}
