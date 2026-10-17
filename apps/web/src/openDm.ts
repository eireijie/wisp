import { api } from "./api.ts";
import { go } from "./router.ts";
import { useStore } from "./store.ts";

/** Reuse an existing DM, or create it before navigating. */
export async function openDm(agentId: string) {
  const existing = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  if (existing) return go({ view: "chat", channelId: existing.id, threadId: null });
  const channel = await api<{ id: string }>("POST", `/api/dm/${agentId}`);
  await useStore.getState().refreshChannels();
  go({ view: "chat", channelId: channel.id, threadId: null });
}
