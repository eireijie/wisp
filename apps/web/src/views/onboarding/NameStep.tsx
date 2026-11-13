import { harnessLabel } from "@wisp/core";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { Ghost } from "../../components/Ghost.tsx";
import { StepHead } from "../../components/SetupShell.tsx";
import type { Powered } from "./ConnectStep.tsx";

/** Name your first agent: a name, its wisp, and the AI it runs on (one of those just connected). */
export function NameStep({ name, setName, look, ready, harness, setHarness, onBack, onNext }: { name: string; setName: (n: string) => void; look: GhostAppearance; ready: Powered[]; harness: string; setHarness: (h: string) => void; onBack: () => void; onNext: () => void }) {
  return (
    <>
      <StepHead title="Name your first agent" sub="It works for you around the clock, on its own computer. You can change its look later." />
      <form
        className="ob-card flex items-center gap-7 px-7 py-6 max-sm:flex-col max-sm:items-stretch max-sm:gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onNext();
        }}
      >
        <div className="ob-bob flex-none self-center">
          <Ghost look={look} size={112} label={`${name || "Your agent"}'s wisp`} />
        </div>
        <div className="flex flex-1 flex-col gap-3.5 min-w-0">
          <label htmlFor="agentName" className="text-[12.5px] font-semibold text-muted">
            Name
          </label>
          <input id="agentName" className="ob-bignm" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span>Runs on</span>
            {ready.length > 1 ? (
              <select className="ob-select" aria-label="Runs on" value={harness} onChange={(e) => setHarness(e.target.value)}>
                {ready.map((r) => (
                  <option key={r.harness} value={r.harness}>
                    {harnessLabel(r.harness)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="ob-select inline-flex items-center">{harnessLabel(harness)}</span>
            )}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
      <div className="ob-foot">
        <span />
        <button type="button" className="ob-b ob-q" onClick={onBack}>
          Back
        </button>
        <button type="button" className="ob-b ob-p" disabled={!name.trim()} onClick={onNext}>
          Continue
        </button>
      </div>
    </>
  );
}
