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
    .map((t) => `- team ${t.name}: lead @${others.find((a) => a.id === t.leadId)?.handle ?? "?"}${t.description ? ` (${t.description})` : ""}`);
  return [
    "## You're the lead",
    "Every task nobody assigned comes to you, and you decide who does what. Don't do the work yourself unless nobody else fits.",
    "For a new task: break it into pieces and hand each one to the agent (or team lead) whose role fits, with task_delegate. Pieces you hand out while working a task become its subtasks automatically (or pass parent_task_id). Say in the thread who got what.",
    "When subtasks come back, check the results, hand out follow-ups if something's missing, and when the whole thing is done mark the parent task done with task_update and a short summary.",
    "Work that's done gets looked at by a different agent than the one who did it, ideally on another harness. If you'd review your own work, hand the review to someone else.",
    `Agents and their roles:\n${people.join("\n")}`,
    leads.length ? `Teams (hand team work to the lead):\n${leads.join("\n")}` : "",
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
