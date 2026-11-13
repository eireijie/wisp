/**
 * What a sign-in printed after a code was sent (its answer, like "Invalid code. Please make sure the
 * full code was copied."): its last line, without the prompt it asks again with. Exported for tests.
 */
export function replyAfter(before: string, now: string): string {
  const added = now.startsWith(before) ? now.slice(before.length) : now.split("\n").slice(-2).join("\n");
  const lines = added.split("\n").map((l) => l.replace(/Paste code here if prompted\s*>?/i, "").trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}

/**
 * The one line before a sign-in's paste box. The provider's page tells you to paste its code into
 * the harness (Claude's says "paste this code into Claude Code"); in Wisp you paste it here, and
 * Wisp hands it to the harness. Said the same way wherever a sign-in asks for a code.
 */
export function pasteHereLine(harness: string, site = "the page"): string {
  return `Sign in on ${site}. It then shows a code and says to paste it into ${harness}: paste it here instead.`;
}

/** Whether this page may read the clipboard (a secure page in a browser that allows it). */
export const canReadClipboard = () => typeof navigator !== "undefined" && !!navigator.clipboard?.readText && typeof window !== "undefined" && window.isSecureContext;

/** The clipboard's text, trimmed; "" when it's empty or the browser said no. */
export async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    return "";
  }
}
