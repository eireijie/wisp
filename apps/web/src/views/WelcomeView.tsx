import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api.ts";
import { awayEnabled, enableTailscale } from "../components/Access.tsx";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { completeSetupStep, nextStep, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { canApproveJoin, unavailable } from "../join.ts";
import { AddDeviceContent } from "../components/AddDevice.tsx";
import { AuthButton, AuthInput, AuthLink } from "../components/auth.tsx";
import { PhonePairing } from "./settings/mobile.tsx";
import { cx } from "../components/ui.tsx";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import { RowState, WHITE_WISP, type StageScene } from "../components/SetupStage.tsx";
import { SetupShell, StepHead } from "../components/SetupShell.tsx";
import type { GhostMood } from "../components/Ghost.tsx";
import { MemoryImport, type Askable } from "../components/MemoryImport.tsx";
import type { MemoryLine } from "@wisp/core/src/memory-import.ts";
import { ConnectStep, type Powered } from "./onboarding/ConnectStep.tsx";
import { NameStep } from "./onboarding/NameStep.tsx";
import { SetupProgress } from "./onboarding/SetupProgress.tsx";
export { makeFirstAgent } from "./onboarding/firstAgent.ts";

export const SETUP_LABELS: Record<StepId, string> = { anywhere: "Away from home", address: "Your address", agent: "Make your first agent", devices: "Add your devices" };

type Screen = "anywhere" | "address" | "connect" | "name" | "memory" | "setup" | "devices";
/** Where each screen sits on the five-dot track (0: before it) and what the wisp says there. */
const SCREENS: Record<Screen, { at: number; line: (name: string) => string; mood?: GhostMood }> = {
  anywhere: { at: 0, line: () => "Want to reach me when you're out?" },
  address: { at: 0, line: () => "This is where I live." },
  connect: { at: 1, line: () => "Pick the AI I run on. You only sign in once." },
  name: { at: 2, line: () => "What should I be called?" },
  memory: { at: 3, line: () => "Tell me what you're working on and I'll pick up from there." },
  setup: { at: 4, line: () => "Moving into my computer…", mood: "working" },
  devices: { at: 5, line: (n) => `Say hi to ${n} from your phone too.` },
};

/**
 * The rest of setup, once the server runs and the account exists: reach it from outside your home,
 * its address, then the five steps to your first agent: connect your AI once, name it, bring what
 * your AI already knows, set it up, and meet it in its chat.
 */
export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const { done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<Screen>(() => {
    if (intro) return onPublicAddress() ? "address" : "anywhere";
    const next = nextStep(done) ?? "anywhere";
    return next === "agent" ? "connect" : next;
  });
  const usable = usableDevices(devices ?? []).filter((d) => d.online && !d.paused);
  const device = usable.find((d) => d.mine) ?? usable[0];
  const [ready, setReady] = useState<Powered[]>([]);
  const [harness, setHarness] = useState("");
  const [name, setName] = useState("Atlas");
  const [look] = useState<GhostAppearance>(() => agents[0]?.settings.appearance ?? START_LOOK);
  const [lines, setLines] = useState<MemoryLine[]>([]);
  const powered = ready.find((r) => r.harness === harness) ?? ready[0];
  const advance = (step: StepId) => {
    completeSetupStep(me.workspace.id, step);
    const next = STEPS[STEPS.indexOf(step) + 1] ?? "devices";
    setScreen(next === "agent" ? "connect" : next);
  };
  const finish = (channelId?: string | null) => {
    completeSetupStep(me.workspace.id, "agent");
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go(channelId ? { view: "chat", channelId, threadId: null } : { view: "dashboard" });
  };
  // Back goes to the screen before, unless that would redo something done
  const back: Partial<Record<Screen, Screen>> = { address: "anywhere", name: "connect", memory: "name" };
  const before = back[screen];
  const canGoBack = !!before && !(screen === "address" && onPublicAddress());
  const s = SCREENS[screen];
  const preAgent = screen === "anywhere" || screen === "address";
  // the steps before the agent were made for a narrow panel; they keep that width in the middle
  const narrow = (node: ReactNode) => <div className="ob-narrow">{node}</div>;
  return (
    <SetupShell at={s.at} line={s.line(name.trim() || "your agent")} look={preAgent ? undefined : look} mood={s.mood} stepKey={screen} onBack={canGoBack ? () => setScreen(before!) : null}>
      {screen === "anywhere" && narrow(<AwayStep onScene={() => {}} onDone={() => advance("anywhere")} />)}
      {screen === "address" && narrow(<AddressStep onScene={() => {}} onNext={() => advance("address")} />)}
      {screen === "connect" && (
        <ConnectStep
          device={device}
          onNext={(r) => {
            setReady(r);
            if (!r.some((x) => x.harness === harness)) setHarness(r[0]?.harness ?? "");
            setScreen("name");
          }}
          onSkip={() => advance("agent")}
        />
      )}
      {screen === "name" && powered && <NameStep name={name} setName={setName} look={look} ready={ready} harness={powered.harness} setHarness={setHarness} onBack={() => setScreen("connect")} onNext={() => setScreen("memory")} />}
      {screen === "memory" && (
        <>
          <StepHead title="Bring what your AI already knows" sub={`${name.trim()} starts out knowing your projects, how you work and what you're in the middle of.`} />
          <MemoryImport
            agentName={name.trim()}
            askable={askableOn(device, ready)}
            saveLabel={`Save to ${name.trim()}'s memory`}
            onSave={(l) => {
              setLines(l);
              setScreen("setup");
            }}
            onSkip={() => {
              setLines([]);
              setScreen("setup");
            }}
          />
        </>
      )}
      {screen === "setup" && device && powered && <SetupProgress device={device} powered={powered} name={name.trim()} look={look} lines={lines} onBack={() => setScreen("memory")} onDone={(_, channelId) => finish(channelId)} />}
      {screen === "devices" && narrow(<PhoneStep onScene={() => {}} onFinish={() => finish()} />)}
    </SetupShell>
  );
}

/** Claude Code or Codex on the person's computer, signed in through Wisp, can be asked for them. */
export function askableOn(device: DeviceInfo | undefined, ready: Powered[]): Askable[] {
  if (!device?.mine) return [];
  // the hub asks with the person's connection when there is one, else the device's own sign-in
  const here = ["claude-code", "codex"].filter((id) => device.harnesses?.some((h) => h.id === id));
  const connected = (id: string) => ready.some((r) => r.harness === id && r.connectionId);
  return [...here.filter(connected), ...here.filter((id) => !connected(id))].map((harness) => ({ harness, nodeId: device.id, device: device.name }));
}

/** What the white wisp turns into when you start making your agent. */
const START_LOOK: GhostAppearance = { ...WHITE_WISP, color: "#8bd4ff", color2: "#ff51bf" };

/** A screen's title, the line under it, and what goes with them. */
function Thread({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div key={title} className="setup-rise flex-1 flex flex-col gap-3.5 pb-3.5">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] leading-tight">{title}</h1>
      {sub && <p className="text-sm text-muted">{sub}</p>}
      {children}
    </div>
  );
}

