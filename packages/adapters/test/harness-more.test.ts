import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessAccounts, changeHarnessSettings, loginCommand, readHarnessSettings, readHarnessSkill } from "../src/index.ts";
import { parseJsonc } from "../src/harness-formats.ts";

let home: string;
const write = (rel: string, text: string) => {
  const f = path.join(home, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel));
const skill = (rel: string, name: string) => write(path.join(rel, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\n---\nSteps.\n`);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "warren-more-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("Gemini CLI", () => {
  beforeEach(() => {
    write(".gemini/settings.json", JSON.stringify({ model: { name: "gemini-3-pro" }, mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] }, docs: { httpUrl: "https://docs.example.com/mcp" } }, ui: { theme: "dark" } }, null, 2));
    write(".gemini/extensions/maps/gemini-extension.json", JSON.stringify({ name: "maps", description: "Maps" }));
    skill(".gemini/skills/review", "review");
  });

  it("reads and changes model, apps and skills", async () => {
    const s = await readHarnessSettings("gemini", { home });
    expect(s).toMatchObject({ model: "gemini-3-pro", providers: null, plugins: [{ id: "maps", enabled: true, canToggle: false }], skills: [{ id: "review", enabled: true }] });
    expect(s.apps.map((a) => [a.id, a.enabled, a.detail])).toEqual([
      ["github", true, "npx -y gh-mcp"],
      ["docs", true, "https://docs.example.com/mcp"],
    ]);
    await changeHarnessSettings("gemini", [{ op: "model", model: "gemini-3-flash" }, { op: "toggle", kind: "app", id: "docs", enabled: false }, { op: "toggle", kind: "skill", id: "review", enabled: false }], { home });
    expect(json(".gemini/settings.json")).toMatchObject({ model: { name: "gemini-3-flash" }, mcp: { excluded: ["docs"] }, skills: { disabled: ["review"] }, ui: { theme: "dark" } });
    await changeHarnessSettings("gemini", [{ op: "toggle", kind: "app", id: "docs", enabled: true }], { home });
    expect(json(".gemini/settings.json").mcp).toEqual({});
  });
});

describe("Qwen Code", () => {
  it("makes settings.json when there isn't one", async () => {
    await changeHarnessSettings("qwen", [{ op: "model", model: "qwen3-coder-plus" }], { home });
    expect(json(".qwen/settings.json")).toEqual({ model: { name: "qwen3-coder-plus" } });
  });
});

describe("OpenCode", () => {
  it("reads opencode.jsonc with comments, and leaves it alone", async () => {
    write(".config/opencode/opencode.jsonc", `{\n  // mine\n  "model": "anthropic/claude-sonnet-5.5",\n  "mcp": { "jira": { "type": "remote", "url": "https://jira.example.com/mcp", "enabled": false }, },\n  "plugin": ["opencode-wakatime"],\n}\n`);
    const s = await readHarnessSettings("opencode", { home });
    expect(s).toMatchObject({ model: "anthropic/claude-sonnet-5.5", fixed: ["file"], apps: [{ id: "jira", enabled: false, canToggle: false }], plugins: [{ id: "opencode-wakatime", canToggle: false }] });
    await expect(changeHarnessSettings("opencode", [{ op: "model", model: "openai/gpt-5" }], { home })).rejects.toThrow(/comments/);
  });

  it("changes plain opencode.json", async () => {
    write(".config/opencode/opencode.json", JSON.stringify({ model: "a/b", mcp: { jira: { type: "remote", url: "u" } } }));
    skill(".agents/skills/deploy", "deploy");
    await changeHarnessSettings("opencode", [{ op: "model", model: "openai/gpt-5" }, { op: "toggle", kind: "app", id: "jira", enabled: false }, { op: "toggle", kind: "skill", id: "deploy", enabled: false }], { home });
    expect(json(".config/opencode/opencode.json")).toEqual({ model: "openai/gpt-5", mcp: { jira: { type: "remote", url: "u", enabled: false } }, permission: { skill: { deploy: "deny" } } });
    expect((await readHarnessSettings("opencode", { home })).skills).toEqual([expect.objectContaining({ id: "deploy", enabled: false })]);
  });
});

