import XCTest
@testable import Wisp

final class MarketplaceTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }

  func testSkillStoreDecodes() throws {
    let list = try decode(SkillStoreList.self, ##"{"skills":[{"id":"anthropic:pdf","name":"PDF","description":"Work with PDFs","source":{"id":"anthropic","label":"Anthropic"},"url":"https://github.com/anthropics/skills/tree/main/skills/pdf","license":{"label":"Apache-2.0","open":true}}],"errors":["Couldn't read OpenAI's skills"]}"##)
    XCTAssertEqual(list.skills.first?.license.open, true)
    XCTAssertEqual(list.skills.first?.source.label, "Anthropic")
    XCTAssertEqual(list.errors?.count, 1)
    XCTAssertNil(try decode(SkillStoreDetail.self, ##"{"skill":{"id":"a:b","name":"B","description":"","source":{"id":"a","label":"A"},"url":"https://x.test","license":{"label":"Proprietary","open":false}},"content":null}"##).content)
  }

  func testLearnedSkillAndAllAgentsDecode() throws {
    let learned = try decode(HelperSkill.self, ##"{"id":"s1","name":"order-pizza","slug":"order-pizza","source":"learned","agentIds":["a1"],"allAgents":true,"learnedBy":"a1","uses":3,"lastUsedAt":"2026-10-29T10:00:00.000Z","createdAt":"2026-10-29T09:00:00.000Z"}"##)
    XCTAssertTrue(learned.isLearned)
    XCTAssertTrue(learned.forAll)
    XCTAssertTrue(learned.has("a9"))
    XCTAssertEqual(learned.uses, 3)
    let names = ["a1": "Ghosty", "a2": "Nova"]
    XCTAssertEqual(SkillText.whoHas(learned, name: { names[$0] }), "All agents")
    XCTAssertEqual(SkillText.meta(learned, name: { names[$0] }, device: { _ in nil }), "Learned by Ghosty · Oct 29 · used 3 times")
    // an older hub: none of the new fields
    let old = try decode(HelperSkill.self, ##"{"id":"s2","name":"PDF","source":"catalog","catalogId":"anthropic:pdf","agentIds":["a1","a2"]}"##)
    XCTAssertFalse(old.forAll); XCTAssertFalse(old.isLearned); XCTAssertNil(old.uses)
    XCTAssertFalse(old.has("a9")); XCTAssertTrue(old.has("a2"))
    XCTAssertEqual(SkillText.whoHas(old, name: { names[$0] }), "2 agents")
    XCTAssertEqual(SkillText.byline(old, name: { names[$0] }, device: { _ in nil }), "Anthropic")
    let one = try decode(HelperSkill.self, ##"{"id":"s3","name":"x","source":"custom","catalogId":"device:n1:codex:x","agentIds":["a2"]}"##)
    XCTAssertEqual(SkillText.whoHas(one, name: { names[$0] }), "Nova")
    XCTAssertEqual(SkillText.byline(one, name: { names[$0] }, device: { $0 == "n1" ? "your Mac" : nil }), "Imported from your Mac")

    let app = try decode(AppConnector.self, ##"{"id":"c1","name":"Linear","kind":"mcp-http","agentIds":[],"allAgents":true}"##)
    XCTAssertTrue(app.has("a1"))
    XCTAssertFalse(try decode(AppConnector.self, ##"{"id":"c2","name":"Old","kind":"secret"}"##).forAll)

    let builtIn = try decode(BuiltInSkillList.self, ##"{"skills":[{"name":"imagegen","description":"Make or edit an image","harness":"codex","harnessLabel":"Codex","agentIds":["a2"]},{"name":"review","harness":"claude-code","harnessLabel":"Claude Code","agentIds":[]}]}"##)
    XCTAssertEqual(builtIn.skills.map(\.id), ["codex:imagegen", "claude-code:review"])
    XCTAssertNil(builtIn.skills[1].description)

    let policy = try decode(AgentPolicy.self, ##"{"askBefore":[],"maxHops":5,"maxRunsPerMinute":20,"defaultAccess":"edit","learnSkills":false}"##)
    XCTAssertEqual(policy.learnSkills, false)
    XCTAssertNil(try decode(AgentPolicy.self, ##"{"askBefore":[],"maxHops":5,"maxRunsPerMinute":20,"defaultAccess":"edit"}"##).learnSkills)
  }

  func testSkillLinkAndFileRoundTrip() throws {
    let skill = SharedSkill(name: "Weekly report — Fridays", description: "Use when asked for a Friday update.", content: "# Weekly report\n\n1. Read the chats.\n2. Write five lines. ✓\n", tags: ["reports", "weekly"])
    let link = SkillShare.link(skill)
    XCTAssertTrue(link.hasPrefix("wisp-skill:"))
    XCTAssertFalse(link.contains(" "))
    XCTAssertEqual(SkillShare.read(link: "Here you go: \(link) (from Sam)"), skill)
    XCTAssertNil(SkillShare.read(link: "https://example.com"))
    XCTAssertNil(SkillShare.read(link: "wisp-skill:not-base64!!"))
    let file = SkillShare.read(file: "---\nname: pdf-tools\ndescription: Work with PDFs\n---\nUse them.\n")
    XCTAssertEqual(file.name, "PDF tools"); XCTAssertEqual(file.description, "Work with PDFs"); XCTAssertEqual(file.content, "Use them.")
    XCTAssertEqual(SkillShare.read(file: "# Standup summary\n\nOne paragraph.", name: "notes.md").name, "Standup summary")
    XCTAssertEqual(SkillShare.read(file: "Just words.", name: "my-skill/SKILL.md").name, "My skill")
    let made = try decode(HelperSkill.self, ##"{"id":"s1","name":"Weekly report","slug":"weekly-report","description":"Use when asked.","content":"# Weekly report\n"}"##)
    let written = SkillShare.file(made)
    XCTAssertEqual(SkillShare.read(file: written).name, "Weekly report")
  }

  func testHarnessEffortAndLogins() throws {
    let codex = try decode(HarnessSettings.self, ##"{"harness":"codex","configPath":"/c","model":null,"provider":"openai","providers":[],"apps":[],"plugins":[],"skills":[],"effort":"high"}"##)
    XCTAssertTrue(codex.hasEffort); XCTAssertEqual(codex.effort, "high")
    let claude = try decode(HarnessSettings.self, ##"{"harness":"claude-code","configPath":"/c","model":null,"provider":null,"providers":null,"apps":[],"plugins":[],"skills":[]}"##)
    XCTAssertFalse(claude.hasEffort)
    let logins = try decode(LoginsResponse.self, ##"{"source":{"kind":"1password","label":"1Password","vaultName":"Agents","connectedBy":"u1","connectedAt":"2026-10-25T00:00:00Z"},"logins":[{"id":"i1","title":"GitHub","site":"github.com","username":"yug","always":["a1"]}],"problem":null}"##)
    XCTAssertEqual(logins.logins.first?.site, "github.com"); XCTAssertEqual(logins.source?.vaultName, "Agents")
  }

  func testShelfDecodesAndRules() throws {
    let shelves = try decode([DeviceShelf].self, ##"[{"nodeId":"n1","nodeName":"MacBook","online":true,"items":[{"key":"claude-code:skill:pdf","harness":"claude-code","kind":"skill","name":"pdf","description":"Read PDFs","path":"/x"},{"key":"codex:mcp:github","harness":"codex","kind":"mcp","name":"github","path":"/y","transport":"http","url":"https://api.example.com/mcp","headers":["Authorization"]},{"key":"codex:mcp:db","harness":"codex","kind":"mcp","name":"db","path":"/z","transport":"stdio","command":"npx","args":["db"],"secrets":["DB_KEY"]}]}]"##)
    let items = shelves[0].items
    XCTAssertEqual(items[0].skillId, "pdf")
    XCTAssertTrue(items[1].readyAsIs)   // only a login header: Wisp signs in itself
    XCTAssertFalse(items[2].readyAsIs)  // a secret stayed on the device
    XCTAssertEqual(ShelfLogic.summary(items), "1 skill and 2 apps")
    XCTAssertEqual(ShelfLogic.skillId("n1", items[0]), "device:n1:claude-code:pdf")
    let have = try decode([HelperSkill].self, ##"[{"id":"s1","name":"PDF","slug":"pdf","catalogId":"device:n1:claude-code:pdf"}]"##)
    XCTAssertTrue(ShelfLogic.inWisp("n1", items[0], skills: have, connectors: []))
    XCTAssertEqual(ShelfLogic.pending(shelves, skills: have, connectors: []).count, 2)
    let form = ShelfLogic.connector("n1", items[2])
    XCTAssertEqual(form.kind, "mcp-stdio"); XCTAssertEqual(form.fields?.first?.key, "DB_KEY"); XCTAssertEqual(form.id, "device:n1:codex:db")
    XCTAssertEqual(ShelfLogic.connector("n1", items[1]).kind, "mcp-http")
  }

  func testTrustLabels() throws {
    func entry(_ json: String) throws -> MarketplaceEntry { try decode(MarketplaceEntry.self, json) }
    let unknown = try entry(##"{"id":"io.github.x/app","name":"App","publisher":"x","brand":"x","verified":false,"installs":[]}"##)
    XCTAssertEqual(MarketText.trust(unknown).kind, .unverified)
    XCTAssertNotNil(MarketText.summary(unknown, MarketplaceInstall(kind: "mcp-http", label: "Remote")).caution)
    let maker = try entry(##"{"id":"com.notion/mcp","name":"Notion","publisher":"com.notion","brand":"notion","domain":"notion.com","verified":true,"installs":[]}"##)
    XCTAssertEqual(MarketText.trust(maker).text, "Made by Notion")
    let other = try entry(##"{"id":"com.acme/tool","name":"Gmail","publisher":"com.acme","brand":"acme","domain":"acme.com","verified":true,"installs":[]}"##)
    XCTAssertEqual(MarketText.trust(other).kind, .verified)
  }

  func testText() {
    XCTAssertEqual(MarketText.slug("Weekly meal plan!"), "weekly-meal-plan")
    XCTAssertEqual(MarketText.skillTitle("mcp-builder"), "MCP builder")
    XCTAssertEqual(MarketText.whatItsFor("Use when asked to plan meals. More text."), "When asked to plan meals.")
    XCTAssertEqual(MarketText.trySuggestion(name: " PDF ", description: "Use when asked to read PDFs."), "Please use your \"PDF\" skill for this. (It is for this: when asked to read PDFs.) Here is what I have: ")
    XCTAssertEqual(MarketText.skillSymbol("xlsx-tools"), "tablecells")
  }
}
