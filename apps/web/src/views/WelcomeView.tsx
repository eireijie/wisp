import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Check, Circle, Loader2, Monitor, Plus } from "lucide-react";
import { HARNESSES, harnessLabel, runsInVm, type Agent, type HarnessSettings } from "@wisp/core";
import { api } from "../api.ts";
import { useAccess } from "../access.ts";
import { completeSetupStep, nextStep, setDismissed, STEPS, useOnboarding, type StepId } from "../onboarding.ts";
import { usableDevices, useDevices, type DeviceInfo } from "../devices.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { unavailable } from "../join.ts";
import { AwayFromHome } from "../components/Access.tsx";
import { AddDeviceContent } from "../components/AddDevice.tsx";
import { Button, Field, Input, cx } from "../components/ui.tsx";
import { HarnessSignIn, type HarnessesResponse } from "./settings/harnesses.tsx";
import { freeHandle } from "./CreateAgent.tsx";

export const SETUP_LABELS: Record<StepId, string> = { ready: "Getting ready", agent: "Make your first agent", anywhere: "Away from home", devices: "Add your devices" };

export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const { done } = useOnboarding(3000);
  const devices = useDevices(3000);
  const [screen, setScreen] = useState<StepId>(() => (intro ? "ready" : (nextStep(done) ?? "ready")));
  const advance = (step: StepId) => {
    completeSetupStep(me.workspace.id, step);
    setScreen(STEPS[STEPS.indexOf(step) + 1] ?? "devices");
  };
  const finish = () => {
    completeSetupStep(me.workspace.id, "devices");
    setDismissed(true);
    go({ view: "dashboard" });
  };
  const index = STEPS.indexOf(screen);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-panel" data-testid="setup">
      <header className="h-16 shrink-0 px-5 sm:px-8 flex items-center gap-4 safe-top">
        <span className="text-sm font-semibold">Your Wisp</span>
        <span className="ml-auto text-sm text-muted">{index + 1} of 4</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className={cx("mx-auto px-5 sm:px-8 pt-6 sm:pt-12 pb-12", screen === "devices" ? "max-w-3xl" : "max-w-xl")}>
          <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={4} aria-valuenow={index + 1} className="grid grid-cols-4 gap-2 mb-9">
            {STEPS.map((id, i) => (
              <span key={id} className={cx("h-1 rounded-full", i <= index ? "bg-ink" : "bg-chip")} />
            ))}
          </div>
          {index > 0 && (
            <button className="mb-5 flex items-center gap-1 text-sm text-muted hover:text-ink" onClick={() => setScreen(STEPS[index - 1])}>
              <ArrowLeft size={15} />
              Back
            </button>
          )}
          <div key={screen} className="wizard-in">
            {screen === "ready" && <GettingReady devices={devices} onNext={() => advance("ready")} />}
            {screen === "agent" && <FirstAgent devices={devices} onNext={() => advance("agent")} />}
            {screen === "anywhere" && (
              <>
                <Heading title="Use Wisp away from home?">So your phone and laptop work on any Wi-Fi or on cell data.</Heading>
                <AwayFromHome onDone={() => advance("anywhere")} />
              </>
            )}
            {screen === "devices" && (
              <>
                <Heading title="Add your phone and other computers" />
                <AddDeviceContent />
                <div className="mt-7 flex justify-end gap-2">
                  <Button onClick={finish}>Done for now</Button>
                  <Button variant="primary" onClick={finish}>
                    Go to Wisp
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="mt-2 text-sm text-muted">{children}</p>}
    </div>
  );
}

