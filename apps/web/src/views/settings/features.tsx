import { useState, type ReactNode } from "react";
import { Bell, CircleDot, Clock, Ghost, ListChecks, Phone, UserPlus, Users } from "lucide-react";
import { FEATURE_INFO, FEATURE_PRESETS, type FeatureKey, type Features } from "@warren/core";
import { useStore } from "../../store.ts";
import { FEATURE_GROUPS, featurePreset, featuresIn, setFeatures, useFeatures } from "../../features.ts";
import { cx } from "../../components/ui.tsx";
import { PageHeader } from "./parts.tsx";

const ICONS: Record<FeatureKey, ReactNode> = {
  background: <Bell size={18} />,
  routines: <Clock size={18} />,
  teach: <CircleDot size={18} />,
  teams: <Users size={18} />,
  tasks: <ListChecks size={18} />,
  voice: <Phone size={18} />,
  buddy: <Ghost size={18} />,
  invite: <UserPlus size={18} />,
};

/** Settings → Features: switch the optional parts of Warren on or off for the whole organization. Owners change them; everyone else can see them. */
export function FeaturesPage() {
  const features = useFeatures();
  const isOwner = useStore((s) => s.me?.role) === "owner";
  const [error, setError] = useState<string | null>(null);
  const preset = featurePreset(features);

  const save = async (patch: Partial<Features>) => {
    setError(null);
    try {
      await setFeatures(patch);
    } catch (e) {
      setError(`Couldn't save that: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <PageHeader title="Features">Turn on only what you use. Everything here is off until you want it, and you can change it any time.</PageHeader>
      <div className="space-y-7">
        {!isOwner && <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">Only owners can change which features are on.</p>}

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-bg px-4.5 py-4">
          <div className="min-w-[200px] flex-1">
            <div className="font-extrabold">Quick start</div>
            <div className="text-[13px] text-muted">Simple turns everything below off. Everything turns it all on.</div>
          </div>
          <div role="group" aria-label="Quick start" className="flex rounded-xl bg-chip p-[3px]">
            {(
              [
                ["simple", "Simple"],
                ["everything", "Everything"],
                ["custom", "Custom"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={preset === id}
                disabled={!isOwner || id === "custom"}
                onClick={() => id !== "custom" && save(FEATURE_PRESETS[id])}
                className={cx("h-[34px] px-4 rounded-[9px] text-[13px] font-bold transition-colors", preset === id ? "bg-panel shadow-sm text-ink" : "text-ink/70", isOwner && id !== "custom" && preset !== id && "hover:text-ink", "disabled:cursor-default")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {FEATURE_GROUPS.map((g) => (
          <section key={g.id} className="space-y-2" aria-labelledby={`fg-${g.id}`}>
            <h2 id={`fg-${g.id}`} className="text-[15px] font-extrabold text-ink/85">
              {g.title}
            </h2>
            <div className="rounded-2xl border border-line overflow-hidden divide-y divide-line">
              {featuresIn(g.id).map((k) => (
                <div key={k} className="flex items-center gap-4 px-4.5 py-3.5">
                  <span className="size-9 shrink-0 rounded-[11px] bg-chip text-ink/80 grid place-items-center" aria-hidden>
                    {ICONS[k]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-bold">{FEATURE_INFO[k].name}</div>
                    <div className="text-[13px] leading-snug text-muted">{FEATURE_INFO[k].description}</div>
                  </div>
                  <Switch on={features[k]} label={FEATURE_INFO[k].name} disabled={!isOwner} onChange={(on) => save({ [k]: on })} />
                </div>
              ))}
            </div>
          </section>
        ))}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
    </>
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
      className={cx("shrink-0 w-[46px] h-7 rounded-full p-[3px] flex transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-3 focus-visible:ring-ring/40", on ? "bg-accent justify-end" : "bg-input justify-start")}
    >
      <span className={cx("size-[22px] rounded-full shadow", on ? "bg-accent-ink" : "bg-white")} />
    </button>
  );
}
