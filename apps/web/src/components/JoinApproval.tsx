import { useEffect, useRef, useState } from "react";
import { Monitor, Loader2 } from "lucide-react";
import { api, observeEvents } from "../api.ts";
import { canApproveJoin, displayJoinCode, unavailable, updateJoinRequests, type JoinRequest } from "../join.ts";
import { useStore } from "../store.ts";
import { Modal } from "./ui.tsx";
import { AuthButton, AuthLink } from "./auth.tsx";

/** Mounted once alongside the app dialogs, including over onboarding and Settings. */
export function JoinApproval() {
  const me = useStore((s) => s.me);
  const connected = useStore((s) => s.connected);
  const workspaceName = useStore((s) => s.me?.workspace.name);
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
    <Modal title={`${request.name} wants to join`} onClose={later} headerless label={`${request.name} wants to join`} className="z-60 sm:max-w-[520px] rounded-t-[38px]! sm:rounded-[28px]!" contentClassName="p-6 sm:p-9">
      <div className="flex items-center gap-3.5">
        <span className="size-12 shrink-0 rounded-[15px] bg-chip grid place-items-center text-ink/85" aria-hidden>
          <Monitor size={24} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[22px] leading-tight font-bold">{request.name} wants to join</h2>
          <p className="mt-0.5 text-sm text-muted">Another computer asked to join {workspaceName ?? "your Wisp"}.</p>
        </div>
      </div>
      <div className="my-5 rounded-3xl bg-card p-[18px] text-center">
        <p className="text-sm text-muted">It should show the same code.</p>
        <p className="mt-1.5 font-mono text-[40px] leading-tight font-bold tracking-[0.2em] tabular-nums">{displayJoinCode(request.code)}</p>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-1.5 items-center">
        <AuthButton disabled={busy} onClick={() => void decide("approve")}>
          {busy && <Loader2 size={15} className="animate-spin" />}Approve
        </AuthButton>
        <div className="flex gap-1">
          <AuthLink disabled={busy} onClick={() => void decide("deny")}>
            Deny
          </AuthLink>
          <AuthLink onClick={later}>Later</AuthLink>
        </div>
      </div>
    </Modal>
  );
}
