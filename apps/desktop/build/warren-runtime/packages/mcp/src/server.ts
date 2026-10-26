import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WarrenClient } from "@warren/sdk";
import type { Screenshot } from "@warren/core";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/**
 * The Warren MCP server: gives any MCP-capable harness (Claude Code, Codex,
 * Kimi, Hermes, OpenClaw, ...) chat, task, memory-vault and file tools.
 */
export async function createWarrenMcp(client: WarrenClient) {
  const me = await client.me();
  if (me.kind !== "agent" || !me.agent) throw new Error("warren-mcp needs an agent token (or a node token with WARREN_AGENT)");
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
    { name: "warren", version: "0.0.1" },
    {
      instructions: `You are @${self.handle} in the Warren workspace "${me.workspace.name}". Use these tools to talk with people and other agents, delegate work, and keep long-term memory. Your private memory folder is "me/" (${myDir}/); "shared/" is visible to every agent, and people may give you access to other folders. Search memory before answering questions about past work, and write down durable facts, decisions and results. When you learn something lasting about a person (a preference, a plan, something they did, a small detail), save it with memory_remember. To hand a note to another agent, share it with memory_share.${startup ? `\n\n${startup}` : ""}`,
    },
  );

  // --- chat -------------------------------------------------------------------

  server.registerTool(
    "chat_send",
    {
      description: "Post a message to a Warren channel (by name, e.g. 'general'). @mention another agent's handle to wake it up.",
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
    { description: "Read recent messages from a channel, or a thread when thread_id is given.", inputSchema: { channel: z.string(), thread_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } },
    safe(async ({ channel, thread_id, limit }) => {
      const ch = await resolveChannel(channel);
      const [{ messages }, agents] = await Promise.all([client.messages(ch.id, { thread: thread_id, limit: limit ?? 30 }), client.agents()]);
      const names = new Map(agents.map((a) => [a.id, `@${a.handle}`]));
      return text(messages.map((m) => `[${m.id}] ${m.author.kind === "agent" ? names.get(m.author.id) : m.author.id === "system" ? "system" : "human"}: ${m.body}`).join("\n") || "(no messages)");
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
    safe(async () => json((await client.channels()).filter((c) => c.kind === "channel").map((c) => ({ name: c.name, topic: c.topic })))),
  );

  server.registerTool(
    "agents_list",
    { description: "List agents in the workspace with their harness, status and teams." },
    safe(async () => json((await client.agents()).map((a) => ({ handle: `@${a.handle}`, name: a.name, harness: a.harness, status: a.status, teams: a.groups })))),
  );

  server.registerTool(
    "teams_list",
    { description: "List teams: their lead, members and roles, who they report to, their channel and their memory folder." },
    safe(async () => {
      const [teams, agents] = await Promise.all([client.teams(), client.agents()]);
      const h = (id: string | null) => (id ? `@${agents.find((a) => a.id === id)?.handle ?? "?"}` : null);
      return json(teams.map((t) => ({ name: t.name, description: t.description, lead: h(t.leadId), reportsTo: h(t.reportsTo), memory: `${t.folder}/`, repo: t.repo, members: t.members.map((m) => ({ agent: h(m.agentId), role: m.role || null })) })));
    }),
  );

  // --- tasks ------------------------------------------------------------------

  server.registerTool(
    "task_delegate",
    {
      description:
        "Hand a piece of work to another agent (possibly on another computer). They get woken up, and you get a message back when they mark it done. Work you hand out while working on a task becomes a subtask of it (or name the parent with parent_task_id); if you're the lead, this is how you assign the pieces of a task to agents by their roles.",
      inputSchema: {
        to: z.string().describe('agent handle, e.g. @nova, or "team:<name>" for a team\'s lead'),
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
    "task_update",
    { description: "Update a task assigned to you. Mark it done (with the result) when finished, or failed with the reason. A task you split into subtasks isn't finished on its own: mark it done once its subtasks are in (results of subtasks come back to you with how many are done).", inputSchema: { task_id: z.string(), status: z.enum(["in_progress", "done", "failed"]), result: z.string().optional() } },
    safe(async ({ task_id, status, result }) => {
      await client.updateTask(task_id, status, result);
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
        team: z.string().optional().describe("team name; its channel and decisions folder are used"),
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
      description: "Create or overwrite a markdown note (Obsidian style: use [[wikilinks]] and #tags). Write to 'me/...' for private memory or 'shared/...' for everyone. Every write is versioned.",
      inputSchema: { path: z.string(), content: z.string(), message: z.string().optional().describe("short change description") },
    },
    safe(async ({ path: p, content, message }) => {
      await client.writeNote(vaultPath(p), content, message);
      return text(`Saved ${vaultPath(p)}.`);
    }),
  );

  server.registerTool(
    "memory_append",
    { description: "Append text to a note, creating it if needed. Good for logs and journals.", inputSchema: { path: z.string(), text: z.string() } },
    safe(async ({ path: p, text: t }) => {
      await client.appendNote(vaultPath(p), t);
      return text(`Appended to ${vaultPath(p)}.`);
    }),
  );

  server.registerTool(
    "memory_remember",
    {
      description:
        "Remember something about a person so every agent knows it later. kind: 'preference' (how they like things), 'plan' (something they intend to do; add due as YYYY-MM-DD if there is one), 'did' (something they did; goes in a dated journal), or 'detail' (a fact about them, their setup, people, tools). One fact per call, in plain words. Defaults to the person you're working with. If a similar memory exists you'll get it back: pass its path as replaces to update it, e.g. to mark a plan done with status 'done'. Never save passwords, keys or secrets.",
      inputSchema: {
        kind: z.enum(["preference", "plan", "did", "detail"]),
        text: z.string().optional().describe("the fact; optional only when replacing to change status/due/pinned"),
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
  // an agent set up without a computer (headless) can't borrow a screen either
  if (computer || !self.settings?.headless) {
    registerComputerTools(server, client, computer, safe);
    registerDeviceTools(server, client, safe);
  }

  // --- reaching the person, and coming back to things -------------------------------------------

  server.registerTool(
    "message_person",
    {
      description:
        "Write to the person you work for, first, in your DM with them: it reaches their phone. Use it when something needs them (a deadline, an email they missed, a reply that arrived, a finished task), not to say you checked. Keep it short and specific; do the work first (a draft, the answer) and include it. For anything you'd send, buy or delete for them, use approval_request instead.",
      inputSchema: { text: z.string(), file_ids: z.array(z.string()).optional() },
    },
    safe(async ({ text: t, file_ids }) => {
      await client.messagePerson(t, file_ids ?? []);
      return text("Sent.");
    }),
  );

  server.registerTool(
    "next_check",
    {
      description:
        "When you're working in the background: say when to look again (10 minutes to 24 hours) and why. Soon while something is moving (waiting on a reply, a deadline today); a few hours when it's calm. Call it at the end of every background check.",
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
      inputSchema: { at: z.string().optional(), in_minutes: z.number().optional(), note: z.string().describe("what to do then, written to your future self") },
    },
    safe(async ({ at, in_minutes, note }) => {
      const f = await client.setFollowup({ at, inMinutes: in_minutes, note });
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
    { description: "Cancel a follow-up that's no longer needed.", inputSchema: { followup_id: z.string() } },
    safe(async ({ followup_id }) => {
      await client.cancelFollowup(followup_id);
      return text("Cancelled.");
    }),
  );

  // --- approvals & routines ---------------------------------------------------------

  server.registerTool(
    "approval_request",
    {
      description:
        "Ask a person's OK before doing something sensitive or hard to undo (sending an email or message outside Warren, buying something, deleting things, posting publicly). Posts an Approve / Deny card where you're working. End your turn after calling it: you'll be woken with the answer.",
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

  // --- files ------------------------------------------------------------------

  server.registerTool(
    "file_view",
    { description: "Look at a Warren file by id: images are shown to you (e.g. screenshots from a recording), text files are returned as text.", inputSchema: { file_id: z.string() } },
    safe(async ({ file_id }) => {
      const f = await client.downloadFile(file_id);
      if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) return { content: [{ type: "image" as const, data: Buffer.from(f.data).toString("base64"), mimeType: f.mime }, { type: "text" as const, text: f.name }] };
      if (/^text\/|json|xml|csv|markdown/.test(f.mime)) return text(Buffer.from(f.data).toString("utf8").slice(0, 50_000));
      return text(`${f.name} is ${f.mime} (${f.data.length} bytes); use file_download to save it.`);
    }),
  );

  server.registerTool(
    "file_upload",
    { description: "Upload a local file to Warren so other agents and people can get it. Returns a file id to attach to messages or tasks.", inputSchema: { local_path: z.string(), channel: z.string().optional() } },
    safe(async ({ local_path, channel }) => {
      const data = await fs.readFile(local_path);
      const ch = channel ? await resolveChannel(channel) : undefined;
      const f = await client.uploadFile(path.basename(local_path), data, guessMime(local_path), ch?.id);
      return text(`Uploaded ${f.name} as ${f.id} (${f.size} bytes).`);
    }),
  );

  server.registerTool(
    "file_download",
    { description: "Download a Warren file by id into a local directory.", inputSchema: { file_id: z.string(), dest_dir: z.string().optional() } },
    safe(async ({ file_id, dest_dir }) => {
      const f = await client.downloadFile(file_id);
      const dir = dest_dir ?? process.cwd();
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(f.name));
      await fs.writeFile(dest, f.data);
      return text(`Saved to ${dest}.`);
    }),
  );

  return server;
}

type Safe = <A>(fn: (a: A) => Promise<{ content: Content[] }>) => (a: A) => Promise<{ content: Content[] } & { isError?: boolean }>;

/**
 * Computer use: look at the screen and use the mouse and keyboard, like a person. Coordinates are
 * pixels in the latest screenshot; each action returns a fresh one so the agent sees what happened.
 *
 * Every tool acts on the agent's own computer unless `computer` names a device it is borrowing
 * (see device_request), so borrowing never changes what the tools do by default.
 */
function registerComputerTools(server: McpServer, client: WarrenClient, own: { name: string; kind: string } | null, safe: Safe) {
  // each screen has its own size, so remember it per target
  const spaces = new Map<string, { width: number; height: number }>();
  const look = async (device: string | undefined, note: string, settleMs = 600): Promise<{ content: Content[] }> => {
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    const s = await client.computer<Screenshot>({ action: "screenshot" }, device);
    spaces.set(device ?? "", { width: s.width, height: s.height });
    return { content: [{ type: "image", data: s.image, mimeType: s.mime }, { type: "text", text: `${device ? `[${device}] ` : ""}${note}${note ? " " : ""}Screen is ${s.width}x${s.height}; coordinates are pixels in this image.` }] };
  };
  const at = async (device: string | undefined) => {
    if (!spaces.has(device ?? "")) await look(device, "", 0);
    return spaces.get(device ?? "")!;
  };
  const after = (device: string | undefined, shot: boolean | undefined, note: string, settleMs?: number) => (shot === false ? text(note) : look(device, note, settleMs));
  const xy = { x: z.number().describe("pixels from the left of the latest screenshot"), y: z.number().describe("pixels from the top") };
  const shot = z.boolean().optional().describe("return a screenshot afterwards (default true)");
  const on = {
    computer: z
      .string()
      .optional()
      .describe(own ? `leave out to act on your own computer "${own.name}"; or the name of a device you're borrowing (device_request)` : "the name of the device you're borrowing (device_request); you have no computer of your own"),
  };
  const mine = own ? `your computer "${own.name}"` : "a device you're borrowing";

  server.registerTool(
    "computer_screenshot",
    { description: `See the screen of ${mine}. By default that's your own computer; pass \`computer\` to look at a device you're borrowing.`, inputSchema: { ...on } },
    safe(async ({ computer }) => look(computer, "", 0)),
  );
  server.registerTool(
    "computer_click",
    { description: "Click at a point on the screen.", inputSchema: { ...xy, button: z.enum(["left", "right", "middle"]).optional(), double: z.boolean().optional(), screenshot: shot, ...on } },
    safe(async ({ x, y, button, double, screenshot, computer }) => {
      await client.computer({ action: "click", x, y, button, double, space: await at(computer) }, computer);
      return after(computer, screenshot, `Clicked (${x}, ${y}).`);
    }),
  );
  server.registerTool(
    "computer_type",
    { description: "Type text where the keyboard focus is (click the field first). Set enter to press Enter after.", inputSchema: { text: z.string(), enter: z.boolean().optional(), screenshot: shot, ...on } },
    safe(async ({ text: t, enter, screenshot, computer }) => {
      await client.computer({ action: "type", text: t }, computer);
      if (enter) await client.computer({ action: "key", keys: "Enter" }, computer);
      return after(computer, screenshot, `Typed ${t.length} characters${enter ? " and pressed Enter" : ""}.`);
    }),
  );
  server.registerTool(
    "computer_key",
    { description: "Press a key or shortcut, e.g. 'Enter', 'Escape', 'Tab', 'ctrl+l', 'cmd+t' (Mac), 'ctrl+shift+t', 'PageDown'.", inputSchema: { keys: z.string(), screenshot: shot, ...on } },
    safe(async ({ keys, screenshot, computer }) => {
      await client.computer({ action: "key", keys }, computer);
      return after(computer, screenshot, `Pressed ${keys}.`);
    }),
  );
  server.registerTool(
    "computer_scroll",
    { description: "Scroll at a point (the mouse moves there first).", inputSchema: { ...xy, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(30).optional().describe("wheel clicks, default 3"), screenshot: shot, ...on } },
    safe(async ({ x, y, direction, amount, screenshot, computer }) => {
      await client.computer({ action: "scroll", x, y, direction, amount, space: await at(computer) }, computer);
      return after(computer, screenshot, `Scrolled ${direction}.`, 400);
    }),
  );
  server.registerTool(
    "computer_drag",
    { description: "Press at one point, drag to another, and release.", inputSchema: { ...xy, to_x: z.number(), to_y: z.number(), screenshot: shot, ...on } },
    safe(async ({ x, y, to_x, to_y, screenshot, computer }) => {
      await client.computer({ action: "drag", x, y, toX: to_x, toY: to_y, space: await at(computer) }, computer);
      return after(computer, screenshot, `Dragged to (${to_x}, ${to_y}).`);
    }),
  );
  server.registerTool(
    "computer_move",
    { description: "Move the mouse without clicking (to hover).", inputSchema: { ...xy, screenshot: shot, ...on } },
    safe(async ({ x, y, screenshot, computer }) => {
      await client.computer({ action: "move", x, y, space: await at(computer) }, computer);
      return after(computer, screenshot, `Moved to (${x}, ${y}).`, 400);
    }),
  );
  server.registerTool(
    "computer_open",
    { description: "Open a URL in the browser, or a file or app, the way double-clicking it would.", inputSchema: { target: z.string().describe("a URL, a path, or an app name"), screenshot: shot, ...on } },
    safe(async ({ target, screenshot, computer }) => {
      await client.computer({ action: "open", target }, computer);
      return after(computer, screenshot, `Opened ${target}.`, 2500);
    }),
  );
  server.registerTool(
    "computer_wait",
    { description: "Wait for something to load, then look again.", inputSchema: { seconds: z.number().min(0.5).max(30), ...on } },
    safe(async ({ seconds, computer }) => look(computer, `Waited ${seconds}s.`, seconds * 1000)),
  );
  if (own && own.kind !== "device") {
    server.registerTool(
      "computer_run",
      { description: `Run a shell command on your computer "${own.name}" (bash) and get its output. Use it for files, installs and scripts; use the screen for apps and websites. Only works on your own computer: a borrowed device lends its screen, not a shell.`, inputSchema: { command: z.string(), timeout_s: z.number().int().min(1).max(600).optional() } },
      safe(async ({ command, timeout_s }) => {
        const r = await client.computer<{ exitCode: number; output: string }>({ action: "run", command, timeout: timeout_s });
        return text(`exit ${r.exitCode}\n${r.output || "(no output)"}`);
      }),
    );
  }
  if (own) {
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
}

/**
 * Borrowing a person's device mid-task: an agent works on its own computer and asks for a device's
 * screen only when the task needs something that lives there (an app that only exists on the shop PC).
 */
function registerDeviceTools(server: McpServer, client: WarrenClient, safe: Safe) {
  server.registerTool(
    "device_list",
    { description: "Devices belonging to people in the workspace whose screen you could ask to borrow with device_request, and whether each can be asked right now (a device whose screen is off has to be turned on by its owner at the device).", inputSchema: {} },
    safe(async () => {
      const list = await client.borrowableDevices();
      return text(list.map((d) => `"${d.name}" (${d.owner}'s): ${d.available ? "can be asked" : d.note}`).join("\n") || "No devices.");
    }),
  );
  server.registerTool(
    "device_request",
    {
      description:
        "Ask to use a person's own device for a while, when the task needs an app or file that only lives on it (say, the POS app on the shop PC). Use your own computer for everything else. Posts an Approve / Deny card to the device's owner, and only they can say yes; they pick how long you get. End your turn after calling it: you'll be woken with the answer. If it's yes, add computer: \"<device name>\" to the computer_* tools to act on the device (without it they still act on your own computer), and call device_return when you're done. The loan ends by itself when time runs out and the owner can take it back at any time; you'll be told. A device whose screen is off can't be asked: its owner has to turn it on at the device.",
      inputSchema: { device: z.string().describe('the device\'s name, e.g. "Shop PC" (see device_list)'), reason: z.string().describe('what you need it for, in a sentence the owner can judge: "Enter today\'s sales in the POS app"') },
    },
    safe(async ({ device, reason }) => {
      const r = await client.requestDevice(device, reason);
      return text(`Asked for ${r.deviceName}. End your turn now; you'll get a message with the answer.`);
    }),
  );
  server.registerTool(
    "device_return",
    { description: "Hand a borrowed device back when you're done with it, so its owner has it to themselves again. Say which if you're borrowing more than one.", inputSchema: { device: z.string().optional() } },
    safe(async ({ device }) => {
      const r = await client.returnDevice(device);
      return text(`Handed ${r.deviceName} back.`);
    }),
  );
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
  return map[ext] ?? "application/octet-stream";
}
