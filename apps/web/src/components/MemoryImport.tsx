import { useEffect, useMemo, useRef, useState } from "react";
import { harnessLabel } from "@wisp/core";
import { memoryPrompt, parseMemoryAnswer, type MemoryLine } from "@wisp/core/src/memory-import.ts";
import { api } from "../api.ts";
import { Spinner, Tick } from "./SetupShell.tsx";

/** A harness on one of the person's devices that Wisp can ask for them. */
export interface Askable {
  harness: string;
  nodeId: string;
  device: string;
}

type Phase = { at: "choose" } | { at: "asking"; harness: string } | { at: "paste" } | { at: "review"; from: string };

/**
 * Bring what your AI already knows: Wisp asks Claude Code or Codex on your computer one question
 * (with your OK, reading only its answer), or you copy the prompt into any other app and paste the
 * reply back. The answer becomes a list you tick through; lines marked (unsure) start unticked and
 * lines that look like a secret never show. `onSave` gets the ticked lines.
 */
export function MemoryImport({ agentName, askable, saveLabel, skipLabel, onSave, onSkip, busy }: { agentName: string; askable: Askable[]; saveLabel: string; skipLabel?: string; onSave: (lines: MemoryLine[]) => void; onSkip?: () => void; busy?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ at: "choose" });
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const parsed = useMemo(() => parseMemoryAnswer(answer), [answer]);
  const [off, setOff] = useState<Set<number>>(new Set());
  const alive = useRef(true);
  useEffect(() => {
    // set again on mount: React's dev double-mount runs the cleanup once in between
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const review = (text: string, from: string) => {
    const p = parseMemoryAnswer(text);
    setAnswer(text);
    setOff(new Set(p.lines.flatMap((l, i) => (l.unsure ? [i] : []))));
    if (!p.lines.length) {
      setError(p.dropped ? "Everything in that answer looked private, so nothing was kept." : "That answer had nothing Wisp could read. Paste the whole reply, with its headings.");
      return;
    }
    setError(null);
    setPhase({ at: "review", from });
  };

  const ask = async (a: Askable) => {
    setError(null);
    setPhase({ at: "asking", harness: a.harness });
    try {
      const { id } = await api<{ id: string }>("POST", "/api/memory-prompt/ask", { nodeId: a.nodeId, harness: a.harness });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        const r = await api<{ status: "running" | "done" | "failed"; answer?: string; error?: string }>("GET", `/api/memory-prompt/ask/${id}`);
        if (r.status === "running") continue;
        if (r.status === "failed") throw new Error(r.error ?? `${harnessLabel(a.harness)} didn't answer`);
        return review(r.answer ?? "", harnessLabel(a.harness));
      }
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
      setPhase({ at: "choose" });
    }
  };

  const copy = async () => {
    // a one-time link an agent can send its answer to, when this Wisp can make one
    const l = link ?? (await api<{ id: string; url: string }>("POST", "/api/memory-links").catch(() => null));
    if (l) setLink(l);
    try {
      await navigator.clipboard.writeText(memoryPrompt(l?.url));
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the prompt and copy it.");
    }
    setPhase({ at: "paste" });
  };

  // an agent that posts to the one-time link fills the box for you
  useEffect(() => {
    if (phase.at !== "paste" || !link) return;
    const t = setInterval(async () => {
      const r = await api<{ answer: string | null; expired: boolean }>("GET", `/api/memory-links/${link.id}`).catch(() => null);
      if (r?.answer) {
        clearInterval(t);
        review(r.answer, "your agent");
      } else if (r?.expired) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [phase.at, link?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const kept = parsed.lines.filter((_, i) => !off.has(i));
  const first = askable[0];
  return (
    <>
      {phase.at === "choose" && (
        <div className="ob-rise flex flex-col gap-2.5">
          {first && (
            <div className="ob-choice ob-main-choice">
              <div className="flex flex-1 flex-col gap-1">
                <span className="ob-name">Ask {harnessLabel(first.harness)} for me</span>
                <span className="ob-sub">Found on {first.device}. Wisp asks it one question and reads only its answer.</span>
              </div>
              <button type="button" className="ob-b ob-p" onClick={() => void ask(first)}>
                Ask it
              </button>
            </div>
          )}
          {askable.slice(1).map((a) => (
            <div key={`${a.nodeId}:${a.harness}`} className="ob-choice">
              <div className="flex flex-1 flex-col gap-1">
                <span className="ob-name">Ask {harnessLabel(a.harness)} for me</span>
                <span className="ob-sub">Found on {a.device}.</span>
              </div>
              <button type="button" className="ob-b" onClick={() => void ask(a)}>
                Ask it
              </button>
            </div>
          ))}
          <div className={first ? "ob-choice" : "ob-choice ob-main-choice"}>
            <div className="flex flex-1 flex-col gap-1">
              <span className="ob-name">Use another app</span>
              <span className="ob-sub">ChatGPT, Grok, Gemini or any agent. Copy the prompt, paste the answer back.</span>
            </div>
            <button type="button" className={first ? "ob-b" : "ob-b ob-p"} onClick={() => void copy()}>
              Copy prompt
            </button>
          </div>
        </div>
      )}

      {phase.at === "paste" && (
        <div className="ob-card ob-rise">
          <div className="ob-row" style={{ paddingBottom: 10 }}>
            <span className="flex-1 text-[13.5px] font-semibold">{copied ? "Prompt copied. Paste it into the other app, then paste its answer here." : "Copy this prompt into the other app, then paste its answer here."}</span>
            <button type="button" className="ob-b" onClick={() => void copy()}>
              {copied ? "Copy again" : "Copy prompt"}
            </button>
          </div>
          {!copied && <pre className="ob-mono mx-[18px] mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-card p-3 text-[12px] text-muted select-all">{memoryPrompt(link?.url)}</pre>}
          <div className="px-[18px] pb-4 flex flex-col gap-2.5">
            <textarea className="ob-paste" placeholder="Paste the answer here" aria-label="The other app's answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            {link && <span className="ob-note">An agent that can open links can send it to the one-time link in the prompt instead; it shows up here.</span>}
            <div className="flex justify-end">
              <button type="button" className="ob-b ob-p" disabled={!answer.trim()} onClick={() => review(answer, "the answer")}>
                Read answer
              </button>
            </div>
          </div>
        </div>
      )}

      {(phase.at === "asking" || phase.at === "review") && (
        <div className="ob-card">
          <div className="ob-row" style={{ padding: "14px 18px" }}>
            {phase.at === "asking" ? <Spinner /> : <Tick />}
            <span className="flex-1 text-[13.5px] font-semibold">{phase.at === "asking" ? `${harnessLabel(phase.harness)} is writing down what it knows…` : `Here's what ${agentName} will know. Untick anything to leave out.`}</span>
            {phase.at === "review" && <span className="ob-note">From {phase.from}</span>}
          </div>
          <div className="ob-rule flex min-h-[120px] max-h-[min(52vh,520px)] overflow-y-auto flex-col py-1.5">
            {phase.at === "asking" && (
              <p className="ob-sub px-[18px] py-3">
                This can take a few minutes. <span className="ob-dots" aria-hidden><span /><span /><span /></span>
              </p>
            )}
            {phase.at === "review" &&
              parsed.lines.map((l, i) => (
                <div key={i}>
                  {(i === 0 || parsed.lines[i - 1].heading !== l.heading) && <div className="ob-mem-group">{l.heading}</div>}
                  <label className="ob-mem" style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                    <input
                      type="checkbox"
                      checked={!off.has(i)}
                      onChange={(e) => {
                        const next = new Set(off);
                        if (e.target.checked) next.delete(i);
                        else next.add(i);
                        setOff(next);
                      }}
                    />
                    <span className="flex-1">{l.text}</span>
                    {l.unsure && <span className="ob-mem-kind">unsure</span>}
                  </label>
                </div>
              ))}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}

      <div className="ob-foot">
        <span className="ob-note">{phase.at === "review" ? (parsed.dropped ? `${parsed.dropped} private ${parsed.dropped === 1 ? "line" : "lines"} left out.` : "") : `Stays in ${agentName}'s memory. You can edit it any time.`}</span>
        {phase.at === "paste" && (
          <button type="button" className="ob-b ob-q" onClick={() => setPhase({ at: "choose" })}>
            Back
          </button>
        )}
        {onSkip && (
          <button type="button" className="ob-b ob-q" onClick={onSkip} disabled={busy}>
            {phase.at === "review" ? "Skip" : (skipLabel ?? "Skip for now")}
          </button>
        )}
        {phase.at === "review" && (
          <button type="button" className="ob-b ob-p ob-pop" disabled={!kept.length || busy} onClick={() => onSave(kept)}>
            {saveLabel}
          </button>
        )}
      </div>
    </>
  );
}
