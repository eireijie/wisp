import { useEffect, useRef, useState } from "react";
import { harnessLabel, type Agent, type Message } from "@wisp/core";
import type { GhostAppearance } from "@wisp/core/src/appearance.ts";
import type { MemoryLine } from "@wisp/core/src/memory-import.ts";
import { api } from "../../api.ts";
import { useStore } from "../../store.ts";
import { unavailable } from "../../join.ts";
import { StepHead, Spinner, Tick } from "../../components/SetupShell.tsx";
import type { DeviceInfo } from "../../devices.ts";
import { makeFirstAgent } from "./firstAgent.ts";
import type { Powered } from "./ConnectStep.tsx";

type TaskId = "computer" | "signin" | "memory" | "hello";
interface TaskState {
  done: boolean;
  note?: string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` gives a value (or the page leaves). */
async function until<T>(check: () => Promise<T | null | undefined>, alive: () => boolean, every = 1500): Promise<T | null> {
  while (alive()) {
    const v = await check().catch(() => null);
    if (v) return v;
    await wait(every);
  }
  return null;
}

/**
 * Setting up: makes the agent, then ticks off what really happens. Its computer is ready, its AI
 * can answer with no sign-in of its own, what it was told is saved to its notes, and it has written
 * its first message (with what it now knows). Nothing here runs on a timer of its own.
 */
export function SetupProgress({ device, powered, name, look, lines, onDone, onBack }: { device: DeviceInfo; powered: Powered; name: string; look: GhostAppearance; lines: MemoryLine[]; onDone: (agent: Agent, channelId: string | null) => void; onBack: () => void }) {
  const [tasks, setTasks] = useState<Record<TaskId, TaskState>>({ computer: { done: false }, signin: { done: false }, memory: { done: false }, hello: { done: false } });
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const alive = useRef(true);
  const label = harnessLabel(powered.harness);
  const order: TaskId[] = lines.length ? ["computer", "signin", "memory", "hello"] : ["computer", "signin", "hello"];
  const text: Record<TaskId, string> = {
    computer: `Starting ${name}'s computer`,
    signin: `Connecting ${label}`,
    memory: `Saving ${lines.length} ${lines.length === 1 ? "thing" : "things"} ${name} knows about you`,
    hello: `${name} is writing to you`,
  };
  const tick = (id: TaskId, note?: string) => alive.current && setTasks((t) => ({ ...t, [id]: { done: true, note } }));

  useEffect(() => {
    alive.current = true;
    if (started.current) return;
    started.current = true;
    const live = () => alive.current;
    void (async () => {
      try {
        const { agents, computers } = useStore.getState();
        const agent = await makeFirstAgent(device, powered.harness, name, agents, computers, look, powered.connectionId ?? undefined, { greetLater: true });
        await Promise.allSettled([useStore.getState().refreshAgents(), useStore.getState().refreshComputers()]);

        // its computer: ready when the hub says so; an agent with none works on the device itself
        const computer = (async () => {
          if (!agent.computerId) return tick("computer", `works on ${device.name}`);
          const ready = await until(async () => {
            await useStore.getState().refreshComputers();
            const c = useStore.getState().computers.find((x) => x.id === agent.computerId);
            if (c?.status === "error") throw new Error(`${c.name} didn't start`);
            return c?.status === "ready" ? c : null;
          }, live, 2500);
          if (ready) tick("computer");
        })();
        // its AI: signed in where it runs, which a connection always is
        const signin = (async () => {
          const r = await until(async () => {
            const h = await api<{ signedIn: boolean | null }>("GET", `/api/agents/${agent.id}/harness`);
            return h.signedIn === true || (h.signedIn === null && !powered.connectionId) ? h : null;
          }, live);
          if (r) tick("signin", powered.connectionId ? "no sign-in needed" : "signed in on " + device.name);
        })();
        const memory = (async () => {
          if (!lines.length) return;
          const r = await api<{ saved: number }>("POST", `/api/agents/${agent.id}/memory-import`, { lines: lines.map((l) => ({ heading: l.heading, text: l.text })) });
          tick("memory", `${r.saved} saved`);
        })();
        await Promise.all([signin, memory]);
        // the hello comes last, so it can use what was just saved
        await api("POST", `/api/agents/${agent.id}/greet`);
        await useStore.getState().refreshChannels();
        const dm = await until(async () => {
          await useStore.getState().refreshChannels();
          return useStore.getState().channels.find((c) => c.kind === "dm" && c.name.endsWith(`:${agent.id}`)) ?? null;
        }, live);
        if (!dm) return;
        const first = await until(async () => {
          const r = await api<{ messages: Message[] }>("GET", `/api/channels/${dm.id}/messages?limit=5`);
          return r.messages.find((m) => m.author.kind === "agent" && m.author.id === agent.id && m.body.trim()) ?? null;
        }, live);
        if (!first) return;
        tick("hello");
        await computer.catch(() => {});
        await wait(700);
        if (alive.current) onDone(agent, dm.id);
      } catch (e) {
        if (alive.current) setError(unavailable(e, "Setting up"));
      }
    })();
    return () => {
      alive.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const done = order.filter((id) => tasks[id].done).length;
  const now = order.find((id) => !tasks[id].done);
  return (
    <>
      <div className="flex flex-col items-center gap-2 pt-6 text-center">
        <StepHead title={`Setting up ${name}`} sub="About a minute. You can leave this page." />
      </div>
      <div className="ob-bar" role="progressbar" aria-label="Setting up" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={done}>
        <div style={{ width: `${Math.round((done / order.length) * 100)}%` }} />
      </div>
      <div className="ob-card py-1.5">
        {order.map((id) => {
          const t = tasks[id];
          return (
            <div key={id} className="ob-task">
              <span className="ob-task-state">{t.done ? <Tick size={16} /> : id === now && !error ? <Spinner /> : <span className="ob-task-later" />}</span>
              <span className="flex-1" style={{ color: t.done || id === now ? "var(--ink)" : "var(--faint)", fontWeight: id === now ? 600 : 400 }}>
                {text[id]}
              </span>
              {t.note && <span className="ob-note">{t.note}</span>}
            </div>
          );
        })}
      </div>
      {error && (
        <div className="ob-foot">
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
          <button type="button" className="ob-b" onClick={onBack}>
            Back
          </button>
        </div>
      )}
    </>
  );
}
