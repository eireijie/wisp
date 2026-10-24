import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, ClientEvent } from "@wisp/core";

vi.mock("../../web/src/router.ts", () => ({ go: vi.fn() }));
const { pushOnHere } = vi.hoisted(() => ({ pushOnHere: vi.fn(() => false) }));
vi.mock("../../web/src/push.ts", () => ({ pushOnHere, syncPushPrefs: vi.fn(async () => {}) }));

// Load the browser module at runtime so the hub's TypeScript project needn't compile the web store and JSX.
let notify: { notifyOn: (event: ClientEvent, before: any, after: any) => void; setNotifyPrefs: (prefs: Record<string, boolean>) => void };
beforeAll(async () => {
  const modulePath = "../../web/src/notifications.ts";
  notify = await import(modulePath);
});

const notification = vi.fn(class {
  close() {}
});
beforeEach(() => {
  notification.mockClear();
  pushOnHere.mockReturnValue(false);
  Object.assign(notification, { permission: "granted" });
  vi.stubGlobal("Notification", notification);
  vi.stubGlobal("window", { Notification: notification });
  vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
  notify.setNotifyPrefs({ enabled: true, dms: true, replies: true, onlyAway: true, sound: false });
});
afterEach(() => vi.unstubAllGlobals());

function message(notifyPreference = "default", kind = "channel", threadId: string | null = null, author: Actor = { kind: "agent", id: "agent" }, joined = true, body = "Hello") {
  const state = {
    me: { user: { id: "me" } },
    agents: [{ id: "agent", name: "Atlas" }],
    members: [{ id: "other", name: "Sam" }],
    channels: [{ id: "channel", name: "general", kind, joined, notify: notifyPreference }],
    messages: { channel: [{ id: "root", author: { kind: "user", id: "me" } }] },
  };
  const event: ClientEvent = { type: "message", message: { id: "message", channelId: "channel", threadId, author, body, parts: [], hop: 0, createdAt: "" } };
  notify.notifyOn(event, state, state);
}

describe("local message notifications", () => {
  it("silences muted channels and DMs, including replies to your threads", () => {
    message("mute", "channel", "root");
    message("mute", "dm");
    expect(notification).not.toHaveBeenCalled();
  });

  it("notifies for agent and other people's messages in channels set to all", () => {
    notify.setNotifyPrefs({ dms: false, replies: false });
    message("all");
    message("all", "channel", "root");
    message("all", "channel", null, { kind: "user", id: "other" });
    expect(notification).toHaveBeenCalledTimes(3);
  });

  it("keeps the default DM and thread reply behavior", () => {
    message();
    message("default", "channel", null, { kind: "user", id: "other" });
    expect(notification).not.toHaveBeenCalled();
    message("default", "dm");
    message("default", "channel", "root");
    expect(notification).toHaveBeenCalledTimes(2);
    notify.setNotifyPrefs({ dms: false, replies: false });
    message("default", "dm");
    message("default", "channel", "root");
    expect(notification).toHaveBeenCalledTimes(2);
  });

  it("doesn't notify for your own messages, system notices, empty messages or unjoined channels", () => {
    message("all", "channel", null, { kind: "user", id: "me" });
    message("all", "channel", null, { kind: "user", id: "system" });
    message("all", "channel", null, { kind: "agent", id: "agent" }, false);
    message("all", "channel", null, { kind: "agent", id: "agent" }, true, " ");
    expect(notification).not.toHaveBeenCalled();
  });

  it("avoids duplicating push notifications for all-message channels and DMs", () => {
    pushOnHere.mockReturnValue(true);
    message("all");
    message("all", "channel", "root");
    message("default", "dm");
    expect(notification).not.toHaveBeenCalled();
    message("all", "channel", null, { kind: "user", id: "other" });
    expect(notification).toHaveBeenCalledOnce();
  });

  it("still respects device notification permission and away-only preferences", () => {
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
    message("all");
    expect(notification).not.toHaveBeenCalled();
    notify.setNotifyPrefs({ onlyAway: false });
    message("all");
    expect(notification).toHaveBeenCalledOnce();
    Object.assign(notification, { permission: "denied" });
    message("all");
    expect(notification).toHaveBeenCalledOnce();
  });
});
