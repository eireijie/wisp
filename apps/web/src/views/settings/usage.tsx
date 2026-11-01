import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { AgentAvatar, cx } from "../../components/ui.tsx";

type Range = "today" | "7d" | "30d";

/** What GET /api/usage returns. */
interface Usage {
  range: Range;
  tz: string;
  buckets: { start: string; chat: number; background: number }[];
  totals: { tokens: number; runs: number; failed: number; estimated: boolean };
  previousTokens: number;
  agents: { agentId: string; tokens: number; runs: number }[];
  models: { model: string; tokens: number }[];
  background: { todayTokens: number; dailyTokens: number | null; resetsAt: string };
}

const RANGES: [Range, string][] = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];
const VS: Record<Range, string> = { today: "yesterday", "7d": "last week", "30d": "last month" };
const LIMITS: { key: string; label: string; tokens: number | null }[] = [
  { key: "300k", label: "300k", tokens: 300_000 },
  { key: "1M", label: "1M", tokens: 1_000_000 },
  { key: "3M", label: "3M", tokens: 3_000_000 },
  { key: "none", label: "No limit", tokens: null },
];
const MIN_LIMIT = 10_000;
const MAX_LIMIT = 1_000_000_000;
const CHAT_SHADE = "var(--accent)";
const OWN_SHADE = "color-mix(in oklab, var(--accent) 45%, var(--card))";

/** 340k, 1.6M, 2B; small numbers stay as they are */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const fmt = (v: number, unit: string) => `${v >= 10 ? Math.round(v) : +v.toFixed(1)}${unit}`;
  if (n < 999_500) return fmt(n / 1000, "k");
  if (n < 999_500_000) return fmt(n / 1_000_000, "M");
  return fmt(n / 1_000_000_000, "B");
}

