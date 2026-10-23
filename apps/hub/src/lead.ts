import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent, LeadStatus } from "@warren/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import type { Store } from "./store.ts";

/**
 * The workspace's lead takes every task nobody assigned, splits it up and hands the pieces to
 * agents by role (or to a team's lead) as subtasks. An owner can pick it; otherwise it's the agent
 * teams report to, a team lead, or whoever sounds like the chief. Stored as the workspace setting
 * "lead". Workspaces from when this was the Orchestration addon keep their dispatcher as the lead.
 */
const KEY = "lead";
const LEGACY_KEY = "orchestration";


const isRemote = (repo: string) => /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(repo);

/**
 * What only the assignee needs to know about a task message: the task id, where to code, and how to
 * report back. People never see this, so it isn't in the message body. Starts with a blank line, or
 * is empty when the message isn't a task for this agent.
 */
export function taskInstructions(store: Store, agentId: string, trigger: { parts: { type: string; taskId?: string }[] }): string {
  const taskId = trigger.parts.find((p) => p.type === "task")?.taskId;
  const task = taskId ? store.task(taskId) : undefined;
  if (!task || task.toAgentId !== agentId) return "";
  const team = task.teamId ? store.team(task.teamId) : undefined;
  const code =
    task.branch && team?.repo && !task.reviewOf
      ? `\n\nCode: you'll work in your own checkout of \`${team.repo}\` on branch \`${task.branch}\` (from \`${team.baseBranch}\`). Commit your work on that branch${isRemote(team.repo) ? " and push it" : ""}.`
      : "";
  return `\n\nThis is task \`${task.id}\`.${code}\n\nWhen finished, report back with the task result (warren tool \`task_update\`, status done).`;
}

/**
 * The run that was working a task failed: the task fails with the reason, and whoever handed it
 * out hears about it in the task's thread. An agent that handed it out (the dispatcher, a lead) is
 * @mentioned, so it wakes up and can hand the work out again or report back.
 */
export function failTaskOfRun(hub: Hub, run: { agentId: string; channelId: string; threadId: string | null; requestedBy: string | null }, reason: string) {
  const { store } = hub;
  const task = run.threadId ? store.taskByThread(run.threadId) : undefined;
  if (!task || task.toAgentId !== run.agentId || (task.status !== "open" && task.status !== "in_progress")) return;
  const agent = store.agent(run.agentId);
  // the agent by name, not @handle: the note is routed, and an @mention would wake the agent that just failed
  const result = `${agent?.name ?? "The agent"}'s run failed: ${reason.trim().replace(/\.+$/, "")}`;
  store.updateTask(task.id, "failed", result);
  hub.broadcast(task.workspaceId, { type: "tasks_changed" });
  const from = task.from.kind === "agent" ? store.agent(task.from.id) : undefined;
  const parent = task.parentId ? store.task(task.parentId) : undefined;
  hub.postMessage({
    channelId: run.channelId,
    threadId: run.threadId,
    author: { kind: "user", id: "system" },
    body: `${from ? `@${from.handle} ` : ""}Task **${task.title}** failed: ${result}.${parent ? ` It's part of **${parent.title}** (\`${parent.id}\`); hand it out again or report back.` : " Fix the cause and hand it out again, or reopen it on the Tasks page."}`,
    hop: 1,
    // only an agent that handed the work out gets woken; a person sees it on the Tasks page
    route: !!from,
    // still for whoever the failed run was for, so an agent on their device can be woken
    onBehalfOf: run.requestedBy,
  });
}

/** The lead an owner picked, or null. */
export function pickedLead(store: Store, workspaceId: string): string | null {
  try {
    const own = store.setting(workspaceId, KEY);
    if (own !== null) return (JSON.parse(own) as { leadId?: string | null }).leadId ?? null;
    const old = JSON.parse(store.setting(workspaceId, LEGACY_KEY) ?? "{}") as { dispatcherId?: unknown };
    return typeof old.dispatcherId === "string" ? old.dispatcherId : null;
  } catch {
    return null;
  }
}

/**
 * Who gets a task nobody assigned: the lead an owner picked, else the agent teams report to, else
 * a team lead, else an agent that sounds like a chief, else the first agent.
 */
