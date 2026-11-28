import { useEffect, useState, type FormEvent } from "react";
import { SetupProblem, setupField } from "../components/SetupShell.tsx";
import { PasswordInput } from "../components/PasswordInput.tsx";
import { BubbleSlot, Stage } from "./onboarding/Stage.tsx";
import { DrawnCheck } from "../components/onboarding/obMotion.tsx";
import { api } from "../api.ts";
import { setupCodeFromHash } from "../setup-link.ts";
import { AuthButton, AuthError, AuthHero, AuthInput, AuthLink, AuthPage } from "../components/auth.tsx";

/** Looks like a whole email address (the check that draws in beside it). */
export const emailLooksRight = (email: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim()) && !/\.$/.test(email.trim());

/** 0–4: how strong a new password is (8+ characters, then mixed case, a digit, a symbol or 14+ characters). */
export function passwordStrength(pw: string): number {
  if (pw.length < 8) return pw ? 1 : 0;
  let n = 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) n++;
  if (/\d/.test(pw)) n++;
  if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 14) n++;
  return Math.min(4, n);
}

/** An invite link: #/join/<code>. */
const inviteCode = () => location.hash.match(/^#\/join\/([\w-]+)/)?.[1] ?? null;
/** The link the desktop app and installer open on a new Bubble AI: #/setup/<setup code>. */
const linkedSetupCode = () => setupCodeFromHash(location.hash);

/** The code in a pasted invite: a link (https://…/#/join/<code>) or just the code itself. */
export function pastedInviteCode(text: string): string | null {
  const t = text.trim();
  return t.match(/\/join\/([\w-]+)/)?.[1] ?? (/^[\w-]+$/.test(t) ? t : null);
}

/**
 * Before you're in: the first run's first screen ("You": make your Bubble AI), sign in, and joining by
 * invite. One calm layout each: the ghost, a title, at most one sentence, the fields, the choices
 * as buttons.
 */
export function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [linkedCode, setLinkedCode] = useState(linkedSetupCode);
  const [form, setForm] = useState({ email: "", password: "", name: "", setupCode: linkedCode });
  // Pasting the link into a tab that's already open only changes the hash (no reload), so pick the code up then too.
  useEffect(() => {
    const on = () => {
      const next = linkedSetupCode();
      if (!next) return;
      setLinkedCode(next);
      setForm((f) => ({ ...f, setupCode: next }));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(inviteCode);
  const [invite, setInvite] = useState<{ workspace: string; role: string } | null>(null);
  /** the invite didn't check out (expired or revoked) */
  const [inviteBad, setInviteBad] = useState(false);
  /** asking for an invite link to paste */
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [attempt, setAttempt] = useState(0);
  const emailOk = emailLooksRight(form.email);

  useEffect(() => {
    api<{ needsSetup: boolean; needsCode?: boolean }>("GET", "/api/setup")
      .then((r) => {
        setNeedsSetup(r.needsSetup);
        setNeedsCode(!!r.needsCode);
      })
      .catch(() => setError("Can't reach your Bubble AI."));
  }, [attempt]);
  useEffect(() => {
    if (!code) return;
    setInvite(null);
    setInviteBad(false);
    api<{ workspace: string; role: string }>("GET", `/api/invites/check?code=${encodeURIComponent(code)}`).then(setInvite, () => setInviteBad(true));
  }, [code]);
  const joining = !!code && !needsSetup;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = needsSetup
        ? await api<{ token: string }>("POST", "/api/setup", { ...form, workspaceName: `${form.name.trim()}'s Bubble AI`, features: "simple", setupCode: form.setupCode.trim() || undefined })
        : joining
          ? await api<{ token: string }>("POST", "/api/invites/accept", { code, name: form.name, email: form.email, password: form.password })
          : await api<{ token: string }>("POST", "/api/auth/login", { email: form.email, password: form.password });
      if (needsSetup || joining) {
        // New account: start it on this device's time zone so agents and routines don't fall back to UTC. Best-effort.
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (timezone) await api("PATCH", "/api/me", { timezone }, { headers: { authorization: `Bearer ${r.token}` } }).catch(() => {});
      }
      if (needsSetup) location.hash = "#/welcome/intro";
      else if (joining) location.hash = "#/";
      onAuthed(r.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const leaveInvite = () => {
    location.hash = "#/";
    setCode(null);
    setInviteBad(false);
    setPasting(false);
    setError(null);
  };
  const usePasted = () => {
    const next = pastedInviteCode(pasted);
    if (!next) return setError("That isn't a Bubble AI invite link.");
    setError(null);
    setPasting(false);
    setPasted("");
    location.hash = `#/join/${next}`;
    setCode(next);
  };

  // can't reach the Bubble AI at all
  if (needsSetup === null && error) {
    return (
      <AuthPage themeToggle={false}>
        <AuthHero title="Can't reach your Bubble AI">Check it's running.</AuthHero>
        <div className="mt-9 flex flex-col items-center gap-1.5">
          <AuthButton
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </AuthButton>
        </div>
      </AuthPage>
    );
  }
  if (needsSetup === null) {
    return (
      // a quick check usually answers at once: the page stays clear, and only says Connecting… if it's slow
      <SlowConnecting />
    );
  }
  // an invite that doesn't work
  if (!needsSetup && code && inviteBad) {
    return (
      <AuthPage themeToggle={false}>
        <AuthHero title="This invite didn't work">Expired or revoked. Ask for a new link.</AuthHero>
        <div className="mt-9 flex flex-col items-center gap-1.5">
          <AuthButton
            onClick={() => {
              setInviteBad(false);
              setCode(null);
              setPasting(true);
            }}
          >
            Try another link
          </AuthButton>
          <AuthLink onClick={leaveInvite}>Sign in instead</AuthLink>
        </div>
      </AuthPage>
    );
  }
  // a place to paste an invite link
  if (!needsSetup && !code && pasting) {
    return (
      <AuthPage themeToggle={false}>
        <AuthHero title="Join with an invite" />
        <form
          className="mt-9 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            usePasted();
          }}
        >
          <AuthInput value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Invite link" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Invite link" autoFocus required />
          <AuthError>{error}</AuthError>
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <AuthButton disabled={!pasted.trim()}>Continue</AuthButton>
            <AuthLink
              onClick={() => {
                setPasting(false);
                setError(null);
              }}
            >
              Sign in instead
            </AuthLink>
          </div>
        </form>
      </AuthPage>
    );
  }

  // the first run's first screen: you
  if (needsSetup) {
    return (
      // the same stage as the pages after it (and the desktop's start page before it): the bubble above, one column
      <Stage page="you" look={undefined} progress={0.08}>
        <form
          className="flex w-full max-w-[400px] flex-col items-center"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <BubbleSlot size={120} />
          <h1 className="ob-title mt-4">Make your Bubble AI</h1>
          <div className="mt-7 flex w-full flex-col gap-3">
            <input className={setupField} value={form.name} onChange={set("name")} autoComplete="name" placeholder="Your name" aria-label="Your name" autoFocus required />
            {needsCode && !linkedCode && (
              <label className="flex flex-col gap-1.5">
                <input className={setupField} value={form.setupCode} onChange={set("setupCode")} placeholder="Setup code" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Setup code" required />
                <span className="pl-1 text-[13px] leading-5 text-faint">On the computer Bubble AI runs on, run bubble-ai setup-code.</span>
              </label>
            )}
            <span className="relative block">
              <input className={`${setupField} pr-11`} type="email" value={form.email} onChange={set("email")} autoComplete="email" placeholder="Email" aria-label="Email" required />
              {emailOk && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2" data-testid="email-ok">
                  <DrawnCheck />
                </span>
              )}
            </span>
            <PasswordInput className={setupField} value={form.password} onChange={set("password")} autoComplete="new-password" minLength={8} placeholder="Password" aria-label="Password" required />
            {form.password && <Meter strength={passwordStrength(form.password)} short={form.password.length < 8} />}
            <SetupProblem>{error}</SetupProblem>
          </div>
          <button type="submit" disabled={busy} className="ob-primary mt-8 w-full max-w-[280px]">
            Continue
          </button>
        </form>
      </Stage>
    );
  }

  return (
    <AuthPage themeToggle={false}>
      <form onSubmit={submit} className="flex flex-col">
        <AuthHero title={joining ? `Join ${invite?.workspace ?? "the workspace"}` : "Sign in to Bubble AI"}>{joining ? (invite ? `You're invited as ${invite.role === "owner" ? "an owner" : `a ${invite.role}`}.` : "Checking your invite…") : undefined}</AuthHero>
        <div className="mt-8 flex flex-col gap-3.5">
          {joining && <AuthInput value={form.name} onChange={set("name")} autoComplete="name" placeholder="Your name" aria-label="Your name" required />}
          <AuthInput type="email" value={form.email} onChange={set("email")} autoComplete="email" placeholder="Email" aria-label="Email" required />
          <AuthInput type="password" value={form.password} onChange={set("password")} autoComplete={joining ? "new-password" : "current-password"} minLength={joining ? 8 : undefined} placeholder="Password" aria-label="Password" required />
          {joining && form.password && <Meter strength={passwordStrength(form.password)} short={form.password.length < 8} />}
          <AuthError>{error}</AuthError>
        </div>
        <div className="mt-8 flex flex-col items-center gap-1.5">
          <AuthButton disabled={busy || (joining && !invite)}>{joining ? "Join" : "Sign in"}</AuthButton>
          {joining ? (
            <AuthLink onClick={leaveInvite}>I already have an account</AuthLink>
          ) : (
            <AuthLink
              onClick={() => {
                setError(null);
                setPasting(true);
              }}
            >
              Join with an invite
            </AuthLink>
          )}
        </div>
      </form>
    </AuthPage>
  );
}

/** Four bars that fill as a new password gets stronger; the only words are "Too short". */
function Meter({ strength, short }: { strength: number; short: boolean }) {
  return (
    <span className="flex items-center gap-2.5 px-1.5" aria-live="polite">
      <span className="ob-meter flex-1 !mt-0" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <i key={i} data-on={strength >= i} />
        ))}
      </span>
      {short && <span className="text-[12px] text-muted">Too short</span>}
    </span>
  );
}

/** "Connecting…", only once the check has taken more than a moment, so a quick one never flashes a card. */
function SlowConnecting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, []);
  return slow ? (
    <AuthPage themeToggle={false}>
      <AuthHero title="Connecting…" />
    </AuthPage>
  ) : (
    <div className="h-full w-full bg-panel" />
  );
}
