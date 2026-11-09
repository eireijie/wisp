import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WispClient } from "@wisp/sdk";
import { SETTINGS_HARNESSES, SETUP_STEPS, WATCH_SERVICES, type Screenshot } from "@wisp/core";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/**
 * The Wisp MCP server: gives any MCP-capable harness (Claude Code, Codex,
 * Kimi, Hermes, OpenClaw, ...) chat, task, memory-vault and file tools.
 */
export async function createWispMcp(client: WispClient, opts: { localFiles?: boolean } = {}) {
  const me = await client.me();
  if (me.kind !== "agent" || !me.agent) throw new Error("wisp-mcp needs an agent token (or a node token with WISP_AGENT)");
  const self = me.agent;
  const myDir = `agents/${self.id}`;

  /** `me/notes.md` is shorthand for this agent's private folder. */
  const vaultPath = (p: string) => (p === "me" || p.startsWith("me/") ? myDir + p.slice(2) : p.replace(/^\/+/, ""));
  const resolveChannel = async (ref: string) => {
    const ch = await client.channelByName(ref);
    if (!ch) throw new Error(`no channel "${ref}"`);
    return ch;
  };
  const safe =
    <A>(fn: (a: A) => Promise<{ content: Content[] }>) =>
    async (a: A) => {
      try {
        return await fn(a);
      } catch (e) {
        return { ...text(`Error: ${(e as Error).message}`), isError: true };
      }
    };

  // what this agent knows going in (who it works with, its teams, pinned notes), so a session starts with it
  const startup = await client
    .memoryContext()
    .then((r) => r.text, () => "")
    .then((t) => (t.length > 8000 ? t.slice(0, 8000) + "\n…(more with memory_context)" : t));
  const server = new McpServer(
    { name: "wisp", version: "0.0.1" },
    {
      instructions: `You are @${self.handle} in the Wisp "${me.workspace.name}". Use these tools to talk with people and other agents, delegate work, and keep long-term memory. Your private memory folder is "me/" (${myDir}/); "shared/" is visible to every agent, and people may give you access to other folders. Search memory before answering questions about past work, and write down durable facts, decisions and results. Before saving anything, read your memory skill (me/skills/memory/SKILL.md) and follow it: search first and update rather than duplicate, one idea per note, link related notes with [[wikilinks]], never save secrets. Facts about a person (a preference, a plan, something they did, a small detail) go in memory_remember. To hand a note to another agent, share it with memory_share.${startup ? `\n\n${startup}` : ""}`,
    },
  );

  // --- chat -------------------------------------------------------------------

  server.registerTool(
    "chat_send",
    {
      description: "Post a message to a Wisp channel (by name, e.g. 'launch'). @mention another agent's handle to wake it up.",
      inputSchema: { channel: z.string(), message: z.string(), thread_id: z.string().optional(), file_ids: z.array(z.string()).optional() },
    },
    safe(async ({ channel, message, thread_id, file_ids }) => {
      const ch = await resolveChannel(channel);
      const m = await client.send(ch.id, message, { threadId: thread_id, fileIds: file_ids });
      return text(`Posted ${m.id} to #${ch.name}.`);
    }),
  );

  server.registerTool(
    "chat_read",
    {
      description: "Read recent messages from a channel, or a thread when thread_id is given. Use before (a time from an earlier line) to read further back, into earlier chats.",
      inputSchema: { channel: z.string(), thread_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), before: z.string().optional() },
    },
    safe(async ({ channel, thread_id, limit, before }) => {
      const ch = await resolveChannel(channel);
      const [{ messages }, agents] = await Promise.all([client.messages(ch.id, { thread: thread_id, limit: limit ?? 30, before }), client.agents()]);
      const names = new Map(agents.map((a) => [a.id, `@${a.handle}`]));
      return text(messages.map((m) => `[${m.id}] ${m.createdAt} ${m.author.kind === "agent" ? names.get(m.author.id) : m.author.id === "system" ? "system" : "human"}: ${m.body}`).join("\n") || "(no messages)");
    }),
  );

  server.registerTool(
    "chat_react",
    { description: "React to a message with an emoji, like a teammate would: 👍 to agree, ✅ when something is done, 👀 when you're looking into it. Message ids come from chat_read.", inputSchema: { message_id: z.string(), emoji: z.string() } },
    safe(async ({ message_id, emoji }) => {
      await client.react(message_id, emoji, true);
      return text(`Reacted ${emoji}.`);
    }),
  );

  server.registerTool(
    "chat_channels",
    { description: "List channels you can see." },
    safe(async () => json((await client.channels()).filter((c) => c.kind === "channel" && !c.archivedAt).map((c) => ({ name: c.name, topic: c.topic, ...(c.private ? { private: true } : {}) })))),
  );

  server.registerTool(
    "agents_list",
    { description: "List agents in the workspace with their harness, status and the channel teams they're on." },
    safe(async () => {
      const [agents, teams] = await Promise.all([client.agents(), client.teams()]);
      return json(agents.map((a) => ({ handle: `@${a.handle}`, name: a.name, harness: a.harness, status: a.status, teams: teams.filter((t) => t.members.some((m) => m.agentId === a.id)).map((t) => `#${t.name}`) })));
    }),
  );

  server.registerTool(
    "teams_list",
    { description: "List channel teams (every team is a channel's): their leads, members and roles, who they report to, and their memory folder and repo." },
    safe(async () => {
      const [teams, agents] = await Promise.all([client.teams(), client.agents()]);
      const h = (id: string | null) => (id ? `@${agents.find((a) => a.id === id)?.handle ?? "?"}` : null);
      return json(teams.map((t) => ({ channel: `#${t.name}`, leads: t.leads.map(h), reportsTo: h(t.reportsTo), memory: t.folder ? `${t.folder}/` : null, repo: t.repo, members: t.members.map((m) => ({ agent: h(m.agentId), role: m.role || null })) })));
    }),
  );

  server.registerTool(
    "team_setup",
    {
      description:
        "Set up how a channel's team works, when a person describes it (\"Opus plans, GPT challenges it until it approves, then Opus hands out the work\"). Give each role a name, a description every agent on the team will read, and the agent who fills it; then the steps in order. A new message in the channel goes through the steps: Wisp hands each step to its role's agent. Kinds: do (does it, passes the result on), review (approves, or sends it back to an earlier step, up to max_rounds before asking a person), hand_out (splits the work into pieces for hand_to roles; review_by checks each piece), ask (a person approves it from the Inbox; send_back_to is where changes go). Replaces the channel's roles and steps. Only the workspace's lead or the channel's lead can.",
      inputSchema: {
        channel: z.string().describe("e.g. #launch-site"),
        schedules: z
          .array(z.object({ cron: z.string().describe('when, as cron, e.g. "0 9 * * 1" for Mondays at 9:00'), ask: z.string().describe("what the team gets asked each time"), timezone: z.string().optional().describe("IANA name, e.g. America/New_York") }))
          .optional()
          .describe("times the team starts on its own, at its first steps; each result still goes along the steps. Leave out to keep the schedules it has"),
        roles: z.array(z.object({ name: z.string(), description: z.string(), agent: z.string().describe("agent handle") })),
        steps: z.array(
          z.object({
            role: z.string().optional().describe("a role name from roles (not needed for ask)"),
            kind: z.enum(["do", "review", "hand_out", "ask"]).optional(),
            prompt: z.string().optional().describe("this step's own instructions"),
            inputs: z.array(z.number().int()).optional().describe("step numbers (1-based) whose results this step uses and waits for. Give inputs on any step and the steps become a flow chart: steps without inputs start together; otherwise they follow one another"),
            action: z.string().describe("what the role does in this step, e.g. Draft a thorough plan"),
            send_back_to: z.number().int().optional().describe("review: step number (1-based) that gets the work back"),
            max_rounds: z.number().int().optional(),
            hand_to: z.array(z.string()).optional().describe("hand_out: role names the pieces go to"),
            review_by: z.string().optional().describe("hand_out: role name that checks each piece"),
          }),
        ),
      },
    },
    safe(async ({ channel, roles, steps, schedules }) => {
      await client.setTeamSteps(channel, { roles, steps, schedules });
      return text(`#${channel.replace(/^#/, "")} now works in ${steps.length} step${steps.length === 1 ? "" : "s"} with ${roles.length} role${roles.length === 1 ? "" : "s"}. Tell the person it's set up; they can change it in the channel's Team tab.`);
    }),
  );

  // --- tasks ------------------------------------------------------------------

  server.registerTool(
    "task_delegate",
    {
      description:
        "Hand a piece of work to another agent (possibly on another computer). They get woken up, and you get a message back when they mark it done. Work you hand out while working on a task becomes a subtask of it (or name the parent with parent_task_id); if you're the lead, this is how you assign the pieces of a task to agents by their roles.",
      inputSchema: {
        to: z.string().describe('agent handle, e.g. @nova, or "#channel" for the lead of that channel\'s team'),
        title: z.string(),
        brief: z.string().describe("everything they need to do the work"),
        channel: z.string().optional(),
        file_ids: z.array(z.string()).optional(),
        parent_task_id: z.string().optional().describe("the task this is a piece of; defaults to the task you're working on"),
      },
    },
    safe(async ({ to, title, brief, channel, file_ids, parent_task_id }) => {
      const ch = channel ? await resolveChannel(channel) : undefined;
      const t = (await client.delegate(to, title, brief, { channelId: ch?.id, fileIds: file_ids, parentTaskId: parent_task_id })) as { id: string; parentId?: string | null };
      return text(`Created task ${t.id} for ${to}${t.parentId ? ` (a subtask of ${t.parentId})` : ""}.`);
    }),
  );

  server.registerTool(
    "agent_create",
    {
      description:
        "Create a new agent to work under you. Leads can do this when their team needs someone it doesn't have; agents a lead made can make sub-agents for pieces of their work. Only works when the workspace switched it on (your prompt says so). The new agent joins your channel's team chart under you; then hand it work with task_delegate.",
      inputSchema: {
        name: z.string().describe("its name, e.g. Scout"),
        role: z.string().optional().describe("what it does in a few words, e.g. Researcher"),
        instructions: z.string().optional().describe("its job and how it should work"),
        handle: z.string().optional().describe("its @handle; made from the name when left out"),
      },
    },
    safe(async ({ name, role, instructions, handle }) => {
      const a = (await client.spawnAgent({ name, role, instructions, handle })) as { handle: string };
      return text(`Created @${a.handle}. Hand it work with task_delegate (to: "@${a.handle}").`);
    }),
  );

  server.registerTool(
    "task_update",
    { description: "Update a task assigned to you. Mark it done (with the result) when finished, or failed with the reason. A task you split into subtasks isn't finished on its own: mark it done once its subtasks are in (results of subtasks come back to you with how many are done). For a review, say whether it's approved or needs changes with verdict.", inputSchema: { task_id: z.string(), status: z.enum(["in_progress", "done", "failed"]), result: z.string().optional(), verdict: z.enum(["approved", "changes"]).optional().describe("for a review: approved moves the work on, changes sends it back with your result as the notes") } },
    safe(async ({ task_id, status, result, verdict }) => {
      await client.updateTask(task_id, status, result, verdict);
      return text(`Task ${task_id} is now ${status}.`);
    }),
  );

  server.registerTool(
    "task_list",
    { description: "List tasks assigned to you or created by you.", inputSchema: { status: z.enum(["open", "in_progress", "done", "failed"]).optional() } },
    safe(async ({ status }) => json(await client.tasks({ agent: "me", ...(status ? { status } : {}) }))),
  );

  server.registerTool(
    "discussion_start",
    {
      description:
        "Talk something through with other agents before doing it. Everyone answers on their own in round 1, then they respond to each other; after the last round the moderator (you, by default) writes the decision, which is saved to team memory, and hands out tasks. It runs by itself in a thread; you'll be woken to write the decision if you moderate.",
      inputSchema: {
        topic: z.string(),
        goal: z.string().optional().describe("what the discussion should decide"),
        participants: z.array(z.string()).optional().describe("agent handles; default: everyone on the team"),
        team: z.string().optional().describe("a channel with a team, e.g. #web; the discussion happens there and its decision goes in the team's memory folder"),
        rounds: z.number().int().min(1).max(5).optional(),
        moderator: z.string().optional(),
      },
    },
    safe(async (d) => {
      const r = await client.startDiscussion(d);
      return text(`Started discussion ${r.id} (${r.rounds} round${r.rounds === 1 ? "" : "s"}). It happens in the thread of message ${r.threadId}.`);
    }),
  );

  server.registerTool(
    "branch_merge",
    { description: "Merge a coding task's branch into the team's base branch (after reviewing it). Pass the task id, or the id of the review task.", inputSchema: { task_id: z.string() } },
    safe(async ({ task_id }) => text((await client.mergeTask(task_id)).output)),
  );

  // --- memory vault -------------------------------------------------------------

  server.registerTool(
    "memory_search",
    { description: "Full-text search across every memory note you can read (your own, shared, and anything shared with you).", inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() } },
    safe(async ({ query, limit }) => {
      const hits = await client.search(query, limit ?? 10);
      return text(hits.map((h) => `${h.path} — ${h.title}\n  ${h.snippet}`).join("\n") || "No matches.");
    }),
  );

  server.registerTool(
    "memory_read",
    { description: "Read a markdown note. Paths look like 'shared/projects/x.md' or 'me/notes.md'.", inputSchema: { path: z.string() } },
    safe(async ({ path: p }) => {
      const n = await client.readNote(vaultPath(p));
      return text(`${n.content}${n.backlinks.length ? `\n\n---\nLinked from: ${n.backlinks.join(", ")}` : ""}`);
    }),
  );

  server.registerTool(
    "memory_write",
    {
      description:
        "Create or overwrite a markdown note (Obsidian style: use [[wikilinks]] and #tags). Write to 'me/...' for private memory or 'shared/...' for everyone; follow me/skills/memory/SKILL.md for folders, header and links. Every write is versioned. The reply lists similar notes to merge into and names you could link.",
      inputSchema: { path: z.string(), content: z.string(), message: z.string().optional().describe("short change description") },
    },
    safe(async ({ path: p, content, message }) => text(`Saved ${vaultPath(p)}.${saveHints(await client.writeNote(vaultPath(p), content, message))}`)),
  );

  server.registerTool(
    "memory_append",
    { description: "Append text to a note, creating it if needed. Good for logs and journals.", inputSchema: { path: z.string(), text: z.string() } },
    safe(async ({ path: p, text: t }) => text(`Appended to ${vaultPath(p)}.${saveHints(await client.appendNote(vaultPath(p), t))}`)),
  );

  server.registerTool(
    "memory_remember",
    {
      description:
        "Remember something about a person so every agent knows it later. kind: 'preference' (how they like things), 'plan' (something they intend to do; add due as YYYY-MM-DD if there is one), 'did' (something they did; goes in a dated journal), or 'detail' (a fact about them, their setup, people, tools). One fact per call, in plain words. Defaults to the person you're working with. If a similar memory exists you'll get it back: pass its path as replaces to update it, e.g. to mark a plan done with status 'done'. Never save passwords, keys or secrets.",
      inputSchema: {
        kind: z.enum(["preference", "plan", "did", "detail"]),
        text: z.string().optional().describe("the fact; optional only when replacing to change status/due"),
        about: z.string().optional().describe("person's name; default: who you're working with"),
        status: z.enum(["active", "done", "dropped"]).optional(),
        due: z.string().optional(),
        replaces: z.string().optional().describe("path of the memory this updates"),
      },
    },
    safe(async (m) => {
      const r = await client.remember(m);
      if (r.saved) return text(`Remembered (${m.kind}) about ${r.person.name} in ${r.path}.`);
      return text(`Not saved: ${r.person.name} already has similar ${m.kind} memories:\n${(r.similar ?? []).map((s) => `- ${s.path}: ${s.text}`).join("\n")}\nIf yours adds something, call again with replaces set to one of these paths.`);
    }),
  );

  server.registerTool(
    "memory_forget",
    { description: "Delete a memory that turned out to be wrong or no longer true (git history keeps the old version).", inputSchema: { path: z.string() } },
    safe(async ({ path: p }) => {
      await client.deleteNote(vaultPath(p));
      return text(`Forgot ${vaultPath(p)}.`);
    }),
  );

  server.registerTool(
    "memory_context",
    {
      description: "What you should know before working: the person you're working with, your teams, the teams that report to you, notes pinned for you, and notes related to an optional topic.",
      inputSchema: { topic: z.string().optional(), about: z.string().optional().describe("person's name") },
    },
    safe(async ({ topic, about }) => text((await client.memoryContext(topic ?? "", about)).text || "Nothing in memory yet.")),
  );

  server.registerTool(
    "memory_share",
    {
      description: "Let another agent read a note or folder you can edit, e.g. share 'me/research.md' with '@nova'. 'with' is an agent handle, a group name, or 'all agents'. They can read it from then on; people can see and undo shares.",
      inputSchema: { path: z.string().describe("note or folder"), with: z.string() },
    },
    safe(async ({ path: p, with: who }) => {
      let target = vaultPath(p).replace(/\/+$/, "");
      // "notes/plan" means the note notes/plan.md when there is one, otherwise the folder
      if (!/\.md$/i.test(target) && (await client.notes()).some((n) => n.path.toLowerCase() === `${target}.md`.toLowerCase())) target += ".md";
      await client.shareNote(target, who);
      return text(`Shared ${target} with ${who} (read-only).`);
    }),
  );

  server.registerTool(
    "memory_list",
    { description: "List notes you can read, optionally under a folder prefix like 'shared/' or 'me/'.", inputSchema: { prefix: z.string().optional() } },
    safe(async ({ prefix }) => {
      const pre = prefix ? vaultPath(prefix) : "";
      const notes = (await client.notes()).filter((n) => n.path.startsWith(pre));
      return text(notes.map((n) => `${n.path} — ${n.title}${n.tags.length ? ` #${n.tags.join(" #")}` : ""}`).join("\n") || "No notes.");
    }),
  );

  // --- computer -----------------------------------------------------------------

  const computer = await client.myComputer().catch(() => null);
  if (computer) registerComputerTools(server, client, computer, safe);

  // --- reaching the person, and coming back to things -------------------------------------------

  server.registerTool(
    "message_person",
    {
      description:
        "Write to the person you work for, first, in your DM with them: it reaches their phone. Use it when something needs them (a deadline, an email they missed, a reply that arrived, a finished task), not to say you checked. Keep it short and specific; do the work first (a draft, the answer) and include it. For anything you'd send, buy or delete for them, use approval_request instead.",
      inputSchema: {
        text: z.string(),
        file_ids: z.array(z.string()).optional(),
        replies: z.array(z.string()).optional().describe("2–4 quick answers they can tap, a few words each, under 40 characters (\"Sent it\", \"Tomorrow\"), when they'd answer in a word"),
        about: z.string().optional().describe("a short key for what this is about (\"notion:<page id>\", \"essay-due-friday\"), so you only raise it once: if they don't answer, Wisp won't let you raise the same key again"),
      },
    },
    safe(async ({ text: t, file_ids, replies, about }) => {
      await client.messagePerson(t, file_ids ?? [], replies ?? [], about);
      return text("Sent.");
    }),
  );

  // --- watching the person's apps ---------------------------------------------------------

  server.registerTool(
    "watch_list",
    {
      description:
        "See what you watch for the person you work for (apps where Wisp tells you when something changes, and sites you check in your browser), and what else can be watched and how to connect it.",
      inputSchema: {},
    },
    safe(async () => {
      const r = await client.watches();
      return text(
        [
          r.watches.length ? "You watch:" : "You don't watch anything for them yet.",
          ...r.watches.map((w) => `- ${w.id} ${w.label} (${w.service})${w.paused ? ", paused" : ""}${w.lastError ? `, last look failed: ${w.lastError}` : ""}. ${w.estimate.note}`),
          "\nWhat can be watched:",
          ...r.services.map((s) => `- ${s.service}: ${s.name}, ${s.watches}.${s.available ? "" : ` Not available: ${s.unavailableReason}`} How: ${s.howToConnect}`),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "watch_start",
    {
      description:
        "Start watching one of the person's apps for them, once they've said yes (\"keep an eye on my Slack\"). Wisp looks for changes on its own, at no token cost, and wakes you with what changed. It uses the key from your connector for that app, or one you give in `key` (ask before making a key for them). For apps with no easy key (Google, Meta, school or bank sites), use service \"browser\" with config.url and config.lookFor: you'll be woken every few hours to look in your computer's browser. Tell them what you'll watch and that they can stop it any time.",
      inputSchema: {
        service: z.enum(["slack", "github", "notion", "linear", "jira", "stripe", "gdrive", "gmail", "gcal", "browser"]),
        key: z.record(z.string(), z.string()).optional().describe("values for this watch alone, named like the connector's (GITHUB_TOKEN, SLACK_BOT_TOKEN…)"),
        config: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("Slack: channels (names); Stripe: types; browser: url and lookFor"),
        label: z.string().optional().describe("what the person sees, e.g. \"Canvas assignments\""),
        every_minutes: z.number().optional().describe("how often to look; browser watches: 120 or more"),
      },
    },
    safe(async ({ service, key, config, label, every_minutes }) => {
      const w = await client.startWatch({ service, key, config, label, everyMinutes: every_minutes });
      return text(
        `Watching ${w.label} (${w.id}). ${w.estimate.note}${w.backgroundOn ? "" : " Background work is off for them, so changes will wait until it's on: ask them, then use settings_change with enabled true."}`,
      );
    }),
  );

  server.registerTool(
    "watch_stop",
    {
      description: "Stop watching something for the person, when they ask or it no longer matters. Changes it saw are dropped.",
      inputSchema: { watch_id: z.string() },
    },
    safe(async ({ watch_id }) => {
      await client.stopWatch(watch_id);
      return text("Stopped.");
    }),
  );

  server.registerTool(
    "settings_read",
    {
      description:
        "See how Wisp is set up for the person you work for: your background work for them (on or off, how often, quiet hours, what to keep an eye on), which mods are on, and how much of their daily allowance background work used today. Read it before settings_change.",
      inputSchema: {},
    },
    safe(async () => {
      const s = await client.mySettings();
      const b = s.background;
      const a = s.allowance;
      const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
      return text(
        [
          b ? `Background work: ${b.enabled ? "on" : "off"}, every ${b.everyMinutes} minutes, quiet ${b.quietStart}–${b.quietEnd}, keeping an eye on: ${b.focus || "everything you can reach"}.` : "Background work: never turned on for them.",
          `Mods (${s.canChangeMods ? "you can change these for them" : "only an owner can change these"}):`,
          ...s.mods.map((m) => `- ${m.key}: ${m.name} (${m.on ? "on" : "off"}): ${m.description}`),
          `Allowance: ${a.dailyTokens ? `${k(a.todayTokens)} of ${k(a.dailyTokens)} tokens used today` : `no limit, ${k(a.todayTokens)} tokens used today`}. They change the allowance themselves in Settings → Usage.`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "settings_change",
    {
      description:
        "Change how Wisp works for the person you work for, when they ask in plain words (\"check less often\", \"don't message me after 10pm\", \"turn on voice calls\"). Background fields change your own background work for them; mods switch optional parts of Wisp on or off (owners only). Only change what they asked for. They see what changed in your DM with an Undo button, so just confirm in a few words.",
      inputSchema: {
        enabled: z.boolean().optional().describe("background work on or off"),
        every_minutes: z.number().int().min(10).max(1440).optional().describe("how often to check, 10–1440 minutes"),
        quiet_start: z.string().optional().describe("quiet hours start, 'HH:MM' 24-hour on their clock"),
        quiet_end: z.string().optional().describe("quiet hours end, 'HH:MM'; same as start = no quiet hours"),
        focus: z.string().optional().describe("what to keep an eye on, in their words; empty = everything you can reach"),
        mods: z.record(z.string(), z.boolean()).optional().describe("mod key → on/off, keys from settings_read"),
      },
    },
    safe(async ({ enabled, every_minutes, quiet_start, quiet_end, focus, mods }) => {
      const background = Object.fromEntries(Object.entries({ enabled, everyMinutes: every_minutes, quietStart: quiet_start, quietEnd: quiet_end, focus }).filter(([, v]) => v !== undefined));
      const r = await client.changeSettings({ ...(Object.keys(background).length ? { background } : {}), ...(mods && Object.keys(mods).length ? { mods } : {}) });
      return text(r.changed.length ? `Changed:\n${r.changed.map((l) => `- ${l}`).join("\n")}\nThey can see it in your DM and undo it.` : (r.note ?? "Nothing changed."));
    }),
  );

  server.registerTool(
    "next_check",
    {
      description:
        "When you're working in the background: say when to look again (10 minutes to 24 hours) and why. Use it while something is moving (waiting on a reply, a deadline today); that time is kept. When it's calm, don't call it: checks slow down by themselves.",
      inputSchema: { minutes: z.number().describe("minutes from now"), reason: z.string().describe("why then, in a few words") },
    },
    safe(async ({ minutes, reason }) => {
      const r = await client.nextCheck(minutes, reason);
      return text(r.on ? `Next check in ${r.minutes} minutes (${new Date(r.nextAt).toISOString()}).` : `Noted, but background checks are off for this person; use followup_set for a specific time.`);
    }),
  );

  server.registerTool(
    "followup_set",
    {
      description:
        "Come back to something at a set time, even if background checks are off: you'll be woken then with this note (e.g. '8am tomorrow: remind them the essay is due at noon'). Give `at` as local time on the person's clock, 'YYYY-MM-DD HH:MM', or `in_minutes`.",
      inputSchema: {
        at: z.string().optional(),
        in_minutes: z.number().optional(),
        note: z.string().describe("what to do then, written to your future self"),
        label: z.string().optional().describe("2–5 words the person sees under your reply: \"Check the build\", \"Nudge you about the deck\", \"Ask how the interview went\""),
        waiting_on: z.enum(["agent", "person"]).optional().describe("\"agent\" when you'll do it (default); \"person\" when it's their promise and you'll nudge them"),
        condition: z.string().optional().describe("for their promises: when it still matters (\"only if it hasn't gone out\")"),
      },
    },
    safe(async ({ at, in_minutes, note, label, waiting_on, condition }) => {
      const f = await client.setFollowup({ at, inMinutes: in_minutes, note, label, waitingOn: waiting_on, condition });
      return text(`Set (${f.id}) for ${new Date(f.dueAt).toLocaleString("en-US", { timeZone: f.timezone, dateStyle: "medium", timeStyle: "short" })} ${f.timezone}.`);
    }),
  );

  server.registerTool(
    "followup_list",
    { description: "Follow-ups you've set that haven't happened yet.", inputSchema: {} },
    safe(async () => {
      const list = await client.followups();
      return text(list.map((f) => `${f.id} ${f.dueAt}: ${f.note}`).join("\n") || "None.");
    }),
  );

  server.registerTool(
    "followup_cancel",
    { description: "Stop a follow-up: it happened (done: true), or it's no longer needed.", inputSchema: { followup_id: z.string(), done: z.boolean().optional() } },
    safe(async ({ followup_id, done }) => {
      await client.cancelFollowup(followup_id, done ?? false);
      return text(done ? "Marked done." : "Cancelled.");
    }),
  );

  server.registerTool(
    "chat_status",
    {
      description:
        "Say where your DM with the person you work for stands, when it changes. \"waiting\": the next step is theirs (an answer, something they said they'd do); Wisp checks back for you if they go quiet. \"done\": what they asked for is finished; add did/saved/next when real work got done and they'll see a short wrap-up. \"open\": anything else. \"closed\": you're dropping it after they didn't answer.",
      inputSchema: {
        status: z.enum(["open", "waiting", "done", "closed"]),
        summary: z.string().optional().describe("what's open, in their words: \"send Sam the deck\""),
        did: z.string().optional().describe("for done: what got done, one line"),
        saved: z.string().optional().describe("for done: what you saved to memory, one line"),
        next: z.string().optional().describe("for done: what comes next, one line"),
        check_back_in_minutes: z.number().optional().describe("for waiting: when to check back if they go quiet (default 3 hours)"),
      },
    },
    safe(async ({ status, summary, did, saved, next, check_back_in_minutes }) => {
      const l = await client.chatStatus({ status, summary, did, saved, next, checkBackInMinutes: check_back_in_minutes });
      return text(l.status === "waiting" ? `Noted: waiting on them (${l.summary}).` : `Noted: ${l.status}.`);
    }),
  );

  server.registerTool(
    "setup_step",
    {
      description:
        "During your first chat with the person you work for (Wisp shows the steps under \"Getting to know\"), record each setup step once it's done or skipped, with a one-line summary. role: the job title they agreed you'd take; Wisp makes it your role. accounts: the accounts or sites they named. watch: only in your reply to their yes, the accounts they said you may keep an eye on; Wisp starts a watch for each. done: true when the setup is over.",
      inputSchema: {
        step: z.enum(SETUP_STEPS).optional(),
        summary: z.string().optional().describe("what you learned or did, one line: \"Wants ads and social posts managed\""),
        role: z.string().optional().describe("for step role, once they agree: \"Business manager\""),
        accounts: z.array(z.string()).optional().describe("for step accounts: [\"Google Ads\", \"Instagram\"]"),
        watch: z
          .array(z.object({ service: z.enum(WATCH_SERVICES), label: z.string().optional(), url: z.string().optional().describe("browser: the site"), lookFor: z.string().optional().describe("browser: what to look for there") }))
          .optional()
          .describe("after they said yes: [{service: \"gmail\"}, {service: \"browser\", label: \"Google Ads\", url: \"https://ads.google.com\", lookFor: \"campaigns paused or over budget\"}]"),
        done: z.boolean().optional(),
      },
    },
    safe(async ({ step, summary, role, accounts, watch, done }) => {
      const r = await client.setupStep({ step, summary, role, accounts, watch, done });
      const watched = r.watched.map((w) => (w.watching ? `Watching ${w.label}.` : `Couldn't watch ${w.label}: ${w.why}`)).join(" ");
      return text([watched, r.done ? "Setup finished. Wrap up with a concrete offer." : `Noted.${r.left.length ? ` Still to do: ${r.left.join(", ")}.` : " That's every step: call setup_step with done: true and wrap up."}`].filter(Boolean).join(" "));
    }),
  );

  // --- approvals & routines ---------------------------------------------------------

  server.registerTool(
    "approval_request",
    {
      description:
        "Ask a person's OK before doing something sensitive or hard to undo (sending an email or message outside Wisp, buying something, deleting things, posting publicly). Posts an Approve / Deny card where you're working. End your turn after calling it: you'll be woken with the answer.",
      inputSchema: { summary: z.string().describe("what you want to do, in one line"), details: z.string().optional().describe("the draft, the list, or why") },
    },
    safe(async ({ summary, details }) => {
      await client.requestApproval(summary, details ?? "");
      return text("Asked. End your turn now; you'll get a message with the decision.");
    }),
  );

  server.registerTool(
    "routine_list",
    { description: "Routines you know: tasks you can do again on your own, some on a schedule. Their steps are notes in your memory.", inputSchema: {} },
    safe(async () => {
      const list = await client.routines();
      return text(list.map((r) => `${r.id} "${r.name}" ${r.status}${r.schedule ? ` schedule "${r.schedule}" (${r.timezone})` : ""} steps: ${r.notePath}`).join("\n") || "No routines yet.");
    }),
  );

  server.registerTool(
    "routine_save",
    {
      description:
        "Save the steps of a routine so you (or a teammate) can do it again on your own: after studying a recording someone made, or when asked to make something a habit. Write numbered steps that name buttons and fields by their labels, say what changes each time, and how to tell it worked. Give routine_id to update one; name to make a new one. schedule is five-field cron, e.g. '0 9 * * 1-5' for weekdays at 9.",
      inputSchema: { routine_id: z.string().optional(), name: z.string().optional(), steps: z.string(), schedule: z.string().nullable().optional(), timezone: z.string().optional().describe("IANA name, e.g. America/New_York") },
    },
    safe(async ({ routine_id, name, steps, schedule, timezone }) => {
      const r = await client.saveRoutine({ routineId: routine_id, name, steps, schedule, timezone });
      return text(`Saved "${r.name}" (${r.id}) to ${r.notePath}.${r.schedule ? ` It runs on schedule "${r.schedule}".` : ""}`);
    }),
  );

  server.registerTool(
    "skill_save",
    {
      description:
        "Save how you did something as a skill, so you do it the same way next time: after a task you'd likely be asked to do again (several steps, a particular site or app, the person's preferences). Write short numbered steps with the specifics that mattered (names, labels, choices the person likes) and where to stop and ask a person. Save again under the same name to update it. Never put passwords, keys or card numbers in a skill.",
      inputSchema: {
        name: z.string().describe("short, like 'Order the usual pizza'"),
        description: z.string().optional().describe("one line: when to use it"),
        content: z.string().describe("markdown: numbered steps"),
        slug: z.string().optional().describe("the /name of a skill you learned before, to update it"),
      },
    },
    safe(async ({ name, description, content, slug }) => {
      const { skill } = await client.saveSkill({ name, description, content, slug });
      return text(`Saved as /${skill.slug}`);
    }),
  );

  // --- your harness's own settings ---------------------------------------------------------------

  const settingsLine = (s: Awaited<ReturnType<typeof client.harnessSettings>>) => {
    const list = (items: { id: string; name: string; enabled: boolean; canToggle: boolean }[]) => items.map((i) => `${i.name}${i.name === i.id ? "" : ` [${i.id}]`} ${i.enabled ? "on" : "off"}${i.canToggle ? "" : " (changed on the device only)"}`).join(", ") || "none";
    return [
      `${s.harness} on ${s.device} (${s.configPath})`,
      s.accounts.length > 1 ? `account in use: ${s.accounts.find((x) => x.id === s.account)?.label ?? s.account} (accounts here: ${s.accounts.map((x) => `${x.label}${x.signedIn === false ? " (not signed in)" : ""}`).join(", ")})` : "",
      `model: ${s.model ?? "(its default)"}${s.providers ? `; provider: ${s.provider ?? "(its default)"} (can be: ${s.providers.map((p) => p.id + (p.signedIn ? " signed in" : "")).join(", ")})` : ""}`,
      s.models.length ? `models it offers: ${s.models.join(", ")}` : "",
      `apps (MCP servers set up in the harness): ${list(s.apps)}`,
      `plugins: ${list(s.plugins)}`,
      `skills: ${list(s.skills)}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  server.registerTool(
    "harness_settings",
    { description: `See your harness's own settings on your device (its config file): the model and provider it uses by default, its apps (MCP servers), plugins and skills, and which are on. Give harness to see another harness on the same device (${SETTINGS_HARNESSES.join(", ")}).`, inputSchema: { harness: z.string().optional() } },
    safe(async ({ harness }) => text(settingsLine(await client.harnessSettings(harness)))),
  );

  server.registerTool(
    "harness_settings_change",
    {
      description:
        "Change your harness's own settings on your device when its owner asks (\"switch Hermes to GPT-5\", \"turn off the GitHub plugin\", \"use my work account\"): its default model, provider, which of its accounts you use, and turning apps, plugins and skills on or off. Only works while you're doing something the device's owner asked for. Names come from harness_settings. The change applies from your next reply on.",
      inputSchema: {
        harness: z.string().optional().describe(`${SETTINGS_HARNESSES.join(", ")}; default: your own`),
        model: z.string().optional(),
        provider: z.string().optional(),
        turn_on: z.array(z.object({ kind: z.enum(["app", "plugin", "skill"]), name: z.string() })).optional(),
        turn_off: z.array(z.object({ kind: z.enum(["app", "plugin", "skill"]), name: z.string() })).optional(),
        use_account: z.string().optional().describe("the name of another of your harness's accounts on this device to use from now on"),
      },
    },
    safe(async ({ harness, model, provider, turn_on, turn_off, use_account }) => {
      const now = await client.harnessSettings(harness);
      const find = (kind: "app" | "plugin" | "skill", name: string) => {
        const items = kind === "app" ? now.apps : kind === "plugin" ? now.plugins : now.skills;
        const n = name.toLowerCase();
        const hit = items.find((i) => i.id === name) ?? items.find((i) => i.id.toLowerCase() === n || i.name.toLowerCase() === n);
        if (!hit) throw new Error(`${now.harness} has no ${kind} "${name}". It has: ${items.map((i) => i.name).join(", ") || "none"}`);
        return hit.id;
      };
      const changes = [
        ...(model ? [{ op: "model" as const, model }] : []),
        ...(provider ? [{ op: "provider" as const, provider }] : []),
        ...(turn_on ?? []).map((t) => ({ op: "toggle" as const, kind: t.kind, id: find(t.kind, t.name), enabled: true })),
        ...(turn_off ?? []).map((t) => ({ op: "toggle" as const, kind: t.kind, id: find(t.kind, t.name), enabled: false })),
      ];
      if (!changes.length && !use_account) return text("Nothing to change: give model, provider, use_account, turn_on or turn_off.");
      const r = await client.changeHarnessSettings(changes, harness, use_account);
      return text(`Changed ${r.changed.join(", ")}.\n${settingsLine({ ...r, models: [] })}`);
    }),
  );

  // --- files ------------------------------------------------------------------

  server.registerTool(
    "file_view",
    { description: "Look at a Wisp file by id: images are shown to you (e.g. screenshots from a recording), text files are returned as text.", inputSchema: { file_id: z.string() } },
    safe(async ({ file_id }) => {
      const f = await client.downloadFile(file_id);
      if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) return { content: [{ type: "image" as const, data: Buffer.from(f.data).toString("base64"), mimeType: f.mime }, { type: "text" as const, text: f.name }] };
      if (/^text\/|json|xml|csv|markdown/.test(f.mime)) return text(Buffer.from(f.data).toString("utf8").slice(0, 50_000));
      return text(`${f.name} is ${f.mime} (${f.data.length} bytes); use file_download to save it.`);
    }),
  );

  /**
   * A file the agent made: read where it runs, else (a path only its computer has, like
   * ~/files/notes.md in its VM, or any path on the remote endpoint) from its computer.
   */
  const readMine = async (p: string): Promise<{ name: string; data: Uint8Array }> => {
    if (opts.localFiles !== false) {
      const local = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
      try {
        return { name: path.basename(local), data: await fs.readFile(local) };
      } catch (err) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
    }
    const comp = await client.myComputer().catch(() => null);
    if (!comp) throw new Error(`There's no file at ${p}.`);
    const f = await client.computer<{ name: string; data: string }>({ action: "file_read", path: p });
    return { name: f.name, data: Buffer.from(f.data, "base64") };
  };

  server.registerTool(
    "file_upload",
    {
      description:
        "Send a file you made (a report, an image, a spreadsheet; up to 100 MB) to the person you're answering: it's attached to your reply in this chat. Give its path where you work or on your computer. Returns a file id, which you can also put in chat_send's file_ids or a task. Only say a file is attached after this succeeds.",
      inputSchema: { local_path: z.string().describe('the file\'s path, e.g. "~/files/report.pdf"'), channel: z.string().optional().describe("only for a file meant for another chat; post it there with chat_send's file_ids") },
    },
    safe(async ({ local_path, channel }) => {
      const f = await readMine(local_path);
      const ch = channel ? await resolveChannel(channel) : undefined;
      const up = await client.uploadFile(f.name, f.data, guessMime(f.name), ch?.id);
      return text(`Sent ${up.name} (${up.size} bytes, file id ${up.id}).${ch ? ` To post it in ${ch.name}, use chat_send with file_ids ["${up.id}"].` : " It's attached to your reply."}`);
    }),
  );

  // the remote endpoint runs on the hub, whose files aren't the caller's
  if (opts.localFiles !== false) {
    server.registerTool(
      "file_download",
      { description: "Download a Wisp file by id into a local directory.", inputSchema: { file_id: z.string(), dest_dir: z.string().optional() } },
      safe(async ({ file_id, dest_dir }) => {
        const f = await client.downloadFile(file_id);
        const dir = dest_dir ?? process.cwd();
        await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, path.basename(f.name));
        await fs.writeFile(dest, f.data);
        return text(`Saved to ${dest}.`);
      }),
    );
  }

  // --- storage (the Storage mod: only there when this agent has some) -------------------------

  const storages = await client.storageMine().catch(() => []);
  if (storages.length) {
    const which = z.string().describe(`which storage: ${storages.map((s) => `"${s.name}"`).join(", ")}`);
    const where = storages.map((s) => `${s.name}: ${s.folders.map((f) => `${f.path} (${f.access === "write" ? "read and change" : "read only"})`).join(", ")}`).join("; ");
    const asked = (r: { status: string; message: string }) => text(r.message);

    server.registerTool(
      "storage_list",
      { description: `List a folder on the person's storage. Without a path, shows the folders you may use. You may use: ${where}.`, inputSchema: { storage: which, path: z.string().optional().describe('e.g. "/Clients/Acme"') } },
      safe(async ({ storage, path: p }) => {
        const r = await client.storageList(storage, p);
        if ("folders" in r) return json(r.folders);
        return text(r.entries.map((e) => `${e.type === "folder" ? "[folder] " : ""}${e.path}${e.size !== null ? ` (${e.size} bytes)` : ""}${e.modified ? `, ${e.modified}` : ""}`).join("\n") || `(${r.path} is empty)`);
      }),
    );

    server.registerTool(
      "storage_read",
      { description: "Read a file on the person's storage: text comes back as text and pictures are shown to you. For anything else, or files over 5 MB, use storage_download.", inputSchema: { storage: which, path: z.string() } },
      safe(async ({ storage, path: p }) => {
        const f = await client.storageRead(storage, p);
        if (f.text !== undefined) return text(f.text.slice(0, 100_000));
        if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime) && f.base64) return { content: [{ type: "image" as const, data: f.base64, mimeType: f.mime }, { type: "text" as const, text: f.name }] };
        return text(`${f.name} is ${f.mime} (${f.size} bytes); use storage_download to get it as a file.`);
      }),
    );

    server.registerTool(
      "storage_search",
      { description: "Find files and folders on the person's storage whose names contain some text, inside the folders you may use (or one of them).", inputSchema: { storage: which, query: z.string(), path: z.string().optional() } },
      safe(async ({ storage, query, path: p }) => {
        const hits = await client.storageSearch(storage, query, p);
        return text(hits.map((e) => `${e.type === "folder" ? "[folder] " : ""}${e.path}`).join("\n") || "Nothing found.");
      }),
    );

    server.registerTool(
      "storage_download",
      {
        description: `Copy a file from the person's storage into Wisp, so you can attach it to a message (its file id)${opts.localFiles !== false ? " and, with dest_dir, save it on your computer" : ""}.`,
        inputSchema: { storage: which, path: z.string(), ...(opts.localFiles !== false ? { dest_dir: z.string().optional() } : {}) },
      },
      safe(async ({ storage, path: p, dest_dir }: { storage: string; path: string; dest_dir?: string }) => {
        const f = await client.storageToWisp(storage, p);
        if (!dest_dir || opts.localFiles === false) return text(`Copied ${f.name} into Wisp as ${f.id} (${f.size} bytes).`);
        const got = await client.downloadFile(f.id);
        await fs.mkdir(dest_dir, { recursive: true });
        const dest = path.join(dest_dir, path.basename(got.name));
        await fs.writeFile(dest, got.data);
        return text(`Saved to ${dest} (Wisp file ${f.id}).`);
      }),
    );

    server.registerTool(
      "storage_upload",
      {
        description: `Put a file on the person's storage at a path (its full path, including the file name). Give a Wisp file id${opts.localFiles !== false ? " or a local_path on your computer" : ""}. A person is asked first, unless they said "Always in this folder"; then end your turn.`,
        inputSchema: { storage: which, path: z.string().describe('e.g. "/Clients/Acme/Q3-report.pdf"'), file_id: z.string().optional(), ...(opts.localFiles !== false ? { local_path: z.string().optional() } : {}) },
      },
      safe(async ({ storage, path: p, file_id, local_path }: { storage: string; path: string; file_id?: string; local_path?: string }) => {
        let fileId = file_id;
        if (!fileId && local_path && opts.localFiles !== false) fileId = (await client.uploadFile(path.basename(local_path), await fs.readFile(local_path), guessMime(local_path))).id;
        if (!fileId) throw new Error("give file_id or local_path");
        return asked(await client.storageChange(storage, "put", p, fileId));
      }),
    );

    server.registerTool(
      "storage_mkdir",
      { description: "Make a folder on the person's storage. A person is asked first, unless they said \"Always in this folder\".", inputSchema: { storage: which, path: z.string() } },
      safe(async ({ storage, path: p }) => asked(await client.storageChange(storage, "mkdir", p))),
    );

    server.registerTool(
      "storage_delete",
      { description: "Delete a file or folder on the person's storage. A person is always asked first; end your turn after.", inputSchema: { storage: which, path: z.string() } },
      safe(async ({ storage, path: p }) => asked(await client.storageChange(storage, "delete", p))),
    );
  }

  return server;
}

type Safe = <A>(fn: (a: A) => Promise<{ content: Content[] }>) => (a: A) => Promise<{ content: Content[] } & { isError?: boolean }>;

/**
 * Computer use: look at the screen and use the mouse and keyboard, like a person. Coordinates are
 * pixels in the latest screenshot; each action returns a fresh one so the agent sees what happened.
 */
function registerComputerTools(server: McpServer, client: WispClient, own: { name: string; kind: string }, safe: Safe) {
  // the screen's size, for scaling coordinates
  let space: { width: number; height: number } | null = null;
  const look = async (note: string, settleMs = 600): Promise<{ content: Content[] }> => {
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    const s = await client.computer<Screenshot>({ action: "screenshot" });
    space = { width: s.width, height: s.height };
    return { content: [{ type: "image", data: s.image, mimeType: s.mime }, { type: "text", text: `${note}${note ? " " : ""}Screen is ${s.width}x${s.height}; coordinates are pixels in this image.` }] };
  };
  const at = async () => {
    if (!space) await look("", 0);
    return space!;
  };
  const after = (shot: boolean | undefined, note: string, settleMs?: number) => (shot === false ? text(note) : look(note, settleMs));
  const xy = { x: z.number().describe("pixels from the left of the latest screenshot"), y: z.number().describe("pixels from the top") };
  const shot = z.boolean().optional().describe("return a screenshot afterwards (default true)");

  server.registerTool(
    "computer_screenshot",
    { description: `See the screen of your computer "${own.name}".`, inputSchema: {} },
    safe(async () => look("", 0)),
  );
  server.registerTool(
    "computer_click",
    { description: "Click at a point on the screen.", inputSchema: { ...xy, button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional(), screenshot: shot } },
    safe(async ({ x, y, button, double, screenshot }) => {
      await client.computer({ action: "click", x, y, button, double, space: await at() });
      return after(screenshot, `Clicked (${x}, ${y}).`);
    }),
  );
  server.registerTool(
    "computer_type",
    { description: "Type text where the keyboard focus is (click the field first). Set enter to press Enter after.", inputSchema: { text: z.string(), enter: z.boolean().optional(), screenshot: shot } },
    safe(async ({ text: t, enter, screenshot }) => {
      await client.computer({ action: "type", text: t });
      if (enter) await client.computer({ action: "key", keys: "Enter" });
      return after(screenshot, `Typed ${t.length} characters${enter ? " and pressed Enter" : ""}.`);
    }),
  );
  server.registerTool(
    "computer_key",
    { description: "Press a key or shortcut, e.g. 'Enter', 'Escape', 'Tab', 'ctrl+l', 'cmd+t' (Mac), 'ctrl+shift+t', 'PageDown'.", inputSchema: { keys: z.string(), screenshot: shot } },
    safe(async ({ keys, screenshot }) => {
      await client.computer({ action: "key", keys });
      return after(screenshot, `Pressed ${keys}.`);
    }),
  );
  server.registerTool(
    "computer_scroll",
    { description: "Scroll at a point (the mouse moves there first).", inputSchema: { ...xy, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(30).optional().describe("wheel clicks, default 3"), screenshot: shot } },
    safe(async ({ x, y, direction, amount, screenshot }) => {
      await client.computer({ action: "scroll", x, y, direction, amount, space: await at() });
      return after(screenshot, `Scrolled ${direction}.`, 400);
    }),
  );
  server.registerTool(
    "computer_drag",
    { description: "Press at one point, drag to another, and release.", inputSchema: { ...xy, to_x: z.number(), to_y: z.number(), screenshot: shot } },
    safe(async ({ x, y, to_x, to_y, screenshot }) => {
      await client.computer({ action: "drag", x, y, toX: to_x, toY: to_y, space: await at() });
      return after(screenshot, `Dragged to (${to_x}, ${to_y}).`);
    }),
  );
  server.registerTool(
    "computer_move",
    { description: "Move the mouse without clicking (to hover).", inputSchema: { ...xy, screenshot: shot } },
    safe(async ({ x, y, screenshot }) => {
      await client.computer({ action: "move", x, y, space: await at() });
      return after(screenshot, `Moved to (${x}, ${y}).`, 400);
    }),
  );
  server.registerTool(
    "computer_open",
    { description: "Open a URL in the browser, or a file or app, the way double-clicking it would.", inputSchema: { target: z.string().describe("a URL, a path, or an app name"), screenshot: shot } },
    safe(async ({ target, screenshot }) => {
      await client.computer({ action: "open", target });
      return after(screenshot, `Opened ${target}.`, 2500);
    }),
  );
  server.registerTool(
    "computer_wait",
    { description: "Wait for something to load, then look again.", inputSchema: { seconds: z.number().min(0.5).max(30) } },
    safe(async ({ seconds }) => look(`Waited ${seconds}s.`, seconds * 1000)),
  );
  if (own.kind !== "device") {
    server.registerTool(
      "computer_run",
      { description: `Run a shell command on your computer "${own.name}" (bash) and get its output. Use it for files, installs and scripts; use the screen for apps and websites.`, inputSchema: { command: z.string(), timeout_s: z.number().int().min(1).max(600).optional() } },
      safe(async ({ command, timeout_s }) => {
        const r = await client.computer<{ exitCode: number; output: string }>({ action: "run", command, timeout: timeout_s });
        return text(`exit ${r.exitCode}\n${r.output || "(no output)"}`);
      }),
    );
  }
  if (own.kind === "vm") {
    server.registerTool(
      "login_fill",
      {
        description:
          "Sign in to a website in your computer's browser with a login from the person's password manager. Open the site's sign-in page first, then call this with the site. Wisp fills the boxes and presses sign in; the password isn't given to you, and don't try to read it from the page. The first time, the person may be asked: then end your turn and you'll get a message once they answer. If there's no saved login, use computer_ask_human instead. Never ask for passwords in chat.",
        inputSchema: {
          site: z.string().describe('the website, e.g. "zendesk.com"'),
          account: z.string().optional().describe("which account, when there's more than one login for the site"),
        },
      },
      safe(async ({ site, account }) => text((await client.fillLogin(site, account)).message)),
    );
  }
  server.registerTool(
    "computer_ask_human",
    {
      description:
        "Ask a person to do something on your own computer that you shouldn't or can't: sign in to a site, enter a 2FA code, solve a captcha, approve a prompt. Shows them the screen with your request. End your turn after calling it; you'll be woken when they hand the computer back.",
      inputSchema: { request: z.string().describe('what you need, e.g. "Sign in to Zendesk so I can work the support queue."') },
    },
    safe(async ({ request }) => {
      await client.computerHelp(request);
      return text("Asked. End your turn now; you'll get a message when they hand the computer back.");
    }),
  );
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
  return map[ext] ?? "application/octet-stream";
}

/** The hints after a save, in a few short lines ("" when there are none). */
export function saveHints(r: { similar?: { path: string; title: string }[]; linkable?: string[]; linked?: string[] } | null | undefined): string {
  const out: string[] = [];
  if (r?.linked?.length) out.push(`It linked to nothing, so Wisp added "Related: ${r.linked.join(", ")}". Change it if a better note fits.`);
  if (r?.similar?.length) out.push(`Similar notes (if it's the same idea, merge into one and delete the other):\n${r.similar.map((s) => `- ${s.path} (${s.title})`).join("\n")}`);
  if (r?.linkable?.length) out.push(`Mentions you could link: ${r.linkable.join(", ")}`);
  return out.length ? `\n${out.join("\n")}` : "";
}
