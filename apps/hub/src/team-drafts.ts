import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { describeFlow, layoutSteps, normalizeSteps, stepsProblem, type Actor, type TeamDraft, type TeamStep, type TeamStepKind } from "@wisp/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import { workspaceLead } from "./lead.ts";

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { user?: boolean; owner?: boolean; member?: boolean; notGuest?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

const SYSTEM: Actor = { kind: "user", id: "system" };

/** The JSON an agent answers with. Ids are the agent's own; agents and teams are named. */
interface DraftJson {
  name?: string;
  steps?: {
    id?: string;
    title?: string;
    agent?: string;
    prompt?: string;
    kind?: string;
    inputs?: string[];
    sendBackTo?: string;
    maxRounds?: number;
    team?: string;
    waitForReply?: boolean;
    condition?: string;
    yes?: string;
    no?: string;
    show?: string;
  }[];
}

const KINDS: Record<string, TeamStepKind> = { do: "do", agent: "do", repeat: "review", review: "review", ask: "ask", askme: "ask", handoff: "handoff", hand_off: "handoff", if: "branch", branch: "branch", ifelse: "branch", custom: "custom" };

/** What an agent is asked to do to draw a team. */
export function draftBrief(description: string, agents: { handle: string; name: string; harness: string }[], teams: string[]): string {
  return [
    `A person wants a team of agents that works like this:\n> ${description.trim().replace(/\n/g, "\n> ")}`,
    "Draw it as a flowchart of steps. Reply with ONLY a JSON object (no code fence, no other text) and finish this task with task_update (status done) with that JSON as the result:",
    `{"name": "short team name", "steps": [{"id": "s1", "title": "Plan the work", "agent": "@handle", "prompt": "what this agent does here, in 1-3 sentences", "kind": "do", "inputs": []}]}`,
    [
      "Rules:",
      "- Each step has an id, a short imperative title, an agent (a handle from the list below), and its own prompt.",
      '- "inputs" lists the ids of steps whose results this one uses; it waits for all of them. Steps with no inputs start together, at the same time. Steps that don\'t need each other should be side by side, not in a line.',
      '- kind is "do" (an agent does it), "repeat" (an agent checks and sends it back to the step in "sendBackTo" until approved; add "maxRounds", 1 to 10), "ask" (a person approves; add "show" for what they see and optionally "sendBackTo"), "handoff" (gives the work to another team named in "team"; add "waitForReply": true to wait for its answer) or "if" (an agent answers a yes/no "condition"; "yes" and "no" are step ids, or null to end; no/yes may point back to an earlier step to loop).',
      "- Every loop must go through a repeat, ask or if step. Keep it to the fewest steps that do the job (at most 12).",
    ].join("\n"),
    `Agents you can use:\n${agents.map((a) => `- @${a.handle} (${a.name}, ${a.harness})`).join("\n")}`,
    teams.length ? `Other teams you can hand work to: ${teams.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** An agent's JSON as steps; null when it isn't JSON with steps. Unknown agents become the drafting agent; unknown teams are left empty (the draft's problem says so). */
export function stepsFromDraftJson(hub: Hub, workspaceId: string, drafter: string, text: string, canSee: (channelId: string) => boolean = () => true): { name?: string; steps: TeamStep[] } | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let json: DraftJson;
  try {
    json = JSON.parse(text.slice(a, b + 1)) as DraftJson;
  } catch {
    return null;
  }
  // an agent's answer can be any shape: anything that isn't a list of steps with their own ids is not a flowchart
  if (!json || !Array.isArray(json.steps)) return null;
  const raw = json.steps.filter((s) => s && typeof s === "object" && !Array.isArray(s)).slice(0, 40);
  if (!raw.length) return null;
  const ids = raw.map((s, i) => (typeof s.id === "string" && s.id.trim() ? s.id.trim() : `s${i + 1}`));
  if (new Set(ids).size !== ids.length) return null;
  const known = new Set(ids);
  const ref = (x: unknown) => (typeof x === "string" && known.has(x) ? x : null);
  const agents = hub.store.agents(workspaceId);
  const agentByName = (n: string | undefined) => {
    const k = (n ?? "").replace(/^@/, "").trim().toLowerCase();
    return k ? (agents.find((x) => x.handle.toLowerCase() === k) ?? agents.find((x) => x.name.toLowerCase() === k)) : undefined;
  };
  const channels = hub.store.channels(workspaceId).filter((c) => c.kind === "channel" && !c.archivedAt && canSee(c.id));
  const steps: TeamStep[] = raw.map((s, i) => {
    const kind = KINDS[(s.kind ?? "do").toLowerCase().replace(/[^a-z_]/g, "")] ?? "do";
    const needsAgent = kind !== "ask" && kind !== "handoff";
    const step: TeamStep = {
      id: ids[i],
      roleId: "",
      kind,
      action: String(s.title ?? "").trim().slice(0, 200) || `Step ${i + 1}`,
      next: null,
      inputs: [...new Set((Array.isArray(s.inputs) ? s.inputs : []).map(ref).filter((x): x is string => !!x && x !== ids[i]))],
      agentId: needsAgent ? (agentByName(s.agent)?.id ?? drafter) : null,
      prompt: typeof s.prompt === "string" ? s.prompt.slice(0, 8000) : "",
      x: 0,
      y: 0,
    };
    if (kind === "review") {
      step.sendBackTo = ref(s.sendBackTo) ?? step.inputs?.[0] ?? null;
      step.maxRounds = Math.min(10, Math.max(1, Math.round(Number(s.maxRounds) || 3)));
    }
    if (kind === "ask") {
      step.show = typeof s.show === "string" ? s.show.slice(0, 2000) : "";
      step.sendBackTo = ref(s.sendBackTo);
    }
    if (kind === "handoff") {
      const t = typeof s.team === "string" ? s.team.replace(/^#/, "").trim().toLowerCase() : "";
      step.handoffTo = channels.find((c) => c.name.toLowerCase() === t)?.id ?? null;
      step.waitForReply = !!s.waitForReply;
    }
    if (kind === "branch") {
      step.condition = typeof s.condition === "string" ? s.condition.slice(0, 500) : "";
      step.ifTrue = ref(s.yes);
      step.ifFalse = ref(s.no);
      step.maxRounds = 3;
    }
    return step;
  });
  try {
    return { name: typeof json.name === "string" ? json.name.trim().slice(0, 60) : undefined, steps: layoutSteps(normalizeSteps(steps)) };
  } catch {
    return null;
  }
}

/**
 * "Agent builds it": a person describes a team in a sentence and an agent draws the flowchart.
 * It happens as a task for that agent (so it shows up like any work), and the draft is read from
 * the task's result, so nothing is created until the person says so.
 */
export function registerTeamDraftApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;

  /** A private team or a DM is for its members and the organization's owners, as everywhere else. */
  const sees = (c: Caller, channelId: string) => {
    const ch = store.channel(channelId);
    if (!ch || ch.workspaceId !== c.workspaceId) return false;
    return (ch.kind !== "dm" && !ch.private) || c.viewer.role === "owner" || store.isMember(ch.id, c.actor);
  };

  const view = (c: Caller, taskId: string): TeamDraft | null => {
    const workspaceId = c.workspaceId;
    const task = store.task(taskId);
    if (!task || task.workspaceId !== workspaceId || task.title !== DRAFT_TITLE || !task.toAgentId) return null;
    // the draft lives in its asker's chat with the agent: only people who can see that chat can see the draft
    if (task.channelId && !sees(c, task.channelId)) return null;
    const description = (/(?:^> .*\n?)+/m.exec(task.brief)?.[0] ?? "").replace(/^> /gm, "").trim();
    const base = { id: task.id, description, agentId: task.toAgentId };
    if (task.status === "open" || task.status === "in_progress") return { ...base, status: "working" };
    if (task.status !== "done") return { ...base, status: "failed", problem: (task.result ?? "The agent could not finish.").slice(0, 300) };
    const drawn = stepsFromDraftJson(hub, workspaceId, task.toAgentId, task.result ?? "", (cid) => sees(c, cid));
    if (!drawn) return { ...base, status: "failed", problem: "The agent's answer wasn't a flowchart I could read. Try again, or build it yourself." };
    const team = { roles: [], steps: drawn.steps };
    const names = (id: string | null) => (id ? (store.agent(id)?.name ?? "Someone") : "Someone");
    return { ...base, status: "ready", name: drawn.name, steps: drawn.steps, lines: describeFlow(team, names, (cid) => store.channel(cid)?.name ?? "another"), ...(stepsProblem(team) ? { problem: stepsProblem(team)! } : {}) };
  };

  app.post("/api/team-drafts", async (req, reply) => {
    const c = h.need(req, reply, { notGuest: true });
    if (!c) return;
    if (c.actor.kind !== "user") return reply.code(403).send({ error: "a person asks for this" });
    const body = h.parse(z.object({ description: z.string().trim().min(3).max(2000), agentId: z.string().optional() }), req.body, reply);
    if (!body) return;
    const all = store.agents(c.workspaceId);
    const agent = body.agentId ? store.agent(body.agentId) : (workspaceLead(store, c.workspaceId) ?? all[0]);
    if (!agent || agent.workspaceId !== c.workspaceId) return reply.code(404).send({ error: all.length ? "agent not found" : "Add an agent first: an agent draws the flowchart." });
    // an agent that won't wake for this person would leave the draft "working" for good
    const why = hub.whyNotAllowed(agent, c.actor.id) ?? (hub.answers(agent, c.actor.id) ? null : `@${agent.handle} only answers some people, so it can't draw this for you. Pick another agent`);
    if (why) return reply.code(409).send({ error: why });
    if (!hub.flows.delegate) return reply.code(503).send({ error: "not ready yet" });
    const teams = store.channels(c.workspaceId).filter((x) => x.kind === "channel" && !x.archivedAt && sees(c, x.id)).map((x) => x.name);
    const dm = store.dmChannel(c.workspaceId, c.actor.id, agent.id);
    const task = hub.flows.delegate({
      workspaceId: c.workspaceId,
      author: SYSTEM,
      from: SYSTEM,
      target: agent,
      title: DRAFT_TITLE,
      brief: draftBrief(body.description, all.map((a) => ({ handle: a.handle, name: a.name, harness: a.harness })), teams),
      channelId: dm.id,
      hop: 1,
      onBehalfOf: c.actor.id,
    });
    return view(c, task.id);
  });

  app.get("/api/team-drafts/:id", async (req, reply) => {
    const c = h.need(req, reply, { notGuest: true });
    if (!c) return;
    const d = view(c, (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "draft not found" });
    return d;
  });
}

const DRAFT_TITLE = "Draw a team flowchart";
