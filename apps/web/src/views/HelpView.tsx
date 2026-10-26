import { GITHUB_URL } from "@wisp/core";
import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronLeft, CircleHelp, ExternalLink, LifeBuoy } from "lucide-react";
import { NEXT_STEP, helperChecklist, nextStep, setupProgress, useOnboarding, type HelperCheck } from "../onboarding.ts";
import { useDevices } from "../devices.ts";
import { href } from "../router.ts";
import { useStore } from "../store.ts";
import { Button, cx } from "../components/ui.tsx";

const ISSUES_URL = `${GITHUB_URL}/issues`;

const SECTIONS = [
  { id: "setup", title: "Finish setup" },
  { id: "helper", title: "My helper isn't answering" },
  { id: "examples", title: "What can Wisp do?" },
  { id: "words", title: "Words you'll see" },
  { id: "report", title: "Report a problem" },
] as const;

const EXAMPLES = [
  "Plan your meals for the week and write the shopping list.",
  "Draft a polite message or email for you to check and send.",
  "Summarize a long document into a few clear points.",
  "Keep notes on what matters to you, so you don't repeat yourself.",
  "Check a website and tell you what changed.",
  "Help sort your inbox, once you connect Gmail.",
];

const GLOSSARY: [string, string, { label: string; to: string }?][] = [
  ["Agent (helper)", "An AI helper you give work to, like a teammate. It has a name, remembers things, and works on a device."],
  ["Harness", "The AI program a helper runs on, like Claude Code or Codex. You pick it once when you make a helper."],
  ["Device", "A computer of yours with Wisp installed. Helpers do their work there."],
  ["Computer", "A desktop a helper can see and use, either a virtual one on your device or your own screen."],
  ["Memory", "Notes Wisp keeps about you and your work, so helpers don't need to be told twice. You can read and fix them."],
  ["Skill", "Something a helper has learned how to do, like a recipe it can follow again."],
  ["Routine", "A job a helper does on its own, on a schedule or when something happens."],
  ["Team", "A group of helpers that work on something together. Each team has its own, under Team settings."],
  ["Connected app", "A service you link to Wisp, like Gmail, so helpers can use it for you."],
  ["Connection code (token)", "A one-time code that links a computer to this Wisp. It's shown once when you add a device."],
  ["AI tokens", "How AI services measure and charge for work: more text, more tokens."],
];

const linkClass = "text-accent-text hover:underline rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40";
const linkButtonClass = "inline-flex items-center justify-center h-9 px-4 rounded-full text-sm font-medium bg-accent text-accent-ink hover:bg-accent/90 outline-none focus-visible:ring-3 focus-visible:ring-ring/40";

/** One place for a beginner to get unstuck: setup, why a helper is quiet, plain words, and where to report problems. */
export function HelpView({ onBack }: { onBack?: () => void }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-15 shrink-0 px-4 md:px-6 flex items-center gap-2 border-b border-line safe-top">
        {onBack && (
          <button className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-hover" onClick={onBack} aria-label="Back">
            <ChevronLeft size={22} />
          </button>
        )}
        <LifeBuoy size={17} className="text-accent-text" aria-hidden />
        <h1 className="t-title flex-1 truncate">Help</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl px-4 md:px-6 py-5 space-y-8">
          <nav aria-label="On this page">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a className={linkClass} href={`${href({ view: "help" })}`} onClick={(e) => jumpTo(e, s.id)}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <SetupSection />
          <HelperSection />
          <ExamplesSection />
          <WordsSection />
          <ReportSection />
        </div>
      </div>
    </div>
  );
}

