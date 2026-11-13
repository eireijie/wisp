import { useEffect, useState, type FormEvent } from "react";
import { SetupShell } from "../components/SetupShell.tsx";
import { Check } from "lucide-react";
import { api } from "../api.ts";
import { AuthButton, AuthError, AuthField, AuthHero, AuthInput, AuthLink, AuthPage } from "../components/auth.tsx";

/** An invite link: #/join/<code>. */
const inviteCode = () => location.hash.match(/^#\/join\/([\w-]+)/)?.[1] ?? null;
/** The link the desktop app and installer open on a new Wisp: #/setup/<setup code>. */
const linkedSetupCode = () => location.hash.match(/^#\/setup\/([\w-]+)/)?.[1] ?? "";

export function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [linkedCode] = useState(linkedSetupCode);
  const [form, setForm] = useState({ email: "", password: "", name: "", setupCode: linkedCode });
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

  useEffect(() => {
    api<{ needsSetup: boolean; needsCode?: boolean }>("GET", "/api/setup")
      .then((r) => {
        setNeedsSetup(r.needsSetup);
        setNeedsCode(!!r.needsCode);
      })
      .catch(() => setError("Can't reach your Wisp."));
  }, [attempt]);
  useEffect(() => {
    if (!code) return;
    setInvite(null);
    setInviteBad(false);
    api<{ workspace: string; role: string }>("GET", `/api/invites/check?code=${encodeURIComponent(code)}`).then(setInvite, () => setInviteBad(true));
  }, [code]);
  const joining = !!code && !needsSetup;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = needsSetup
        ? await api<{ token: string }>("POST", "/api/setup", { ...form, workspaceName: `${form.name.trim()}'s Wisp`, features: "simple", setupCode: form.setupCode.trim() || undefined })
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
    // a link (https://…/#/join/<code>) or just the code itself
    const text = pasted.trim();
    const next = text.match(/\/join\/([\w-]+)/)?.[1] ?? (/^[\w-]+$/.test(text) ? text : null);
    if (!next) return setError("That isn't a Wisp invite link.");
    setError(null);
    setPasting(false);
    setPasted("");
    location.hash = `#/join/${next}`;
    setCode(next);
  };

  // can't reach the Wisp at all
  if (needsSetup === null && error) {
    return (
      <AuthPage>
        <AuthHero title="Can't reach your Wisp">Check that it's running and that you're online.</AuthHero>
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
      <AuthPage>
        <AuthHero title="Connecting…" />
      </AuthPage>
    );
  }
  // an invite that doesn't work
  if (!needsSetup && code && inviteBad) {
    return (
      <AuthPage>
        <AuthHero title="This invite didn't work">It may have expired or been revoked. Ask the person who invited you for a new link.</AuthHero>
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
      <AuthPage>
        <AuthHero title="Join with an invite">Paste the invite link you were sent.</AuthHero>
        <form
          className="mt-9 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            usePasted();
          }}
        >
          <AuthField label="Invite link">
            <AuthInput value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…/#/join/…" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Invite link" autoFocus required />
          </AuthField>
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

  const page = (
      <form onSubmit={submit} className="flex flex-col">
        {needsSetup ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] leading-tight">Create your account</h1>
            <p className="text-sm text-muted">You'll use this to sign in from your other devices.</p>
          </div>
        ) : (
          <AuthHero title={joining ? `Join ${invite?.workspace ?? "the workspace"}` : "Sign in to Wisp"}>
            {joining ? (invite ? `You're invited as ${invite.role === "owner" ? "an owner" : `a ${invite.role}`}.` : "Checking your invite…") : "Where people and agents work together."}
          </AuthHero>
        )}
        {joining && invite && (
          <p className="mt-6 flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-body">
            <Check size={18} className="text-ok shrink-0" aria-hidden />
            Invite checked. It's good to use.
          </p>
        )}
        <div className="mt-8 flex flex-col gap-3.5">
          {(joining || needsSetup) && (
            <AuthField label="Your name">
              <AuthInput value={form.name} onChange={set("name")} autoComplete="name" placeholder="Your name" aria-label="Your name" required />
            </AuthField>
          )}
          {needsSetup && needsCode && !linkedCode && (
            <AuthField label="Setup code" hint="On the computer Wisp runs on, run wisp setup-code.">
              <AuthInput value={form.setupCode} onChange={set("setupCode")} placeholder="abcd-efgh-jkmn" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Setup code" required />
            </AuthField>
          )}
          <AuthField label="Email">
            <AuthInput type="email" value={form.email} onChange={set("email")} autoComplete="email" placeholder="you@example.com" aria-label="Email" required />
          </AuthField>
          <AuthField label="Password" hint={joining ? "At least 8 characters." : undefined}>
            <AuthInput
              type="password"
              value={form.password}
              onChange={set("password")}
              autoComplete={needsSetup || joining ? "new-password" : "current-password"}
              minLength={needsSetup || joining ? 8 : undefined}
              placeholder={needsSetup || joining ? "At least 8 characters" : "Password"}
              aria-label="Password"
              required
            />
          </AuthField>
          <AuthError>{error}</AuthError>
        </div>
        <div className="mt-8 flex flex-col items-center gap-1.5">
          <AuthButton className={needsSetup ? "setup-press h-[42px] rounded-lg" : undefined} disabled={busy || (joining && !invite)}>{needsSetup ? "Continue" : joining ? (invite ? `Join ${invite.workspace}` : "Join") : "Sign in"}</AuthButton>
          {joining && <AuthLink onClick={leaveInvite}>I already have an account</AuthLink>}
          {!needsSetup && !joining && (
            <AuthLink
              onClick={() => {
                setError(null);
                setPasting(true);
              }}
            >
              Have an invite link? Join
            </AuthLink>
          )}
        </div>
      </form>
  );
  // the first run's account screen stands on the setup stage, with the wisp beside it
  return needsSetup ? (
    <SetupShell at={0} stepKey="account" line="Hi. Make your account first. It's how you sign in to Wisp from any device.">
      <div className="ob-narrow">{page}</div>
    </SetupShell>
  ) : (
    <AuthPage>{page}</AuthPage>
  );
}
