import { useEffect, useRef, useState } from "react";
import { Check, Globe, Loader2 } from "lucide-react";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../../access.ts";
import { isLocalOnlyHost } from "../../loopback.ts";
import { unavailable } from "../../join.ts";
import { SetupLink } from "../../components/SetupShell.tsx";

/**
 * Whether first run shows "Use Bubble AI away from home". Only the hub's owner can turn it on;
 * a hub that is already reached from outside (a cloud server, a domain, Tailscale) has an
 * address, and an older hub with no reach API has nothing to show.
 */
export function awayStepWanted(o: { owner: boolean; info: AccessInfo | null; failed: boolean; loc?: Pick<Location, "protocol" | "hostname"> }): boolean {
  if (!o.owner || o.failed) return false;
  const loc = o.loc ?? (typeof location === "undefined" ? undefined : location);
  // a cloud server is opened at its public address (often plain http on its IP): it already has one
  if (loc && !isLocalOnlyHost(loc.hostname) && onPublicAddress({ protocol: "https:", hostname: loc.hostname })) return false;
  const info = o.info;
  if (!info) return true;
  return !info.publicUrl && info.cloudflare?.state !== "running";
}

/** The three ticks, read from the hub's Tailscale status. */
export function awayTicks(info: AccessInfo | null) {
  const s = info?.tailscale.state;
  const installed = !!s && s !== "missing";
  const signedIn = s === "running" || s === "stopped" || s === "starting";
  const on = !!info?.publicUrl && !!info.tailscale.serving;
  return { installed, signedIn, on };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const platformName = (p: string | undefined) => (p === "darwin" ? "Mac" : p === "win32" ? "PC" : "computer");

/**
 * First run, after the AI is picked (board 16): "Use Bubble AI away from home" with Tailscale.
 * Three rows tick themselves as each part finishes: installed, signed in (on Tailscale's own
 * page), address on. Signing in here turns the address on without another tap; someone already
 * signed in taps Turn on, so arriving on the page never changes anything by itself.
 * "Only at home for now" keeps it under Settings → Computers.
 */
export function AwayStep({ onDone }: { onDone: () => void }) {
  const info = useAccess(2500);
  const act = useAccessStore((s) => s.act);
  const { installed, signedIn, on } = awayTicks(info);
  const [busy, setBusy] = useState<"login" | "on" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);
  // the person tapped Sign in on this page: once Tailscale says they're in, the address turns on by itself
  const [engaged, setEngaged] = useState(false);
  const where = platformName(info?.hubPlatform);

  // looking again when the person comes back from Tailscale's installer or its sign-in page
  useEffect(() => {
    const look = () => void useAccessStore.getState().refresh(true);
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, []);

  const turnOn = async () => {
    setBusy("on");
    setError(null);
    try {
      let next = useAccessStore.getState().info;
      if (next?.tailscale.state === "stopped") next = await act("up");
      if (next?.tailscale.state === "running" && !next.tailscale.serving) next = await act("serve");
      if (next?.tailscale.error) throw new Error(next.tailscale.error);
    } catch (e) {
      setError(unavailable(e, "Away from home"));
    } finally {
      setBusy(null);
    }
  };

  // signed in from this page: the address turns on by itself, once
  useEffect(() => {
    if (!engaged || !signedIn || on || tried.current) return;
    tried.current = true;
    void turnOn();
  }, [engaged, signedIn, on]);

  const signIn = async () => {
    setBusy("login");
    setError(null);
    setEngaged(true);
    try {
      const next = await act("login");
      if (next.tailscale.authUrl) window.open(next.tailscale.authUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(unavailable(e, "Tailscale sign-in"));
    } finally {
      setBusy(null);
    }
  };

  const rows = [
    {
      key: "install",
      title: `Install Tailscale on this ${where}`,
      line: installed ? "Found it" : "Free, from Tailscale",
      done: installed,
      ready: !!info,
      action: !installed && info ? { label: "Get it", run: () => void window.open(info.download, "_blank", "noopener,noreferrer") } : null,
    },
    {
      key: "signin",
      title: "Sign in to Tailscale",
      line: signedIn ? "Signed in" : "Opens Tailscale’s own page",
      done: signedIn,
      ready: installed,
      action: installed && !signedIn ? { label: "Sign in", run: () => void signIn(), busy: busy === "login" } : null,
    },
    {
      key: "address",
      title: "Turn on your address",
      line: on ? hostOf(info!.publicUrl!) : info?.tailscale.dnsName?.replace(/\.$/, "") || "A private address your devices can reach",
      done: on,
      ready: signedIn,
      action: signedIn && !on && !busy ? { label: error ? "Try again" : "Turn on", run: () => void turnOn() } : null,
      working: busy === "on",
    },
  ];

  return (
    <div className="flex w-full max-w-[488px] flex-col">
      <Globe size={30} strokeWidth={1.6} className="text-muted" aria-hidden />
      <h1 className="ob-title mt-3.5 text-left!">Use Bubble AI away from home</h1>
      <p className="ob-sub text-left!">Tailscale gives your agents a private address your phone can reach from anywhere.</p>
      <ul className="mt-5 border-b border-line">
        {rows.map((r) => (
          <li key={r.key} className="flex min-h-[62px] items-center gap-3.5 border-t border-line" style={{ opacity: r.ready || r.done ? 1 : 0.5 }} data-done={r.done || undefined}>
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full ${r.done ? "bg-ink text-panel" : r.ready ? "shadow-[inset_0_0_0_1.5px_var(--ink)]" : "shadow-[inset_0_0_0_1.5px_var(--line2)]"}`}
              aria-hidden
            >
              {r.done ? <Check size={14} strokeWidth={2.4} /> : r.working ? <Loader2 size={13} className="animate-spin" /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col py-2">
              <span className="text-[14.5px] font-semibold">
                {r.title}
                <span className="sr-only">{r.done ? ", done" : ""}</span>
              </span>
              <span className="truncate text-[12.5px] text-muted">{r.working ? "Turning on…" : r.line}</span>
            </span>
            {r.action && (
              <button type="button" onClick={r.action.run} disabled={!!busy} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-panel outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">
                {"busy" in r.action && r.action.busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
                {r.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3.5 text-[12.5px] text-muted">Put Tailscale on your phone too, with the same account.</p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="mt-10 flex flex-col items-center">
        <button type="button" disabled={!on} onClick={onDone} className="ob-primary w-full max-w-[280px]">
          Continue
        </button>
        <SetupLink
          onClick={() => {
            skipAccess();
            onDone();
          }}
        >
          Only at home for now
        </SetupLink>
      </div>
    </div>
  );
}
