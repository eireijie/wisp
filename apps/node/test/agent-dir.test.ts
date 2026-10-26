import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentFolder } from "../src/agent-dir.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wisp-agent-dir-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("an agent's folder on a device", () => {
  it("stays the same when the agent's handle is renamed", () => {
    expect(agentFolder(dir, { id: "a1", handle: "nova" })).toBe("nova");
    expect(agentFolder(dir, { id: "a1", handle: "writer" })).toBe("nova");
  });
  it("doesn't hand a new agent the folder of one that was renamed", () => {
    agentFolder(dir, { id: "a1", handle: "nova" });
    expect(agentFolder(dir, { id: "a2", handle: "nova" })).toMatch(/^nova-/);
    expect(agentFolder(dir, { id: "a2", handle: "nova" })).toBe(agentFolder(dir, { id: "a2", handle: "other" }));
  });
});
