import { harnessInfo, harnessLabel, type Agent, type AgentSetup, type Message } from "@wisp/core";
import type { Hub } from "./hub.ts";

/**
 * A new agent speaks first. The hub writes its hello in its DM with whoever made it, so the
 * person sees it even when the model is slow, failing or not signed in yet; then the agent
 * asks a few setup questions, one at a time, in its own voice. Every answer is kept on the
 * agent (settings.setup) and shown to it in every prompt, so what the person said changes how
 * it works even if a model never saved a thing.
 */

/** After this long, a setup nobody finished is over, so a person coming back much later isn't quizzed. */
export const SETUP_DAYS = 7;
const ANSWER_CHARS = 600;
const skipped = (a: string) => !a || /^(skip|pass|no|nope|none|nothing|n\/a|not now|later|-)[.!]*$/i.test(a.trim());

export interface SetupQuestion {
  key: "first" | "apps" | "checkins" | "ask" | "style";
  /** the question in plain words, as Wisp asks it when the agent can't */
  ask: string;
  /** what the agent does with the answer */
  save: string;
}

/** The agent's job title: its own, or the one it holds on a team's chart. */
export function roleOf(hub: Hub, agent: Agent): string {
  const own = agent.settings.role?.trim();
  if (own) return own;
  for (const t of hub.store.teams(agent.workspaceId)) {
    const role = t.members.find((m) => m.agentId === agent.id)?.role.trim();
    if (role) return role;
  }
  return "";
}

/** The setup questions, in order; the first one fits the agent's role when it has one. */
export function setupQuestions(role: string): SetupQuestion[] {
  const r = role.trim().toLowerCase();
  return [
    {
      key: "first",
      ask: r ? `What's the first thing you'd like me to take on as your ${r}?` : "What would you like help with first?",
      save: "Save it as a plan in their notes (memory_remember, kind plan). It's the first thing you'll do once setup is over.",
    },
    {
      key: "apps",
      ask: "Which apps do you use most, like email, calendar, docs or chat? I can connect to them and keep an eye on things for you.",
      save: "Save the apps as a preference. For ones you aren't connected to yet, tell them they can connect each one in Marketplace → Apps; don't promise to watch an app you can't reach.",
    },
    {
      key: "checkins",
      ask: "How often should I check in with you, and are there hours I should stay quiet?",
      save: "Apply it with settings_read then settings_change (background work on, how often, quiet hours, what to keep an eye on). If they'd rather you only answer when asked, turn background work off. Save it as a preference too.",
    },
    {
      key: "ask",
      ask: "Is there anything I should never do without asking you first?",
      save: "Add each one to the Boundaries in your soul (memory_write on me/SOUL.md, unless it's locked) and save it as a preference. From now on, ask with approval_request before any of them.",
    },
    {
      key: "style",
      ask: "Last one: how do you like me to talk to you? Short and to the point, or more detail?",
      save: "Save it as a preference and follow it from now on, starting with this reply.",
    },
  ];
}

/** Whether the agent's harness is signed in where it runs: false only when Wisp knows it isn't. */
function signedIn(hub: Hub, agent: Agent): boolean | null {
  if (agent.settings.connectionId) return true;
  if (!agent.nodeId || hub.runsInComputer(agent)) return null;
  const here = hub.store.nodeCatalog(agent.nodeId).find((h) => h.harness === agent.harness);
  return here?.accounts?.[here.agentAccounts?.[agent.id] ?? "default"] ?? null;
}

/** The hello, written by Wisp in the agent's name. */
export function greetingText(agent: Pick<Agent, "name" | "harness">, firstQuestion: string, signIn: { device: string } | null): string {
  const hello = `Hey, I'm ${agent.name}! How can I help? What do you need from me?`;
  if (signIn) {
    const label = harnessLabel(agent.harness);
    return `${hello}\n\nBefore I can get started, ${label} needs to be signed in on ${signIn.device}. You can do that in Settings → Harnesses. Once it's done, tell me: ${firstQuestion.charAt(0).toLowerCase()}${firstQuestion.slice(1)}`;
  }
  return `${hello}\n\nI've got a few quick questions so I can be useful from the start. Skip any you like.\n\n${firstQuestion}`;
}

/** Is this agent's setup still going, for this DM? */
export function activeSetup(agent: Pick<Agent, "settings">, channelId?: string): AgentSetup | null {
  const s = agent.settings.setup;
  if (!s || s.done) return null;
  if (channelId && s.channelId !== channelId) return null;
  if (Date.now() - Date.parse(s.startedAt) > SETUP_DAYS * 86_400_000) return null;
  return s;
}

/**
 * Say hello in the DM with the person it works for and start the setup. Only once per agent:
 * an agent that already has a setup (or greeted before a restart) is left alone. Agents another
 * app runs (Grok, ChatGPT through MCP) speak for themselves, so Wisp doesn't put words in their mouth.
 */
