import { useEffect, useState } from "react";
import { CalendarClock, Check, Cloud, FileText, KeyRound, Laptop, Loader2, Lock, Monitor, Play, Plus, Trash2, Video } from "lucide-react";
import { describeCron, harnessInfo, harnessLabel, nextRun, runsInVm, type Agent, type Routine } from "@wisp/core";
import { api } from "../api.ts";
import { useStore, type ComputerInfo } from "../store.ts";
import { go, href } from "../router.ts";
import { agentReadiness, computerKindLabel, useDevices, type DeviceInfo } from "../devices.ts";
import { AddComputer, ComputerMini } from "./ComputersView.tsx";
import { Intro } from "./SettingsParts.tsx";
import { Button, Field, Input, Modal, Pill, Textarea, cx, timeAgo } from "../components/ui.tsx";
import { Advanced, useSimple } from "../experience.tsx";

/** Harnesses Warren starts on a device (natively or over ACP), as opposed to ones that join through MCP. */
export function runsOnDevice(harness: string) {
  return harness.startsWith("acp:") || (harnessInfo(harness)?.protocol ?? "mcp") !== "mcp";
}

// --- Computer -------------------------------------------------------------------------------------

/**
 * Which computer the agent sees and uses. Agents aren't headless unless someone picks that here.
 */
