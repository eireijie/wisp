import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { frontMatter, shortDescription, type CommandOption } from "@wisp/core";

/**
 * Commands and skills a harness keeps in files on this device, for the "/" menu in chat.
 * Exported for tests, with the home folder as a parameter.
 */

/** Skills in `<dir>/<name>/SKILL.md`; `builtIn` marks ones the harness ships. */
export async function skillsIn(dir: string, opts: { prefix?: string; via: CommandOption["via"]; builtIn?: boolean }): Promise<CommandOption[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: CommandOption[] = [];
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    const text = await fs.readFile(path.join(dir, n, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    const fm = frontMatter(text);
    if (fm["user-invocable"] === "false") continue;
    out.push({ name: `${opts.prefix ?? ""}${fm.name || n}`, description: shortDescription(fm.description), kind: "skill", via: opts.via, ...(opts.builtIn ? { builtIn: true } : {}) });
  }
  return out;
}

/** Custom commands: `<dir>/<name>.md`, and `<dir>/<folder>/<name>.md` as `folder:name`. */
export async function commandsIn(dir: string, prefix = ""): Promise<CommandOption[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: CommandOption[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) out.push(...(await commandsIn(path.join(dir, e.name), `${prefix}${e.name}:`)));
    else if (e.name.endsWith(".md")) {
      const fm = frontMatter(await fs.readFile(path.join(dir, e.name), "utf8").catch(() => ""));
      out.push({ name: `${prefix}${e.name.slice(0, -3)}`, description: shortDescription(fm.description), hint: fm["argument-hint"] || undefined, kind: "command", via: "raw" });
    }
  }
  return out;
}

/** Claude Code's built-in commands that work when it runs headless, as Wisp runs it. */
export const CLAUDE_BUILTINS: CommandOption[] = [
  { name: "compact", description: "Shrink the conversation so it can keep going", hint: "what to keep", kind: "command", via: "raw", builtIn: true },
  { name: "review", description: "Review a pull request", kind: "command", via: "raw", builtIn: true },
  { name: "security-review", description: "Look for security problems in the changes on this branch", kind: "command", via: "raw", builtIn: true },
  { name: "init", description: "Write a CLAUDE.md that explains this codebase", kind: "command", via: "raw", builtIn: true },
  { name: "pr-comments", description: "Read the comments on a pull request", kind: "command", via: "raw", builtIn: true },
];

/** Claude Code commands Wisp leaves out of "/": Wisp has its own, or they only work in its terminal. */
const CLAUDE_SKIP = new Set([
  "clear", "color", "config", "fast", "focus", "heapdump", "rename", "output-style", "doctor", "reload-plugins", "reload-skills", "agents", "mcp", "import",
  "auto-mode-setup", "autocompact", "design-consent", "design-revoke", "list-agents", "team-onboarding", "workflow-launch-exec", "model", "effort", "context",
  "usage", "advisor", "goal", "insights", "recap", "skill-doctor",
]);

/** What well-known Claude Code commands do, for the ones its start-up list names without saying. */
const CLAUDE_DESCRIPTIONS: Record<string, string> = {
  compact: "Summarize this chat to free up space",
  review: "Review the changes on this branch",
  "security-review": "Look for security problems in the changes",
  init: "Write a CLAUDE.md for this project",
  "pr-comments": "Read the comments on a pull request",
  simplify: "Tidy up the changed code without changing what it does",
  "code-review": "Look for bugs in the changes",
  debug: "Find out why something is broken",
  verify: "Check that a change actually works",
  batch: "Make the same change across many files",
  loop: "Run a prompt again on an interval",
  run: "Start the app and see a change working",
  "deep-research": "Research a question across many sources",
  cost: "See what this session has cost",
  memory: "Edit what Claude Code remembers",
  "release-notes": "See what's new in Claude Code",
};

/**
 * Claude Code's "/" list from the first line of a run (stream-json `system`/`init`): every command
 * and skill the session can run. Entries on disk (`known`, from claudeCommands) keep their
 * descriptions; other commands are the harness's own (`builtIn`). Exported for tests.
 */
export function claudeInitCommands(init: { slash_commands?: unknown; skills?: unknown; terminal_slash_commands?: unknown }, known: CommandOption[] = []): CommandOption[] | null {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().replace(/^\//, "")) : []);
  if (!Array.isArray(init.slash_commands) && !Array.isArray(init.skills)) return null;
  const skills = new Set(names(init.skills));
  const terminal = new Set(names(init.terminal_slash_commands));
  const byName = new Map(known.map((c) => [c.name, c]));
  const out: CommandOption[] = [];
  for (const name of new Set([...names(init.slash_commands), ...skills])) {
    if (terminal.has(name) || name.startsWith("_") || CLAUDE_SKIP.has(name)) continue;
    const disk = byName.get(name);
    const description = disk?.description ?? CLAUDE_DESCRIPTIONS[name];
    const kind = skills.has(name) ? "skill" : "command";
    out.push({ name, ...(description ? { description } : {}), ...(disk?.hint ? { hint: disk.hint } : {}), kind, via: "raw", ...(kind === "command" && (!disk || disk.builtIn) ? { builtIn: true } : {}) });
  }
  return dedupe(out);
}

/** Claude Code: its built-ins, the person's commands and skills, and those of their enabled plugins (as `plugin:name`). */
export async function claudeCommands(home = os.homedir()): Promise<CommandOption[]> {
  const base = path.join(home, ".claude");
  const out = [...CLAUDE_BUILTINS, ...(await commandsIn(path.join(base, "commands"))), ...(await skillsIn(path.join(base, "skills"), { via: "raw" }))];
  const readJson = (f: string) => fs.readFile(f, "utf8").then((t) => JSON.parse(t), () => ({}));
  const [installed, settings] = await Promise.all([readJson(path.join(base, "plugins", "installed_plugins.json")), readJson(path.join(base, "settings.json"))]);
  const enabled: Record<string, boolean> = settings?.enabledPlugins ?? {};
  for (const [id, entry] of Object.entries<any>(installed?.plugins ?? {})) {
    if (enabled[id] === false) continue;
    // version 2 keeps a list per plugin (one per scope); version 1 kept one
    const installPath: string | undefined = (Array.isArray(entry) ? entry[0] : entry)?.installPath;
    if (!installPath) continue;
    const plugin = id.split("@")[0];
    out.push(...(await commandsIn(path.join(installPath, "commands"), `${plugin}:`)), ...(await skillsIn(path.join(installPath, "skills"), { prefix: `${plugin}:`, via: "raw" })));
  }
  return dedupe(out);
}

/** Codex can't run skills by name in `codex exec`, so asking for one becomes a request to use it. */
export async function codexCommands(codexHome: string, home = os.homedir()): Promise<CommandOption[]> {
  return dedupe([
    ...(await skillsIn(path.join(codexHome, "skills"), { via: "prompt" })),
    ...(await skillsIn(path.join(home, ".agents", "skills"), { via: "prompt" })),
    // the skills Codex ships (skill-creator, skill-installer…) live in a dot-folder
    ...(await skillsIn(path.join(codexHome, "skills", ".system"), { via: "prompt", builtIn: true })),
  ]);
}

function dedupe(list: CommandOption[]): CommandOption[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, 500);
}
