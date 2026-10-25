import { useEffect, useState } from "react";
import {
  Download,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { api } from "../api.ts";
import {
  linkReach,
  shareOrigin,
  useAccess,
  useAccessStore,
} from "../access.ts";
import { AwayFromHome } from "./Access.tsx";
import { RELEASES } from "../downloads.ts";
import { unavailable } from "../join.ts";
import { useStore } from "../store.ts";
import { canApproveJoin } from "../join.ts";
import { PhonePairing } from "../views/settings/mobile.tsx";
import { Button, CopyBlock, Modal } from "./ui.tsx";

export function AddDeviceContent() {
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const info = useAccess();
  const [invite, setInvite] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingUpAway, setSettingUpAway] = useState(false);
  // a new phone code after Away from home turns on, so it carries the new address
  const [pairingRound, setPairingRound] = useState(0);
  const reach = linkReach(
    invite?.url ?? (info ? shareOrigin(info) : null),
    info,
  );
  const makeInvite = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await api("POST", "/api/join/invites"));
    } catch (e) {
      setError(unavailable(e, "Invite links"));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (allowed) void makeInvite();
  }, [allowed]);
  const expired = invite && Date.parse(invite.expiresAt) <= Date.now();
  return (
    <div className="space-y-4">
      {info && reach === "wifi" && (
        <div className="rounded-2xl border border-line p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Wifi size={18} className="text-muted" />
            <p className="flex-1 text-sm">These only work on this Wi-Fi.</p>
            {allowed && !settingUpAway && (
              <Button onClick={() => setSettingUpAway(true)}>
                Turn on Away from home
              </Button>
            )}
          </div>
          {settingUpAway && (
            <AwayFromHome
              onDone={() => {
                setSettingUpAway(false);
                setPairingRound((n) => n + 1);
                void useAccessStore.getState().refresh(true);
                if (allowed) void makeInvite();
              }}
            />
          )}
        </div>
      )}
      {reach === "tailscale" && (
        <p className="flex items-center gap-3 rounded-2xl border border-line p-4 text-sm">
          <ShieldCheck size={18} className="text-muted" />
          Away from home, the other device needs Tailscale too, signed in to the
          same account.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-line p-5 space-y-4">
          <h3 className="flex items-center gap-2 font-semibold">
            <Smartphone size={20} />
            Phone
          </h3>
          <PhonePairing key={pairingRound} autoStart compact />
        </section>
        <section className="rounded-2xl border border-line p-5 space-y-5">
          <h3 className="flex items-center gap-2 font-semibold">
            <Monitor size={20} />
            Another computer
          </h3>
          <ol className="space-y-4 text-sm list-decimal pl-5 marker:text-muted">
            <li className="pl-1">
              Get Wisp on it:
              <br />
              <a
                href={RELEASES}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-ink underline"
              >
                <Download size={15} />
                Download Wisp
              </a>
            </li>
            <li className="pl-1">
              Pick <strong className="font-semibold">Join my Wisp</strong>.
              <span className="block mt-1 text-muted">
                On this Wi-Fi it finds you.
              </span>
            </li>
            <li className="pl-1">Approve it here.</li>
          </ol>
          <div className="border-t border-line pt-4 space-y-3">
            <p className="text-sm">
              {reach === "wifi"
                ? "Not found? Paste this link in Join my Wisp."
                : "Somewhere else? Send it this invite link."}
            </p>
            {invite && !expired && <CopyBlock text={invite.url} />}
            {!allowed && (
              <p className="text-sm text-muted">
                Ask your Wisp's owner for an invite link.
              </p>
            )}
            {busy && (
              <p role="status" className="text-sm text-muted">
                Making an invite link…
              </p>
            )}
            {error && (
              <p role="status" className="text-sm text-muted">
                {error}
              </p>
            )}
            {allowed && !busy && (!invite || expired) && (
              <Button onClick={() => void makeInvite()}>
                <RefreshCw size={14} />
                {expired ? "Make a new link" : "Try again"}
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export function AddDeviceDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Add a device" onClose={onClose} wide>
      <div className="pt-3">
        <AddDeviceContent />
      </div>
      <div className="flex justify-end mt-5">
        <Button onClick={onClose}>Done for now</Button>
      </div>
    </Modal>
  );
}
