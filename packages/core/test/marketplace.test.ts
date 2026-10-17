import { describe, expect, it } from "vitest";
import { marketplaceEntry, rankMarketplace, trustLabel, type RegistryServer } from "../src/index.ts";

const remote = (url: string) => ({ remotes: [{ type: "streamable-http", url }] });
const entry = (s: RegistryServer) => {
  const e = marketplaceEntry({ version: "1.0.0", ...s });
  if (!e) throw new Error("no entry");
  return e;
};

describe("trustLabel", () => {
  it("says Made by when a verified publisher ships its own product", () => {
    const e = entry({ name: "com.notion/mcp", title: "Notion", ...remote("https://mcp.notion.com/mcp") });
    const t = trustLabel(e);
    expect(t.kind).toBe("maker");
    expect(t.text).toBe("Made by Notion");
  });

  it("says Made by for a company GitHub org whose product matches", () => {
    const t = trustLabel(entry({ name: "io.github.github/github-mcp-server", title: "GitHub", ...remote("https://api.githubcopilot.com/mcp/") }));
    expect(t.kind).toBe("maker");
  });

  it("does not claim Gmail is made by a verified third party", () => {
    const e = entry({ name: "dev.shveik/agmail", title: "Gmail", ...remote("https://agmail.shveik.dev/mcp") });
    expect(e.verified).toBe(true);
    const t = trustLabel(e);
    expect(t.kind).toBe("verified");
    expect(t.text).toBe("Verified publisher");
    expect(t.explanation).toContain("shveik.dev");
    expect(t.explanation).toMatch(/doesn't mean/);
  });

  it("does not claim a verified company's other product is the app asked about", () => {
    const e = entry({ name: "com.microsoft/learn", title: "Microsoft Learn", ...remote("https://learn.microsoft.com/api/mcp") });
    expect(trustLabel(e, "Gmail").kind).not.toBe("maker");
  });

  it("an app name the listing is not for blocks the maker label", () => {
    const e = entry({ name: "com.notion/mcp", title: "Notion", ...remote("https://mcp.notion.com/mcp") });
    expect(trustLabel(e, "Gmail").kind).toBe("verified");
    expect(trustLabel(e, "notion").kind).toBe("maker");
  });

  it("calls unverified servers Not verified and warns", () => {
    const e = entry({ name: "io.github.domdomegg/gmail-mcp", title: "Gmail", packages: [{ registryType: "npm", identifier: "gmail-mcp", version: "1.0.0", transport: { type: "stdio" } }] });
    expect(e.verified).toBe(false);
    const t = trustLabel(e);
    expect(t.kind).toBe("unverified");
    expect(t.text).toBe("Not verified");
    expect(t.explanation).toMatch(/only add servers you trust/i);
  });

  it("treats aggregators as unverified", () => {
    const e = entry({ name: "ai.smithery/gmail", title: "Gmail", ...remote("https://gmail.smithery.ai/mcp") });
    expect(trustLabel(e).kind).toBe("unverified");
  });
});

describe("rankMarketplace", () => {
  it("puts the maker above a verified third party above unverified", () => {
    const third = entry({ name: "dev.shveik/agmail", title: "Gmail", ...remote("https://agmail.shveik.dev/mcp") });
    const maker = entry({ name: "com.gmail/mcp", title: "Gmail", ...remote("https://mcp.gmail.com/mcp") });
    const none = entry({ name: "io.github.domdomegg/gmail-mcp", title: "Gmail", ...remote("https://x.example/mcp") });
    expect(rankMarketplace([none, third, maker], "gmail").map((e) => e.id)).toEqual([maker.id, third.id, none.id]);
  });
});
