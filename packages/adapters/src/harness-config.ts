import { migrateMcpConfig } from "./mcp-migration.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { type ConfigSummary, type TomlDoc, type TomlEntry, asObject, boolish, deepEqual, findSkills, mcpItem, parseToml, readJson, safeWrite, sameKey, setPath, str, strings, tomlSet, tomlString, yamlSetList, yamlSetScalar } from "./harness-formats.ts";
import { MORE_HARNESSES, configFileFor, type HarnessSpec, type SpecDirs } from "./harness-more.ts";
import { SETTING_NAME, frontMatter, shortDescription, type HarnessConfigChange, type HarnessSettingItem, type HarnessSettings, type HarnessSettingsChange, type HarnessSkillFile } from "@wisp/core";

/**
 * A harness's own settings, straight from its config file: Hermes's ~/.hermes/config.yaml, Codex's
 * ~/.codex/config.toml, Claude Code's ~/.claude/settings.json. Reading turns them into a
 * HarnessSettings summary; changing edits only the lines that change (comments and the rest of the
 * file stay as they were), checks the result still reads back as the old file plus the change, keeps
 * a backup, and swaps the file in at once.
 */

export interface HarnessHomes {
  /** the home folder (default: this user's) */
  home?: string;
  /** a harness's own folder instead of its usual one (an account's folder), by harness id */
  dirs?: Record<string, string>;
  /** older names for dirs.hermes / dirs.codex / dirs["claude-code"] */
  hermesHome?: string;
  codexHome?: string;
  claudeDir?: string;
}

/** Hermes, Codex and Claude Code, read and changed here; the rest come from harness-more.ts. */
const BUILTIN: Record<string, HarnessSpec> = {
  hermes: {
    env: "HERMES_HOME",
    dir: (home) => path.join(home, ".hermes"),
    config: "config.yaml",
    accounts: true,
    read: (d) => readHermes(legacy(d, "hermes")),
    edit: (text, changes) => editHermes(text, changes),
    skillRoots: (d) => [path.join(d.dir, "skills")],
  },
  codex: {
    env: "CODEX_HOME",
    dir: (home) => path.join(home, ".codex"),
    config: "config.toml",
    accounts: true,
    // a ChatGPT login keeps its token in auth.json and leaves config.toml out until something sets a value
    missingOk: true,
    read: (d) => readCodex(legacy(d, "codex")),
    edit: (text, changes) => editCodex(text, changes),
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  },
  "claude-code": {
    env: "CLAUDE_CONFIG_DIR",
    dir: (home) => path.join(home, ".claude"),
    config: "settings.json",
    accounts: true,
    missingOk: true,
    read: (d) => readClaude(legacy(d, "claude-code")),
    edit: (text, changes) => editClaude(text, changes),
    skillRoots: (d) => [path.join(d.dir, "skills")],
  },
};

/** Every harness Wisp reads and changes the settings of, by id. */
export const HARNESS_SPECS: Record<string, HarnessSpec> = { ...BUILTIN, ...MORE_HARNESSES };

/** Gemini's variable names the folder above .gemini, Goose's the folder above config/. */
const FROM_ENV: Record<string, (v: string) => string> = { gemini: (v) => path.join(v, ".gemini"), goose: (v) => path.join(v, "config") };

const homes = (h: HarnessHomes = {}) => {
  const home = h.home ?? os.homedir();
  // a home given for tests (or a scratch device) means that home's folders, not this user's
  const env = (name: string) => (h.home ? undefined : process.env[name]);
  const own: Record<string, string | undefined> = { hermes: h.hermesHome, codex: h.codexHome, "claude-code": h.claudeDir, ...h.dirs };
  const dir = (harness: string) => {
    const spec = HARNESS_SPECS[harness];
    const moved = env(spec.env);
    return own[harness] ?? (moved ? (FROM_ENV[harness]?.(moved) ?? moved) : spec.dir(home));
  };
  return { home, hermes: dir("hermes"), codex: dir("codex"), claude: dir("claude-code"), dir };
};

/** The readers above were written for one folder per harness. */
const legacy = (d: SpecDirs, harness: string): Homes => ({ ...homes({ home: d.home }), [harness === "claude-code" ? "claude" : harness]: d.dir });

