import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Smartphone } from "lucide-react";
import { api } from "../../api.ts";
import { Button, cx } from "../../components/ui.tsx";
import { PageHeader } from "./parts.tsx";

type State = "waiting" | "claimed" | "approved" | "rejected" | "expired";
interface Pairing {
  id: string;
  state: State;
  code: string | null;
  deviceName: string | null;
  platform: string | null;
  expiresAt: string;
}
interface Started extends Pairing {
  addresses: string[];
  link: string;
}

const PRIVATE = /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const TAILNET = /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Where the phone has to be for these addresses to work, in a sentence. */
function reachHint(addresses: string[]): string {
  if (!addresses.length) return "This computer isn't on a network your phone can reach. Connect it to Wi-Fi and start again.";
  if (addresses.some((a) => !PRIVATE.test(a) && !TAILNET.test(a))) return "Your phone can reach this Warren from anywhere.";
  if (addresses.some((a) => TAILNET.test(a))) return "Your phone needs to be on the same Wi-Fi, or signed in to Tailscale.";
  return "Your phone needs to be on the same Wi-Fi as this computer. To use Warren away from home, see Deploying in the docs.";
}

/** Settings → Mobile: pair the phone app with this Warren by scanning a QR code, then matching a code. */
export function MobilePage() {
  const [started, setStarted] = useState<Started | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = useRef<string | null>(null);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const s = await api<Started>("POST", "/api/pair", { origin: window.location.origin });
      live.current = s.id;
      setStarted(s);
      setPairing(s);
      setQr(await QRCode.toDataURL(s.link, { margin: 1, width: 480, errorCorrectionLevel: "M", color: { dark: "#0b0b10", light: "#ffffff" } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // follow the pairing while a phone might scan it or the codes are being checked
  const state = pairing?.state;
  useEffect(() => {
    if (!started || (state !== "waiting" && state !== "claimed")) return;
    const t = setInterval(async () => {
      try {
        const p = await api<Pairing>("GET", `/api/pair/${started.id}`);
        if (live.current === started.id) setPairing(p);
      } catch {
        if (live.current === started.id) setPairing((p) => (p ? { ...p, state: "expired" } : p));
      }
    }, 1500);
    return () => clearInterval(t);
  }, [started, state]);

  // leaving the page ends a pairing nobody finished
  useEffect(
    () => () => {
      if (live.current) api("POST", `/api/pair/${live.current}/cancel`).catch(() => {});
    },
    [],
  );

  const confirm = async () => {
    if (!pairing) return;
    setBusy(true);
    try {
      setPairing(await api<Pairing>("POST", `/api/pair/${pairing.id}/confirm`));
      live.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!pairing) return;
    await api("POST", `/api/pair/${pairing.id}/cancel`).catch(() => {});
    live.current = null;
    setPairing({ ...pairing, state: "rejected" });
  };
  const copy = async () => {
    if (!started) return;
    await navigator.clipboard.writeText(started.link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const step = state === "claimed" ? 2 : state === "approved" ? 3 : 1;
  const phone = pairing?.deviceName || (pairing?.platform === "android" ? "your Android phone" : "your iPhone");

  return (
    <>
      <PageHeader title="Mobile">Use Warren on your phone. Open the Warren app on your iPhone or Android phone and scan the code here. No address or password to type.</PageHeader>

      <div className="rounded-xl border border-line p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row gap-6 sm:items-center">
          <div className="mx-auto sm:mx-0 size-56 shrink-0 rounded-xl border border-line bg-hover flex items-center justify-center overflow-hidden">
            {state === "waiting" && qr ? (
              <img src={qr} alt="QR code to scan with the Warren app on your phone" className="size-full bg-white p-2" />
            ) : state === "claimed" ? (
              <div className="text-center px-3" aria-live="polite">
                <div className="text-xs text-muted mb-2">Code on {phone}</div>
                <div className="font-mono text-4xl font-semibold tracking-[0.2em] tabular-nums">{pairing!.code}</div>
              </div>
            ) : state === "approved" ? (
              <div className="text-center px-4" aria-live="polite">
                <div className="mx-auto mb-2 size-10 rounded-full bg-ok/15 text-ok flex items-center justify-center">
                  <Check size={20} />
                </div>
                <div className="text-sm font-medium">Paired</div>
                <div className="text-xs text-muted mt-1">{phone} is signed in.</div>
              </div>
            ) : (
              <Button onClick={start} disabled={busy}>
                <Smartphone size={15} /> {state ? "Start again" : "Start pairing"}
              </Button>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-3">
            {state === "waiting" && started && (
              <>
                <p className="text-sm">Scan this with the Warren app, or with your phone's camera.</p>
                <p className="text-xs text-muted">{reachHint(started.addresses)}</p>
                <p className="text-xs text-muted">The code works once and expires in 5 minutes.</p>
                <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
                  {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy pairing link"}
                </button>
              </>
            )}
            {state === "claimed" && (
              <>
                <p className="text-sm">Does {phone} show the same six digits?</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={confirm} disabled={busy}>
                    Yes, pair it
                  </Button>
                  <Button variant="ghost" onClick={reject}>
                    No, cancel
                  </Button>
                </div>
                <p className="text-xs text-muted">If the digits don't match, someone else scanned your code. Cancel and start again.</p>
              </>
            )}
            {state === "approved" && (
              <>
                <p className="text-sm">Your phone is ready. It stays signed in until you sign it out under Security → Sign-ins.</p>
                <Button onClick={start} disabled={busy}>
                  Pair another phone
                </Button>
              </>
            )}
            {(state === "expired" || state === "rejected") && <p className="text-sm text-muted">{state === "expired" ? "The code expired." : "Pairing was cancelled."} Start again to show a new code.</p>}
            {!state && <p className="text-sm text-muted">Get the Warren app on your phone first, then start pairing here.</p>}
            {error && <p className="text-sm text-bad">{error}</p>}
          </div>
        </div>
      </div>

      <ol className="mt-8 space-y-5">
        {[
          ["Scan the QR code", "Open Warren on your phone and scan the code shown here."],
          ["Check the code", "Make sure the six digits match on both screens, then confirm here."],
          ["You're in", "Your phone signs in by itself after you confirm."],
        ].map(([title, text], i) => (
          <li key={title} className="flex gap-4">
            <span className={cx("size-9 shrink-0 rounded-full border flex items-center justify-center text-sm font-medium", step > i + 1 || state === "approved" ? "border-ok/40 bg-ok/10 text-ok" : step === i + 1 && state ? "border-accent text-ink" : "border-line text-muted")}>
              {step > i + 1 || state === "approved" ? <Check size={15} /> : i + 1}
            </span>
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-sm text-muted">{text}</div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
