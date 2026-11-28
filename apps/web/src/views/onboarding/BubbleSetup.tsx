import { Check, Loader2 } from "lucide-react";
import { cx } from "../../components/ui.tsx";
import { agentInstructions } from "../../onboardingV3.ts";
import { BubbleSlot } from "./Stage.tsx";
import type { GhostAppearance } from "@bubble-ai/core";

/**
 * The first run's pages after "Your agent" (2026-11-26 canvas): How it starts (Simple or Advanced,
 * each shown as a small loop of what it's like), then for Advanced, Introduce yourself (board 16b,
 * was Make it yours: what it should help with in the person's own words, anything it should know
 * about them, how it talks and when it checks in). The picks write the person's first message, shown
 * as they'll send it; Send sends exactly that, and the agent suggests which apps to connect
 * (hub setup-picks.ts); there is no Connect page any more.
 * They sit on the one Stage (Stage.tsx); the bubble above each is the stage's own.
 */

export type SetupPath = "advanced" | "simple";

/** "a, b and c" */
export function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

// --- How it starts -------------------------------------------------------------------------------

/** Simple or Advanced, each shown, not described: a chat that starts right away, or goals and apps picked first. */
export function StartStep({ name, path, onPath, onNext }: { name: string; path: SetupPath; onPath: (p: SetupPath) => void; onNext: () => void }) {
  return (
    <div className="flex w-full max-w-[600px] flex-col items-center">
      <BubbleSlot size={96} />
      <h1 className="ob-title mt-5">How should {name} start?</h1>
      <div role="radiogroup" aria-label="How it starts" className="mt-7 grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" role="radio" aria-checked={path === "simple"} onClick={() => onPath("simple")} className="ob-tile flex flex-col gap-3 p-3">
          <div className="ob-demo ob-demo-simple" aria-hidden>
            <span className="msg m1" />
            <span className="msg me m2" />
            <span className="msg m3" />
          </div>
          <span className="px-1 pb-1">
            <span className="block text-[15px] font-semibold">Simple</span>
            <span className="block text-[13px] text-muted">Chat now</span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={path === "advanced"} onClick={() => onPath("advanced")} className="ob-tile flex flex-col gap-3 p-3">
          <div className="ob-demo ob-demo-adv" aria-hidden>
            <span className="chip c1">My days</span>
            <span className="chip c2">Messages</span>
            <span className="chip c3">Trips</span>
            <span className="chip r1">Calendar ✓</span>
            <span className="chip r2">Gmail ✓</span>
          </div>
          <span className="px-1 pb-1">
            <span className="block text-[15px] font-semibold">Advanced</span>
            <span className="block text-[13px] text-muted">Goals and apps first</span>
          </span>
        </button>
      </div>
      <button type="button" onClick={onNext} className="ob-primary mt-9 w-full max-w-[280px]">
        Continue
      </button>
    </div>
  );
}

// --- Introduce yourself -------------------------------------------------------------------------------

export interface SetupGoal {
  id: string;
  /** in the person's own words, as they'd say it */
  label: string;
  /** the same, as it reads after "I'd like help with:" */
  want: string;
  /** a 24×24 line-icon path */
  icon: string;
}

