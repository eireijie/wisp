import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { harnessInfo, harnessLabel, SETUP_STEPS, WATCH_SERVICES, type Agent, type AgentSetup, type Message, type SetupStep, type WatchService } from "@wisp/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";

/**
 * A new agent speaks first. The hub writes its hello in its DM with whoever made it, so the
 * person sees it even when the model is slow, failing or not signed in yet. Then the agent leads
 * a short setup in its own voice: what they want done (narrowed down, with a role it offers),
 * the accounts involved, a look at what's signed in on its computer, check-ins, what to ask
 * about first, and how to talk. It records each step with setup_step; Wisp keeps those (and
 * what the person wrote) on the agent and in every prompt, so the setup changes how it works
 * even if a model never saved a thing.
 */

/** After this long, a setup nobody finished is over, so a person coming back much later isn't quizzed. */
export const SETUP_DAYS = 7;
/** A setup never takes more of the person's messages than this. */
export const SETUP_REPLIES = 15;
const REPLY_CHARS = 600;
const STEP_CHARS = 400;

interface StepGuide {
  /** the question in plain words, as Wisp asks it when the agent can't; null when it's work, not a question */
  ask: string | null;
  /** how the agent runs the step and where what it learns goes */
  how: (ctx: { computer: boolean; logins: boolean }) => string;
}

const GUIDE: Record<SetupStep, StepGuide> = {
  goal: {
    ask: "What would you like me to do?",
    how: () =>
      `Find out what they want done. If it's broad ("ads"), ask one follow-up to narrow it ("Managing ads, social posts, or both?"). Save it as a plan (memory_remember, kind plan).`,
  },
  role: {
    ask: null,
    how: () => `Offer the role that fits, in plain words ("I can be your business manager"). If they agree, record it with setup_step role (a short job title); Wisp makes it your role.`,
  },
  accounts: {
    ask: "Which accounts should I work with? For example Google, Meta or Instagram.",
    how: () =>
      `Ask which accounts or sites the work needs (Google, Meta, Instagram…). Record them with setup_step accounts. Save them as a preference. Where Wisp has an app for one (Marketplace → Apps), say they can connect it there.`,
  },
  signins: {
    ask: null,
    how: ({ computer, logins }) =>
      computer
        ? [
            `Say you'll check the sign-ins ("Let's check what's signed in"), then open each account's site in your computer's browser and look, without changing anything: who's signed in, and how many businesses, pages or profiles you can see. Report it in a few short lines ("Google Ads is signed in with 3 businesses; Instagram has 1 account").`,
            `If something should change (sign out, sign in to the right account), propose it and ask first; change nothing until they say yes. Sign in only with login_fill, which fills from their own password manager and never shows you the password: offer that first ("I'd sign in with your password manager, OK?")${logins ? "" : `. They haven't connected one yet, so say they can in Settings → Logins (1Password works), or sign in themselves when you hand them the screen with computer_ask_human`}. For a code or anything login_fill can't fill, use computer_ask_human. Never ask for a password in chat.`,
            `Record what you found with setup_step signins, and save it as a detail in their notes.`,
          ].join(" ")
        : `You don't have a computer, so you can't open their accounts to see what's signed in. Say so in one line, and that they can give you one from your page (Agents → you → Computer). Record setup_step signins with "no computer yet", then move on.`,
  },
  checkins: {
    ask: "How often should I check in with you, and are there hours I should stay quiet?",
    how: () =>
      `Ask how often to check in and when to stay quiet, and offer to keep an eye on the accounts they named ("Want me to keep an eye on Google Ads and Instagram?"). Apply the check-ins with settings_read then settings_change (background work on, how often, quiet hours). Only after they say yes to watching, in the reply to that yes, list the accounts in setup_step watch: the app's service (${WATCH_SERVICES.filter((s) => s !== "browser").join(", ")}), or "browser" with the site's url and what to look for (Google Ads, Instagram and other sites). Wisp starts the watches and tells you which worked; say so in a line. Don't watch anything they didn't say yes to. If they'd rather you only answer when asked, turn background work off. Save it as a preference.`,
  },
  boundaries: {
    ask: "Is there anything I should never do without asking you first?",
    how: () => `Ask what you should never do without asking. Add each one to the Boundaries in your soul (memory_write on me/SOUL.md, unless it's locked) and save it as a preference; from now on, ask with approval_request before any of them.`,
  },
  style: {
    ask: "How do you like me to talk to you: short and to the point, or more detail?",
    how: () => `Unless it's already clear, ask how they like to be talked to. Save it as a preference and follow it from then on.`,
  },
};

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

/** The hello, written by Wisp in the agent's name. */
export function greetingText(agent: Pick<Agent, "name" | "harness">, signIn: { device: string } | null): string {
  const hello = `Hey, I'm ${agent.name}! What would you like me to do?`;
  if (signIn) {
    return `${hello}\n\nBefore I can get started, ${harnessLabel(agent.harness)} needs to be signed in on ${signIn.device}. Press Sign in in this chat to do that. Tell me what you need in the meantime and I'll pick it up once that's done.`;
  }
  return `${hello}\n\nTell me in a few words. Then I'll ask a couple of quick things so I can get set up; skip any you like.`;
}

/** Is this agent's setup still going, for this DM? */
export function activeSetup(agent: Pick<Agent, "settings">, channelId?: string): AgentSetup | null {
  const s = agent.settings.setup;
  if (!s || s.done) return null;
  if (channelId && s.channelId !== channelId) return null;
  if (Date.now() - Date.parse(s.startedAt) > SETUP_DAYS * 86_400_000) return null;
  return s;
}

/** The steps still to do, in order. */
const remaining = (s: AgentSetup) => SETUP_STEPS.filter((k) => s.steps[k] === undefined);

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
  // where it runs: its device, or its own computer when its harness runs in there
  const signIn = hub.signInNeeded(fresh);
  // an agent made for a job already has its role; it doesn't offer one
  const steps: AgentSetup["steps"] = roleOf(hub, fresh) ? { role: roleOf(hub, fresh) } : {};
  store.updateAgent(fresh.id, { settings: { setup: { userId, channelId: dm.id, startedAt: new Date().toISOString(), replies: [], steps, done: false } } });
  const msg = hub.postMessage({ channelId: dm.id, author: { kind: "agent", id: fresh.id }, body: greetingText(fresh, signIn ? { device: signIn.where } : null), route: false });
  store.updateAgent(fresh.id, { settings: { setup: { ...store.agent(fresh.id)!.settings.setup!, greetingId: msg.id } } });
  hub.broadcast(fresh.workspaceId, { type: "channels_changed" });
  return msg;
}

