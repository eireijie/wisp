import { useState } from "react";
import { useStore } from "../../store.ts";
import { ALLOWANCE_LEVELS, tokensText, useAllowance } from "../../changes.ts";
import { AgentAvatar, agentColor, cx } from "../../components/ui.tsx";

/** Settings → Usage: one daily allowance for everything your agents do on their own, and who used what today. */
export function UsagePage() {
  const agents = useStore((s) => s.agents);
  const [a, save] = useAllowance();
  const [error, setError] = useState<string | null>(null);
  if (!a) return <p className="text-sm text-muted">Loading…</p>;
  const pick = async (tokens: number | null) => {
    setError(null);
    try {
      await save(tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const total = a.dailyTokens ?? Math.max(a.todayTokens, 1);
  return (
    <div className="space-y-9 max-w-2xl">
      <h2 className="text-2xl font-extrabold">Usage</h2>

      <section className="space-y-3.5">
        <p className="text-xl font-semibold">Agents working on their own can use up to</p>
        <div role="radiogroup" aria-label="Daily allowance" className="flex flex-wrap gap-2">
          {ALLOWANCE_LEVELS.map((l) => {
            const on = a.dailyTokens === l.tokens;
            return (
              <button
                key={l.label}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => void pick(l.tokens)}
                className={cx("h-11 min-w-20 px-4 rounded-full border text-[15px] font-extrabold transition-colors", on ? "bg-accent text-accent-ink border-transparent" : "border-line hover:bg-hover")}
              >
                {l.tokens ? `${l.label} · ${tokensText(l.tokens)}` : l.label}
              </button>
            );
          })}
          {a.dailyTokens !== null && !ALLOWANCE_LEVELS.some((l) => l.tokens === a.dailyTokens) && (
            <span role="radio" aria-checked className="h-11 px-4 rounded-full bg-accent text-accent-ink text-[15px] font-extrabold inline-flex items-center">
              {tokensText(a.dailyTokens)}
            </span>
          )}
        </div>
        <p className="text-xl font-semibold">tokens a day.</p>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h3 className="flex-1 text-[17px] font-extrabold">Today</h3>
          <span className="text-sm font-bold text-muted">
            {a.estimated && "about "}
            {tokensText(a.todayTokens)}
            {a.dailyTokens ? ` of ${tokensText(a.dailyTokens)}` : ""}
          </span>
        </div>
        <div className="h-3.5 rounded-full bg-chip flex overflow-hidden" aria-hidden>
          {a.agents.map((x) => (
            <span key={x.agentId} className="block h-full" style={{ width: `${Math.min(100, (x.tokens / total) * 100)}%`, background: agentColor(agents.find((g) => g.id === x.agentId)) }} />
          ))}
        </div>
        {a.agents.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet today.</p>
        ) : (
          <div>
            {a.agents.map((x) => {
              const agent = agents.find((g) => g.id === x.agentId);
              return (
                <div key={x.agentId} className="flex items-center gap-3 h-12 border-b border-line text-[15px]">
                  {agent && <AgentAvatar agent={agent} size={24} badge={false} />}
                  <span className="flex-1 font-bold truncate">{agent?.name ?? "An agent"}</span>
                  <span className="text-sm text-muted">
                    {x.checks} {x.checks === 1 ? "check" : "checks"}
                  </span>
                  <span className="w-14 text-right font-extrabold">{tokensText(x.tokens)}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-sm text-muted">Near the limit, agents check half as often. At the limit, they wait until tomorrow.</p>
      </section>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
