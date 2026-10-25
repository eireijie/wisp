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