/**
 * The chat a person's message belongs to while their setup is going: the one the hello started,
 * so a quiet break mid-setup doesn't start a fresh chat (and a fresh harness session) halfway through.
 */
export function setupChat(hub: Hub, m: { channelId: string; threadId?: string | null; author: { kind: string; id: string } }): string | null {
  if (m.threadId || m.author.kind !== "user") return null;
  const { store } = hub;
  for (const member of store.channelMembers(m.channelId)) {
    if (member.kind !== "agent") continue;
    const agent = store.agent(member.id);
    const s = agent && activeSetup(agent, m.channelId);
    if (s?.userId === m.author.id && s.greetingId) return store.message(s.greetingId)?.conversationId ?? null;
  }
  return null;
}

/** The person wrote in the setup DM: keep what they said. A setup takes at most SETUP_REPLIES of their messages. */
export function recordSetupReply(hub: Hub, msg: Message): void {
  if (msg.author.kind !== "user" || msg.threadId) return;
  const { store } = hub;
  for (const m of store.channelMembers(msg.channelId)) {
    if (m.kind !== "agent") continue;
    const agent = store.agent(m.id);
    const s = agent && activeSetup(agent, msg.channelId);
    if (!agent || !s || s.userId !== msg.author.id) continue;
    const replies = [...s.replies, msg.body.trim().slice(0, REPLY_CHARS)];
    store.updateAgent(agent.id, { settings: { setup: { ...s, replies, done: replies.length > SETUP_REPLIES } } });
    void saveSetupNote(hub, agent.id).catch(() => undefined);
  }
}

/**
 * The agent finished a step (setup_step). A role the person agreed to becomes the agent's role;
 * the accounts they named go to watchSetupAccounts.
 */
