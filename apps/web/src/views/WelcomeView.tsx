import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Bot, Check, Download, FileText, KeyRound, Laptop, Loader2, MessageSquareText, Monitor, Plus, Server, Smartphone, Sparkles, TerminalSquare, UtensilsCrossed, Users } from "lucide-react";
import { HARNESSES, harnessInfo, harnessLabel, lentNow, runsInVm, type Agent, type DeviceRole, type MessagePart } from "@warren/core";
import { defaultAppearance } from "@warren/core/src/appearance.ts";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { renderMarkdown } from "../markdown.ts";
import { STEPS, setDismissed, useOnboarding, type OnboardingState, type StepId } from "../onboarding.ts";
import { useDesktopInfo } from "../desktop.ts";
import { setExperience, type Experience } from "../experience.tsx";
import { usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { ComputerMini } from "./ComputersView.tsx";
import { freeHandle, importFound } from "./AgentsView.tsx";
import { Ghost } from "../components/Ghost.tsx";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { AgentAvatar, Button, CopyBlock, DeviceInstall, cx } from "../components/ui.tsx";

/**
 * First-run setup, laid out like Paperclip's: one question per screen on a plain page, a
 * progress strip on top, Back and Continue underneath. Each screen checks itself against what
 * actually happened (a device connected, an agent replied), so it picks up where you left off.
 */

const LABELS: Record<StepId, string> = { device: "Device", role: "Its job", agent: "Agent", harness: "Harness", hello: "First task" };

/** "intro" comes before step 1 and is not a numbered step: it only shows for a new account, or when asked for. */
type Screen = StepId | "intro" | "done";

/** The filled field Paperclip's setup uses: no outline until it's focused. */
const FILLED = "h-11 w-full rounded-lg border border-transparent bg-chip px-3.5 text-[15px] outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/30";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);

