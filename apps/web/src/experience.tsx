import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { usePrefs, useStore } from "./store.ts";

/**
 * Simple or Advanced: how much of Wisp a person sees. Simple keeps advanced setup (teams,
 * harness details, VM sizes, tokens, raw files) behind "Advanced" disclosures; Advanced shows it
 * all. Picked during onboarding and in Settings → App behavior; stored in the person's prefs.
 */
export type Experience = "simple" | "advanced";

export function useExperience(): Experience {
  return usePrefs().experience;
}

/** True when the person chose Simple. */
export function useSimple(): boolean {
  return useExperience() === "simple";
}

export async function setExperience(experience: Experience) {
  await useStore.getState().setPrefs({ experience });
}

/**
 * Something only Advanced people see outright. In Simple it's folded under a small "Advanced"
 * disclosure (default), or left out entirely with `hide`. Use `title` to say what's inside, e.g.
 * "Advanced: VM size and resources".
 */
export function Advanced({ children, hide, title = "Advanced", className }: { children: ReactNode; hide?: boolean; title?: string; className?: string }) {
  const simple = useSimple();
  const [open, setOpen] = useState(false);
  if (!simple) return <>{children}</>;
  if (hide) return null;
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        <ChevronRight size={14} className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden />
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Something only Simple people see: a plain explanation, a shortcut, a recommended choice. */
export function SimpleOnly({ children }: { children: ReactNode }) {
  return useSimple() ? <>{children}</> : null;
}
