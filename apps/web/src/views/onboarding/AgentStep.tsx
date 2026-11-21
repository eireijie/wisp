import { useEffect, useRef, useState } from "react";
import type { GhostShape } from "@wisp/core";
import { motionReduced, useMotionReduced } from "../../theme.ts";
import { FAMILY_COLORS } from "../../ghostFamily.ts";
import { Ghost } from "../../components/Ghost.tsx";
import { agentInstructions, cap, loadAnswers, PHRASE, pickedGoals, roleLine, type AgentDraft } from "../../onboardingV3.ts";
import { PageTop } from "../../components/onboarding/PageTop.tsx";
import { HOST_LOOK, HostGhost, OB_EASE, hostReact } from "../../components/onboarding/HostGhost.tsx";
import { WHITE_WISP } from "../../components/SetupStage.tsx";
export { roleLine };

/** What page 3 learned (its Fact, read loosely so this page works before or without it). */
type Fact = { group: string; text: string };
const factsOf = (a: object): Fact[] => {
  const f = (a as { facts?: unknown }).facts;
  return Array.isArray(f) ? f.filter((x): x is Fact => !!x && typeof x.group === "string" && typeof x.text === "string") : [];
};

const STYLE = `
@keyframes ob-pop { 0% { opacity: 0; transform: translateY(6px) scale(.98); } 100% { opacity: 1; transform: none; } }
.ob-pop { animation: ob-pop .32s cubic-bezier(.32,.72,0,1) both; }
@keyframes ob-hop-a { 0%,100% { transform: none; } 35% { transform: translateY(-14px) scale(.95,1.06); } 70% { transform: translateY(0) scale(1.07,.93); } }
@keyframes ob-hop-b { 0%,100% { transform: none; } 35% { transform: translateY(-14px) scale(.95,1.06); } 70% { transform: translateY(0) scale(1.07,.93); } }
.ob-hop-a { animation: ob-hop-a .5s cubic-bezier(.32,.72,0,1); }
.ob-hop-b { animation: ob-hop-b .5s cubic-bezier(.32,.72,0,1); }
@keyframes ob-page { 0% { opacity: 0; transform: translateX(40px); } 100% { opacity: 1; transform: none; } }
.ob-page { animation: ob-page .45s cubic-bezier(.32,.72,0,1) both; }
.ob-btn { transition: transform .15s ease, background .15s ease, border-color .15s ease; }
.ob-btn:active { transform: scale(.96); }
@media (prefers-reduced-motion: reduce) {
  .ob-pop, .ob-hop-a, .ob-hop-b, .ob-page { animation: none; }
  .ob-btn { transition: none; }
  .ob-btn:active { transform: none; }
}`;

const COLOR_NAMES = ["Violet", "Teal", "Orange", "Blue", "Pink", "Lime"];
const SHAPES: GhostShape[] = ["classic", "round", "tall", "sheet", "wisp"];
const SHAPE_LABEL: Record<GhostShape, string> = { classic: "Classic", round: "Round", tall: "Tall", sheet: "Sheet", wisp: "Wisp" };
const NAME_POOL = ["Juno", "Atlas", "Pip", "Nova", "Milo", "Iris", "Otto", "Wren", "Remy", "Luna"];

