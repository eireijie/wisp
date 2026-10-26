/** What Escape does while the team builder is open: the same as its Back button, and it closes the "Leave without saving?" question first. */
export function escapeAction(state: { discarding: boolean; changed: boolean }): "keep-editing" | "ask" | "leave" {
  if (state.discarding) return "keep-editing";
  return state.changed ? "ask" : "leave";
}