/** A harness's usual folder on this device (where its default account lives). */
export function harnessDir(harness: string, h?: HarnessHomes): string | null {
  return HARNESS_SPECS[harness] ? homes({ home: h?.home }).dir(harness) : null;
}

/** The file Wisp reads and changes for a harness, or null for one it doesn't know. */
export function harnessConfigPath(harness: string, h?: HarnessHomes): string | null {
  return HARNESS_SPECS[harness] ? path.join(homes(h).dir(harness), HARNESS_SPECS[harness].config) : null;
}

/** Whether a harness is set up here: its config file is there (whichever name it uses). */
export async function harnessConfigured(harness: string, h?: HarnessHomes): Promise<boolean> {
  const spec = HARNESS_SPECS[harness];
  if (!spec) return false;
  const d = specDirs(harness, h);
  return !!(await fs.stat(await configFileFor(harness, d.dir, path.join(d.dir, spec.config))).catch(() => null));
}

const specDirs = (harness: string, h?: HarnessHomes): SpecDirs => {
  const d = homes(h);
  return { home: d.home, dir: d.dir(harness) };
};

export async function readHarnessSettings(harness: string, h?: HarnessHomes): Promise<HarnessSettings> {
  const spec = HARNESS_SPECS[harness];
  if (!spec) throw new Error(`Wisp can't change ${harness}'s settings yet`);
  const d = specDirs(harness, h);
  const file = await configFileFor(harness, d.dir, path.join(d.dir, spec.config));
  const empty: HarnessSettings = { harness, account: "default", accounts: [], multiAccount: false, agentAccounts: {}, configPath: file, model: null, provider: null, providers: null, apps: [], plugins: [], skills: [] };
  try {
    return { ...empty, ...(await spec.read(d)) };
  } catch (err) {
    return { ...empty, error: `Couldn't read ${file}: ${(err as Error).message}` };
  }
}

/** Apply `changes` to a harness's config file and read the settings back. */
export async function changeHarnessSettings(harness: string, changes: HarnessSettingsChange[], h?: HarnessHomes): Promise<HarnessSettings> {
  const spec = HARNESS_SPECS[harness];
  if (!spec) throw new Error(`Wisp can't change ${harness}'s settings yet`);
  for (const c of changes) if (c.op === "model" || c.op === "provider") SETTING_NAME.parse(c.op === "model" ? c.model : c.provider);
  // the reasoning effort is a top-level key of the config, set after the harness's own editor ran
  const effort = changes.find((c) => c.op === "effort")?.effort;
  if (effort !== undefined && !/^[a-z]{2,16}$/.test(effort)) throw new Error("a reasoning effort is a level like low, medium or high");
  const rest = changes.filter((c): c is HarnessConfigChange => c.op !== "effort");
  const d = specDirs(harness, h);
  const file = await configFileFor(harness, d.dir, path.join(d.dir, spec.config));
  const real = await fs.realpath(file).catch(() => file);
  const before = await fs.readFile(real, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" && spec.missingOk) return "";
    throw e.code === "ENOENT" ? new Error(`${file} doesn't exist yet; set ${harness} up on the device first`) : e;
  });
  const current = await readHarnessSettings(harness, h);
  if (current.error) throw new Error(current.error);
  if (current.fixed?.includes("file")) throw new Error(`${path.basename(file)} has comments in it, so Wisp leaves it as it is; change it on the device`);
  if (effort !== undefined && current.effort === undefined) throw new Error(`${harness} has no reasoning effort setting Wisp can change`);
  if (effort !== undefined && current.fixed?.includes("model")) throw new Error(`${harness}'s reasoning effort is changed on the device`);
  for (const c of rest) {
    if (c.op !== "toggle" && current.fixed?.includes(c.op)) throw new Error(`${harness}'s ${c.op} is changed on the device`);
    if (c.op === "provider" && current.providers === null) throw new Error(`${harness} has no provider setting`);
    if (c.op !== "toggle") continue;
    const list = c.kind === "app" ? current.apps : c.kind === "plugin" ? current.plugins : current.skills;
    const item = list.find((i) => i.id === c.id);
    if (!item) throw new Error(`${harness} has no ${c.kind} "${c.id}"`);
    if (!item.canToggle) throw new Error(`${harness} has no off switch for ${item.name}; change it on the device`);
  }
  const edits = harness === "hermes" ? hermesModelChoices(rest, current) : rest;
  let after = migrateMcpConfig(await spec.edit(before, edits, d), harness);
  if (effort !== undefined) after = setCodexEffort(after, effort);
  if (after !== before) await safeWrite(real, before, after);
  return readHarnessSettings(harness, h);
}

