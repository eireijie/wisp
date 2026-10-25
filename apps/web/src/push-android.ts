import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";

/**
 * Push in Wisp's Android app. Its web view can't do Web Push, so the app does push itself
 * (Firebase Cloud Messaging) and tells the page through the `WispAndroid` bridge it exposes.
 * Everything here is false/empty in a normal browser.
 */
interface Bridge {
  pushState?: () => string;
  enablePush?: () => void;
}

const bridge = (): Bridge | null => {
  const b = (typeof window !== "undefined" ? (window as unknown as { WispAndroid?: Bridge }).WispAndroid : undefined) ?? null;
  return b && typeof b.pushState === "function" ? b : null;
};

/** Whether this page is running inside the Android app (with push handled natively). */
export const androidPush = () => bridge() !== null;

export interface AndroidPushState {
  /** the hub has a Firebase service account, so it can push to Android */
  hubReady: boolean | null;
  /** the person allowed notifications for the app (always true before Android 13) */
  allowed: boolean;
  /** this phone has given the hub its push token */
  registered: boolean;
}

export function parseState(raw: string | null | undefined): { allowed: boolean; registered: boolean } {
  try {
    const j = JSON.parse(raw ?? "{}") as { permission?: boolean; registered?: boolean };
    return { allowed: !!j.permission, registered: !!j.registered };
  } catch {
    return { allowed: false, registered: false };
  }
}

/** Push status for this phone, refreshed when the app says the permission answer came back. */
export function useAndroidPush() {
  const [state, setState] = useState<AndroidPushState>({ hubReady: null, allowed: false, registered: false });
  const refresh = useCallback(async () => {
    const hub = await api<{ android?: { available?: boolean } }>("GET", "/api/me/push").catch(() => null);
    setState({ hubReady: hub ? !!hub.android?.available : false, ...parseState(bridge()?.pushState?.()) });
  }, []);
  useEffect(() => {
    void refresh();
    // the app fires this after the permission prompt; registering with the hub takes a moment more
    const again = () => {
      void refresh();
      setTimeout(() => void refresh(), 3000);
    };
    window.addEventListener("wisp-push-state", again);
    return () => window.removeEventListener("wisp-push-state", again);
  }, [refresh]);
  const turnOn = () => bridge()?.enablePush?.();
  const test = async () => {
    const r = await api<{ sent: number }>("POST", "/api/me/push/test").catch(() => ({ sent: 0 }));
    return r.sent > 0;
  };
  return { ...state, turnOn, test, refresh };
}
