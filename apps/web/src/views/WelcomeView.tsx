import { useState } from "react";
import type { Agent } from "@bubble-ai/core";
import { completeSetupStep, featuresForExperience, setDismissed, setReadyItem, stepsFinished, welcomeReturn, type StepId } from "../onboarding.ts";
import { usableDevices, useDevices } from "../devices.ts";
import { useStore } from "../store.ts";
import { go } from "../router.ts";
import { openDm } from "../openDm.ts";
import { loadAnswers, saveAnswers } from "../onboardingV3.ts";
import type { GhostAppearance } from "@bubble-ai/core/src/appearance.ts";
import { api } from "../api.ts";
import { setFeatures } from "../features.ts";
import { FAMILY_COLORS } from "../ghostFamily.ts";
import { AgentStep, nextLook } from "./onboarding/AgentStep.tsx";
import { AIStep } from "./onboarding/AIStep.tsx";
import { introMessage, SETUP_GOALS, StartStep, YoursStep, yoursInstructions, type CheckIn, type SetupPath, type Talk } from "./onboarding/BubbleSetup.tsx";
import { lookOf } from "./onboarding/firstAgent.ts";
import { Stage } from "./onboarding/Stage.tsx";
import { macStepWanted, ThisMacStep } from "./onboarding/ThisMacStep.tsx";
import { AwayStep, awayStepWanted } from "./onboarding/AwayStep.tsx";
import { useAccess, useAccessStore } from "../access.ts";
import { startSetupTour, type SetupTourState } from "../components/onboarding/SetupTour.tsx";
export { askableOn, makeFirstAgent, NO_NODE } from "./onboarding/firstAgent.ts";

/** The first run's screens after the account ("You", which AuthScreen shows before anyone is signed in). */
export type WelcomeScreen = "mac" | "agent" | "start" | "ai" | "away" | "goals";

/**
 * The agent this first run is about: the one it made (remembered in this browser), else, coming
 * back from somewhere else, the oldest one this person made. None yet: "Your agent" makes it.
 */
