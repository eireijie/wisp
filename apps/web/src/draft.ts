/** Words waiting to prefill a chat's composer (from "Try asking…" on Home), keyed by channel id. Taken once. */
const pending = new Map<string, string>();

export function setDraft(channelId: string, text: string) {
  pending.set(channelId, text);
}

/** The waiting words for this channel, removed so they only prefill once. */
export function takeDraft(channelId: string): string | undefined {
  const text = pending.get(channelId);
  pending.delete(channelId);
  return text;
}
