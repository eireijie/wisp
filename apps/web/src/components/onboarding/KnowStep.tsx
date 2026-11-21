import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { motionReduced } from "../../theme.ts";
import { FACT_GROUPS, SCAN_PARTS } from "../../onboardingV3.ts";
import { IMPORT_APPS, addFacts, copyQuestion, dropFact, initKnow, pickApp, questionText, startScan, stillLearning, takeAnswer, useKnow } from "../../onboardingKnow.ts";
import { OnboardingGhost } from "./OnboardingGhost.tsx";
import { PageTop } from "./PageTop.tsx";
import { HOST_LOOK, HostGhost, OB_EASE, hostReact } from "./HostGhost.tsx";
import { useCountUp, useOneByOne } from "./obMotion.tsx";

const STYLE = `
@keyframes ob-pop { 0% { opacity: 0; transform: translateY(6px) scale(.96); } 100% { opacity: 1; transform: none; } }
.ob-pop { animation: ob-pop .32s cubic-bezier(.32,.72,0,1) both; }
@keyframes ob-hop-a { 0%,100% { transform: none; } 35% { transform: translateY(-10px) scale(.96,1.05); } 70% { transform: translateY(0) scale(1.06,.94); } }
@keyframes ob-hop-b { 0%,100% { transform: none; } 35% { transform: translateY(-10px) scale(.96,1.05); } 70% { transform: translateY(0) scale(1.06,.94); } }
.ob-hop-a { animation: ob-hop-a .5s cubic-bezier(.32,.72,0,1); }
.ob-hop-b { animation: ob-hop-b .5s cubic-bezier(.32,.72,0,1); }
@keyframes ob-page { 0% { opacity: 0; transform: translateX(40px); } 100% { opacity: 1; transform: none; } }
.ob-page { animation: ob-page .45s cubic-bezier(.32,.72,0,1) both; }
@keyframes ob-spin { to { transform: rotate(360deg); } }
.ob-spin3 { animation: ob-spin .9s linear infinite; transform-origin: center; }
.ob-btn { transition: transform .15s ease, background .15s ease; }
.ob-btn:active { transform: scale(.97); }
.ob-fact .ob-x { opacity: .45; }
.ob-fact:hover .ob-x, .ob-x:focus-visible { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .ob-pop, .ob-page, .ob-hop-a, .ob-hop-b, .ob-spin3 { animation: none; }
  .ob-btn { transition: none; }
  .ob-btn:active { transform: none; }
}`;

/** A finding that flies out of the host into place (it just appears under Reduce Motion). */
function FlyIn({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = document.querySelector<HTMLElement>('[data-testid="host-ghost"]');
    if (!el || !host || typeof el.animate !== "function" || motionReduced()) return;
    const from = host.getBoundingClientRect();
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height * 0.55 - (to.top + to.height / 2);
    el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 }, { opacity: 1, offset: 0.25 }, { transform: "none", opacity: 1 }], { duration: 560, easing: OB_EASE });
  }, []);
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}

const Check = () => (
  <span className="ob-pop w-[18px] h-[18px] rounded-full bg-ink flex items-center justify-center">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--panel)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12 5 5 9-10" />
    </svg>
  </span>
);

const card = "border border-[var(--line2)] rounded-[18px] p-5 flex flex-col gap-3.5 min-w-0";
const quiet = "ob-btn h-10 px-3.5 rounded-full text-muted hover:text-ink";
const primary = "ob-btn h-10 px-[18px] rounded-full bg-ink text-panel font-semibold";

/**
 * Page 3 of the first run: let me get to know you. Two optional ways, both running in the
 * background so nobody waits: look around this computer (after one yes), or bring what another AI
 * knows. Every finding is a chip the person can remove; they're saved to memory as they arrive.
 */
