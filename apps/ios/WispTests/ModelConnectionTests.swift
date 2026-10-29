import XCTest
@testable import Wisp

/** Models are the brain, harnesses the body: the words and rules behind the run line, the pickers and Settings → Models. */
@MainActor
final class ModelConnectionTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }
  private func json(_ fields: Fields) throws -> String {
    let e = JSONEncoder(); e.outputFormatting = .sortedKeys
    return String(decoding: try e.encode(fields), as: UTF8.self)
  }

  private let claudeSignIn = ##"{"id":"mc1","provider":"anthropic","kind":"oauth","label":"Claude","account":"yug@example.com","plan":"Max","keyHint":null,"createdAt":"2026-10-28T00:00:00Z","updatedAt":"2026-10-28T00:00:00Z","lastUsedAt":null,"lastError":null,"usage":{"window":"5-hour","usedFraction":0.74,"resetsAt":"2026-10-29T05:40:00Z","planType":"max","windows":[{"window":"5-hour","usedFraction":0.74,"resetsAt":"2026-10-29T05:40:00Z"},{"window":"weekly","usedFraction":0.2,"resetsAt":null}],"capturedAt":"2026-10-29T01:00:00Z"},"usedBy":[{"id":"a1","handle":"ghosty","name":"Ghosty"}],"harnesses":["claude-code","hermes"],"mine":true}"##
  private let openrouterKey = ##"{"id":"mc2","provider":"openrouter","kind":"key","label":"OpenRouter key","account":null,"plan":null,"keyHint":"a91f","createdAt":"x","updatedAt":"x","lastUsedAt":null,"lastError":null,"usage":null,"usedBy":[],"harnesses":["claude-code","codex","hermes"],"mine":true}"##

  func testDecodesAConnectionFromTheHub() throws {
    let c = try decode(ModelConnection.self, claudeSignIn)
    XCTAssertTrue(c.isSignIn)
    XCTAssertEqual(c.usage?.windows?.count, 2)
    XCTAssertEqual(c.usedBy?.first?.name, "Ghosty")
    XCTAssertEqual(ModelWords.percentLeft(c.usage!), 26)
  }

  func testConnectionWords() throws {
    let c = try decode(ModelConnection.self, claudeSignIn)
    let k = try decode(ModelConnection.self, openrouterKey)
    XCTAssertEqual(ModelWords.connectionDetail(c), "Signed in · Claude Max · yug@example.com")
    XCTAssertEqual(ModelWords.connectionDetail(k), "API key ····a91f")
    XCTAssertEqual(ModelWords.connectionCaption(kind: "oauth", plan: "Max", keyHint: nil), "Signed in · Max")
    XCTAssertEqual(ModelWords.connectionCaption(kind: "oauth", plan: nil, keyHint: nil), "Signed in")
    XCTAssertEqual(ModelWords.connectionCaption(kind: "key", plan: nil, keyHint: "a91f"), "Key ····a91f")
    XCTAssertEqual(ModelWords.provider("openai"), "ChatGPT")
    XCTAssertEqual(ModelWords.provider("xai"), "Grok")
  }

  func testRunLine() {
    XCTAssertEqual(ModelWords.runLine(harness: "hermes", model: "Opus 5.5", effort: "high"), "Hermes · Opus 5.5 · High")
    XCTAssertEqual(ModelWords.runLine(harness: "codex", model: nil, effort: "xhigh"), "Codex · Extra")
    XCTAssertEqual(ModelWords.runLine(harness: "claude-code", model: "", effort: nil), "Claude Code")
  }

  func testModelLabelPrefersAList() {
    let lists: [[(id: String, label: String)]] = [[("claude-opus-5-5", "Opus 5.5")], [("gpt-6.1", "GPT-6.1")]]
    XCTAssertEqual(ModelWords.modelLabel("claude-opus-5-5", in: lists), "Opus 5.5")
    XCTAssertEqual(ModelWords.modelLabel("gpt-6.1", in: lists), "GPT-6.1")
    XCTAssertEqual(ModelWords.modelLabel("x-ai/grok-5", in: lists), "grok-5")
  }

  func testPlanLine() {
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
    let now = Wire.date("2026-10-29T01:00:00Z")!
    let soon = PlanUsage(window: "5-hour", usedFraction: 0.74, resetsAt: "2026-10-29T05:40:00Z")
    XCTAssertEqual(ModelWords.planLine(soon, now: now, calendar: cal, locale: Locale(identifier: "en_US")), "26% left · resets 5:40 AM")
    let later = PlanUsage(window: "weekly", usedFraction: 0.2, resetsAt: "2026-11-02T05:40:00Z")
    XCTAssertEqual(ModelWords.planLine(later, now: now, calendar: cal, locale: Locale(identifier: "en_US")), "80% left · resets Mon 5:40 AM")
    XCTAssertEqual(ModelWords.planLine(PlanUsage(window: "x", usedFraction: 1.4, resetsAt: nil)), "0% left")
  }

  func testContextLine() {
    XCTAssertEqual(ModelWords.contextLine(used: 98_000, window: 258_000), "98K of 258K")
    XCTAssertEqual(ModelWords.contextLine(used: nil, window: 1_000_000), "0 of 1M")
    XCTAssertNil(ModelWords.contextLine(used: 10, window: nil))
  }

  func testEffortIsKeptOnlyWhenOffered() {
    XCTAssertEqual(ModelWords.keptEffort("high", offered: ["low", "high"]), "high")
    XCTAssertNil(ModelWords.keptEffort("xhigh", offered: ["low", "high"]))
    XCTAssertNil(ModelWords.keptEffort(nil, offered: ["low"]))
  }

  func testSupportTable() throws {
    let support = [CredentialSupport(harness: "codex", provider: "openai", kind: "oauth"), CredentialSupport(harness: "hermes", provider: "openai", kind: "oauth")]
    XCTAssertEqual(ModelWords.harnesses(for: "openai", kind: "oauth", support: support), ["codex", "hermes"])
    let k = try decode(ModelConnection.self, openrouterKey)
    XCTAssertTrue(ModelWords.supports("codex", k, support: []))
    XCTAssertFalse(ModelWords.supports("pi", k, support: []))
  }

  func testWhereAnAgentRuns() throws {
    let computers = try decode(HarnessComputersResponse.self, ##"{"computers":[{"id":"n1","kind":"device","name":"proxmox","nodeId":"n1","online":true,"reported":true,"harnesses":[]},{"id":"vm1","kind":"vm","name":"agent's desk","nodeId":"n1","online":true,"reported":true,"harnesses":[{"id":"codex","label":"Codex","version":"0.162","agents":[{"id":"a1","handle":"ghosty","name":"Ghosty"}]}]}]}"##).computers
    let inVM = try decode(Agent.self, ##"{"id":"a1","name":"Ghosty","handle":"ghosty","harness":"codex","nodeId":"n1","computerId":"vm1","status":"online"}"##)
    let onDevice = try decode(Agent.self, ##"{"id":"a2","name":"Nova","handle":"nova","harness":"codex","nodeId":"n1","status":"online"}"##)
    XCTAssertEqual(HarnessPlace.computer(of: inVM, in: computers)?.name, "agent's desk")
    XCTAssertEqual(HarnessPlace.computer(of: onDevice, in: computers)?.name, "proxmox")
  }

  func testSwitchingHarness() throws {
    let c = try decode(ModelConnection.self, claudeSignIn)
    // Hermes can use the Claude sign-in: model and connection stay
    XCTAssertEqual(try json(HarnessPlace.switchFields(to: "hermes", from: "claude-code", connection: c)), ##"{"harness":"hermes"}"##)
    // Codex can't: both go, back to the computer's own sign-in
    XCTAssertEqual(try json(HarnessPlace.switchFields(to: "codex", from: "claude-code", connection: c)), ##"{"harness":"codex","model":null,"settings":{"connectionId":null}}"##)
    // off a connection, a model id belongs to the old harness
    XCTAssertEqual(try json(HarnessPlace.switchFields(to: "codex", from: "claude-code", connection: nil)), ##"{"harness":"codex","model":null}"##)
  }

  func testContextAndModelsCarryTheConnection() throws {
    let ctx = try decode(AgentContextInfo.self, ##"{"harness":"hermes","model":"claude-opus-5-5","effort":"high","access":"edit","contextUsed":98000,"contextWindow":258000,"efforts":["low","medium","high","max"],"connection":{"id":"mc1","provider":"anthropic","kind":"oauth","label":"Claude","account":null,"plan":"Max"},"plan":{"window":"5-hour","usedFraction":0.74,"resetsAt":null,"capturedAt":"x"}}"##)
    XCTAssertEqual(ctx.efforts, ["low", "medium", "high", "max"])
    XCTAssertEqual(ctx.connection?.provider, "anthropic")
    XCTAssertEqual(ctx.plan.map(ModelWords.percentLeft), 26)
    let models = try decode(AgentModels.self, ##"{"device":null,"computer":null,"catalog":null,"connection":{"id":"mc1","provider":"anthropic","kind":"oauth","label":"Claude","account":null,"plan":"Max","mine":true},"models":[{"id":"claude-opus-5-5","label":"Opus 5.5","efforts":["low","high"],"contextWindow":258000}]}"##)
    let info = RunInfo()
    info.context = ctx
    info.models = models
    let agent = try decode(Agent.self, ##"{"id":"a1","name":"Ghosty","handle":"ghosty","harness":"hermes","status":"online"}"##)
    XCTAssertEqual(info.line(agent), "Hermes · Opus 5.5 · High")
    XCTAssertEqual(info.providerLabel, "Claude")
  }

  func testSignInProgress() throws {
    let l = try decode(ModelLogin.self, ##"{"id":"ml1","provider":"openai","harness":"codex","status":"running","url":"https://auth.openai.com/codex/device","code":"K7QF-2MXD","output":"","nodeId":"n1"}"##)
    XCTAssertTrue(l.running)
    XCTAssertEqual(ModelWords.host(l.url), "auth.openai.com")
    XCTAssertEqual(ModelWords.host("https://www.claude.ai/oauth"), "claude.ai")
  }
}
