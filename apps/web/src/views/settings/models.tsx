import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { MODEL_PROVIDER_INFO, harnessLabel, providerLabel, type ModelConnection, type ModelProvider } from "@wisp/core";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { AgentAvatar, cx } from "../../components/ui.tsx";
import { Dlg } from "../../components/MarketParts.tsx";
import { ConnectModel } from "../../components/ConnectModel.tsx";
import { ThinBar } from "../../components/RunParts.tsx";
import { PROVIDERS, connectionName, connectionSub, forgetConnectionModels, planLeft, useConnections, windowName } from "../../models.ts";
import { PageHeader } from "./parts.tsx";

/** Phones get the larger rows and type in dialogs. */
function useNarrow() {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 767px)") : null;
  const [narrow, setNarrow] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setNarrow(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return narrow;
}

const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-chip px-3 text-[13px] font-medium hover:bg-hover";

/**
 * Settings → Models: the model connections (sign-ins and API keys) this person made, how much of
 * each plan is left, which agents use each, and the providers not connected yet.
 */
export function ModelsPage() {
  const { connections, reload } = useConnections();
  const [connecting, setConnecting] = useState<ModelProvider | "any" | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const narrow = useNarrow();
  const managed = connections?.find((c) => c.id === managing);
  const mine = (connections ?? []).filter((c) => c.mine);
  const missing = PROVIDERS.filter((p) => !mine.some((c) => c.provider === p.id));
  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <PageHeader title="Models">Connect once with a sign-in or a key. Every agent can use them, in any harness.</PageHeader>
        <button type="button" onClick={() => setConnecting("any")} className={cx(btn, "mt-0.5")}>
          <Plus size={14} /> Connect
        </button>
      </div>
      {connections === null ? (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </p>
      ) : (
        <div className="space-y-6">
          {mine.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
              {mine.map((c) => (
                <ConnectionRow key={c.id} c={c} all={mine} onManage={() => setManaging(c.id)} />
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <section>
              <h3 className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wide text-faint">Not connected</h3>
              <div className="overflow-hidden rounded-xl border border-line bg-card divide-y divide-line">
                {missing.map((p) => (
                  <div key={p.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
                    <span className="text-[14px] font-medium">{p.label}</span>
                    <span className="min-w-0 truncate text-[13px] text-faint">{p.signIn?.length ? "Sign in or API key" : "API key"}</span>
                    <button type="button" onClick={() => setConnecting(p.id)} className={cx(btn, "ml-auto")}>
                      Connect
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {connecting && (
        <Dlg title={connecting === "any" ? "Connect a model" : `Connect ${providerLabel(connecting)}`} onClose={() => setConnecting(null)}>
          <ConnectModel
            big={narrow}
            provider={connecting === "any" ? undefined : connecting}
            onDone={() => {
              forgetConnectionModels();
              reload();
              setConnecting(null);
            }}
          />
        </Dlg>
      )}
      {managed && <Manage c={managed} all={mine} onClose={() => setManaging(null)} onChanged={reload} />}
    </div>
  );
}

function ConnectionRow({ c, all, onManage }: { c: ModelConnection; all: ModelConnection[]; onManage: () => void }) {
  const agents = useStore((s) => s.agents);
  const plan = c.usage ? planLeft(c.usage) : null;
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7rem_auto]">
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium">{connectionName(c, all)}</div>
        <div className={cx("truncate text-[12px]", c.lastError ? "text-warn" : "text-faint")}>{c.lastError ?? connectionSub(c)}</div>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
        {c.usage && plan ? (
          <div className="space-y-1">
            <div className="flex justify-between gap-2 text-[12px] text-muted">
              <span className="truncate">{windowName(c.usage.window)}</span>
              <span className="shrink-0 tabular-nums">{plan.left}% left</span>
            </div>
            <ThinBar pct={plan.left} color={plan.left < 30 ? "var(--warn)" : "var(--accent-chats, #0a84ff)"} />
          </div>
        ) : (
          <span className="text-[12px] text-faint">{c.kind === "oauth" ? "Plan shows after a run" : ""}</span>
        )}
      </div>
      <div className="hidden min-w-0 items-center gap-1 md:flex">
        {c.usedBy.length ? (
          c.usedBy.slice(0, 5).map((u) => {
            const a = agents.find((x) => x.id === u.id);
            return (
              <span key={u.id} title={u.name}>
                <AgentAvatar agent={a ?? { name: u.name, handle: u.handle, harness: "" }} size={18} interactive={false} />
              </span>
            );
          })
        ) : (
          <span className="text-[12px] text-faint">No agents</span>
        )}
        {c.usedBy.length > 5 && <span className="text-[12px] text-faint">+{c.usedBy.length - 5}</span>}
      </div>
      <button type="button" onClick={onManage} className={cx(btn, "row-start-1 col-start-2 md:row-start-auto md:col-start-auto")}>
        Manage
      </button>
    </div>
  );
}

function Manage({ c, all, onClose, onChanged }: { c: ModelConnection; all: ModelConnection[]; onClose: () => void; onChanged: () => void }) {
  const [label, setLabel] = useState(c.label);
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = MODEL_PROVIDER_INFO[c.provider];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || label.trim() === c.label) return;
    setBusy("save");
    setError(null);
    try {
      await api("PATCH", `/api/model-connections/${c.id}`, { label: label.trim() });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await api("DELETE", `/api/model-connections/${c.id}`);
      forgetConnectionModels();
      onChanged();
      await useStore.getState().refreshAgents();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };
  const windows = c.usage?.windows?.length ? c.usage.windows : c.usage ? [c.usage] : [];
  return (
    <Dlg title={connectionName(c, all)} sub={connectionSub(c)} onClose={onClose}>
      <form onSubmit={save} className="flex gap-2">
        <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Name" maxLength={80} className="h-9 min-w-0 flex-1 rounded-lg border border-control-line bg-control px-3 text-[14px] outline-none focus:border-ring" />
        <button type="submit" disabled={!label.trim() || label.trim() === c.label || !!busy} className={cx(btn, "h-9 disabled:opacity-50")}>
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : "Rename"}
        </button>
      </form>
      {windows.length > 0 && (
        <div className="space-y-2.5 rounded-xl border border-line bg-card px-3.5 py-3">
          {windows.map((w) => {
            const p = planLeft(w);
            return (
              <div key={w.window} className="space-y-1">
                <div className="flex justify-between gap-2 text-[12px] text-muted">
                  <span>{windowName(w.window)}</span>
                  <span className="tabular-nums">{p.text}</span>
                </div>
                <ThinBar pct={p.left} color={p.left < 30 ? "var(--warn)" : "var(--accent-chats, #0a84ff)"} />
              </div>
            );
          })}
        </div>
      )}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 px-1 text-[13px]">
        <dt className="text-faint">Used by</dt>
        <dd className="min-w-0 truncate">{c.usedBy.length ? c.usedBy.map((u) => u.name).join(", ") : "No agents"}</dd>
        <dt className="text-faint">Harnesses</dt>
        <dd className="min-w-0 truncate">{c.harnesses.map(harnessLabel).join(", ") || "None yet"}</dd>
        {c.kind === "key" && (
          <>
            <dt className="text-faint">Key</dt>
            <dd>
              <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                Manage keys at {info.label}
              </a>
            </dd>
          </>
        )}
      </dl>
      {error && <p className="px-1 text-[12px] text-bad">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {confirm ? (
          <>
            <span className="mr-auto text-[12px] text-muted">{c.usedBy.length ? `${c.usedBy.length === 1 ? c.usedBy[0].name : `${c.usedBy.length} agents`} go back to their computer's own sign-in.` : "Remove it?"}</span>
            <button type="button" onClick={() => setConfirm(false)} className={btn}>
              Keep
            </button>
            <button type="button" onClick={remove} disabled={!!busy} className={cx(btn, "bg-bad/15 text-bad hover:bg-bad/25")}>
              {busy === "remove" ? <Loader2 size={13} className="animate-spin" /> : "Remove"}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} className={cx(btn, "text-bad")}>
            Remove
          </button>
        )}
      </div>
    </Dlg>
  );
}
