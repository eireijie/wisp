import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changeHarnessSettings, codexArgs, editCodex, editHermes, parseToml, readHarnessSettings, readHarnessSkill } from "../src/index.ts";

const HERMES = `# Hermes settings
model:
  default: gpt-5.6-luna # what it uses
  provider: openai-codex
  base_url: ''
agent:
  max_turns: 500
  personalities:
    helpful: You are a helpful, friendly AI assistant.
skills:
  creation_nudge_interval: 15
platform_toolsets:
  cli:
    - hermes-cli
mcp_servers:
  github:
    command: npx
    args:
    - -y
    - '@modelcontextprotocol/server-github'
  notes:
    url: https://notes.example.com/mcp
    enabled: false
# trailing comment stays
`;

const CODEX = `# my codex
model = "gpt-6-astra"
model_reasoning_effort = "high" # keep
notify = ["/bin/notify", "turn-ended"]

[model_providers.ollama]
name = "Ollama"
base_url = "http://localhost:11434/v1"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"

[mcp_servers.files]
command = "npx"
args = [
  "-y",
  "files-mcp",
]
enabled = false

[plugins."github@openai-curated"]
enabled = true

[plugins."canva@openai-curated"]
enabled = true
`;

let home: string;
const write = (rel: string, text: string) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), "utf8");
const skill = (rel: string, name: string, description = "Does a thing") => write(path.join(rel, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nHow to ${name}.\n`);
const backups = (rel: string) => fs.readdirSync(path.dirname(path.join(home, rel))).filter((n) => n.startsWith(`${path.basename(rel)}.wisp-bak.`));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-harness-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("Hermes settings", () => {
  beforeEach(() => {
    write(".hermes/config.yaml", HERMES);
    write(".hermes/auth.json", JSON.stringify({ providers: { "openai-codex": { token: "secret" } }, credential_pool: { copilot: [] } }));
    write(".hermes/hermes-agent/plugins/disk-cleanup/plugin.yaml", "name: disk-cleanup\ndescription: Cleans up temp files\n");
    write(".hermes/hermes-agent/plugins/image_gen/plugin.yaml", "name: image_gen\nkind: backend\n");
    write(".hermes/plugins/homelab/plugin.yaml", "name: homelab\ndescription: Homelab ops\n");
    skill(".hermes/skills/github/github-issues", "github-issues");
    skill(".hermes/skills/research/arxiv", "arxiv");
  });

  it("reads model, provider, apps, plugins and skills", async () => {
    const s = await readHarnessSettings("hermes", { home });
    expect(s.error).toBeUndefined();
    expect(s.configPath).toBe(path.join(home, ".hermes", "config.yaml"));
    expect(s.model).toBe("gpt-5.6-luna");
    expect(s.provider).toBe("openai-codex");
    expect(s.providers!.filter((p) => p.signedIn).map((p) => p.id).sort()).toEqual(["copilot", "openai-codex"]);
    expect(s.providers!.some((p) => p.id === "openrouter" && !p.signedIn)).toBe(true);
    expect(s.apps).toEqual([
      { id: "github", name: "github", enabled: true, canToggle: true, detail: "npx -y @modelcontextprotocol/server-github" },
      { id: "notes", name: "notes", enabled: false, canToggle: true, detail: "https://notes.example.com/mcp" },
    ]);
    // backends aren't switched on and off
    expect(s.plugins.map((p) => [p.id, p.enabled])).toEqual([
      ["disk-cleanup", false],
      ["homelab", false],
    ]);
    expect(s.skills.map((k) => [k.id, k.enabled])).toEqual([
      ["github-issues", true],
      ["arxiv", true],
    ]);
    // no secrets from auth.json travel
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("changes only the lines that change, keeping comments, and backs the file up", async () => {
    const s = await changeHarnessSettings(
      "hermes",
      [
        { op: "model", model: "anthropic/claude-sonnet-5.5" },
        { op: "provider", provider: "openrouter" },
        { op: "toggle", kind: "plugin", id: "homelab", enabled: true },
        { op: "toggle", kind: "skill", id: "arxiv", enabled: false },
        { op: "toggle", kind: "app", id: "github", enabled: false },
        { op: "toggle", kind: "app", id: "notes", enabled: true },
      ],
      { home },
    );
    expect(s.model).toBe("anthropic/claude-sonnet-5.5");
    expect(s.provider).toBe("openrouter");
    expect(s.plugins.find((p) => p.id === "homelab")!.enabled).toBe(true);
    expect(s.skills.find((k) => k.id === "arxiv")!.enabled).toBe(false);
    expect(s.apps.map((a) => a.enabled)).toEqual([false, true]);
    const text = read(".hermes/config.yaml");
    expect(text).toContain("# Hermes settings\nmodel:\n  default: anthropic/claude-sonnet-5.5 # what it uses\n  provider: openrouter\n  base_url: ''\n");
    expect(text).toContain("skills:\n  creation_nudge_interval: 15\n  disabled:\n    - arxiv\n");
    expect(text).toContain("  notes:\n    url: https://notes.example.com/mcp\n    enabled: true\n");
    expect(text).toContain("plugins:\n  enabled:\n    - homelab\n");
    expect(text).not.toContain("disabled: []");
    expect(text).toContain("# trailing comment stays\n");
    expect(text).toContain("platform_toolsets:\n  cli:\n    - hermes-cli\n");
    expect(backups(".hermes/config.yaml")).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, ".hermes", backups(".hermes/config.yaml")[0]), "utf8")).toBe(HERMES);
  });

  it("turns a plugin off the way `hermes plugins disable` does", async () => {
    write(".hermes/config.yaml", `${HERMES}plugins:\n  enabled: [homelab, disk-cleanup]\n`);
    await changeHarnessSettings("hermes", [{ op: "toggle", kind: "plugin", id: "homelab", enabled: false }], { home });
    expect(read(".hermes/config.yaml")).toContain("plugins:\n  enabled:\n    - disk-cleanup\n  disabled:\n    - homelab\n");
  });

  it("splits Hermes's own provider:model picks into its two settings", async () => {
    const s = await changeHarnessSettings("hermes", [{ op: "model", model: "openai-codex:gpt-6-astra" }], { home });
    expect([s.provider, s.model]).toEqual(["openai-codex", "gpt-6-astra"]);
    // a colon that isn't after a provider is part of the name
    expect((await changeHarnessSettings("hermes", [{ op: "model", model: "llama3:8b" }], { home })).model).toBe("llama3:8b");
  });

  it("turns the old one-line model into the block form", () => {
    const out = editHermes("model: gpt-4o\nagent:\n  max_turns: 5\n", [{ op: "provider", provider: "openrouter" }]);
    expect(out).toBe("model:\n  default: gpt-4o\n  provider: openrouter\nagent:\n  max_turns: 5\n");
  });

  it("keeps the file when a change can't be made cleanly", async () => {
    write(".hermes/config.yaml", "model:\n  default:\n    nested: true\n");
    await expect(changeHarnessSettings("hermes", [{ op: "model", model: "gpt-5" }], { home })).rejects.toThrow(/single value/);
    expect(read(".hermes/config.yaml")).toBe("model:\n  default:\n    nested: true\n");
  });

  it("refuses names that could break out of a value, and things it doesn't have", async () => {
    await expect(changeHarnessSettings("hermes", [{ op: "model", model: "gpt-5\nevil: true" }], { home })).rejects.toThrow();
    await expect(changeHarnessSettings("hermes", [{ op: "toggle", kind: "skill", id: "nope", enabled: false }], { home })).rejects.toThrow(/no skill/);
    expect(read(".hermes/config.yaml")).toBe(HERMES);
    expect(backups(".hermes/config.yaml")).toHaveLength(0);
  });

  it("writes through a symlinked config to the file it points at", async () => {
    write("dotfiles/hermes.yaml", HERMES);
    fs.rmSync(path.join(home, ".hermes/config.yaml"));
    fs.symlinkSync(path.join(home, "dotfiles/hermes.yaml"), path.join(home, ".hermes/config.yaml"));
    await changeHarnessSettings("hermes", [{ op: "model", model: "gpt-5" }], { home });
    expect(fs.lstatSync(path.join(home, ".hermes/config.yaml")).isSymbolicLink()).toBe(true);
    expect(read("dotfiles/hermes.yaml")).toContain("default: gpt-5 # what it uses");
  });

  it("keeps only the newest three backups", async () => {
    for (const m of ["a1", "a2", "a3", "a4", "a5"]) {
      await changeHarnessSettings("hermes", [{ op: "model", model: m }], { home });
      // backups are stamped to the second
      await new Promise((r) => setTimeout(r, 1010));
    }
    expect(backups(".hermes/config.yaml")).toHaveLength(3);
  }, 15_000);

  it("shares a skill's file by its name", async () => {
    const f = await readHarnessSkill("hermes", "arxiv", { home });
    expect(f).toEqual({ name: "arxiv", description: "Does a thing", content: expect.stringContaining("How to arxiv.") });
    await expect(readHarnessSkill("hermes", "../../etc/passwd", { home })).rejects.toThrow(/no skill/);
  });

  it("says what went wrong when the config can't be read", async () => {
    write(".hermes/config.yaml", "model: [unclosed\n");
    const s = await readHarnessSettings("hermes", { home });
    expect(s.error).toMatch(/Couldn't read/);
  });
});

describe("Codex settings", () => {
  beforeEach(() => {
    write(".codex/config.toml", CODEX);
    skill(".codex/skills/review-pr", "review-pr");
    skill(".agents/skills/deploy", "deploy");
  });

  it("reads the parts Wisp shows", async () => {
    const s = await readHarnessSettings("codex", { home });
    expect(s.error).toBeUndefined();
    expect(s.model).toBe("gpt-6-astra");
    expect(s.provider).toBe("openai");
    expect(s.providers!.map((p) => p.id)).toEqual(["openai", "ollama"]);
    expect(s.apps).toEqual([
      { id: "linear", name: "linear", enabled: true, canToggle: true, detail: "https://mcp.linear.app/mcp" },
      { id: "files", name: "files", enabled: false, canToggle: true, detail: "npx -y files-mcp" },
    ]);
    expect(s.plugins.map((p) => [p.id, p.name, p.enabled])).toEqual([
      ["github@openai-curated", "github", true],
      ["canva@openai-curated", "canva", true],
    ]);
    expect(s.skills.map((k) => [k.id, k.enabled])).toEqual([
      ["review-pr", true],
      ["deploy", true],
    ]);
  });

  it("lets a ChatGPT login with no config.toml pick a model, and the run passes it to codex", async () => {
    fs.rmSync(path.join(home, ".codex/config.toml"));
    write(".codex/auth.json", "{}");
    const s = await readHarnessSettings("codex", { home });
    expect(s.error).toBeUndefined();
    expect(s.model).toBeNull();
    const after = await changeHarnessSettings("codex", [{ op: "model", model: "gpt-6.1-sol" }], { home });
    expect(after.model).toBe("gpt-6.1-sol");
    expect(read(".codex/config.toml")).toContain('model = "gpt-6.1-sol"');
    expect(codexArgs({ prompt: "", cwd: "/", model: "gpt-6.1-sol", effort: "high", fast: true } as any)).toEqual(
      expect.arrayContaining(["-m", "gpt-6.1-sol", 'model_reasoning_effort="high"', 'service_tier="priority"']),
    );
  });

  it("changes the model in a config Codex's app wrote (service tier, notify array, project tables)", async () => {
    write(
      ".codex/config.toml",
      'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\nnotify = ["node", "hook.js", "turn-ended"]\nservice_tier = "priority"\n\n[marketplaces.openai-bundled]\nsource_type = "local"\n\n[plugins."github@openai-curated"]\nenabled = true\n\n[projects."/Users/me/Documents/My project"]\ntrust_level = "trusted"\n',
    );
    const s = await readHarnessSettings("codex", { home });
    expect(s.error).toBeUndefined();
    expect(s.fixed).toBeUndefined();
    expect(s.model).toBe("gpt-6-astra");
    const after = await changeHarnessSettings("codex", [{ op: "model", model: "gpt-6.1-sol" }], { home });
    expect(after.model).toBe("gpt-6.1-sol");
    expect(read(".codex/config.toml")).toContain('notify = ["node", "hook.js", "turn-ended"]');
  });

  it("edits values in place and adds what's missing", async () => {
    const s = await changeHarnessSettings(
      "codex",
      [
        { op: "model", model: "gpt-5" },
        { op: "provider", provider: "ollama" },
        { op: "toggle", kind: "app", id: "linear", enabled: false },
        { op: "toggle", kind: "plugin", id: "canva@openai-curated", enabled: false },
        { op: "toggle", kind: "skill", id: "deploy", enabled: false },
      ],
      { home },
    );
    expect([s.model, s.provider]).toEqual(["gpt-5", "ollama"]);
    expect(s.apps.find((a) => a.id === "linear")!.enabled).toBe(false);
    expect(s.plugins.find((p) => p.id === "canva@openai-curated")!.enabled).toBe(false);
    expect(s.skills.find((k) => k.id === "deploy")!.enabled).toBe(false);
    const text = read(".codex/config.toml");
    expect(text.startsWith('# my codex\nmodel_provider = "ollama"\nmodel = "gpt-5"\nmodel_reasoning_effort = "high" # keep\n')).toBe(true);
    expect(text).toContain('[mcp_servers.linear]\nenabled = false\nurl = "https://mcp.linear.app/mcp"\n');
    expect(text).toContain('[plugins."canva@openai-curated"]\nenabled = false\n');
    expect(text).toContain('args = [\n  "-y",\n  "files-mcp",\n]\n');
    expect(text.endsWith('\n[[skills.config]]\nname = "deploy"\nenabled = false\n')).toBe(true);
    expect(backups(".codex/config.toml")).toHaveLength(1);

    // and back on: the same entry flips, no second one
    await changeHarnessSettings("codex", [{ op: "toggle", kind: "skill", id: "deploy", enabled: true }], { home });
    expect(read(".codex/config.toml").match(/\[\[skills\.config\]\]/g)).toHaveLength(1);
    expect((await readHarnessSettings("codex", { home })).skills.find((k) => k.id === "deploy")!.enabled).toBe(true);
  });

  it("reads dotted keys, quoted keys and arrays of tables", () => {
    const doc = parseToml('a.b = 1\n"x y" = \'lit\'\n[t]\nk = [1, "two", true] # c\n[[arr]]\nn = 1\n[[arr]]\nn = 2\n');
    expect(doc.entries.map((e) => [e.table.join("."), e.key, e.value, e.arrayIndex])).toEqual([
      ["a", "b", 1, 0],
      ["", "x y", "lit", 0],
      ["t", "k", [1, "two", true], 0],
      ["arr", "n", 1, 1],
      ["arr", "n", 2, 2],
    ]);
  });

  it("starts a table that isn't there yet", () => {
    expect(editCodex('model = "a"\n', [{ op: "toggle", kind: "app", id: "x", enabled: false }])).toBe('model = "a"\n\n[mcp_servers.x]\nenabled = false\n');
  });
});

describe("Claude Code settings", () => {
  beforeEach(() => {
    write(".claude/settings.json", JSON.stringify({ theme: "dark", enabledPlugins: { "agent-skills@addy": true, "old@market": false } }, null, 2) + "\n");
    write(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "agent-skills@addy": [{ installPath: path.join(home, "p1") }], "old@market": [{ installPath: path.join(home, "p2") }] } }));
    write("p1/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-skills", description: "Engineering skills" }));
    write(".claude.json", JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } }, oauthAccount: { token: "secret" } }));
    skill(".claude/skills/release-notes", "release-notes");
  });

  it("reads plugins, user MCP servers and skills", async () => {
    const s = await readHarnessSettings("claude-code", { home });
    expect(s.model).toBeNull();
    expect(s.providers).toBeNull();
    expect(s.plugins).toEqual([
      { id: "agent-skills@addy", name: "agent-skills", description: "Engineering skills", enabled: true, canToggle: true },
      { id: "old@market", name: "old", enabled: false, canToggle: true },
    ]);
    expect(s.apps).toEqual([{ id: "sentry", name: "sentry", enabled: true, canToggle: false, detail: "https://mcp.sentry.dev/mcp" }]);
    expect(s.skills).toEqual([{ id: "release-notes", name: "release-notes", description: "Does a thing", enabled: true, canToggle: true }]);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("changes settings.json and keeps everything else", async () => {
    await changeHarnessSettings(
      "claude-code",
      [
        { op: "model", model: "opus" },
        { op: "toggle", kind: "plugin", id: "old@market", enabled: true },
        { op: "toggle", kind: "skill", id: "release-notes", enabled: false },
      ],
      { home },
    );
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({ theme: "dark", enabledPlugins: { "agent-skills@addy": true, "old@market": true }, model: "opus", skillOverrides: { "release-notes": "off" } });
    await changeHarnessSettings("claude-code", [{ op: "toggle", kind: "skill", id: "release-notes", enabled: true }], { home });
    expect(JSON.parse(read(".claude/settings.json")).skillOverrides).toBeUndefined();
    await expect(changeHarnessSettings("claude-code", [{ op: "toggle", kind: "app", id: "sentry", enabled: false }], { home })).rejects.toThrow(/no off switch/);
    await expect(changeHarnessSettings("claude-code", [{ op: "provider", provider: "x" }], { home })).rejects.toThrow(/no provider/);
  });

  it("makes settings.json when there isn't one", async () => {
    fs.rmSync(path.join(home, ".claude/settings.json"));
    await changeHarnessSettings("claude-code", [{ op: "model", model: "sonnet" }], { home });
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({ model: "sonnet" });
  });
});
