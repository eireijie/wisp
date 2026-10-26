import { useEffect, useState } from "react";
import type { Agent } from "@wisp/core";
import { api } from "../api.ts";
import { ArrowRight, Check, Globe, Plus } from "lucide-react";
import { AgentAvatar, cx } from "../components/ui.tsx";
import { AuthButton, AuthHero, AuthInput, AuthLink, AuthPage } from "../components/auth.tsx";
import { WispGhost } from "../components/icons.tsx";

const NEW = "new";

/** A handle for a new agent named after the app ("Grok" → @grok, then @grok-2…). */
export function handleFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 28) || "app";
  let h = base;
  for (let i = 2; taken.includes(h); i++) h = `${base}-${i}`;
  return h;
}

/**
 * An app connecting to Wisp by URL (Grok, ChatGPT, Claude…) signs in here: the person picks
 * which agent it acts as, or makes one for it, and is sent back to the app.
 */
export function AuthorizeView({ requestId }: { requestId: string }) {
  const [info, setInfo] = useState<{ client: string; returnsTo: string } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pick, setPick] = useState<string>(NEW);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** the request is gone: it expired, or it was already answered */
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    Promise.all([api<{ client: string; returnsTo: string }>("GET", `/api/oauth/requests/${requestId}`), api<Agent[]>("GET", "/api/agents")])
      .then(([i, list]) => {
        setInfo(i);
        setAgents(list);
        // an agent already named after the app is the likely pick
        const same = list.find((a) => a.name.toLowerCase() === i.client.toLowerCase());
        setPick(same?.id ?? NEW);
        setName(i.client);
      })
      .catch((e) => {
        // a request that has ended answers 404 or 410; anything else is a real problem to show
        if ([404, 410].includes((e as { status?: number }).status ?? 0)) setExpired(true);
        else setError(e.message);
      });
  }, [requestId]);

  const finish = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let agentId = pick;
      if (approve && pick === NEW) {
        const n = name.trim() || info!.client;
        const harness = /grok/i.test(n + info!.client) ? "grok" : "custom";
        agentId = (await api<Agent>("POST", "/api/agents", { handle: handleFor(n, agents.map((a) => a.handle)), name: n, harness })).id;
      }
      const { redirect } = await api<{ redirect: string }>("POST", `/api/oauth/requests/${requestId}/${approve ? "approve" : "deny"}`, approve ? { agentId } : undefined);
      location.href = redirect;
    } catch (e) {
      if ((e as { status?: number }).status === 404 && /expired/i.test((e as Error).message)) setExpired(true);
      else setError((e as Error).message);
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <AuthPage themeToggle={false}>
        <AuthHero title="This request expired">Go back to the app and try connecting again.</AuthHero>
        <div className="mt-9">
          <AuthButton onClick={() => (window.history.length > 1 ? window.history.back() : window.close())}>Close</AuthButton>
        </div>
      </AuthPage>
    );
  }
  return (
    <AuthPage themeToggle={false} wide>
      {!info ? (
        <div className="flex flex-col items-center gap-4 text-ink">
          <span className="auth-bob">
            <WispGhost size={60} />
          </span>
          <span className="sr-only">Wisp</span>
          <p className={cx("text-sm text-center", error ? "text-bad" : "text-muted")}>{error ?? "Loading…"}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-center gap-3.5">
            <span className="size-[60px] rounded-xl bg-chip grid place-items-center text-ink/85" aria-hidden>
              <Globe size={28} strokeWidth={1.8} />
            </span>
            <ArrowRight size={22} className="text-faint" aria-hidden />
            <WispGhost size={60} className="text-ink" />
            <span className="sr-only">Wisp</span>
          </div>
          <div className="text-center space-y-1.5">
            <h1 className="t-title">Let {info.client} act as an agent?</h1>
            <p className="text-[15px] text-muted">Pick the agent it acts as.</p>
          </div>
          <div className="rounded-3xl bg-card overflow-hidden divide-y divide-line" role="radiogroup">
            {agents.map((a) => (
              <label key={a.id} className="flex items-center gap-3.5 px-[18px] min-h-14 cursor-pointer hover:bg-hover">
                <input type="radio" name="agent" className="sr-only" checked={pick === a.id} onChange={() => setPick(a.id)} />
                <AgentAvatar agent={a} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium truncate">{a.name}</span>
                  <span className="block text-xs text-muted truncate">@{a.handle}</span>
                </span>
                {pick === a.id && (
                  <span className="size-6 rounded-full bg-badge text-badge-ink grid place-items-center" aria-hidden>
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
              </label>
            ))}
            <label className="block px-[18px] py-3 min-h-14 cursor-pointer hover:bg-hover space-y-2">
              <span className="flex items-center gap-3.5 min-h-10">
                <input type="radio" name="agent" className="sr-only" checked={pick === NEW} onChange={() => setPick(NEW)} />
                <span className="size-[38px] rounded-xl bg-chip grid place-items-center text-ink/85" aria-hidden>
                  <Plus size={20} />
                </span>
                <span className="flex-1 text-[15px] font-medium">New agent</span>
                {pick === NEW && (
                  <span className="size-6 rounded-full bg-badge text-badge-ink grid place-items-center" aria-hidden>
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
              </span>
              {pick === NEW && <AuthInput value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" maxLength={80} className="h-12 text-[15px] rounded-2xl bg-panel" />}
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-bad text-center">
              {error}
            </p>
          )}
          <div className="flex flex-col items-center gap-1.5">
            <AuthButton disabled={busy} onClick={() => finish(true)}>
              Allow
            </AuthButton>
            <AuthLink disabled={busy} onClick={() => finish(false)}>
              Deny
            </AuthLink>
          </div>
          <p className="text-xs text-faint text-center">Returns to {info.returnsTo}</p>
        </div>
      )}
    </AuthPage>
  );
}