export function workspaceLead(store: Store, workspaceId: string): ReturnType<Store["agent"]> {
  const picked = pickedLead(store, workspaceId);
  const chosen = picked ? store.agent(picked) : undefined;
  if (chosen && chosen.workspaceId === workspaceId) return chosen;
  const teams = store.teams(workspaceId);
  const agents = store.agents(workspaceId);
  const boss = teams.map((t) => t.reportsTo).find((id) => id && !teams.some((x) => x.members.some((m) => m.agentId === id) && x.reportsTo));
  const lead = teams.find((t) => t.leadId)?.leadId;
  const chief = agents.find((a) => /chief|boss|lead|manager/i.test(`${a.handle} ${a.name}`));
  const found = store.agent(boss ?? lead ?? chief?.id ?? agents[0]?.id ?? "");
  return found && found.workspaceId === workspaceId ? found : undefined;
}

export function leadStatus(store: Store, workspaceId: string): LeadStatus {
  const picked = pickedLead(store, workspaceId);
  return { leadId: picked && store.agent(picked)?.workspaceId === workspaceId ? picked : null, lead: workspaceLead(store, workspaceId)?.id ?? null };
}

/** What an agent does, for the lead to hand work out by: its own role, else its role on a team. */
function roleOf(store: Store, agent: Agent): { role: string; notes: string } {
  if (agent.settings.role?.trim()) return { role: agent.settings.role.trim(), notes: agent.settings.roleNotes?.trim() ?? "" };
  const onTeam = store
    .teams(agent.workspaceId)
    .flatMap((t) => t.members.filter((m) => m.agentId === agent.id && m.role.trim()))
    .at(0);
  return { role: onTeam?.role.trim() ?? "", notes: onTeam?.roleNotes.trim() ?? "" };
}

/** What the lead is told every run: it assigns, and who it can assign to. Empty for everyone else. */
export function leadSection(store: Store, agent: Agent): string {
  if (workspaceLead(store, agent.workspaceId)?.id !== agent.id) return "";
  const others = store.agents(agent.workspaceId).filter((a) => a.id !== agent.id);
  if (!others.length) return "";
  const people = others.map((a) => {
    const { role, notes } = roleOf(store, a);
    return `- @${a.handle} (${a.name}, ${a.harness}): ${role || "no role yet"}${notes ? `. ${notes}` : ""}`;
  });
  const leads = store
    .teams(agent.workspaceId)
    .filter((t) => t.leadId && t.leadId !== agent.id)
    .map((t) => `- #${t.name}: lead @${others.find((a) => a.id === t.leadId)?.handle ?? "?"}`);
  return [
    "## You're the lead",
    "Every task nobody assigned comes to you, and you decide who does what. Don't do the work yourself unless nobody else fits.",
    "For a new task: break it into pieces and hand each one to the agent (or team lead) whose role fits, with task_delegate. Pieces you hand out while working a task become its subtasks automatically (or pass parent_task_id). Say in the thread who got what.",
    "When subtasks come back, check the results, hand out follow-ups if something's missing, and when the whole thing is done mark the parent task done with task_update and a short summary.",
    "Work that's done gets looked at by a different agent than the one who did it, ideally on another harness. If you'd review your own work, hand the review to someone else.",
    `Agents and their roles:\n${people.join("\n")}`,
    leads.length ? `Channel teams (hand a team's work to its lead, or to "team:<channel>"):\n${leads.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

/** GET/PUT /api/settings/lead: who the workspace's lead is, and (for owners) a way to pick one. */
export function registerLeadApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;

  app.get("/api/settings/lead", async (req, reply) => {
    const c = h.need(req, reply);
    if (!c) return;
    return leadStatus(store, c.workspaceId);
  });

  app.put("/api/settings/lead", async (req, reply) => {
    const c = h.need(req, reply, { owner: true });
    if (!c) return;
    const body = h.parse(z.object({ leadId: z.string().nullable() }).strict(), req.body, reply);
    if (!body) return;
    if (body.leadId) {
      const a = store.agent(body.leadId);
      if (!a || a.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    }
    store.setSetting(c.workspaceId, KEY, JSON.stringify({ leadId: body.leadId }));
    hub.broadcast(c.workspaceId, { type: "lead_changed" });
    return leadStatus(store, c.workspaceId);
  });
}
