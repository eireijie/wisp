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

  it("ranks a name match above a verified listing that only mentions the app in its description", () => {
    const mention = entry({ name: "com.example/mail-tools", title: "Mail tools", description: "Works with gmail and more", ...remote("https://mcp.example.com/mcp") });
    const named = entry({ name: "io.github.someone/gmail-mcp", title: "Gmail", ...remote("https://x.example/mcp") });
    expect(mention.verified).toBe(true);
    expect(named.verified).toBe(false);
    expect(rankMarketplace([mention, named], "gmail").map((e) => e.id)).toEqual([named.id, mention.id]);
  });

  it("ranks a whole-word name match above a substring match, even a verified one", () => {
    const sub = entry({ name: "dev.shveik/agmail", title: "Agmail", ...remote("https://agmail.shveik.dev/mcp") });
    const word = entry({ name: "io.github.x/gmail-tools", title: "Gmail tools", ...remote("https://x.example/mcp") });
    expect(sub.verified).toBe(true);
    expect(rankMarketplace([sub, word], "gmail").map((e) => e.id)).toEqual([word.id, sub.id]);
  });

  it("matches across spaces and dashes", () => {
    const hit = entry({ name: "io.github.x/google-calendar", title: "Calendar helper", ...remote("https://x.example/mcp") });
    const miss = entry({ name: "com.example/other", title: "Other", description: "google calendar too", ...remote("https://mcp.example.com/mcp") });
    expect(rankMarketplace([miss, hit], "google calendar")[0].id).toBe(hit.id);
  });
});
