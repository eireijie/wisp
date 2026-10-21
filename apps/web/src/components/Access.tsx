import { useState } from "react";
import { Check, ExternalLink, Globe, Loader2, Lock, Wifi } from "lucide-react";
import { useStore } from "../store.ts";
import { onPublicAddress, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { Button, CopyBlock, cx } from "./ui.tsx";
import { Toggle } from "../views/settings/parts.tsx";

/** Where Tailscale stands, as the three steps an owner walks through. */
function stage(info: AccessInfo): 0 | 1 | 2 | 3 {
  const t = info.tailscale;
  if (t.state === "missing" || t.state === "error") return 0;
  if (t.state === "needs-login") return 1;
  if (t.state !== "running" || !t.serving) return 2;
  return 3;
}

/**
 * Reach Warren from anywhere with Tailscale: install it on the computer running Warren, sign in,
 * turn on the https address, and (optionally) let people without Tailscale in. Used by the setup
 * step and Settings → Access.
 */
export function AccessPanel({ compact = false }: { compact?: boolean }) {
  const info = useAccess(3000);
  const act = useAccessStore((s) => s.act);
  const refresh = useAccessStore((s) => s.refresh);
  const owner = useStore((s) => s.me?.role === "owner");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = useAccessStore((s) => s.failed);

  if (!info && failed)
    return <p className="text-sm text-muted">Warren couldn't check how it's reached. If it was just updated, restart it on the computer it runs on (or run: warren update), then reload this page.</p>;
  if (!info)
    return (
      <div className="py-8 grid place-items-center text-muted" role="status">
        <Loader2 className="animate-spin" />
      </div>
    );

  const t = info.tailscale;
  const at = stage(info);
  const run = async (action: string) => {
    setBusy(action);
    setError(null);
    try {
      const next = await act(action);
      // signing in happens on Tailscale's own page
      if (action === "login" && next.tailscale.authUrl) window.open(next.tailscale.authUrl, "_blank", "noopener");
      if (next.tailscale.error) setError(next.tailscale.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // a hub that's already on a public https address (a cloud server, a domain) needs none of this
  if (onPublicAddress() && !info.publicUrl)
    return (
      <Done url={location.origin} body="Warren already has an address that works from anywhere. Share it with the people and devices you add." />
    );

  if (!owner)
    return info.publicUrl ? (
      <Done url={info.publicUrl} body={`Open Warren at this address from anywhere. Your devices need Tailscale, signed in to ${t.tailnet ?? "the same Tailscale network"}.`} />
    ) : (
      <p className="text-sm text-muted">Warren only works on its home network for now. The owner can turn on Tailscale under Settings → Access.</p>
    );

  return (
    <div className="space-y-4">
      {!compact && (
        <ol className="flex items-center gap-2 text-xs" aria-label="Tailscale setup">
          {["Install", "Sign in", "Turn on"].map((label, i) => (
            <li key={label} className={cx("flex items-center gap-2", i === Math.min(at, 2) && at < 3 ? "text-ink font-medium" : "text-muted")}>
              {i > 0 && <span className="h-px w-5 bg-line" />}
              <span className={cx("size-5 rounded-full grid place-items-center text-[11px] font-semibold", i < at ? "bg-ok text-panel" : i === at ? "bg-ink text-panel" : "bg-chip text-muted")}>{i < at ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}

      {at === 0 && (
        <Step
          title="Install Tailscale on the computer running Warren"
          body="Tailscale is free. It connects your computers and phone privately, as if they were on the same Wi-Fi, from anywhere. Nothing is opened to the internet."
        >
          <a href={info.download} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-ink text-panel text-sm font-medium">
            Download Tailscale <ExternalLink size={14} />
          </a>
          <Button onClick={() => void refresh(true)}>I installed it</Button>
          {t.state === "error" && t.error && <p className="w-full text-xs text-bad">{t.error}</p>}
        </Step>
      )}

      {at === 1 && (
        <Step title="Sign in to Tailscale" body="Use any Google, Microsoft, GitHub or Apple account. Sign in with the same account on your phone and other computers later.">
          <Button variant="primary" disabled={!!busy} onClick={() => void run("login")}>
            {busy === "login" ? <Loader2 size={14} className="animate-spin" /> : null} Sign in to Tailscale
          </Button>
          {t.authUrl && (
            <a href={t.authUrl} target="_blank" rel="noreferrer" className="text-sm underline">
              Open the sign-in page again
            </a>
          )}
        </Step>
      )}

      {at === 2 && (
        <Step
          title={t.state === "running" ? "Turn on Warren's address" : "Connect Tailscale"}
          body={
            t.state === "running"
              ? `Warren gets a private https address on ${t.tailnet ?? "your Tailscale network"}, like https://${t.dnsName ?? "this-computer.your-tailnet.ts.net"}. Only devices signed in to it can open it.`
              : "Tailscale is signed in but switched off on this computer."
          }
        >
          {t.state === "running" ? (
            <Button variant="primary" disabled={!!busy} onClick={() => void run("serve")}>
              {busy === "serve" ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />} Turn on the address
            </Button>
          ) : (
            <Button variant="primary" disabled={!!busy} onClick={() => void run("up")}>
              {busy === "up" ? <Loader2 size={14} className="animate-spin" /> : null} Connect
            </Button>
          )}
        </Step>
      )}

      {at === 3 && info.publicUrl && (
        <>
          <Done url={info.publicUrl} body={`Open Warren at this address from anywhere. On your phone and other computers, install Tailscale and sign in to ${t.tailnet ?? "the same account"}.`} />
          {t.canFunnel !== false && (
            <label className="flex items-start justify-between gap-3 rounded-xl border border-line p-3.5">
              <span className="text-sm">
                <span className="font-medium flex items-center gap-1.5">
                  <Globe size={14} /> Let people without Tailscale in
                </span>
                <span className="block text-xs text-muted mt-0.5">
                  Turns on Tailscale Funnel: the same address works for anyone, like a friend you invite. They still need an invite and a password; anyone with the address can see Warren's sign-in page.
                </span>
              </span>
              <Toggle on={t.funnel} onChange={(on) => void run(on ? "funnel" : "unfunnel")} label="Let people without Tailscale in" disabled={!!busy} />
            </label>
          )}
          <button type="button" className="text-xs text-muted hover:text-ink underline" disabled={!!busy} onClick={() => void run("unserve")}>
            Turn off the address
          </button>
        </>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}

      {info.lan.length > 0 && !compact && (
        <details className="rounded-xl bg-bg px-3.5 py-2.5 text-sm">
          <summary className="cursor-pointer font-medium flex items-center gap-1.5">
            <Wifi size={14} /> On the same Wi-Fi
          </summary>
          <p className="mt-2 text-xs text-muted">Devices on this computer's network can also use:</p>
          <div className="mt-2 space-y-1.5">
            {info.lan.map((a) => (
              <CopyBlock key={a} text={a} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Step({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
      <div>
        <p className="text-[15px] font-semibold">{title}</p>
        <p className="text-sm text-muted mt-0.5">{body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Done({ url, body }: { url: string; body: string }) {
  return (
    <div className="rounded-xl border border-ok/40 bg-ok/10 p-4 space-y-2.5">
      <p className="text-[15px] font-semibold flex items-center gap-1.5">
        <Check size={16} className="text-ok" /> Warren works from anywhere
      </p>
      <CopyBlock text={url} />
      <p className="text-sm text-muted">{body}</p>
      {location.origin !== url && (
        <a href={url} className="inline-flex items-center gap-1.5 text-sm font-medium underline">
          Open Warren at this address <ExternalLink size={13} />
        </a>
      )}
    </div>
  );
}
