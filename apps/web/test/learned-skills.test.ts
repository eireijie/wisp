import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, AgentCommand, MessagePart, Skill } from "@wisp/core";

vi.mock("../src/api.ts", () => ({ api: vi.fn() }));
vi.mock("../src/theme.ts", () => ({ motionReduced: () => false, useMotionReduced: () => true, THEMES: [], useAppearance: () => ({}) }));
vi.mock("../src/store.ts", () => ({
  useStore: Object.assign((select: (s: unknown) => unknown) => select({ agents: [], me: null }), { getState: () => ({}), subscribe: () => () => {} }),
  conversationKey: (c: string) => c,
  useNames: () => ({ agent: () => undefined }),
}));

const { skillByline, skillHolders, skillMeta, whoPatch, whoValue, builtInId } = await import("../src/views/SkillsView.tsx");
const { skillSections } = await import("../src/views/settings/skills.tsx");
const { orderSlashRows, slashSection, commandGroup } = await import("../src/components/SlashMenu.tsx");
const { AgentPicker } = await import("../src/components/ShopParts.tsx");
const { SkillLines } = await import("../src/views/ChannelView.tsx");
const { href, parseRoute } = await import("../src/router.ts");

const agent = (id: string, name: string, harness = "codex") => ({ id, name, handle: name.toLowerCase(), harness, status: "idle", settings: {} }) as unknown as Agent;
const ghosty = agent("a1", "Ghosty");
const nova = agent("a2", "Nova", "claude-code");
const agents = [ghosty, nova];

const skill = (o: Partial<Skill>): Skill => ({
  id: "s1",
  slug: "order-pizza",
  name: "order-pizza",
  description: "Order the usual from Ordering360",
  tags: [],
  source: "learned",
  catalogId: null,
  content: "1. Open Ordering360",
  agentIds: ["a1"],
  allAgents: false,
  learnedBy: "a1",
  uses: 0,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-10-29T12:00:00Z",
  updatedAt: "2026-10-29T12:00:00Z",
  ...o,
}) as Skill;

describe("skill lines in Settings → Skills", () => {
  it("says who has a skill", () => {
    expect(skillHolders(skill({ allAgents: true }), agents)).toBe("All agents");
    expect(skillHolders(skill({ agentIds: ["a2"] }), agents)).toBe("Nova");
    expect(skillHolders(skill({ agentIds: ["a1", "a2"] }), agents)).toBe("2 agents");
    expect(skillHolders(skill({ agentIds: [] }), agents)).toBe("No agents");
    expect(skillHolders(skill({ agentIds: ["gone"] }), agents)).toBe("No agents");
  });

  it("says where it came from", () => {
    expect(skillByline(skill({}), agents)).toBe("Ghosty · Oct 29");
    expect(skillByline(skill({ source: "catalog", catalogId: "anthropic:docx" }), agents)).toBe("Anthropic");
    expect(skillByline(skill({ source: "catalog", catalogId: "meal-plan" }), agents)).toBe("Wisp");
    expect(skillByline(skill({ source: "catalog", catalogId: "device:n1:codex:humanizer" }), agents, (id) => (id === "n1" ? "your Mac" : undefined))).toBe("Imported from your Mac");
    expect(skillByline(skill({ source: "custom" }), agents)).toBe("Made here");
  });

  it("puts learned-by, the date and uses under a skill's name", () => {
    expect(skillMeta(skill({ uses: 3 }), agents)).toBe("Learned by Ghosty · Oct 29 · used 3 times");
    expect(skillMeta(skill({ uses: 1 }), agents)).toBe("Learned by Ghosty · Oct 29 · used once");
    expect(skillMeta(skill({ uses: 0 }), agents)).toBe("Learned by Ghosty · Oct 29");
    expect(skillMeta(skill({ source: "custom", uses: 2 }), agents)).toBe("Made here · updated Oct 29 · used 2 times");
  });

  it("maps Who can use it to the API", () => {
    expect(whoValue(skill({}), agents)).toBe("just");
    expect(whoValue(skill({ allAgents: true }), agents)).toBe("all");
    expect(whoValue(skill({ source: "custom" }), agents)).toBe("some");
    // the agent that learned it is gone: pick agents instead
    expect(whoValue(skill({ learnedBy: "gone" }), agents)).toBe("some");
    expect(whoPatch(skill({}), "all")).toEqual({ allAgents: true });
    expect(whoPatch(skill({}), "just")).toEqual({ allAgents: false, agentIds: ["a1"] });
    expect(whoPatch(skill({}), "some")).toEqual({ allAgents: false });
  });

  it("groups the list Learned, Built in, Added, and filters by tab", () => {
    const list = [skill({ id: "x", name: "docx", source: "catalog" }), skill({ id: "old", createdAt: "2026-10-01T00:00:00Z", name: "weekly-report" }), skill({})];
    const builtIn = [{ name: "security-review", harness: "claude-code", harnessLabel: "Claude Code", agentIds: ["a2"] }, { name: "imagegen", harness: "codex", harnessLabel: "Codex", agentIds: ["a1"] }];
    const all = skillSections(list, builtIn, "all");
    expect(all.map((s) => s.title)).toEqual(["Learned", "Built in", "Added"]);
    expect(all[0].rows.map((r) => r.skill.name)).toEqual(["order-pizza", "weekly-report"]);
    expect(all[1].rows.map((r) => r.skill.name)).toEqual(["security-review", "imagegen"]);
    expect(skillSections(list, builtIn, "built-in").map((s) => s.id)).toEqual(["built-in"]);
    expect(skillSections(list, [], "built-in")).toEqual([]);
    expect(skillSections([], builtIn, "all").map((s) => s.id)).toEqual(["built-in"]);
  });

  it("opens a skill's page by route", () => {
    expect(href({ view: "settings", page: "skills", item: "s1" })).toBe("#/settings/skills/s1");
    expect(parseRoute("#/settings/skills/s1")).toEqual({ view: "settings", page: "skills", item: "s1" });
    const id = builtInId({ harness: "claude-code", name: "agent-skills:review" });
    expect(parseRoute(href({ view: "settings", page: "skills", item: id }))).toEqual({ view: "settings", page: "skills", item: id });
    expect(parseRoute("#/settings/skills")).toEqual({ view: "settings", page: "skills" });
  });
});

