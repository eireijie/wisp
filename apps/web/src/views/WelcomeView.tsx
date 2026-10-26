import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Bot, Check, Copy, ExternalLink, Globe, Loader2, Monitor, Plus, ShieldCheck } from "lucide-react";
import { HARNESSES, harnessLabel, runsInVm, type Agent, type HarnessLogin, type HarnessSettings } from "@wisp/core";
import { api } from "../api.ts";
import { awayEnabled, enableTailscale } from "../components/Access.tsx";
import { skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { completeSetupStep, nextStep, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { canApproveJoin, unavailable } from "../join.ts";
import { AddDeviceContent } from "../components/AddDevice.tsx";
import { AuthButton, AuthInput, AuthLink } from "../components/auth.tsx";
import { WispGhost } from "../components/icons.tsx";
import { MoreOptions } from "../components/MoreOptions.tsx";
import { CopyBlock, Field, Input, cx } from "../components/ui.tsx";
import type { HarnessesResponse } from "./settings/harnesses.tsx";
import { freeHandle } from "./CreateAgent.tsx";

export const SETUP_LABELS: Record<StepId, string> = { ready: "Getting ready", agent: "Make your first agent", anywhere: "Away from home", devices: "Add your devices" };

/**
 * Setting Wisp up, as a chat with Wisp: four steps (name it, pick the AI for your first helper,
 * away from home, add your devices). Wisp's lines are grey bubbles; what you picked comes back
 * as a blue one, and the next question follows below it.
 */
export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const { done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<StepId>(() => (intro ? "ready" : (nextStep(done) ?? "ready")));
  // what you answered on each step, shown as your bubble on the next one
  const [answers, setAnswers] = useState<Partial<Record<StepId, string>>>({});
  const advance = (step: StepId, answer?: string) => {
    completeSetupStep(me.workspace.id, step);
    if (answer) setAnswers((a) => ({ ...a, [step]: answer }));
    setScreen(STEPS[STEPS.indexOf(step) + 1] ?? "devices");
  };
  const finish = () => {
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go({ view: "dashboard" });
  };
  const index = STEPS.indexOf(screen);
  const before = STEPS[index - 1] ? answers[STEPS[index - 1]] : undefined;
  return (
    <div className="fixed inset-0 z-40 flex bg-app" data-testid="setup">
      <div className="hidden md:flex w-[84px] shrink-0 justify-center pt-5 text-ink" aria-hidden>
        <WispGhost size={34} />
      </div>
      <main className="flex-1 min-w-0 flex flex-col bg-panel md:my-2.5 md:mr-2.5 md:rounded-[28px]">
        <header className="shrink-0 w-full max-w-[640px] mx-auto px-[22px] pt-[max(1.5rem,env(safe-area-inset-top))] md:pt-8 flex items-center gap-3.5">
          {index > 0 ? (
            <button className="circle circle-sm" aria-label="Back" onClick={() => setScreen(STEPS[index - 1])}>
              <ArrowLeft size={18} strokeWidth={2} />
            </button>
          ) : (
            <span className="circle-sm size-11" aria-hidden />
          )}
          <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={4} aria-valuenow={index + 1} className="flex-1 h-1 rounded-full bg-chip">
            <div className="h-1 rounded-full bg-ink transition-[width]" style={{ width: `${((index + 1) / STEPS.length) * 100}%` }} />
          </div>
          <span className="min-w-8 text-right text-sm font-medium text-faint tabular-nums">{index + 1} / 4</span>
        </header>
        <div key={screen} className="wizard-in flex-1 min-h-0 flex flex-col">
          {screen === "ready" && <NameStep devices={devices} onNext={(workspace) => advance("ready", workspace)} />}
          {screen === "agent" && <AgentStep devices={devices} answer={before} onNext={(label) => advance("agent", label)} />}
          {screen === "anywhere" && <AwayStep answer={before} onDone={(label) => advance("anywhere", label)} />}
          {screen === "devices" && (
            <>
              <Thread>
                {before && <Me>{before}</Me>}
                <Msg>Last one. Add your phone and other computers.</Msg>
                <div className="rounded-3xl bg-card p-4 sm:p-5">
                  <AddDeviceContent />
                </div>
              </Thread>
              <Actions>
                <AuthButton onClick={finish}>Go to Wisp</AuthButton>
              </Actions>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** The conversation: Wisp's name and ghost on top, then the bubbles. */
function Thread({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-[640px] mx-auto px-[22px] pt-[18px] md:pt-10 pb-6 flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5 mb-0.5 text-ink">
          <WispGhost size={34} />
          <span className="text-[15px] font-semibold text-ink/80">Wisp</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** What you do next, pinned at the bottom. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="shrink-0 w-full max-w-[640px] mx-auto px-[22px] pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] flex flex-col gap-2.5 items-stretch">{children}</div>;
}

const bubble = "rounded-[22px] px-[17px] py-3 text-[17px] leading-[1.4] max-w-[84%]";
function Msg({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(bubble, "self-start bg-card", className)}>{children}</div>;
}
function Me({ children }: { children: ReactNode }) {
  return <div className={cx(bubble, "self-end bg-badge text-badge-ink max-w-[80%]")}>{children}</div>;
}
/** Wisp is waiting on you: three pulsing dots and what for. */
function Waiting({ children }: { children: ReactNode }) {
  return (
    <Msg className="flex items-center gap-2.5 text-[15px] text-muted">
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
    <div role={label ? "radiogroup" : undefined} aria-label={label} className="rounded-3xl bg-card overflow-hidden divide-y divide-line">
      {children}
    </div>
  );
}
const tile = "size-[38px] shrink-0 rounded-xl bg-chip grid place-items-center text-ink/85";

export function ReadyChecklist({ platform, devices }: { platform?: string; devices: DeviceInfo[] | null }) {
  const computer = platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";
  const names = [...new Set((devices ?? []).flatMap((d) => d.harnesses ?? []).map((h) => harnessLabel(h.id)))];
  const prepared = devices?.some((d) => d.online && d.capabilities?.vm.ok);
  const row = (ready: boolean, text: string, detail?: string) => (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 text-muted">{ready ? <Check size={18} /> : <Loader2 size={18} className="animate-spin" />}</span>
      <span className="text-[15px]">
        {text}
        {detail && <span className="block mt-0.5 text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
  return (
    <ul aria-live="polite" className="rounded-3xl bg-card px-[18px] py-1.5 divide-y divide-line">
      {row(true, `Wisp is running on this ${computer}`)}
      {row(names.length > 0, names.length ? `Found ${names.join(", ")}` : "Looking for agent apps…")}
      {row(!!prepared, prepared ? "Computers are ready for agents" : "Getting computers ready for agents…", prepared ? undefined : "About 2 min, you can keep going.")}
    </ul>
  );
}

/** Step 1: what to call your Wisp (and you), while Wisp looks around this computer. */
function NameStep({ devices, onNext }: { devices: DeviceInfo[] | null; onNext: (workspace: string) => void }) {
  const me = useStore((s) => s.me)!;
  const access = useAccess(3000);
  const [name, setName] = useState(me.user.name);
  const initial = /^(Warren|Wisp|Home)$/i.test(me.workspace.name) ? `${me.user.name}'s Wisp` : me.workspace.name;
  const [workspace, setWorkspace] = useState(initial);
  const [custom, setCustom] = useState(initial !== `${me.user.name}'s Wisp`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== me.user.name) await api("PATCH", "/api/me", { name: name.trim() });
      if (owner && workspace.trim() !== me.workspace.name) await api("PATCH", "/api/workspace", { name: workspace.trim() });
      await useStore.getState().load();
      onNext(workspace.trim());
    } catch (e) {
      setError(unavailable(e, "Setup"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex-1 min-h-0 flex flex-col">
      <Thread>
        <Msg>Hi, I'm Wisp. I'll get you set up in a minute.</Msg>
        <Msg>What should we call your Wisp?</Msg>
        <div className="mt-1.5">
          <ReadyChecklist platform={access?.hubPlatform} devices={devices} />
        </div>
      </Thread>
      <Actions>
        <AuthInput
          className="rounded-full px-[22px]"
          value={workspace}
          disabled={!owner}
          maxLength={60}
          required
          aria-label="Your Wisp"
          placeholder={`${me.user.name}'s Wisp`}
          onChange={(e) => {
            setCustom(true);
            setWorkspace(e.target.value);
          }}
        />
        <MoreOptions about="your name" className="self-center">
          <Field label="Your name">
            <Input
              className="h-11! rounded-2xl! bg-card!"
              value={name}
              maxLength={80}
              required
              autoComplete="name"
              onChange={(e) => {
                setName(e.target.value);
                if (!custom) setWorkspace(`${e.target.value.trim()}'s Wisp`);
              }}
            />
          </Field>
        </MoreOptions>
        <Problem>{error}</Problem>
        <AuthButton disabled={busy || !name.trim() || !workspace.trim()}>{busy && <Loader2 size={16} className="animate-spin" />}Continue</AuthButton>
      </Actions>
    </form>
  );
}

/** Keep a detected sign-in on the device; install a new harness there when requested. */
export async function makeFirstAgent(device: DeviceInfo, harness: string, name: string, agents: Agent[], computers: ComputerInfo[]) {
  const installed = device.harnesses?.some((h) => h.id === harness);
  const inVm = !installed && runsInVm(harness) && device.role !== "headless" && device.role !== "screen" && !!device.capabilities?.vm.ok;
  if (!installed && !inVm) {
    await api("POST", `/api/nodes/${device.id}/install`, { harness });
    await api("POST", `/api/nodes/${device.id}/refresh`).catch(() => {});
  }
  const canVm = device.role !== "headless" && device.role !== "screen" && !!device.capabilities?.vm.ok;
  let computer = canVm ? computers.find((c) => c.kind === "vm" && c.nodeId === device.id && !c.agents.length) : undefined;
  if (canVm && !computer) computer = await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: device.id, name: `${name}'s desk`, cpus: 2, memoryGb: 4 });
  if (device.role === "screen" && device.mine && device.capabilities?.screen.ok) {
    computer = computers.find((c) => c.kind === "device" && c.nodeId === device.id);
    if (!computer) computer = await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId: device.id });
  }
  return api<Agent>("POST", "/api/agents", {
    name,
    handle: freeHandle(
      name,
      agents.map((a) => a.handle),
    ),
    harness,
    nodeId: device.id,
    computerId: computer?.id ?? null,
    settings: inVm ? { runIn: "computer" } : computer ? { runIn: "device" } : { headless: true },
  });
}

/** Step 2: the AI that powers your first helper, signing in to it, and making the helper. */
function AgentStep({ devices, answer, onNext }: { devices: DeviceInfo[] | null; answer?: string; onNext: (label?: string) => void }) {
  const agents = useStore((s) => s.agents);
  const computers = useStore((s) => s.computers);
  const usable = usableDevices(devices ?? []).filter((d) => d.online && !d.paused);
  const [deviceId, setDeviceId] = useState("");
  const device = usable.find((d) => d.id === deviceId) ?? usable.find((d) => d.mine) ?? usable[0];
  const [name, setName] = useState("Atlas");
  const [harness, setHarness] = useState("");
  const [more, setMore] = useState(false);
  const [settings, setSettings] = useState<HarnessSettings[]>([]);
  const [signingIn, setSigningIn] = useState<HarnessSettings | null>(null);
  const [created, setCreated] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSettings = async () => {
    if (!device) return;
    const data = await api<HarnessesResponse>("GET", `/api/nodes/${device.id}/harness-settings`);
    setSettings(data.harnesses);
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
  const selected = harness || installed[0]?.id || "kimi";
  const account = (s: HarnessSettings) => s.accounts.find((a) => a.isDefault) ?? s.accounts[0];
  const pick = (id: string) => {
    setHarness(id);
    setError(null);
    const s = settings.find((s) => s.harness === id);
    if (s && account(s)?.signedIn === false && device?.mine) setSigningIn(s);
  };
  const create = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await makeFirstAgent(device, selected, name.trim(), agents, computers);
      setCreated(agent);
      await Promise.allSettled([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);
      if (agent.settings.runIn !== "computer") {
        await loadSettings().catch(() => {});
        const s = settings.find((s) => s.harness === selected);
        if (s && account(s)?.signedIn === false && device.mine) setSigningIn(s);
      }
    } catch (e) {
      setError(unavailable(e, "Agent setup"));
    } finally {
      setBusy(false);
    }
  };
  if (signingIn && device && account(signingIn)) {
    return (
      <HarnessSignInChat
        device={device}
        settings={signingIn}
        account={account(signingIn)}
        answer={answer}
        onClose={() => setSigningIn(null)}
        onDone={() => {
          setSigningIn(null);
          void loadSettings().catch(() => {});
        }}
      />
    );
  }
  if (created) return <AgentCreated agent={created} answer={harnessLabel(created.harness)} onNext={() => onNext(`${created.name} is made`)} />;
  const current = settings.find((s) => s.harness === selected);
  const needsSignIn = !!device?.mine && !!current && account(current)?.signedIn === false;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Thread>
        {answer && <Me>{answer}</Me>}
        <Msg>Nice. Now pick the AI that powers your first helper.</Msg>
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
        <Group label="Agent app">
          {installed.map((h) => {
            const s = settings.find((s) => s.harness === h.id);
            const signedIn = s ? account(s)?.signedIn : null;
            return <HarnessChoice key={h.id} title={harnessLabel(h.id)} body={signedIn === true ? "Signed in" : signedIn === false ? "Found on this computer. Sign in when you pick it." : "Found on this computer"} selected={selected === h.id} onClick={() => pick(h.id)} />;
          })}
          <HarnessChoice
            title="Hermes, Kimi, Gemini and more"
            body="Not installed yet. Wisp installs it."
            selected={!installed.some((h) => h.id === selected)}
            onClick={() => {
              setMore(!more);
              if (installed.some((h) => h.id === selected)) pick("kimi");
            }}
            icon={<Plus size={21} />}
          />
        </Group>
        {more && (
          <div role="radiogroup" aria-label="More agent apps" className="grid grid-cols-2 gap-2">
            {HARNESSES.filter((h) => h.protocol !== "mcp" && (h.install?.npm || (runsInVm(h.id) && device?.capabilities?.vm.ok)) && !installed.some((i) => i.id === h.id)).map((h) => (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={selected === h.id}
                className={cx("rounded-2xl border px-3.5 py-3 text-[15px] text-left", selected === h.id ? "border-ink bg-card" : "border-line hover:bg-hover")}
                onClick={() => pick(h.id)}
              >
                {h.label}
              </button>
            ))}
          </div>
        )}
        {!device && (
          <p role="status" className="text-sm text-muted">
            Waiting for this computer to connect; you can skip this for now.
          </p>
        )}
        <Problem>{error}</Problem>
      </Thread>
      <Actions>
        <MoreOptions about="the helper's name" className="self-center">
          <Field label="Name">
            <Input className="h-11! rounded-2xl! bg-card!" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
        </MoreOptions>
        {needsSignIn ? (
          <AuthButton disabled={busy || !current} onClick={() => current && setSigningIn(current)}>
            Sign in to {harnessLabel(selected)}
          </AuthButton>
        ) : (
          <AuthButton disabled={busy || !device || !name.trim() || (!device.mine && !installed.some((h) => h.id === selected))} onClick={() => void create()}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? "Getting ready…" : `Make ${name.trim() || "Atlas"}`}
          </AuthButton>
        )}
        <AuthLink onClick={() => onNext("Skipped for now")} disabled={busy} className="self-center">
          Skip for now
        </AuthLink>
      </Actions>
    </div>
  );
}

/** A harness you can pick: its name, whether it's found or signed in, and a check when chosen. */
export function HarnessChoice({
  title,
  body,
  selected,
  onClick,
  icon = <Bot size={21} />,
}: {
  title: string;
  body: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onClick} className="w-full flex items-center gap-3.5 px-[18px] py-3 min-h-16 text-left hover:bg-hover">
      <span className={tile}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[17px] font-medium">{title}</span>
        <span className="block text-sm mt-0.5 text-muted">{body}</span>
      </span>
      {selected && (
        <span className="size-6 shrink-0 rounded-full bg-badge text-badge-ink grid place-items-center" aria-hidden>
          <Check size={14} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/**
 * Signing an AI in without a terminal: the computer starts the harness's sign-in and Wisp shows
 * the link and code it prints (and takes the code the page gives you back). The same flow as
 * Settings' sign-in, told as part of the chat.
 */
function HarnessSignInChat({ device, settings, account, answer, onClose, onDone }: { device: HarnessesResponse["device"]; settings: HarnessSettings; account: HarnessSettings["accounts"][number]; answer?: string; onClose: () => void; onDone: () => void }) {
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
    <div className="flex-1 min-h-0 flex flex-col">
      <Thread>
        {answer && <Me>{answer}</Me>}
        <Me>{label}</Me>
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
              <div className="self-stretch rounded-3xl bg-card p-[18px] flex flex-col items-center gap-3.5">
                <div className="font-mono text-[34px] font-bold tracking-[0.15em]">{login.code}</div>
                <button
                  type="button"
                  className="h-11 px-5 rounded-full bg-control border border-control-line text-[15px] font-semibold inline-flex items-center gap-2 hover:bg-hover"
                  onClick={() => {
                    void navigator.clipboard?.writeText(login.code!);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check size={17} /> : <Copy size={17} />}
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
            )}
            {login.url && !login.code && pasting && (
              <form onSubmit={send} className="self-stretch flex items-center gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code the page gives you" aria-label="Code from the sign-in page" className="flex-1 h-12! rounded-full! bg-card! px-4!" autoFocus />
                <button type="submit" disabled={!code.trim()} className="h-12 px-5 rounded-full bg-accent text-accent-ink text-[15px] font-semibold disabled:opacity-50">
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
          <AuthButton onClick={start} disabled={!provider}>
            Continue
          </AuthButton>
        )}
        {login?.status === "running" && login.url && (
          <a href={login.url} target="_blank" rel="noreferrer" className="h-14 w-full inline-flex items-center justify-center gap-2.5 rounded-full bg-accent text-accent-ink text-[17px] font-semibold hover:bg-accent/90">
            <ExternalLink size={17} /> Open the sign-in page
          </a>
        )}
        {login?.status === "running" && login.url && !login.code && !pasting && (
          <AuthLink className="self-center" onClick={() => setPasting(true)}>
            Paste the code the page gives you
          </AuthLink>
        )}
        {login?.status === "failed" && (
          <AuthButton
            variant="secondary"
            onClick={() => {
              setLogin(null);
              if (!perProvider) void start();
            }}
          >
            Try again
          </AuthButton>
        )}
        {(login?.status === "done" || manual) && <AuthButton onClick={close}>Done</AuthButton>}
        {!(login?.status === "done" || manual) && (
          <AuthLink className="self-center" onClick={close}>
            Not now
          </AuthLink>
        )}
      </Actions>
    </div>
  );
}

function AgentCreated({ agent, answer, onNext }: { agent: Agent; answer?: string; onNext: () => void }) {
  const inVm = agent.settings.runIn === "computer";
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inVm) return;
    let alive = true;
    const check = () =>
      api<{ signedIn: boolean | null }>("GET", `/api/agents/${agent.id}/harness`).then(
        (r) => alive && setSignedIn(r.signedIn),
        () => {},
      );
    void check();
    const t = setInterval(check, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent.id, inVm]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Thread>
        {answer && <Me>{answer}</Me>}
        <Msg>{agent.name} is made.</Msg>
        {inVm && signedIn !== true && (
          <Msg>
            Sign in to {harnessLabel(agent.harness)} on {agent.name}'s computer.
          </Msg>
        )}
        <Problem>{error}</Problem>
      </Thread>
      <Actions>
        {inVm && signedIn !== true && (
          <AuthButton
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              // Open synchronously so browsers allow the sign-in window.
              const tab = window.open("about:blank", "_blank");
              try {
                const r = await api<{ computerId: string }>("POST", `/api/agents/${agent.id}/signin`);
                if (tab) {
                  tab.opener = null;
                  tab.location.href = href({ view: "computers", computerId: r.computerId });
                } else go({ view: "computers", computerId: r.computerId });
              } catch (e) {
                tab?.close();
                setError(unavailable(e, "Sign-in"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Monitor size={17} />}Sign in
          </AuthButton>
        )}
        <AuthButton onClick={onNext}>{inVm && signedIn !== true ? "Sign in later" : "Continue"}</AuthButton>
      </Actions>
    </div>
  );
}

/** Step 3: reach Wisp from anywhere (Tailscale or Cloudflare), or only at home. */
function AwayStep({ answer, onDone }: { answer?: string; onDone: (label: string) => void }) {
  const info = useAccess(3000);
  const failed = useAccessStore((s) => s.failed);
  const allowed = useStore((s) => canApproveJoin(s.me?.role));
  const [choice, setChoice] = useState<"tailscale" | "cloudflare" | null>(null);
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const platform = info?.hubPlatform === "darwin" ? "Mac" : info?.hubPlatform === "win32" ? "PC" : "computer";
  const signedIn = !!info && info.tailscale.state === "running";
  const back = () => {
    setChoice(null);
    setError(null);
    setHint(null);
  };
  const proceed = async () => {
    if (!choice) return;
    if (awayEnabled(info) && choice === "tailscale") return onDone("Yes, with Tailscale");
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      let ready = false;
      if (choice === "cloudflare") {
        const next = await api<AccessInfo>("POST", "/api/reach/cloudflare", { action: "start", token: credential.trim() });
        useAccessStore.setState({ info: next, failed: false });
        setCredential("");
        ready = awayEnabled(next);
      } else ready = await enableTailscale();
      if (ready) {
        setHint("Away from home is on.");
        onDone(choice === "cloudflare" ? "Yes, with Cloudflare" : "Yes, with Tailscale");
      } else setHint(choice === "cloudflare" ? "Cloudflare is connecting…" : "Finish setting up Tailscale, then choose Turn on away-from-home again.");
    } catch (e) {
      setError(unavailable(e, "Away from home"));
    } finally {
      setBusy(false);
    }
  };
  const notes = (
    <>
      {!info && failed && (
        <p role="status" className="text-sm text-muted">
          Away from home isn't available yet; you can keep going.
        </p>
      )}
      {!allowed && <p className="text-sm text-muted">Your Wisp's owner can turn this on.</p>}
      {info && awayEnabled(info) && (
        <p className="text-sm flex items-center gap-2">
          <Check size={15} />
          Away from home is on.
        </p>
      )}
      {hint && (
        <p role="status" className="text-sm text-muted">
          {hint}
        </p>
      )}
      <Problem>{error}</Problem>
    </>
  );
  const only = () => {
    skipAccess();
    onDone("Only at home for now");
  };
  if (choice === "tailscale") {
    const state = info?.tailscale.state;
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <Thread>
          {answer && <Me>{answer}</Me>}
          <Me>Yes, with Tailscale</Me>
          <Msg>{signedIn ? `Tailscale is already on this ${platform}. Nothing to set up.` : "Tailscale is a free app that links your devices. Install it on this computer, then sign in."}</Msg>
          <Group>
            <StatusRow done={!!state && state !== "missing"} icon={<ShieldCheck size={20} />} text="Tailscale is installed">
              {state === "missing" && info && (
                <a href={info.download} target="_blank" rel="noreferrer" className="text-sm text-info hover:underline">
                  Install Tailscale
                </a>
              )}
            </StatusRow>
            <StatusRow done={signedIn} icon={<ExternalLink size={20} />} text="Sign in to Tailscale">
              {info?.tailscale.authUrl && !signedIn && (
                <a href={info.tailscale.authUrl} target="_blank" rel="noreferrer" className="text-sm text-info hover:underline">
                  Open the Tailscale sign-in page
                </a>
              )}
            </StatusRow>
          </Group>
          {notes}
        </Thread>
        <Actions>
          <AuthButton disabled={busy || !allowed} onClick={() => void proceed()}>
            {busy && <Loader2 size={16} className="animate-spin" />}Turn on away-from-home
          </AuthButton>
          <AuthLink className="self-center" onClick={back}>
            Back to the options
          </AuthLink>
        </Actions>
      </div>
    );
  }
  if (choice === "cloudflare") {
    return (
      <form
        className="flex-1 min-h-0 flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void proceed();
        }}
      >
        <Thread>
          {answer && <Me>{answer}</Me>}
          <Me>Yes, with Cloudflare</Me>
          <Msg>Paste your Cloudflare setup code and I'll do the rest.</Msg>
          <Msg className="text-[15px] text-muted">Needs a domain you own.</Msg>
          {notes}
        </Thread>
        <Actions>
          <AuthInput type="password" autoComplete="off" className="rounded-full px-[22px]" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Setup code" aria-label="Cloudflare setup code" autoFocus />
          <AuthButton disabled={busy || !allowed || !credential.trim()}>
            {busy && <Loader2 size={16} className="animate-spin" />}Turn on away-from-home
          </AuthButton>
          <AuthLink className="self-center" onClick={back}>
            Back to the options
          </AuthLink>
        </Actions>
      </form>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Thread>
        {answer && <Me>{answer}</Me>}
        <Msg>Do you want to use Wisp away from home too?</Msg>
        <Msg className="text-[15px] text-muted">So your phone and laptop work on any Wi-Fi or on cell data.</Msg>
        {notes}
      </Thread>
      <Actions>
        <AuthButton
          disabled={busy || !allowed}
          onClick={() => {
            if (awayEnabled(info)) return onDone("Yes, with Tailscale");
            setChoice("tailscale");
          }}
        >
          <ShieldCheck size={19} /> Yes, with Tailscale
        </AuthButton>
        <AuthButton variant="secondary" disabled={busy || !allowed} onClick={() => setChoice("cloudflare")}>
          <Globe size={19} /> Yes, with Cloudflare
        </AuthButton>
        <AuthLink className="self-center" onClick={only}>
          Only at home for now
        </AuthLink>
      </Actions>
    </div>
  );
}

function StatusRow({ done, icon, text, children }: { done: boolean; icon: ReactNode; text: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 px-[18px] py-3 min-h-16">
      <span className={tile}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-[17px] font-medium">{text}</span>
        {children}
      </span>
      {done ? <Check size={20} className="text-ok shrink-0" aria-label="Done" /> : <Loader2 size={18} className="animate-spin text-muted shrink-0" aria-label="Waiting" />}
    </div>
  );
}