/**
 * Hermes lists its models as "provider:model" (its ACP picker does), but keeps the two apart in its
 * config: picking "openai-codex:gpt-6" sets both. A colon that isn't after a provider stays in the name.
 */
function hermesModelChoices(changes: HarnessConfigChange[], current: HarnessSettings): HarnessConfigChange[] {
  const known = new Set([...HERMES_KNOWN_PROVIDERS, ...(current.providers ?? []).map((p) => p.id)]);
  return changes.flatMap((c): HarnessConfigChange[] => {
    const m = c.op === "model" ? /^([a-z0-9-]+):(.+)$/.exec(c.model) : null;
    if (!m || !known.has(m[1]) || changes.some((x) => x.op === "provider")) return [c];
    return [
      { op: "provider", provider: m[1] },
      { op: "model", model: m[2] },
    ];
  });
}

/** A skill's SKILL.md, found by its id among the harness's own skills (never a path someone sent). */
export async function readHarnessSkill(harness: string, id: string, h?: HarnessHomes): Promise<HarnessSkillFile> {
  const spec = HARNESS_SPECS[harness];
  if (!spec) throw new Error(`Wisp can't share ${harness}'s skills yet`);
  for (const root of spec.skillRoots(specDirs(harness, h))) {
    const found = (await findSkills(root)).find((s) => s.id === id);
    if (!found) continue;
    const content = await fs.readFile(found.file, "utf8");
    if (content.length > 100_000) throw new Error(`${found.name}'s SKILL.md is too big to share (over 100 KB)`);
    const fm = frontMatter(content);
    return { name: fm.name || found.name, description: (fm.description || "").slice(0, 2000), content };
  }
  throw new Error(`${harness} has no skill "${id}"`);
}

export { parseToml } from "./harness-formats.ts";

// --- reading ---------------------------------------------------------------------------------

type Homes = ReturnType<typeof homes>;
type Summary = ConfigSummary;

/** Providers people pick most often, after the ones this device is signed in to. */
const HERMES_PROVIDERS = ["openrouter", "anthropic", "openai-api", "openai-codex", "nous", "gemini", "xai", "deepseek", "kimi-coding"];
/** Every provider Hermes knows (its PROVIDER_REGISTRY, and the special ones), to tell "provider:model" apart. */
const HERMES_KNOWN_PROVIDERS = [
  ...HERMES_PROVIDERS,
  ...["auto", "custom", "moa", "xai-oauth", "qwen-oauth", "lmstudio", "copilot", "copilot-acp", "zai", "kimi-coding-cn", "stepfun", "arcee", "gmi", "minimax", "minimax-oauth", "alibaba", "alibaba-coding-plan", "minimax-cn", "nvidia", "ai-gateway", "opencode-zen", "opencode-go", "kilocode", "huggingface", "xiaomi", "tencent-tokenhub", "ollama-cloud", "bedrock", "vertex", "azure-foundry"],
];

async function readHermes(d: Homes): Promise<Summary> {
  const cfg = asObject(yaml.load(await fs.readFile(path.join(d.hermes, "config.yaml"), "utf8")));
  const model = cfg.model;
  const auth = asObject(await readJson(path.join(d.hermes, "auth.json")));
  const signedIn = new Set([...Object.keys(asObject(auth.providers)), ...Object.keys(asObject(auth.credential_pool))]);
  const provider = typeof model === "object" && model ? str(asObject(model).provider) : null;
  const ids = [...new Set([...signedIn, ...(provider ? [provider] : []), ...HERMES_PROVIDERS])];
  const plugins = asObject(cfg.plugins);
  const enabled = new Set(strings(plugins.enabled));
  const disabled = new Set(strings(plugins.disabled));
  const skillsOff = new Set(strings(asObject(cfg.skills).disabled));
  return {
    model: typeof model === "string" ? model : str(asObject(model).default),
    provider,
    providers: ids.map((id) => ({ id, signedIn: signedIn.has(id) })).sort((a, b) => Number(b.signedIn) - Number(a.signedIn)),
    apps: Object.entries(asObject(cfg.mcp_servers)).map(([name, v]) => mcpItem(name, asObject(v), boolish(asObject(v).enabled, true), true)),
    plugins: (await hermesPlugins(d)).map((p) => ({ ...p, enabled: enabled.has(p.id) && !disabled.has(p.id), canToggle: true })),
    skills: (await findSkills(path.join(d.hermes, "skills"))).map((s) => ({ id: s.id, name: s.name, description: s.description, enabled: !skillsOff.has(s.id), canToggle: true })),
  };
}