/** What you do next, at the bottom. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="shrink-0 flex flex-col gap-2.5 items-stretch">{children}</div>;
}

/** The screens' tighter button. */
function SetupButton({ className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return <AuthButton {...p} className={cx("setup-press h-[42px] rounded-lg", className)} />;
}
function Msg({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-sm text-muted", className)}>{children}</p>;
}
/** Wisp is waiting on you: three pulsing dots and what for. */
function Waiting({ children }: { children: ReactNode }) {
  return (
    <Msg className="flex items-center gap-2.5">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-muted animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
      {children}
    </Msg>
  );
}
function Problem({ children }: { children?: ReactNode }) {
  return children ? (
    <p role="alert" className="text-sm text-bad">
      {children}
    </p>
  ) : null;
}
/** A grouped list of rows on a card. */
function Group({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div role={label ? "radiogroup" : undefined} aria-label={label} className="rounded-lg border border-line bg-card overflow-hidden divide-y divide-line">
      {children}
    </div>
  );
}

/** Where your devices connect, and what that address can reach. */
export function serverAddress(info: AccessInfo | null, loc: Pick<Location, "origin" | "protocol" | "hostname"> = location): { url: string; note: string } | null {
  if (onPublicAddress(loc)) return { url: loc.origin, note: "Your devices connect here, at home or away." };
  if (!info) return null;
  if (info.publicUrl) return { url: info.publicUrl, note: info.publicUrl.endsWith(".ts.net") && !info.tailscale.funnel ? "Your devices connect here, at home or away. Any device on your Tailscale can reach it." : "Your devices connect here, at home or away." };
  return info.lan[0] ? { url: info.lan[0], note: "Your devices connect here while they're on your home network." } : null;
}

/** Your server's address, to copy. */
function AddressStep({ onScene, onNext }: { onScene: (s: StageScene) => void; onNext: () => void }) {
  const info = useAccess(3000);
  const address = serverAddress(info);
  const [copied, setCopied] = useState(false);
  useEffect(() => onScene({ name: "address", address: address?.url }), [address?.url]);
  return (
    <>
      <Thread title="Your Wisp server address" sub={address?.note}>
        {address ? (
          <div className="rounded-lg border border-line bg-card p-3.5 flex items-center justify-between gap-2.5">
            <span className="font-mono text-sm break-all">{address.url}</span>
            <button
              type="button"
              className="h-8 px-2.5 shrink-0 rounded-md bg-control border border-control-line text-[13px] font-medium hover:bg-hover"
              onClick={() => {
                void navigator.clipboard?.writeText(address.url);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <Waiting>Looking up your address</Waiting>
        )}
      </Thread>
      <Actions>
        <SetupButton onClick={onNext}>Continue</SetupButton>
      </Actions>
    </>
  );
}

/** Your phone, by QR code; other computers are one tap away. */
function PhoneStep({ onScene, onFinish }: { onScene: (s: StageScene) => void; onFinish: () => void }) {
  const [computer, setComputer] = useState(false);
  useEffect(() => onScene({ name: "phone" }), []);
  return (
    <>
      {computer ? (
        <Thread title="Add a computer">
          <AddDeviceContent phone={false} />
        </Thread>
      ) : (
        <Thread title="Add your phone" sub="Scan this with the Wisp app.">
          <div className="setup-qr"><PhonePairing autoStart compact /></div>
        </Thread>
      )}
      <Actions>
        <SetupButton onClick={onFinish}>Go to Wisp</SetupButton>
        <AuthLink className="self-center" onClick={() => setComputer(!computer)}>
          {computer ? "Add your phone instead" : "Add a computer instead"}
        </AuthLink>
      </Actions>
    </>
  );
}

/** The device's message when it has no Node.js (see NO_NODE in the node package). */
export const NO_NODE = /Node\.js isn't installed on this computer/;

/** Reach Wisp from outside your home (Tailscale or Cloudflare), or only at home. */
function AwayStep({ onScene, onDone }: { onScene: (s: StageScene) => void; onDone: () => void }) {
  const info = useAccess(3000);
  const failed = useAccessStore((s) => s.failed);
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [choice, setChoice] = useState<"tailscale" | "cloudflare" | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // each Tailscale state gets one automatic push forward; Try again clears it
  const pushed = useRef<string | null>(null);
  // the page `login` answers with; later status checks may not repeat it
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // what our own push found, tied to the state it was found in so it clears when that changes
  const [found, setFound] = useState<{ state: string; text: string } | null>(null);
  const [slow, setSlow] = useState(false);
  const state = info?.tailscale.state;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (state !== "starting") return setSlow(false);
    const t = setTimeout(() => setSlow(true), STARTING_MS);
    return () => clearTimeout(t);
  }, [state, attempt]);
  useEffect(() => {
    if (choice !== "tailscale" || !info || !allowed || !state) return;
    if (awayEnabled(info)) return onDone();
    // a state we don't push (error, starting, missing) forgets the last push, so a recovery pushes again
    if (state !== "needs-login" && state !== "running" && state !== "stopped") pushed.current = null;
    if (pushed.current === state) return;
    if (state === "needs-login" && !info.tailscale.authUrl) {
      pushed.current = state;
    } else if (state === "running" || state === "stopped") {
      pushed.current = state;
    } else return;
    void advanceTailscale(state, !!info.tailscale.authUrl).then((r) => {
      if (r.done) return onDone();
      if (r.loginUrl) setLoginUrl(r.loginUrl);
      // a late answer about a state we've already left is old news
      if (r.problem && stateRef.current === state) setFound({ state, text: r.problem });
    });
  }, [choice, info, state, allowed, attempt]);
  const tryAgain = () => {
    setFound(null);
    setSlow(false);
    pushed.current = null;
    setAttempt((n) => n + 1);
    void useAccessStore.getState().refresh(true);
  };
  const startCloudflare = async () => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const next = await api<AccessInfo>("POST", "/api/reach/cloudflare", { action: "start", token: credential.trim() });
      useAccessStore.setState({ info: next, failed: false });
      setCredential("");
      if (awayEnabled(next)) onDone();
      else setHint("Cloudflare is connecting…");
    } catch (e) {
      setError(unavailable(e, "Away from home"));
    } finally {
      setBusy(false);
    }
  };
  const only = () => {
    skipAccess();
    onDone();
  };
  useEffect(() => {
    if (choice) onScene({ name: choice === "tailscale" ? "tailscale" : "anywhere", linked: state === "running", onBack: () => setChoice(null) });
    else onScene({ name: "anywhere" });
  }, [choice, state === "running"]);
  if (choice === "tailscale") {
    const problem = tailscaleProblem({ info, failed, found: found && found.state === state ? found.text : null, slow });
    return <TailscaleScreen info={info} authUrl={info?.tailscale.authUrl ?? loginUrl} problem={problem} onRetry={tryAgain} onSkip={only} />;
  }
  if (choice === "cloudflare") {
    return (
      <form
        className="flex-1 flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void startCloudflare();
        }}
      >
        <Thread title="Connect Cloudflare" sub="Paste your Cloudflare setup code. This needs a domain you own.">
          <AuthInput type="password" autoComplete="off" className="h-[42px] rounded-lg px-3" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Setup code" aria-label="Cloudflare setup code" autoFocus />
          {hint && (
            <p role="status" className="text-sm text-muted">
              {hint}
            </p>
          )}
          <Problem>{error}</Problem>
        </Thread>
        <Actions>
          <SetupButton disabled={busy || !allowed || !credential.trim()}>
            {busy && <Loader2 size={16} className="animate-spin" />}Continue
          </SetupButton>
        </Actions>
      </form>
    );
  }
  return (
    <>
      <Thread title="Use Wisp outside your home?" sub="So your phone and laptop work on any Wi-Fi or on cell data.">
        <button type="button" className="setup-choice" disabled={!allowed} onClick={() => setChoice("tailscale")}>
          <BrandMark name="tailscale" />
          <span>
            <strong className="block text-sm font-medium">Yes, with Tailscale</strong>
            <span className="block text-[13px] text-muted">A free app that links your devices.</span>
          </span>
        </button>
        <button type="button" className="setup-choice" disabled={!allowed} onClick={() => setChoice("cloudflare")}>
          <BrandMark name="cloudflare" />
          <span>
            <strong className="block text-sm font-medium">Yes, with Cloudflare</strong>
            <span className="block text-[13px] text-muted">Needs a domain you own.</span>
          </span>
        </button>
        {!info && failed && (
          <p role="status" className="text-sm text-muted">
            Away from home isn't available yet; you can keep going.
          </p>
        )}
        {!allowed && <p className="text-sm text-muted">Your Wisp's owner can turn this on.</p>}
      </Thread>
      <Actions>
        <AuthLink className="self-center" onClick={only}>
          Only at home for now
        </AuthLink>
      </Actions>
    </>
  );
}