export function firstRunAgent<A extends Pick<Agent, "id" | "createdAt" | "settings">>(savedId: string | null | undefined, agents: readonly A[], userId: string): A | undefined {
  // one it made and that has since been removed is not replaced by another: "Your agent" makes a new one
  if (savedId) return agents.find((a) => a.id === savedId);
  return agents.filter((a) => a.settings.createdBy === userId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

/**
 * Which screen shows. "Its AI" only ever shows for an agent that exists: with none, whatever was
 * asked for, it is "Your agent". A new setup and "See the welcome again" (`intro`) start there too.
 */
export function welcomeScreen(wanted: WelcomeScreen | null, o: { intro?: boolean; hasAgent: boolean; mac?: boolean }): WelcomeScreen {
  // in the desktop app on a Mac, first: let agents use this Mac (once)
  if (o.mac && (wanted ?? "mac") === "mac") return "mac";
  if (!o.hasAgent) return "agent";
  return wanted ?? (o.intro ? "agent" : "ai");
}

/**
 * What ending the first run marks done: the address and the agent once it exists; never the agent
 * step without one. Away from home is its own page now, done when it is on or skipped, so it is never ticked off here.
 */
export function finishedSteps(hasAgent: boolean): StepId[] {
  return hasAgent ? ["address", ...stepsFinished(true)] : [];
}

/** The pages in order, for the progress line and which way a page slides. */
const ORDER: WelcomeScreen[] = ["mac", "agent", "start", "ai", "away", "goals"];

/**
 * The first run after the account, all on one stage (Stage.tsx) that never unmounts: Your agent →
 * How it starts → Which AI app → Away from home (Tailscale; not for cloud servers), then for Advanced, Introduce yourself, then its chat, where the picks are
 * the person's first message and the agent answers with the apps it suggests connecting. The agent
 * is made when "Your agent" is continued, so it exists whatever happens next.
 */
export function WelcomeView({ intro }: { intro?: boolean }) {
  const me = useStore((s) => s.me)!;
  const agents = useStore((s) => s.agents);
  const devices = useDevices(3000);
  const ws = me.workspace.id;
  const usable = usableDevices(devices ?? []).filter((d) => d.online && !d.paused);
  const device = usable.find((d) => d.mine) ?? usable[0];
  const [agentId, setAgentId] = useState<string | null>(() => loadAnswers(ws).agentId ?? null);
  const agent = firstRunAgent(agentId, agents, me.user.id);
  const [wanted, setWanted] = useState<WelcomeScreen | null>(null);
  // only an owner's first run on their Mac; done once per workspace in this app
  const [mac] = useState(() => me.role === "owner" && macStepWanted(typeof window !== "undefined" ? window.wispDesktop : undefined, loadAnswers(ws).macReady));
  const screen = welcomeScreen(wanted, { intro, hasAgent: !!agent, mac });
  const [dir, setDir] = useState<1 | -1>(1);
  const goTo = (s: WelcomeScreen) => (setDir(ORDER.indexOf(s) >= ORDER.indexOf(screen) ? 1 : -1), setWanted(s));
  const [look, setLook] = useState<GhostAppearance>(() => agent?.settings.appearance ?? { ...lookOf(FAMILY_COLORS[0], "classic"), bubble: "round" });
  const [name, setName] = useState(agent?.name ?? "");
  const called = agent?.name ?? (name || "your agent");
  const [busy, setBusy] = useState(false);
  // away from home: asked once the AI is picked, unless this hub already has an address (cloud, domain, Tailscale on)
  useAccess(0);
  const reach = useAccessStore((s) => s.info);
  const reachFailed = useAccessStore((s) => s.failed);
  const [awayKept, setAwayKept] = useState(false);
  const away = awayKept || awayStepWanted({ owner: me.role === "owner", info: reach, failed: reachFailed });

  const finish = (channelId: string | null) => {
    for (const step of finishedSteps(!!agent)) completeSetupStep(ws, step);
    // what's left (phone, apps, away from home, getting to know you) stays under "Finish setup"
    if (agent) setReadyItem(ws, "started", true);
    setDismissed(true);
    if (channelId) go({ view: "chat", channelId, threadId: null });
    else if (agent) void openDm(agent.id).catch(() => go({ view: "dashboard" }));
    else go({ view: "dashboard" });
  };

  const [path, setPathState] = useState<SetupPath>(() => loadAnswers(ws).path ?? "advanced");
  const setPath = (p: SetupPath) => (setPathState(p), saveAnswers(ws, { path: p }));
  const [goals, setGoalsState] = useState<string[]>(() => {
    // picks saved by an older first run (Email, Calendar…) aren't these: start from the usual two
    const kept = (loadAnswers(ws).setupGoals ?? []).filter((g) => SETUP_GOALS.some((x) => x.id === g));
    return kept.length ? kept : ["days", "people"];
  });
  const setGoals = (g: string[]) => (setGoalsState(g), saveAnswers(ws, { setupGoals: g }));
  const [about, setAbout] = useState("");
  const [talk, setTalk] = useState<Talk>("friendly");
  const [when, setWhen] = useState<CheckIn>("morning");
  const person = me.user.preferredName || me.user.name;
  // the chat the AI step opened, kept while Advanced asks the rest
  const [chatId, setChatId] = useState<string | null>(null);
  const toChat = (tour: Omit<SetupTourState, "agentId">) => {
    if (agent) startSetupTour({ agentId: agent.id, ...tour });
    finish(chatId);
  };
  /** Simple or Advanced also sets the organization's features (an owner's choice; it changes nothing for a member). */
  const startNext = () => {
    if (me.role === "owner") void setFeatures(featuresForExperience(path)).catch(() => {});
    goTo("ai");
  };
  /** Introduce yourself: the agent's instructions, then the message the page showed goes to it as the person's first message; it answers in the chat with the apps to connect. */
  const saveYours = async () => {
    setBusy(true);
    if (agent) {
      await api("PATCH", `/api/agents/${agent.id}`, { instructions: yoursInstructions(agent.name, person, goals, talk, when, about) }).catch(() => {});
      // sent once; coming back to this page later doesn't send them again
      await api("POST", `/api/agents/${agent.id}/setup-picks`, { text: introMessage(called, person, goals, about, talk, when), goals }).catch(() => {});
    }
    setBusy(false);
    toChat({ path: "advanced", on: [], off: [] });
  };

  /** After the AI (and away from home): Advanced introduces itself; Simple goes to the chat. */
  const afterAway = (channelId: string | null) => {
    if (path === "advanced") goTo("goals");
    else {
      if (agent) startSetupTour({ agentId: agent.id, path: "simple", on: [], off: [] });
      finish(channelId);
    }
  };

  const steps = ORDER.filter((s) => (mac || s !== "mac") && (away || s !== "away") && (path === "advanced" || s !== "goals"));
  const at = Math.max(0, steps.indexOf(screen));
  const back: Partial<Record<WelcomeScreen, WelcomeScreen>> = { ...(mac ? { agent: "mac" as const } : {}), start: "agent", ai: "start", away: "ai", goals: away ? "away" : "ai" };
  // the first screen goes back to the page it was opened from (the chats list, Settings), when it was opened from one
  const from = welcomeReturn();
  const leave = screen === "agent" && from ? () => void (location.hash = from) : null;
  const onBack = busy || (screen === "ai" && chatId) ? null : back[screen] ? () => goTo(back[screen]!) : leave;

  let page;
  if (screen === "mac")
    page = (
      <ThisMacStep
        onDone={() => {
          saveAnswers(ws, { macReady: true });
          goTo("agent");
        }}
      />
    );
  else if (screen === "goals" && agent)
    page = <YoursStep name={called} person={person} goals={goals} onGoals={setGoals} about={about} onAbout={setAbout} talk={talk} onTalk={setTalk} when={when} onWhen={setWhen} onNext={() => void saveYours()} busy={busy} />;
  else if (screen === "start" && agent) page = <StartStep name={called} path={path} onPath={setPath} onNext={startNext} />;
  else if (screen === "ai" && agent)
    page = (
      <AIStep
        key={agent.id}
        agentId={agent.id}
        device={device}
        onBusy={setBusy}
        onDone={(channelId) => {
          setChatId(channelId);
          if (away) {
            setAwayKept(true);
            goTo("away");
          } else afterAway(channelId);
        }}
      />
    );
  else if (screen === "away" && agent) page = <AwayStep onDone={() => afterAway(chatId)} />;
  else
    page = (
      <AgentStep
        workspaceId={ws}
        person={me.user.name}
        device={device}
        existing={agent}
        look={look}
        onLook={setLook}
        onContinue={(id, n) => {
          saveAnswers(ws, { agentId: id });
          setAgentId(id);
          setName(n);
          goTo("start");
        }}
        // only offered after the hub wouldn't make the agent: leave, with the agent step still open
        onLeave={() => finish(null)}
      />
    );

  return (
    <Stage
      page={screen}
      dir={dir}
      look={screen === "agent" ? look : (agent?.settings.appearance ?? look)}
      seed={agent?.id}
      mood={busy ? "working" : "awake"}
      progress={(at + 1) / (steps.length + 1)}
      onBack={onBack}
      onBubble={screen === "agent" ? () => setLook((l) => nextLook(l)) : undefined}
    >
      {page}
    </Stage>
  );
}