/** Plugins people turn on and off themselves (`hermes plugins enable`): Hermes's bundled ones and the user's own. */
async function hermesPlugins(d: Homes): Promise<{ id: string; name: string; description?: string }[]> {
  const out = new Map<string, { id: string; name: string; description?: string }>();
  for (const root of [path.join(d.hermes, "hermes-agent", "plugins"), path.join(d.hermes, "plugins")]) {
    for (const dir of (await fs.readdir(root).catch(() => [] as string[])).sort()) {
      const manifest = await fs.readFile(path.join(root, dir, "plugin.yaml"), "utf8").catch(() => null);
      if (manifest === null) continue;
      let m: Record<string, unknown>;
      try {
        m = asObject(yaml.load(manifest));
      } catch {
        continue;
      }
      // backends and providers are picked elsewhere in Hermes's config, not switched on
      if (m.kind && m.kind !== "standalone") continue;
      out.set(dir, { id: dir, name: str(m.name) ?? dir, description: shortDescription(str(m.description) ?? undefined) });
    }
  }
  return [...out.values()];
}

async function readCodex(d: Homes): Promise<Summary> {
  const doc = parseToml(await fs.readFile(path.join(d.codex, "config.toml"), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "" : Promise.reject(e))));
  const get = (table: string[], key: string) => doc.entries.find((e) => sameKey(e.table, table) && e.key === key && !e.arrayIndex)?.value;
  const provider = str(get([], "model_provider"));
  const configured = doc.tables.filter((t) => t.path.length === 2 && t.path[0] === "model_providers").map((t) => t.path[1]);
  const ids = [...new Set(["openai", ...configured, ...(provider ? [provider] : [])])];
  const apps: HarnessSettingItem[] = [];
  const plugins: HarnessSettingItem[] = [];
  for (const t of doc.tables) {
    if (t.array || t.path.length !== 2) continue;
    const fields = Object.fromEntries(doc.entries.filter((e) => sameKey(e.table, t.path) && !e.arrayIndex).map((e) => [e.key, e.value]));
    if (t.path[0] === "mcp_servers") apps.push(mcpItem(t.path[1], fields, fields.enabled !== false, true));
    if (t.path[0] === "plugins") plugins.push({ id: t.path[1], name: t.path[1].split("@")[0], enabled: fields.enabled !== false, canToggle: true });
  }
  // [[skills.config]] entries turn skills off by name (or by the SKILL.md's path)
  const overrides = codexSkillOverrides(doc);
  const skills: HarnessSettingItem[] = [];
  for (const root of [path.join(d.codex, "skills"), path.join(d.home, ".agents", "skills")]) {
    for (const s of await findSkills(root)) {
      if (skills.some((k) => k.id === s.id)) continue;
      const o = overrides.find((x) => x.name === s.id || x.path === s.file);
      skills.push({ id: s.id, name: s.name, description: s.description, enabled: o?.enabled ?? true, canToggle: true });
    }
  }
  return { model: str(get([], "model")), provider: provider ?? "openai", providers: ids.map((id) => ({ id, signedIn: id === "openai" || configured.includes(id) })), effort: str(get([], "model_reasoning_effort")) ?? null, apps, plugins, skills };
}

function codexSkillOverrides(doc: TomlDoc) {
  return doc.tables
    .filter((t) => t.array && sameKey(t.path, ["skills", "config"]))
    .map((t) => {
      const fields = Object.fromEntries(doc.entries.filter((e) => e.arrayIndex === t.arrayIndex && sameKey(e.table, t.path)).map((e) => [e.key, e.value]));
      return { table: t, name: str(fields.name), path: str(fields.path), enabled: typeof fields.enabled === "boolean" ? fields.enabled : undefined };
    });
}

