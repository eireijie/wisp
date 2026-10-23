import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { frontMatter, shortDescription, type CommandOption } from "@warren/core";

/**
 * Commands and skills a harness keeps in files on this device, for the "/" menu in chat.
 * Exported for tests, with the home folder as a parameter.
 */

/** Skills in `<dir>/<name>/SKILL.md`. */
export async function skillsIn(dir: string, opts: { prefix?: string; via: CommandOption["via"] }): Promise<CommandOption[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: CommandOption[] = [];
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    const text = await fs.readFile(path.join(dir, n, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    const fm = frontMatter(text);
    if (fm["user-invocable"] === "false") continue;
    out.push({ name: `${opts.prefix ?? ""}${fm.name || n}`, description: shortDescription(fm.description), kind: "skill", via: opts.via });
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

/** Claude Code's built-in commands that work when it runs headless, as Warren runs it. */
const CLAUDE_BUILTINS: CommandOption[] = [
  { name: "compact", description: "Shrink the conversation so it can keep going", hint: "what to keep", kind: "command", via: "raw" },
  { name: "review", description: "Review a pull request", kind: "command", via: "raw" },
  { name: "security-review", description: "Look for security problems in the changes on this branch", kind: "command", via: "raw" },
  { name: "init", description: "Write a CLAUDE.md that explains this codebase", kind: "command", via: "raw" },
  { name: "pr-comments", description: "Read the comments on a pull request", kind: "command", via: "raw" },
];

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
  return dedupe([...(await skillsIn(path.join(codexHome, "skills"), { via: "prompt" })), ...(await skillsIn(path.join(home, ".agents", "skills"), { via: "prompt" }))]);
}

function dedupe(list: CommandOption[]): CommandOption[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, 500);
}
