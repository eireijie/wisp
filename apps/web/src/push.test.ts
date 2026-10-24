import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import * as push from "./push.ts";
import * as notifications from "./notifications.ts";

vi.mock("./api.ts", () => ({ api: vi.fn() }));
vi.mock("./router.ts", () => ({ go: vi.fn() }));
const getSubscription = vi.fn();
const sub = { endpoint: "https://push.test/device", toJSON: () => ({ endpoint: "https://push.test/device", keys: { p256dh: "key", auth: "auth" } }) };

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("window", { PushManager: class {}, Notification });
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn(async () => ({ pushManager: { getSubscription, subscribe: vi.fn(async () => sub) } })) } });
  getSubscription.mockReset().mockResolvedValue(sub);
  vi.mocked(api).mockReset().mockImplementation(async (_method, path) => path === "/api/push/key" ? { publicKey: "AQID" } : []);
  notifications.setNotifyPrefs({ enabled: false, dms: true, replies: true, approvals: true, help: true, tasks: true, sound: false, onlyAway: true });
});
afterEach(() => vi.unstubAllGlobals());

const defaults = { dms: true, replies: true, approvals: true, help: true, tasks: true };
const expectSubscription = (prefs: typeof defaults) => expect(api).toHaveBeenLastCalledWith("POST", "/api/push/subscribe", { ...sub.toJSON(), prefs });

describe("push categories", () => {
  it("sends current categories when enabling push", async () => {
    notifications.setNotifyPrefs({ replies: false, tasks: false });
    expect(await push.enablePush()).toEqual({ ok: true });
    expectSubscription({ ...defaults, replies: false, tasks: false });
    expect(push.pushOnHere()).toBe(true);
  });

  it.each(["dms", "replies", "approvals", "help", "tasks"] as const)("resends the subscription when %s changes while push is on", async (key) => {
    localStorage.setItem("warren.push", "1");
    notifications.setNotifyPrefs({ [key]: false });
    await vi.waitFor(() => expectSubscription({ ...defaults, [key]: false }));
    expect(getSubscription).toHaveBeenCalledOnce();
    vi.mocked(api).mockClear();
    notifications.setNotifyPrefs({ [key]: false, sound: true, onlyAway: false, enabled: true });
    await Promise.resolve();
    expect(api).not.toHaveBeenCalled();
  });

  it("doesn't subscribe when push is off and tolerates failed updates", async () => {
    notifications.setNotifyPrefs({ dms: false });
    await Promise.resolve();
    expect(getSubscription).not.toHaveBeenCalled();
    localStorage.setItem("warren.push", "1");
    vi.mocked(api).mockRejectedValue(new Error("Offline"));
    notifications.setNotifyPrefs({ dms: true });
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    await expect(push.syncPushPrefs()).resolves.toBeUndefined();
  });
});

describe("startup push reconciliation", () => {
  it("clears a stale flag during notification initialization when the subscription is gone", async () => {
    localStorage.setItem("warren.push", "1");
    getSubscription.mockResolvedValue(null);
    notifications.primeTasks();
    await vi.waitFor(() => expect(push.pushOnHere()).toBe(false));
    expect(getSubscription).toHaveBeenCalledOnce();
  });

  it.each(["denied", "default"])("clears the flag when notification permission is %s", async (permission) => {
    localStorage.setItem("warren.push", "1");
    vi.stubGlobal("Notification", { permission });
    await push.reconcilePush();
    expect(push.pushOnHere()).toBe(false);
  });

  it("keeps the flag for a live, permitted subscription", async () => {
    localStorage.setItem("warren.push", "1");
    await push.reconcilePush();
    expect(push.pushOnHere()).toBe(true);
  });
});
