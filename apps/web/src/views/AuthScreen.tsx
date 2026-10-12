import { useEffect, useState, type FormEvent } from "react";
import { Moon, Sun } from "lucide-react";
import { api } from "../api.ts";
import { useAppearance } from "../theme.ts";
import { Button, Field, GhostMark, Input } from "../components/ui.tsx";

export function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const { resolvedMode, toggleMode } = useAppearance();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [form, setForm] = useState({ email: "", password: "", name: "", workspaceName: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("GET", "/api/setup")
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => setError("Can't reach the Warren hub."));
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = needsSetup
        ? await api<{ token: string }>("POST", "/api/setup", { ...form, workspaceName: form.workspaceName || "Warren" })
        : await api<{ token: string }>("POST", "/api/auth/login", { email: form.email, password: form.password });
      if (needsSetup) location.hash = "#/welcome";
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
          <GhostMark size={18} className="text-accent-text" /> Warren
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold">{needsSetup ? "Set up Warren" : "Sign in to Warren"}</h1>
          <p className="text-sm text-muted">{needsSetup ? "You'll be the owner of this workspace." : "Where people and agents work together."}</p>
        </div>
        {needsSetup === null && !error ? (
          <p className="text-sm text-muted">Connecting…</p>
        ) : (
          <div className="space-y-4">
            {needsSetup && (
              <>
                <Field label="Your name">
                  <Input value={form.name} onChange={set("name")} autoComplete="name" required />
                </Field>
                <Field label="Workspace name">
                  <Input value={form.workspaceName} onChange={set("workspaceName")} placeholder="Warren" />
                </Field>
              </>
            )}
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
            </Field>
            <Field label="Password" hint={needsSetup ? "At least 8 characters." : undefined}>
              <Input type="password" value={form.password} onChange={set("password")} autoComplete={needsSetup ? "new-password" : "current-password"} minLength={needsSetup ? 8 : undefined} required />
            </Field>
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button variant="primary" className="w-full h-10" disabled={busy}>
              {needsSetup ? "Create workspace" : "Sign in"}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
