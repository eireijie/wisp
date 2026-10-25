import { useEffect, useRef, useState } from "react";
import { Monitor, Loader2 } from "lucide-react";
import { api, observeEvents } from "../api.ts";
import { canApproveJoin, displayJoinCode, unavailable, updateJoinRequests, type JoinRequest } from "../join.ts";
import { useStore } from "../store.ts";
import { Button, Modal } from "./ui.tsx";

/** Mounted once alongside the app dialogs, including over onboarding and Settings. */
export function JoinApproval() {
  const me = useStore((s) => s.me);
  const connected = useStore((s) => s.connected);
  const allowed = canApproveJoin(me?.role);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep requests pending on the server, but don't reopen dismissed dialogs on refresh.
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    setRequests([]);
    setError(null);
    if (!allowed) return;
    let alive = true;
    let revision = 0;
    const stop = observeEvents((event) => {
      revision++;
      setRequests((r) => updateJoinRequests(r, event));
    });
    const refresh = async () => {
      const before = revision;
      try {
        const result = await api<JoinRequest[] | { requests: JoinRequest[] }>("GET", "/api/join/requests");
        if (alive && before === revision) setRequests(Array.isArray(result) ? result : result.requests);
      } catch {
        /* An older Wisp has no join requests. Keep listening for live events. */
      }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      alive = false;
      stop();
      clearInterval(timer);
    };
  }, [allowed, me?.workspace.id, connected]);
  const request = requests.find((r) => !dismissed.includes(r.id));
  const current = useRef<string | undefined>(undefined);
  current.current = request?.id;
  useEffect(() => setError(null), [request?.id]);
  if (!allowed || !request) return null;
  const later = () => setDismissed((ids) => [...ids, request.id]);
  const decide = async (action: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/join/requests/${encodeURIComponent(request.id)}/${action}`);
      setRequests((r) => r.filter((x) => x.id !== request.id));
    } catch (e) {
      if (current.current === request.id) setError((e as { status?: number }).status === 404 ? "This request has ended." : unavailable(e, "Device approval"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${request.name} wants to join`} onClose={later} headerless label={`${request.name} wants to join`} className="z-60" contentClassName="pt-6">
      <Monitor size={26} className="mb-4 text-muted" />
      <h2 className="text-xl font-semibold">{request.name} wants to join</h2>
      <div className="my-6 rounded-xl border border-line bg-bg p-5 text-center">
        <p className="text-sm text-muted">It should show the same code</p>
        <p className="mt-3 font-mono text-4xl font-semibold tracking-widest tabular-nums">{displayJoinCode(request.code)}</p>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={later}>
          Later
        </Button>
        <Button disabled={busy} onClick={() => void decide("deny")}>
          Deny
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void decide("approve")}>
          {busy && <Loader2 size={15} className="animate-spin" />}Approve
        </Button>
      </div>
    </Modal>
  );
}