/** A company's own mark: Tailscale follows the theme, Cloudflare keeps its orange. */
function BrandMark({ name }: { name: "tailscale" | "cloudflare" }) {
  const src = `/brands/${name}.svg`;
  return name === "cloudflare" ? (
    <img src={src} alt="" width={24} height={24} className="shrink-0" />
  ) : (
    <span aria-hidden className="inline-block size-6 shrink-0 bg-current" style={{ mask: `url(${src}) center / contain no-repeat`, WebkitMask: `url(${src}) center / contain no-repeat` }} />
  );
}

const STARTING_MS = 20_000;

/** One automatic step forward for a Tailscale state; says what to show when it can't move on. */
export async function advanceTailscale(
  state: string,
  hasAuthUrl: boolean,
  io: { login: () => Promise<AccessInfo>; enable: () => Promise<boolean> } = { login: () => useAccessStore.getState().act("login"), enable: () => enableTailscale() },
): Promise<{ done?: true; loginUrl?: string; problem?: string }> {
  try {
    if (state === "needs-login" && !hasAuthUrl) {
      const url = (await io.login()).tailscale.authUrl;
      return url ? { loginUrl: url } : { problem: "Wisp couldn't get the Tailscale sign-in page. Try again." };
    }
    if (state === "running" || state === "stopped") {
      return (await io.enable()) ? { done: true } : { problem: "Tailscale isn't ready yet. Open the Tailscale app, make sure you're signed in and connected, then try again." };
    }
  } catch (e) {
    return { problem: unavailable(e, "Tailscale") };
  }
  return {};
}