/** "500000", "500k", "2M", "1.5m" → a number, or null when it isn't one */
export function parseTokens(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([kmb]?)\s*$/i.exec(text.replace(/,(?=\d{3}\b)/g, ""));
  if (!m) return null;
  const n = Number(m[1].replace(",", ".")) * ({ "": 1, k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()];
  return Number.isFinite(n) ? Math.round(n) : null;
}

const cityOf = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");

function untilText(iso: string, now: number): string {
  const mins = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}

function deltaText(total: number, previous: number, range: Range): string {
  if (previous === 0) return total === 0 ? "No tokens yet" : `Nothing before, vs ${VS[range]}`;
  const pct = Math.round(((total - previous) / previous) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}% vs ${VS[range]}`;
}

/** Axis labels for each bar: sparse hours, weekdays, or sparse dates. */
function labelsFor(u: Usage): string[] {
  const n = u.buckets.length;
  const fmt = (o: Intl.DateTimeFormatOptions, iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: u.tz, ...o }).format(new Date(iso));
  return u.buckets.map((b, i) => {
    if (u.range === "today") {
      if (i % 4) return "";
      const h = i;
      return h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
    }
    if (i === n - 1) return "Today";
    if (u.range === "7d") return fmt({ weekday: "short" }, b.start);
    return (n - 1 - i) % 5 === 0 ? fmt({ month: "short", day: "numeric" }, b.start) : "";
  });
}

const card = "rounded-xl bg-card border border-line";

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className={cx(card, "px-4 py-3.5 min-w-0")}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight truncate">{children}</div>
      {sub}
    </div>
  );
}

/** A row of equal buttons, one picked. */
function Seg({ value, options, onChange, label, className }: { value: string; options: { key: string; label: string }[]; onChange: (k: string) => void; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("flex gap-0.5 p-0.5 rounded-lg border border-line bg-control", className)}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          onClick={() => onChange(o.key)}
          className={cx("flex-1 h-7 px-2.5 rounded-md text-[13px] whitespace-nowrap transition-colors", value === o.key ? "bg-hover text-ink font-semibold" : "text-muted font-medium hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chart({ u }: { u: Usage }) {
  const limit = u.range !== "today" ? u.background.dailyTokens : null;
  const labels = labelsFor(u);
  const peak = Math.max(1, limit ?? 0, ...u.buckets.map((b) => b.chat + b.background));
  const gap = u.buckets.length <= 7 ? "gap-3 sm:gap-[18px]" : u.buckets.length <= 24 ? "gap-1 sm:gap-1.5" : "gap-[3px] sm:gap-1";
  const pct = (v: number) => `${(v / peak) * 100}%`;
  const when = (iso: string, i: number) =>
    u.range === "today"
      ? new Intl.DateTimeFormat("en-US", { timeZone: u.tz, hour: "numeric" }).format(new Date(iso))
      : i === u.buckets.length - 1
        ? "Today"
        : new Intl.DateTimeFormat("en-US", { timeZone: u.tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  return (
    <div className={cx(card, "px-[18px] py-4")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold">{u.range === "today" ? "Tokens per hour" : "Tokens per day"}</h3>
        <div className="flex gap-3.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: CHAT_SHADE }} />
            Chats and tasks
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: OWN_SHADE }} />
            On their own
          </span>
        </div>
      </div>
      <div className={cx("relative h-[200px] mt-4 flex items-end border-b border-line", gap)}>
        {limit !== null && (
          <>
            <div className="absolute inset-x-0 border-t border-dashed border-faint/60 pointer-events-none" style={{ bottom: pct(limit) }} />
            <div className="absolute right-0 text-[11px] text-faint pointer-events-none" style={{ bottom: `calc(${pct(limit)} + 4px)` }}>
              Daily limit for on their own
            </div>
          </>
        )}
        {u.buckets.map((b, i) => (
          <div
            key={b.start}
            className="flex-1 min-w-0 h-full flex flex-col justify-end"
            title={`${when(b.start, i)}: ${compact(b.chat + b.background)} (chats and tasks ${compact(b.chat)}, on their own ${compact(b.background)})`}
          >
            <div style={{ height: pct(b.chat), background: CHAT_SHADE }} className="rounded-t-[3px]" />
            <div style={{ height: pct(b.background), background: OWN_SHADE }} className={b.chat === 0 ? "rounded-t-[3px]" : ""} />
          </div>
        ))}
      </div>
      <div className={cx("flex mt-1.5", gap)}>
        {labels.map((l, i) => (
          <div key={i} className="flex-1 min-w-0 relative h-4">
            <span className="absolute left-1/2 -translate-x-1/2 text-[11px] text-faint whitespace-nowrap tabular-nums">{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LimitCard({ current, onSave }: { current: number | null; onSave: (tokens: number | null) => Promise<void> }) {
  const preset = LIMITS.find((l) => l.tokens === current);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState(current ? String(current) : "");
  const [error, setError] = useState<string | null>(null);
  const showCustom = custom || !preset;
  useEffect(() => {
    if (!custom) setText(current ? String(current) : "");
  }, [current, custom]);
  const run = async (tokens: number | null) => {
    setError(null);
    try {
      await onSave(tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const commit = () => {
    const n = parseTokens(text);
    if (n === null || n < MIN_LIMIT || n > MAX_LIMIT) {
      setError("Enter a number from 10k to 1B, like 500k or 2M.");
      return;
    }
    if (n !== current) void run(n);
    else setError(null);
  };
  return (
    <div className={cx(card, "px-[18px] py-3.5")}>
      <h3 className="text-sm font-semibold">Daily limit when working on their own</h3>
      <Seg
        className="mt-3"
        label="Daily limit"
        value={showCustom ? "custom" : (preset?.key ?? "")}
        options={[...LIMITS, { key: "custom", label: "Custom" }]}
        onChange={(k) => {
          if (k === "custom") {
            setCustom(true);
            return;
          }
          setCustom(false);
          void run(LIMITS.find((l) => l.key === k)!.tokens);
        }}
      />
      {showCustom && (
        <label className="mt-2.5 flex items-center gap-2 text-[13px] text-muted">
          Tokens a day
          <input
            value={text}
            inputMode="text"
            placeholder="500k"
            aria-label="Tokens a day"
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), undefined)}
            className="flex-1 min-w-0 h-8 rounded-md border border-control-line bg-control px-2.5 text-[13px] text-right text-ink tabular-nums"
          />
        </label>
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <p className="mt-2.5 text-xs text-faint">At 80% agents slow down. At the limit they wait for the reset.</p>
    </div>
  );
}

/** Settings → Usage: what your agents used, who used it, and the daily limit for work they do on their own. */
export function UsagePage() {
  const agents = useStore((s) => s.agents);
  const backgroundVersion = useStore((s) => s.backgroundVersion);
  // changes when an agent starts or finishes working, so the page catches up when a run ends
  const busy = useStore((s) => s.agents.filter((a) => a.status === "busy").map((a) => a.id).join(","));
  const [range, setRange] = useState<Range>("7d");
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const u = await api<Usage>("GET", `/api/usage?range=${range}`);
      if (mine !== seq.current) return;
      setData(u);
      setError(null);
      setNow(Date.now());
    } catch (e) {
      if (mine !== seq.current) return;
      setError((e as Error).message || "Couldn't load usage");
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // a background change or a run starting/ending: refresh shortly (several often arrive together)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(), 800);
    return () => clearTimeout(t);
  }, [backgroundVersion, busy, load]);

  // and once a minute while the page is showing
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const saveLimit = async (dailyTokens: number | null) => {
    await api("PUT", "/api/background/allowance", { dailyTokens });
    await load();
  };

  const header = (
    <div className="flex items-end justify-between gap-4">
      <h2 className="t-title max-md:hidden">Usage</h2>
      <Seg label="Range" value={range} options={RANGES.map(([key, label]) => ({ key, label }))} onChange={(k) => setRange(k as Range)} className="w-[220px] max-w-[60%]" />
    </div>
  );

  if (!data || data.range !== range) {
    return (
      <div className="space-y-5 max-w-5xl">
        {header}
        {error ? (
          <div className={cx(card, "px-[18px] py-6 flex flex-col items-start gap-3")}>
            <p className="text-sm text-bad">Couldn't load usage. {error}</p>
            <button type="button" onClick={() => void load()} className="h-8 px-3.5 rounded-md border border-line text-[13px] font-medium hover:bg-hover">
              Retry
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    );
  }

  const { totals, background: bg } = data;
  const about = totals.estimated ? <span className="mr-1 text-sm font-medium text-muted">about</span> : null;
  const share = bg.dailyTokens ? Math.min(100, (bg.todayTokens / bg.dailyTokens) * 100) : 0;
  const topModel = Math.max(1, ...data.models.map((m) => m.tokens));
  const agentRows = data.agents.map((a) => ({ ...a, agent: agents.find((g) => g.id === a.agentId) }));
  const grid = "grid grid-cols-[minmax(0,1fr)_40px_60px_40px] sm:grid-cols-[minmax(0,1fr)_70px_90px_60px] gap-x-3 px-4 sm:px-[18px]";

  return (
    <div className="space-y-5 max-w-5xl">
      {header}
      {error && (
        <div className="flex items-center gap-3 text-xs text-bad">
          Couldn't refresh.
          <button type="button" onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Tokens" sub={<div className="mt-1 text-xs text-muted truncate">{deltaText(totals.tokens, data.previousTokens, range)}</div>}>
          {about}
          {compact(totals.tokens)}
        </Stat>
        <Stat label="Runs" sub={<div className="mt-1 text-xs text-muted">{totals.failed ? `${totals.failed} failed` : "None failed"}</div>}>
          {totals.runs.toLocaleString()}
        </Stat>
        <Stat
          label="On their own today"
          sub={
            bg.dailyTokens ? (
              <div className="mt-2.5 h-1 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={Math.round(share)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full" style={{ width: `${share}%`, background: CHAT_SHADE }} />
              </div>
            ) : null
          }
        >
          {compact(bg.todayTokens)}
          {bg.dailyTokens ? <span className="ml-1.5 text-sm font-medium text-faint">/ {compact(bg.dailyTokens)}</span> : null}
        </Stat>
        <Stat label="Resets" sub={<div className="mt-1 text-xs text-muted truncate">Midnight, {cityOf(data.tz)}</div>}>
          {untilText(bg.resetsAt, now)}
        </Stat>
      </div>

      <Chart u={data} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3 items-start">
        <div className={cx(card, "overflow-hidden")}>
          <div className={cx(grid, "py-3 text-xs text-faint border-b border-line")}>
            <span>Agent</span>
            <span className="text-right">Runs</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Share</span>
          </div>
          {agentRows.length === 0 && <p className="px-[18px] py-4 text-sm text-muted">Nothing yet in this time.</p>}
          {agentRows.map((r) => (
            <div key={r.agentId} className={cx(grid, "h-11 items-center text-sm tabular-nums border-b border-line last:border-b-0")}>
              <span className="flex items-center gap-2.5 min-w-0">
                <AgentAvatar agent={r.agent ?? { name: "Deleted agent", harness: "custom" }} size={22} badge={false} interactive={false} />
                <span className="truncate">{r.agent?.name ?? "Deleted agent"}</span>
              </span>
              <span className="text-right text-muted">{r.runs.toLocaleString()}</span>
              <span className="text-right">{compact(r.tokens)}</span>
              <span className="text-right text-muted">{totals.tokens ? `${Math.round((r.tokens / totals.tokens) * 100)}%` : "0%"}</span>
            </div>
          ))}
        </div>

        <div className="space-y-3 min-w-0">
          <div className={cx(card, "px-[18px] py-3.5")}>
            <h3 className="text-sm font-semibold mb-2.5">By model</h3>
            {data.models.length === 0 && <p className="text-sm text-muted">Nothing yet in this time.</p>}
            {data.models.map((m) => (
              <div key={m.model} className="py-1.5 space-y-1.5">
                <div className="flex justify-between gap-3 text-[13px]">
                  <span className="truncate">{m.model}</span>
                  <span className="text-muted tabular-nums shrink-0">{compact(m.tokens)}</span>
                </div>
                <div className="h-1 rounded-full bg-line overflow-hidden">
                  <div className="h-full" style={{ width: `${(m.tokens / topModel) * 100}%`, background: CHAT_SHADE } as CSSProperties} />
                </div>
              </div>
            ))}
          </div>
          <LimitCard current={bg.dailyTokens} onSave={saveLimit} />
        </div>
      </div>
    </div>
  );
}
