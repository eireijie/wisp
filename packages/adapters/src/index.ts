import { HARNESSES } from "@wisp/core";
import { acpAdapter } from "./acp.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import type { HarnessAdapter } from "./types.ts";

export * from "./types.ts";
export { claudeCommands, codexCommands, commandsIn, skillsIn } from "./commands.ts";
export { scanShelf, serverItem } from "./shelf.ts";
export { HarnessAccounts, loginCommand, modelLoginCommand, setupTokenFrom } from "./harness-accounts.ts";
export { changeHarnessSettings, editClaude, editCodex, editHermes, HARNESS_SPECS, harnessConfigPath, harnessConfigured, harnessDir, parseToml, readHarnessSettings, readHarnessSkill, type HarnessHomes } from "./harness-config.ts";
export { RunFiles, commandVersion, execCommand, runJsonl, spawnCommand, stopProcess } from "./process.ts";
export { claudeCode, claudeArgs, claudeEnv, claudeMcpConfig, claudePlan, claudeUsage, parseClaudeLine } from "./claude-code.ts";
export { codex, codexArgs, codexConnectionArgs, codexDefaults, codexEnv, codexMcpConfig, codexPlan, codexTokens, codexUsageFromRollout, parseCodexCatalog, parseCodexLine, runCodexHome } from "./codex.ts";
export { codexAuthFromHermes, hermesEntryFromCodex, localCredentialFs, prepareCredential, type CredentialFs, type CredentialPlaces, type PreparedCredential } from "./credentials.ts";
export { AcpConnection, acpAdapter, acpCommands, acpUsage, acpMcpServers, acpModels, parseAcpUpdate, permissionOutcome } from "./acp.ts";

/**
 * Registered harnesses: Claude Code and Codex have their own adapters; every harness that
 * speaks the Agent Client Protocol goes through the ACP adapter.
 */
export const adapters: Record<string, HarnessAdapter> = {
  [claudeCode.id]: claudeCode,
  [codex.id]: codex,
  ...Object.fromEntries(HARNESSES.filter((h) => h.protocol === "acp").map((h) => [h.id, acpAdapter({ id: h.id, label: h.label, binary: h.binary, args: h.acpArgs ?? [], vm: { binary: h.binary, args: h.acpArgs ?? [] } })])),
};

/** A device's own harness settings in node.json: overrides for known ones, or new ACP agents ("acp:<name>"). */
export interface DeviceHarness {
  label?: string;
  command?: string;
  args?: string[];
}

/** The adapters this device runs: the built-in ones with its overrides applied, plus the ones it declared. */
export function deviceAdapters(declared: Record<string, DeviceHarness> = {}): Record<string, HarnessAdapter> {
  const out = { ...adapters };
  for (const [id, h] of Object.entries(declared)) {
    const known = HARNESSES.find((x) => x.id === id);
    if (known?.protocol === "native") continue; // their CLIs aren't ACP; configure them with harnessOptions
    if (!known && !id.startsWith("acp:")) continue;
    if (!h.command && !known) continue;
    out[id] = acpAdapter({ id, label: h.label ?? known?.label ?? id.slice(4), binary: h.command ?? known!.binary, args: h.args ?? known?.acpArgs ?? [], vm: known?.acpArgs ? { binary: known.binary, args: known.acpArgs } : undefined });
  }
  return out;
}
