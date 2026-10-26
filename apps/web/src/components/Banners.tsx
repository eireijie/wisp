import { useEffect, useState } from "react";
import { Loader2, RefreshCw, WifiOff } from "lucide-react";
import { reconnectNow } from "../api.ts";
import { useStore } from "../store.ts";
import { useHubUpdated } from "../hubUpdate.ts";

/** True once the live connection has been down for a moment, so a quick blip or the first load doesn't flash a banner. */
function useOffline(): boolean {
  const connected = useStore((s) => s.connected);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (connected) return setLate(false);
    const t = setTimeout(() => setLate(true), 1500);
    return () => clearTimeout(t);
  }, [connected]);
  return late && !connected;
}

/**
 * The hub can't be reached. Desktops: a bar across the top of the panel with Retry. Phones: a
 * "Reconnecting…" pill near the top over a dimmed screen (it keeps trying by itself).
 */
export function OfflineBanner({ phone }: { phone: boolean }) {
  const offline = useOffline();
  const [trying, setTrying] = useState(false);
  if (!offline) return null;
  if (phone)
    return (
      <>
        <div className="fixed inset-0 z-40 bg-black/35 pointer-events-none" aria-hidden />
        <div role="status" className="glass fixed inset-x-[18px] top-[122px] z-50 h-12 rounded-full flex items-center gap-3 px-[18px] text-[15px] font-medium safe-top">
          <Loader2 size={18} strokeWidth={2.2} className="animate-spin text-muted" aria-hidden />
          Reconnecting…
        </div>
      </>
    );
  return (
    <div role="status" className="shrink-0 flex items-center justify-center gap-3.5 px-5 py-3 bg-card border-b border-line text-sm font-medium">
      <WifiOff size={18} strokeWidth={1.8} className="text-muted" aria-hidden />
      Can’t reach your Wisp
      <span className="text-faint" aria-hidden>
        ·
      </span>
      <button
        onClick={() => {
          setTrying(true);
          reconnectNow();
          setTimeout(() => setTrying(false), 1500);
        }}
        className="h-8 px-4 rounded-full bg-accent text-accent-ink text-[13px] font-medium inline-flex items-center gap-1.5"
      >
        <RefreshCw size={14} strokeWidth={2.2} className={trying ? "animate-spin" : undefined} aria-hidden />
        Retry
      </button>
    </div>
  );
}

/** The hub was updated while this window was open: offer the new version instead of running the old one. */
export function UpdatedBanner({ phone }: { phone: boolean }) {
  const updated = useHubUpdated();
  const [later, setLater] = useState(false);
  if (!updated || later) return null;
  return (
    <div
      role="status"
      className={phone ? "glass fixed inset-x-[18px] top-[122px] z-50 rounded-xl pl-[18px] pr-3.5 py-3.5 flex items-center gap-3" : "glass fixed right-6 bottom-6 z-50 w-[380px] rounded-3xl pl-5 pr-4 py-4 flex items-center gap-2.5"}
    >
      <span className={phone ? "flex-1 text-base font-medium" : "flex-1 text-[15px] font-medium"}>Wisp was updated</span>
      <button className="h-11 px-3.5 rounded-full text-muted text-[15px] font-medium hover:text-ink" onClick={() => setLater(true)}>
        Not now
      </button>
      <button className="h-11 px-[18px] rounded-full bg-accent text-accent-ink text-[15px] font-medium" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
