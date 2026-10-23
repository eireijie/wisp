import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { HarnessSettingItem, HarnessSettingsChange } from "@warren/core";
import { asObject, editJson, editYaml, isPlainJson, manifestDirs, mcpItem, objAt, parseJsonc, parseToml, readJson, sameKey, skillItems, str, strings, toggleInList, tomlSet, type ConfigSummary } from "./harness-formats.ts";

/**
 * How Warren reads and changes each harness's own config. Hermes, Codex and Claude Code live in
 * harness-config.ts; the rest are here, from each one's documentation:
 * Gemini CLI  ~/.gemini/settings.json        Qwen Code  ~/.qwen/settings.json
 * OpenCode    ~/.config/opencode/opencode.json(c)   Goose  ~/.config/goose/config.yaml
 * Kimi CLI    ~/.kimi/config.toml            Cursor     ~/.cursor/cli-config.json
 * OpenClaw    ~/.openclaw/openclaw.json
 * What a harness has no setting for in its file (Cursor's model) is shown but not changed.
 */

export interface SpecDirs {
  home: string;
  /** the harness's folder (an account's, or its usual one) */
  dir: string;
}

export interface HarnessSpec {
  /** the variable that moves the harness's folder */
  env: string;
  /** its usual folder */
  dir: (home: string) => string;
  /** the config file, in the folder */
  config: string;
  /** separate logins per folder (the login lives in the folder), so a second account is really separate */
  accounts: boolean;
  /** what the variable is set to for a folder (Gemini's points at the folder above .gemini) */
  envValue?: (dir: string) => string;
  /** an account's folder inside the place Warren keeps it */
  accountDir?: (root: string) => string;
  /** a missing config file is fine: changing makes it */
  missingOk?: boolean;
  read(d: SpecDirs): Promise<ConfigSummary>;
  edit(text: string, changes: HarnessSettingsChange[], d: SpecDirs): string | Promise<string>;
  skillRoots(d: SpecDirs): string[];
}

const xdgConfig = (home: string) => (process.env.XDG_CONFIG_HOME && home === process.env.HOME ? process.env.XDG_CONFIG_HOME : path.join(home, ".config"));
const text = (file: string) => fs.readFile(file, "utf8").catch(() => "");