export function KnowStep({ name, workspaceId, onContinue, onSkip, onBack }: { name: string; workspaceId: string; onContinue: () => void; onSkip: () => void; onBack?: () => void }) {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const k = useKnow();
  useEffect(() => initKnow(workspaceId), [workspaceId]);

  // the host hops when it finds the name, and when an import lands
  const [smile, setSmile] = useState(false);
  const smileT = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cheer = () => {
    hostReact("hop");
    setSmile(true);
    clearTimeout(smileT.current);
    smileT.current = setTimeout(() => setSmile(false), 1100);
  };
  const seenName = useRef(k.nameFound);
  useEffect(() => {
    if (k.nameFound !== seenName.current) cheer();
    seenName.current = k.nameFound;
  }, [k.nameFound]); // eslint-disable-line react-hooks/exhaustive-deps
  const seenImport = useRef(k.imported);
  useEffect(() => {
    if (k.imported && k.imported !== seenImport.current) cheer();
    seenImport.current = k.imported;
  }, [k.imported]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(smileT.current), []);

  const [scanOff, setScanOff] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const scanning = k.scan === "running";
  // what it finds lands one thing at a time: each flies out of the host into "What I know", the host catches it, and the count ticks up
  const shown = useOneByOne(k.facts.length, 170);
  const facts = k.facts.slice(0, shown);
  const count = useCountUp(facts.length);
  const caught = useRef(shown);
  useEffect(() => {
    if (shown > caught.current) hostReact("catch");
    caught.current = shown;
  }, [shown]);
  const appName = IMPORT_APPS.find((a) => a.id === k.app)!.label;
  const sub = scanning ? "Looking around…" : facts.length ? "Here's what I picked up." : "The more I know, the less you'll have to explain later.";

  const readAnswer = (text: string) => {
    if (!text.trim()) return setPasteError("Paste the whole reply, with its headings.");
    if (text.includes("I'm moving my work into Wisp")) return setPasteError("That's my question. Paste the answer it gave you.");
    const n = takeAnswer(text);
    if (!n) return setPasteError("I couldn't find anything to keep in that answer. Paste the whole reply, with its headings.");
    setPasteError("");
    setPasting(false);
    setPaste("");
  };
  const pasteAnswer = async () => {
    // the clipboard when the browser allows it, else a box to paste into
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {}
    if (text.trim() && text.includes("##") && !text.includes("I'm moving my work into Wisp")) readAnswer(text);
    else setPasting(true);
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (t) addFacts([{ group: "You", text: t.slice(0, 200), src: "you" }]);
    setDraft("");
    setAdding(false);
  };

  const showScan = k.available === true && !scanOff;
  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-panel text-ink text-[14px] leading-[22px]">
      <style>{STYLE}</style>
      <PageTop step={2} onBack={onBack} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="ob-stagger mx-auto w-full max-w-[1072px] flex flex-col gap-6 px-4 sm:px-6 pt-4 pb-10">
          <div className="flex items-center gap-4">
            <HostGhost look={HOST_LOOK} size={72} mood={scanning ? "working" : "awake"} happy={smile || !!k.imported} />
            <div className="flex flex-col gap-0.5 min-w-0">
              <h1 className="text-[24px] leading-[30px] font-[650] tracking-[-0.015em]">{first ? `Let me get to know you, ${first}.` : "Let me get to know you."}</h1>
              <p className="text-[15px] leading-[22px] text-muted" aria-live="polite">
                {sub}
              </p>
            </div>
          </div>

          <div className={showScan ? "grid grid-cols-1 md:grid-cols-2 gap-4" : "grid grid-cols-1 gap-4 max-w-[528px]"}>
            {showScan && (
              <section className={`${card}${scanning ? " ob-sweep" : ""}`}>
                <div className="flex items-center gap-2.5">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="4" y="5" width="16" height="11" rx="2" />
                    <path d="M2 20h20" />
                  </svg>
                  <h2 className="text-[15px] font-semibold">Look around {k.computer}</h2>
                </div>
                <p className="text-muted">One yes, and I'll read just these. It stays in your Wisp.</p>
                <ul className="flex flex-col gap-1.5">
                  {SCAN_PARTS.map((p) => {
                    const st = k.parts[p.id];
                    return (
                      <li key={p.id} className="flex items-center gap-2.5 h-7">
                        <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center">
                          {st.state === "idle" && <span className="block w-1.5 h-1.5 rounded-full bg-[var(--input)]" />}
                          {st.state === "busy" && (
                            <svg className="ob-spin3" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--wisp)" strokeWidth="2.4" strokeLinecap="round" aria-label="Looking">
                              <path d="M12 3a9 9 0 1 1-9 9" />
                            </svg>
                          )}
                          {st.state === "done" && <Check />}
                        </span>
                        <span className="flex-1 min-w-0 truncate">{p.label}</span>
                        <span className="text-[12px] text-muted truncate max-w-[45%]">{st.found}</span>
                      </li>
                    );
                  })}
                </ul>
                {k.scan === "idle" && (
                  <div className="flex gap-2">
                    <button type="button" className={primary} onClick={() => void startScan()}>
                      Yes, take a look
                    </button>
                    <button type="button" className={quiet} onClick={() => setScanOff(true)}>
                      Not now
                    </button>
                  </div>
                )}
              </section>
            )}

            <section className={card}>
              <div className="flex items-center gap-2.5">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 12h12M12 6l6 6-6 6M20 5v14" />
                </svg>
                <h2 className="text-[15px] font-semibold">Bring what your other AI knows</h2>
              </div>
              <p className="text-muted">ChatGPT, Claude or Grok already know a lot about you. Ask, and I'll keep the useful parts.</p>
              <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Which AI">
                {IMPORT_APPS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={k.app === a.id}
                    onClick={() => pickApp(a.id)}
                    className="ob-btn h-8 px-3.5 rounded-full border text-ink"
                    style={k.app === a.id ? { borderColor: "var(--wisp)", background: "rgb(169 139 245 / .12)" } : { borderColor: "var(--line2)", background: "var(--panel)" }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              {k.imported ? (
                <p className="ob-pop text-[13px] leading-[18px] text-muted" aria-live="polite">
                  Got it. I kept {k.imported.kept} {k.imported.kept === 1 ? "thing" : "things"} from {k.imported.app} and left out anything private, like account numbers.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] leading-[18px]">
                    1. Copy my question into {k.app === "other" ? "your AI" : appName}.&nbsp; 2. Paste its answer here.
                  </span>
                  <div className="flex gap-2 flex-wrap">
                    <button type="button" className="ob-btn h-10 px-4 rounded-full border border-[var(--input)] bg-[var(--control)] text-ink" onClick={() => void copyQuestion().then(setCopied)}>
                      {copied ? "Copied" : "Copy question"}
                    </button>
                    <button type="button" className="ob-btn h-10 px-4 rounded-full bg-ink text-panel font-semibold" onClick={() => void pasteAnswer()}>
                      Paste answer
                    </button>
                  </div>
                  {copied === false && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--card)] p-3 text-[12px] text-muted select-all">{questionText()}</pre>}
                  {pasting && (
                    <div className="flex flex-col gap-2">
                      <textarea
                        autoFocus
                        aria-label="Its answer"
                        placeholder="Paste its answer here"
                        value={paste}
                        onChange={(e) => setPaste(e.target.value)}
                        className="min-h-[96px] rounded-[14px] border border-[var(--input)] bg-[var(--control)] p-3 text-[13px] outline-none focus:border-ink"
                      />
                      <button type="button" className={`${primary} self-start`} onClick={() => readAnswer(paste)}>
                        Keep the useful parts
                      </button>
                    </div>
                  )}
                  {pasteError && (
                    <p role="alert" className="text-[13px] text-bad">
                      {pasteError}
                    </p>
                  )}
                  {k.listening && copied !== null && <span className="text-[12px] text-faint">If {k.app === "other" ? "your AI" : appName} can open links, it can send its answer straight here.</span>}
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">What I know so far</h2>
              {!!facts.length && <span className="text-[13px] text-muted tabular-nums" data-testid="know-count">{count} {count === 1 ? "thing" : "things"}</span>}
            </div>
            <div className="min-h-[120px] rounded-[18px] bg-[var(--card)] p-4 flex flex-col gap-3">
              {!facts.length && <span className="text-faint">Only your name, so far. Say yes above and this fills in.</span>}
              {FACT_GROUPS.map((g) => {
                const mine = facts.filter((f) => f.group === g);
                if (!mine.length) return null;
                return (
                  <div key={g} className="flex gap-3 items-start">
                    <span className="w-[72px] shrink-0 text-[12px] leading-[30px] text-muted">{g}</span>
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {mine.map((f) => (
                        <FlyIn key={f.id} className="ob-fact min-h-[30px] max-w-full flex items-center gap-1.5 pl-3 pr-1.5 rounded-[15px] bg-panel border border-[var(--line)] text-[13px]">
                          <span className="min-w-0 break-words">{f.text}</span>
                          <span className="text-[11px] text-faint shrink-0">{f.src}</span>
                          <button type="button" aria-label={`Forget ${f.text}`} onClick={() => dropFact(f.id)} className="ob-x w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-ink hover:bg-[var(--hover)]">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                              <path d="M6 6l12 12M18 6 6 18" />
                            </svg>
                          </button>
                        </FlyIn>
                      ))}
                    </div>
                  </div>
                );
              })}
              {adding ? (
                <form onSubmit={add} className="flex gap-2 items-center">
                  <input
                    autoFocus
                    aria-label="Something about you"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => !draft.trim() && setAdding(false)}
                    placeholder="e.g. I'm on Pacific time"
                    maxLength={200}
                    className="h-[30px] w-full max-w-[320px] px-3 rounded-[15px] border border-[var(--input)] bg-[var(--control)] text-[13px] outline-none focus:border-ink"
                  />
                  <button type="submit" className="h-[30px] px-3 rounded-[15px] bg-ink text-panel text-[13px] font-semibold">
                    Add
                  </button>
                </form>
              ) : (
                !!facts.length && <button type="button" onClick={() => setAdding(true)} className="self-start h-[30px] px-3 rounded-[15px] border border-dashed border-[var(--input)] text-muted text-[13px] hover:text-ink">
                  Add something
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={onContinue} className="ob-btn setup-press h-11 px-[22px] rounded-full bg-ink text-panel font-semibold">
              {facts.length ? "That's me" : "Continue"}
            </button>
            <button type="button" onClick={onSkip} className="ob-btn h-11 px-3.5 rounded-full text-muted hover:text-ink">
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "Still learning…": while the look-around or an import is still running after the person moved
 * on, a small line at the top of the next onboarding pages with the newest thing found.
 */
export function StillLearning() {
  const k = useKnow();
  if (!stillLearning(k)) return null;
  return (
    <div className="ob-pop flex items-center gap-2 h-7 px-2.5 rounded-full bg-[var(--card)] text-[12px] text-muted max-w-[min(420px,60vw)]" aria-live="polite">
      <OnboardingGhost size={18} working follow={false} />
      <span className="shrink-0 font-medium text-ink">Still learning…</span>
      {k.latest && <span className="truncate">{k.latest}</span>}
    </div>
  );
}