describe("the / menu", () => {
  const cmd = (name: string, o: Partial<AgentCommand> = {}): AgentCommand => ({ name, description: "", kind: "command", via: "raw", group: "harness", ...o }) as AgentCommand;
  const rows = (list: AgentCommand[], a: Agent = ghosty) => list.map((command) => ({ agent: a, command }));

  it("orders sections learned, harness, Wisp, skills", () => {
    const list = rows([cmd("model", { kind: "wisp", via: "wisp", group: "wisp" }), cmd("docx", { kind: "wisp-skill", via: "prompt", group: "skill" }), cmd("review"), cmd("order-pizza", { kind: "wisp-skill", group: "learned", learnedBy: "Ghosty", isNew: true })]);
    const ordered = orderSlashRows(list);
    expect(ordered.map((r) => r.command.name)).toEqual(["order-pizza", "review", "model", "docx"]);
    expect(ordered.map((r) => slashSection(r).label)).toEqual(["Learned by Ghosty", "Codex", "Wisp", "Skills"]);
  });

  it("puts names that start with what was typed first, inside each section", () => {
    const list = rows([cmd("security-review"), cmd("review"), cmd("context", { kind: "wisp", group: "wisp" })]);
    expect(orderSlashRows(list, "rev").map((r) => r.command.name)).toEqual(["review", "security-review", "context"]);
  });

  it("keeps two harnesses apart, in the order they come", () => {
    const list = [...rows([cmd("imagegen")]), ...rows([cmd("compact")], nova), ...rows([cmd("skill-creator")])];
    expect(orderSlashRows(list).map((r) => slashSection(r).label)).toEqual(["Codex", "Codex", "Claude Code"]);
  });

  it("works out a section for commands from older hubs", () => {
    expect(commandGroup({ kind: "wisp" })).toBe("wisp");
    expect(commandGroup({ kind: "wisp-skill" })).toBe("skill");
    expect(commandGroup({ kind: "skill" })).toBe("harness");
  });
});

describe("All agents in the agent picker", () => {
  it("hides the per-agent switches while it's on", () => {
    const html = renderToStaticMarkup(createElement(AgentPicker, { agents, value: [], onChange: () => {}, allAgents: { on: true, onChange: () => {} } }));
    expect(html).toContain("All agents");
    expect(html).not.toContain("Ghosty");
  });
  it("shows them under it while it's off", () => {
    const html = renderToStaticMarkup(createElement(AgentPicker, { agents, value: ["a1"], onChange: () => {}, allAgents: { on: false, onChange: () => {} } }));
    expect(html).toContain("All agents");
    expect(html).toContain("Ghosty");
    expect(html).not.toContain("Select all");
  });
});

describe("skill lines under a reply", () => {
  it("shows learned first, then used, each linking to the skill", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "Done." } as MessagePart,
      { type: "skill", action: "used", skillId: "s2", slug: "weekly-report" },
      { type: "skill", action: "learned", skillId: "s1", slug: "order-pizza" },
    ];
    const html = renderToStaticMarkup(createElement(SkillLines, { parts }));
    expect(html.indexOf("Learned: order-pizza")).toBeLessThan(html.indexOf("Using weekly-report"));
    expect(html).toContain('href="#/settings/skills/s1"');
    expect(html).toContain('href="#/settings/skills/s2"');
  });
  it("renders nothing without skill parts", () => {
    expect(renderToStaticMarkup(createElement(SkillLines, { parts: [] }))).toBe("");
  });
});
