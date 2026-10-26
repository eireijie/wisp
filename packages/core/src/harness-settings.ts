import { z } from "zod";

/**
 * A harness's own settings on a device (its model, provider, MCP servers, plugins and skills), read
 * from the harness's config file by the device and changed from Wisp: Settings → Harnesses, or an
 * agent asked in chat. Only the device's owner changes them; the device writes the file itself.
 */

/** Harnesses whose config Wisp can read and change. */
export const SETTINGS_HARNESSES = ["hermes", "claude-code", "codex", "gemini", "qwen", "opencode", "goose", "kimi", "cursor", "openclaw"] as const;

/** Model and provider names go into config files as they are, so nothing that could break out of a value. */
export const SETTING_NAME = z.string().min(1).max(200).regex(/^[\w.:/@+-]+$/, "letters, digits and . : / @ + - _ only");

export const HarnessSettingItem = z.object({
  id: z.string().max(300),
  name: z.string().max(200),
  description: z.string().max(300).optional(),
  enabled: z.boolean(),
  /** false when the harness has no off switch for it in its config */
  canToggle: z.boolean(),
  /** an app (MCP server): what it runs or where it connects */
  detail: z.string().max(500).optional(),
});
export type HarnessSettingItem = z.infer<typeof HarnessSettingItem>;

/** One login of a harness on a device; each has its own config folder there, and agents pick one. */
export const HarnessAccount = z.object({
  id: z.string().max(64),
  label: z.string().max(80),
  /** the harness's own folder (~/.codex, ~/.claude, ~/.hermes): the account people had before Wisp */
  isDefault: z.boolean(),
  /** null when the device can't tell */
  signedIn: z.boolean().nullable(),
  /** who it's signed in as, when the harness says (an email or plan name) */
  who: z.string().max(200).optional(),
});
export type HarnessAccount = z.infer<typeof HarnessAccount>;

/** Account ids people pick: lower case, digits and dashes (they name folders on the device). */
export const ACCOUNT_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const HarnessSettings = z.object({
  harness: z.string().max(60),
  /** which account these settings are for */
  account: z.string().max(64).default("default"),
  accounts: z.array(HarnessAccount).max(50).default([]),
  /** its logins live in its folder, so it can have more than one account here */
  multiAccount: z.boolean().default(false),
  /** agents on this device using each account (agent id → account id); the device keeps this */
  agentAccounts: z.record(z.string().max(64)).default({}),
  /** the file Wisp reads and changes */
  configPath: z.string().max(1000),
  model: z.string().max(200).nullable(),
  provider: z.string().max(200).nullable(),
  /** providers to pick from (signed in ones first); null when the harness has no provider setting */
  providers: z.array(z.object({ id: z.string().max(200), signedIn: z.boolean() })).max(100).nullable(),
  /** MCP servers set up in the harness itself */
  apps: z.array(HarnessSettingItem).max(200),
  plugins: z.array(HarnessSettingItem).max(500),
  skills: z.array(HarnessSettingItem).max(500),
  /** what's shown but changed only on the device: the model, the provider, or the whole file (it has comments) */
  fixed: z.array(z.enum(["model", "provider", "file"])).optional(),
  /** models the config itself lists to pick from (Kimi's [models.*]) */
  modelChoices: z.array(z.string().max(200)).max(200).optional(),
  /** the config couldn't be read (shown instead of the settings) */
  error: z.string().max(1000).optional(),
});
export type HarnessSettings = z.infer<typeof HarnessSettings>;

export const HarnessSettingsChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("model"), model: SETTING_NAME }),
  z.object({ op: z.literal("provider"), provider: SETTING_NAME }),
  z.object({ op: z.literal("toggle"), kind: z.enum(["app", "plugin", "skill"]), id: z.string().min(1).max(300), enabled: z.boolean() }),
]);
export type HarnessSettingsChange = z.infer<typeof HarnessSettingsChange>;

/** What can be done to a harness's accounts on a device. */
export const HarnessAccountOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), label: z.string().trim().min(1).max(80) }),
  z.object({ op: z.literal("rename"), account: ACCOUNT_ID, label: z.string().trim().min(1).max(80) }),
  z.object({ op: z.literal("remove"), account: ACCOUNT_ID }),
  /** which account an agent on this device uses (null: the default one) */
  z.object({ op: z.literal("assign"), agentId: z.string().max(64), account: ACCOUNT_ID.nullable() }),
  /** start signing an account in; `provider` for harnesses that sign in per provider (Hermes) */
  z.object({ op: z.literal("login"), account: ACCOUNT_ID, provider: z.string().max(100).regex(/^[\w.-]+$/).optional() }),
  /** type into the sign-in (a code the page showed after you approved) */
  z.object({ op: z.literal("login_input"), loginId: z.string().max(64), text: z.string().max(2000) }),
  z.object({ op: z.literal("login_status"), loginId: z.string().max(64) }),
  z.object({ op: z.literal("login_cancel"), loginId: z.string().max(64) }),
]);
export type HarnessAccountOp = z.infer<typeof HarnessAccountOp>;

/** A sign-in running on the device: the link to open and the code to enter, as the harness printed them. */
export const HarnessLogin = z.object({
  id: z.string().max(64),
  harness: z.string().max(60),
  account: z.string().max(64),
  status: z.enum(["running", "done", "failed"]),
  url: z.string().max(2000).optional(),
  code: z.string().max(100).optional(),
  /** the last lines the sign-in printed (links and codes only matter; nothing secret is printed) */
  output: z.string().max(4000),
  error: z.string().max(1000).optional(),
});
export type HarnessLogin = z.infer<typeof HarnessLogin>;

/** A skill's file, read from a harness to share it with other agents as a Wisp skill. */
export const HarnessSkillFile = z.object({ name: z.string().max(200), description: z.string().max(2000), content: z.string().max(100_000) });
export type HarnessSkillFile = z.infer<typeof HarnessSkillFile>;

/** One line for what a change does, for chat and the activity log ("model → gpt-5", "turned off GitHub"). */
export function describeChange(c: HarnessSettingsChange): string {
  if (c.op === "model") return `model → ${c.model}`;
  if (c.op === "provider") return `provider → ${c.provider}`;
  return `turned ${c.enabled ? "on" : "off"} ${c.kind} ${c.id}`;
}
