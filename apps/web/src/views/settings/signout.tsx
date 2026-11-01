import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button, Modal } from "../../components/ui.tsx";
import { logout } from "../../logout.ts";

/** Asks first. Agents keep working; coming back needs a sign-in or the QR code. `className` styles the trigger. */
export function SignOutButton({ className, label = "Sign out", icon }: { className?: string; label?: string; icon?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button onClick={() => setAsking(true)} className={className}>
        {icon && <LogOut size={17} aria-hidden />} {label}
      </button>
      {asking && (
        <Modal title="Sign out of Wisp?" onClose={() => setAsking(false)}>
          <p className="text-body text-muted mb-5">Your agents keep working. To come back, sign in again.</p>
          <div className="flex flex-col gap-2">
            <Button
              variant="danger"
              className="h-12"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                logout();
              }}
            >
              Sign out
            </Button>
            <Button variant="ghost" className="h-12" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
