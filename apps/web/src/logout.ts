import { api, setToken } from "./api.ts";

/** Signs out of this device (the hub forgets the session, badges clear) and reloads to the sign-in screen. */
export async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  window.wispDesktop?.setBadge(0);
  const nav = navigator as Navigator & { clearAppBadge?(): Promise<void>; setAppBadge?(n: number): Promise<void> };
  await (nav.clearAppBadge ? nav.clearAppBadge() : nav.setAppBadge?.(0))?.catch(() => {});
  setToken(null);
  location.hash = "";
  location.reload();
}
