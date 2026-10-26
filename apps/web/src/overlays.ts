import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * One stack for everything that sits over the app: dialogs and sheets, the search palette, the
 * "needs your help" card, a computer's screen, the team builder. Each is portaled to <body>, so
 * the one that opened last is later in the DOM and paints on top at the same z-index; this stack
 * says the same thing to the keyboard: only the topmost overlay answers Escape and Tab.
 */
export type OverlayKind = "modal" | "palette" | "help" | "screen" | "builder";
type Entry = { id: symbol; kind: OverlayKind };
const stack: Entry[] = [];

/** Put an overlay on the stack; the returned function takes it off. */
export function registerOverlay(id: symbol, kind: OverlayKind): () => void {
  stack.push({ id, kind });
  return () => {
    const i = stack.findIndex((e) => e.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Register while `active` (and mounted). Ask `isTopOverlay` / `topOverlay` from key handlers. */
export function useOverlay(id: symbol, kind: OverlayKind, active = true) {
  useEffect(() => (active ? registerOverlay(id, kind) : undefined), [id, kind, active]);
}

/** The topmost overlay's kind, or null when nothing is open. */
export function topOverlay(): OverlayKind | null {
  return stack.at(-1)?.kind ?? null;
}

/** True when `id` is the topmost overlay (or nothing is registered at all). */
export function isTopOverlay(id: symbol): boolean {
  return !stack.length || stack[stack.length - 1]!.id === id;
}

/** Render an overlay into <body>, where its place in the DOM (later = on top) matches its place in the stack. */
export function toBody(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}
