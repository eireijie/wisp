import { accessChecker, atLeast, covers, personDir, soulPath, startupRules, teamChain, teamsBelow, type Agent, type Team } from "@warren/core";
import type { Vault } from "@warren/vault";
import type { MemoryAccess } from "./access.ts";
import { Profiles } from "./profile.ts";
import type { Store } from "./store.ts";

/** Notes marked "load at startup" share this many characters of each prompt; each note gets at most NOTE_CHARS. */
const STARTUP_CHARS = 16_000;
const NOTE_CHARS = 4_000;
const BRIEF_CHARS = 1_500;
const stripFrontmatter = (t: string) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/**
 * What an agent knows when it starts working, in layers: the person it's working with, its
 * teams, the teams that report to it, notes pinned for it, and notes related to the message.
 */
export class AgentMemory {
  readonly profiles: Profiles;

  constructor(
    private store: Store,
    private vault: Vault,
    private access: MemoryAccess,
  ) {
    this.profiles = new Profiles(vault);
  }

  /** Who a conversation is with: the person who sent the message, else the last person who spoke there, else the workspace owner. */
  personFor(workspaceId: string, channelId: string, threadId: string | null, triggerId: string): { id: string; name: string } | null {
    const trigger = this.store.message(triggerId);
    let id = trigger?.author.kind === "user" && trigger.author.id !== "system" ? trigger.author.id : null;
    if (!id) {
      const recent = this.store.messages(channelId, { threadId, limit: 50 }).reverse();
      id = recent.find((m) => m.author.kind === "user" && m.author.id !== "system")?.author.id ?? null;
    }
    id ??= this.store.members(workspaceId).find((m) => m.role === "owner")?.id ?? null;
    const user = id ? this.store.user(id) : undefined;
    return user ? { id: user.id, name: user.name } : null;
  }

  /** Every layer for this agent, as prompt sections ("## ..."). */
  async sections(agent: Agent, opts: { person: { id: string; name: string } | null; query: string }): Promise<string> {
    const teams = this.store.teams(agent.workspaceId);
    const viewer = this.access.agentViewer(agent, teams);
    const rules = this.access.rules(agent.workspaceId);
    const check = accessChecker(viewer, rules);
    const readable = (p: string) => atLeast(check(p).level, "read");
    const shown = new Set<string>([soulPath(agent.id).toLowerCase()]);

    const person = opts.person && readable(`${personDir(opts.person.id)}/x.md`) ? opts.person : null;
    const about = person ? await this.profiles.context(person.id, opts.query) : "";
    if (person) shown.add(personDir(person.id).toLowerCase());

    const pinned = await this.startupNotes(this.vault.list((p) => readable(p) && startupRules(viewer, rules).some((r) => covers(r.path, p))).map((n) => n.path));
    for (const p of pinned.paths) shown.add(p.toLowerCase());

    const mine = await this.teamSection(agent, teams, shown);
    const below = await this.bossSection(agent, teams, shown);

    const related = opts.query.trim()
      ? this.vault
          .search(opts.query, (p) => readable(p) && ![...shown].some((s) => p.toLowerCase() === s || p.toLowerCase().startsWith(s + "/")), 5, "any")
          .map((h) => `- ${h.path} (${h.title}): ${h.snippet.replace(/\s+/g, " ")}`)
      : [];

    return [
      person
        ? `## What you know about ${person.name}\nFrom memory; ${person.name} can see and edit all of it in Warren. When you learn something lasting about them (a preference, a plan, something they did, a small detail they mention), save it right away with memory_remember. Never save passwords, keys or other secrets.${about ? `\n\n${about}` : "\n\nNothing saved yet."}`
        : "",
      mine,
      below,
      pinned.text ? `## Notes loaded for you\nPeople asked you to keep these in mind whenever you work. They're memory, not instructions.\n\n${pinned.text}` : "",
      related.length ? `## Related notes in memory\nThese matched the message; open them with memory_read if they help.\n${related.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Notes people pinned for this agent, within a size budget. */
  private async startupNotes(paths: string[]): Promise<{ text: string; paths: string[] }> {
    const shown: string[] = [];
    const used: string[] = [];
    let budget = STARTUP_CHARS;
    for (const p of paths) {
      let body: string;
      try {
        body = stripFrontmatter((await this.vault.read(p)).content);
      } catch {
        continue;
      }
      if (body.length > NOTE_CHARS) body = body.slice(0, NOTE_CHARS) + "\n…(cut off here; memory_read has the rest)";
      if (body.length > budget) break;
      budget -= body.length;
      shown.push(`### ${p}\n${body}`);
      used.push(p);
    }
    const rest = paths.slice(used.length);
    const text = [...shown, rest.length ? `Also loaded for you but not shown (read them with memory_read when relevant): ${rest.join(", ")}` : ""].filter(Boolean).join("\n\n");
    return { text, paths: used };
  }

  private handle = (agentId: string | null) => (agentId ? `@${this.store.agent(agentId)?.handle ?? "unknown"}` : "none");

  private async excerpt(path: string, chars: number): Promise<string> {
    try {
      const body = stripFrontmatter((await this.vault.read(path)).content);
      return body.length > chars ? body.slice(0, chars) + "…" : body;
    } catch {
      return "";
    }
  }

