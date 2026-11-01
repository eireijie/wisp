import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNEL_SETTINGS, builtinRules, channelTeams, covers, pickReviewer, teamChain, teamOf, teamProblem, LoopGuard, parseMentions, parseSubjectKey, accessChecker, signInProblem, startupRules, subjectKey, type AccessRule, type Channel, type ChannelTeam, type Viewer } from "../src/index.ts";

describe("parseMentions", () => {
  it("finds handles, ignores emails and code", () => {
    expect(parseMentions("hey @Atlas and @nova-2, mail a@b.com, `@nope`")).toEqual(["atlas", "nova-2"]);
    expect(parseMentions("```\n@hidden\n```\n@seen")).toEqual(["seen"]);
  });
});

describe("LoopGuard", () => {
  it("enforces hop and rate limits", () => {
    const g = new LoopGuard({ maxHops: 3, maxRunsPerWindow: 2, windowMs: 1000 });
    expect(g.allow("c", 3).ok).toBe(false);
    expect(g.allow("c", 0, 0).ok).toBe(true);
    expect(g.allow("c", 1, 10).ok).toBe(true);
    expect(g.allow("c", 1, 20).ok).toBe(false);
    expect(g.allow("c", 1, 2000).ok).toBe(true);
  });
});

describe("memory access", () => {
  const base = builtinRules({ agents: [{ id: "a" }, { id: "b" }], teams: [{ name: "research", folder: "teams/research", above: ["boss"] }], people: [{ id: "u" }] });
  const atlas: Viewer = { actor: { kind: "agent", id: "a" }, teams: ["research"], teamRoles: [{ team: "research", role: "reviewer" }] };
  const level = (v: Viewer, p: string, extra: AccessRule[] = []) => accessChecker(v, [...base, ...extra])(p).level;
  const member: Viewer = { actor: { kind: "user", id: "u" }, role: "member" };
  const guest: Viewer = { actor: { kind: "user", id: "g" }, role: "guest" };

  it("defaults: agents get shared/, their own folder, their teams' pools and people's folders", () => {
    expect(level(atlas, "shared/x.md")).toBe("edit");
    expect(level(atlas, "agents/a/notes.md")).toBe("edit");
    expect(level(atlas, "agents/b/SOUL.md")).toBe("none");
    expect(level(atlas, "teams/research/plan.md")).toBe("edit");
    expect(level(atlas, "teams/ops/plan.md")).toBe("none");
    expect(level(atlas, "Projects/x.md")).toBe("none");
    expect(level(atlas, "people/u/preferences/short.md")).toBe("edit");
    // the boss a team reports to can use its pool
    expect(level({ actor: { kind: "agent", id: "boss" } }, "teams/research/plan.md")).toBe("edit");
  });

  it("people's folders are theirs, and closed to other people", () => {
    expect(level(member, "people/u/plans/x.md")).toBe("manage");
    expect(level({ actor: { kind: "user", id: "v" }, role: "member" }, "people/u/plans/x.md")).toBe("none");
  });

  it("defaults: people edit everything, guests read shared/, owners manage", () => {
    expect(level(member, "agents/b/SOUL.md")).toBe("edit");
    expect(level(member, "Projects/x.md")).toBe("edit");
    expect(level(guest, "shared/x.md")).toBe("read");
    expect(level(guest, "agents/b/x.md")).toBe("none");
    expect(level({ actor: { kind: "user", id: "o" }, role: "owner" }, "anything.md")).toBe("manage");
  });

  it("folder rules apply inside, and a closer rule overrides them", () => {
    const rules: AccessRule[] = [
      { path: "Projects", subject: { kind: "all_agents" }, level: "read" },
      { path: "Projects/secret", subject: { kind: "all_agents" }, level: "none" },
    ];
    expect(level(atlas, "Projects/plan.md", rules)).toBe("read");
    expect(level(atlas, "projects/Secret/keys.md", rules)).toBe("none");
    // closer path beats a more specific subject further up
    expect(level(atlas, "Projects/secret/keys.md", [...rules, { path: "Projects", subject: { kind: "agent", id: "a" }, level: "edit" }])).toBe("none");
  });

  it("at the same path the most specific subject wins, and stored rules beat defaults", () => {
    expect(level(atlas, "shared/x.md", [{ path: "shared", subject: { kind: "agent", id: "a" }, level: "read" }])).toBe("read");
    expect(level(atlas, "shared/x.md", [{ path: "shared", subject: { kind: "all_agents" }, level: "none" }])).toBe("none");
    expect(level(atlas, "teams/research/x.md", [{ path: "teams/research", subject: { kind: "all_agents" }, level: "none" }])).toBe("edit");
    // two teams at the same spot: the more generous one
    const two: Viewer = { ...atlas, teams: ["research", "ops"] };
    const rules: AccessRule[] = [
      { path: "Docs", subject: { kind: "team", name: "research" }, level: "read" },
      { path: "Docs", subject: { kind: "team", name: "ops" }, level: "edit" },
    ];
    expect(level(two, "Docs/a.md", rules)).toBe("edit");
    // a role on a team beats the whole team
    const roles: AccessRule[] = [
      { path: "teams/research/decisions", subject: { kind: "team", name: "research" }, level: "read" },
      { path: "teams/research/decisions", subject: { kind: "role", team: "Research", role: "Reviewer" }, level: "edit" },
    ];
    expect(level(atlas, "teams/research/decisions/d.md", roles)).toBe("edit");
    expect(level({ ...atlas, teamRoles: [] }, "teams/research/decisions/d.md", roles)).toBe("read");
  });

  it("caps: agents never manage, guests only read, a locked soul is read-only", () => {
    expect(level(atlas, "x.md", [{ path: "", subject: { kind: "agent", id: "a" }, level: "manage" }])).toBe("edit");
    expect(level(guest, "shared/x.md", [{ path: "shared", subject: { kind: "user", id: "g" }, level: "edit" }])).toBe("read");
    expect(level({ ...atlas, soulLocked: true }, "agents/a/soul.md")).toBe("read");
    expect(level({ ...atlas, soulLocked: true }, "agents/a/notes.md")).toBe("edit");
  });

  it("explains which rule decided", () => {
    const d = accessChecker(atlas, base)("shared/deep/x.md");
    expect(d.rule?.path).toBe("shared");
    expect(d.rule?.builtin).toBe(true);
  });

  it("finds startup rules for a viewer", () => {
    const rules: AccessRule[] = [
      { path: "Projects/brief.md", subject: { kind: "team", name: "research" }, level: "read", startup: true },
      { path: "Projects/other.md", subject: { kind: "agent", id: "b" }, level: "read", startup: true },
    ];
    expect(startupRules(atlas, [...base, ...rules]).map((r) => r.path)).toEqual(["Projects/brief.md"]);
  });

  it("round-trips subject keys and covers paths", () => {
    for (const s of [{ kind: "agent", id: "x" }, { kind: "team", name: "a:b" }, { kind: "role", team: "web", role: "code/review" }, { kind: "members" }, { kind: "all_agents" }] as const) expect(parseSubjectKey(subjectKey(s))).toEqual(s);
    expect(parseSubjectKey("agent:")).toBeNull();
    expect(covers("", "a/b.md")).toBe(true);
    expect(covers("a", "ab/c.md")).toBe(false);
  });
});