export function ComputerPanel({ agent, nodes }: { agent: Agent; nodes: DeviceInfo[] }) {
  const computers = useStore((s) => s.computers);
  const agents = useStore((s) => s.agents);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = computers.find((c) => c.id === agent.computerId);
  const device = nodes.find((n) => n.id === agent.nodeId);
  const headless = !current && !!agent.settings.headless;

  const use = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await Promise.all([refreshAgents(), useStore.getState().refreshComputers()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const assign = (c: { id: string }) => api("PATCH", `/api/agents/${agent.id}`, { computerId: c.id });
  const quickVm = () =>
    use("vm", async () => {
      const c = await api<ComputerInfo>("POST", "/api/computers", { kind: "vm", nodeId: agent.nodeId, name: `${agent.name}'s desk`, cpus: 2, memoryGb: 4 });
      // a harness that comes with the VM moves in with it, unless someone already chose where it runs
      await api("PATCH", `/api/agents/${agent.id}`, { computerId: c.id, ...(runsInVm(agent.harness) && !agent.settings.runIn ? { settings: { runIn: "computer" } } : {}) });
    });
  const quickScreen = () => use("screen", async () => assign(await api<ComputerInfo>("POST", "/api/computers", { kind: "device", nodeId: agent.nodeId })));
  const goHeadless = () => {
    if (!confirm(`Run @${agent.handle} headless? It won't be able to see or use a screen: no websites, no apps, only its harness's own tools.`)) return;
    use("headless", () => api("PATCH", `/api/agents/${agent.id}`, { computerId: null, settings: { headless: true } }));
  };

  const others = computers.filter((c) => c.id !== agent.computerId);
  return (
    <div className="space-y-8 max-w-3xl">
      <section>
        <Intro title="Computer">
          <p>
            The computer @{agent.handle} works on: it opens apps and websites, signs in once and stays signed in, and keeps its files there. You can watch it live and take control anytime. Agents that share a computer share its files, browser and sign-ins, so they can hand work to each other.
          </p>
        </Intro>
        {current ? (
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-full sm:w-96">
              <ComputerMini computer={current} />
            </div>
            <div className="space-y-2 text-sm">
              <div className="font-medium">{current.name}</div>
              <div className="text-muted">{computerKindLabel(current, nodes)}</div>
              {current.agents.length > 1 && (
                <div className="text-muted">
                  Shared with{" "}
                  {agents
                    .filter((a) => current.agents.includes(a.id) && a.id !== agent.id)
                    .map((a) => `@${a.handle}`)
                    .join(", ")}
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button onClick={() => go({ view: "computers", computerId: current.id, teach: agent.id })}>
                  <Video size={15} /> Teach a task
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className={cx("rounded-xl border px-4 py-3 text-sm", headless || agent.computerId ? "border-line bg-bg text-muted" : "border-warn/40 bg-warn/10")}>
            {agent.computerId
              ? `@${agent.handle} uses ${device?.ownerName ?? "someone"}'s own screen, which only they can see.`
              : headless
                ? `@${agent.handle} runs headless: it can't see or use a screen. Give it a computer below to change that.`
                : `@${agent.handle} doesn't have a computer yet, so it can't use apps or websites. Pick one below.`}
          </div>
        )}
      </section>

      <RunsWhere agent={agent} device={device} />

      <section className="space-y-2">
        <h3 className="font-semibold text-sm">{current ? "Switch to" : "Give it"}</h3>
        <div className="grid sm:grid-cols-2 gap-2">
          {device && device.capabilities?.vm.ok && (
            <Option icon={<Monitor size={17} />} title={`A new VM on ${device.name}`} body="Its own desktop with Google Chrome. Doesn't touch your screen." busy={busy === "vm"} onClick={quickVm} />
          )}
          {device?.mine && (
            <Option
              icon={<Lock size={17} />}
              title="Your own screen"
              body={
                device.capabilities?.screen.off
                  ? `Off. Turn it on at ${device.name} with: warren node screen on`
                  : device.capabilities?.screen.ok === false
                    ? device.capabilities.screen.detail
                    : "Only while you lend it, and only for things you ask. For apps that only live on your computer."
              }
              disabled={device.capabilities?.screen.ok === false || others.some((c) => c.kind === "device" && c.nodeId === device.id) || current?.kind === "device"}
              busy={busy === "screen"}
              onClick={quickScreen}
            />
          )}
          {others.map((c) => (
            <Option key={c.id} icon={c.kind === "orgo" ? <Cloud size={17} /> : c.kind === "vm" ? <Monitor size={17} /> : <Laptop size={17} />} title={c.name} body={`${computerKindLabel(c, nodes)}${c.agents.length ? ` · used by ${agents.filter((a) => c.agents.includes(a.id)).map((a) => `@${a.handle}`).join(", ")}` : ""}`} busy={busy === c.id} onClick={() => use(c.id, () => assign(c))} />
          ))}
          <Option icon={<Plus size={17} />} title="Another computer…" body="A VM on a different device, or an Orgo cloud computer." onClick={() => setAdding(true)} />
        </div>
        {!headless && (
          <button onClick={goHeadless} disabled={!!busy} className="mt-2 text-xs text-muted hover:text-bad underline-offset-2 hover:underline">
            Run it headless instead (no computer)
          </button>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
      </section>

      {adding && (
        <AddComputer
          devices={nodes}
          nodeId={agent.nodeId}
          defaultName={`${agent.name}'s desk`}
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            use(c.id, () => assign(c));
          }}
        />
      )}
    </div>
  );
}

interface HarnessPlace {
  possible: boolean;
  inComputer: boolean;
  signedIn: boolean | null;
  computerId: string | null;
}

/**
 * Where the agent's harness runs: inside its VM (its shell, files and browser all stay in there,
 * and anyone can ask it for things) or directly on the device (it can reach the device's files).
 */
function RunsWhere({ agent, device }: { agent: Agent; device: DeviceInfo | undefined }) {
  const refreshAgents = useStore((s) => s.refreshAgents);
  const [info, setInfo] = useState<HarnessPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = harnessLabel(agent.harness);
  const load = () => api<HarnessPlace>("GET", `/api/agents/${agent.id}/harness`).then(setInfo, () => setInfo(null));
  useEffect(() => {
    load();
  }, [agent.id, agent.computerId, agent.settings.runIn, agent.harness]);
  if (!info || !runsOnDevice(agent.harness) || !device) return null;

  const set = async (runIn: "computer" | "device") => {
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/agents/${agent.id}`, { settings: { runIn } });
      await refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ computerId: string }>("POST", `/api/agents/${agent.id}/signin`);
      go({ view: "computers", computerId: r.computerId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-sm">Where {label} runs</h3>
      {!info.possible ? (
        <p className="text-sm text-muted">
          Directly on {device.name}, where it can reach that device's files.{" "}
          {runsInVm(agent.harness) ? `Give it a VM on ${device.name} to run it inside that instead.` : `${label} doesn't come with Warren's VM yet, so it runs on the device.`}
        </p>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-2">
            <Option icon={<Monitor size={17} />} title={`Inside its computer${info.inComputer ? " ✓" : ""}`} body="Recommended. Its shell, files and browser all stay in the VM, so it can't touch the device, and anyone can ask it for things." busy={busy && !info.inComputer} disabled={info.inComputer} onClick={() => set("computer")} />
            <Option icon={<Laptop size={17} />} title={`On ${device.name}${!info.inComputer ? " ✓" : ""}`} body={`It can reach ${device.name}'s files and its own sign-in there. Only ${device.mine ? "you" : (device.ownerName ?? "the device's owner")} can ask it for things.`} busy={busy && info.inComputer} disabled={!info.inComputer} onClick={() => set("device")} />
          </div>
          {info.inComputer && info.signedIn === false && (
            <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm flex flex-wrap items-center gap-3">
              <span className="flex-1 min-w-48">
                {label} isn't signed in on its computer yet. Sign in once: a terminal opens on its screen, and you finish there (the browser opens in the VM too).
              </span>
              <Button variant="primary" disabled={busy} onClick={signIn}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} Sign in to {label}
              </Button>
            </div>
          )}
          {info.inComputer && info.signedIn === true && (
            <p className="text-sm text-ok flex items-center gap-1.5">
              <Check size={14} /> {label} is signed in on its computer.
            </p>
          )}
        </>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </section>
  );
}

function Option({ icon, title, body, onClick, busy, disabled }: { icon: React.ReactNode; title: string; body: string; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled || busy} onClick={onClick} className="text-left rounded-xl border border-line p-3 flex gap-3 hover:bg-hover disabled:opacity-50 disabled:pointer-events-none">
      <span className="size-8 shrink-0 rounded-lg bg-chip grid place-items-center text-muted">{busy ? <Loader2 size={16} className="animate-spin" /> : icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium truncate">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
      </span>
    </button>
  );
}

// --- Routines ---------------------------------------------------------------------------------------

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Longest name the hub accepts for a routine. */
const NAME_MAX = 80;

/** A short routine name from what the person wants done: the first sentence, cut at a word. */
export function routineName(name: string, result: string): string {
  const given = name.trim();
  if (given) return given.slice(0, NAME_MAX);
  const first = (result.trim().split(/[.!?\n]/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (first.length <= 50) return first;
  const cut = first.slice(0, 50);
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim() + "…";
}

/** The steps text saved with a routine: the goal first, then any steps the person wrote. */
export function routineSteps(result: string, steps: string): string {
  const goal = result.trim();
  const body = steps.trim();
  if (!goal) return steps;
  return body ? `Goal: ${goal}\n\n${body}` : `Goal: ${goal}\n\nNo steps were written. Work out the steps yourself, and adapt if something looks different next time.`;
}

/** Why a new routine can't be saved yet (null = fine). The hub needs a name of 1 to 80 characters. */
export function routineProblem(simple: boolean, name: string, result: string): string | null {
  if (simple && !result.trim()) return "Say what should happen.";
  if (!routineName(name, result)) return "Give the routine a name.";
  return null;
}

/** What the agent's schedules are waiting for: its device's name (or "a device"), or null when the device is connected or unknown. */
export function routinesWaitingFor(agent: Pick<Agent, "nodeId" | "harness" | "settings" | "computerId">, devices: DeviceInfo[] | null): string | null {
  if (agentReadiness(agent, devices).ready) return null;
  if (!agent.nodeId) return "a device";
  const device = devices?.find((d) => d.id === agent.nodeId);
  return device && (!device.online || device.paused) ? device.name : null;
}

/** Tasks the agent knows how to do again, learned by watching or written down, some on a schedule. */
export function RoutinesPanel({ agent, active }: { agent: Agent; active: boolean }) {
  const version = useStore((s) => s.routinesVersion);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const waitingFor = routinesWaitingFor(agent, useDevices());
  const [writing, setWriting] = useState(false);
  const [scheduling, setScheduling] = useState<Routine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (active) api<Routine[]>("GET", `/api/routines?agent=${agent.id}`).then(setRoutines, () => setRoutines([]));
  }, [active, agent.id, version]);

  const teach = () => (agent.computerId ? go({ view: "computers", computerId: agent.computerId, teach: agent.id }) : go({ view: "agents", agentId: agent.id, tab: "computer" }));
  const run = async (r: Routine) => {
    setError(null);
    try {
      const res = await api<{ channelId: string }>("POST", `/api/routines/${r.id}/run`);
      await useStore.getState().refreshChannels();
      go({ view: "chat", channelId: res.channelId, threadId: null });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <Intro title="Routines">
        <p>A routine is something your helper does on a schedule, like dinner ideas every Monday.</p>
        <p>Things @{agent.handle} knows how to do again on its own. Teach one by doing the task once while it watches, or write the steps yourself. Routines can run on a schedule.</p>
      </Intro>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={teach} title={agent.computerId ? undefined : "Give it a computer first"}>
          <Video size={15} /> Teach a task
        </Button>
        <Button onClick={() => setWriting(true)}>
          <FileText size={15} /> Write a routine
        </Button>
      </div>
      {!agent.computerId && <p className="text-xs text-muted">Teaching needs a computer: pick one on the Computer tab.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {routines === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : routines.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">No routines yet.</p>
      ) : (
        <div className="space-y-2">
        {waitingFor && <p className="text-xs text-muted">Schedules are saved. They run once {waitingFor} is connected.</p>}
        <div className="rounded-xl border border-line divide-y divide-line">
          {routines.map((r) => {
            const next = r.schedule && r.enabled && r.status === "ready" ? nextRun(r.schedule, r.timezone) : null;
            return (
              <div key={r.id} className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-56 flex-1">
                  <div className="font-medium flex items-center gap-2">
                    {r.name}
                    {r.status === "learning" && <Pill tone="info">learning</Pill>}
                    {!r.enabled && <Pill>paused</Pill>}
                  </div>
                  <div className="text-xs text-muted">
                    {r.schedule ? `${describeCron(r.schedule)}${r.timezone !== TZ ? ` (${r.timezone})` : ""}` : "When someone runs it"}
                    {next && ` · next ${next.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}
                    {next && waitingFor && ` · waiting for ${waitingFor}`}
                    {r.lastRunAt && ` · last requested ${timeAgo(r.lastRunAt)}`}
                    {r.lastCompletedAt && ` · last completed ${timeAgo(r.lastCompletedAt)}`}
                  </div>
                </div>
                <a className="text-sm text-accent-text hover:underline" href={href({ view: "vault", path: r.notePath })}>
                  Steps
                </a>
                <Button variant="ghost" onClick={() => setScheduling(r)}>
                  <CalendarClock size={15} /> Schedule
                </Button>
                <Button disabled={r.status !== "ready"} onClick={() => run(r)}>
                  <Play size={15} /> Run now
                </Button>
                <button
                  className="p-2 rounded-md text-muted hover:text-bad hover:bg-hover"
                  title="Delete routine"
                  onClick={async () => {
                    if (!confirm(`Delete the routine "${r.name}"? Its steps stay in memory.`)) return;
                    await api("DELETE", `/api/routines/${r.id}`);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
        </div>
      )}
      {writing && <WriteRoutine agent={agent} onClose={() => setWriting(false)} />}
      {scheduling && <ScheduleDialog routine={scheduling} onClose={() => setScheduling(null)} />}
    </div>
  );
}

function WriteRoutine({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const simple = useSimple();
  const [result, setResult] = useState("");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState(simple ? "" : "1. \n2. \n3. ");
  const [schedule, setSchedule] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`New routine for ${agent.name}`} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const problem = routineProblem(simple, name, result);
          if (problem) return setError(problem);
          try {
            await api("POST", "/api/routines", { agentId: agent.id, name: routineName(name, result), steps: simple ? routineSteps(result, steps) : steps, schedule, timezone: TZ });
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        {simple && (
          <Field label="What should happen?">
            <Textarea rows={3} value={result} onChange={(e) => setResult(e.target.value)} placeholder="Send me three dinner ideas with a shopping list" required />
          </Field>
        )}
        <Field label="Name" hint={simple ? "Leave it empty and we will name it for you." : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={simple ? "Dinner ideas" : "Inbox zero"} required={!simple} />
        </Field>
        {simple ? (
          <Field label="Steps (optional)" hint="Your helper works out the steps if you leave this empty.">
            <Textarea rows={5} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="1. Look at what is in the fridge" />
          </Field>
        ) : (
          <Field label="Steps" hint="Name buttons and fields by their labels, say what changes each time, and what done looks like.">
            <Textarea rows={8} value={steps} onChange={(e) => setSteps(e.target.value)} />
          </Field>
        )}
        <ScheduleEditor value={schedule} onChange={setSchedule} />
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary">Save routine</Button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleDialog({ routine, onClose }: { routine: Routine; onClose: () => void }) {
  const [schedule, setSchedule] = useState(routine.schedule);
  const [enabled, setEnabled] = useState(routine.enabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`When does "${routine.name}" run?`} onClose={onClose}>
      <div className="space-y-4">
        <ScheduleEditor value={schedule} onChange={setSchedule} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On
        </label>
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api("PATCH", `/api/routines/${routine.id}`, { schedule, enabled, timezone: TZ });
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Preset = "none" | "daily" | "weekdays" | "weekly" | "hourly" | "custom";

function presetOf(cron: string | null): { preset: Preset; time: string; day: number } {
  const m = cron?.match(/^(\d+) (\d+) \* \* (\*|1-5|\d)$/);
  if (!cron) return { preset: "none", time: "09:00", day: 1 };
  if (cron === "0 * * * *") return { preset: "hourly", time: "09:00", day: 1 };
  if (!m) return { preset: "custom", time: "09:00", day: 1 };
  const time = `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
  return m[3] === "*" ? { preset: "daily", time, day: 1 } : m[3] === "1-5" ? { preset: "weekdays", time, day: 1 } : { preset: "weekly", time, day: Number(m[3]) };
}

/** Plain choices ("every weekday at 9:00") that write a cron schedule; custom cron for the rest. */
function ScheduleEditor({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const simple = useSimple();
  const init = presetOf(value);
  const [preset, setPreset] = useState<Preset>(init.preset);
  // an existing custom schedule stays in plain view; a new one is typed under Advanced in Simple
  const [startedCustom] = useState(init.preset === "custom");
  const [time, setTime] = useState(init.time);
  const [day, setDay] = useState(init.day);
  const [custom, setCustom] = useState(value ?? "0 9 * * 1-5");
  const [h, m] = time.split(":").map(Number);
  const at = `${m || 0} ${h || 0}`;
  const cron = preset === "none" ? null : preset === "hourly" ? "0 * * * *" : preset === "daily" ? `${at} * * *` : preset === "weekdays" ? `${at} * * 1-5` : preset === "weekly" ? `${at} * * ${day}` : custom.trim();
  useEffect(() => {
    onChange(cron);
  }, [cron]);
  const selectCls = "h-9 rounded-lg border border-line bg-panel px-2 text-sm";
  // Simple keeps a custom schedule out of the list, but never hides one that is already set.
  const customInput = (
    <label className="flex flex-col gap-1 text-xs text-muted">
      Custom schedule (cron)
      <Input
        className="w-48 font-mono"
        value={custom}
        onChange={(e) => {
          setCustom(e.target.value);
          setPreset("custom");
        }}
        placeholder="0 9 * * 1-5"
      />
    </label>
  );
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">Schedule</span>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1 text-xs text-muted">
          How often
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={selectCls}>
            <option value="none">Only when someone runs it</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Every weekday</option>
            <option value="weekly">Every week</option>
            <option value="hourly">Every hour</option>
            {(!simple || preset === "custom") && <option value="custom">{simple ? "Custom schedule" : "Custom (cron)"}</option>}
          </select>
        </label>
        {preset === "weekly" && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Day
            <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={selectCls}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  on {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {["daily", "weekdays", "weekly"].includes(preset) && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={selectCls} />
          </label>
        )}
        {preset === "custom" && (!simple || startedCustom) && customInput}
      </div>
      {simple && !startedCustom && <Advanced title="Custom schedule">{customInput}</Advanced>}
      <p className="text-xs text-muted">{cron ? `${describeCron(cron)}, in ${TZ}.` : "Run it from here, or ask the helper in chat."}</p>
    </div>
  );
}
