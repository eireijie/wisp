import { describe, expect, it } from "vitest";
import { appCategory, entryLogos, linkedSkillContent, logoIndex, logoSlug, looksSecret, redactServer, shelfSummary, skillLicense, skillTitle, titleToSlug, ShelfItem } from "../src/index.ts";

const index = logoIndex([
  { title: "Notion", hex: "000000" },
  { title: "Google Calendar", slug: "googlecalendar", hex: "4285F4" },
  { title: "GitHub", hex: "181717" },
  { title: "Square", hex: "3E4348" },
  { title: "Hugging Face", hex: "FFD21E", aliases: { aka: ["HF"] } },
  { title: "monday.com", hex: "FF3D57" },
]);

describe("logos", () => {
  it("follows Simple Icons' slug rule", () => {
    expect(titleToSlug("monday.com")).toBe("mondaydotcom");
    expect(titleToSlug("Hugging Face")).toBe("huggingface");
    expect(titleToSlug("C++")).toBe("cplusplus");
  });

  it("matches a whole brand name, ignoring filler words", () => {
    expect(logoSlug(["Google Calendar MCP"], index)).toBe("googlecalendar");
    expect(logoSlug(["GitHub MCP Server"], index)).toBe("github");
    expect(logoSlug(["hf"], index)).toBe("huggingface");
    expect(logoSlug(["monday.com"], index)).toBe("mondaydotcom");
  });

  it("never matches a brand that is only a word inside the name", () => {
    expect(logoSlug(["Square Root Calculator"], index)).toBeNull();
    expect(logoSlug(["Notion Clone Kit"], index)).toBeNull();
  });

  it("falls through names in order: display name, then the publisher's brand", () => {
    expect(logoSlug(["Rovo", "notion"], index)).toBe("notion");
    expect(logoSlug([null, "", "Nothing here"], index)).toBeNull();
  });

  it("tries the registry's own icon before the brand's logo", () => {
    expect(entryLogos({ id: "com.notion/mcp", name: "Notion", brand: "notion", icon: "https://notion.com/i.png" })).toEqual(["https://notion.com/i.png", "/api/logo?for=Notion&for=mcp&for=notion"]);
    expect(entryLogos({ id: "com.mintmcp/gmail", name: "Gmail", brand: "mintmcp", icon: null })).toEqual(["/api/logo?for=Gmail&for=gmail&for=mintmcp"]);
  });
});

describe("app categories", () => {
  it("shelves apps by their name, then what they do", () => {
    expect(appCategory({ name: "Gmail", description: "Read and send email" })).toBe("Email and calendar");
    expect(appCategory({ name: "Stripe" })).toBe("Finance");
    expect(appCategory({ name: "Acme", description: "Query your Postgres database" })).toBe("Data");
    expect(appCategory({ name: "Notion" })).toBe("Docs and notes");
    expect(appCategory({ name: "Mystery", description: "" })).toBeNull();
  });
});

