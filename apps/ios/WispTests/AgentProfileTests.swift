import XCTest
import SwiftUI
@testable import Wisp

/** The words and little rules behind an agent's profile and its pages (agent-*.dc.html). */
@MainActor
final class AgentProfileTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }

  private func agent(model: String? = nil, settings: String = "{}", status: String = "online", computerId: String? = nil) throws -> Agent {
    let modelJSON = model.map { "\"\($0)\"" } ?? "null"
    let computerJSON = computerId.map { "\"\($0)\"" } ?? "null"
    return try decode(Agent.self, ##"{"id":"a1","name":"Ghosty","handle":"ghosty","harness":"codex","model":\##(modelJSON),"nodeId":"n1","computerId":\##(computerJSON),"groups":[],"settings":\##(settings),"status":"\##(status)"}"##)
  }

  private let catalog = AgentModels.Catalog(
    models: [ModelOption(id: "sol-6.1", label: "sol 6.1", description: nil, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", fast: nil)],
    efforts: ["low", "medium", "high"], defaultModel: "sol-6.1", defaultEffort: "medium")

  // MARK: profile rows

  func testEffortNames() {
    XCTAssertEqual(AgentLine.effort("xhigh"), "Extra")
    XCTAssertEqual(AgentLine.effort("high"), "High")
    XCTAssertEqual(AgentLine.effort("low"), "Low")
    XCTAssertEqual(AgentLine.effort(""), "Default")
  }

  func testModelRow() throws {
    XCTAssertEqual(AgentLine.model(agent: try agent(), catalog: catalog), "Harness default")
    XCTAssertEqual(AgentLine.model(agent: try agent(model: "sol-6.1", settings: ##"{"effort":"high"}"##), catalog: catalog), "sol 6.1 · High")
    XCTAssertEqual(AgentLine.model(agent: try agent(model: "sol-6.1", settings: ##"{"effort":"xhigh","fast":true}"##), catalog: catalog), "sol 6.1 · Extra · Fast")
    // a model the catalog doesn't list shows as its id
    XCTAssertEqual(AgentLine.model(agent: try agent(model: "my-own"), catalog: catalog), "my-own")
    XCTAssertEqual(AgentLine.model(agent: try agent(model: "my-own"), catalog: nil), "my-own")
    // an effort alone still says something
    XCTAssertEqual(AgentLine.model(agent: try agent(settings: ##"{"effort":"low"}"##), catalog: nil), "Low")
  }

  func testComputerRow() throws {
    let ready = try decode(Computer.self, ##"{"id":"c1","name":"Ghosty's desk","kind":"vm","nodeId":"n1","status":"ready","statusText":"Ready","agents":["a1"]}"##)
    let stopped = try decode(Computer.self, ##"{"id":"c1","name":"Ghosty's desk","kind":"vm","nodeId":"n1","status":"stopped","statusText":"Stopped"}"##)
    XCTAssertEqual(AgentLine.computer(agent: try agent(computerId: "c1"), computer: ready), "Ready")
    XCTAssertEqual(AgentLine.computer(agent: try agent(computerId: "c1"), computer: stopped), "Stopped")
    XCTAssertEqual(AgentLine.computer(agent: try agent(status: "busy", computerId: "c1"), computer: ready), "Working")
    XCTAssertEqual(AgentLine.computer(agent: try agent(), computer: nil), "None yet")
    XCTAssertEqual(AgentLine.computer(agent: try agent(settings: ##"{"headless":true}"##), computer: nil), "Headless")
  }

  func testWhereItWorks() throws {
    let screen = try decode(Computer.self, ##"{"id":"c1","name":"Mac","kind":"device","nodeId":"n1","status":"ready","statusText":"Ready"}"##)
    let own = try decode(Computer.self, ##"{"id":"c2","name":"Desk","kind":"vm","nodeId":"n1","status":"ready","statusText":"Ready","agents":["a1"]}"##)
    let shared = try decode(Computer.self, ##"{"id":"c3","name":"Shared","kind":"vm","nodeId":"n1","status":"ready","statusText":"Ready","agents":["a1","a2"]}"##)
    let me = try agent()
    XCTAssertEqual(AgentLine.place(agent: me, computer: screen), .screen)
    XCTAssertEqual(AgentLine.place(agent: me, computer: own), .own)
    XCTAssertEqual(AgentLine.place(agent: me, computer: shared), .other)
    XCTAssertEqual(AgentLine.place(agent: me, computer: nil), .none)
  }

  func testRoutinesAndCounts() throws {
    let on = try decode(Routine.self, ##"{"id":"r1","agentId":"a1","name":"A","notePath":"x.md","enabled":true}"##)
    let paused = try decode(Routine.self, ##"{"id":"r2","agentId":"a1","name":"B","notePath":"y.md","enabled":false}"##)
    XCTAssertEqual(AgentLine.routines([on, on, paused]), "2 on")
    XCTAssertEqual(AgentLine.routines([paused]), "All off")
    XCTAssertEqual(AgentLine.routines([]), "None")
    XCTAssertEqual(AgentLine.count(0), "None")
    XCTAssertEqual(AgentLine.count(4), "4")
  }

  func testWhoCanAskIt() throws {
    XCTAssertEqual(AgentLine.respond(try agent()), "Anyone")
    XCTAssertEqual(AgentLine.respond(try agent(settings: ##"{"respondTo":"me"}"##)), "Only me")
    XCTAssertEqual(AgentLine.respond(try agent(settings: ##"{"respondTo":"people","respondPeople":["u2"]}"##)), "Picked")
    XCTAssertEqual(AskWho.caption("people", people: 0), "Pick at least one person.")
    XCTAssertEqual(AskWho.caption("people", people: 2), "2 people can message it.")
  }

  func testAskWhoSavesPeopleOnlyWhenPicked() {
    let people = AskWho.settings("people", people: ["u3", "u2"])
    XCTAssertEqual(people["respondTo"].flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) }, "\"people\"")
    XCTAssertEqual(people["respondPeople"].flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) }, "[\"u2\",\"u3\"]")
    XCTAssertNil(AskWho.settings("me", people: ["u2"])["respondPeople"])
  }

  func testPermissionChips() {
    XCTAssertEqual(AgentAccess.allCases.map(AgentLine.accessChip), ["Read", "Edit", "Full access"])
    XCTAssertEqual(AgentAccess.from("read-only"), .readOnly)
    XCTAssertEqual(AgentAccess.from("full"), .full)
  }

  // MARK: activity

  func testRunWords() throws {
    let done = try decode(AgentRun.self, ##"{"id":"r1","status":"done","trigger":"draft the release notes\nfor this week","createdAt":"2026-10-25T11:02:00Z","finishedAt":"2026-10-25T11:06:00Z","kind":"message"}"##)
    let failed = try decode(AgentRun.self, ##"{"id":"r2","status":"failed","trigger":null,"createdAt":"2026-10-25T18:12:00Z","finishedAt":"2026-10-25T18:12:38Z","kind":"background"}"##)
    let running = try decode(AgentRun.self, ##"{"id":"r3","status":"running","createdAt":"2026-10-25T11:00:00Z"}"##)
    XCTAssertEqual(RunLine.status(done), "Done")
    XCTAssertEqual(RunLine.status(failed), "Failed")
    XCTAssertEqual(RunLine.status(running), "Working")
    XCTAssertTrue(RunLine.isGood(done))
    XCTAssertTrue(RunLine.isBad(failed))
    XCTAssertEqual(RunLine.title(done), "draft the release notes")
    XCTAssertEqual(RunLine.title(failed), "Background check")
    XCTAssertEqual(RunLine.duration(from: done.createdAt, to: done.finishedAt), "4m")
    XCTAssertEqual(RunLine.duration(from: failed.createdAt, to: failed.finishedAt), "38s")
    XCTAssertEqual(RunLine.duration(from: "2026-10-25T11:00:00Z", to: "2026-10-25T12:04:00Z"), "1h 4m")
    XCTAssertNil(RunLine.duration(from: nil, to: nil))
  }

  // MARK: routines

  func testScheduleDraftRoundTrips() {
    for cron in ["", "0 * * * *", "30 8 * * *", "30 8 * * 1-5", "0 9 * * 5", "*/15 * * * *"] {
      XCTAssertEqual(ScheduleDraft(cron: cron).cron, cron, cron)
    }
    XCTAssertEqual(ScheduleDraft(cron: "0 9 * * 5").repeatMode, .weekly)
    XCTAssertEqual(ScheduleDraft(cron: "0 9 * * 5").day, 5)
    XCTAssertEqual(ScheduleDraft(cron: "0 9 * * 7").day, 0)
    XCTAssertEqual(ScheduleDraft(cron: "*/15 * * * *").repeatMode, .custom)
    var draft = ScheduleDraft(cron: "")
    XCTAssertEqual(draft.repeatMode, .none)
    draft.repeatMode = .weekdays; draft.hour = 8; draft.minute = 30
    XCTAssertEqual(draft.cron, "30 8 * * 1-5")
    XCTAssertTrue(draft.showsTime)
    draft.repeatMode = .hourly
    XCTAssertFalse(draft.showsTime)
  }

  func testRoutineWords() throws {
    let weekly = try decode(Routine.self, ##"{"id":"r1","agentId":"a1","name":"Release","notePath":"x.md","schedule":"0 9 * * 5","enabled":true,"status":"ready"}"##)
    let manual = try decode(Routine.self, ##"{"id":"r2","agentId":"a1","name":"Tidy","notePath":"y.md","enabled":false,"status":"ready"}"##)
    let learning = try decode(Routine.self, ##"{"id":"r3","agentId":"a1","name":"Watch","notePath":"z.md","enabled":true,"status":"learning"}"##)
    XCTAssertTrue(RoutineWords.when(weekly, channel: "Release crew").hasSuffix("posts in Release crew"))
    XCTAssertTrue(RoutineWords.when(manual, channel: nil).hasPrefix("Only when someone runs it"))
    XCTAssertTrue(RoutineWords.when(manual, channel: nil).hasSuffix("posts here"))
    XCTAssertNil(RoutineWords.badge(weekly))
    XCTAssertEqual(RoutineWords.badge(manual), "Paused")
    XCTAssertEqual(RoutineWords.badge(learning), "Learning")
  }

  // MARK: background and edit text

  func testQuietHoursWords() {
    XCTAssertEqual(BackgroundView.clockLong("22:00"), "10 PM")
    XCTAssertEqual(BackgroundView.clockLong("07:30"), "7:30 AM")
    XCTAssertEqual(BackgroundView.quiet("22:00", "07:00"), "10 PM to 7 AM")
    XCTAssertEqual(BackgroundView.quiet("22:00", "22:00"), "Never")
  }

  func testEditText() {
    XCTAssertEqual(AgentEditText.firstLine("# Ghosty\n\n- Warm, brief, double-checks facts\nMore"), "Warm, brief, double-checks facts")
    XCTAssertEqual(AgentEditText.firstLine("# only a heading"), "")
    XCTAssertTrue(AgentEditText.firstLine(String(repeating: "word ", count: 30)).hasSuffix("…"))
    XCTAssertEqual(AgentEditText.insert("Ask before", into: ""), "## Ask before\n- ")
    XCTAssertEqual(AgentEditText.insert("Ask before", into: "## What it owns\n- Releases\n"), "## What it owns\n- Releases\n\n## Ask before\n- ")
    XCTAssertEqual(AgentEditText.snippets.count, 6)
  }

  func testTemplatesAreComplete() throws {
    XCTAssertEqual(AgentTemplate.all.map(\.name), ["Researcher", "Code reviewer", "Planner", "Writer"])
    for template in AgentTemplate.all {
      XCTAssertFalse(template.does.isEmpty)
      XCTAssertTrue(template.instructions.contains("## "))
      // what the create request sends as the role is the whole line, and the hub accepts it
      let draft = AgentDraft()
      draft.does = template.does
      XCTAssertEqual(draft.roleText, template.does)
      XCTAssertLessThanOrEqual(try XCTUnwrap(draft.roleText).count, 60)
    }
    let long = AgentDraft()
    long.does = "  " + String(repeating: "a", count: 90) + " "
    XCTAssertEqual(long.roleText?.count, 60)
    XCTAssertNil(AgentDraft().roleText)
  }

  func testLookLabels() {
    XCTAssertEqual(GhostLabels.label("tophat"), "Top hat")
    XCTAssertEqual(GhostLabels.label("bowtie"), "Bow tie")
    XCTAssertEqual(GhostLabels.label("none"), "None")
    XCTAssertEqual(GhostLabels.label("beanie"), "Beanie")
  }

  func testNewAgentDraftHandleFollowsName() {
    let draft = AgentDraft()
    draft.name = "Release Manager"
    XCTAssertEqual(draft.finalHandle(), "release-manager")
    draft.handle = "rm"
    XCTAssertEqual(draft.finalHandle(), "rm")
    XCTAssertFalse(draft.custom)
    XCTAssertEqual(draft.computer, "later")
  }
}
