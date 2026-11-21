import { ChevronLeft } from "lucide-react";
import { NEW_TRACK, Track, useEscBack } from "../SetupShell.tsx";

/** A first-run page's top bar: Back (Esc does it too) on the left, the same dots as the pages before it in the middle. */
export function PageTop({ step, onBack }: { step: number; onBack?: (() => void) | null }) {
  useEscBack(onBack);
  return (
    <div className="ob-top safe-top shrink-0">
      <div className="ob-back-slot">
        {onBack && (
          <button type="button" className="ob-back" aria-label="Back" onClick={onBack}>
            <ChevronLeft size={17} />
          </button>
        )}
      </div>
      <Track at={step} track={NEW_TRACK} />
      <div className="ob-back-slot" />
    </div>
  );
}
