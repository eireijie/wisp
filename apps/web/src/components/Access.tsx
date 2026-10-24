import { useState } from "react";
import { Check, Globe, Home, Loader2, ShieldCheck } from "lucide-react";
import { api } from "../api.ts";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { canApproveJoin, unavailable } from "../join.ts";
import { useStore } from "../store.ts";
import { Button, Input, cx } from "./ui.tsx";

export function awayEnabled(info: AccessInfo | null): boolean {
  return !!info?.publicUrl || !!info?.cloudflare?.enabled || onPublicAddress();
}

/** Tailscale Serve is private; only Funnel makes the address usable by external apps. */
export function connectorOrigin(
  info: AccessInfo | null,
  loc: Pick<Location, "protocol" | "hostname" | "origin"> | undefined = typeof location === "undefined" ? undefined : location,
): string | null {
  const cf = info?.cloudflare;
  const candidate = cf?.enabled ? (cf.publicUrl ?? cf.url) : info?.tailscale.funnel ? info.publicUrl : null;
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (onPublicAddress(url)) return url.origin;
    } catch { /* An incomplete reach response cannot be shared with another app. */ }
  }
  if (loc && onPublicAddress(loc) && !loc.hostname.endsWith(".ts.net")) return loc.origin;
  return null;
}

/** Advance the same reach actions used by Settings, opening installation/sign-in when needed. */
export async function enableTailscale(publicAccess = false): Promise<boolean> {
  const store = useAccessStore.getState();
  let info = await store.refresh(true);
  if (!info) throw new Error("Away from home isn't available yet; update Wisp on this computer.");
  if (info.tailscale.state === "missing") {
    window.open(info.download, "_blank", "noopener,noreferrer");
    return false;
  }
  if (info.tailscale.state === "needs-login") {
    info = await store.act("login");
    if (info.tailscale.authUrl) window.open(info.tailscale.authUrl, "_blank", "noopener,noreferrer");
    return false;
  }
  if (info.tailscale.state === "stopped") info = await store.act("up");
  if (info.tailscale.state === "error") throw new Error(info.tailscale.error || "Tailscale couldn't connect; try again.");
  if (info.tailscale.state !== "running") return false;
  if (!info.tailscale.serving) info = await store.act("serve");
  if (publicAccess && !info.tailscale.funnel) info = await store.act("funnel");
  if (info.tailscale.error) throw new Error(info.tailscale.error);
  return publicAccess ? !!connectorOrigin(info) : !!info.publicUrl;
}

export function AccessPanel({ compact: _compact = false }: { compact?: boolean }) {
  return <AwayFromHome />;
}

export function AwayFromHome({ onDone }: { onDone?: () => void }) {
  const info = useAccess(3000);
  const failed = useAccessStore((s) => s.failed);
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [choice, setChoice] = useState<"tailscale" | "cloudflare" | "home">("tailscale");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const platform = info?.hubPlatform === "darwin" ? "Mac" : info?.hubPlatform === "win32" ? "PC" : "computer";
  const signedIn = !!info && info.tailscale.state === "running";
  const proceed = async () => {
    if (choice === "home") {
      skipAccess();
      onDone?.();
      return;
    }
    if (awayEnabled(info) && choice === "tailscale") {
      onDone?.();
      return;
    }
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      let ready = false;
      if (choice === "cloudflare") {
        const next = await api<AccessInfo>("POST", "/api/reach/cloudflare", { token: credential.trim() });
        useAccessStore.setState({ info: next, failed: false });
        setCredential("");
        ready = awayEnabled(next);
      } else ready = await enableTailscale();
      if (ready) {
        setHint("Away from home is on.");
        onDone?.();
      } else setHint("Finish setting up Tailscale, then choose Turn it on again.");
    } catch (e) {
      setError(unavailable(e, "Away from home"));
    } finally {
      setBusy(false);
    }
  };
  const choices = [
    {
      id: "tailscale" as const,
      icon: <ShieldCheck size={21} />,
      title: "Yes, with Tailscale",
      body: signedIn ? `Already on this ${platform}. Nothing to set up.` : "Free. Wisp helps you install it.",
    },
    { id: "cloudflare" as const, icon: <Globe size={21} />, title: "Yes, with Cloudflare", body: "Needs a domain you own." },
    { id: "home" as const, icon: <Home size={21} />, title: "Only at home for now", body: "Change it any time in Settings." },
  ];
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Away from home" className="space-y-3">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={choice === c.id}
            disabled={busy}
            onClick={() => {
              setChoice(c.id);
              setError(null);
              setHint(null);
            }}
            className={cx("w-full flex items-center gap-4 rounded-xl border p-4 text-left", choice === c.id ? "border-ink bg-hover" : "border-line hover:bg-hover")}
          >
            <span className="text-muted">{c.icon}</span>
            <span className="flex-1">
              <span className="font-medium text-sm">{c.title}</span>
              {c.id === "tailscale" && <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-xs">Best</span>}
              <span className="block mt-1 text-sm text-muted">{c.body}</span>
            </span>
            {choice === c.id && <Check size={17} />}
          </button>
        ))}
      </div>
      {choice === "cloudflare" && (
        <label className="block text-sm font-medium">
          Cloudflare setup code
          <Input
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            className="mt-2 w-full"
            placeholder="Paste from Cloudflare"
          />
        </label>
      )}
      {!info && failed && (
        <p role="status" className="text-sm text-muted">
          Away from home isn't available yet; you can keep going.
        </p>
      )}
      {choice === "tailscale" && info?.tailscale.state === "missing" && (
        <a href={info.download} target="_blank" rel="noreferrer" className="inline-block text-sm underline">
          Install Tailscale
        </a>
      )}
      {choice === "tailscale" && info?.tailscale.authUrl && (
        <a href={info.tailscale.authUrl} target="_blank" rel="noreferrer" className="inline-block text-sm underline">
          Open the Tailscale sign-in page
        </a>
      )}
      {!allowed && <p className="text-sm text-muted">Your Wisp's owner can turn this on.</p>}
      {info && awayEnabled(info) && (
        <p className="text-sm flex items-center gap-2">
          <Check size={15} />
          Away from home is on.
        </p>
      )}
      {hint && (
        <p role="status" className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void proceed()} disabled={busy || (choice !== "home" && (!allowed || (choice === "cloudflare" && !credential.trim())))}>
          {busy && <Loader2 size={15} className="animate-spin" />}
          {choice === "home" ? "Continue" : "Turn it on"}
        </Button>
      </div>
    </div>
  );
}