export async function recordSetupStep(
  hub: Hub,
  agent: Agent,
  step: { step?: SetupStep; summary?: string; role?: string; accounts?: string[]; watch?: SetupWatch[]; done?: boolean },
  /** the message the agent is answering: watches start only in the reply to the person's own yes */
  answering?: Message,
): Promise<{ setup: AgentSetup; watched: WatchResult[] } | { error: string }> {
  const { store } = hub;
  const s = activeSetup(agent);
  if (!s) return { error: "your setup is already over; just carry on" };
  if (step.watch?.length && !(answering && answering.author.kind === "user" && answering.author.id === s.userId && answering.channelId === s.channelId))
    return { error: "watches start only in your reply to their yes in your DM; ask them first" };
  const steps = { ...s.steps };
  const role = step.role?.trim().slice(0, 60);
  if (role) {
    store.updateAgent(agent.id, { settings: { role } });
    hub.broadcast(agent.workspaceId, { type: "agents_changed" });
    steps.role = role;
  }
  const accounts = step.accounts?.map((a) => a.trim().slice(0, 80)).filter(Boolean).slice(0, 30);
  if (accounts?.length) steps.accounts = accounts.join(", ");
  if (step.step) steps[step.step] = (step.summary?.trim() || steps[step.step] || "done").slice(0, STEP_CHARS);
  const watched = step.watch?.length ? await watchSetupAccounts(hub, agent, s.userId, step.watch) : [];
  const ok = watched.filter((w) => w.watching && !steps.checkins?.includes(w.label)).map((w) => w.label);
  if (ok.length) steps.checkins = [steps.checkins, `Watching ${ok.join(", ")}`].filter(Boolean).join("; ").slice(0, STEP_CHARS);
  const next: AgentSetup = { ...s, steps, ...(accounts?.length ? { accounts } : {}), done: !!step.done };
  store.updateAgent(agent.id, { settings: { setup: next } });
  void saveSetupNote(hub, agent.id).catch(() => undefined);
  return { setup: next, watched };
}

/** An account the person said yes to watching, as the agent names it. */
export interface SetupWatch {
  service: WatchService;
  label?: string;
  /** browser watches: the site, and what to look for there */
  url?: string;
  lookFor?: string;
}

export type WatchResult = { label: string; watching: true; watchId: string } | { label: string; watching: false; why: string };

/**
 * Start watching the accounts the person said yes to (recordSetupStep only calls this in the reply
 * to their own message). Each becomes a watch (watches.ts) for this agent and this person; one
 * this agent already has for the same app or site is kept, not doubled.
 */
export async function watchSetupAccounts(hub: Hub, agent: Agent, userId: string, wanted: SetupWatch[]): Promise<WatchResult[]> {
  const have = hub.watches.list(agent.workspaceId, { agentId: agent.id, userId });
  const out: WatchResult[] = [];
  for (const w of wanted.slice(0, 10)) {
    const label = (w.label?.trim() || (w.service === "browser" ? w.url ?? "a site" : w.service)).slice(0, 80);
    const same = have.find((h) => h.service === w.service && (w.service !== "browser" || h.config.url === w.url));
    if (same) {
      out.push({ label, watching: true, watchId: same.id });
      continue;
    }
    const config = w.service === "browser" ? { url: w.url?.trim() ?? "", lookFor: w.lookFor?.trim() ?? "" } : undefined;
    const made = await hub.watches.create({ workspaceId: agent.workspaceId, userId, agentIds: [agent.id], service: w.service, config, label: w.label?.trim() || undefined, createdBy: agent.id });
    out.push("error" in made ? { label, watching: false, why: made.error } : { label: made.label, watching: true, watchId: made.id });
    if (!("error" in made)) have.push(made);
  }
  return out;
}

/** What the person said at setup, kept in the agent's own notes too, where they can read and fix it. */
export const setupNotePath = (agentId: string) => `agents/${agentId}/First chat.md`;

const STEP_TITLE: Record<SetupStep, string> = { goal: "What they want", role: "My role", accounts: "Accounts", signins: "What's signed in", checkins: "Check-ins", boundaries: "Ask first", style: "How to talk to them" };

async function saveSetupNote(hub: Hub, agentId: string) {
  const agent = hub.store.agent(agentId);
  const s = agent?.settings.setup;
  if (!agent || !s) return;
  const person = hub.store.user(s.userId);
  const name = person?.preferredName || person?.name || "them";
  const steps = SETUP_STEPS.filter((k) => s.steps[k]).map((k) => `- **${STEP_TITLE[k]}:** ${s.steps[k]!.replace(/\s+/g, " ")}`);
  const said = s.replies.map((r) => `- ${r.replace(/\s+/g, " ")}`);
  const note = [`# Getting to know ${name}`, "", `What ${name} and @${agent.handle} worked out in their first chat.`, "", ...(steps.length ? [...steps, ""] : []), `## In ${name}'s words`, "", ...said, ""].join("\n");
  await hub.vault(agent.workspaceId).write(setupNotePath(agent.id), note, { name: "Wisp", email: "wisp@localhost" }, `Setup notes for @${agent.handle}`);
}