export const SETUP_GOALS: SetupGoal[] = [
  { id: "days", label: "Keep my days on track", want: "keeping my days on track", icon: "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4" },
  { id: "msgs", label: "Stay on top of my messages", want: "staying on top of my messages", icon: "M4 6h16v12H4zM4 7l8 6 8-6" },
  { id: "people", label: "Remember the people I care about", want: "remembering the people I care about", icon: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" },
  { id: "plans", label: "Plan trips and weekends", want: "planning trips and weekends", icon: "M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  { id: "money", label: "Keep an eye on money and bills", want: "keeping an eye on money and bills", icon: "M3 7h18v12H3zM3 11h18M16 15h2" },
  { id: "health", label: "Help me stay healthy", want: "staying healthy", icon: "M3 12h4l3-7 4 14 3-7h4" },
  { id: "business", label: "Help run my business", want: "running my business", icon: "M4 9l1-5h14l1 5M4 9v11h16V9M4 9h16M9 20v-6h6v6" },
  { id: "learn", label: "Help me learn and build things", want: "learning and building things", icon: "M4 5h7a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-7" },
];

export type Talk = "short" | "friendly" | "thorough";
export type CheckIn = "morning" | "evening" | "needed";
const TALK: { id: Talk; label: string }[] = [
  { id: "short", label: "Short" },
  { id: "friendly", label: "Friendly" },
  { id: "thorough", label: "Thorough" },
];
const WHEN: { id: CheckIn; label: string }[] = [
  { id: "morning", label: "Each morning" },
  { id: "evening", label: "Each evening" },
  { id: "needed", label: "Only when it matters" },
];

/** The person's first name, for their first message. */
export const firstName = (person: string) => person.trim().split(/\s+/)[0] ?? "";

const picked = (goals: readonly string[]) => SETUP_GOALS.filter((g) => goals.includes(g.id));

/** What you'd like help with and about you, in plain words: the middle of your first message. */
export function picksMessage(goals: readonly string[], about: string): string {
  const want = picked(goals).map((g) => g.want);
  const known = about.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return [want.length ? `I'd like help ${andList(want)}.` : "I'm not sure yet what I'd like help with.", known ? `About me: ${known}.` : ""].filter(Boolean).join(" ");
}

const TALK_LINE: Record<Talk, string> = { short: "Keep it short", friendly: "Keep it friendly", thorough: "Be thorough" };
const WHEN_LINE: Record<CheckIn, string> = { morning: "check in each morning", evening: "check in each evening", needed: "only check in when it matters" };

/**
 * Your first message to the agent, written from the picks (board 16b), and exactly what is sent:
 * "Hi Juno, I'm Sam. I'd like help keeping my days on track. About me: … Keep it friendly, and check in each morning."
 */
export function introMessage(name: string, person: string, goals: readonly string[], about: string, talk: Talk, when: CheckIn): string {
  const first = firstName(person);
  const hi = `Hi ${name}${first ? `, I'm ${first}` : ""}.`;
  return [hi, picksMessage(goals, about), `${TALK_LINE[talk]}, and ${WHEN_LINE[when]}.`].join(" ").slice(0, 2000);
}

/** The agent's instructions from Introduce yourself: the usual start, what it helps with, about the person, how it talks, when it checks in. */
export function yoursInstructions(name: string, person: string, goals: readonly string[], talk: Talk, when: CheckIn, about = ""): string {
  const who = firstName(person) || "them";
  const base = agentInstructions(name, person, "", [], picked(goals).map((g) => g.want).join(", "));
  const known = about.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 500);
  const me = known ? `About ${who}, in their words: "${known}."` : "";
  const style = { short: "Keep messages short: one or two lines.", friendly: "Be warm and friendly, with enough detail to act on.", thorough: "Give full detail, and say what you've already done." }[talk];
  const check = { morning: `Each morning, message ${who} with what needs them.`, evening: `Each evening, message ${who} with what happened and what needs them.`, needed: `Only message ${who} when something matters.` }[when];
  return [base, me, style, check].filter(Boolean).join(" ");
}

/** Introduce yourself to {name} (board 16b, was Make it yours): your picks write your first message, shown on the right as you'll send it. */
export function YoursStep({ name, person, goals, onGoals, about, onAbout, talk, onTalk, when, onWhen, onNext, busy }: { name: string; person: string; goals: string[]; onGoals: (g: string[]) => void; about: string; onAbout: (a: string) => void; talk: Talk; onTalk: (t: Talk) => void; when: CheckIn; onWhen: (w: CheckIn) => void; onNext: () => void; busy?: boolean; look?: Pick<GhostAppearance, "color" | "color2" | "bubble">; seed?: string }) {
  const msg = introMessage(name, person, goals, about, talk, when);
  return (
    <div className="flex w-full max-w-[584px] flex-col items-center">
      <BubbleSlot size={60} />
      <h1 className="ob-title mt-3">Introduce yourself to {name}</h1>
      <p className="ob-sub mt-1! text-[14px]!">Tap what fits. It becomes your first message.</p>
      <div className="mt-[18px] w-full px-0.5 text-[12.5px] text-muted" id="ob-help">
        I’d like help with
      </div>
      <div className="mt-[7px] grid w-full grid-cols-1 gap-[7px] sm:grid-cols-2" aria-labelledby="ob-help" role="group">
        {SETUP_GOALS.map((g) => {
          const on = goals.includes(g.id);
          return (
            <button key={g.id} type="button" aria-pressed={on} onClick={() => onGoals(on ? goals.filter((x) => x !== g.id) : [...goals, g.id])} className="ob-tile flex h-[42px] items-center gap-2 px-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 opacity-85">
                <path d={g.icon} />
              </svg>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{g.label}</span>
              <span aria-hidden className={cx("grid size-[18px] shrink-0 place-items-center rounded-full text-white transition-[background-color,opacity] duration-200", on ? "bg-wisp opacity-100" : "opacity-0")}>
                <Check size={11} strokeWidth={3.2} />
              </span>
            </button>
          );
        })}
      </div>
      <label className="mt-3.5 w-full px-0.5 text-[12.5px] text-muted" htmlFor="ob-about">
        About me
      </label>
      <input
        id="ob-about"
        value={about}
        onChange={(e) => onAbout(e.target.value)}
        maxLength={300}
        placeholder="I work weekends, I’m a student, I love hiking…"
        className="ob-field mt-[7px] h-[42px]! w-full rounded-[11px]! px-3.5!"
      />
      <div className="mt-3 flex w-full flex-col gap-[7px]">
        <Seg label="Talk to me" value={talk} options={TALK} onPick={onTalk} />
        <Seg label="Check in" value={when} options={WHEN} onPick={onWhen} />
      </div>
      {/* your first message, on the right like any message you send; it is exactly what goes to the agent */}
      <div className="mt-4 flex w-full justify-end" aria-live="polite">
        <div className="bubble me max-w-[88%]! text-[14.5px] leading-[1.4]!" data-testid="intro-message">
          {msg}
        </div>
      </div>
      <button type="button" onClick={onNext} disabled={busy} className="ob-primary mt-4 w-full max-w-[260px]">
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
        Send to {name}
      </button>
    </div>
  );
}

function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: { id: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-[78px] shrink-0 truncate text-[12.5px] text-muted">{label}</span>
      <div role="radiogroup" aria-label={label} className="ob-seg ob-seg-fill ob-seg-wide min-w-0 flex-1">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onPick(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