/** Gemini CLI and Qwen Code share a settings format (Qwen started as a Gemini CLI fork). */
function geminiLike(opts: { env: string; folder: string; envIsParent: boolean; extensions: boolean; name: string }): HarnessSpec {
  return {
    env: opts.env,
    dir: (home) => path.join(home, opts.folder),
    config: "settings.json",
    accounts: true,
    missingOk: true,
    ...(opts.envIsParent ? { envValue: (dir: string) => path.dirname(dir), accountDir: (root: string) => path.join(root, opts.folder) } : {}),
    async read(d) {
      const raw = await text(path.join(d.dir, "settings.json"));
      const s = asObject(parseJsonc(raw));
      const model = typeof s.model === "string" ? s.model : str(asObject(s.model).name);
      const mcp = asObject(s.mcp);
      const excluded = new Set(strings(mcp.excluded));
      const allowed = Array.isArray(mcp.allowed) ? new Set(strings(mcp.allowed)) : null;
      const off = new Set(strings(asObject(s.skills).disabled));
      const plain = isPlainJson(raw);
      const plugins: HarnessSettingItem[] = [];
      if (opts.extensions) {
        // turning extensions on and off is per folder (extension-enablement.json); shown, changed with `gemini extensions`
        const enablement = asObject(await readJson(path.join(d.dir, "extensions", "extension-enablement.json")));
        for (const e of await manifestDirs(path.join(d.dir, "extensions"), "gemini-extension.json")) {
          const overrides = strings(asObject(enablement[e.id]).overrides);
          plugins.push({ ...e, enabled: !overrides.some((o) => /^!\/?\*+$/.test(o) || o === "!" + d.home + "/*"), canToggle: false });
        }
      }
      return {
        model,
        provider: null,
        providers: null,
        apps: Object.entries(asObject(s.mcpServers)).map(([n, v]) => mcpItem(n, { ...asObject(v), url: asObject(v).httpUrl ?? asObject(v).url }, !excluded.has(n) && (!allowed || allowed.has(n)), plain && !allowed)),
        plugins,
        skills: await skillItems([path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")], (id) => !off.has(id), plain),
        ...(plain ? {} : { fixed: ["file" as const] }),
      };
    },
    edit(raw, changes) {
      return editJson(raw, `${opts.name}'s settings.json`, (s) => {
        for (const c of changes) {
          if (c.op === "model") s.model = typeof s.model === "string" || !s.model ? { name: c.model } : { ...asObject(s.model), name: c.model };
          else if (c.op === "provider") throw new Error(`${opts.name} has no provider setting`);
          else if (c.kind === "app") toggleInList(s, ["mcp", "excluded"], c.id, !c.enabled);
          else if (c.kind === "skill") toggleInList(s, ["skills", "disabled"], c.id, !c.enabled);
          else throw new Error(`turn ${opts.name}'s extensions on and off with \`gemini extensions enable|disable\` on the device`);
        }
      });
    },
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  };
}

const opencodeFile = async (dir: string) => {
  for (const n of ["opencode.json", "opencode.jsonc"]) if (await fs.stat(path.join(dir, n)).catch(() => null)) return path.join(dir, n);
  return path.join(dir, "opencode.json");
};

export const MORE_HARNESSES: Record<string, HarnessSpec> = {
  gemini: geminiLike({ env: "GEMINI_CLI_HOME", folder: ".gemini", envIsParent: true, extensions: true, name: "Gemini CLI" }),
  qwen: geminiLike({ env: "QWEN_HOME", folder: ".qwen", envIsParent: false, extensions: false, name: "Qwen Code" }),

  // its logins live in ~/.local/share/opencode, which its config folder variable doesn't move
  opencode: {
    env: "OPENCODE_CONFIG_DIR",
    dir: (home) => path.join(xdgConfig(home), "opencode"),
    config: "opencode.json",
    accounts: false,
    missingOk: true,
    async read(d) {
      const raw = await text(await opencodeFile(d.dir));
      const s = asObject(parseJsonc(raw));
      const plain = isPlainJson(raw);
      const perms = asObject(asObject(s.permission).skill);
      const model = str(s.model);
      return {
        model,
        provider: null,
        providers: null,
        apps: Object.entries(asObject(s.mcp)).map(([n, v]) => {
          const e = asObject(v);
          return mcpItem(n, { url: e.url, command: Array.isArray(e.command) ? strings(e.command)[0] : e.command, args: Array.isArray(e.command) ? strings(e.command).slice(1) : [] }, e.enabled !== false, plain);
        }),
        plugins: strings(s.plugin).map((p) => ({ id: p, name: p.replace(/^@[^/]+\//, "").replace(/@[^@]*$/, ""), enabled: true, canToggle: false })),
        skills: await skillItems([path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")], (id) => perms[id] !== "deny", plain),
        ...(plain ? {} : { fixed: ["file" as const] }),
      };
    },
    edit(raw, changes) {
      return editJson(raw, "opencode.json", (s) => {
        for (const c of changes) {
          // OpenCode names models "provider/model"
          if (c.op === "model") s.model = c.model;
          else if (c.op === "provider") throw new Error("OpenCode picks the provider with the model (provider/model)");
          else if (c.kind === "app") objAt(s, ["mcp", c.id]).enabled = c.enabled;
          else if (c.kind === "skill") {
            const p = objAt(s, ["permission", "skill"]);
            if (c.enabled) delete p[c.id];
            else p[c.id] = "deny";
          } else throw new Error("OpenCode's plugins are added and removed in opencode.json on the device");
        }
      });
    },
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  },

  // its logins live in the system keychain, which doesn't follow the folder
  goose: {
    env: "GOOSE_PATH_ROOT",
    dir: (home) => path.join(xdgConfig(home), "goose"),
    config: "config.yaml",
    accounts: false,
    async read(d) {
      const cfg = asObject(yaml.load(await fs.readFile(path.join(d.dir, "config.yaml"), "utf8")));
      const active = str(cfg.active_provider);
      const providers = asObject(cfg.providers);
      const provider = active ?? str(cfg.GOOSE_PROVIDER);
      const settings = asObject(await readJson(path.join(d.dir, "settings.json")));
      const disabledPlugins = new Set(strings(settings.disabledPlugins));
      return {
        model: active ? str(asObject(providers[active]).model) : str(cfg.GOOSE_MODEL),
        provider,
        providers: [...new Set([...Object.keys(providers), ...(provider ? [provider] : [])])].map((id) => ({ id, signedIn: asObject(providers[id]).configured === true || id === provider })),
        apps: Object.entries(asObject(cfg.extensions))
          .filter(([, v]) => !["builtin", "platform"].includes(String(asObject(v).type)))
          .map(([n, v]) => {
            const e = asObject(v);
            return { ...mcpItem(n, { command: e.cmd, args: e.args, url: e.uri }, e.enabled !== false, true), name: str(e.name) ?? n };
          }),
        plugins: (await manifestDirs(path.join(d.home, ".agents", "plugins"), "plugin.json")).map((p) => ({ ...p, enabled: !disabledPlugins.has(p.id), canToggle: false })),
        skills: await skillItems([path.join(d.home, ".agents", "skills")], () => true, false),
      };
    },
    edit(raw, changes) {
      const cfg = asObject(yaml.load(raw));
      const sets: { path: string[]; value: string | boolean }[] = [];
      // the newer layout (active_provider + providers.<id>.model), else the older flat keys
      let active = str(cfg.active_provider);
      for (const c of changes) {
        if (c.op === "provider") {
          if (active) (sets.push({ path: ["active_provider"], value: c.provider }), (active = c.provider));
          else sets.push({ path: ["GOOSE_PROVIDER"], value: c.provider });
        } else if (c.op === "model") sets.push(active ? { path: ["providers", active, "model"], value: c.model } : { path: ["GOOSE_MODEL"], value: c.model });
        else if (c.kind === "app") sets.push({ path: ["extensions", c.id, "enabled"], value: c.enabled });
        else throw new Error("Goose's plugins and skills are changed on the device");
      }
      return editYaml(raw, "config.yaml", sets, (t) => yaml.load(t));
    },
    skillRoots: (d) => [path.join(d.home, ".agents", "skills")],
  },

  kimi: {
    env: "KIMI_SHARE_DIR",
    dir: (home) => path.join(home, ".kimi"),
    config: "config.toml",
    accounts: true,
    async read(d) {
      const doc = parseToml(await fs.readFile(path.join(d.dir, "config.toml"), "utf8"));
      const top = (k: string) => doc.entries.find((e) => !e.table.length && e.key === k && !e.arrayIndex)?.value;
      const models = doc.tables.filter((t) => t.path.length === 2 && t.path[0] === "models").map((t) => t.path[1]);
      const model = str(top("default_model"));
      const provider = model ? str(doc.entries.find((e) => sameKey(e.table, ["models", model]) && e.key === "provider")?.value) : null;
      const mcp = asObject(asObject(await readJson(path.join(d.dir, "mcp.json"))).mcpServers);
      return {
        model,
        provider,
        providers: null,
        apps: Object.entries(mcp).map(([n, v]) => mcpItem(n, asObject(v), true, false)),
        plugins: (await manifestDirs(path.join(d.dir, "plugins"), "plugin.json")).map((p) => ({ ...p, enabled: true, canToggle: false })),
        skills: await skillItems([path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")], () => true, false),
        fixed: ["provider"],
        // the models it can pick are the [models.<name>] it has
        ...(models.length ? { modelChoices: models } : {}),
      };
    },
    edit(raw, changes) {
      let out = raw;
      const models = parseToml(raw)
        .tables.filter((t) => t.path.length === 2 && t.path[0] === "models")
        .map((t) => t.path[1]);
      for (const c of changes) {
        if (c.op !== "model") throw new Error("Kimi's apps, plugins and skills are changed on the device (kimi mcp, kimi plugin)");
        if (!models.includes(c.model)) throw new Error(`Kimi only uses models set up in its config.toml (${models.join(", ") || "none yet"}); add "${c.model}" there first`);
        out = tomlSet(out, [], "default_model", c.model);
      }
      return out;
    },
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  },

  // where its login lives isn't documented, so one account
  cursor: {
    env: "CURSOR_CONFIG_DIR",
    dir: (home) => path.join(home, ".cursor"),
    config: "cli-config.json",
    accounts: false,
    async read(d) {
      const s = asObject(parseJsonc(await text(path.join(d.dir, "cli-config.json"))));
      const m = s.model;
      const model = typeof m === "string" ? m : (str(asObject(m).modelId) ?? str(asObject(m).displayModelId) ?? str(asObject(m).id));
      const mcp = asObject(asObject(await readJson(path.join(d.dir, "mcp.json"))).mcpServers);
      return {
        model,
        provider: null,
        providers: null,
        apps: Object.entries(mcp).map(([n, v]) => mcpItem(n, asObject(v), true, false)),
        plugins: [],
        skills: await skillItems([path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")], () => true, false),
        fixed: ["model", "provider"],
      };
    },
    edit() {
      throw new Error("Cursor's settings are changed in Cursor on the device (/model, agent mcp)");
    },
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  },

  // its logins live in its state database, one per state folder, which Warren doesn't move yet
  openclaw: {
    env: "OPENCLAW_STATE_DIR",
    dir: (home) => path.join(home, ".openclaw"),
    config: "openclaw.json",
    accounts: false,
    async read(d) {
      const raw = await fs.readFile(path.join(d.dir, "openclaw.json"), "utf8");
      const s = asObject(parseJsonc(raw));
      const plain = isPlainJson(raw);
      const m = asObject(asObject(s.agents).defaults).model;
      const entries = asObject(asObject(s.plugins).entries);
      const deny = new Set(strings(asObject(s.plugins).deny));
      const skills = asObject(asObject(s.skills).entries);
      const ids = new Set([...Object.keys(entries), ...(await manifestDirs(path.join(d.dir, "extensions"), "package.json")).map((e) => e.id)]);
      return {
        model: typeof m === "string" ? m : str(asObject(m).primary),
        provider: null,
        providers: null,
        apps: Object.entries(asObject(asObject(s.mcp).servers)).map(([n, v]) => mcpItem(n, asObject(v), asObject(v).enabled !== false, plain)),
        plugins: [...ids].sort().map((id) => ({ id, name: id, enabled: asObject(entries[id]).enabled !== false && !deny.has(id), canToggle: plain && !deny.has(id) })),
        skills: await skillItems([path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")], (id) => asObject(skills[id]).enabled !== false, plain),
        ...(plain ? {} : { fixed: ["file" as const] }),
      };
    },
    edit(raw, changes) {
      return editJson(raw, "openclaw.json", (s) => {
        for (const c of changes) {
          if (c.op === "model") {
            const defaults = objAt(s, ["agents", "defaults"]);
            if (typeof defaults.model === "string" || !defaults.model) defaults.model = { primary: c.model };
            else asObject(defaults.model).primary = c.model;
          } else if (c.op === "provider") throw new Error("OpenClaw picks the provider with the model (provider/model)");
          else if (c.kind === "app") objAt(s, ["mcp", "servers", c.id]).enabled = c.enabled;
          else if (c.kind === "plugin") objAt(s, ["plugins", "entries", c.id]).enabled = c.enabled;
          else objAt(s, ["skills", "entries", c.id]).enabled = c.enabled;
        }
      });
    },
    skillRoots: (d) => [path.join(d.dir, "skills"), path.join(d.home, ".agents", "skills")],
  },
};

/** OpenCode keeps either opencode.json or opencode.jsonc; this is the one it has. */
export const configFileFor = async (harness: string, dir: string, fallback: string) => (harness === "opencode" ? opencodeFile(dir) : fallback);
