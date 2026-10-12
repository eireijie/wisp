import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredAgent } from "@warren/core";

/**
 * Agents that already live on this device: Hermes profiles, OpenClaw workspaces, Claude Code
 * subagents and OpenCode agents. People can bring them into Warren with their soul,
 * instructions and notes. The list carries only names and counts; contents are read when
 * someone imports one.
 */

interface Source {
  agent: DiscoveredAgent;
  read: () => DiscoveredAgent;
}

const MAX_FILE = 100_000;

function readText(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return undefined;
    const t = fs.readFileSync(file, "utf8");
    return t.length > MAX_FILE ? t.slice(0, MAX_FILE) + "\n…(truncated)" : t;
  } catch {
    return undefined;
  }
}

function dirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

function files(p: string, ext = ".md"): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(ext))
      .map((d) => path.join(p, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** YAML-ish frontmatter (flat key: value) and the body after it. Exported for tests. */
export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

const heading = (md: string | undefined) => md?.match(/^#\s+(.+)$/m)?.[1]?.trim();

function memoriesIn(list: string[]): { name: string; content: string }[] {
  return list
    .map((f) => ({ name: path.basename(f), content: readText(f) ?? "" }))
    .filter((m) => m.content.trim())
    .slice(0, 50);
}

/** Hermes' model setting, as its ACP model id ("provider:model"). Exported for tests. */
export function hermesModel(yaml: string): string | undefined {
  const inline = yaml.match(/^model:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/m)?.[1];
  if (inline) return inline;
  const block = yaml.match(/^model:[ \t]*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
  const get = (k: string) => block.match(new RegExp(`^[ \\t]+${k}:[ \\t]*["']?([^"'\\n#]+?)["']?[ \\t]*$`, "m"))?.[1];
  const name = get("default");
  if (!name) return undefined;
  const provider = get("provider");
  return provider ? `${provider}:${name}` : name;
}

function hermes(home: string): Source[] {
  const root = path.join(home, ".hermes");
  if (!fs.existsSync(root)) return [];
  const profiles = [{ name: "default", dir: root }, ...dirs(path.join(root, "profiles")).map((d) => ({ name: path.basename(d), dir: d }))];
  return profiles
    .filter((p) => fs.existsSync(path.join(p.dir, "SOUL.md")) || fs.existsSync(path.join(p.dir, "memories")))
    .map((p) => {
      const soulFile = path.join(p.dir, "SOUL.md");
      const memFiles = files(path.join(p.dir, "memories"));
      const model = hermesModel(readText(path.join(p.dir, "config.yaml")) ?? "");
      const agent: DiscoveredAgent = {
        key: `hermes:${p.name}`,
        harness: "hermes",
        name: heading(readText(soulFile)) ?? (p.name === "default" ? "Hermes" : `Hermes (${p.name})`),
        description: `Hermes profile "${p.name}"`,
        model,
        path: p.dir,
        hasSoul: fs.existsSync(soulFile),
        memoryCount: memFiles.length,
      };
      return { agent, read: () => ({ ...agent, soul: readText(soulFile), memories: memoriesIn(memFiles) }) };
    });
}

function openclaw(home: string): Source[] {
  const root = path.join(home, ".openclaw");
  if (!fs.existsSync(root)) return [];
  const workspaces = [...dirs(root).filter((d) => /^workspace/.test(path.basename(d))), ...dirs(path.join(root, "agents")).map((d) => path.join(d, "workspace"))].filter((d) =>
    ["SOUL.md", "AGENTS.md", "IDENTITY.md"].some((f) => fs.existsSync(path.join(d, f))),
  );
  return workspaces.map((ws) => {
    const identity = readText(path.join(ws, "IDENTITY.md"));
    const memFiles = [path.join(ws, "USER.md"), path.join(ws, "MEMORY.md"), ...files(path.join(ws, "memory"))].filter((f) => fs.existsSync(f));
    const name = identity?.match(/^\s*[-*]?\s*\**name\**\s*:\s*(.+)$/im)?.[1]?.replace(/\*/g, "").trim() ?? heading(identity) ?? "OpenClaw";
    const agent: DiscoveredAgent = {
      key: `openclaw:${path.relative(root, ws)}`,
      harness: "openclaw",
      name,
      description: `OpenClaw workspace ${path.relative(home, ws)}`,
      path: ws,
      hasSoul: fs.existsSync(path.join(ws, "SOUL.md")),
      memoryCount: memFiles.length,
    };
    return {
      agent,
      read: () => ({
        ...agent,
        soul: [readText(path.join(ws, "SOUL.md")), identity].filter(Boolean).join("\n\n") || undefined,
        instructions: readText(path.join(ws, "AGENTS.md")),
        memories: memoriesIn(memFiles),
      }),
    };
  });
}

/** Markdown agent definitions with frontmatter (Claude Code subagents, OpenCode agents). */
function definitions(dir: string, harness: string, label: string): Source[] {
  return files(dir).map((f) => {
    const { meta, body } = frontmatter(readText(f) ?? "");
    const name = meta.name || path.basename(f, ".md");
    const agent: DiscoveredAgent = {
      key: `${harness}:${name}`,
      harness,
      name,
      description: meta.description ? meta.description.slice(0, 2000) : `${label} agent`,
      model: meta.model && meta.model !== "inherit" ? meta.model : undefined,
      path: f,
      hasSoul: false,
      memoryCount: 0,
    };
    return { agent, read: () => ({ ...agent, instructions: body.trim() }) };
  });
}

/**
 * The harness you already use, as it's set up for you: its instructions file (CLAUDE.md,
 * AGENTS.md, GEMINI.md, .goosehints) and, for Claude Code, the memories it saved per project.
 */
function yourSetup(home: string): Source[] {
  const out: Source[] = [];
  const add = (harness: string, label: string, file: string, memFiles: { name: string; file: string }[], model?: string) => {
    const instructions = readText(file)?.trim();
    if (!instructions && !memFiles.length) return;
    const agent: DiscoveredAgent = {
      key: `${harness}:main`,
      harness,
      name: `${label} (your setup)`,
      description: [instructions ? `your ${path.basename(file)}` : "", memFiles.length ? `${memFiles.length} saved ${memFiles.length === 1 ? "memory" : "memories"}` : ""].filter(Boolean).join(" and "),
      model,
      path: path.dirname(file),
      hasSoul: false,
      memoryCount: memFiles.length,
    };
    out.push({
      agent,
      read: () => ({
        ...agent,
        instructions,
        memories: memFiles
          .map((m) => ({ name: m.name, content: readText(m.file) ?? "" }))
          .filter((m) => m.content.trim())
          .slice(0, 50),
      }),
    });
  };
  // Claude Code keeps memories per project: ~/.claude/projects/<project>/memory/*.md
  const claudeMem = dirs(path.join(home, ".claude", "projects")).flatMap((p) =>
    files(path.join(p, "memory")).map((f) => ({ name: `${path.basename(p).replace(/^-+/, "").slice(-40)}-${path.basename(f)}`, file: f })),
  );
  const claudeModel = (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).model;
      return typeof m === "string" ? m : undefined;
    } catch {
      return undefined;
    }
  })();
  add("claude-code", "Claude Code", path.join(home, ".claude", "CLAUDE.md"), claudeMem, claudeModel);
  const codexModel = readText(path.join(home, ".codex", "config.toml"))?.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  add("codex", "Codex", path.join(home, ".codex", "AGENTS.md"), [], codexModel);
  add("gemini", "Gemini CLI", path.join(home, ".gemini", "GEMINI.md"), []);
  add("goose", "Goose", path.join(home, ".config", "goose", ".goosehints"), []);
  return out;
}

function sources(home = os.homedir()): Source[] {
  return [
    ...yourSetup(home),
    ...hermes(home),
    ...openclaw(home),
    ...definitions(path.join(home, ".claude", "agents"), "claude-code", "Claude Code"),
    ...definitions(path.join(home, ".config", "opencode", "agent"), "opencode", "OpenCode"),
    ...definitions(path.join(home, ".config", "opencode", "agents"), "opencode", "OpenCode"),
  ];
}

/** What's on this device, without contents. */
export function discoverAgents(home?: string): DiscoveredAgent[] {
  try {
    return sources(home)
      .map((s) => s.agent)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** Everything about one of them, for an import. */
export function readDiscovered(key: string, home?: string): DiscoveredAgent | null {
  return sources(home).find((s) => s.agent.key === key)?.read() ?? null;
}