describe("public skills", () => {
  it("copies only open-source skills", () => {
    expect(skillLicense("Proprietary. LICENSE.txt has complete terms", "© 2025 Anthropic, PBC. All rights reserved.")).toEqual({ label: "Proprietary", open: false });
    expect(skillLicense("Complete terms in LICENSE.txt", "                                 Apache License\n                           Version 2.0, January 2004")).toEqual({ label: "Apache-2.0", open: true });
    expect(skillLicense(undefined, "MIT License\n\nCopyright (c)")).toEqual({ label: "MIT", open: true });
    expect(skillLicense(undefined, undefined)).toEqual({ label: "No license", open: false });
    expect(skillLicense(undefined, undefined, "Apache-2.0")).toEqual({ label: "Apache-2.0", open: true });
    expect(skillLicense(undefined, "CC BY-NC 4.0").open).toBe(false);
  });

  it("names skills from their folder", () => {
    expect(skillTitle("frontend-design")).toBe("Frontend design");
    expect(skillTitle("mcp-builder")).toBe("MCP builder");
    expect(skillTitle("gh-fix-ci")).toBe("GH fix CI");
    expect(skillTitle("chatgpt-apps")).toBe("ChatGPT apps");
  });

  it("points a skill's own files at its source instead of copying them", () => {
    const out = linkedSkillContent("Read [the forms guide](forms.md) and run [this](./scripts/fill.py). See [docs](https://x.dev) or [below](#steps).", "https://github.com/o/r/tree/main/skills/pdf", "https://raw.githubusercontent.com/o/r/main/skills/pdf", { label: "Apache-2.0", open: true }, "OpenAI's skills");
    expect(out).toContain("](https://raw.githubusercontent.com/o/r/main/skills/pdf/forms.md)");
    expect(out).toContain("](https://raw.githubusercontent.com/o/r/main/skills/pdf/scripts/fill.py)");
    expect(out).toContain("](https://x.dev)");
    expect(out).toContain("](#steps)");
    expect(out).toContain("From OpenAI's skills: https://github.com/o/r/tree/main/skills/pdf (Apache-2.0)");
  });
});

describe("what's on a device", () => {
  it("spots credentials without flagging ordinary values", () => {
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksSecret("sk-proj-AbCdEf1234567890")).toBe(true);
    expect(looksSecret("Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm")).toBe(true);
    expect(looksSecret("/Users/me/.codex")).toBe(false);
    expect(looksSecret("registry.modelcontextprotocol.io")).toBe(false);
    expect(looksSecret("@modelcontextprotocol/server-github")).toBe(false);
    expect(looksSecret("1000")).toBe(false);
    expect(looksSecret("postgres://me:pw@db.example.com/app")).toBe(true);
    expect(looksSecret("postgres://db.example.com/app")).toBe(false);
  });

  it("keeps secret values on the device and leaves placeholders", () => {
    const r = redactServer({
      command: "npx",
      args: ["-y", "@acme/mcp", "--api-key", "sk-live-1234567890abcdef", "--region=us", "--token=abc"],
      env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret", NODE_PATH: "/usr/lib/node", LOG_LEVEL: "debug" },
    });
    expect(r.args).toEqual(["-y", "@acme/mcp", "--api-key", "{{API_KEY}}", "--region=us", "--token={{TOKEN}}"]);
    expect(r.env).toEqual({ NODE_PATH: "/usr/lib/node", LOG_LEVEL: "debug" });
    expect(r.secrets.sort()).toEqual(["API_KEY", "GITHUB_TOKEN", "TOKEN"]);
    expect(JSON.stringify(r)).not.toMatch(/sk-live|ghp_secret|=abc/);
  });

  it("strips keys out of a server's address", () => {
    const r = redactServer({ url: "https://mcp.example.com/sse?apiKey=abc123&team=core" });
    expect(r.url).toBe("https://mcp.example.com/sse?apiKey={{APIKEY}}&team=core");
    expect(r.secrets).toEqual(["APIKEY"]);
  });

  it("validates what a device reports", () => {
    expect(ShelfItem.safeParse({ key: "codex:mcp:x", harness: "codex", kind: "mcp", name: "x", path: "~/.codex/config.toml", transport: "http", url: "https://x.dev/mcp", headers: ["Authorization"] }).success).toBe(true);
    expect(ShelfItem.safeParse({ key: "k", harness: "codex", kind: "plugin", name: "x", path: "" }).success).toBe(false);
  });

  it("counts skills and apps for the banner", () => {
    expect(shelfSummary([{ kind: "skill" }, { kind: "skill" }, { kind: "mcp" }])).toBe("2 skills and 1 app");
    expect(shelfSummary([{ kind: "skill" }])).toBe("1 skill");
    expect(shelfSummary([{ kind: "mcp" }, { kind: "mcp" }])).toBe("2 apps");
  });
});
