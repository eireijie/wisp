import { api } from "./api.ts";
import { getNotifyPrefs } from "./notifications.ts";

/**
 * Web push for this device: the hub sends to it while Warren is closed (an agent writing to you,
 * or asking for your OK). Needs the service worker, so it works in the installed app on iPhone and
 * in desktop browsers served over HTTPS (or localhost).
 */
export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** The subscription this device has with the hub, if push is on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

const toBytes = (base64url: string) => {
  const s = atob(base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const KEY = "warren.push";
/** whether this device gets push, so the page doesn't also show its own notification */
export const pushOnHere = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
};

/** Check the saved hint against the browser before suppressing page notifications. */
export async function reconcilePush() {
  if (!pushOnHere()) return;
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || !(await currentSubscription())) remember(false);
  } catch {}
}

async function subscribe(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { dms, replies, approvals, help, tasks } = getNotifyPrefs();
  await api("POST", "/api/push/subscribe", { endpoint: json.endpoint, keys: json.keys, prefs: { dms, replies, approvals, help, tasks } });
}

/** Keep the hub's categories in sync for this browser's existing subscription. */
export async function syncPushPrefs() {
  if (!pushOnHere()) return;
  try {
    const sub = await currentSubscription();
    if (sub) await subscribe(sub);
  } catch {}
}

/** Ask the browser (it must follow a tap or click), subscribe, and tell the hub. */
export async function enablePush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!pushSupported()) return { ok: false, reason: /iPhone|iPad/.test(navigator.userAgent) ? "On iPhone, add Warren to your Home Screen (Share → Add to Home Screen) and open it from there first." : "This browser can't receive push notifications." };
  const reg = await registration();
  if (!reg) return { ok: false, reason: "Warren's app isn't installed in this browser yet. Reload the page and try again." };
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return { ok: false, reason: "Notifications are blocked for Warren in this browser's settings." };
  const { publicKey } = await api<{ publicKey: string }>("GET", "/api/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) }));
  await subscribe(sub);
  remember(true);
  return { ok: true };
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  remember(false);
}
