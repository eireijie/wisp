import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from "react";
import { Bot, Check, Copy, ExternalLink, Loader2, Monitor, Plus } from "lucide-react";
import { HARNESSES, harnessLabel, runsInVm, type Agent, type HarnessLogin, type HarnessSettings } from "@wisp/core";
import { api } from "../api.ts";
import { awayEnabled, enableTailscale } from "../components/Access.tsx";
import { onPublicAddress, skipAccess, useAccess, useAccessStore, type AccessInfo } from "../access.ts";
import { completeSetupStep, nextStep, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { canApproveJoin, unavailable } from "../join.ts";
import { AddDeviceContent } from "../components/AddDevice.tsx";
import { AuthButton, AuthInput, AuthLink } from "../components/auth.tsx";
import { PhonePairing } from "./settings/mobile.tsx";
import { CopyBlock, Field, Input, cx } from "../components/ui.tsx";
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
  const { done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<StepId>(() => (intro ? (onPublicAddress() ? "address" : "anywhere") : (nextStep(done) ?? "anywhere")));
  const advance = (step: StepId) => {
    completeSetupStep(me.workspace.id, step);
    setScreen(STEPS[STEPS.indexOf(step) + 1] ?? "devices");
  };
  const finish = () => {
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go({ view: "dashboard" });
  };
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-panel md:bg-app md:flex md:p-6" data-testid="setup">
      <main className="m-auto w-full min-h-full md:min-h-[500px] md:max-w-[472px] flex flex-col bg-panel p-8 pt-[max(2rem,env(safe-area-inset-top))] md:rounded-[10px] md:border md:border-line">
        <div key={screen} className="wizard-in flex-1 flex flex-col">
          {screen === "anywhere" && <AwayStep onDone={() => advance("anywhere")} />}
          {screen === "address" && <AddressStep onNext={() => advance("address")} />}
          {screen === "agent" && <AgentStep devices={devices} onNext={() => advance("agent")} />}
          {screen === "devices" && <PhoneStep onFinish={finish} />}
        </div>
      </main>
    </div>
  );
}