describe("Goose", () => {
  it("uses providers.<active>.model, and extensions' enabled", async () => {
    write(".config/goose/config.yaml", "# goose\nactive_provider: anthropic\nproviders:\n  anthropic:\n    enabled: true\n    model: claude-sonnet-5.5\n    configured: true\n  openai:\n    model: gpt-5\nextensions:\n  developer:\n    type: builtin\n    enabled: true\n  github:\n    type: stdio\n    cmd: npx\n    args: [-y, gh-mcp]\n    enabled: true\n");
    const s = await readHarnessSettings("goose", { home });
    expect(s).toMatchObject({ model: "claude-sonnet-5.5", provider: "anthropic", apps: [{ id: "github", enabled: true, canToggle: true }] });
    expect(s.providers!.map((p) => [p.id, p.signedIn])).toEqual([
      ["anthropic", true],
      ["openai", false],
    ]);
    await changeHarnessSettings("goose", [{ op: "provider", provider: "openai" }, { op: "model", model: "gpt-6" }, { op: "toggle", kind: "app", id: "github", enabled: false }], { home });
    const text = read(".config/goose/config.yaml");
    expect(text).toContain("# goose\nactive_provider: openai\n");
    expect(text).toContain("  openai:\n    model: gpt-6\n");
    expect(text).toContain("    args: [-y, gh-mcp]\n    enabled: false\n");
  });

  it("uses the older flat keys when that's what the file has", async () => {
    write(".config/goose/config.yaml", "GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-4o\n");
    await changeHarnessSettings("goose", [{ op: "model", model: "gpt-5" }], { home });
    expect(read(".config/goose/config.yaml")).toBe("GOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-5\n");
  });
});

describe("Kimi CLI", () => {
  it("picks among the models its config has", async () => {
    write(".kimi/config.toml", 'default_model = "k2"\n\n[models.k2]\nprovider = "moonshot"\nmodel = "kimi-k2"\n\n[models.k3]\nprovider = "moonshot"\nmodel = "kimi-k3"\n');
    write(".kimi/mcp.json", JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } }));
    const s = await readHarnessSettings("kimi", { home });
    expect(s).toMatchObject({ model: "k2", provider: "moonshot", modelChoices: ["k2", "k3"], apps: [{ id: "linear", canToggle: false }] });
    await changeHarnessSettings("kimi", [{ op: "model", model: "k3" }], { home });
    expect(read(".kimi/config.toml").startsWith('default_model = "k3"\n')).toBe(true);
    await expect(changeHarnessSettings("kimi", [{ op: "model", model: "gpt-5" }], { home })).rejects.toThrow(/only uses models set up/);
  });
});

describe("Cursor", () => {
  it("shows what it has and changes nothing", async () => {
    write(".cursor/cli-config.json", JSON.stringify({ model: { modelId: "gpt-5", displayName: "GPT-5" } }));
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: { figma: { url: "https://figma.example.com/mcp" } } }));
    const s = await readHarnessSettings("cursor", { home });
    expect(s).toMatchObject({ model: "gpt-5", fixed: ["model", "provider"], apps: [{ id: "figma", canToggle: false }] });
    await expect(changeHarnessSettings("cursor", [{ op: "model", model: "x" }], { home })).rejects.toThrow(/changed on the device/);
  });
});

describe("OpenClaw", () => {
  it("reads agents.defaults.model and switches servers, plugins and skills", async () => {
    write(".openclaw/openclaw.json", JSON.stringify({ agents: { defaults: { model: { primary: "anthropic/claude-opus-5.5", fallbacks: [] } } }, mcp: { servers: { notes: { url: "u" } } }, plugins: { entries: { voice: { enabled: true } } } }, null, 2));
    skill(".openclaw/skills/standup", "standup");
    const s = await readHarnessSettings("openclaw", { home });
    expect(s).toMatchObject({ model: "anthropic/claude-opus-5.5", apps: [{ id: "notes", enabled: true }], plugins: [{ id: "voice", enabled: true }], skills: [{ id: "standup", enabled: true }] });
    await changeHarnessSettings("openclaw", [{ op: "model", model: "openai/gpt-5" }, { op: "toggle", kind: "plugin", id: "voice", enabled: false }, { op: "toggle", kind: "skill", id: "standup", enabled: false }, { op: "toggle", kind: "app", id: "notes", enabled: false }], { home });
    expect(json(".openclaw/openclaw.json")).toEqual({
      agents: { defaults: { model: { primary: "openai/gpt-5", fallbacks: [] } } },
      mcp: { servers: { notes: { url: "u", enabled: false } } },
      plugins: { entries: { voice: { enabled: false } } },
      skills: { entries: { standup: { enabled: false } } },
    });
    expect((await readHarnessSkill("openclaw", "standup", { home })).content).toContain("Steps.");
  });
});

