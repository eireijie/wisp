import { useState, type ReactNode } from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import type { OrchestrationSettings, OrchestrationStatus } from "@warren/core";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { go, href } from "../router.ts";
import { Button, cx } from "./ui.tsx";

/** Change the Orchestration addon (owners only); the store follows via the hub's event too. */
export async function saveOrchestration(patch: Partial<OrchestrationSettings>) {
  const next = await api<OrchestrationStatus>("PUT", "/api/settings/orchestration", patch);
  useStore.setState({ orchestration: next });
  return next;
}

/**
 * The addon's setup steps, each with a way to finish it: turn it on, pick the dispatcher, give
 * someone a role. `dispatcherPicker` replaces the default link for step two (the Addons page
 * shows its select there).
 */
export function OrchestrationChecklist({ status, dispatcherPicker, onNavigate }: { status: OrchestrationStatus; dispatcherPicker?: ReactNode; onNavigate?: () => void }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const owner = me.role === "owner";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstOther = agents.find((a) => a.id !== status.dispatcherId);
  const to = (r: Parameters<typeof go>[0]) => (onNavigate?.(), go(r));

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveOrchestration({ enabled: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action: Record<OrchestrationStatus["steps"][number]["id"], ReactNode> = {
    enabled: owner ? (
      <Button variant="primary" onClick={turnOn} disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" />} Turn on
      </Button>
    ) : (
      <span className="text-xs text-muted">An owner turns it on</span>
    ),
    dispatcher:
      dispatcherPicker ??
      (owner ? (
        <Button onClick={() => to({ view: "settings", page: "addons" })}>Pick one</Button>
      ) : (
        <span className="text-xs text-muted">An owner picks it</span>
      )),
    roles:
      agents.length < 2 ? (
        <Button onClick={() => to({ view: "agents", agentId: null })}>Add an agent</Button>
      ) : (
        <span className="flex items-center gap-2">
          {firstOther && (
            <Button onClick={() => to({ view: "agents", agentId: firstOther.id, tab: "instructions" })}>Give a role</Button>
          )}
          <a className="text-xs text-accent-text hover:underline" href={href({ view: "teams", teamId: null })} onClick={() => onNavigate?.()}>
            or set a team lead
          </a>
        </span>
      ),
  };

  // a step only makes sense once the one before it is done
  const next = status.steps.findIndex((s) => !s.done);
  return (
    <div>
      <ol className="rounded-xl border border-line divide-y divide-line">
        {status.steps.map((s, i) => (
          <li key={s.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <span className="flex items-start gap-3 min-w-0 flex-1">
              <span className={cx("mt-0.5 shrink-0 grid place-items-center size-5 rounded-full", s.done ? "bg-ok text-white" : "text-faint")}>{s.done ? <Check size={13} strokeWidth={3} /> : <Circle size={18} />}</span>
              <span className={cx("text-sm", s.done ? "text-muted" : "text-ink")}>
                <span className="font-mono text-[11px] text-faint mr-1.5">{i + 1}</span>
                {s.label}
              </span>
            </span>
            {!s.done && (i === next || s.id === "roles") && <span className="shrink-0 sm:ml-auto pl-8 sm:pl-0">{action[s.id]}</span>}
          </li>
        ))}
      </ol>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </div>
  );
}
