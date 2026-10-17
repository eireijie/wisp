import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, CONNECTOR_HELP, EVERYDAY_APPS, catalogConnector, connectorUnsupportedReason, connectorWorksWith, everydayAppFor, everydayFirst, harnessSupportsConnectors, type ConnectorKind } from "../src/connectors.ts";

const kinds: ConnectorKind[] = ["mcp-http", "mcp-stdio", "secret"];

describe("harnessSupportsConnectors", () => {
  it("native harnesses get every kind", () => {
    for (const id of ["claude-code", "codex"]) for (const k of kinds) expect(harnessSupportsConnectors(id, k)).toBe(true);
  });
  it("acp harnesses get everything but remote servers", () => {
    for (const id of ["gemini", "acp:my-bot"]) {
      expect(harnessSupportsConnectors(id)).toBe(false);
      expect(harnessSupportsConnectors(id, "mcp-http")).toBe(false);
      expect(harnessSupportsConnectors(id, "mcp-stdio")).toBe(true);
      expect(harnessSupportsConnectors(id, "secret")).toBe(true);
    }
  });
  it("mcp harnesses get nothing", () => {
    for (const k of kinds) expect(harnessSupportsConnectors("grok", k)).toBe(false);
    expect(harnessSupportsConnectors("unknown-thing")).toBe(false);
  });
  it("explains why in plain words", () => {
    expect(connectorUnsupportedReason("gemini")).toBe("Gemini CLI can't use connected apps yet");
    expect(connectorUnsupportedReason("grok")).toBe("Grok connects through warren-mcp, so it can't use connected apps here");
    expect(connectorUnsupportedReason("codex")).toBeNull();
    expect(connectorUnsupportedReason("gemini", "secret")).toBeNull();
    expect(CONNECTOR_HELP).toMatch(/Claude Code or Codex/);
  });
  it("connectorWorksWith stays as before", () => {
    expect(connectorWorksWith("mcp-http")).toEqual(["claude-code", "codex"]);
    expect(connectorWorksWith("mcp-stdio")).toEqual(["claude-code", "codex", "acp"]);
    expect(connectorWorksWith("secret")).toEqual(["claude-code", "codex", "acp"]);
  });
});

describe("everydayAppFor", () => {
  it("finds apps by name, alias and partial words", () => {
    expect(everydayAppFor("gmail")?.name).toBe("Gmail");
    expect(everydayAppFor("gmail")?.catalogId).toBeNull();
    expect(everydayAppFor("  Gmail   inbox ")?.name).toBe("Gmail");
    expect(everydayAppFor("slack")?.catalogId).toBe("slack");
    expect(everydayAppFor("google cal")?.name).toBe("Google Calendar");
    expect(everydayAppFor("calendar")?.name).toBe("Google Calendar");
    expect(everydayAppFor("drive")?.name).toBe("Google Drive");
  });
  it("does not match developer things or tiny queries", () => {
    expect(everydayAppFor("git")).toBeNull();
    expect(everydayAppFor("gi")).toBeNull();
    expect(everydayAppFor("")).toBeNull();
  });
  it("every built-in catalogId exists in the catalog", () => {
    for (const a of EVERYDAY_APPS) if (a.catalogId) expect(catalogConnector(a.catalogId)).toBeTruthy();
  });
});

describe("everydayFirst", () => {
  it("puts chat & docs first and developer things last without mutating", () => {
    const before = CONNECTOR_CATALOG.map((c) => c.id);
    const out = everydayFirst(CONNECTOR_CATALOG);
    expect(CONNECTOR_CATALOG.map((c) => c.id)).toEqual(before);
    expect(out).toHaveLength(CONNECTOR_CATALOG.length);
    expect(out.slice(0, 3).map((c) => c.id)).toEqual(["slack", "notion", "gdrive"]);
    const ids = out.map((c) => c.id);
    expect(ids.indexOf("slack")).toBeLessThan(ids.indexOf("github"));
    expect(ids.indexOf("gdrive")).toBeLessThan(ids.indexOf("github"));
    expect(out.at(-1)?.category).toBe("Cloud keys");
  });
});