export function greetNewAgent(hub: Hub, agent: Agent, userId: string | null | undefined): Message | null {
  const { store } = hub;
  if (!userId || !store.user(userId) || !store.role(agent.workspaceId, userId)) return null;
  const fresh = store.agent(agent.id);
  if (!fresh || fresh.settings.setup) return null;
  if (harnessInfo(fresh.harness)?.protocol === "mcp") return null;
  const dm = store.dmChannel(fresh.workspaceId, userId, fresh.id);
  // someone may already have written there (an agent made from one found on a device)
  if (store.messages(dm.id, { limit: 1 }).length) return null;
  const questions = setupQuestions(roleOf(hub, fresh));
  const notSignedIn = signedIn(hub, fresh) === false;
  const device = fresh.nodeId ? store.node(fresh.nodeId)?.name ?? "its device" : "its device";
  store.updateAgent(fresh.id, { settings: { setup: { userId, channelId: dm.id, startedAt: new Date().toISOString(), answers: [], done: false } } });
  const msg = hub.postMessage({ channelId: dm.id, author: { kind: "agent", id: fresh.id }, body: greetingText(fresh, questions[0].ask, notSignedIn ? { device } : null), route: false });
  store.updateAgent(fresh.id, { settings: { setup: { ...store.agent(fresh.id)!.settings.setup!, greetingId: msg.id } } });
  hub.broadcast(fresh.workspaceId, { type: "channels_changed" });
  return msg;
}

/**
 * The person wrote in the setup DM: keep it as the answer to the question it's for. The last
 * answer ends the setup (its reply still gets the closing section, see setupSection).
 */
export function recordSetupAnswer(hub: Hub, msg: Message): void {
  if (msg.author.kind !== "user" || msg.threadId) return;
  const { store } = hub;
  for (const m of store.channelMembers(msg.channelId)) {
    if (m.kind !== "agent") continue;
    const agent = store.agent(m.id);
    const s = agent && activeSetup(agent, msg.channelId);
    if (!agent || !s || s.userId !== msg.author.id) continue;
    const total = setupQuestions(roleOf(hub, agent)).length;
    const answers = [...s.answers, msg.body.trim().slice(0, ANSWER_CHARS)];
    store.updateAgent(agent.id, { settings: { setup: { ...s, answers, lastAnswerId: msg.id, done: answers.length >= total } } });
    void saveSetupNote(hub, agent, s.userId, answers).catch(() => undefined);
  }
}

/** What the person said at setup, kept in the agent's own notes too, where they can read and fix it. */
export const setupNotePath = (agentId: string) => `agents/${agentId}/First chat.md`;

async function saveSetupNote(hub: Hub, agent: Agent, userId: string, answers: string[]) {
  const person = hub.store.user(userId);
  const name = person?.preferredName || person?.name || "them";
  const questions = setupQuestions(roleOf(hub, agent));
  const lines = answers.map((a, i) => `- **${questions[i]?.ask ?? "More"}** ${skipped(a) ? "_Skipped._" : a.replace(/\s+/g, " ")}`);
  const note = `# Getting to know ${name}\n\nWhat ${name} told @${agent.handle} in their first chat.\n\n${lines.join("\n")}\n`;
  await hub.vault(agent.workspaceId).write(setupNotePath(agent.id), note, { name: "Wisp", email: "wisp@localhost" }, `Setup answers for @${agent.handle}`);
}

/**
 * The setup, as a prompt section: what's been asked and answered, what to do with the answer
 * just given, and the next question (or how to wrap up). After setup, what they said stays in
 * every prompt as a short reminder. Empty when there's nothing to say.
 */
export function setupSection(hub: Hub, agent: Agent, at: { channelId: string; triggerId: string; live: boolean }, personName: string): string {
  const { channelId, triggerId } = at;
  const s = agent.settings.setup;
  if (!s || (!s.answers.length && s.done)) return "";
  const questions = setupQuestions(roleOf(hub, agent));
  const said = s.answers.map((a, i) => `- ${questions[i]?.ask ?? "(another answer)"} → ${skipped(a) ? "(skipped)" : a}`);
  const live = at.live && s.channelId === channelId && (activeSetup(agent, channelId) || (s.done && s.lastAnswerId === triggerId));
  if (!live) {
    const kept = said.filter((l) => !l.endsWith("(skipped)"));
    return kept.length ? `## What ${personName} told you when you met\nFrom your first chat; they may have changed their mind since, and what they say now wins.\n${kept.join("\n")}` : "";
  }
  const n = s.answers.length;
  const justAnswered = n ? questions[n - 1] : undefined;
  const next = questions[n];
  const role = roleOf(hub, agent);
  return [
    `## Getting to know ${personName}`,
    `You're new. Wisp said hello for you and asked the first question; you ask the rest, one per message, in your own voice and personality${role ? `, as their ${role}` : ""}. Keep each message short: a line on their answer, then the next question. Put the questions in your own words, and fit them to your role and instructions; skip one that clearly doesn't apply to your job. If they skip a question or say "skip", move on without fuss. If they'd rather just get going, drop the rest and help them.`,
    said.length ? `So far (Wisp keeps these in me/First chat.md):\n${said.join("\n")}` : "",
    justAnswered && !skipped(s.answers[n - 1]) ? `With the answer they just gave: ${justAnswered.save}` : "",
    next
      ? `Ask next (your words): ${next.ask}${next.key === "apps" ? " Mention they can connect apps in Marketplace → Apps." : ""}`
      : `That was the last question. Thank them in a few words, say in one line what you'll remember, then end with one concrete offer to start on something now, based on what they told you (for example their first task). Don't ask more setup questions.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The model failed mid-setup for a reason other than sign-in: Wisp asks the next question itself, so the chat doesn't stall. */
export function askNextIfStalled(hub: Hub, agentId: string, channelId: string, signInTrouble: boolean): void {
  if (signInTrouble) return;
  const agent = hub.store.agent(agentId);
  const s = agent && activeSetup(agent, channelId);
  if (!agent || !s || !s.answers.length) return;
  const next = setupQuestions(roleOf(hub, agent))[s.answers.length];
  if (next) hub.postMessage({ channelId, author: { kind: "agent", id: agent.id }, body: next.ask, route: false });
}
