import { noteWords, overlap } from "@wisp/vault";
import { SLOW_DOWN_AT } from "./background.ts";
import { agentPolicy } from "./policy.ts";
import type { Hub } from "./hub.ts";

/**
 * Agents keep memory without being asked. Models skip "save what you learned" in a prompt, so the
 * hub watches how each chat run ended instead: when it did real work, finished a task, or the
 * person said something lasting (a preference, a decision, how to do something), and the agent
 * saved nothing, the hub queues a short memory pass. Once the chat has gone quiet, the agent gets
 * one fresh run (in its own conversation, nothing posted) with what happened, and saves or updates
 * linked notes. Doing the same kind of task again, or being shown how, asks it for a skill too.
 *
 * Passes count against the person's daily background allowance and use the model they picked for
 * background checks; past SLOW_DOWN_AT of the allowance they stop until tomorrow. Once a day the
 * hub also tidies the graph on its own (no model): notes that link nothing get linked to their
 * closest notes, and notes that look like duplicates are handed to the agent's next pass to merge.
 */

/** The device sees memory passes as their own conversation, apart from the chat they came from. */
export const MEMORY_THREAD = "memory";
/** How long a chat stays quiet before its pass runs (more work in that time joins the same pass). */
const SETTLE_MS = 3 * 60_000;
/** A busy chat that never goes quiet still gets its pass this long after the first item. */
const MAX_WAIT_MS = 20 * 60_000;
/** Runs one pass looks back at; older ones drop off. */
const MAX_ITEMS = 6;
/** Passes a day, per agent and person. */
export const PASSES_PER_DAY = 8;
/** Tool calls that make a run real work rather than a quick answer. */
const WORK_CALLS = 3;
/** How far back doing "the same kind of task" counts. */
const REPEAT_DAYS = 30;
/** How often the hub tidies each vault. */
const TIDY_EVERY_MS = 24 * 60 * 60_000;
/** Notes one tidy looks at, at most. */
const TIDY_NOTES = 25;
/** Notes this close (shared words over all words) are flagged for the agent to merge. */
const MERGE_SCORE = 0.6;
const EXCERPT = 600;

/** Tools that save to memory or skills: a run that used one saved on its own. */
const SAVING = /^(memory_(write|append|remember|forget)|skill_save|routine_save)$/;
/** Tools that don't count as doing work (Wisp's own bookkeeping). */
const BOOKKEEPING = /^(memory_|skill_|settings_|followup_|chat_|approval_request|next_check|task_update|TodoWrite)/;

