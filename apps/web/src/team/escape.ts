import { topOverlay } from "../overlays.ts";

/** What Escape does while the team builder is open: the same as its Back button, and a dialog open over the builder gets it first; it closes the "Leave without saving?" question first. */
export function escapeAction(state: { discarding: boolean; changed: boolean; nested?: boolean }): "keep-editing" | "ask" | "leave" | "defer" {
  if (state.discarding) return "keep-editing";
  // a dialog opened from inside the builder (New agent, an add-step sheet) takes Escape itself
  if (state.nested) return "defer";
  return state.changed ? "ask" : "leave";
}

/** True while something is open over the builder: a dialog, the search palette, or any menu (they close on Escape and own the keyboard). */
export function builderCovered(): boolean {
  return topOverlay() !== "builder" || !!document.querySelector('[role="menu"]');
}