async function readClaude(d: Homes): Promise<Summary> {
  const settings = asObject(await readJson(path.join(d.claude, "settings.json"), true));
  const enabled = asObject(settings.enabledPlugins);
  const overrides = asObject(settings.skillOverrides);
  const installed = asObject(asObject(await readJson(path.join(d.claude, "plugins", "installed_plugins.json"))).plugins);
  const plugins: HarnessSettingItem[] = [];
  for (const [id, entry] of Object.entries(installed)) {
    const installPath = str(asObject(Array.isArray(entry) ? entry[0] : entry).installPath);
    const manifest = installPath ? asObject(await readJson(path.join(installPath, ".claude-plugin", "plugin.json"))) : {};
    plugins.push({ id, name: str(manifest.name) ?? id.split("@")[0], description: shortDescription(str(manifest.description) ?? undefined), enabled: enabled[id] !== false, canToggle: true });
  }
  // user-wide MCP servers live in ~/.claude.json, which Claude Code rewrites all the time: shown, not changed
  const state = asObject(await readJson(path.join(d.claude === path.join(d.home, ".claude") ? d.home : d.claude, ".claude.json")));
  return {
    model: str(settings.model),
    provider: null,
    providers: null,
    apps: Object.entries(asObject(state.mcpServers)).map(([name, v]) => mcpItem(name, asObject(v), true, false)),
    plugins,
    skills: (await findSkills(path.join(d.claude, "skills"))).map((s) => ({ id: s.id, name: s.name, description: s.description, enabled: overrides[s.id] !== "off", canToggle: true })),
  };
}

// --- changing ------------------------------------------------------------------------------

/** Hermes: model.default and model.provider, plugins.enabled/disabled, skills.disabled, mcp_servers.<name>.enabled. */
export function editHermes(text: string, changes: HarnessConfigChange[]): string {
  const before = asObject(yaml.load(text));
  const expected = structuredClone(before);
  if (typeof before.model === "string" && changes.some((c) => c.op === "model" || c.op === "provider")) {
    // the old one-line form ("model: name") becomes the block form Hermes writes today
    text = yamlSetScalar(yamlSetScalar(text, ["model"], null), ["model", "default"], before.model);
    expected.model = { default: before.model };
  }
  let out = text;
  const list = (v: unknown) => new Set(strings(v));
  for (const c of changes) {
    if (c.op === "model" || c.op === "provider") {
      const key = c.op === "model" ? "default" : "provider";
      const value = c.op === "model" ? c.model : c.provider;
      out = yamlSetScalar(out, ["model", key], value);
      setPath(expected, ["model", key], value);
    } else if (c.kind === "skill") {
      const off = list(asObject(expected.skills).disabled);
      c.enabled ? off.delete(c.id) : off.add(c.id);
      out = yamlSetList(out, ["skills", "disabled"], [...off].sort());
      setPath(expected, ["skills", "disabled"], [...off].sort());
    } else if (c.kind === "plugin") {
      // what `hermes plugins enable/disable` does: the allow-list, and the deny-list wins over it
      const on = list(asObject(expected.plugins).enabled);
      const off = list(asObject(expected.plugins).disabled);
      if (c.enabled) (on.add(c.id), off.delete(c.id));
      else (on.delete(c.id), off.add(c.id));
      // an empty list that wasn't there before stays out
      const had = asObject(expected.plugins);
      for (const [key, set] of [["enabled", on], ["disabled", off]] as const) {
        if (!set.size && !(key in had)) continue;
        out = yamlSetList(out, ["plugins", key], [...set].sort());
        setPath(expected, ["plugins", key], [...set].sort());
      }
    } else {
      out = yamlSetScalar(out, ["mcp_servers", c.id, "enabled"], c.enabled);
      setPath(expected, ["mcp_servers", c.id, "enabled"], c.enabled);
    }
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(out);
  } catch (err) {
    throw new Error(`the change would leave config.yaml unreadable (${(err as Error).message}); nothing was changed`);
  }
  if (!deepEqual(parsed, expected)) throw new Error("the change didn't come out as expected, so config.yaml was left as it was");
  return out;
}

