import { api } from "./api.ts";
import { setDraft } from "./draft.ts";
import { go } from "./router.ts";
import { useStore } from "./store.ts";

/** Reuse an existing DM, or create it before navigating. A draft, if given, prefills its composer. */
export async function openDm(agentId: string, draft?: string) {
  const existing = useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agentId}`));
  const id = existing?.id ?? (await api<{ id: string }>("POST", `/api/dm/${agentId}`)).id;
  if (!existing) await useStore.getState().refreshChannels();
  if (draft) setDraft(id, draft);
  go({ view: "chat", channelId: id, threadId: null });
}
