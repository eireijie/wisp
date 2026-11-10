import type { CommandOption } from "./types.ts";

/**
 * "/" commands in chat. Each agent offers its harness's own commands and skills (reported by its
 * device in the harness catalog), the Wisp skills it has, and a few Wisp answers itself.
 */

/** Commands Wisp answers itself, for every agent, without waking it. */
export const WISP_COMMANDS: { name: string; description: string }[] = [
  { name: "context", description: "See how full this conversation is" },
  { name: "compact", description: "Shrink this conversation so it can keep going" },
  { name: "new", description: "Start a fresh conversation" },
  { name: "stop", description: "Stop what it's working on" },
  { name: "model", description: "See or change the model, like /model gpt-6.1-sol (or /model default)" },
  { name: "effort", description: "See or change how hard it thinks, like /effort high (or /effort default)" },
  { name: "harness", description: "See or change the harness it runs in, like /harness codex" },
];

/**
 * How /compact runs in a harness. Claude Code and Hermes compact their own session when sent their
 * command headless; `codex exec` and the rest have no commands, so Wisp asks for a summary and
 * carries it into a new conversation.
 */
export function compactPlan(harness: string): { via: "native"; command: string } | { via: "summary" } {
  if (harness === "claude-code") return { via: "native", command: "compact" };
  if (harness === "hermes") return { via: "native", command: "compress" };
  return { via: "summary" };
}

/** What a harness without its own /compact is asked, so its answer can start the next conversation. */
export const SUMMARY_REQUEST =
  "Write a summary of this conversation so far, so that you could carry on from it in a fresh conversation: what we are doing, what was decided, the names of files and things that matter, and what is left to do. Plain text, under 300 words, no greeting.";

/** Hermes' "Context compressed: 4 -> 4 messages\n~15,322 -> ~15,322 tokens" as one plain line. */
export function plainCompact(text: string): string | null {
  const m = /~?([\d,]+)\s*->\s*~?([\d,]+)\s*tokens/i.exec(text);
  if (!m) return null;
  const k = (n: string) => {
    const v = Number(n.replace(/,/g, ""));
    return v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v);
  };
  if (Number(m[2].replace(/,/g, "")) >= Number(m[1].replace(/,/g, ""))) return `Nothing to shrink yet (${k(m[1])} tokens).`;
  return `Compacted: ${k(m[1])} → ${k(m[2])} tokens`;
}

/** A message that is just "/new" (after any @mentions): it starts a new chat. */
export function startsNewChat(body: string): boolean {
  return /^(?:@[\w.-]+\s+)*\/new\s*$/i.test(body.trim());
}

/** One entry in the "/" menu: where it comes from decides how it runs. */
export interface AgentCommand {
  name: string;
  description?: string;
  hint?: string;
  /** "wisp": answered by Wisp; "command"/"skill": the harness's own; "wisp-skill": a skill installed through Wisp */
  kind: "wisp" | "command" | "skill" | "wisp-skill";
  via: "wisp" | "raw" | "prompt";
  /** the menu's section: skills agents learned, the harness's own, Wisp's commands, other Wisp skills */
  group: "learned" | "harness" | "wisp" | "skill";
  /** learned in the last 7 days: the menu shows "new" */
  isNew?: boolean;
  /** for "learned": who learned it, e.g. "Ghosty" */
  learnedBy?: string;
}

/** A Wisp skill as the "/" menu needs it; `learnedBy` (the agent's name) marks one an agent learned. */
export interface CommandSkill {
  slug: string;
  description: string;
  learnedBy?: string;
  /** when it was learned (ISO), for the "new" tag */
  createdAt?: string;
}

const NEW_FOR_MS = 7 * 24 * 3600_000;

/**
 * Everything an agent offers after "/", in the menu's order: skills agents learned, the harness's
 * own, Wisp's commands, then other Wisp skills. Wisp's commands keep their names; a learned skill
 * wins over a same-named harness entry (it's the agent's own way), and a harness entry over a Wisp skill.
 */
export function agentCommands(harness: CommandOption[] | undefined, wispSkills: CommandSkill[], now = Date.now()): AgentCommand[] {
  const taken = new Set(WISP_COMMANDS.map((c) => c.name));
  const learned: AgentCommand[] = [];
  for (const s of wispSkills) {
    if (s.learnedBy === undefined || taken.has(s.slug)) continue;
    taken.add(s.slug);
    const isNew = !!s.createdAt && now - Date.parse(s.createdAt) < NEW_FOR_MS;
    learned.push({ name: s.slug, description: s.description, kind: "wisp-skill", via: "prompt", group: "learned", learnedBy: s.learnedBy, ...(isNew ? { isNew } : {}) });
  }
  const own: AgentCommand[] = [];
  for (const c of harness ?? []) {
    if (taken.has(c.name)) continue;
    taken.add(c.name);
    const { builtIn: _b, ...rest } = c;
    own.push({ ...rest, group: "harness" });
  }
  const wisp: AgentCommand[] = WISP_COMMANDS.map((c) => ({ ...c, kind: "wisp", via: "wisp", group: "wisp" }));
  const skills: AgentCommand[] = [];
  for (const s of wispSkills) {
    if (s.learnedBy !== undefined || taken.has(s.slug)) continue;
    taken.add(s.slug);
    skills.push({ name: s.slug, description: s.description, kind: "wisp-skill", via: "prompt", group: "skill" });
  }
  return [...learned, ...own, ...wisp, ...skills];
}

/** "/name args" at the start of a message, after an optional @mention of the agent it's for. */
export function parseCommand(body: string, handle?: string): { name: string; args: string } | null {
  let s = body.trim();
  if (handle) s = s.replace(new RegExp(`^@${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])\\s*`, "i"), "");
  const m = /^\/(\w[\w:.-]*)(?:\s+([\s\S]*))?$/.exec(s);
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

/** What a harness receives for a command it can't run by name: a request to use that skill. */
export function skillRequest(name: string, args: string): string {
  return `Use your "${name}" skill${args ? ` for this: ${args}` : "."}`;
}

/** The top-level text values of a SKILL.md or command file's front matter (`name`, `description`…). */
export function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // a block (`|` or `>`): the indented lines under it
    if (/^[|>][+-]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      out[kv[1]] = block.join(v.startsWith("|") ? "\n" : " ").trim();
      continue;
    }
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

/** A description short enough for one line of the menu. */
export function shortDescription(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}
