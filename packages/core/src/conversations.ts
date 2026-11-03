/**
 * Chats split after a quiet break: when nobody has said anything at the top of a DM or team for
 * this long, the next message starts a new chat. The agent starts it with fresh context, and the
 * apps draw a dated divider where it begins. Threads never split; they're one conversation already.
 */
export const CONVERSATION_GAP_MS = 150 * 60_000;

/** What a top-level message needs for splitting: its id, when, who wrote it, and the chat it joined. */
export interface ChatPoint {
  id: string;
  createdAt: string;
  authorId: string;
  conversationId?: string | null;
}

/**
 * The chat a new top-level message joins: the latest message's, unless it's been quiet for
 * CONVERSATION_GAP_MS, then a new one named after the message itself. Wisp's own notices
 * ("Run failed") don't keep a chat going, so `latest` is the latest message someone wrote.
 */
export function conversationFor(latest: ChatPoint | undefined, message: { id: string; createdAt: string }): string {
  if (!latest) return message.id;
  const quiet = Date.parse(message.createdAt) - Date.parse(latest.createdAt);
  if (quiet >= CONVERSATION_GAP_MS) return message.id;
  return latest.conversationId || latest.id;
}

/**
 * Chat ids for a run of top-level messages, oldest first (for messages from before chats split).
 * System notices join the chat they're in and never start or extend one.
 */
export function splitConversations(messages: ChatPoint[]): Map<string, string> {
  const out = new Map<string, string>();
  let latest: ChatPoint | undefined;
  for (const m of messages) {
    const id = m.authorId === "system" ? (latest ? out.get(latest.id)! : m.id) : conversationFor(latest, m);
    out.set(m.id, id);
    if (m.authorId !== "system") latest = { ...m, conversationId: id };
  }
  return out;
}