export function ReadyChecklist({ platform, devices }: { platform?: string; devices: DeviceInfo[] | null }) {
  const computer = platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";
  const names = [...new Set((devices ?? []).flatMap((d) => d.harnesses ?? []).map((h) => harnessLabel(h.id)))];
  const prepared = devices?.some((d) => d.online && d.capabilities?.vm.ok);
  const row = (ready: boolean, text: string, detail?: string) => (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-0.5 text-muted">{ready ? <Check size={18} /> : <Loader2 size={18} className="animate-spin" />}</span>
      <span className="text-sm">
        {text}
        {detail && <span className="block mt-0.5 text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
  return (
    <ul aria-live="polite" className="mb-7 divide-y divide-line rounded-xl border border-line px-4">
      {row(true, `Wisp is running on this ${computer}`)}
      {row(names.length > 0, names.length ? `Found ${names.join(", ")}` : "Looking for agent apps…")}
      {row(!!prepared, prepared ? "Computers are ready for agents" : "Getting computers ready for agents…", prepared ? undefined : "About 2 min, you can keep going.")}
    </ul>
  );
}

function GettingReady({ devices, onNext }: { devices: DeviceInfo[] | null; onNext: () => void }) {
  const me = useStore((s) => s.me)!;
  const access = useAccess(3000);
  const [name, setName] = useState(me.user.name);
  const initial = /^(Warren|Wisp|Home)$/i.test(me.workspace.name) ? `${me.user.name}'s Wisp` : me.workspace.name;
  const [workspace, setWorkspace] = useState(initial);
  const [custom, setCustom] = useState(initial !== `${me.user.name}'s Wisp`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === "owner";
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (name.trim() !== me.user.name) await api("PATCH", "/api/me", { name: name.trim() });
          if (owner && workspace.trim() !== me.workspace.name) await api("PATCH", "/api/workspace", { name: workspace.trim() });
          await useStore.getState().load();
          onNext();
        } catch (e) {
          setError(unavailable(e, "Setup"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heading title="Getting ready" />
      <ReadyChecklist platform={access?.hubPlatform} devices={devices} />
      <div className="space-y-4">
        <Field label="Your name">
          <Input
            className="w-full h-11! bg-chip"
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
        <Field label="Your Wisp">
          <Input
            className="w-full h-11! bg-chip"
            value={workspace}
            disabled={!owner}
            maxLength={60}
            required
            onChange={(e) => {
              setCustom(true);
              setWorkspace(e.target.value);
            }}
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-bad">
          {error}
        </p>
      )}
      <div className="mt-7 flex justify-end">
        <Button variant="primary" disabled={busy || !name.trim() || !workspace.trim()}>
          {busy && <Loader2 size={15} className="animate-spin" />}Continue
        </Button>
      </div>
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

function FirstAgent({ devices, onNext }: { devices: DeviceInfo[] | null; onNext: () => void }) {
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
  return (
    <>
      <Heading title="Make your first agent" />
      {created ? (
        <AgentCreated agent={created} onNext={onNext} />
      ) : (
        <>
          {usable.length > 1 && (
            <label className="block mb-4 text-sm">
              Computer
              <select className="ml-3 rounded-lg border border-line bg-panel p-2" value={device?.id} onChange={(e) => setDeviceId(e.target.value)}>
                {usable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div role="radiogroup" aria-label="Agent app" className="space-y-3">
            {installed.map((h) => {
              const s = settings.find((s) => s.harness === h.id);
              const signedIn = s ? account(s)?.signedIn : null;
              return (
                <HarnessChoice
                  key={h.id}
                  title={harnessLabel(h.id)}
                  body={signedIn === true ? "Signed in" : signedIn === false ? "Sign in when you pick it" : "Checking sign-in…"}
                  selected={selected === h.id}
                  onClick={() => pick(h.id)}
                />
              );
            })}
            <HarnessChoice
              title="Hermes, Kimi, Gemini and more"
              body="Wisp installs it"
              selected={!installed.some((h) => h.id === selected)}
              onClick={() => {
                setMore(!more);
                if (installed.some((h) => h.id === selected)) pick("kimi");
              }}
              icon={<Plus size={21} />}
            />
          </div>
          {more && (
            <div role="radiogroup" aria-label="More agent apps" className="grid grid-cols-2 gap-2 mt-3">
              {HARNESSES.filter((h) => h.protocol !== "mcp" && (h.install?.npm || (runsInVm(h.id) && device?.capabilities?.vm.ok)) && !installed.some((i) => i.id === h.id)).map(
                (h) => (
                  <button
                    key={h.id}
                    role="radio"
                    aria-checked={selected === h.id}
                    className={cx("rounded-lg border p-3 text-sm text-left", selected === h.id ? "border-ink bg-hover" : "border-line")}
                    onClick={() => pick(h.id)}
                  >
                    {h.label}
                  </button>
                ),
              )}
            </div>
          )}
          {!device && (
            <p role="status" className="mt-4 text-sm text-muted">
              Waiting for this computer to connect; you can skip this for now.
            </p>
          )}
          <div className="mt-6">
            <Field label="Name">
              <Input className="w-full h-11! bg-chip" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          {error && (
            <p role="alert" className="mt-4 text-sm text-bad">
              {error}
            </p>
          )}
          <div className="mt-7 flex justify-end gap-2">
            <Button onClick={onNext} disabled={busy} variant="ghost">
              Skip
            </Button>
            <Button variant="primary" disabled={busy || !device || !name.trim() || (!device.mine && !installed.some((h) => h.id === selected))} onClick={() => void create()}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? "Getting ready…" : `Make ${name.trim() || "Atlas"}`}
            </Button>
          </div>
        </>
      )}
      {signingIn && device && account(signingIn) && (
        <HarnessSignIn device={device} settings={signingIn} account={account(signingIn)} onClose={() => setSigningIn(null)} onDone={() => void loadSettings().catch(() => {})} />
      )}
    </>
  );
}

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
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx("w-full flex items-center gap-4 rounded-xl border p-4 text-left", selected ? "border-ink bg-hover" : "border-line hover:bg-hover")}
    >
      <span className="text-muted">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm mt-1 text-muted">{body}</span>
      </span>
      {selected ? <Check size={17} /> : <Circle size={17} className="text-faint" />}
    </button>
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
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-line p-5">
        <Check size={21} />
        <span>{agent.name} is made.</span>
      </div>
      {inVm && signedIn !== true && (
        <>
          <p className="text-sm text-muted">
            Sign in to {harnessLabel(agent.harness)} on {agent.name}'s computer.
          </p>
          <Button
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
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Monitor size={15} />}Sign in
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onNext}>
          {inVm && signedIn !== true ? "Sign in later" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