import { GHOST_ACCESSORIES, GHOST_EYES, GHOST_HATS, GHOST_PALETTES, GHOST_SHAPES, defaultAppearance } from "../src/index.ts";

describe("teamChain", () => {
  it("follows bosses up through the teams they lead, and stops at loops", () => {
    const teams = [
      { leads: ["lead-web"], reportsTo: "cto" },
      { leads: ["cto"], reportsTo: "ceo" },
      { leads: ["ceo"], reportsTo: "lead-web" },
    ];
    expect(teamChain(teams[0], teams)).toEqual(["cto", "ceo", "lead-web"]);
    expect(teamChain({ reportsTo: null }, teams)).toEqual([]);
  });
});

describe("teamOf", () => {
  const channel = (team: ChannelTeam | null, more: Partial<Channel> = {}): Channel => ({ id: "ch_1", workspaceId: "ws", name: "web", kind: "channel", topic: "", sectionId: null, private: false, archivedAt: null, settings: { ...DEFAULT_CHANNEL_SETTINGS, team }, createdAt: "", ...more });
  const chart: ChannelTeam = {
    nodes: [
      { agentId: "a", lead: true, x: 0, y: 0, role: "Lead" },
      { agentId: "b", lead: false, x: 0, y: 100, role: " Reviewer ", roleNotes: "Checks it" },
    ],
    edges: [{ from: "a", to: "b" }],
    folder: "/teams/web/",
    repo: " /srv/web ",
    reportsTo: "boss",
  };
  it("reads a channel's chart as its team, named and keyed by the channel", () => {
    expect(teamOf(channel(chart))).toEqual({
      id: "ch_1",
      channelId: "ch_1",
      workspaceId: "ws",
      name: "web",
      leads: ["a"],
      leadId: "a",
      reportsTo: "boss",
      folder: "teams/web",
      repo: "/srv/web",
      baseBranch: "main",
      members: [
        { agentId: "a", role: "Lead", roleNotes: "", lead: true, managerId: null },
        { agentId: "b", role: "Reviewer", roleNotes: "Checks it", lead: false, managerId: "a" },
      ],
    });
  });
  it("has no team without a chart, in a DM, or once archived", () => {
    expect(teamOf(channel(null))).toBeNull();
    expect(teamOf(channel({ ...chart, nodes: [] }))).toBeNull();
    expect(teamOf(channel(chart, { kind: "dm" }))).toBeNull();
    expect(teamOf(channel(chart, { archivedAt: "2026-01-01" }))).toBeNull();
    expect(channelTeams([channel(chart), channel(null, { id: "ch_2" })]).map((t) => t.id)).toEqual(["ch_1"]);
  });
  it("won't let a team report to one of its own", () => {
    expect(teamProblem({ ...chart, reportsTo: "b" })).toMatch(/report/);
    expect(teamProblem(chart)).toBeNull();
  });
});

