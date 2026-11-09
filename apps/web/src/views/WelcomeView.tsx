import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from "react";
import { Bot, Check, Copy, ExternalLink, Loader2, Monitor, Shuffle } from "lucide-react";
import { HARNESSES, harnessLabel, preferSignedIn, runsInVm, type Agent, type HarnessLogin, type HarnessSettings } from "@wisp/core";
import { api } from "../api.ts";
import { awayEnabled, enableTailscale } from "../components/Access.tsx";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { completeSetupStep, nextStep, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
import { isSharedComputer, usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { useComputerMode } from "../computerMode.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { canApproveJoin, unavailable } from "../join.ts";
import { AddDeviceContent } from "../components/AddDevice.tsx";
import { AuthButton, AuthInput, AuthLink } from "../components/auth.tsx";
import { PhonePairing } from "./settings/mobile.tsx";
import { CopyBlock, Field, Input, cx } from "../components/ui.tsx";
import { GHOST_PALETTES, GHOST_WHITE, randomAppearance, type GhostAppearance } from "@wisp/core/src/appearance.ts";
import { SHAPES } from "../components/Ghost.tsx";
import { HarnessLogo } from "../components/HarnessLogo.tsx";
import { CodeTiles, RowState, SetupStage, WHITE_WISP, type StageScene } from "../components/SetupStage.tsx";
import type { HarnessesResponse } from "./settings/harnesses.tsx";
import { freeHandle } from "./CreateAgent.tsx";
import { signInFor } from "./needs-sign-in.ts";

export const SETUP_LABELS: Record<StepId, string> = { anywhere: "Away from home", address: "Your address", agent: "Make your first agent", devices: "Add your devices" };

/**
 * The rest of setup, once the server runs and the account exists: reach it from outside your home,
 * its address, your first agent, your phone. Everything here is one plain screen at a time.
 */
export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const { done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<StepId>(() => (intro ? (onPublicAddress() ? "address" : "anywhere") : (nextStep(done) ?? "anywhere")));
  // the agent's look, once you start making it; the wisp keeps it for the rest of setup
  const [look, setLook] = useState<GhostAppearance | null>(() => agents[0]?.settings.appearance ?? null);
  const [scene, setScene] = useState<StageScene>({ name: screen === "agent" ? "look" : screen === "devices" ? "phone" : screen });
  const advance = (step: StepId) => {
    completeSetupStep(me.workspace.id, step);
    setScreen(STEPS[STEPS.indexOf(step) + 1] ?? "devices");
  };
  const finish = () => {
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go({ view: "dashboard" });
  };
  // the step's own Back wins; otherwise the screen before, unless going there would redo something
  const before = STEPS[STEPS.indexOf(screen) - 1];
  const canGoBack = !!before && !(screen === "address" && onPublicAddress()) && !(screen === "devices" && agents.length > 0);
  return (
    <SetupStage scene={{ look: look ?? undefined, ...scene, onBack: scene.onBack === undefined ? (canGoBack ? () => setScreen(before) : undefined) : scene.onBack }}>
      {screen === "anywhere" && <AwayStep key={screen} onScene={setScene} onDone={() => advance("anywhere")} />}
      {screen === "address" && <AddressStep key={screen} onScene={setScene} onNext={() => advance("address")} />}
      {screen === "agent" && <AgentStep key={screen} look={look ?? START_LOOK} setLook={setLook} devices={devices} onScene={setScene} onNext={() => advance("agent")} />}
      {screen === "devices" && <PhoneStep key={screen} onScene={setScene} onFinish={finish} />}
    </SetupStage>
  );
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

/** Keep a detected sign-in on the device; install a new harness there when requested. */
export async function makeFirstAgent(device: DeviceInfo, harness: string, name: string, agents: Agent[], computers: ComputerInfo[], appearance?: GhostAppearance) {
  const installed = device.harnesses?.some((h) => h.id === harness);
  const canVm = device.role !== "headless" && device.role !== "screen" && !!device.capabilities?.vm.ok;
  const inVm = !installed && runsInVm(harness) && canVm;
  if (!installed && !inVm) {
    await api("POST", `/api/nodes/${device.id}/install`, { harness });
    await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
  }
  const common = {
    name,
    handle: freeHandle(
      name,
      agents.map((a) => a.handle),
    ),
    harness,
    nodeId: device.id,
  };
  const look = appearance ? { appearance } : {};
  if (inVm) {
    // an AI that only runs inside a computer gets one of its own, with the AI in it
    let computer = computers.find((c) => c.kind === "vm" && c.nodeId === device.id && !c.agents.length);
    if (!computer) computer = await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: device.id, name: `${name}'s desk`, cpus: 2, memoryGb: 4 });
    return api<Agent>("POST", "/api/agents", { ...common, computerId: computer.id, settings: { runIn: "computer", ...look } });
  }
  // otherwise Wisp places it: the AI stays beside its sign-in, and it works on the shared computer
  return api<Agent>("POST", "/api/agents", { ...common, useDefaults: true, settings: look });
}

export type SkipResult = { kept: Agent } | { kept: null; reason: "nothing-to-keep" } | { kept: null; reason: "failed"; message: string };

/**
 * "Skip for now" on the agent step must not lose the agent the person just named: make it now
 * (without waiting for a sign-in; the Inbox says what it still needs) and only then move on.
 * With no computer or no name there is nothing to make; a failure is reported, never swallowed.
 */
export async function skipKeepingAgent(o: { device: DeviceInfo | undefined; harness: string; name: string; agents: Agent[]; computers: ComputerInfo[]; look: GhostAppearance; make?: typeof makeFirstAgent }): Promise<SkipResult> {
  if (!o.device || !o.name.trim()) return { kept: null, reason: "nothing-to-keep" };
  try {
    return { kept: await (o.make ?? makeFirstAgent)(o.device, o.harness, o.name.trim(), o.agents, o.computers, o.look) };
  } catch (e) {
    return { kept: null, reason: "failed", message: (e as Error).message || "something went wrong" };
  }
}

/** The AI that powers your first agent, signing in to it, and making the agent. */
function AgentStep({ look, setLook, devices, onScene, onNext }: { look: GhostAppearance; setLook: (l: GhostAppearance) => void; devices: DeviceInfo[] | null; onScene: (s: StageScene) => void; onNext: () => void }) {
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const usable = usableDevices(devices ?? []).filter((d) => d.online && !d.paused);
  const [deviceId, setDeviceId] = useState("");
  const device = usable.find((d) => d.id === deviceId) ?? usable.find((d) => d.mine) ?? usable[0];
  const [name, setName] = useState("Atlas");
  const [harness, setHarness] = useState("");
  const [view, setView] = useState<"look" | "harness">("look");
  // signing in from the Make button: make the agent as soon as that's done
  const [makeAfterSignIn, setMakeAfterSignIn] = useState(false);
  /** Wisp can't tell whether this AI is signed in, and the person says it is */
  const [unknownOk, setUnknownOk] = useState(false);
  const [settings, setSettings] = useState<HarnessSettings[]>([]);
  const [signingIn, setSigningIn] = useState<HarnessSettings | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSettings = async () => {
    if (!device) return;
    const data = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings`);
    setSettings(data.harnesses);
    return data.harnesses;
  };
  useEffect(() => {
    setSettings([]);
    setHarness("");
    setError(null);
    setCreated(null);
    if (!device) return;
    let alive = true;
    const load = () =>
      api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings`).then(
        (data) => {
          if (alive) setSettings(data.harnesses);
        },
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [device?.id]);
  const installed = device?.harnesses ?? [];
  const account = (s: HarnessSettings) => s.accounts.find((a) => a.isDefault) ?? s.accounts[0];
  // one that's signed in first: a harness that would fail its first reply is never preselected over one that works
  const selected =
    harness ||
    preferSignedIn(
      installed.map((h) => h.id),
      (id) => {
        const s = settings.find((x) => x.harness === id);
        return s ? account(s)?.signedIn : undefined;
      },
    ) ||
    "kimi";
  const pick = (id: string) => {
    setHarness(id);
    setUnknownOk(false);
    setError(null);
  };
  const create = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await makeFirstAgent(device, selected, name.trim(), agents, computers, look);
      setCreated(agent);
      setLook(look);
      await Promise.allSettled([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
      if (agent.settings.runIn !== "computer" && !unknownOk) {
        // read what the device says now: an AI that was just installed isn't in the list from before
        const fresh = await loadSettings().catch(() => undefined);
        const s = signInFor(fresh ?? settings, selected);
        if (s && device.mine) setSigningIn(s);
      }
    } catch (e) {
      setError(unavailable(e, "Agent setup"));
    } finally {
      setBusy(false);
    }
  };
  const [skipArmed, setSkipArmed] = useState(false);
  const skip = async () => {
    if (skipArmed) return onNext();
    setBusy(true);
    const r = await skipKeepingAgent({ device, harness: selected, name, agents, computers, look });
    setBusy(false);
    if (r.kept) {
      await Promise.allSettled([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
      return onNext();
    }
    if (r.reason === "failed") {
      setError(`Couldn't set up ${name.trim()} yet: ${r.message}. Press Skip for now again to go on without it; you can make it later from Agents.`);
      setSkipArmed(true);
      return;
    }
    onNext();
  };
  const displayName = name.trim() || "Atlas";
  const tag = created?.handle ?? freeHandle(displayName, agents.map((a) => a.handle));
  useEffect(() => {
    if (created && !signingIn) return onScene({ name: "made", look, tag, badge: created.harness, onBack: null });
    if (signingIn) return onScene({ name: "signin", look, badge: selected, onBack: null });
    if (view === "harness") return onScene({ name: "harness", look, tag, badge: selected, onBack: () => setView("look") });
    onScene({ name: "look", look, tag });
  }, [view, !!signingIn, !!created, look, tag, selected]);
  if (signingIn && device && account(signingIn)) {
    return (
      <HarnessSignInChat
        device={device}
        settings={signingIn}
        account={account(signingIn)}
        onClose={() => {
          setSigningIn(null);
          setMakeAfterSignIn(false);
        }}
        onDone={() => {
          setSigningIn(null);
          void loadSettings().catch(() => {});
          if (makeAfterSignIn) {
            setMakeAfterSignIn(false);
            void create();
          }
        }}
      />
    );
  }
  if (created) {
    const settingsNow = settings.find((s) => s.harness === created.harness);
    return <AgentCreated agent={created} device={device?.name} onSignIn={device?.mine && settingsNow && account(settingsNow) ? () => setSigningIn(settingsNow) : undefined} onNext={onNext} />;
  }
  if (view === "look") {
    return (
      <>
        <Thread title="Create your agent" sub="Name it and make it yours.">
          <Field label="Name">
            <Input className="h-[42px]! rounded-lg! bg-card!" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <LookPicker look={look} onChange={setLook} />
        </Thread>
        <Actions>
          <SetupButton variant="secondary" onClick={() => setLook(randomAppearance())}>
            <Shuffle size={16} />
            Shuffle
          </SetupButton>
          <SetupButton disabled={!name.trim()} onClick={() => setView("harness")}>
            Continue
          </SetupButton>
        </Actions>
      </>
    );
  }
  const current = settings.find((s) => s.harness === selected);
  const signedIn = current ? account(current)?.signedIn : undefined;
  const needsSignIn = !!device?.mine && !!current && !!account(current) && signedIn !== true && !(signedIn === null && unknownOk);
  const noNode = !!error && NO_NODE.test(error);
  const notInstalled = HARNESSES.filter((h) => h.protocol !== "mcp" && (h.install?.npm || (runsInVm(h.id) && device?.capabilities?.vm.ok)) && !installed.some((i) => i.id === h.id));
  const isInstalled = installed.some((h) => h.id === selected);
  return (
    <>
      <Thread title={`What powers ${displayName}?`} sub="You can change this later.">
        {usable.length > 1 && (
          <label className="self-start flex items-center gap-3 text-sm text-muted">
            Computer
            <select className="rounded-xl border border-line bg-card p-2 text-ink" value={device?.id} onChange={(e) => setDeviceId(e.target.value)}>
              {usable.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div role="radiogroup" aria-label="Agent app" className="grid grid-cols-2 gap-2">
          {installed.map((h) => {
            const s = settings.find((s) => s.harness === h.id);
            const state = s ? account(s)?.signedIn : undefined;
            return <HarnessChoice key={h.id} title={harnessLabel(h.id)} body={state === true ? "Signed in" : state === false ? "Needs sign-in" : state === null ? "Sign-in unknown" : "On this computer"} selected={selected === h.id} onClick={() => pick(h.id)} icon={<HarnessLogo harness={h.id} size={24} />} />;
          })}
          {notInstalled.map((h) => (
            <HarnessChoice key={h.id} title={h.label} body="Wisp installs it" selected={selected === h.id} onClick={() => pick(h.id)} icon={<HarnessLogo harness={h.id} size={24} />} />
          ))}
        </div>
        {!device && (
          <p role="status" className="text-sm text-muted">
            Waiting for a computer to connect; you can skip this for now.
          </p>
        )}
        {noNode ? (
          <p role="alert" className="text-sm text-bad">
            {harnessLabel(selected)} needs Node.js, and this computer doesn't have it.{" "}
            <a href="https://nodejs.org" target="_blank" rel="noreferrer" className="text-info hover:underline">
              Get Node.js
            </a>
            , install it, then try again.
          </p>
        ) : (
          <Problem>{error}</Problem>
        )}
      </Thread>
      <Actions>
        {needsSignIn ? (
          <SetupButton
            disabled={busy || !current}
            onClick={() => {
              if (!current) return;
              setMakeAfterSignIn(true);
              setSigningIn(current);
            }}
          >
            Sign in to {harnessLabel(selected)}
          </SetupButton>
        ) : (
          <SetupButton disabled={busy || !device || !name.trim() || (!device.mine && !isInstalled)} onClick={() => void create()}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? "Getting ready…" : noNode ? "Try again" : isInstalled ? `Make ${displayName}` : `Install ${harnessLabel(selected)} and make ${displayName}`}
          </SetupButton>
        )}
        {needsSignIn && signedIn === null && (
          <AuthLink onClick={() => setUnknownOk(true)} disabled={busy} className="self-center">
            It's already signed in
          </AuthLink>
        )}
        <AuthLink onClick={() => void skip()} disabled={busy} className="self-center">
          Skip for now
        </AuthLink>
      </Actions>
    </>
  );
}

const SWATCHES: { name: string; color: string; color2: string }[] = [
  { name: "White", ...GHOST_WHITE },
  ...["Bubblegum sky", "Orchid peach", "Coral mint", "Arctic blue", "Solar flare", "Violet ember", "Ultraviolet tide"].map((n) => GHOST_PALETTES.find((p) => p.name === n)!),
];
const HATS: [string, GhostAppearance["hat"]][] = [["None", "none"], ["Top hat", "tophat"], ["Crown", "crown"], ["Beanie", "beanie"], ["Party", "party"]];

/** The agent's color, shape and hat; the wisp on the stage shows each change. */
function LookPicker({ look, onChange }: { look: GhostAppearance; onChange: (l: GhostAppearance) => void }) {
  const label = "block text-[13px] font-medium text-muted mb-1.5";
  return (
    <>
      <div>
        <span className={label}>Color</span>
        <div className="flex gap-2">
          {SWATCHES.map((s) => (
            <button key={s.name} type="button" aria-label={s.name} title={s.name} aria-pressed={look.color === s.color && look.color2 === s.color2} className="setup-swatch" style={{ background: `linear-gradient(${s.color}, ${s.color2})` }} onClick={() => onChange({ ...look, color: s.color, color2: s.color2 })} />
          ))}
        </div>
      </div>
      <div>
        <span className={label}>Shape</span>
        <div className="flex gap-1.5">
          {(Object.keys(SHAPES) as GhostAppearance["shape"][]).map((s) => (
            <button key={s} type="button" aria-label={s} aria-pressed={look.shape === s} className="setup-shape" onClick={() => onChange({ ...look, shape: s })}>
              <svg viewBox="16 6 88 108" width="100%" height="100%" aria-hidden>
                <path d={SHAPES[s].body[0]} fill="currentColor" />
              </svg>
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className={label}>Hat</span>
        <div className="flex flex-wrap gap-1.5">
          {HATS.map(([n, hat]) => (
            <button key={hat} type="button" aria-pressed={look.hat === hat} className="setup-chip" onClick={() => onChange({ ...look, hat })}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** A harness you can pick: its logo, name, and whether it's here or signed in. */
export function HarnessChoice({
  title,
  body,
  selected,
  onClick,
  icon = <Bot size={24} />,
}: {
  title: string;
  body: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onClick} className="setup-choice setup-tile">
      <span className="shrink-0 grid place-items-center">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-medium leading-tight truncate">{title}</span>
        <span className="block text-xs mt-px text-muted truncate">{body}</span>
      </span>
    </button>
  );
}

/**
 * Signing an AI in without a terminal: the computer starts the harness's sign-in and Wisp shows
 * the link and code it prints (and takes the code the page gives you back). The same flow as
 * Settings' sign-in.
 */
function HarnessSignInChat({ device, settings, account, onClose, onDone }: { device: HarnessesResponse["device"]; settings: HarnessSettings; account: HarnessSettings["accounts"][number]; onClose: () => void; onDone: () => void }) {
  const label = harnessLabel(settings.harness);
  const perProvider = settings.harness === "hermes";
  const [provider, setProvider] = useState(settings.provider ?? settings.providers?.[0]?.id ?? "");
  const [login, setLogin] = useState<HarnessLogin | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (body: unknown) => api<any>("POST", `/api/nodes/${device.id}/harness-accounts/${settings.harness}`, body);
  const start = async () => {
    setError(null);
    try {
      const r = await act({ op: "login", account: account.id, ...(perProvider ? { provider } : {}) });
      if ("manual" in r) setManual(r.manual);
      else setLogin(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!perProvider) void start();
  }, []);
  useEffect(() => {
    if (!login || login.status !== "running") return;
    const t = setInterval(async () => {
      const next = await act({ op: "login_status", loginId: login.id }).catch(() => null);
      if (!next) return;
      setLogin(next);
      if (next.status === "done") onDone();
    }, 1500);
    return () => clearInterval(t);
  }, [login?.id, login?.status]);
  const close = () => {
    if (login?.status === "running") void act({ op: "login_cancel", loginId: login.id }).catch(() => {});
    onClose();
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!login || !code.trim()) return;
    setLogin(await act({ op: "login_input", loginId: login.id, text: code.trim() }));
    setCode("");
    setPasting(false);
  };
  const choosing = perProvider && !login && !manual;
  return (
    <>
      <Thread title={`Sign in to ${label}`}>
        {choosing && (
          <>
            <Msg>Which account should {label} sign in with?</Msg>
            <label className="self-start flex items-center gap-3 text-sm text-muted">
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded-xl border border-line bg-card p-2 text-ink">
                {(settings.providers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {manual && (
          <>
            <Msg>
              {label} signs in on its own screen. On {device.name}, run:
            </Msg>
            <CopyBlock text={manual} />
          </>
        )}
        {login?.status === "running" && (
          <>
            {login.url ? <Msg>Open the sign-in page{login.code ? ", then enter this code there." : ", then paste the code it gives you."}</Msg> : <Waiting>Starting {label}'s sign-in on {device.name}…</Waiting>}
            {login.code && (
              <div className="self-stretch flex flex-col items-center gap-3.5">
                <CodeTiles code={login.code} />
                <button
                  type="button"
                  className="setup-press h-9 px-4 rounded-lg bg-control border border-control-line text-[13px] font-medium inline-flex items-center gap-2 hover:bg-hover"
                  onClick={() => {
                    void navigator.clipboard?.writeText(login.code!);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
            )}
            {login.url && !login.code && pasting && (
              <form onSubmit={send} className="self-stretch flex items-center gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code the page gives you" aria-label="Code from the sign-in page" className="flex-1 h-12! rounded-full! bg-card! px-4!" autoFocus />
                <button type="submit" disabled={!code.trim()} className="h-12 px-5 rounded-full bg-accent text-accent-ink text-body font-medium disabled:opacity-50">
                  Send
                </button>
              </form>
            )}
            <Waiting>Waiting for you to finish there</Waiting>
          </>
        )}
        {login?.status === "done" && <Msg>Signed in.</Msg>}
        {login?.status === "failed" && <Msg className="text-bad whitespace-pre-wrap">{login.error ?? "The sign-in didn't finish."}</Msg>}
        <Problem>{error}</Problem>
      </Thread>
      <Actions>
        {choosing && (
          <SetupButton onClick={start} disabled={!provider}>
            Continue
          </SetupButton>
        )}
        {login?.status === "running" && login.url && (
          <a href={login.url} target="_blank" rel="noreferrer" className="h-[42px] w-full inline-flex items-center justify-center gap-2.5 rounded-lg bg-accent text-accent-ink text-body font-medium hover:bg-accent/90">
            <ExternalLink size={17} /> Open the sign-in page
          </a>
        )}
        {login?.status === "running" && login.url && !login.code && !pasting && (
          <AuthLink className="self-center" onClick={() => setPasting(true)}>
            Paste the code the page gives you
          </AuthLink>
        )}
        {login?.status === "failed" && (
          <SetupButton
            variant="secondary"
            onClick={() => {
              setLogin(null);
              if (!perProvider) void start();
            }}
          >
            Try again
          </SetupButton>
        )}
        {(login?.status === "done" || manual) && <SetupButton onClick={close}>Done</SetupButton>}
        {!(login?.status === "done" || manual) && (
          <AuthLink className="self-center" onClick={close}>
            Not now
          </AuthLink>
        )}
      </Actions>
    </>
  );
}

export function AgentCreated({ agent, device, onSignIn, onNext }: { agent: Agent; device?: string; onSignIn?: () => void; onNext: () => void }) {
  const inVm = agent.settings.runIn === "computer";
  const label = harnessLabel(agent.harness);
  // where it works, plainly; which device hosts what is for Advanced
  const { advanced } = useComputerMode();
  const computer = useStore((s) => s.computers).find((c) => c.id === agent.computerId);
  const place = advanced ? (device ? `, on ${device}` : "") : isSharedComputer(computer) || agent.settings.waitsForShared ? ", on the shared computer" : computer?.kind === "vm" ? ", on its own computer" : "";
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      api<{ signedIn: boolean | null }>("GET", `/api/agents/${agent.id}/harness`).then(
        (r) => {
          if (!alive) return;
          setSignedIn(r.signedIn);
          setChecked(true);
        },
        () => {},
      );
    void check();
    const t = setInterval(check, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent.id]);
  const waiting = checked && signedIn !== true;
  return (
    <>
      <Thread title={waiting ? `${agent.name} needs a sign-in` : `${agent.name} is made`} sub={`Uses ${label}${place}.`}>
        {waiting && <Msg>{signedIn === null && !inVm ? `Wisp can't tell if ${label} is signed in. If it isn't, ${agent.name} can't answer yet.` : `${agent.name} can't answer until you sign in to ${label}${inVm ? ` on ${agent.name}'s computer` : ""}.`}</Msg>}
        {waiting && screen && <Msg>Finish signing in on the computer's screen, then come back here. This page updates by itself.</Msg>}
        <Problem>{error}</Problem>
      </Thread>
      <Actions>
        {waiting && screen && (
          <a href={screen} target="_blank" rel="noreferrer" className="h-[42px] w-full inline-flex items-center justify-center gap-2.5 rounded-lg bg-control border border-control-line text-body font-medium hover:bg-hover">
            <Monitor size={17} /> Open the computer's screen
          </a>
        )}
        {waiting && !screen && inVm && (
          <SetupButton
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              // Open synchronously so browsers allow the sign-in window.
              const tab = window.open("about:blank", "_blank");
              try {
                const r = await api<{ computerId: string }>("POST", `/api/agents/${agent.id}/signin`);
                const to = href({ view: "computers", computerId: r.computerId });
                // setup stays open here; no window (a blocker, say) still leaves a link to open
                setScreen(to);
                if (tab) {
                  tab.opener = null;
                  tab.location.href = to;
                }
              } catch (e) {
                tab?.close();
                setError(unavailable(e, "Sign-in"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Monitor size={17} />}Sign in
          </SetupButton>
        )}
        {waiting && !inVm && onSignIn && (
          <SetupButton variant="secondary" onClick={onSignIn}>
            Sign in
          </SetupButton>
        )}
        <SetupButton onClick={onNext}>{waiting ? "Sign in later" : "Continue"}</SetupButton>
      </Actions>
    </>
  );
}

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