/** The person said something lasting about themselves or a decision. */
const SAID =
  /\b(i (?:prefer|like|love|hate|don'?t (?:like|want|use)|want you|always|never|usually|use|work)|i'?m (?:a|an|the|working|based|in|on)|my (?:\w+ ){0,2}(?:is|are|was)|call me|we (?:decided|agreed|chose|picked|went with)|we'?re (?:going|switching|moving)|let'?s (?:go with|use|stick with|switch)|remember (?:that|this|to)|keep in mind|for future reference|don'?t ever|please always|please never)\b/i;
/** The person is showing the agent how to do something. */
const TAUGHT = /\b(next time|from now on|going forward|here'?s how|this is how|the way to|the steps (?:are|to)|step 1|always (?:do|use|start|check|ask)|whenever you)\b/i;

export type Reason = "work" | "task" | "said" | "taught" | "repeat" | "decision";

const WHY: Record<Reason, string> = {
  work: "you did several steps of work",
  task: "you finished a task",
  said: "they said something that may be lasting",
  taught: "they showed you how they want it done",
  repeat: "you've done this kind of task before",
  decision: "a discussion reached a decision",
};

interface Item {
  runId: string;
  at: string;
  where: string;
  who: string;
  asked: string;
  replied: string;
  tools: string[];
  reasons: Reason[];
  /** a skill would help: it's a repeat, or they taught it */
  skill: boolean;
}

interface Pending {
  agentId: string;
  userId: string;
  channelId: string;
  items: Item[];
  first: number;
  due: number;
}

const short = (t: string, n = EXCERPT) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
/** A tool's own name, without the MCP server prefix (`mcp__wisp__memory_write` in Claude Code, `wisp.memory_write` in Codex → `memory_write`). */
const toolName = (n: string) => n.split(/__|\./).pop() ?? n;

export class AutoMemory {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** passes waiting for the chat to go quiet, by agent and person */
  private pending = new Map<string, Pending>();
  /** notes a run saved, from the memory API (any harness, whatever it calls its tools) */
  private savedIn = new Map<string, Set<string>>();
  /** duplicate notes the tidy-up found, for the agent's next pass */
  private merges = new Map<string, [string, string][]>();
  /** what each pass was about, until it ends */
  private passes = new Map<string, Pending>();
  private tidiedAt = new Map<string, number>();

  constructor(private hub: Hub) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** An agent saved a note (or skill) during a run. */
  saved(runId: string | undefined, path: string) {
    if (!runId) return;
    this.savedIn.set(runId, (this.savedIn.get(runId) ?? new Set()).add(path));
  }

  /** The commit message for a save: in a memory pass it says so, so History shows where a save came from. */
  commitMessage(run: { id: string; kind: string | null } | undefined, path: string, message?: string): string | undefined {
    if (run?.kind !== "memory") return message;
    const where = [...new Set(this.passes.get(run.id)?.items.map((i) => i.where) ?? [])];
    return `${message?.trim() || `Save ${path}`} (memory pass after work in ${where.join(", ") || "a chat"})`;
  }

  /** Whether this workspace has automatic saving on (it is unless an owner turned agents.autoMemory off). */
  private on(workspaceId: string) {
    return agentPolicy(this.hub, workspaceId).autoMemory;
  }

  /**
   * A chat run finished with a reply. Decide whether it's worth a memory pass, and queue it.
   * `usedSkill`: it learned or followed a skill (so there's one already).
   */
  runFinished(
    run: { id: string; agentId: string; channelId: string; threadId: string | null; triggerMessageId: string; requestedBy: string | null; discussionId: string | null; phase: string | null; kind: string | null },
    result: { reply: string; tools: string[]; usedSkill: boolean },
    at = new Date(),
  ) {
    const saved = this.savedIn.get(run.id);
    this.savedIn.delete(run.id);
    if (run.kind) return;
    const { store } = this.hub;
    const agent = store.agent(run.agentId);
    if (!agent || !this.on(agent.workspaceId)) return;
    // in a discussion only the summary counts: that's where it decides
    if (run.discussionId && run.phase !== "summary") return;
    const trigger = run.triggerMessageId ? store.message(run.triggerMessageId) : undefined;
    const fromPerson = trigger?.author.kind === "user" && trigger.author.id !== "system";
    const asked = trigger?.body ?? "";
    const tools = result.tools.map(toolName);
    const work = tools.filter((t) => !BOOKKEEPING.test(t));
    const reasons: Reason[] = [];
    if (run.discussionId) reasons.push("decision");
    if (tools.includes("task_update")) reasons.push("task");
    if (work.length >= WORK_CALLS) reasons.push("work");
    if (fromPerson && SAID.test(asked)) reasons.push("said");
    const taught = fromPerson && TAUGHT.test(asked);
    if (taught) reasons.push("taught");
    const repeat = work.length >= 2 && this.repeats(run.id, run.agentId, asked, work, at);
    if (repeat) reasons.push("repeat");
    const learn = agentPolicy(this.hub, agent.workspaceId).learnSkills;
    const skill = learn && (taught || repeat) && !result.usedSkill && !tools.includes("skill_save") && !this.hasSkillFor(run.agentId, asked);
    const savedAny = !!saved?.size || tools.some((t) => SAVING.test(t));
    const note = reasons.some((r) => r !== "repeat") && !savedAny;
    if (!skill && !note) return;
    const userId = run.requestedBy ?? store.members(agent.workspaceId).find((m) => m.role === "owner")?.id;
    if (!userId) return;

    const channel = store.channel(run.channelId);
    const where = !channel ? "a chat" : channel.kind === "dm" ? "a direct message" : `#${channel.name}`;
    const key = `${run.agentId}:${userId}`;
    const p = this.pending.get(key) ?? { agentId: run.agentId, userId, channelId: run.channelId, items: [], first: at.getTime(), due: 0 };
    p.items = [
      ...p.items,
      {
        runId: run.id,
        at: at.toISOString(),
        where,
        who: trigger ? this.hub.displayName(trigger.author) : "someone",
        asked: short(asked),
        replied: short(result.reply),
        tools: [...new Set(work)].slice(0, 12),
        reasons: reasons.filter((r) => r !== "repeat" || skill),
        skill,
      },
    ].slice(-MAX_ITEMS);
    p.channelId = run.channelId;
    p.due = Math.min(at.getTime() + SETTLE_MS, p.first + MAX_WAIT_MS);
    this.pending.set(key, p);
  }

  /** Has the agent done this kind of task before (same tools, a similar ask)? Remembers this one either way. */
  private repeats(runId: string, agentId: string, asked: string, tools: string[], at: Date): boolean {
    const { db } = this.hub.store;
    const words = noteWords(asked);
    const used = new Set(tools);
    const since = new Date(at.getTime() - REPEAT_DAYS * 86_400_000).toISOString();
    const earlier = db.prepare("SELECT words, tools FROM task_shapes WHERE agent_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200").all(agentId, since) as { words: string; tools: string }[];
    db.prepare("INSERT OR REPLACE INTO task_shapes (run_id, agent_id, words, tools, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, agentId, [...words].join(" "), [...used].join(" "), at.toISOString());
    return earlier.some((e) => {
      const ask = overlap(words, new Set(e.words.split(" ").filter(Boolean)));
      const how = overlap(used, new Set(e.tools.split(" ").filter(Boolean)));
      return ask.shared >= 2 && ask.score >= 0.3 && how.score >= 0.5;
    });
  }

  /** Whether one of the agent's skills already looks like it's for this. */
  private hasSkillFor(agentId: string, asked: string): boolean {
    const words = noteWords(asked);
    return this.hub.skills.forAgent(agentId).some((s) => overlap(words, noteWords(`${s.name} ${s.description}`)).shared >= 2);
  }

  /** Start every pass that's due, and tidy vaults that are due a tidy. */
  async tick(at = new Date()) {
    const { store } = this.hub;
    for (const [key, p] of this.pending) {
      if (p.due > at.getTime()) continue;
      const agent = store.agent(p.agentId);
      if (!agent || !store.user(p.userId) || !this.on(agent.workspaceId)) {
        this.pending.delete(key);
        continue;
      }
      // waits (keeping what it has) while the agent's device is away or it's already saving
      if (!this.hub.agentAvailable(agent) || this.passRunning(agent.id)) continue;
      this.pending.delete(key);
      // the same allowance as background checks: past most of it, saving waits for another day
      if (this.hub.background.allowanceShare(agent.workspaceId, p.userId, at) >= SLOW_DOWN_AT) continue;
      if (this.passesToday(agent.id, p.userId, at) >= PASSES_PER_DAY) continue;
      if (this.hub.whyNotAllowed(agent, p.userId) || !this.hub.answers(agent, p.userId)) continue;
      const channelId = store.channel(p.channelId) ? p.channelId : store.dmChannel(agent.workspaceId, p.userId, agent.id).id;
      const runId = store.createRun({ agentId: agent.id, channelId, threadId: null, triggerMessageId: "", hop: 0, requestedBy: p.userId, kind: "memory" });
      this.passes.set(runId, p);
      this.hub.dispatchRun(runId);
    }
    for (const ws of store.db.prepare("SELECT id FROM workspaces").all() as { id: string }[]) {
      if ((this.tidiedAt.get(ws.id) ?? 0) + TIDY_EVERY_MS > at.getTime()) continue;
      this.tidiedAt.set(ws.id, at.getTime());
      if (this.on(ws.id)) await this.tidy(ws.id, at).catch(() => undefined);
    }
  }

  private passRunning(agentId: string) {
    return !!this.hub.store.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? AND kind = 'memory' AND status IN ('queued','running')").get(agentId);
  }

  private passesToday(agentId: string, userId: string, at: Date) {
    const since = new Date(at.getTime() - 86_400_000).toISOString();
    return (this.hub.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND requested_by = ? AND kind = 'memory' AND created_at >= ?").get(agentId, userId, since) as { n: number }).n;
  }

  /** The prompt for a memory pass. */
  prompt(run: { id: string; agentId: string }): string {
    const { store } = this.hub;
    const agent = store.agent(run.agentId)!;
    const p = this.passes.get(run.id);
    const merges = this.merges.get(run.agentId) ?? [];
    this.merges.delete(run.agentId);
    const items = (p?.items ?? []).map((i, n) =>
      [
        `${n + 1}. ${i.at.slice(0, 16).replace("T", " ")} UTC in ${i.where}. ${i.who} wrote: "${i.asked || "(nothing)"}"`,
        i.tools.length ? `   You used: ${i.tools.join(", ")}` : "",
        i.replied ? `   You replied: "${i.replied}"` : "",
        `   Why it may be worth keeping: ${i.reasons.map((r) => WHY[r]).join("; ")}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const skillItems = (p?.items ?? []).flatMap((i, n) => (i.skill ? [n + 1] : []));
    const learned = this.hub.skills.forAgent(agent.id).filter((s) => s.source === "learned");
    return [
      `You are @${agent.handle} ("${agent.name}") in the Wisp workspace "${store.workspace(agent.workspaceId)?.name}". This is a short memory pass Wisp runs after your recent work. Nothing you write here is posted; only what you save is kept, and people can see and undo every save in Memory.`,
      items.length ? `\n## What happened\n${items.join("\n")}` : "",
      `\n## What to do`,
      `- For each item, decide whether anything is worth keeping: a decision, a preference, a result someone will need again, how a connected app or site works, a fact about a project or person. Skip small talk, one-off answers and anything memory already has.`,
      `- Search first (memory_search) and update the note that's already there instead of making another one.`,
      `- Facts about a person: memory_remember. Everything else: memory_write, following your memory skill (me/skills/memory/SKILL.md): one idea per note, a clear title, and [[links]] to the related notes and the hub note of its project, topic or person (make the hub note if it's missing).`,
      `- Things other agents or people should know go in shared/ (or the team's folder); your own working notes in me/.`,
      skillItems.length
        ? `- ${skillItems.length === 1 ? `Item ${skillItems[0]}` : `Items ${skillItems.join(", ")}`}: save how to do it with skill_save (short numbered steps with the specifics that mattered, and where to stop and ask a person).${learned.length ? ` If one of your skills already covers it (${learned.map((s) => `/${s.slug}`).join(", ")}), save under that name to update it.` : ""}`
        : "",
      merges.length ? `- Wisp found notes that may say the same thing: ${merges.map(([a, b]) => `${a} and ${b}`).join("; ")}. If they do, merge them into one and memory_forget the other; if not, link them.` : "",
      `- Never save passwords, keys, tokens, card numbers or one-time codes; write where the secret lives instead.`,
      `\nKeep it short: a few tool calls. When you're done, reply with one line saying what you saved, or "nothing" if nothing was worth keeping.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A pass ended. Nothing is posted; what it saved is in the vault's history. */
  finished(runId: string) {
    this.passes.delete(runId);
    this.savedIn.delete(runId);
  }

  /**
   * The daily tidy, with no model: recent notes in shared/ and agents' folders that link to nothing
   * and nothing links to get a "Related:" line to their closest notes in the same folder tree, and
   * notes that look like the same idea are handed to the agent that owns them to merge.
   */
  async tidy(workspaceId: string, at = new Date()) {
    const vault = this.hub.vault(workspaceId);
    const since = at.getTime() - 7 * 86_400_000;
    const graph = vault.graph();
    const agents = new Set(this.hub.store.agents(workspaceId).map((a) => a.id));
    const scopeOf = (p: string) => (p.startsWith("shared/") ? "shared" : /^agents\/[^/]+\//.test(p) ? p.split("/").slice(0, 2).join("/") : null);
    const machinery = (p: string) => /(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(p) || /(^|\/)SOUL\.md$/i.test(p) || /(^|\/)journal\//i.test(p);
    const recent = graph.nodes.filter((n) => n.path && (n.updatedAt ?? 0) >= since && scopeOf(n.path) && !machinery(n.path)).slice(0, TIDY_NOTES);
    for (const n of recent) {
      const p = n.path!;
      const scope = scopeOf(p)!;
      const inScope = (q: string) => q.startsWith(scope + "/") && !machinery(q);
      const note = await vault.read(p).catch(() => null);
      if (!note) continue;
      const hints = await vault.hints(p, note.content, inScope);
      if (n.links === 0) {
        const links = [...new Set([...hints.linkable, ...hints.similar.map((s) => `[[${s.path.split("/").pop()!.replace(/\.md$/i, "")}]]`)])].slice(0, 3);
        if (links.length) await vault.write(p, `${note.content.replace(/\s+$/, "")}\n\nRelated: ${links.join(", ")}\n`, { name: "Wisp", email: "wisp@localhost" }, `Tidy: link ${p} to related notes`);
      }
      // the agent that owns the folder merges, and only notes it can edit
      const owner = scope.startsWith("agents/") ? scope.split("/")[1] : null;
      if (!owner || !agents.has(owner)) continue;
      for (const s of hints.similar) {
        const other = await vault.read(s.path).catch(() => null);
        if (!other) continue;
        const score = overlap(noteWords(note.content), noteWords(other.content)).score;
        const pair: [string, string] = [p, s.path].sort() as [string, string];
        const list = this.merges.get(owner) ?? [];
        if (score >= MERGE_SCORE && !list.some(([a, b]) => a === pair[0] && b === pair[1])) this.merges.set(owner, [...list, pair].slice(-5));
      }
    }
    this.hub.store.db.prepare("DELETE FROM task_shapes WHERE created_at < ?").run(new Date(at.getTime() - REPEAT_DAYS * 86_400_000).toISOString());
  }
}
