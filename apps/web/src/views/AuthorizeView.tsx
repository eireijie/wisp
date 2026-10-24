import { useEffect, useState } from "react";
import type { Agent } from "@warren/core";
import { api } from "../api.ts";
import { AgentAvatar, Button, GhostMark, Input, cx } from "../components/ui.tsx";

const NEW = "new";

/** A handle for a new agent named after the app ("Grok" → @grok, then @grok-2…). */
export function handleFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 28) || "app";
  let h = base;
  for (let i = 2; taken.includes(h); i++) h = `${base}-${i}`;
  return h;
}

/**
 * An app connecting to Warren by URL (Grok, ChatGPT, Claude…) signs in here: the person picks
 * which agent it acts as, or makes one for it, and is sent back to the app.
 */
export function AuthorizeView({ requestId }: { requestId: string }) {
  const [info, setInfo] = useState<{ client: string; returnsTo: string } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pick, setPick] = useState<string>(NEW);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      .catch((e) => setError(e.message));
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
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-panel flex items-center px-6 sm:px-8 py-10 safe-top">
      <div className="w-full max-w-sm mx-auto space-y-6">
        <div className="flex items-center gap-1.5 font-semibold">
          <GhostMark size={18} className="text-accent-text" /> Warren
        </div>
        {!info ? (
          <p className={cx("text-sm", error ? "text-bad" : "text-muted")}>{error ?? "Loading…"}</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold">Connect {info.client}</h1>
              <p className="text-sm text-muted">Pick the agent it acts as.</p>
            </div>
            <div className="space-y-1.5" role="radiogroup">
              {agents.map((a) => (
                <label key={a.id} className={cx("flex items-center gap-3 rounded-xl border px-3 py-2 cursor-pointer", pick === a.id ? "border-ring bg-hover" : "border-line hover:bg-hover")}>
                  <input type="radio" name="agent" className="sr-only" checked={pick === a.id} onChange={() => setPick(a.id)} />
                  <AgentAvatar agent={a} size={28} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{a.name}</span>
                    <span className="block text-xs text-muted truncate">@{a.handle}</span>
                  </span>
                </label>
              ))}
              <label className={cx("block rounded-xl border px-3 py-2 cursor-pointer space-y-2", pick === NEW ? "border-ring bg-hover" : "border-line hover:bg-hover")}>
                <span className="flex items-center gap-3">
                  <input type="radio" name="agent" className="sr-only" checked={pick === NEW} onChange={() => setPick(NEW)} />
                  <span className="text-sm font-medium">New agent</span>
                </span>
                {pick === NEW && <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" maxLength={80} />}
              </label>
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="space-y-2">
              <Button variant="primary" className="w-full h-10" disabled={busy} onClick={() => finish(true)}>
                Allow
              </Button>
              <Button variant="ghost" className="w-full" disabled={busy} onClick={() => finish(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-faint">Returns to {info.returnsTo}</p>
          </>
        )}
      </div>
    </div>
  );
}
