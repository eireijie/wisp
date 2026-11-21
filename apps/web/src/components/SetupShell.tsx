import { useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import type { GhostMood } from "./Ghost.tsx";
import { Ghost } from "./Ghost.tsx";
import { WHITE_WISP } from "./SetupStage.tsx";

/** The five steps after the account: connect, name, memory, setting up, meet. */
export const TRACK = ["Connect your AI", "Name your agent", "Bring your memory", "Set up", "Meet your agent"] as const;
/** A new setup's five pages: the old away and address screens, then Getting to know you, Make me yours, Its AI. */
export const NEW_TRACK = ["Away from home", "Your address", "Getting to know you", "Make me yours", "Its AI"] as const;

/**
 * First-run setup's frame: on the left the agent's wisp with one short line from it, at the top a
 * track of five dots (the current one stretched), and the step in the middle. `at` is 1–5 for
 * those steps, 0 before them (server, account, outside your home), where no dot is current yet.
 */
export function SetupShell({ at, track = TRACK, line, look, mood = "awake", stepKey, onBack, children }: { at: number; track?: readonly string[]; line: string; look?: GhostAppearance; mood?: GhostMood; stepKey: string; onBack?: (() => void) | null; children: ReactNode }) {
  useEscBack(onBack);
  return (
    <div className="ob-frame" data-testid="setup">
      <aside className="ob-side">
        <div className="ob-brand">
          <WispMark />
          <span>Wisp</span>
        </div>
        <div className="ob-ghost">
          <div>
            <Ghost look={look ?? WHITE_WISP} size={132} mood={mood} trackPointer label="" />
          </div>
          <p key={line} className="ob-line" aria-live="polite">
            {line}
          </p>
        </div>
      </aside>
      <main className="ob-main">
        <div className="ob-top">
          <div className="ob-back-slot">
            {onBack && (
              <button type="button" className="ob-back" aria-label="Back" onClick={onBack}>
                <ChevronLeft size={17} />
              </button>
            )}
          </div>
          <Track at={at} track={track} />
          <div className="ob-back-slot" />
        </div>
        <section key={stepKey} className="ob-step">
          {children}
        </section>
      </main>
    </div>
  );
}

/** Esc is Back too, unless it's closing something else (a dialog) or would throw away typing. */
export function useEscBack(onBack: (() => void) | null | undefined) {
  useEffect(() => {
    if (!onBack) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[role=dialog]")) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && (t as HTMLInputElement).value) return;
      onBack();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onBack]);
}

/** Five dots; the current one is a 28px pill, the ones done and current are ink. */
export function Track({ at, track = TRACK }: { at: number; track?: readonly string[] }) {
  return (
    <div role="progressbar" aria-label={at ? `Step ${at} of 5: ${track[at - 1]}` : "Getting started"} aria-valuemin={0} aria-valuemax={5} aria-valuenow={at} className="ob-track">
      {track.map((name, i) => (
        <span key={name} className="ob-dot" data-state={i + 1 === at ? "now" : i + 1 < at ? "done" : "later"} />
      ))}
    </div>
  );
}

function WispMark() {
  return (
    <svg width="18" height="20" viewBox="24 14 72 92" aria-hidden>
      <path d="M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z" fill="var(--ink)" />
      <ellipse cx="50" cy="54" rx="5" ry="6.5" fill="var(--app)" />
      <ellipse cx="70" cy="54" rx="5" ry="6.5" fill="var(--app)" />
    </svg>
  );
}

/** A step's heading and the line under it. */
export function StepHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="ob-head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

/** The green check that pops in. */
export function Tick({ size = 15 }: { size?: number }) {
  return (
    <svg className="ob-pop" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function Spinner({ size = 15 }: { size?: number }) {
  return (
    <svg className="ob-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
