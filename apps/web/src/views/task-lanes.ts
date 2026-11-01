/** A task that failed on its own. A cancelled one is stored as failed too, but someone stopped it on purpose, so it stays with the finished ones. */
export function isFailedTask(t: { status: string; result?: string | null }): boolean {
  return t.status === "failed" && !t.result?.startsWith("Cancelled");
}

/** Finished tasks split in two: Failed never counts as Done. Most recent 20 of each. */
export function closedLanes<T extends { status: string; result?: string | null }>(closed: T[]): { failed: T[]; done: T[] } {
  return { failed: closed.filter(isFailedTask).slice(0, 20), done: closed.filter((t) => !isFailedTask(t)).slice(0, 20) };
}