describe("default ghost", () => {
  it("is stable per seed and always valid", () => {
    expect(defaultAppearance("nova")).toEqual(defaultAppearance("nova"));
    for (const seed of ["a", "nova", "atlas", "hermes", "x".repeat(40), ""]) {
      const g = defaultAppearance(seed);
      expect(GHOST_SHAPES).toContain(g.shape);
      expect(GHOST_EYES).toContain(g.eyes);
      expect(GHOST_HATS).toContain(g.hat);
      expect(GHOST_ACCESSORIES).toContain(g.accessory);
      expect(GHOST_PALETTES.map((p) => `${p.color}/${p.color2}`)).toContain(`${g.color}/${g.color2}`);
    }
    const shapes = new Set(Array.from({ length: 40 }, (_, i) => defaultAppearance(`agent-${i}`).shape));
    expect(shapes.size).toBeGreaterThan(2); // agents don't all look alike
  });
});

describe("signInProblem", () => {
  it("turns a harness's sign-in error into what to do on the device", () => {
    const claude = signInProblem("claude-code", "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.");
    expect(claude?.explain("my-mac")).toBe("Claude Code on my-mac isn't signed in. Open Settings → Harnesses, sign in to Claude Code on my-mac, then ask again.");
    expect(signInProblem("codex", "Error: Not logged in. Run `codex login`.")?.login).toBe("codex login");
    expect(signInProblem("gemini", "not authenticated")?.label).toBe("Gemini CLI");
  });
  it("leaves other errors alone", () => {
    expect(signInProblem("claude-code", "harness crashed")).toBeNull();
    expect(signInProblem("codex", "exited with code 1")).toBeNull();
    expect(signInProblem("custom", "not logged in")).toBeNull();
  });
});

