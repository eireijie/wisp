import { useEffect, useState } from "react";
import { useStore } from "./store.ts";

/**
 * Noticing that the hub now serves a newer web app than the one this window loaded (after
 * Settings → Updates, `warren update`, or a redeploy), so the page can offer a reload instead of
 * running old code until someone happens to refresh. The built app's entry script has a content
 * hash in its name, so a different name in the hub's index.html means a different build.
 */

/** The entry script an index.html loads, like "/assets/index-ZKSI-DFt.js", or null. */
export function entryScript(html: string): string | null {
  return html.match(/<script[^>]*src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
}

/** The entry script this page was loaded with, as a path. */
function loadedScript(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return el ? pathOf(el.src) : null;
}

/** A script's path, whether the page wrote it relative or the browser made it absolute. */
const pathOf = (src: string) => new URL(src, "http://hub.invalid/").pathname;

/** Whether the hub's index.html now loads a different build than `loaded`. Unknown (offline, an odd page) counts as no. */
export async function hubWasUpdated(loaded: string | null, fetchIndex: () => Promise<string> = defaultFetch): Promise<boolean> {
  if (!loaded) return false;
  try {
    const now = entryScript(await fetchIndex());
    return !!now && pathOf(now) !== pathOf(loaded);
  } catch {
    return false;
  }
}

const defaultFetch = async () => {
  const res = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
};

const EVERY = 10 * 60_000;

/** True once the hub serves a newer build. Checks when the connection comes back (the hub restarts to update), when the window comes back into view, and every few minutes. */
export function useHubUpdated(): boolean {
  const connected = useStore((s) => s.connected);
  const [updated, setUpdated] = useState(false);
  // a dev server serves source, not hashed builds
  const loaded = import.meta.env.PROD ? loadedScript() : null;

  useEffect(() => {
    if (!loaded || updated) return;
    let stopped = false;
    const check = () => void hubWasUpdated(loaded).then((u) => !stopped && u && setUpdated(true));
    const onVisible = () => document.visibilityState === "visible" && check();
    const t = setInterval(check, EVERY);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [loaded, updated]);

  // a reconnect is the usual sign: updating restarts the hub
  useEffect(() => {
    if (connected && loaded && !updated) void hubWasUpdated(loaded).then((u) => u && setUpdated(true));
  }, [connected, loaded, updated]);

  return updated;
}