/** One thing it learned on page 3 that reads well after "then": work first, never "You're Sam". */
function factLine(facts: readonly Fact[]): string | null {
  const order = ["Work", "Likes", "Tools"] as const;
  for (const g of order) {
    const f = facts.find((x) => x.group === g && !/^you(?:'re| are)\b/i.test(x.text));
    if (f) return f.text.replace(/[.\s]+$/, "").replace(/^([A-Z])(?![A-Z])/, (c) => c.toLowerCase());
  }
  return null;
}

/** "Hi Sam, I'm Juno. I'll start with your inbox, then the spring sale on March 3." */
export function previewLine(person: string, agent: string, goals: readonly string[], facts: readonly Fact[]): string {
  const who = person.trim().split(/\s+/)[0];
  const top = pickedGoals(goals)[0];
  const fact = factLine(facts);
  const hi = `${who ? `Hi ${who}` : "Hi"}, I'm ${agent}.`;
  if (top && fact) return `${hi} I'll start with ${PHRASE[top.id]}, then ${fact}.`;
  if (top) return `${hi} I'll start with ${PHRASE[top.id]}.`;
  if (fact) return `${hi} I'll start with ${fact}.`;
  return `${hi} I'll start by learning how you like things done.`;
}

export const handleOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** The app's ghost in the picked colour and shape: floats, smiles and talks (no cursor follow). */
function AgentGhost({ size, color, shape, smiling = false, still = false }: { size: number; color: string; shape: GhostShape; smiling?: boolean; still?: boolean }) {
  return <Ghost look={{ shape, color, eyes: "dots", mouth: "smile", cheeks: false, hat: "none", accessory: "none", motion: "float" }} size={size} happy={smiling} talking={smiling} animate={!still} label="" />;
}

type Field = "name" | "role" | "color" | "shape";

/**
 * Page 4 of the first run: make the agent theirs. Everything starts filled in from pages 2 and 3
 * (and keeps following page 3's findings as they arrive, except a field the person changed).
 * Continue only saves a draft; page 5 creates the agent once its AI is chosen.
 */
export function AgentStep({ workspaceId, person, onContinue, onBack }: { workspaceId: string; person: string; onContinue: (draft: AgentDraft) => void; onBack?: () => void }) {
  const reduced = useMotionReduced();
  const [answers, setAnswers] = useState(() => loadAnswers(workspaceId));
  const facts = factsOf(answers);
  const draft = answers.agentDraft;
  const touched = useRef<Set<Field>>(new Set(draft ? (["name", "role", "color", "shape"] as Field[]) : []));
  const [name, setName] = useState(draft?.name ?? "Juno");
  // a draft saved with the old "so you can spend less time on them" wording gets the new line
  const [role, setRole] = useState(() => (draft?.role && !/, so you can spend less time on (them|it)\.$/.test(draft.role) ? draft.role : roleLine(answers.goals, answers.other, facts)));
  const [color, setColor] = useState<string>(draft?.color ?? FAMILY_COLORS[0]);
  const [shape, setShape] = useState<GhostShape>(draft?.shape && SHAPES.includes(draft.shape) ? draft.shape : "classic");
  const [smile, setSmile] = useState(false);
  // a new shape morphs in (a quick shrink and twist back to rest), never a cut
  const morph = useRef<HTMLDivElement>(null);
  const shownShape = useRef(shape);
  useEffect(() => {
    if (shownShape.current === shape) return;
    shownShape.current = shape;
    const el = morph.current;
    if (!el || motionReduced() || typeof el.animate !== "function") return;
    el.animate([{ transform: "scale(0.86) rotate(-6deg)", opacity: 0.55 }, { transform: "none", opacity: 1 }], { duration: 300, easing: OB_EASE });
  }, [shape]);
  // the white host puts on the agent's colour a beat after the page opens (already dressed when coming back)
  const [dressed, setDressed] = useState(!!draft);
  useEffect(() => {
    if (dressed) return;
    const t = setTimeout(() => (setDressed(true), hostReact("hop")), reduced ? 0 : 650);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // page 3 keeps learning in the background and saves what it finds to the answers; follow it
  useEffect(() => {
    const read = () =>
      setAnswers((cur) => {
        const next = loadAnswers(workspaceId);
        return JSON.stringify(factsOf(next)) === JSON.stringify(factsOf(cur)) && next.goals.join() === cur.goals.join() ? cur : next;
      });
    const t = setInterval(read, 1500);
    window.addEventListener("storage", read);
    return () => {
      clearInterval(t);
      window.removeEventListener("storage", read);
    };
  }, [workspaceId]);

  const suggestedRole = roleLine(answers.goals, answers.other, facts);
  useEffect(() => {
    if (!touched.current.has("role")) setRole(suggestedRole);
  }, [suggestedRole]);

  // three names, never the person's own
  const first = person.trim().split(/\s+/)[0] ?? "";
  const names = NAME_POOL.filter((n) => n.toLowerCase() !== first.toLowerCase()).slice(0, 3);

  const bump = (kind: "hop" | "nod" = "hop") => {
    setDressed(true);
    hostReact(kind);
    if (reduced) return;
    setSmile(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSmile(false), 1100);
  };
  const change = (f: Field) => touched.current.add(f);
  const pickName = (n: string) => (change("name"), setName(n), bump("nod"));
  const pickColor = (c: string) => (change("color"), setColor(c), bump());
  const pickShape = (s: GhostShape) => (change("shape"), setShape(s), bump());
  const surprise = () => {
    const any = <T,>(xs: readonly T[], not: T) => {
      const rest = xs.filter((x) => x !== not);
      return rest[Math.floor(Math.random() * rest.length)] ?? not;
    };
    change("name");
    change("color");
    change("shape");
    setName((n) => any(NAME_POOL, n));
    setColor((c) => any(FAMILY_COLORS, c));
    setShape((s) => any(SHAPES, s));
    bump();
  };

  const agent = name.trim() || "your agent";
  const preview = previewLine(person, agent, answers.goals, facts);
  const ok = !!name.trim();
  const save = () => {
    if (!ok) return;
    const n = name.trim();
    const r = role.trim() || suggestedRole;
    onContinue({
      name: n,
      ...(handleOf(n) ? { handle: handleOf(n) } : {}),
      role: r,
      color,
      shape,
      instructions: agentInstructions(n, person, r, answers.goals, answers.other),
    });
  };

  const label = "text-[13px] font-semibold text-muted";
  const field = "h-11 box-border px-[18px] rounded-full border border-[var(--input)] bg-[var(--control)] text-ink text-[15px] outline-none focus:border-ink w-full min-w-0";
  return (
    <div className="fixed inset-0 z-10 flex flex-col bg-panel text-ink text-[14px] leading-[22px]">
      <style>{STYLE}</style>
      <PageTop step={3} onBack={onBack} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="ob-stagger min-h-full grid grid-cols-1 lg:grid-cols-[minmax(0,520px)_minmax(0,440px)] gap-10 lg:gap-20 justify-center items-center px-4 sm:px-6 pt-4 pb-10">
          <form
            className="flex flex-col gap-[22px] min-w-0 order-2 lg:order-1"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="flex flex-col gap-0.5">
              <h1 className="text-[24px] leading-[30px] font-[650] tracking-[-0.015em]">Make me yours.</h1>
              <p className="text-[15px] leading-[22px] text-muted">I picked these from what you told me. Change anything.</p>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="ob-agent-name" className={label}>
                Name
              </label>
              <input
                id="ob-agent-name"
                value={name}
                maxLength={40}
                autoComplete="off"
                onChange={(e) => {
                  change("name");
                  setName(e.target.value);
                }}
                className={field}
              />
              <div className="flex gap-1.5 flex-wrap">
                {names.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={name.trim() === n}
                    onClick={() => pickName(n)}
                    className="ob-btn h-[30px] px-3 rounded-[15px] border text-[13px] text-ink bg-panel"
                    style={{ borderColor: name.trim() === n ? "var(--ink)" : "var(--line2)" }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="ob-agent-role" className={label}>
                What I do
              </label>
              <input
                id="ob-agent-role"
                value={role}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => {
                  change("role");
                  setRole(e.target.value);
                }}
                className={field}
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Colour</span>
              <div className="flex gap-2.5 flex-wrap" role="group" aria-label="Colour">
                {FAMILY_COLORS.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={COLOR_NAMES[i]}
                    aria-pressed={color === c}
                    onClick={() => pickColor(c)}
                    className="ob-btn w-9 h-9 rounded-full p-[3px] bg-panel border-2"
                    style={{ borderColor: color === c ? "var(--ink)" : "transparent" }}
                  >
                    <span className="block w-full h-full rounded-full" style={{ background: c }} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Shape</span>
              <div className="flex gap-2 flex-wrap" role="group" aria-label="Shape">
                {SHAPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-label={SHAPE_LABEL[s]}
                    aria-pressed={shape === s}
                    onClick={() => pickShape(s)}
                    className="ob-btn w-14 h-14 rounded-[14px] border flex items-center justify-center p-0"
                    style={{ borderColor: shape === s ? "var(--ink)" : "var(--line2)", boxShadow: shape === s ? "inset 0 0 0 1px var(--ink)" : "none", background: shape === s ? `${color}1f` : "var(--panel)" }}
                  >
                    <AgentGhost size={38} color={color} shape={s} still />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 items-center pt-1">
              <button type="submit" disabled={!ok} className="ob-btn setup-press h-11 px-[22px] rounded-full bg-ink text-panel font-semibold disabled:opacity-40">
                Continue
              </button>
              <button type="button" onClick={surprise} className="ob-btn h-11 px-4 rounded-full border border-[var(--line2)] bg-panel text-ink">
                Surprise me
              </button>
            </div>
          </form>

          <div className="flex flex-col items-center gap-[22px] min-w-0 order-1 lg:order-2">
            <div className="w-full max-w-[440px] h-[240px] lg:h-[320px] rounded-[24px] bg-[var(--card)] flex flex-col items-center justify-center gap-3">
              <div ref={morph} data-ghost-glance="">
                <HostGhost className="ob-dress" look={dressed ? { ...WHITE_WISP, shape, color, color2: undefined } : { ...HOST_LOOK, shape }} size={150} happy={smile} talking={smile} follow={false} />
              </div>
              <div className="flex flex-col items-center gap-0.5 min-w-0 max-w-full px-6 text-center">
                <span className="text-[15px] font-semibold truncate max-w-full">{agent}</span>
                <span className="text-[13px] text-muted line-clamp-2">{role.trim() || suggestedRole}</span>
              </div>
            </div>
            <div className="w-full max-w-[440px] flex gap-2.5 items-start" aria-live="polite">
              <AgentGhost size={28} color={color} shape={shape} />
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-[13px] font-semibold truncate">{agent}</span>
                <span key={preview} className="ob-pop bg-[var(--card)] rounded-[18px] px-3.5 py-[9px] self-start">
                  {preview}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