describe("pickReviewer", () => {
  const c = (agentId: string, harness: string, role = "", lead = false) => ({ agentId, harness, role, lead });
  const builder = { agentId: "b", harness: "codex" };

  it("prefers a reviewer role, then another harness, then the lead, and never the builder", () => {
    expect(pickReviewer(builder, [c("b", "codex"), c("k", "kimi"), c("r", "claude-code", "Reviewer"), c("l", "hermes", "", true)])).toBe("r");
    expect(pickReviewer(builder, [c("c2", "codex", "Code reviewer"), c("k", "kimi")])).toBe("c2");
    expect(pickReviewer(builder, [c("c2", "codex"), c("k", "kimi")])).toBe("k");
    expect(pickReviewer(builder, [c("c2", "codex"), c("c3", "codex", "", true)])).toBe("c3");
    expect(pickReviewer(builder, [c("b", "codex", "Reviewer", true)])).toBeNull();
    expect(pickReviewer(builder, [])).toBeNull();
  });

  it("among reviewers, takes the one on another harness", () => {
    expect(pickReviewer(builder, [c("a", "codex", "Reviewer"), c("z", "claude-code", "Reviewer")])).toBe("z");
  });
});

describe("/ commands", () => {
  it("reads a command after an optional @mention of its agent", async () => {
    const { parseCommand, agentCommands } = await import("../src/commands.ts");
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseCommand("@poopy /review 42", "poopy")).toEqual({ name: "review", args: "42" });
    expect(parseCommand("@nova /review 42", "poopy")).toBeNull();
    expect(parseCommand("@poopyx /review", "poopy")).toBeNull();
    expect(parseCommand("look at /etc")).toBeNull();
    expect(agentCommands([{ name: "context", kind: "command", via: "raw" }], [{ slug: "pdf", description: "PDFs" }]).map((c) => c.kind)).toEqual(["wisp", "wisp", "wisp", "wisp", "wisp-skill"]);
  });

  it("groups the menu: learned skills, the harness's own, Wisp's, then other skills", async () => {
    const { agentCommands } = await import("../src/commands.ts");
    const now = Date.parse("2026-10-29T12:00:00Z");
    const list = agentCommands(
      [
        { name: "review", description: "Harness review", kind: "command", via: "raw", builtIn: true },
        { name: "pdf", description: "Harness PDFs", kind: "skill", via: "raw" },
        { name: "model", kind: "command", via: "raw" },
      ],
      [
        { slug: "pdf", description: "Wisp PDFs" },
        { slug: "notes", description: "Take notes" },
        { slug: "review", description: "My way", learnedBy: "Ghosty", createdAt: "2026-10-28T00:00:00Z" },
        { slug: "pizza", description: "Order pizza", learnedBy: "Nova", createdAt: "2026-10-01T00:00:00Z" },
        { slug: "context", description: "A learned name Wisp already uses", learnedBy: "Nova" },
      ],
      now,
    );
    expect(list.map((c) => `${c.name}:${c.group}`)).toEqual(["review:learned", "pizza:learned", "pdf:harness", "context:wisp", "model:wisp", "effort:wisp", "harness:wisp", "notes:skill"]);
    expect(list[0]).toEqual({ name: "review", description: "My way", kind: "wisp-skill", via: "prompt", group: "learned", learnedBy: "Ghosty", isNew: true });
    expect(list[1].isNew).toBeUndefined();
    expect(list[2]).toEqual({ name: "pdf", description: "Harness PDFs", kind: "skill", via: "raw", group: "harness" });
  });

  it("reads front matter, block values included", async () => {
    const { frontMatter } = await import("../src/commands.ts");
    expect(frontMatter('---\nname: pdf\ndescription: "Read PDFs"\n---\nbody')).toEqual({ name: "pdf", description: "Read PDFs" });
    expect(frontMatter("---\nname: h\ndescription: |\n  Makes text\n  sound human.\nlicense: MIT\n---\n").description).toBe("Makes text\nsound human.");
  });
});
