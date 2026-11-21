import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api.ts";
import { awayEnabled, enableTailscale } from "../components/Access.tsx";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { completeSetupStep, nextStep, savedSetup, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
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
import { NEW_TRACK, SetupShell, StepHead } from "../components/SetupShell.tsx";
import type { GhostMood } from "../components/Ghost.tsx";
import { MemoryImport, type Askable } from "../components/MemoryImport.tsx";
import type { MemoryLine } from "@wisp/core/src/memory-import.ts";
import { ConnectStep, type Powered } from "./onboarding/ConnectStep.tsx";
import { NameStep } from "./onboarding/NameStep.tsx";
import { SetupProgress } from "./onboarding/SetupProgress.tsx";
import { HelloNext } from "../components/HelloStep.tsx";
import { loadAnswers, saveAnswers } from "../onboardingV3.ts";
import { KnowStep, StillLearning } from "../components/onboarding/KnowStep.tsx";
import { flushNotes } from "../onboardingKnow.ts";
import { saveAgentDraft } from "../onboardingV3.ts";
import { AgentStep } from "./onboarding/AgentStep.tsx";
import { AIStep, draftOf } from "./onboarding/AIStep.tsx";
import { SlideMark, SlideOpen } from "../components/onboarding/obMotion.tsx";
import { hostReact } from "../components/onboarding/HostGhost.tsx";
export { makeFirstAgent } from "./onboarding/firstAgent.ts";

export const SETUP_LABELS: Record<StepId, string> = { anywhere: "Away from home", address: "Your address", agent: "Make your first agent", devices: "Add your devices" };

type Screen = "anywhere" | "address" | "connect" | "name" | "memory" | "setup" | "devices";
/** Where each screen sits on the five-dot track (0: before it) and what the wisp says there. */
const SCREENS: Record<Screen, { at: number; line: (name: string) => string; mood?: GhostMood }> = {
  anywhere: { at: 0, line: () => "Want me on your phone when you're out?" },
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
  // a new setup (#/welcome/intro): away and address (the old screens), then v3's know, agent and AI
  // pages in place of the old connect, name, memory and setup screens, then the agent's chat
  type V3 = "know" | "agent" | "ai";
  const firstV3 = (): V3 => {
    const a = loadAnswers(me.workspace.id);
    return !a.knowDone ? "know" : !a.agentDraft ? "agent" : "ai";
  };
  // after a reload mid-setup, pick up at the first v3 page not done yet (away and address are saved as done)
  const [v3, setV3] = useState<V3 | null>(() => (intro && savedSetup(me.workspace.id).address ? firstV3() : null));
  const [screen, setScreen] = useState<Screen>(() => {
    // resuming on a v3 page: Back from it lands on the address screen, the last one before it
    // Away and its address are one page now; a cloud server (already reachable) only shows its address
    if (intro) return onPublicAddress() ? "address" : "anywhere";
    const next = nextStep(done) ?? "anywhere";
    return next === "agent" ? "connect" : next;
  });
  const usable = usableDevices(devices ?? []).filter((d) => d.online && !d.paused);
  const device = usable.find((d) => d.mine) ?? usable[0];
  const [ready, setReady] = useState<Powered[]>([]);
  const [harness, setHarness] = useState("");
  const [name, setName] = useState("Atlas");
  // the look picked on Make me yours carries through every later step (the agent's own look once it exists)
  const drafted = loadAnswers(me.workspace.id).agentDraft ? draftOf(me.workspace.id).look : null;
  const look: GhostAppearance = agents[0]?.settings.appearance ?? drafted ?? START_LOOK;
  const [lines, setLines] = useState<MemoryLine[]>([]);
  const [awayChoice, setAwayChoice] = useState<AwayChoice | null>(null);
  const powered = ready.find((r) => r.harness === harness) ?? ready[0];
  const advance = (step: StepId) => {
    completeSetupStep(me.workspace.id, step);
    const next = STEPS[STEPS.indexOf(step) + 1] ?? "devices";
    if (next === "agent" && intro) return setV3(firstV3());
    setScreen(next === "agent" ? "connect" : next);
  };
  const finish = (channelId?: string | null) => {
    completeSetupStep(me.workspace.id, "agent");
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go(channelId ? { view: "chat", channelId, threadId: null } : { view: "dashboard" });
  };
  // Back goes to the screen before, unless that would redo something done
  const back: Partial<Record<Screen, Screen>> = { address: "anywhere", connect: onPublicAddress() ? "address" : "anywhere", name: "connect", memory: "name", devices: "connect" };
  const before = back[screen];
  const canGoBack = !!before && !(screen === "address" && onPublicAddress());
  // a step's own inner screen (Tailscale, Cloudflare) goes back to that step's choices first
  const [inner, setInner] = useState<{ screen: Screen; back: () => void } | null>(null);
  const onScene = (sc: StageScene) => setInner(sc.onBack ? { screen, back: sc.onBack } : null);
  const innerBack = inner && inner.screen === screen ? inner.back : null;
  // in a new setup, the phone step (after skipping the AI) goes back to the AI page
  const goBack = innerBack ?? (intro && screen === "devices" ? () => setV3("ai") : canGoBack ? () => setScreen(before!) : null);
  // the v3 pages: Getting to know you goes back to the address (or away) screen, the rest to the page before
  const backFromKnow = () => setV3(null);
  const s = SCREENS[screen];
  const preAgent = (screen === "anywhere" || screen === "address") && !drafted;
  // the steps before the agent were made for a narrow panel; they keep that width in the middle
  const narrow = (node: ReactNode) => <div className="ob-narrow">{node}</div>;
  if (v3 === "know") {
    const done = () => {
      saveAnswers(me.workspace.id, { knowDone: true });
      void flushNotes();
      setV3(firstV3());
    };
    return (
      <HelloNext>
        <KnowStep onBack={backFromKnow} name={me.user.name} workspaceId={me.workspace.id} onContinue={done} onSkip={done} />
      </HelloNext>
    );
  }
  // while page 3's look-around or import still runs, every later page shows it at the top
  const learning = (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 safe-top">
      <StillLearning />
    </div>
  );
  if (v3 === "agent") {
    return (
      <HelloNext>
        {learning}
        <AgentStep
          onBack={() => setV3("know")}
          workspaceId={me.workspace.id}
          person={me.user.name}
          onContinue={(draft) => {
            saveAgentDraft(me.workspace.id, draft);
            setName(draft.name);
            setV3("ai");
          }}
        />
      </HelloNext>
    );
  }
  if (v3 === "ai") {
    return (
      <HelloNext>
        {learning}
        <AIStep
          onBack={() => setV3("agent")}
          device={device}
          person={me.user.name}
          onDone={(agentId, channelId) => {
            setV3(null);
            if (agentId) finish(channelId);
            else advance("agent");
          }}
        />
      </HelloNext>
    );
  }
  return (
    <>
    {learning}
    <SetupShell
      // a new setup counts away and address as its first two of five dots, like the pages after them
      at={intro ? ({ anywhere: 1, address: 1, devices: 5 } as Partial<Record<Screen, number>>)[screen] ?? s.at : s.at}
      track={intro ? NEW_TRACK : undefined}
      line={screen === "anywhere" && awayChoice ? AWAY_LINES[awayChoice] : s.line(name.trim() || "your agent")} look={preAgent ? undefined : look} mood={s.mood} stepKey={screen} onBack={goBack}>
      {screen === "anywhere" && narrow(<AwayStep onScene={onScene} onChoice={setAwayChoice} onDone={() => (completeSetupStep(me.workspace.id, "anywhere"), advance("address"))} />)}
      {screen === "address" && narrow(<AddressStep onScene={onScene} onNext={() => advance("address")} />)}
      {screen === "connect" && (
        <ConnectStep
          device={device}
          onNext={(r) => {
            setReady(r);
            if (!r.some((x) => x.harness === harness)) setHarness(r[0]?.harness ?? "");
            setScreen("name");
          }}
          // skipping the AI makes no agent; the phone page shows once, never in a loop
          onSkip={() => (done.devices ? finish() : advance("agent"))}
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
      {screen === "devices" && narrow(<PhoneStep onScene={onScene} onFinish={() => finish()} />)}
    </SetupShell>
    </>
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
function AwayStep({ onScene, onChoice, onDone }: { onScene: (s: StageScene) => void; onChoice?: (c: AwayChoice) => void; onDone: () => void }) {
  const info = useAccess(3000);
  const failed = useAccessStore((s) => s.failed);
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [choice, setChoice] = useState<AwayChoice | null>(null);
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
    if (awayEnabled(info)) return;
    // a state we don't push (error, starting, missing) forgets the last push, so a recovery pushes again
    if (state !== "needs-login" && state !== "running" && state !== "stopped") pushed.current = null;
    if (pushed.current === state) return;
    if (state === "needs-login" && !info.tailscale.authUrl) {
      pushed.current = state;
    } else if (state === "running" || state === "stopped") {
      pushed.current = state;
    } else return;
    void advanceTailscale(state, !!info.tailscale.authUrl).then((r) => {
      if (r.done) return void useAccessStore.getState().refresh(true);
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
    // a Cloudflare tunnel token is long; anything short is a partial paste
    if (!credential.trim()) return setError("Paste your Cloudflare setup code first.");
    if (credential.trim().length < 20) return setError("That isn't a whole Cloudflare setup code. Copy all of it from Cloudflare and paste it here.");
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const next = await api<AccessInfo>("POST", "/api/reach/cloudflare", { action: "start", token: credential.trim() });
      useAccessStore.setState({ info: next, failed: false });
      setCredential("");
      if (!awayEnabled(next)) setHint("Cloudflare is connecting…");
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
  useEffect(() => onScene({ name: "anywhere" }), []);
  const problem = choice === "tailscale" ? tailscaleProblem({ info, failed, found: found && found.state === state ? found.text : null, slow }) : null;
  // the address picking gives you: the public one once away from home works, the home one when staying home
  const away = !!info && awayEnabled(info);
  const address = choice === "home" || (choice && away) ? serverAddress(info) : null;
  const ready = choice === "home" || (!!choice && away);
  // the host hops once when the address lands
  useEffect(() => {
    if (address?.url) hostReact("hop");
  }, [address?.url]);
  const pick = (c: AwayChoice) => {
    setChoice(c);
    onChoice?.(c);
    setError(null);
    hostReact("nod");
  };
  const list = useRef<HTMLDivElement>(null);
  return (
    <form
      className="flex-1 flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice === "cloudflare" && !away) return void startCloudflare();
        if (choice === "home") return only();
        if (ready) onDone();
      }}
    >
      <Thread title="Use Wisp outside your home?" sub="So your phone and laptop work on any Wi-Fi or on cell data.">
        <div ref={list} className="ob-slide" role="radiogroup" aria-label="Away from home">
          <SlideMark list={list} pick={choice} />
          <AwayChoiceRow on={choice === "tailscale"} disabled={!allowed} onPick={() => pick("tailscale")} mark={<BrandMark name="tailscale" />} title="Yes, with Tailscale" sub="A free app that links your devices." />
          <AwayChoiceRow on={choice === "cloudflare"} disabled={!allowed} onPick={() => pick("cloudflare")} mark={<BrandMark name="cloudflare" />} title="Yes, with Cloudflare" sub="Needs a domain you own." />
          <AwayChoiceRow on={choice === "home"} onPick={() => pick("home")} mark={<HomeMark />} title="Only at home for now" sub="Your devices connect on your home Wi-Fi." />
        </div>
        <SlideOpen open={choice === "tailscale" && !away}>
          <div className="flex flex-col gap-2.5 pt-1">
            <TailscaleRows info={info} authUrl={info?.tailscale.authUrl ?? loginUrl} problem={problem} />
            {problem && (
              <button type="button" className="ob-link self-start text-sm" onClick={tryAgain}>
                Try again
              </button>
            )}
          </div>
        </SlideOpen>
        <SlideOpen open={choice === "cloudflare" && !away}>
          <div className="flex flex-col gap-2 pt-1">
            <AuthInput type="password" autoComplete="off" className="h-[42px] rounded-lg px-3" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Cloudflare setup code" aria-label="Cloudflare setup code" />
            {hint && (
              <p role="status" className="text-sm text-muted">
                {hint}
              </p>
            )}
            <Problem>{error}</Problem>
          </div>
        </SlideOpen>
        <SlideOpen open={!!address}>
          <AddressCard address={address} />
        </SlideOpen>
        {!info && failed && (
          <p role="status" className="text-sm text-muted">
            Away from home isn't available yet; you can keep going.
          </p>
        )}
        {!allowed && <p className="text-sm text-muted">Your Wisp's owner can turn this on.</p>}
      </Thread>
      <Actions>
        <SetupButton disabled={busy || !choice || (choice === "tailscale" && !away) || (choice === "cloudflare" && !away && !credential.trim())}>
          {busy && <Loader2 size={16} className="animate-spin" />}
          {choice === "cloudflare" && !away ? "Connect" : "Continue"}
        </SetupButton>
      </Actions>
    </form>
  );
}

type AwayChoice = "tailscale" | "cloudflare" | "home";
/** What the host says once you pick how to reach it. */
const AWAY_LINES: Record<AwayChoice, string> = { tailscale: "Then I'm on your phone too.", cloudflare: "Then I'm on your phone too.", home: "Home it is. Change it any time." };

/** One way to reach Wisp, as a radio row; the picked row's outline slides to it. */
function AwayChoiceRow({ on, disabled, onPick, mark, title, sub }: { on: boolean; disabled?: boolean; onPick: () => void; mark: ReactNode; title: string; sub: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="setup-choice" disabled={disabled} onClick={onPick}>
      {mark}
      <span className="flex-1 min-w-0">
        <strong className="block text-sm font-medium">{title}</strong>
        <span className="block text-[13px] text-muted">{sub}</span>
      </span>
    </button>
  );
}

function HomeMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** The address your devices connect to, with Copy. */
function AddressCard({ address }: { address: { url: string; note: string } | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [address?.url]);
  return (
    <div className="pt-1 flex flex-col gap-1.5">
      <div className="rounded-lg border border-line bg-card p-3.5 flex items-center justify-between gap-2.5">
        {address ? <span className="font-mono text-sm break-all">{address.url}</span> : <Waiting>Looking up your address</Waiting>}
        {address && (
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
        )}
      </div>
      {address && <p className="text-[13px] text-muted">{address.note}</p>}
    </div>
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
  return (
    <>
      <Thread title="Connect Tailscale" sub="Wisp moves on by itself once both are done.">
        <TailscaleRows info={info} authUrl={authUrl} problem={problem} />
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

/** Tailscale's two steps (installed, signed in), what's wrong, and what it's waiting on. */
function TailscaleRows({ info, authUrl, problem }: { info: AccessInfo | null; authUrl?: string | null; problem: string | null }) {
  const state = info?.tailscale.state;
  return (
    <>
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
