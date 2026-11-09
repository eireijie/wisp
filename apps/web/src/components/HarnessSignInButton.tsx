import { useState, type ReactNode } from "react";
import { Loader2, LogIn } from "lucide-react";
import { harnessLabel, type AgentSignIn, type HarnessSettings } from "@wisp/core";
import { api } from "../api.ts";
import { go } from "../router.ts";
import { useStore } from "../store.ts";
import { HarnessSignIn, type HarnessesResponse } from "../views/settings/harnesses.tsx";
import { cx } from "./ui.tsx";

/**
 * "Sign in" for a harness where it runs, right here: on a device it opens that harness's own
 * sign-in (link, code, paste box); inside an agent's own computer it starts the sign-in on that
 * computer's screen and takes you there to finish it. Works for any harness and any computer.
 */
export function HarnessSignInButton({ signIn, agentId, className, children, onOpenChange }: { signIn: AgentSignIn; agentId?: string; className?: string; children?: ReactNode; onOpenChange?: (open: boolean) => void }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ device: HarnessesResponse["device"]; settings: HarnessSettings; account: HarnessSettings["accounts"][number] } | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (signIn.computerId) {
        if (!agentId) throw new Error("open the agent's computer to sign in there");
        const r = await api<{ computerId: string }>("POST", `/api/agents/${agentId}/signin`);
        go({ view: "computers", computerId: r.computerId });
        return;
      }
      const r = await api<HarnessesResponse>("GET", `/api/nodes/${signIn.nodeId}/harness-settings?harness=${encodeURIComponent(signIn.harness)}&account=${encodeURIComponent(signIn.account)}`);
      const settings = r.harnesses.find((h) => h.harness === signIn.harness);
      const account = settings?.accounts.find((a) => a.id === signIn.account) ?? settings?.accounts.find((a) => a.isDefault) ?? settings?.accounts[0];
      if (!settings || !account) throw new Error(`${harnessLabel(signIn.harness)} isn't on ${signIn.where} anymore`);
      setOpen({ device: r.device, settings, account });
      onOpenChange?.(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void start()} className={cx("h-8 px-3 rounded-full border border-control-line bg-control text-[13px] text-ink hover:bg-hover disabled:opacity-50 inline-flex shrink-0 items-center gap-1.5", className)}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />} {children ?? "Sign in"}
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
      {open && <HarnessSignIn device={open.device} settings={open.settings} account={open.account} onClose={() => (setOpen(null), onOpenChange?.(false))} onDone={() => void refreshAgents()} />}
    </>
  );
}

/** The line a chat shows while its agent can't answer because its harness isn't signed in where it runs. */
export function SignInNeededBar({ agent }: { agent: { id: string; name: string; signIn?: AgentSignIn | null } }) {
  // while its sign-in is open the bar stays, so the dialog isn't lost when the status changes under it
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<AgentSignIn | null>(agent.signIn ?? null);
  if (agent.signIn && agent.signIn !== last) setLast(agent.signIn);
  const signIn = agent.signIn ?? (open ? last : null);
  if (!signIn) return null;
  return (
    <div role="status" className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px]">
      <span className="min-w-0 flex-1">
        {harnessLabel(signIn.harness)} isn't signed in on {signIn.where}, so {agent.name} can't answer yet.
      </span>
      <HarnessSignInButton signIn={signIn} agentId={agent.id} onOpenChange={setOpen} />
    </div>
  );
}
