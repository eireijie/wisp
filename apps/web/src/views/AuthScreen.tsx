import { useEffect, useState, type FormEvent } from "react";
import { Moon, Sun } from "lucide-react";
import { api } from "../api.ts";
import { useAppearance } from "../theme.ts";
import { Button, Field, GhostMark, Input } from "../components/ui.tsx";

/** An invite link: #/join/<code>. */
const inviteCode = () => location.hash.match(/^#\/join\/([\w-]+)/)?.[1] ?? null;
/** The link the desktop app and installer open on a new Wisp: #/setup/<setup code>. */
const linkedSetupCode = () => location.hash.match(/^#\/setup\/([\w-]+)/)?.[1] ?? "";

export function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const { resolvedMode, toggleMode } = useAppearance();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [linkedCode] = useState(linkedSetupCode);
  const [form, setForm] = useState({ email: "", password: "", name: "", workspaceName: "", setupCode: linkedCode });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(inviteCode);
  const [invite, setInvite] = useState<{ workspace: string; role: string } | null>(null);

  useEffect(() => {
    api<{ needsSetup: boolean; needsCode?: boolean }>("GET", "/api/setup")
      .then((r) => {
        setNeedsSetup(r.needsSetup);
        setNeedsCode(!!r.needsCode);
      })
      .catch(() => setError("Can't reach your Wisp."));
  }, []);
  useEffect(() => {
    if (!code) return;
    api<{ workspace: string; role: string }>("GET", `/api/invites/check?code=${encodeURIComponent(code)}`).then(setInvite, (e) => setError((e as Error).message));
  }, [code]);
  const joining = !!code && !needsSetup;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = needsSetup
        ? await api<{ token: string }>("POST", "/api/setup", { ...form, workspaceName: form.workspaceName.trim() || `${form.name.trim()}'s Wisp`, features: "simple", setupCode: form.setupCode.trim() || undefined })
        : joining
          ? await api<{ token: string }>("POST", "/api/invites/accept", { code, name: form.name, email: form.email, password: form.password })
          : await api<{ token: string }>("POST", "/api/auth/login", { email: form.email, password: form.password });
      if (needsSetup || joining) {
        // New account: start it on this device's time zone so agents and routines don't fall back to UTC. Best-effort.
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (timezone) await api("PATCH", "/api/me", { timezone }, { headers: { authorization: `Bearer ${r.token}` } }).catch(() => {});
      }
      if (needsSetup) {
        await api("PUT", "/api/me/prefs", { experience: "simple" }, { headers: { authorization: `Bearer ${r.token}` } }).catch(() => {});
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

  return (
    <div className="relative min-h-full bg-panel flex items-center px-6 sm:px-8 py-10 safe-top">
      <button onClick={toggleMode} className="absolute top-4 right-4 p-2 rounded-lg text-muted hover:text-ink hover:bg-hover" aria-label={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
        {resolvedMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <form onSubmit={submit} className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-1.5 font-semibold">
          <GhostMark size={18} className="text-accent-text" /> Wisp
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold">{needsSetup ? "Set up Wisp" : joining ? `Join ${invite?.workspace ?? "the workspace"}` : "Sign in to Wisp"}</h1>
          <p className="text-sm text-muted">
            {needsSetup ? "You'll be the owner of this organization." : joining ? (invite ? `You're invited as ${invite.role === "owner" ? "an owner" : `a ${invite.role}`}. Make your account.` : "Checking your invite…") : "Where people and agents work together."}
          </p>
        </div>
        {needsSetup === null && !error ? (
          <p className="text-sm text-muted">Connecting…</p>
        ) : (
          <div className="space-y-4">
            {joining && (
              <Field label="Your name">
                <Input value={form.name} onChange={set("name")} autoComplete="name" required />
              </Field>
            )}
            {needsSetup && (
              <>
                <Field label="Your name">
                  <Input value={form.name} onChange={set("name")} autoComplete="name" required />
                </Field>
                <Field label="Your Wisp">
                  <Input value={form.workspaceName} onChange={set("workspaceName")} placeholder={form.name.trim() ? `${form.name.trim()}'s Wisp` : "Your Wisp"} />
                </Field>
                {needsCode && !linkedCode && (
                  <Field label="Setup code" hint="On the computer Wisp runs on, run wisp setup-code.">
                    <Input value={form.setupCode} onChange={set("setupCode")} placeholder="abcd-efgh-jkmn" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
                  </Field>
                )}
              </>
            )}
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
            </Field>
            <Field label="Password" hint={needsSetup || joining ? "At least 8 characters." : undefined}>
              <Input type="password" value={form.password} onChange={set("password")} autoComplete={needsSetup || joining ? "new-password" : "current-password"} minLength={needsSetup || joining ? 8 : undefined} required />
            </Field>
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button variant="primary" className="w-full h-10" disabled={busy || (joining && !invite)}>
              {needsSetup ? "Start Wisp" : joining ? "Join" : "Sign in"}
            </Button>
            {joining && (
              <button
                type="button"
                className="w-full text-sm text-muted hover:text-ink"
                onClick={() => {
                  location.hash = "#/";
                  setCode(null);
                  setError(null);
                }}
              >
                I already have an account
              </button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