/** A screen's title, the line under it, and what goes with them. */
function Thread({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col gap-3.5 pb-3.5">
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
  return <AuthButton {...p} className={cx("h-[42px] rounded-lg", className)} />;
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
function AddressStep({ onNext }: { onNext: () => void }) {
  const info = useAccess(3000);
  const address = serverAddress(info);
  const [copied, setCopied] = useState(false);
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
        <SetupButton onClick={onNext}>Start using Wisp!</SetupButton>
      </Actions>
    </>
  );
}

/** Your phone, by QR code; other computers are one tap away. */
function PhoneStep({ onFinish }: { onFinish: () => void }) {
  const [computer, setComputer] = useState(false);
  return (
    <>
      {computer ? (
        <Thread title="Add a computer">
          <AddDeviceContent phone={false} />
        </Thread>
      ) : (
        <Thread title="Add your phone" sub="Scan this with the Wisp app.">
          <PhonePairing autoStart compact />
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

/** The AI that powers your first agent, signing in to it, and making the agent. */
function AgentStep({ devices, onNext }: { devices: DeviceInfo[] | null; onNext: () => void }) {
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
  const selected = harness || installed[0]?.id || "kimi";
  const account = (s: HarnessSettings) => s.accounts.find((a) => a.isDefault) ?? s.accounts[0];
  const pick = (id: string) => {
    setHarness(id);
    setError(null);
    const s = signInFor(settings, id);
    if (s && device?.mine) setSigningIn(s);
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
  if (signingIn && device && account(signingIn)) {
    return (
      <HarnessSignInChat
        device={device}
        settings={signingIn}
        account={account(signingIn)}
        onClose={() => setSigningIn(null)}
        onDone={() => {
          setSigningIn(null);
          void loadSettings().catch(() => {});
        }}
      />
    );
  }
  if (created) return <AgentCreated agent={created} onNext={onNext} />;
  const current = settings.find((s) => s.harness === selected);
  const needsSignIn = !!device?.mine && !!current && account(current)?.signedIn === false;
  return (
    <>
      <Thread title="Create your agent" sub="Pick the AI that powers it.">
        <Field label="Name">
          <Input className="h-[42px]! rounded-lg! bg-card!" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
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
            icon={<Plus size={20} />}
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
                className={cx("rounded-2xl border px-3.5 py-3 text-body text-left", selected === h.id ? "border-ink bg-card" : "border-line hover:bg-hover")}
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
        {needsSignIn ? (
          <SetupButton disabled={busy || !current} onClick={() => current && setSigningIn(current)}>
            Sign in to {harnessLabel(selected)}
          </SetupButton>
        ) : (
          <SetupButton disabled={busy || !device || !name.trim() || (!device.mine && !installed.some((h) => h.id === selected))} onClick={() => void create()}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? "Getting ready…" : `Make ${name.trim() || "Atlas"}`}
          </SetupButton>
        )}
        <AuthLink onClick={onNext} disabled={busy} className="self-center">
          Skip for now
        </AuthLink>
      </Actions>
    </>
  );
}

/** A harness you can pick: its name, whether it's found or signed in, and a check when chosen. */
export function HarnessChoice({
  title,
  body,
  selected,
  onClick,
  icon = <Bot size={20} />,
}: {
  title: string;
  body: string;
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onClick} className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-hover">
      <span className="shrink-0 text-ink/85">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-body font-medium">{title}</span>
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
              <div className="self-stretch rounded-lg border border-line bg-card p-[18px] flex flex-col items-center gap-3.5">
                <div className="font-mono text-[34px] font-bold tracking-[0.15em]">{login.code}</div>
                <button
                  type="button"
                  className="h-11 px-5 rounded-full bg-control border border-control-line text-body font-medium inline-flex items-center gap-2 hover:bg-hover"
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

function AgentCreated({ agent, onNext }: { agent: Agent; onNext: () => void }) {
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
    <>
      <Thread title={`${agent.name} is made`}>
        {inVm && signedIn !== true && (
          <Msg>
            Sign in to {harnessLabel(agent.harness)} on {agent.name}'s computer.
          </Msg>
        )}
        <Problem>{error}</Problem>
      </Thread>
      <Actions>
        {inVm && signedIn !== true && (
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
          </SetupButton>
        )}
        <SetupButton onClick={onNext}>{inVm && signedIn !== true ? "Sign in later" : "Continue"}</SetupButton>
      </Actions>
    </>
  );
}

/** Reach Wisp from outside your home (Tailscale or Cloudflare), or only at home. */
function AwayStep({ onDone }: { onDone: () => void }) {
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
  const state = info?.tailscale.state;
  useEffect(() => {
    if (choice !== "tailscale" || !info || !allowed || !state) return;
    if (awayEnabled(info)) return onDone();
    if (pushed.current === state) return;
    const fail = (e: unknown) => setError(unavailable(e, "Tailscale"));
    if (state === "needs-login" && !info.tailscale.authUrl) {
      pushed.current = state;
      useAccessStore.getState().act("login").then((next) => setLoginUrl(next.tailscale.authUrl ?? null), fail);
    } else if (state === "running" || state === "stopped") {
      pushed.current = state;
      enableTailscale().then((ready) => ready && onDone(), fail);
    }
  }, [choice, info, state, allowed, attempt]);
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
  if (choice === "tailscale") {
    const authUrl = info?.tailscale.authUrl ?? loginUrl;
    return (
      <>
        <Thread title="Connect Tailscale" sub="Wisp moves on by itself once both are done.">
          <Group>
            <StatusRow done={!!state && state !== "missing"} text="Tailscale is installed">
              {state === "missing" && info && (
                <a href={info.download} target="_blank" rel="noreferrer" className="block text-[13px] text-info hover:underline">
                  Install Tailscale
                </a>
              )}
            </StatusRow>
            <StatusRow done={state === "running"} text="Sign in to Tailscale">
              {authUrl && state !== "running" && (
                <a href={authUrl} target="_blank" rel="noreferrer" className="block text-[13px] text-info hover:underline">
                  Open the Tailscale sign-in page
                </a>
              )}
            </StatusRow>
          </Group>
          <Problem>{error}</Problem>
        </Thread>
        <Actions>
          {error && (
            <SetupButton
              onClick={() => {
                setError(null);
                pushed.current = null;
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </SetupButton>
          )}
          <AuthLink className="self-center" onClick={only}>
            Only at home for now
          </AuthLink>
        </Actions>
      </>
    );
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
          <AuthLink className="self-center" onClick={() => setChoice(null)}>
            Back
          </AuthLink>
        </Actions>
      </form>
    );
  }
  return (
    <>
      <Thread title="Use Wisp outside your home?" sub="So your phone and laptop work on any Wi-Fi or on cell data. Tailscale is a free app that links your devices.">
        {!info && failed && (
          <p role="status" className="text-sm text-muted">
            Away from home isn't available yet; you can keep going.
          </p>
        )}
        {!allowed && <p className="text-sm text-muted">Your Wisp's owner can turn this on.</p>}
      </Thread>
      <Actions>
        <SetupButton disabled={!allowed} onClick={() => setChoice("tailscale")}>
          Yes, with Tailscale
        </SetupButton>
        <SetupButton variant="secondary" disabled={!allowed} onClick={() => setChoice("cloudflare")}>
          Yes, with Cloudflare
        </SetupButton>
        <AuthLink className="self-center" onClick={only}>
          Only at home for now
        </AuthLink>
      </Actions>
    </>
  );
}

function StatusRow({ done, text, children }: { done: boolean; text: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 text-sm">
      <span className={cx("size-2 shrink-0 rounded-full", done ? "bg-ok" : "bg-muted animate-pulse")} aria-label={done ? "Done" : "Waiting"} />
      <span className="flex-1 min-w-0">
        {text}
        {children}
      </span>
    </div>
  );
}