/** What to tell the person when the Tailscale screen can't move on; null while things are fine or still working. */
export function tailscaleProblem({ info, failed, found, error, slow }: { info: AccessInfo | null; failed: boolean; found?: string | null; error?: string | null; slow?: boolean }): string | null {
  if (failed) return "Wisp couldn't check Tailscale on this computer. Try again.";
  if (error) return error;
  if (found) return found;
  const t = info?.tailscale;
  if (!t || t.state === "missing") return null;
  if (t.error) return t.error;
  if (t.state === "error") return "Tailscale didn't answer. Open the Tailscale app, then try again.";
  if (t.state === "starting" && slow) return "Tailscale is taking a while to connect. Open the Tailscale app to check, then try again.";
  return null;
}

export function TailscaleScreen({ info, authUrl, problem, onRetry, onSkip }: { info: AccessInfo | null; authUrl?: string | null; problem: string | null; onRetry: () => void; onSkip: () => void }) {
  const state = info?.tailscale.state;
  return (
    <>
      <Thread title="Connect Tailscale" sub="Wisp moves on by itself once both are done.">
        <Group>
          <StatusRow state={!state || state === "missing" ? "working" : "done"} text="Tailscale is installed">
            {state === "missing" && info && (
              <a href={info.download} target="_blank" rel="noreferrer" className="block text-[13px] text-info hover:underline">
                Install Tailscale
              </a>
            )}
          </StatusRow>
          <StatusRow state={state === "running" ? "done" : !state || state === "missing" ? "off" : "working"} text="Sign in to Tailscale">
            {authUrl && state !== "running" && (
              <a href={authUrl} target="_blank" rel="noreferrer" className="block text-[13px] text-info hover:underline">
                Open the Tailscale sign-in page
              </a>
            )}
          </StatusRow>
        </Group>
        <Problem>{problem}</Problem>
        {!problem && state === "starting" && <Waiting>Tailscale is connecting</Waiting>}
        {!problem && state === "needs-login" && !authUrl && <Waiting>Getting the sign-in page</Waiting>}
      </Thread>
      <Actions>
        {problem && <SetupButton onClick={onRetry}>Try again</SetupButton>}
        <AuthLink className="self-center" onClick={onSkip}>
          Only at home for now
        </AuthLink>
      </Actions>
    </>
  );
}

function StatusRow({ state, text, children }: { state: "done" | "working" | "off"; text: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 text-sm">
      <RowState state={state} />
      <span className={cx("flex-1 min-w-0", state === "off" && "text-faint")}>
        {text}
        {children}
      </span>
    </div>
  );
}
