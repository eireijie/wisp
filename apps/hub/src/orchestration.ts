import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent, OrchestrationSettings, OrchestrationStatus } from "@warren/core";
import type { Caller } from "./api.ts";
import type { Hub } from "./hub.ts";
import type { Store } from "./store.ts";

/**
 * The Orchestration addon. Off by default: tasks then go straight to whoever they're for. Turned on,
 * one agent (the dispatcher) takes every task nobody assigned, breaks it down and hands the pieces
 * to agents with roles (or team leads) as subtasks. Stored as the workspace setting "orchestration".
 */
const KEY = "orchestration";

export function orchestration(store: Store, workspaceId: string): OrchestrationSettings {
  try {
    const v = JSON.parse(store.setting(workspaceId, KEY) ?? "{}") as Partial<OrchestrationSettings>;
    return { enabled: !!v.enabled, dispatcherId: typeof v.dispatcherId === "string" ? v.dispatcherId : null };
  } catch {
    return { enabled: false, dispatcherId: null };
  }
}

/** The setup checklist: on, a dispatcher picked, and someone with a role to hand work to. */
export function orchestrationStatus(store: Store, workspaceId: string): OrchestrationStatus {
  const s = orchestration(store, workspaceId);
  const agents = store.agents(workspaceId);
  const dispatcher = s.dispatcherId ? agents.find((a) => a.id === s.dispatcherId) : undefined;
  const others = agents.filter((a) => a.id !== dispatcher?.id);
  const roles = others.some((a) => a.settings.role?.trim()) || store.teams(workspaceId).some((t) => t.leadId && t.leadId !== dispatcher?.id);
  const steps: OrchestrationStatus["steps"] = [
    { id: "enabled", label: "Turn on Orchestration", done: s.enabled },
    { id: "dispatcher", label: "Pick the dispatcher: the agent that takes every task and assigns the work", done: !!dispatcher },
    { id: "roles", label: "Give another agent a role (or give a team a lead) so there's someone to hand work to", done: roles },
  ];
  return { ...s, dispatcherId: dispatcher?.id ?? null, steps, ready: steps.every((x) => x.done) };
}

/** The dispatcher, when the addon is on and it still exists. */
export function activeDispatcher(store: Store, workspaceId: string): ReturnType<Store["agent"]> {
  const s = orchestration(store, workspaceId);
  const a = s.enabled && s.dispatcherId ? store.agent(s.dispatcherId) : undefined;
  return a && a.workspaceId === workspaceId ? a : undefined;
}

/** What the dispatcher is told every run: it assigns, and who it can assign to. */
export function dispatcherSection(store: Store, agent: Agent): string {
  if (activeDispatcher(store, agent.workspaceId)?.id !== agent.id) return "";
  const others = store.agents(agent.workspaceId).filter((a) => a.id !== agent.id);
  const people = others.map((a) => `- @${a.handle} (${a.name}): ${a.settings.role?.trim() || "no role yet"}${a.settings.roleNotes?.trim() ? `. ${a.settings.roleNotes.trim()}` : ""}`);
  const leads = store
    .teams(agent.workspaceId)
    .filter((t) => t.leadId && t.leadId !== agent.id)
    .map((t) => `- team ${t.name}: lead @${others.find((a) => a.id === t.leadId)?.handle ?? "?"}${t.description ? ` (${t.description})` : ""}`);
  return [
    "## You're the dispatcher",
    "This workspace uses Orchestration: every task nobody assigned comes to you, and you decide who does what. Don't do the work yourself unless nobody else fits.",
    "For a new task: break it into pieces and hand each one to the agent (or team lead) whose role fits, with task_delegate. Pieces you hand out while working a task become its subtasks automatically (or pass parent_task_id). Say in the thread who got what.",
    "When subtasks come back, check the results, hand out follow-ups if something's missing, and when the whole thing is done mark the parent task done with task_update and a short summary.",
    people.length ? `Agents and their roles:\n${people.join("\n")}` : "There are no other agents yet.",
    leads.length ? `Teams (hand team work to the lead):\n${leads.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const result = `@${agent?.handle ?? "agent"}'s run failed: ${reason}`;
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

interface Helpers {
  need(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean; user?: boolean; member?: boolean }): Caller | null;
  parse<S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null;
}

/** GET/PUT /api/settings/orchestration: the addon's switch, its dispatcher, and the setup checklist. */
export function registerOrchestrationApi(app: FastifyInstance, hub: Hub, h: Helpers) {
  const { store } = hub;

  app.get("/api/settings/orchestration", async (req, reply) => {
    const c = h.need(req, reply);
    if (!c) return;
    return orchestrationStatus(store, c.workspaceId);
  });

  app.put("/api/settings/orchestration", async (req, reply) => {
    const c = h.need(req, reply, { owner: true });
    if (!c) return;
    const body = h.parse(z.object({ enabled: z.boolean(), dispatcherId: z.string().nullable() }).partial().strict(), req.body, reply);
    if (!body) return;
    if (body.dispatcherId) {
      const a = store.agent(body.dispatcherId);
      if (!a || a.workspaceId !== c.workspaceId) return reply.code(404).send({ error: "agent not found" });
    }
    const next = { ...orchestration(store, c.workspaceId), ...body };
    store.setSetting(c.workspaceId, KEY, JSON.stringify(next));
    hub.broadcast(c.workspaceId, { type: "orchestration_changed" });
    return orchestrationStatus(store, c.workspaceId);
  });
}
