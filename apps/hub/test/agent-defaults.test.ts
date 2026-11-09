import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountsSignedIn, preferSignedIn, type HarnessCatalog } from "@wisp/core";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { agentDefaults, saveAgentDefaults } from "../src/agent-defaults.ts";

const listed = (harness: string, signedIn: boolean | null): HarnessCatalog => ({ harness, version: "1", models: [], accounts: { default: signedIn } }) as unknown as HarnessCatalog;

function setup() {
  const store = new Store(openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wisp-defaults-")), "hub.sqlite")));
  const ws = store.createWorkspace("Org");
  const owner = store.createUser("o@example.com", "O", "");
  store.addMember(ws.id, owner.id, "owner");
  const node = store.createNode(ws.id, "Test Mac", owner.id);
  return { store, ws: ws.id, node: node.id };
}

describe("which harness a new agent starts on", () => {
  it("prefers one that's signed in, then one nobody can tell about, and only then a signed-out one", () => {
    const state: Record<string, boolean | null> = { "claude-code": false, codex: true, hermes: null };
    expect(preferSignedIn(["claude-code", "codex", "hermes"], (id) => state[id])).toBe("codex");
    expect(preferSignedIn(["claude-code", "hermes"], (id) => state[id])).toBe("hermes");
    expect(preferSignedIn(["claude-code", "claude-code"], (id) => state[id])).toBe("claude-code");
    expect(preferSignedIn([], () => true)).toBeUndefined();
    expect(accountsSignedIn({ default: false, work: true })).toBe(true);
    expect(accountsSignedIn({ default: false })).toBe(false);
    expect(accountsSignedIn({ default: null, work: false })).toBeNull();
    expect(accountsSignedIn(undefined)).toBeNull();
  });

  it("doesn't preselect Claude Code when only Codex is signed in, even after a Claude Code agent was made", () => {
    const { store, ws, node } = setup();
    store.setNodeCatalog(node, [listed("claude-code", false), listed("codex", true)]);
    expect(agentDefaults(store, ws).harness).toBe("codex");
    // the latest agent is on Claude Code (signed out): still Codex
    store.createAgent({ workspaceId: ws, handle: "cleo", name: "Cleo", harness: "claude-code", nodeId: node });
    expect(agentDefaults(store, ws).harness).toBe("codex");
    // once Claude Code is signed in, the latest agent's harness is kept
    store.setNodeCatalog(node, [listed("claude-code", true), listed("codex", true)]);
    expect(agentDefaults(store, ws).harness).toBe("claude-code");
  });

  it("keeps the saved choice unless it's signed out and another is signed in; with none signed in it keeps it (the app offers Sign in)", () => {
    const { store, ws, node } = setup();
    saveAgentDefaults(store, ws, { harness: "claude-code" });
    store.setNodeCatalog(node, [listed("claude-code", null), listed("codex", true)]);
    expect(agentDefaults(store, ws).harness).toBe("claude-code");
    store.setNodeCatalog(node, [listed("claude-code", false), listed("codex", true)]);
    expect(agentDefaults(store, ws).harness).toBe("codex");
    store.setNodeCatalog(node, [listed("claude-code", false), listed("codex", false)]);
    expect(agentDefaults(store, ws).harness).toBe("claude-code");
  });
});
