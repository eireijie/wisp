import { useEffect, useState, type ReactNode } from "react";
import { Bell, Check, Laptop, LogOut, Moon, Smartphone, Sun, SunMoon, Volume2 } from "lucide-react";
import { api } from "../../api.ts";
import { useStore, usePrefs } from "../../store.ts";
import { href } from "../../router.ts";
import { THEMES, useAppearance, type ModeChoice } from "../../theme.ts";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../../push.ts";
import { androidPush, useAndroidPush } from "../../push-android.ts";
import { chime, enableNotifications, permission, setNotifyPrefs, show, useNotifyPrefs, type NotifyPrefs } from "../../notifications.ts";
import { Button, Field, IconButton, Input, Pill, UserAvatar, clockTime, cx, timeAgo } from "../../components/ui.tsx";
import { Card, PageHeader, Row, SavedNote, Section, Segmented, Toggle, useSavedFlash } from "./parts.tsx";
import { useFeature } from "../../features.ts";

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// --- Profile ----------------------------------------------------------------------------------

export function ProfilePage() {
  const me = useStore((s) => s.me)!;
  const [f, setF] = useState({ name: me.user.name, email: me.user.email, preferredName: me.user.preferredName ?? "", timezone: me.user.timezone ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();
  const dirty = f.name !== me.user.name || f.email !== me.user.email || f.preferredName !== (me.user.preferredName ?? "") || f.timezone !== (me.user.timezone ?? "");

  const patchMe = async (patch: Record<string, unknown>) => {
    const user = await api<typeof me.user>("PATCH", "/api/me", patch);
    useStore.setState((s) => (s.me ? { me: { ...s.me, user } } : {}));
    useStore.getState().load();
    flash();
    return user;
  };
  const applyDetected = async () => {
    setBusy(true);
    setError(null);
    try {
      await patchMe({ timezone: HERE });
      setF((p) => ({ ...p, timezone: HERE }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patchMe({ name: f.name, email: f.email, preferredName: f.preferredName.trim() || null, timezone: f.timezone || null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Profile">How you show up to people and agents in {me.workspace.name}.</PageHeader>
      <form onSubmit={save} className="space-y-6 max-w-lg">
        <div className="flex items-center gap-4">
          <UserAvatar name={f.name || me.user.name} size={56} />
          <div className="text-sm">
            <div className="font-medium">{f.name || me.user.name}</div>
            <div className="text-muted capitalize">{me.role}</div>
          </div>
        </div>
        <Field label="Full name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} />
        </Field>
        <Field label="What should agents call you?" hint="Agents use this when they talk to you and when they remember things about you.">
          <Input value={f.preferredName} onChange={(e) => setF({ ...f, preferredName: e.target.value })} placeholder={me.user.name.split(" ")[0]} maxLength={40} />
        </Field>
        <Field label="Email" hint="You sign in with it.">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        {!me.user.timezone && !f.timezone && HERE !== "UTC" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
            <span>Your time zone isn't set, so agents see UTC.</span>
            <button type="button" disabled={busy} className="shrink-0 text-accent-text hover:underline disabled:opacity-50" onClick={applyDetected}>
              Use {HERE.replace(/_/g, " ")} (detected)
            </button>
          </div>
        )}
        <Field
          label="Time zone"
          hint={
            <>
              Agents see your local time, so "tomorrow morning" means yours, and routines you teach run on your clock.{" "}
              {f.timezone !== HERE && (
                <button type="button" className="text-accent-text hover:underline" onClick={() => setF({ ...f, timezone: HERE })}>
                  Use this device's ({HERE})
                </button>
              )}
            </>
          }
        >
          <select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} className="h-9 w-full rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="">Not set (agents see UTC)</option>
            {(ZONES.length ? ZONES : [HERE]).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <SavedNote shown={saved} />
        </div>
      </form>
      <p className="mt-10 text-sm text-muted">
        What agents have learned about you lives on{" "}
        <a className="text-accent-text hover:underline" href={href({ view: "about" })}>
          About you
        </a>
        , where you can fix or delete any of it.
      </p>
    </>
  );
}

// --- Preferences ------------------------------------------------------------------------------

export function PreferencesPage() {
  const prefs = usePrefs();
  const setPrefs = useStore((s) => s.setPrefs);
  const [saved, flash] = useSavedFlash();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const set = async (patch: Parameters<typeof setPrefs>[0]) => {
    await setPrefs(patch);
    flash();
  };
  const now = new Date();
  return (
    <>
      <PageHeader title="App behavior">How Wisp works for you, on every device you sign in on.</PageHeader>
      <div className="mb-3 h-4">
        <SavedNote shown={saved} />
      </div>
      <Section title="How much to show" description="Simple keeps the advanced parts (teams, harness details, VM sizes, tokens, raw files) behind “Advanced” so the everyday ones stand out. Nothing is removed; you can switch any time.">
        <Card>
          <Row label="Experience" hint={prefs.experience === "simple" ? "The everyday parts first; advanced options a click away." : "Everything, all the time."}>
            <Segmented
              label="Experience"
              value={prefs.experience}
              onChange={(v) => set({ experience: v })}
              options={[
                ["simple", "Simple"],
                ["advanced", "Advanced"],
              ]}
            />
          </Row>
        </Card>
      </Section>
      <Section title="Messages">
        <Card>
          <Row label="Sending a message" hint={prefs.sendWith === "enter" ? "Shift + Enter starts a new line." : "Enter starts a new line, for longer messages."}>
            <Segmented
              label="Sending a message"
              value={prefs.sendWith}
              onChange={(v) => set({ sendWith: v })}
              options={[
                ["enter", "Enter sends"],
                ["mod-enter", `${mac ? "⌘" : "Ctrl"} + Enter sends`],
              ]}
            />
          </Row>
          <Row label="Clock" hint={`Times show as ${clockTime(now, prefs.clock)}.`}>
            <Segmented
              label="Clock"
              value={prefs.clock}
              onChange={(v) => set({ clock: v })}
              options={[
                ["auto", "Automatic"],
                ["12h", "12-hour"],
                ["24h", "24-hour"],
              ]}
            />
          </Row>
        </Card>
      </Section>
      <Section title="Agents">
        <Card>
          <Row label="Tools agents used" hint="Under each reply: which tools an agent called and what came back. Memory it saved about you always shows.">
            <Segmented
              label="Tools agents used"
              value={prefs.toolCalls}
              onChange={(v) => set({ toolCalls: v })}
              options={[
                ["collapsed", "Collapsed"],
                ["expanded", "Open"],
                ["hidden", "Hidden"],
              ]}
            />
          </Row>
        </Card>
      </Section>
    </>
  );
}

// --- Notifications ----------------------------------------------------------------------------

export type NotifyKey = "on" | "off" | "blocked" | "ask" | "unsupported";

/** What notifications are doing on THIS device, in plain words. */
export function notifyStatus(perm: NotificationPermission | "unsupported", enabled: boolean): { key: NotifyKey; label: string; hint: string } {
  if (perm === "unsupported") return { key: "unsupported", label: "Not available in this browser", hint: "This browser can't show notifications. On an iPhone, add Wisp to your Home Screen first (Share, then Add to Home Screen)." };
  if (perm === "denied") return { key: "blocked", label: "Blocked by your browser", hint: "Your browser is blocking them for this site. Allow notifications in the site's settings (the icon left of the address), then reload." };
  if (perm === "default") return { key: "ask", label: "Not asked yet", hint: "Your browser will ask for permission when you turn them on." };
  return enabled ? { key: "on", label: "On", hint: "You'll get notifications on this device." } : { key: "off", label: "Off", hint: "Switched off on this device. Switch it on to get them." };
}

const statusTone = { on: "ok", off: "neutral", blocked: "bad", ask: "warn", unsupported: "neutral" } as const;

/** Push state for this device, shared by the main switch and the push section. */
function usePush() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void currentSubscription().then((s) => setOn(!!s), () => setOn(false));
  }, []);
  const change = async (want: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (want) {
        const r = await enablePush();
        if (r.ok) setOn(true);
        else setNote(r.reason);
      } else {
        await disablePush();
        setOn(false);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    const r = await api<{ sent: number }>("POST", "/api/push/test").catch(() => ({ sent: 0 }));
    setNote(r.sent ? "Sent. It should arrive in a few seconds." : "Nothing was sent. Turn push off and on again.");
  };
  return { on, busy, note, change, test };
}

export function NotificationsPage() {
  // Wisp's Android app: a web view can't do Web Push, so the app's own push is shown instead
  if (androidPush()) return <AndroidNotificationsPage />;
  return <BrowserNotificationsPage />;
}

/** Notifications in the Android app: status of its native push, and a test. */
function AndroidNotificationsPage() {
  const push = useAndroidPush();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status =
    push.hubReady === null
      ? { label: "Checking…", tone: "neutral" as const, hint: "Asking your Wisp whether it can send notifications." }
      : !push.hubReady
        ? { label: "Not set up", tone: "neutral" as const, hint: "The owner of this Wisp hasn't connected Firebase yet, so phones can't be notified while the app is closed. See the deploy guide's Android push section." }
        : !push.allowed
          ? { label: "Off", tone: "warn" as const, hint: "Allow notifications to hear from agents while Wisp is closed." }
          : push.registered
            ? { label: "On", tone: "ok" as const, hint: "You'll get notifications on this phone, even with Wisp closed." }
            : { label: "Connecting…", tone: "warn" as const, hint: "Allowed. Registering this phone with your Wisp." };
  const sendTest = async () => {
    setBusy(true);
    setNote(null);
    const ok = await push.test();
    setNote(ok ? "Sent. It should arrive in a few seconds." : "Nothing was sent. Check that notifications are on for Wisp in your phone's settings.");
    setBusy(false);
  };
  return (
    <>
      <PageHeader title="Notifications">Get a notification when an agent writes to you, wants your OK, or needs you on its computer, even with Wisp closed.</PageHeader>
      <Section title="On this phone">
        <Card>
          <Row
            label={
              <span className="inline-flex items-center gap-2">
                <Smartphone size={15} /> Notifications on this phone
              </span>
            }
            hint={status.hint}
          >
            <Pill tone={status.tone}>{status.label}</Pill>
            {push.hubReady && !push.allowed && (
              <Button variant="primary" onClick={push.turnOn}>
                Turn on notifications
              </Button>
            )}
          </Row>
          {push.hubReady && push.allowed && push.registered && (
            <Row label="Send a test notification" hint="Check that it reaches this phone.">
              <Button disabled={busy} onClick={() => void sendTest()}>
                Send a test notification
              </Button>
            </Row>
          )}
        </Card>
        {note && (
          <p role="status" className="mt-2 text-sm text-muted">
            {note}
          </p>
        )}
      </Section>
    </>
  );
}

function BrowserNotificationsPage() {
  const prefs = useNotifyPrefs();
  const tasksOn = useFeature("tasks");
  const push = usePush();
  const [perm, setPerm] = useState(permission());
  const [starting, setStarting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const status = notifyStatus(perm, prefs.enabled);
  const on = status.key === "on";
  const turnOn = async () => {
    setStarting(true);
    try {
      const p = await enableNotifications();
      setPerm(p);
      // so they also arrive while Wisp is closed; if that can't be done, say why but keep going
      if (p === "granted" && pushSupported()) await push.change(true);
    } finally {
      setStarting(false);
    }
  };
  const toggle = (k: keyof NotifyPrefs) => (v: boolean) => setNotifyPrefs({ [k]: v });
  const sendTest = () => {
    show("Wisp", "Notifications work on this device.", undefined, { test: true });
    setTestNote("Sent. You should see it now. If not, check your computer's notification settings.");
  };
  const events: [keyof NotifyPrefs, string, string][] = [
    ["dms", "Direct messages", "An agent writes to you in a DM."],
    ["replies", "Replies to you", "An agent answers in a thread you started."],
    ["approvals", "Approvals", "An agent wants your OK before it does something."],
    ["help", "Help on a computer", "An agent needs you to sign in, enter a code or check something on its screen."],
    ["tasks", "Finished tasks", "A task you handed off is done, or couldn't be done."],
  ];
  const shownEvents = tasksOn ? events : events.filter(([k]) => k !== "tasks");
  return (
    <>
      <PageHeader title="Notifications">Get a notification when something needs you, on this device.</PageHeader>
      <Section title="Notify me when a task finishes or needs me">
        <Card>
          <Row
            label={
              <span className="inline-flex items-center gap-2">
                <Bell size={15} /> Notifications on this device
              </span>
            }
            hint={status.hint}
          >
            <Pill tone={statusTone[status.key]}>{status.label}</Pill>
            {status.key === "ask" && (
              <Button variant="primary" disabled={starting} onClick={() => void turnOn()}>
                {starting ? "Turning on…" : "Turn on notifications"}
              </Button>
            )}
            {perm === "granted" && <Toggle label="Notifications on this device" on={prefs.enabled} onChange={toggle("enabled")} />}
          </Row>
          {perm === "granted" && (
            <Row label="Send a test notification" hint="Check that it shows up on this device.">
              <Button onClick={sendTest}>Send a test notification</Button>
            </Row>
          )}
        </Card>
        {testNote && perm === "granted" && (
          <p role="status" className="mt-2 text-sm text-muted">
            {testNote}
          </p>
        )}
      </Section>
      <Section title="While Wisp is open" description="Shows a notification while Wisp is open in a tab or window.">
        <Card>
          <Row label="Notifications while Wisp is open" hint="Uses the main switch above.">
            <Pill tone={on ? "ok" : "neutral"}>{on ? "On" : "Off"}</Pill>
          </Row>
          {on && (
            <Row label="Only when I'm away" hint="Stay quiet while Wisp is the window you're using.">
              <Toggle label="Only when I'm away" on={prefs.onlyAway} onChange={toggle("onlyAway")} />
            </Row>
          )}
          {on && (
            <Row label="Play a sound" hint="A short chime with each notification.">
              <IconButton icon={<Volume2 size={15} />} label="Play the sound" onClick={chime} />
              <Toggle label="Play a sound" on={prefs.sound} onChange={toggle("sound")} />
            </Row>
          )}
        </Card>
      </Section>
      <PushSection push={push} />
      <Section title="Tell me about">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Pill tone={on ? "ok" : "warn"}>{on ? "Active" : "Paused"}</Pill>
          {on ? "You'll get these on this device." : "These are saved, but you won't get any until notifications are on."}
        </p>
        <Card>
          {shownEvents.map(([k, label, hint]) => (
            <Row key={k} label={label} hint={hint}>
              <Toggle label={label} on={!!prefs[k]} onChange={toggle(k)} />
            </Row>
          ))}
        </Card>
      </Section>
    </>
  );
}

/** Push: agents reach this device even while Wisp is closed, like a text from an assistant. */
function PushSection({ push }: { push: ReturnType<typeof usePush> }) {
  const { on, busy, note, change, test } = push;
  return (
    <Section title="Even when Wisp is closed (push)" description="This device gets them like a text message, even with Wisp closed: when an agent writes to you, or wants your OK before it sends something.">
      <Card>
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              <Smartphone size={15} /> Push to this device
            </span>
          }
          hint={!pushSupported() ? (/iPhone|iPad/.test(navigator.userAgent) ? "On iPhone, add Wisp to your Home Screen (Share → Add to Home Screen) and open it from there." : "This browser can't receive push notifications.") : on ? "On." : "Off. Your browser will ask for permission."}
        >
          {pushSupported() && on !== null && <Toggle label="Push to this device" on={on} disabled={busy} onChange={(v) => void change(v)} />}
        </Row>
      </Card>
      {note && <p role="status" className="mt-2 text-sm text-muted">{note}</p>}
      {on && (
        <Button className="mt-3" onClick={() => void test()}>
          Send a test push
        </Button>
      )}
    </Section>
  );
}

// --- Appearance -------------------------------------------------------------------------------

export function AppearancePage() {
  const { mode, resolvedMode, theme, textSize, reduceMotion, setMode, setTheme, setTextSize, setReduceMotion } = useAppearance();
  const modes: [ModeChoice, ReactNode][] = [
    ["system", <><SunMoon size={14} /> System</>],
    ["light", <><Sun size={14} /> Light</>],
    ["dark", <><Moon size={14} /> Dark</>],
  ];
  return (
    <>
      <PageHeader title="Appearance">How Wisp looks on this device.</PageHeader>
      <Section title="Mode">
        <Segmented label="Mode" value={mode} options={modes} onChange={setMode} />
      </Section>
      <Section title="Theme" description="Every theme works in light and dark. Agents keep their own colors in all of them.">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              // each card carries its own theme, so its preview shows that theme's colors
              <button
                key={t.id}
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(t.id)}
                data-theme={t.id}
                data-mode={resolvedMode}
                className={cx("text-left rounded-xl border p-3 transition-colors", selected ? "border-accent ring-1 ring-accent" : "border-line hover:bg-hover")}
              >
                <div className="rounded-lg border border-line bg-bg p-2.5 space-y-2" aria-hidden>
                  <div className="flex items-center gap-1.5">
                    <span className="h-6 px-2.5 rounded-full bg-accent text-accent-ink text-[11px] font-medium inline-flex items-center">New agent</span>
                    <span className="text-[11px] text-accent-text underline underline-offset-2">a link</span>
                  </div>
                  <div className="h-6 rounded-md bg-accent-soft px-2 flex items-center gap-1.5 text-[11px] text-ink">
                    <span className="size-1.5 rounded-full bg-accent" /># launch
                  </div>
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-sm font-medium flex-1">{t.name}</span>
                  {selected && <Check size={15} className="text-accent-text" />}
                </div>
                <p className="text-xs text-muted mt-0.5">{t.blurb}</p>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Accessibility">
        <Card>
          <Row label="Text size" hint="Makes text and spacing smaller or bigger.">
            <Segmented
              label="Text size"
              value={textSize}
              onChange={setTextSize}
              options={[
                ["small", "Small"],
                ["default", "Default"],
                ["large", "Large"],
              ]}
            />
          </Row>
          <Row label="Reduce motion" hint="Keeps ghosts and transitions still. Your system's reduce-motion setting does this too.">
            <Toggle label="Reduce motion" on={reduceMotion} onChange={setReduceMotion} />
          </Row>
        </Card>
      </Section>
    </>
  );
}

// --- Security ---------------------------------------------------------------------------------

interface Session {
  id: string;
  label: string;
  createdAt: string;
  lastUsed: string | null;
  current: boolean;
}

export function SecurityPage() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Session[]>("GET", "/api/me/sessions").then(setSessions, (e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);
  const signOut = async (s: Session) => {
    await api("DELETE", `/api/me/sessions/${s.id}`).catch((e) => setError((e as Error).message));
    load();
  };
  const others = (sessions ?? []).filter((s) => !s.current);
  const icon = (label: string) => (/iPhone|Android|iPad/.test(label) ? <Smartphone size={16} /> : <Laptop size={16} />);
  return (
    <>
      <PageHeader title="Security">Your password, and the browsers and apps you're signed in on.</PageHeader>
      <PasswordForm onChanged={load} />
      <Section
        title="Where you're signed in"
        description="Sign out of anything you don't recognize. Changing your password signs out everything else too."
        action={
          others.length > 0 && (
            <Button
              onClick={async () => {
                await api("POST", "/api/me/sessions/sign-out-others").catch((e) => setError((e as Error).message));
                load();
              }}
            >
              <LogOut size={14} /> Sign out everywhere else
            </Button>
          )
        }
      >
        {error && <p className="mb-2 text-sm text-bad">{error}</p>}
        <Card>
          {(sessions ?? []).map((s) => (
            <div key={s.id} className="px-4 py-3 flex items-center gap-3">
              <span className="size-8 rounded-lg bg-chip grid place-items-center text-muted shrink-0">{icon(s.label)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium flex items-center gap-2">
                  {s.label === "login" || s.label === "setup" ? "A browser" : s.label}
                  {s.current && <Pill tone="ok">This device</Pill>}
                </div>
                <div className="text-xs text-muted">
                  Signed in {timeAgo(s.createdAt)}
                  {s.lastUsed && !s.current ? ` · last active ${timeAgo(s.lastUsed)}` : ""}
                </div>
              </div>
              {!s.current && (
                <Button variant="ghost" onClick={() => signOut(s)}>
                  Sign out
                </Button>
              )}
            </div>
          ))}
          {sessions === null && <p className="px-4 py-3 text-sm text-muted">Loading…</p>}
        </Card>
      </Section>
    </>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flash] = useSavedFlash();
  return (
    <Section title="Password">
      <form
        className="space-y-4 max-w-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (f.next !== f.again) return setError("The new passwords don't match.");
          setBusy(true);
          try {
            await api("POST", "/api/me/password", { current: f.current, next: f.next });
            setF({ current: "", next: "", again: "" });
            flash();
            onChanged();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input type="password" autoComplete="new-password" minLength={8} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
        </Field>
        <Field label="New password again">
          <Input type="password" autoComplete="new-password" minLength={8} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
          <SavedNote shown={saved} />
        </div>
      </form>
    </Section>
  );
}

