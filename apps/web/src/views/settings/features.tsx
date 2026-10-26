import { useState, type ReactNode } from "react";
import { Bell, CircleDot, Clock, Ghost, ListChecks, MonitorSmartphone, Phone, UserPlus } from "lucide-react";
import { FEATURE_INFO, FEATURE_KEYS, type FeatureKey, type Features } from "@wisp/core";
import { useStore } from "../../store.ts";
import { setFeatures, useFeatures } from "../../features.ts";
import { AskAgent } from "../../components/AskAgent.tsx";
import { Button, cx } from "../../components/ui.tsx";

const ICONS: Record<FeatureKey, ReactNode> = {
  background: <Bell size={18} />,
  routines: <Clock size={18} />,
  teach: <CircleDot size={18} />,
  tasks: <ListChecks size={18} />,
  voice: <Phone size={18} />,
  buddy: <Ghost size={18} />,
  invite: <UserPlus size={18} />,
  remoteDesktop: <MonitorSmartphone size={18} />,
};

/**
 * Mods: the optional parts of Wisp, switched on or off for the whole organization. Owners
 * change them (or ask an agent to); everyone else can see them.
 */
export function ModsPage() {
  const features = useFeatures();
  const isOwner = useStore((s) => s.me?.role) === "owner";
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: Partial<Features>) => {
    setError(null);
    try {
      await setFeatures(patch);
    } catch (e) {
      setError(`Couldn't save that: ${(e as Error).message}`);
    }
  };

  const on = FEATURE_KEYS.filter((k) => features[k]);
  const off = FEATURE_KEYS.filter((k) => !features[k]);
  const card = (k: FeatureKey, control: ReactNode) => (
    <div key={k} className="rounded-2xl border border-line p-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="size-9 shrink-0 rounded-lg bg-chip text-ink/80 grid place-items-center" aria-hidden>
          {ICONS[k]}
        </span>
        <span className="flex-1 min-w-0 text-body font-medium">{FEATURE_INFO[k].name}</span>
        {control}
      </div>
      <p className="text-sm leading-snug text-ink/75">{FEATURE_INFO[k].description}</p>
    </div>
  );

  return (
    <div className="space-y-8">
      <h2 className="t-title">Mods</h2>
      {isOwner ? <AskAgent placeholder={`Ask {name}, like "turn on voice calls"`} /> : <p className="text-sm text-muted">Only owners can turn mods on or off.</p>}
      {on.length > 0 && (
        <section className="space-y-2.5" aria-labelledby="mods-on">
          <h3 id="mods-on" className="text-body font-semibold text-muted">
            On
          </h3>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">{on.map((k) => card(k, <Switch on label={FEATURE_INFO[k].name} disabled={!isOwner} onChange={(v) => save({ [k]: v })} />))}</div>
        </section>
      )}
      {off.length > 0 && (
        <section className="space-y-2.5" aria-labelledby="mods-more">
          <h3 id="mods-more" className="text-body font-semibold text-muted">
            More mods
          </h3>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">
            {off.map((k) =>
              card(
                k,
                <Button className="h-8 px-3.5 text-[13px]" disabled={!isOwner} onClick={() => save({ [k]: true })}>
                  Add
                </Button>,
              ),
            )}
          </div>
        </section>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("shrink-0 w-[46px] h-7 rounded-full p-[3px] flex transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-3 focus-visible:ring-ring/40", on ? "bg-accent" : "bg-input")}
    >
      <span className={cx("m-knob size-[22px] rounded-full shadow", on ? "bg-accent-ink translate-x-[18px]" : "bg-white")} />
    </button>
  );
}