/** In-page jump. The hash holds the route, so scroll instead of changing the URL. */
function jumpTo(e: React.MouseEvent, id: string) {
  e.preventDefault();
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

function Section({ id, title, children }: { id: (typeof SECTIONS)[number]["id"]; title: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-title`} className="scroll-mt-4 space-y-3 outline-none">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SetupSection() {
  const { done } = useOnboarding();
  const { progress, steps, complete } = setupProgress(done);
  const next = nextStep(done);
  return (
    <Section id="setup" title="Finish setup">
      <div className="flex items-center gap-3">
        <div role="progressbar" aria-valuemin={0} aria-valuemax={steps} aria-valuenow={progress} aria-label="Setup progress" className="h-2 flex-1 rounded-full bg-chip overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(progress / steps) * 100}%` }} />
        </div>
        <span className="text-sm text-muted tabular-nums whitespace-nowrap">
          {progress} of {steps} steps done
        </span>
      </div>
      {complete || !next ? (
        <p className="text-sm text-muted">Setup is done. You're ready to go.</p>
      ) : (
        <p className="text-sm">
          <span className="text-muted">Next: </span>
          {NEXT_STEP[next]}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {!complete && (
          <a className={linkButtonClass} href={href({ view: "welcome" })}>
            Continue setup
          </a>
        )}
        <a className={cx("text-sm", linkClass)} href={href({ view: "welcome", intro: true })}>
          {complete ? "See the welcome again" : "What is Wisp? See the welcome again"}
        </a>
      </div>
    </Section>
  );
}

function HelperSection() {
  const agents = useStore((s) => s.agents);
  const devices = useDevices();
  const checks = helperChecklist(agents, devices);
  return (
    <Section id="helper" title="My helper isn't answering">
      {devices === null && (
        <p className="text-sm text-faint" role="status">
          Checking your devices…
        </p>
      )}
      <ul className="rounded-xl border border-line divide-y divide-line">
        {checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>
    </Section>
  );
}

const STATUS = {
  ok: { Icon: Check, tone: "text-ok", word: "Working" },
  bad: { Icon: AlertTriangle, tone: "text-warn", word: "Needs fixing" },
  unknown: { Icon: CircleHelp, tone: "text-faint", word: "Can't tell yet" },
} as const;

function CheckRow({ check }: { check: HelperCheck }) {
  const { Icon, tone, word } = STATUS[check.status];
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon size={16} className={cx("mt-0.5 shrink-0", tone)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <div className={check.status === "unknown" ? "text-muted" : undefined}>
          <span className="sr-only">{word}: </span>
          {check.label}
          {check.status !== "ok" && <span className="ml-2 text-xs text-faint">{word}</span>}
        </div>
        {check.status === "bad" && check.fix && <p className="mt-0.5 text-muted">{check.fix}</p>}
        {check.status === "bad" && check.to && (
          <a className={cx("mt-1 inline-block", linkClass)} href={href(check.to)}>
            Fix this
          </a>
        )}
      </div>
    </li>
  );
}

function ExamplesSection() {
  return (
    <Section id="examples" title="What can Wisp do?">
      <ul className="list-disc pl-5 space-y-1.5 text-sm">
        {EXAMPLES.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </Section>
  );
}

function WordsSection() {
  return (
    <Section id="words" title="Words you'll see">
      <dl className="rounded-xl border border-line divide-y divide-line">
        {GLOSSARY.map(([term, meaning, link]) => (
          <div key={term} className="px-4 py-3">
            <dt className="text-sm font-medium">{term}</dt>
            <dd className="mt-0.5 text-sm text-muted">
              {meaning}
              {link && (
                <>
                  {" "}
                  <a className={linkClass} href={link.to}>
                    {link.label}
                  </a>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ReportSection() {
  return (
    <Section id="report" title="Report a problem">
      <p className="text-sm text-muted">Something broken or confusing? Tell us what you were trying to do, what you expected, and what happened instead. Leave out passwords and private details.</p>
      <a className={cx("inline-flex items-center gap-1 text-sm", linkClass)} href={ISSUES_URL} target="_blank" rel="noreferrer">
        Open an issue on GitHub <ExternalLink size={13} aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </Section>
  );
}