/** Codex's `model_reasoning_effort` (top level), changed on its own and checked like the other edits. */
export function setCodexEffort(text: string, effort: string): string {
  const out = tomlSet(text, [], "model_reasoning_effort", effort);
  const a = parseToml(text);
  const b = parseToml(out);
  const rest = (d: TomlDoc) => d.entries.filter((e) => !(sameKey(e.table, []) && e.key === "model_reasoning_effort")).map((e) => `${e.table.join("\0")}\0${e.key}\0${e.raw}`);
  const ra = rest(a);
  const rb = rest(b);
  if (ra.length !== rb.length || ra.some((x, i) => x !== rb[i]) || !b.entries.some((e) => sameKey(e.table, []) && e.key === "model_reasoning_effort" && e.value === effort)) throw new Error("the change didn't come out as expected, so config.toml was left as it was");
  return out;
}

/** Codex: top-level model and model_provider, [mcp_servers.<name>] and [plugins."<id>"] enabled, [[skills.config]] for skills. */
export function editCodex(text: string, changes: HarnessConfigChange[]): string {
  let out = text;
  const want: { table: string[]; key: string; value: unknown; arrayIndex?: number; name?: string }[] = [];
  for (const c of changes) {
    if (c.op === "model" || c.op === "provider") {
      const key = c.op === "model" ? "model" : "model_provider";
      const value = c.op === "model" ? c.model : c.provider;
      out = tomlSet(out, [], key, value);
      want.push({ table: [], key, value });
    } else if (c.kind === "app" || c.kind === "plugin") {
      const table = [c.kind === "app" ? "mcp_servers" : "plugins", c.id];
      out = tomlSet(out, table, "enabled", c.enabled);
      want.push({ table, key: "enabled", value: c.enabled });
    } else {
      const doc = parseToml(out);
      const entry = codexSkillOverrides(doc).find((o) => o.name === c.id);
      if (entry) out = tomlSet(out, ["skills", "config"], "enabled", c.enabled, entry.table.arrayIndex);
      else if (!c.enabled) out = `${out}${out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n"}[[skills.config]]\nname = ${tomlString(c.id)}\nenabled = false\n`;
      want.push({ table: ["skills", "config"], key: "enabled", value: c.enabled, name: c.id });
    }
  }
  // the file still reads, every value that wasn't changed is as it was, and each change is there
  const a = parseToml(text);
  const b = parseToml(out);
  const changed = (e: TomlEntry) => want.some((w) => sameKey(w.table, e.table) && w.key === e.key && !w.name) || (sameKey(e.table, ["skills", "config"]) && e.key === "enabled");
  const rest = (d: TomlDoc) => d.entries.filter((e) => !changed(e) && !(sameKey(e.table, ["skills", "config"]) && e.key === "name")).map((e) => `${e.table.join("\0")}\0${e.key}\0${e.raw}`);
  const ra = rest(a);
  const rb = rest(b);
  if (ra.length !== rb.length || ra.some((x, i) => x !== rb[i])) throw new Error("the change didn't come out as expected, so config.toml was left as it was");
  for (const w of want) {
    const ok = w.name
      ? codexSkillOverrides(b).some((o) => o.name === w.name && (o.enabled ?? true) === w.value) || (w.value === true && !codexSkillOverrides(b).some((o) => o.name === w.name))
      : b.entries.some((e) => sameKey(e.table, w.table) && e.key === w.key && e.value === w.value);
    if (!ok) throw new Error("the change didn't come out as expected, so config.toml was left as it was");
  }
  return out;
}

/** Claude Code: model, enabledPlugins, skillOverrides in settings.json. */
export function editClaude(text: string, changes: HarnessConfigChange[]): string {
  const settings = text.trim() ? asObject(JSON.parse(text)) : {};
  for (const c of changes) {
    if (c.op === "model") settings.model = c.model;
    else if (c.op === "provider") throw new Error("Claude Code has no provider setting");
    else if (c.kind === "plugin") settings.enabledPlugins = { ...asObject(settings.enabledPlugins), [c.id]: c.enabled };
    else if (c.kind === "skill") {
      const o = { ...asObject(settings.skillOverrides) };
      if (c.enabled) delete o[c.id];
      else o[c.id] = "off";
      if (Object.keys(o).length) settings.skillOverrides = o;
      else delete settings.skillOverrides;
    } else throw new Error("Claude Code's own apps (MCP servers) are changed on the device");
  }
  const indent = /^\{\s*\n(\s+)"/.exec(text)?.[1] ?? "  ";
  return JSON.stringify(settings, null, indent.includes("\t") ? "\t" : indent.length) + (text === "" || text.endsWith("\n") ? "\n" : "");
}