export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const { state, error, refresh, done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<Screen | null>(null);
  // what this run of setup is working on: the device, and the agent it made or found
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // "Add a different one": a new agent even though one exists
  const [fresh, setFresh] = useState(false);
  const [name, setName] = useState("");

  // open on the first thing that hasn't happened yet, or on the intro when asked for
  useEffect(() => {
    if (!screen && state) setScreen(intro ? "intro" : (STEPS.find((s) => !done[s]) ?? "done"));
  }, [state, screen, done, intro]);
  // already open and sent to #/welcome/intro (from Help): show it again
  useEffect(() => {
    if (intro) setScreen((s) => (s ? "intro" : s));
  }, [intro]);

  const usable = usableDevices(devices ?? []);
  const device = usable.find((d) => d.id === deviceId) ?? pickDevice(usable);
  const agent = agentId ? agents.find((a) => a.id === agentId) : fresh ? undefined : (agents.find((a) => a.nodeId === device?.id) ?? agents.find((a) => a.nodeId) ?? agents[0]);

  const scroller = useRef<HTMLDivElement>(null);
  const show = (s: Screen) => {
    setScreen(s);
    scroller.current?.scrollTo({ top: 0 });
  };
  const next = (from: StepId) => show(STEPS[STEPS.indexOf(from) + 1] ?? "done");
  const back = (from: StepId) => show(STEPS[STEPS.indexOf(from) - 1] ?? from);
  const leave = (channelId: string | null = null) => {
    setDismissed(true);
    go({ view: "chat", channelId, threadId: null });
  };

  // the intro is done: drop "/intro" from the address so the same link works again later
  const startSetup = () => {
    if (intro) go({ view: "welcome" });
    show(STEPS.find((s) => !done[s]) ?? "done");
  };

  const hero = screen === "agent" || screen === "harness" || screen === "hello";
  const look = agent ? (agent.settings.appearance ?? defaultAppearance(agent.handle)) : defaultAppearance(slug(name) || "new-agent");

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-panel" data-testid="setup">
      <header className="shrink-0 safe-top">
        <div className="h-14 px-4 md:px-6 flex items-center gap-3">
          <span className="text-sm font-medium text-muted truncate">Set up {me.workspace.name}</span>
          <button onClick={() => leave()} className="ml-auto text-sm text-muted hover:text-ink">
            {screen === "done" ? "Close" : "Do this later"}
          </button>
        </div>
      </header>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div className="mx-auto my-auto w-[560px] max-w-full shrink-0 px-6 sm:px-10 pt-6 pb-12">
          {screen && screen !== "intro" && <Stepper current={screen} done={done} onJump={show} />}
          {error && (
            <div role="alert" className="mb-6 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
              {error}
            </div>
          )}
          {/* one ghost across the agent screens, so moving between them doesn't replay it */}
          {hero && (
            <div className="mb-6 flex flex-col items-center gap-1">
              <Ghost look={look} size={132} trackPointer wave={screen === "hello" && !!state?.firstReply} label={agent ? `${agent.name}, your agent` : "Your new agent, looking toward your pointer"} />
              <div className="h-5 text-sm font-medium text-muted">{agent ? `@${agent.handle}` : slug(name) ? `@${slug(name)}` : ""}</div>
            </div>
          )}
          {!screen || !devices ? (
            <div className="py-24 grid place-items-center text-muted" role="status">
              <Loader2 className="animate-spin" />
            </div>
          ) : (
            <div key={screen} className="wizard-in">
              {screen === "intro" && <IntroScreen onContinue={startSetup} />}
              {screen === "device" && (
                <DeviceScreen
                  usable={usable}
                  device={device}
                  onPick={setDeviceId}
                  onNext={(id) => {
                    setDeviceId(id);
                    refresh();
                    next("device");
                  }}
                />
              )}
              {screen === "role" && (device ? <RoleScreen device={device} onBack={() => back("role")} onNext={() => (refresh(), next("role"))} /> : <NoDevice onBack={() => back("role")} />)}
              {screen === "agent" && (
                <AgentScreen
                  usable={usable}
                  device={device}
                  agent={agent}
                  name={name}
                  setName={setName}
                  onBack={() => back("agent")}
                  onNext={() => next("agent")}
                  onFresh={() => {
                    setAgentId(null);
                    setFresh(true);
                  }}
                  onBrought={(a) => {
                    setAgentId(a.id);
                    refresh();
                    show("hello");
                  }}
                />
              )}
              {screen === "harness" &&
                (device ? (
                  <HarnessScreen
                    device={device}
                    name={name.trim()}
                    agent={agent}
                    onCreated={(a) => {
                      setAgentId(a.id);
                      refresh();
                    }}
                    onBack={() => back("harness")}
                    onNext={() => next("harness")}
                  />
                ) : (
                  <NoDevice onBack={() => back("harness")} />
                ))}
              {screen === "hello" && <HelloScreen state={state} agent={agent} onBack={() => back("hello")} onFinish={leave} />}
              {screen === "done" && <DoneScreen state={state} onFinish={() => leave()} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Your connected device with a job first, then any connected one, then any at all. */
function pickDevice(ds: DeviceInfo[]): DeviceInfo | undefined {
  return ds.find((d) => d.online && d.mine && d.role) ?? ds.find((d) => d.online && d.mine) ?? ds.find((d) => d.online) ?? ds[0];
}

// --- the frame ------------------------------------------------------------------------------------

/** Paperclip's progress strip: one segment per step, filled up to here. Finished ones take you back. */
function Stepper({ current, done, onJump }: { current: Exclude<Screen, "intro">; done: Record<StepId, boolean>; onJump: (s: StepId) => void }) {
  const at = current === "done" ? STEPS.length : STEPS.indexOf(current);
  return (
    <nav aria-label="Setup steps" className="mb-10">
      <div className="mb-2.5 text-xs text-muted">{current === "done" ? "All set" : `Step ${at + 1} of ${STEPS.length} · ${LABELS[current]}`}</div>
      <ol className="flex gap-1.5">
        {STEPS.map((s, i) => {
          // you can go back anywhere, and forward to a step whose earlier ones are done
          const reachable = i !== at && STEPS.slice(0, i).every((p) => done[p]);
          return (
            <li key={s} className="flex-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onJump(s)}
                aria-label={`${LABELS[s]}, step ${i + 1} of ${STEPS.length}${done[s] ? ", done" : ""}`}
                aria-current={i === at ? "step" : undefined}
                title={LABELS[s]}
                className={cx("block h-1.5 w-full rounded-full transition-colors disabled:cursor-default", i <= at ? "bg-accent" : done[s] ? "bg-accent/35" : "bg-chip", reachable && "hover:opacity-75")}
              />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The big centered question, and a line under it. */
function Heading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-9 text-center">
      <h1 tabIndex={-1} className="text-[26px] leading-tight font-semibold tracking-tight text-balance outline-none">
        {title}
      </h1>
      {children && <p className="mt-2 text-base leading-relaxed text-muted text-balance">{children}</p>}
    </div>
  );
}

/** Back on the left, the one thing to do next on the right. */
function Footer({ onBack, label, onNext, disabled, busy, waiting, extra }: { onBack?: () => void; label: string; onNext: () => void; disabled?: boolean; busy?: boolean; waiting?: boolean; extra?: ReactNode }) {
  return (
    <div className="mt-10 flex items-center gap-3">
      {onBack && (
        <Button variant="ghost" onClick={onBack} className="-ml-3">
          <ArrowLeft size={16} /> Back
        </Button>
      )}
      <div className="ml-auto flex items-center gap-3">
        {extra}
        <Button variant="primary" className="h-10 px-5" disabled={disabled || busy} onClick={onNext}>
          {busy || waiting ? <Loader2 size={16} className="animate-spin" /> : null}
          {label}
          {!busy && !waiting && <ArrowRight size={16} />}
        </Button>
      </div>
    </div>
  );
}

/** One of a few choices, as a large tile. */
function Choice({ icon, title, badge, body, selected, disabled, onClick }: { icon: ReactNode; title: string; badge?: string; body: ReactNode; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cx("w-full text-left rounded-xl border p-4 flex gap-3.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed", selected ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}
    >
      <span className={cx("size-10 shrink-0 rounded-lg grid place-items-center", selected ? "bg-accent text-accent-ink" : "bg-chip text-muted")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[15px] font-medium">
          {title}
          {badge && <span className="rounded-full bg-accent-soft text-accent-text px-2 py-0.5 text-[11px] font-medium">{badge}</span>}
        </span>
        <span className="mt-0.5 block text-sm text-muted leading-snug">{body}</span>
      </span>
    </button>
  );
}

function Status({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <div role="status" className={cx("flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm", ok ? "bg-ok/10 text-ok" : "bg-chip text-muted")}>
      {ok ? <Check size={16} className="shrink-0" /> : <Loader2 size={16} className="shrink-0 animate-spin" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Command({ label, text, children }: { label?: string; text: string; children?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label && <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>}
      <CopyBlock text={text} />
      {children && <p className="text-xs text-muted">{children}</p>}
    </div>
  );
}

function NoDevice({ onBack }: { onBack: () => void }) {
  return (
    <>
      <Heading title="Connect a device first">Agents live on one of your devices. Go back a step to connect it.</Heading>
      <Footer onBack={onBack} label="Continue" disabled onNext={() => {}} />
    </>
  );
}

// --- before step 1: what Warren is -----------------------------------------------------------------

const EXAMPLES: { icon: ReactNode; text: string }[] = [
  { icon: <UtensilsCrossed size={17} />, text: "Plan a week of dinners and a shopping list" },
  { icon: <MessageSquareText size={17} />, text: "Draft a polite message to a landlord or a coworker" },
  { icon: <FileText size={17} />, text: "Summarize a document" },
];

/** Plain words about what Warren is, and how much of it to show. Not a numbered step. */
function IntroScreen({ onContinue }: { onContinue: () => void }) {
  const picked = useStore((s) => s.me?.prefs?.experience);
  const [choice, setChoice] = useState<Experience>(picked ?? "simple");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice !== picked) await setExperience(choice);
      onContinue();
    } catch {
      setError("Couldn't save that. Check your connection and try again. You can also change it later in Settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Heading title="Welcome to Warren">
        Warren is a place where you and AI helpers work together. You chat with them, they do the work on a computer you choose, and they remember what matters.
      </Heading>
      <ul className="grid sm:grid-cols-3 gap-2.5" aria-label="Things you can ask">
        {EXAMPLES.map((e) => (
          <li key={e.text} className="rounded-xl border border-line p-3.5 flex sm:flex-col gap-3 items-start">
            <span className="size-8 shrink-0 rounded-lg bg-chip text-muted grid place-items-center">{e.icon}</span>
            <span className="text-sm leading-snug">{e.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex items-center justify-center gap-2 text-sm text-muted text-center">
        <Sparkles size={14} className="shrink-0" /> You'll set up your first helper in the next few minutes, then you can ask things like these.
      </p>
      <div className="mt-9">
        <h2 id="experience-q" className="mb-3 text-base font-semibold">How much do you want to see?</h2>
        <div className="space-y-2.5" role="radiogroup" aria-labelledby="experience-q">
          <Choice icon={<Sparkles size={18} />} title="Simple" badge="Recommended" selected={choice === "simple"} disabled={busy} onClick={() => setChoice("simple")} body="The everyday parts first. Advanced options stay a click away." />
          <Choice icon={<TerminalSquare size={18} />} title="Advanced" selected={choice === "advanced"} disabled={busy} onClick={() => setChoice("advanced")} body="Everything: teams, harness details, VM sizes, tokens, raw files." />
        </div>
        <p className="mt-2 text-xs text-muted">You can change this any time in Settings.</p>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
      <Footer label="Continue" busy={busy} onNext={next} />
    </>
  );
}

// --- 1. the device ----------------------------------------------------------------------------------

/** Opened on the computer running the hub, so that computer is probably the device. */
const onHub = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".localhost");

function guessName(): string {
  const ua = navigator.userAgent;
  return /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? "my-mac" : /Windows/.test(ua) ? "my-pc" : /Linux/.test(ua) && !/Android/.test(ua) ? "my-linux" : "my-computer";
}

/** Device names like "yug-mac" read as one word, so they don't break at the hyphen. */
const nb = (name: string) => <span className="whitespace-nowrap">{name}</span>;

const DMG = "https://github.com/eireijie/warren/releases/download/desktop-v0.0.1/Warren-0.0.1-arm64.dmg";

/** The no-Terminal way to connect: the Warren app does it itself, or can be downloaded and pointed at this server. */
function EasiestWay({ name, connected }: { name: string; connected: boolean }) {
  const { inDesktop, info, connect } = useDesktopInfo();
  const [busy, setBusy] = useState(false);
  const hub = location.origin;
  if (inDesktop)
    return (
      <div className="rounded-xl border border-line bg-panel p-4 space-y-2">
        <p className="text-sm font-medium">This Mac is being connected automatically</p>
        <p className="text-sm text-muted">
          {connected ? `${name} is connected.` : info?.device ? "Connected to Warren. It can take a few seconds to show up here." : "The Warren app has not connected this Mac yet."}
        </p>
        {!connected && !info?.device && (
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await connect();
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect this Mac
          </Button>
        )}
      </div>
    );
  return (
    <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
      <p className="text-sm font-medium">Easiest: download Warren for Mac</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <a className="font-medium underline" href={DMG}>Download for Apple silicon</a>
        <a className="text-muted underline" href="https://github.com/eireijie/warren/releases" target="_blank" rel="noreferrer">All releases</a>
      </div>
      <p className="text-sm text-muted">Then open it and choose “Join a server” with this address:</p>
      <CopyBlock text={hub} />
    </div>
  );
}

function DeviceScreen({ usable, device, onPick, onNext }: { usable: DeviceInfo[]; device: DeviceInfo | undefined; onPick: (id: string) => void; onNext: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(guessName);
  const [created, setCreated] = useState<{ id: string; name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (created) {
    const live = usable.find((d) => d.id === created.id && d.online);
    return (
      <>
        <Heading title={`Connect ${created.name}`}>Warren needs to be running on {created.name} so your agents can work there. The Mac app does this for you; a command works for any computer.</Heading>
        <div className="space-y-5">
          <EasiestWay name={created.name} connected={!!live} />
          <details className="rounded-xl border border-line p-4">
            <summary className="cursor-pointer text-sm font-medium">Connect another computer with a command</summary>
            <div className="mt-3 space-y-3">
              <DeviceInstall token={created.token} name={created.name} />
              <p className="text-xs text-muted">“warren node start” stops when you close its terminal window; “warren service install node” keeps it running in the background.</p>
            </div>
          </details>
          <p className="text-xs text-muted">
            The token is shown once and saved on the device.
            {onHub() && " If this is the computer running Warren, pick “Warren already installed” and run it in the folder you started Warren from."}
          </p>
          <Status ok={!!live}>{live ? `${created.name} is connected` : `Waiting for ${created.name} to connect…`}</Status>
        </div>
        <Footer onBack={() => setCreated(null)} label={live ? "Continue" : "Waiting"} waiting={!live} disabled={!live} onNext={() => onNext(created.id)} />
      </>
    );
  }

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ node: { id: string; name: string }; token: string }>("POST", "/api/nodes", { name: name.trim() });
      setCreated({ ...r.node, token: r.token });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (adding || !usable.length)
    return (
      <>
        <Heading title="Where will your agents live?">A computer that can stay on: this one, a home server, a desktop. It connects out to Warren, so it works behind routers and firewalls.</Heading>
        <label className="block space-y-2">
          <span className="text-sm font-medium">Name this device</span>
          <input
            className={FILLED}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                create();
              }
            }}
          />
        </label>
        {onHub() && <p className="mt-3 text-sm text-muted">Running Warren on this computer? It can be the device too: agents get their own VMs on it, apart from your screen.</p>}
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <Footer onBack={usable.length ? () => setAdding(false) : undefined} label="Continue" busy={busy} disabled={!name.trim()} onNext={create} />
      </>
    );

  return (
    <>
      <Heading title="Where will your agents live?">Pick the device to set up. You can add more later under Devices.</Heading>
      <div className="space-y-2.5" role="radiogroup" aria-label="Device">
        {usable.map((d) => (
          <Choice
            key={d.id}
            icon={<Server size={18} />}
            title={d.name}
            selected={d.id === device?.id}
            onClick={() => onPick(d.id)}
            body={
              d.online ? (
                <span className="text-ok">Connected{d.mine ? "" : ` · shared by ${d.ownerName ?? "its owner"}`}</span>
              ) : (
                <>
                  Not running. Start it there with <code>warren node start</code>
                </>
              )
            }
          />
        ))}
        <button type="button" onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-line p-4 flex items-center gap-3.5 text-left text-muted hover:bg-hover hover:text-ink">
          <span className="size-10 shrink-0 rounded-lg bg-chip grid place-items-center">
            <Plus size={18} />
          </span>
          <span className="text-[15px] font-medium">Connect another device</span>
        </button>
      </div>
      <Footer label={device?.online ? "Continue" : "Waiting"} waiting={!!device && !device.online} disabled={!device?.online} onNext={() => device && onNext(device.id)} />
    </>
  );
}

// --- 2. what the device does for agents ------------------------------------------------------------------------

function RoleScreen({ device, onBack, onNext }: { device: DeviceInfo; onBack: () => void; onNext: () => void }) {
  const [role, setRole] = useState<DeviceRole>(device.role ?? "vms");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caps = device.capabilities;
  const owner = device.mine ? "you" : (device.ownerName ?? "its owner");
  const ready = role === "headless" || (role === "vms" ? !!caps?.vm.ok : !!caps?.screen.ok);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (device.mine && role !== device.role) await api("PATCH", `/api/nodes/${device.id}`, { role });
      onNext();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!device.mine)
    return (
      <>
        <Heading title={`What ${device.name} does for agents`}>
          {device.role ? `${owner} set it to ${ROLE_TEXT[device.role].toLowerCase()}.` : `${owner} hasn't chosen yet, so agents get a VM there when it can run one.`} Only {owner} can change it.
        </Heading>
        <Footer onBack={onBack} label="Continue" onNext={onNext} />
      </>
    );

  return (
    <>
      <Heading title={<>What should {nb(device.name)} do for your agents?</>}>You can change this later under Devices.</Heading>
      <div className="space-y-2.5" role="radiogroup" aria-label={`What ${device.name} does for agents`}>
        <Choice
          icon={<Monitor size={19} />}
          title={ROLE_TEXT.vms}
          badge="Recommended"
          selected={role === "vms"}
          onClick={() => setRole("vms")}
          body="Each agent gets its own desktop here: a VM with Google Chrome, a terminal and files. They sign in to websites and work there, and your screen stays yours."
        />
        <Choice
          icon={<Laptop size={19} />}
          title={ROLE_TEXT.screen}
          selected={role === "screen"}
          onClick={() => setRole("screen")}
          body={`Agents use ${device.name}'s own screen and apps, but only while you lend it, and only for things you ask. For apps that only live on this computer.`}
        />
        <Choice
          icon={<TerminalSquare size={19} />}
          title={ROLE_TEXT.headless}
          selected={role === "headless"}
          onClick={() => setRole("headless")}
          body="Agents run here without a desktop. They can chat, write code and keep memory, but can't open apps or websites."
        />
      </div>

      <div className="mt-5 space-y-3">
        {!caps ? (
          <Status ok={null}>Waiting to hear from {device.name}…</Status>
        ) : role === "vms" ? (
          caps.vm.ok ? (
            <Status ok>{caps.vm.detail}</Status>
          ) : (
            <div className="rounded-xl border border-line p-4 space-y-3 text-sm">
              <p>{caps.vm.detail}</p>
              <Command text="warren setup">Run this on {device.name}. It installs a VM engine if it needs one (asking first) and downloads the agents' desktop. This page updates by itself.</Command>
            </div>
          )
        ) : role === "screen" ? (
          caps.screen.ok ? (
            <Status ok>Its screen is on. Agents still only use it while you lend it.</Status>
          ) : caps.screen.off ? (
            <div className="rounded-xl border border-line p-4 space-y-3 text-sm">
              <p>{device.name}'s screen is off, which is how every device starts. Only you can turn it on, at {device.name} itself:</p>
              <Command text="warren node screen on">This page updates by itself.</Command>
            </div>
          ) : (
            <p className="text-sm text-bad">{caps.screen.detail}</p>
          )
        ) : null}
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer onBack={onBack} label={ready ? "Continue" : "Waiting"} waiting={!ready} busy={busy} disabled={!ready} onNext={save} />
    </>
  );
}

const ROLE_TEXT: Record<DeviceRole, string> = { vms: "Run their computers", screen: "Lend them this screen", headless: "Neither: run them headless" };

// --- 3. the agent ------------------------------------------------------------------------------------

/** The computer a new agent gets on a device, by what the device does for agents. */
async function computerFor(device: DeviceInfo, name: string, computers: ComputerInfo[]): Promise<{ computerId: string | null; kind: "vm" | "device" | null }> {
  if (device.role === "headless") return { computerId: null, kind: null };
  if (device.role === "screen" && device.mine) {
    const screen = computers.find((c) => c.kind === "device" && c.nodeId === device.id);
    if (screen) return { computerId: screen.id, kind: "device" };
    if (!device.capabilities?.screen.ok) return { computerId: null, kind: null };
    return { computerId: (await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId: device.id })).id, kind: "device" };
  }
  // its own VM, or one made earlier that nobody has yet
  const idle = computers.find((c) => c.kind === "vm" && c.nodeId === device.id && !c.agents.length);
  if (idle) return { computerId: idle.id, kind: "vm" };
  if (!device.capabilities?.vm.ok) return { computerId: null, kind: null };
  return { computerId: (await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: device.id, name: `${name}'s desk`, cpus: 2, memoryGb: 4 })).id, kind: "vm" };
}

function AgentScreen({
  usable,
  device,
  agent,
  name,
  setName,
  onBack,
  onNext,
  onFresh,
  onBrought,
}: {
  usable: DeviceInfo[];
  device: DeviceInfo | undefined;
  agent: Agent | undefined;
  name: string;
  setName: (n: string) => void;
  onBack: () => void;
  onNext: () => void;
  onFresh: () => void;
  onBrought: (a: Agent) => void;
}) {
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const [bringing, setBringing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = slug(name);
  const taken = agents.some((a) => a.handle === handle);
  const valid = !!name.trim() && /^[a-z][a-z0-9-]{0,31}$/.test(handle) && !taken;
  // agents that already live on your devices, ready to bring in
  const found = usable.flatMap((n) => (n.discovered ?? []).map((d) => ({ node: n, d }))).filter((x) => !agents.some((a) => a.nodeId === x.node.id && a.harness === x.d.harness && a.name === x.d.name));

  if (agent)
    return (
      <>
        <Heading title={`Meet ${agent.name}`}>
          {harnessLabel(agent.harness)}
          {agent.nodeId ? ` on ${usable.find((d) => d.id === agent.nodeId)?.name ?? "a device"}` : ""}. It wakes up when you @mention it.
        </Heading>
        <Footer onBack={onBack} label="Continue" onNext={onNext} extra={<Button variant="ghost" onClick={onFresh}>Add a different one</Button>} />
      </>
    );

  const bringIn = async (x: (typeof found)[number]) => {
    setBringing(x.d.key);
    setError(null);
    try {
      const { computerId } = await computerFor(x.node, x.d.name, computers);
      await useStore.getState().refreshComputers();
      const a = await importFound(x, { handle: freeHandle(x.d.name, agents.map((g) => g.handle)), computerId, headless: x.node.role === "headless", computers: useStore.getState().computers });
      await Promise.all([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
      onBrought(a);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBringing(null);
    }
  };

  return (
    <>
      <Heading title={agents.length ? "Create an agent" : "Create your first agent"} />
      <label className="block space-y-2">
        <span className="text-sm font-medium">Agent name</span>
        <input
          className={FILLED}
          value={name}
          maxLength={80}
          autoFocus
          placeholder="e.g. Atlas"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && valid) {
              e.preventDefault();
              onNext();
            }
          }}
        />
        {taken && <span className="block text-xs text-bad">You already have an @{handle}. Pick another name.</span>}
      </label>
      {!device && <p className="mt-3 text-sm text-warn">No device yet. It waits until one connects.</p>}

      {found.length > 0 && (
        <div className="mt-8 space-y-2">
          <div className="text-sm font-medium">Or bring in one you already have</div>
          <div className="rounded-xl border border-line divide-y divide-line">
            {found.slice(0, 5).map((x) => (
              <div key={`${x.node.id}:${x.d.key}`} className="flex items-center gap-3 px-3 py-2.5">
                <AgentAvatar agent={{ harness: x.d.harness, name: x.d.name }} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{x.d.name}</span>
                  <span className="block text-xs text-muted truncate">
                    {harnessLabel(x.d.harness)} on {x.node.name}
                    {x.d.description ? ` · ${x.d.description}` : ""}
                  </span>
                </span>
                <Button disabled={!!bringing} onClick={() => bringIn(x)}>
                  {bringing === x.d.key ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Bring in
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">Its instructions, soul and notes come along.</p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer onBack={onBack} label="Next" disabled={!valid} onNext={onNext} />
    </>
  );
}

// --- 4. its harness, signed in -----------------------------------------------------------------------------

/** Harnesses Warren starts itself (not ones that join over MCP), and ones the device declared. */
function harnessesFor(device: DeviceInfo) {
  const built = HARNESSES.filter((h) => h.protocol !== "mcp").map((h) => h.id);
  const declared = (device.harnesses ?? []).map((h) => h.id).filter((id) => id.startsWith("acp:"));
  return [...built, ...declared];
}

function HarnessScreen({ device, name, agent, onCreated, onBack, onNext }: { device: DeviceInfo; name: string; agent: Agent | undefined; onCreated: (a: Agent) => void; onBack: () => void; onNext: () => void }) {
  const computers = useStore((s) => s.computers);
  const installed = new Set((device.harnesses ?? []).map((h) => h.id));
  const vms = (device.role ?? "vms") === "vms" && !!device.capabilities?.vm.ok;
  const inVm = (id: string) => vms && runsInVm(id);
  const ready = (id: string) => inVm(id) || installed.has(id);
  // ready ones first: in its computer, then installed on the device
  const all = harnessesFor(device).sort((a, b) => +inVm(b) - +inVm(a) || +installed.has(b) - +installed.has(a));
  const [harness, setHarness] = useState(() => all.find(ready) ?? all[0]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (agent) return <SignIn agent={agent} device={device} onBack={onBack} onNext={onNext} />;

  const shown = more ? all : all.slice(0, 6);
  if (!shown.includes(harness)) shown.push(harness);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { computerId, kind } = await computerFor(device, name, computers);
      const a = await api<Agent>("POST", "/api/agents", {
        harness,
        name,
        handle: slug(name),
        nodeId: device.id,
        computerId,
        settings: {
          ...(device.role === "headless" ? { headless: true } : {}),
          // in a VM on its own device, these harnesses run inside it, away from the device
          ...(kind === "vm" && runsInVm(harness) ? { runIn: "computer" as const } : {}),
        },
      });
      await Promise.all([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
      onCreated(a);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await api("POST", `/api/nodes/${device.id}/install`, { harness });
      await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };
  const info = harnessInfo(harness);

  return (
    <>
      <Heading title={`Pick ${name}'s harness`}>The agent program it runs, with your own subscription.</Heading>
      <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Harness">
        {shown.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={harness === id}
            onClick={() => setHarness(id)}
            className={cx("rounded-xl border p-3 text-left flex items-center gap-3 transition-colors", harness === id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover")}
          >
            <HarnessLogo harness={id as Agent["harness"]} size={30} />
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate">{harnessLabel(id)}</span>
              <span className={cx("block text-[11px] truncate", ready(id) ? "text-ok" : "text-muted")}>{inVm(id) ? "Comes with its computer" : installed.has(id) ? `Installed on ${device.name}` : `Not on ${device.name} yet`}</span>
            </span>
          </button>
        ))}
      </div>
      {all.length > 6 && !more && (
        <button type="button" onClick={() => setMore(true)} className="mt-3 text-sm text-muted hover:text-ink">
          More harnesses
        </button>
      )}
      {!ready(harness) && (
        <div className="mt-5 rounded-xl border border-line p-4 space-y-3 text-sm">
          <p>
            {harnessLabel(harness)} isn't installed on {device.name} yet.
          </p>
          {info?.install?.npm && device.mine ? (
            <Button onClick={install} disabled={installing}>
              {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {installing ? `Installing on ${device.name}…` : `Install on ${device.name}`}
            </Button>
          ) : info?.install?.docs ? (
            <p className="text-muted">
              Install it on {device.name} with{" "}
              <a className="text-accent-text hover:underline" href={info.install.docs} target="_blank" rel="noreferrer">
                its installer
              </a>
              , then come back.
            </p>
          ) : (
            <p className="text-muted">Install it on {device.name}, then come back.</p>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer onBack={onBack} label={`Create ${name}`} busy={busy} disabled={!ready(harness)} onNext={create} />
    </>
  );
}

/** "claude (then /login)": the command to copy, and what to do once it's open. */
function loginSteps(harness: string): { command: string; then: string | null } | null {
  const m = harnessInfo(harness)?.login?.match(/^(.*?)(?: \((?:then )?(.*)\))?$/);
  return m ? { command: m[1], then: m[2] ?? null } : null;
}

/** Where its harness signs in: once on its computer when it runs in there, or as usual on the device. */
function SignIn({ agent, device, onBack, onNext }: { agent: Agent; device: DeviceInfo; onBack: () => void; onNext: () => void }) {
  const computer = useStore((s) => s.computers.find((c) => c.id === agent.computerId));
  const label = harnessLabel(agent.harness);
  const inVm = agent.settings.runIn === "computer" && computer?.kind === "vm";
  const login = loginSteps(agent.harness);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ask until it's signed in; one question at a time, since a VM can take a while to answer
  useEffect(() => {
    if (!inVm) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const r = await api<{ signedIn: boolean | null }>("GET", `/api/agents/${agent.id}/harness`).catch(() => null);
      if (!alive) return;
      if (r) setSignedIn(r.signedIn);
      if (r?.signedIn !== true) timer = setTimeout(check, 4000);
    };
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [agent.id, inVm]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ computerId: string }>("POST", `/api/agents/${agent.id}/signin`);
      window.open(href({ view: "computers", computerId: r.computerId }), "_blank");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!inVm || !computer)
    return (
      <>
        <Heading title={`${agent.name} is in`}>
          {label} runs on {device.name} and uses its sign-in there.
        </Heading>
        {login && (
          <Command label={`Not signed in to ${label} on ${device.name} yet?`} text={login.command}>
            Run this there once{login.then ? `, then ${login.then}` : ""}.
          </Command>
        )}
        {computer?.kind === "device" && <p className="mt-5 text-sm text-muted">It works on {device.name}'s own screen while you lend it. You'll lend it in the next step.</p>}
        {!computer && <p className="mt-5 text-sm text-muted">It runs headless, so it has no apps or websites. You can give it a computer later on its page.</p>}
        <Footer onBack={onBack} label="Continue" onNext={onNext} />
      </>
    );

  const start = async () => {
    setBusy(true);
    setError(null);
    await api("POST", `/api/computers/${computer.id}/start`).catch((err) => setError((err as Error).message));
    await useStore.getState().refreshComputers();
    setBusy(false);
  };
  return (
    <>
      <Heading title={`Sign ${agent.name} in to ${label}`}>
        It runs inside its own computer with your {label} subscription. Sign in there once.
      </Heading>
      <div className="space-y-4">
        <ComputerMini computer={computer} />
        {signedIn === true ? (
          <Status ok>{label} is signed in on its computer.</Status>
        ) : computer.status === "starting" ? (
          <Status ok={null}>Starting {computer.name}. The first time takes a few minutes.</Status>
        ) : computer.status === "stopped" ? (
          <div className="rounded-xl border border-line p-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="flex-1 min-w-48">{computer.name} is stopped. Start it to sign in.</span>
            <Button onClick={start} disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />} Start it
            </Button>
          </div>
        ) : computer.status !== "ready" ? (
          <p className="text-sm text-bad">{computer.statusText || `${computer.name} can't be reached right now. Is ${device.name} on?`}</p>
        ) : signedIn === false ? (
          <div className="rounded-xl border border-line p-4 space-y-3 text-sm">
            <p>A terminal opens on its screen in a new tab. Finish signing in there, and this page notices.</p>
            <Button variant="primary" onClick={signIn} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Sign in to {label}
            </Button>
          </div>
        ) : (
          <Status ok={null}>Checking whether {label} is signed in…</Status>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer
        onBack={onBack}
        label="Continue"
        disabled={signedIn !== true}
        onNext={onNext}
        extra={
          signedIn !== true && (
            <Button variant="ghost" onClick={onNext}>
              Later
            </Button>
          )
        }
      />
    </>
  );
}

// --- 5. a first task ------------------------------------------------------------------------------

function HelloScreen({ state, agent, onBack, onFinish }: { state: OnboardingState | null; agent: Agent | undefined; onBack: () => void; onFinish: (channelId?: string) => void }) {
  const channels = useStore((s) => s.channels);
  const loadChannel = useStore((s) => s.loadChannel);
  const live = useStore((s) => s.live);
  const general = channels.find((c) => c.name === "general");
  const messages = useStore((s) => (general ? s.messages[general.id] : undefined));
  const computer = useStore((s) => s.computers.find((c) => c.id === agent?.computerId));
  const [text, setText] = useState("");
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent || text) return;
    setText(
      computer
        ? `@${agent.handle} Open news.ycombinator.com in your browser and tell me the top 3 stories, one line each. Then save a short note about what you're good at to your memory as me/strengths.md.`
        : `@${agent.handle} Hi! Introduce yourself in two sentences, then save a short note about what you're good at to your memory as me/strengths.md.`,
    );
  }, [agent, computer, text]);
  useEffect(() => {
    if (general) loadChannel(general.id);
  }, [general, loadChannel]);

  const reply = useMemo(() => (sentAt && agent ? messages?.find((m) => m.author.kind === "agent" && m.author.id === agent.id && m.createdAt >= sentAt) : undefined), [messages, sentAt, agent]);
  const running = agent ? Object.values(live).find((r) => r.agentId === agent.id) : undefined;
  const html = useMemo(() => (reply?.body ? renderMarkdown(reply.body) : ""), [reply]);

  if (!agent)
    return (
      <>
        <Heading title="Let's get started">Add an agent first, then come back here.</Heading>
        <Footer onBack={onBack} label="Send" disabled onNext={() => {}} />
      </>
    );

  const send = async () => {
    if (!general || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api<{ createdAt: string }>("POST", `/api/channels/${general.id}/messages`, { body: text });
      setSentAt(m.createdAt);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const notes = state?.memoryNotes.filter((n) => n.path.startsWith(`agents/${agent.id}/`)) ?? [];

  return (
    <>
      <Heading title="Let's get started">{agent.name} is ready to work. {computer ? "Ask for something on the web and watch it happen." : "Say hello and give it something to do."}</Heading>
      {computer?.kind === "device" && <Lend computer={computer} agent={agent} />}
      {!sentAt ? (
        <label className="block space-y-2">
          <span className="text-sm font-medium">First task</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={cx(FILLED, "h-auto py-3 leading-relaxed resize-none")} />
          <span className="block text-xs text-muted">It goes to #general. Agents wake up when they're @mentioned.</span>
        </label>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-line p-4 flex gap-3" role="status" aria-live="polite">
            <AgentAvatar agent={agent} live />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium flex items-center gap-2">
                {agent.name}
                {!reply && <Loader2 size={13} className="animate-spin text-muted" />}
                {!reply && <span className="text-xs text-muted font-normal">{running?.tools.length ? `using ${running.tools.at(-1)!.replace(/^mcp__warren__/, "")}` : agent.status === "offline" ? "waiting for its device" : "thinking"}</span>}
              </div>
              {reply ? reply.body ? <div className="prose-w text-[15px]" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="text-sm text-bad">{failureText(reply.parts)}</p> : running?.text && <p className="text-sm text-muted line-clamp-3">{running.text}</p>}
            </div>
          </div>
          {computer && <ComputerMini computer={computer} />}
          {reply && notes.length > 0 && (
            <button onClick={() => go({ view: "vault", path: notes[0].path })} className="w-full rounded-xl border border-line px-4 py-3 flex items-center gap-3 text-left hover:bg-hover">
              <BookOpen size={16} className="text-accent-text shrink-0" />
              <span className="min-w-0 flex-1 text-sm">
                It saved <b>{notes[0].title}</b> to memory: notes you can read and edit, shared with the agents you choose.
              </span>
              <ArrowRight size={14} className="text-faint" />
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <Footer onBack={onBack} label={sentAt ? "Go to #general" : "Send"} busy={busy} disabled={!sentAt && !text.trim()} onNext={sentAt ? () => onFinish(general?.id) : send} />
    </>
  );
}

/** A device's own screen only works for agents while it's lent. */
function Lend({ computer, agent }: { computer: ComputerInfo; agent: Agent }) {
  const [busy, setBusy] = useState(false);
  if (lentNow(computer))
    return (
      <div className="mb-5">
        <Status ok>Your screen is lent to agents for now. Stop anytime from Computers.</Status>
      </div>
    );
  return (
    <div className="mb-5 rounded-xl border border-line p-4 flex flex-wrap items-center gap-3 text-sm">
      <span className="flex-1 min-w-48">{agent.name} works on your screen, and only while you lend it.</span>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api("POST", `/api/computers/${computer.id}/lend`, { minutes: 60 }).catch(() => {});
          await useStore.getState().refreshComputers();
          setBusy(false);
        }}
      >
        {busy && <Loader2 size={15} className="animate-spin" />} Lend it for an hour
      </Button>
    </div>
  );
}

function failureText(parts: MessagePart[]): string {
  const status = parts.find((p) => p.type === "status");
  return status?.type === "status" ? status.text : "Something went wrong.";
}

// --- all set ----------------------------------------------------------------------------------------

function DoneScreen({ state, onFinish }: { state: OnboardingState | null; onFinish: () => void }) {
  const me = useStore((s) => s.me)!;
  return (
    <>
      <Heading title={`${me.workspace.name} is ready`}>Your agents talk to you and to each other, hand work across devices, and build up memory you can read and edit.</Heading>
      <div className="grid sm:grid-cols-2 gap-3">
        <Tip icon={<Bot size={17} />} title="Add more agents" onClick={() => go({ view: "agents", agentId: null })}>
          Give each one a job. They @mention each other and hand off tasks.
        </Tip>
        <Tip icon={<Users size={17} />} title="Bring in your team" onClick={() => go({ view: "settings", page: "people" })}>
          Invite people with a link and choose what they can do.
        </Tip>
        <Tip icon={<BookOpen size={17} />} title="Read the memory" onClick={() => go({ view: "vault", path: state?.memoryNotes[0]?.path ?? null })}>
          Notes your agents keep, with links and history.
        </Tip>
        <Tip icon={<Smartphone size={17} />} title="Install on your phone">
          iPhone: Safari → Share → <b>Add to Home Screen</b>. Android: Chrome menu → <b>Install app</b>.
        </Tip>
      </div>
      <Footer label="Go to #general" onNext={onFinish} />
    </>
  );
}

function Tip({ icon, title, children, onClick }: { icon: ReactNode; title: string; children: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="size-8 rounded-lg bg-accent-soft text-accent-text grid place-items-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium text-sm flex items-center gap-1">
          {title} {onClick && <ArrowRight size={13} className="text-faint" />}
        </div>
        <div className="text-sm text-muted">{children}</div>
      </div>
    </>
  );
  const cls = "rounded-xl border border-line p-4 flex gap-3 text-left";
  return onClick ? (
    <button onClick={onClick} className={cx(cls, "hover:bg-hover")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