describe("JSON with comments", () => {
  it("keeps strings with slashes and drops comments and trailing commas", () => {
    expect(parseJsonc('{ "url": "https://x.y/z", /* a */ "a": [1, 2,], // b\n }')).toEqual({ url: "https://x.y/z", a: [1, 2] });
  });
});

describe("accounts", () => {
  let warren: string;
  beforeEach(() => {
    warren = path.join(home, ".warren");
    write(".codex/config.toml", 'model = "gpt-6"\n');
    write(".codex/auth.json", "{}");
    write(".gemini/settings.json", "{}");
    write(".hermes/config.yaml", "model:\n  default: x\n");
    write(".hermes/profiles/coder/config.yaml", "model:\n  default: y\n");
  });

  it("adds an account with the default's settings and none of its logins", () => {
    const a = new HarnessAccounts(warren, { home });
    const work = a.add("codex", "Work ChatGPT");
    expect(work).toEqual({ id: "work-chatgpt", label: "Work ChatGPT", isDefault: false, signedIn: false });
    const dir = a.dir("codex", "work-chatgpt");
    expect(dir).toBe(path.join(warren, "accounts", "codex", "work-chatgpt"));
    expect(fs.readFileSync(path.join(dir, "config.toml"), "utf8")).toBe('model = "gpt-6"\n');
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
    expect(a.list("codex").map((x) => [x.id, x.signedIn])).toEqual([
      ["default", true],
      ["work-chatgpt", false],
    ]);
    expect(a.add("codex", "Work ChatGPT").id).toBe("work-chatgpt-2");
    expect(a.env("codex", "work-chatgpt")).toEqual({ CODEX_HOME: dir });
    expect(a.env("codex", "default")).toEqual({});
  });

  it("points Gemini's variable at the folder above .gemini", () => {
    const a = new HarnessAccounts(warren, { home });
    a.add("gemini", "Personal");
    expect(a.dir("gemini", "personal")).toBe(path.join(warren, "accounts", "gemini", "personal", ".gemini"));
    expect(a.env("gemini", "personal")).toEqual({ GEMINI_CLI_HOME: path.join(warren, "accounts", "gemini", "personal") });
  });

  it("uses Hermes's own profiles, including ones made outside Warren", () => {
    const a = new HarnessAccounts(warren, { home });
    expect(a.list("hermes").map((x) => x.id)).toEqual(["default", "coder"]);
    expect(a.dir("hermes", "coder")).toBe(path.join(home, ".hermes", "profiles", "coder"));
    a.add("hermes", "Research");
    expect(fs.existsSync(path.join(home, ".hermes", "profiles", "research", "config.yaml"))).toBe(true);
  });

  it("remembers which agent uses which, and forgets an account without deleting it", () => {
    const a = new HarnessAccounts(warren, { home });
    a.add("codex", "Work");
    a.assign("agt_1", "codex", "work");
    expect(a.accountOf("agt_1", "codex")).toBe("work");
    expect(a.accountOf("agt_2", "codex")).toBe("default");
    expect(() => a.assign("agt_1", "codex", "nope")).toThrow(/no account/);
    const { dir } = a.remove("codex", "work");
    expect(fs.existsSync(dir)).toBe(true);
    expect(a.accountOf("agt_1", "codex")).toBe("default");
    expect(() => a.remove("codex", "default")).toThrow();
  });

  it("won't add a second account where logins can't be kept apart", () => {
    const a = new HarnessAccounts(warren, { home });
    expect(() => a.add("goose", "Two")).toThrow(/keychain/);
    expect(a.env("goose", "two")).toEqual({});
  });

  it("knows how each one signs in", () => {
    expect(loginCommand("codex")).toEqual({ command: "codex", args: ["login", "--device-auth"] });
    expect(loginCommand("hermes", "openai-codex")).toEqual({ command: "hermes", args: ["auth", "add", "openai-codex"] });
    expect(() => loginCommand("hermes")).toThrow(/provider/);
    expect(loginCommand("gemini")).toEqual({ manual: ["gemini"] });
  });

  it("reads an account's own settings", async () => {
    const a = new HarnessAccounts(warren, { home });
    a.add("codex", "Work");
    await changeHarnessSettings("codex", [{ op: "model", model: "gpt-5" }], { home, dirs: { codex: a.dir("codex", "work") } });
    expect((await readHarnessSettings("codex", { home })).model).toBe("gpt-6");
    expect((await readHarnessSettings("codex", { home, dirs: { codex: a.dir("codex", "work") } })).model).toBe("gpt-5");
  });
});