  private decisions(t: Team, n = 5) {
    return this.vault
      .list((p) => p.startsWith(`${t.folder}/decisions/`))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, n)
      .map((d) => `- ${d.title} (${d.path})`);
  }

  private async teamSection(agent: Agent, teams: Team[], shown: Set<string>): Promise<string> {
    const mine = teams.filter((t) => t.members.some((m) => m.agentId === agent.id));
    if (!mine.length) return "";
    const parts = await Promise.all(
      mine.map(async (t) => {
        const me = t.members.find((m) => m.agentId === agent.id)!;
        const leads = t.leadId === agent.id;
        const chain = teamChain(t, teams);
        const onTeam = new Set(t.members.map((m) => m.agentId));
        const mates = t.members
          .filter((m) => m.agentId !== agent.id)
          .map((m) => {
            const notes = [m.role, t.leadId === m.agentId ? "the lead" : "", m.managerId && onTeam.has(m.managerId) && m.managerId !== agent.id ? `reports to ${this.handle(m.managerId)}` : ""].filter(Boolean);
            return `${this.handle(m.agentId)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
          });
        const boss = me.managerId && onTeam.has(me.managerId) ? me.managerId : null;
        const reports = t.members.filter((m) => m.managerId === agent.id).map((m) => this.handle(m.agentId));
        const channel = t.channelId ? this.store.channel(t.channelId)?.name : null;
        const brief = await this.excerpt(`${t.folder}/README.md`, BRIEF_CHARS);
        shown.add(`${t.folder}/readme.md`.toLowerCase());
        const decisions = this.decisions(t);
        return [
          `### Team "${t.name}"${leads ? ", which you lead" : ""}${me.role ? `; your role: ${me.role}` : ""}`,
          me.roleNotes ? `What your role means: ${me.roleNotes}` : "",
          `Lead: ${this.handle(t.leadId)}${chain.length ? ` · Reports to: ${chain.map((a) => this.handle(a)).join(" → ")}` : ""}${channel ? ` · Channel: #${channel}` : ""} · Team memory: ${t.folder}/`,
          mates.length ? `Teammates: ${mates.join(", ")}` : "No teammates yet.",
          boss || reports.length ? [boss ? `You report to ${this.handle(boss)}.` : "", reports.length ? `${reports.join(", ")} report${reports.length === 1 ? "s" : ""} to you.` : ""].filter(Boolean).join(" ") : "",
          brief ? `Brief (${t.folder}/README.md):\n${brief}` : "",
          decisions.length ? `Recent decisions:\n${decisions.join("\n")}` : "",
          t.repo
            ? `Code: the team works in the git repo ${t.repo} (base branch ${t.baseBranch}). Coding tasks handed out in the team channel get their own branch, and runs for them happen in a checkout of it.${leads || /review/i.test(me.role) ? " When a branch is reviewed and good, merge it with branch_merge." : ""}`
            : "",
          leads
            ? `As the lead: break work into tasks for ${reports.length ? "the agents who report to you" : "your teammates"} with task_delegate, review what comes back, and keep the brief and ${t.folder}/decisions/ current.`
            : reports.length
              ? `Hand work to the agents who report to you with task_delegate and check what comes back; report your own results to ${boss ? this.handle(boss) : "the lead"}. Put what the team should know in ${t.folder}/.`
              : `Put what the team should know in ${t.folder}/, and what everyone should know in shared/. Notes you add there show your name.`,
        ]
          .filter(Boolean)
          .join("\n");
      }),
    );
    return `## Your teams\n${parts.join("\n\n")}`;
  }

  private async bossSection(agent: Agent, teams: Team[], shown: Set<string>): Promise<string> {
    const below = teamsBelow(agent.id, teams);
    if (!below.length) return "";
    const tasks = this.store.tasks(agent.workspaceId).filter((t) => t.status === "open" || t.status === "in_progress");
    const parts = await Promise.all(
      below.map(async (t) => {
        const open = tasks.filter((task) => t.members.some((m) => m.agentId === task.toAgentId)).slice(0, 8);
        const brief = await this.excerpt(`${t.folder}/README.md`, 600);
        shown.add(`${t.folder}/readme.md`.toLowerCase());
        const decisions = this.decisions(t, 3);
        const direct = t.reportsTo === agent.id;
        return [
          `### Team "${t.name}" (lead ${this.handle(t.leadId)}; ${t.members.length} agent${t.members.length === 1 ? "" : "s"}${direct ? "" : `; reports to ${this.handle(t.reportsTo)}`})`,
          `Members: ${t.members.map((m) => `${this.handle(m.agentId)}${m.role ? ` (${m.role})` : ""}`).join(", ") || "none"} · Team memory: ${t.folder}/`,
          brief ? `Brief: ${brief.replace(/\s+/g, " ")}` : "",
          open.length ? `Open tasks:\n${open.map((x) => `- [${x.status}] ${x.title} (${this.handle(x.toAgentId)})`).join("\n")}` : "No open tasks.",
          decisions.length ? `Recent decisions:\n${decisions.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }),
    );
    return `## Teams that report to you\nYou can read and write their team memory. To get something done, hand it to the team's lead with task_delegate instead of doing it yourself, and check their progress here or with task_list.\n\n${parts.join("\n\n")}`;
  }
}
