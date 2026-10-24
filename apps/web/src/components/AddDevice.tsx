import { useEffect, useState } from "react";
import { Download, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { api } from "../api.ts";
import { RELEASES } from "../downloads.ts";
import { unavailable } from "../join.ts";
import { useStore } from "../store.ts";
import { canApproveJoin } from "../join.ts";
import { PhonePairing } from "../views/settings/mobile.tsx";
import { Button, CopyBlock, Modal } from "./ui.tsx";

export function AddDeviceContent() {
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="rounded-2xl border border-line p-5 space-y-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Smartphone size={20} />
          Phone
        </h3>
        <PhonePairing autoStart compact />
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
            <a href={RELEASES} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-ink underline">
              <Download size={15} />
              Download Wisp
            </a>
          </li>
          <li className="pl-1">
            Pick <strong className="font-semibold">Join my Wisp</strong>.<span className="block mt-1 text-muted">On this Wi-Fi it finds you.</span>
          </li>
          <li className="pl-1">Approve it here.</li>
        </ol>
        <div className="border-t border-line pt-4 space-y-3">
          <p className="text-sm">Somewhere else? Send it this invite link.</p>
          {invite && !expired && (
<CopyBlock text={invite.url} />
          )}
          {!allowed && <p className="text-sm text-muted">Ask your Wisp's owner for an invite link.</p>}
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
