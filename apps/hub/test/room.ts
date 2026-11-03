import type { Actor, Channel, ChannelSettings } from "@wisp/core";
import type { Hub } from "../src/hub.ts";

/**
 * A plain chat room, made straight in the store. The API refuses to make a channel that isn't a
 * team of at least two agents, but many tests only need somewhere to talk.
 */
export function makeRoom(
  hub: Hub,
  who: { workspaceId: string; userId: string },
  body: { name: string; topic?: string; sectionId?: string | null; private?: boolean; settings?: Partial<ChannelSettings>; members?: Actor[] },
): { status: number; data: Channel } {
  const { store } = hub;
  const created = store.createChannel(who.workspaceId, body.name, "channel", body.topic ?? "");
  const ch = store.updateChannel(created.id, { sectionId: body.sectionId ?? null, private: body.private ?? false, settings: body.settings ?? {} })!;
  store.addChannelMember(ch.id, { kind: "user", id: who.userId });
  for (const m of body.members ?? []) store.addChannelMember(ch.id, m);
  hub.broadcast(who.workspaceId, { type: "channels_changed" });
  return { status: 200, data: ch };
}

/** The same, for whoever holds `token`, on a hub listening at `base`. */
export async function makeRoomAs(hub: Hub, base: string, token: string, body: Parameters<typeof makeRoom>[2]) {
  const res = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  const me = (await res.json()) as { user: { id: string }; workspace: { id: string } };
  return makeRoom(hub, { workspaceId: me.workspace.id, userId: me.user.id }, body);
}

/** The same, for a signed-in SDK client. */
export async function makeRoomFor(hub: Hub, client: { request: (method: string, path: string) => Promise<any> }, body: Parameters<typeof makeRoom>[2]) {
  const me = await client.request("GET", "/api/me");
  return makeRoom(hub, { workspaceId: me.workspace.id, userId: me.user.id }, body);
}