/**
 * The setup, as a prompt section: the steps done and to do, how to run the next one, and how to
 * finish. After setup, what came out of it stays in every prompt as a short reminder. Empty when
 * there's nothing to say.
 */
export function setupSection(hub: Hub, agent: Agent, at: { channelId: string; live: boolean }, personName: string): string {
  const s = agent.settings.setup;
  if (!s) return "";
  const done = SETUP_STEPS.filter((k) => s.steps[k] !== undefined);
  if (!(at.live && s.channelId === at.channelId && activeSetup(agent, at.channelId))) {
    const kept = done.map((k) => `- ${STEP_TITLE[k]}: ${s.steps[k]}`);
    // a setup cut short still leaves what they said
    const lines = kept.length ? kept : s.replies.map((r) => `- "${r}"`);
    return lines.length ? `## What ${personName} told you when you met\nFrom your first chat; they may have changed their mind since, and what they say now wins.\n${lines.join("\n")}` : "";
  }
  const ctx = { computer: !!hub.computerSection(agent.id), logins: !!hub.logins.status(agent.workspaceId) };
  const left = remaining(s);
  const role = roleOf(hub, agent);
  return [
    `## Getting to know ${personName}`,
    `You're new, and this is your first chat. Wisp said hello for you and asked what they'd like you to do. Lead a short setup, in your own voice and personality${role ? `, as their ${role}` : ""}: one thing per message, a line on what they said and then the next question. Use your own words and fit the steps to your job; skip any that clearly don't apply. If they say "skip", move on without fuss; if they'd rather just get going, finish the setup and help them.`,
    done.length ? `Done so far:\n${done.map((k) => `- ${STEP_TITLE[k]}: ${s.steps[k]}`).join("\n")}` : "",
    s.replies.length ? `What they've written so far:\n${s.replies.map((r) => `- "${r}"`).join("\n")}` : "",
    left.length ? `Still to do, in this order:\n${left.map((k) => `- ${k}: ${GUIDE[k].how(ctx)}`).join("\n")}` : "",
    `After each step, call setup_step with the step and a one-line summary of what you learned or did (skipped ones too). When the steps are done, or they want to get going, call setup_step with done: true, thank them in a few words, say in one line what you'll remember, and end with one concrete offer to start on something now, based on what they told you.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The model failed mid-setup for a reason other than sign-in: Wisp takes what they last wrote as
 * the answer to the step it was on and asks the next question itself, so the chat doesn't stall.
 */
export function askNextIfStalled(hub: Hub, agentId: string, channelId: string, signInTrouble: boolean): void {
  if (signInTrouble) return;
  const agent = hub.store.agent(agentId);
  const s = agent && activeSetup(agent, channelId);
  if (!agent || !s || !s.replies.length) return;
  const asked = remaining(s).find((k) => GUIDE[k].ask);
  if (!asked) return;
  const steps = { ...s.steps, [asked]: `"${s.replies.at(-1)}" (their words)` };
  hub.store.updateAgent(agent.id, { settings: { setup: { ...s, steps } } });
  const next = SETUP_STEPS.filter((k) => steps[k] === undefined).find((k) => GUIDE[k].ask);
  if (next) hub.postMessage({ channelId, author: { kind: "agent", id: agent.id }, body: GUIDE[next].ask!, route: false });
}

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

/** POST /api/setup-step: the agent says how its setup chat is going (MCP setup_step). */
export function registerSetupApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  app.post("/api/setup-step", async (req, reply) => {
    const c = h.need(req, reply);
    if (!c) return;
    if (c.actor.kind !== "agent") return reply.code(403).send({ error: "agents only" });
    const agent = hub.store.agent(c.actor.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const body = h.parse(
      z.object({
        step: z.enum(SETUP_STEPS).optional(),
        summary: z.string().max(2000).optional(),
        role: z.string().max(200).optional(),
        accounts: z.array(z.string().max(200)).max(50).optional(),
        watch: z.array(z.object({ service: z.enum(WATCH_SERVICES), label: z.string().max(80).optional(), url: z.string().max(2000).optional(), lookFor: z.string().max(500).optional() })).max(10).optional(),
        done: z.boolean().optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const run = hub.runFor(agent.id, req.headers["x-wisp-run"]);
    const answering = run?.triggerMessageId ? hub.store.message(run.triggerMessageId) : undefined;
    const r = await recordSetupStep(hub, agent, body, answering);
    if ("error" in r) return reply.code(409).send(r);
    return { done: r.setup.done, left: remaining(r.setup), watched: r.watched };
  });
}
