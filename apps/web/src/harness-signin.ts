/**
 * What a sign-in printed after a code was sent (its answer, like "Invalid code. Please make sure the
 * full code was copied."): its last line, without the prompt it asks again with. Exported for tests.
 */
export function replyAfter(before: string, now: string): string {
  const added = now.startsWith(before) ? now.slice(before.length) : now.split("\n").slice(-2).join("\n");
  const lines = added.split("\n").map((l) => l.replace(/Paste code here if prompted\s*>?/i, "").trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}
