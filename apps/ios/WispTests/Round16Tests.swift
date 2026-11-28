import XCTest
@testable import Wisp

/** Round 16 (boards 16, 16b, 16c): Introduce yourself, the Tailscale step, Runs on, Composio's "No apps picked yet", and settings. */
@MainActor
final class Round16Tests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(T.self, from: Data(json.utf8)) }
  private func json(_ v: AnyEncodable?) -> String? { v.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) } }

  // MARK: Introduce yourself (16b)

  func testTheFirstMessageIsTheBoardsExample() {
    XCTAssertEqual(
      SetupGoals.introMessage(agent: "Juno", person: "Sam Lee", goals: ["days", "msgs"], about: "I work weekends and I’m training for a half marathon", talk: .friendly, when: .morning),
      "Hi Juno, I'm Sam. I'd like help keeping my days on track and staying on top of my messages. About me: I work weekends and I’m training for a half marathon. Keep it friendly, and check in each morning.")
  }

  func testTheFirstMessageWithoutPicksOrAName() {
    XCTAssertEqual(SetupGoals.introMessage(agent: "Juno", person: "", goals: [], about: "  ", talk: .short, when: .needed),
                   "Hi Juno! I'm not sure yet what I'd like help with. Keep it short, and only check in when it matters.")
    XCTAssertEqual(SetupGoals.introMessage(agent: "Rae", person: "Sam", goals: ["plans"], about: "student.", talk: .thorough, when: .evening),
                   "Hi Rae, I'm Sam. I'd like help planning trips and weekends. About me: student. Be thorough, and check in each evening.")
    // the order follows the list, not the taps
    XCTAssertTrue(SetupGoals.introMessage(agent: "J", person: "", goals: ["msgs", "days"], about: "", talk: .short, when: .morning).contains("keeping my days on track and staying on top of my messages"))
  }

  // MARK: Tailscale step (16)

  func testTheTailscaleStepOnlyWhenThereIsNoAwayAddress() throws {
    let home = try decode(ReachInfo.self, ##"{"publicUrl":null,"tailscale":{"state":"missing"},"hubPlatform":"darwin"}"##)
    XCTAssertTrue(OnboardingAway.needed(home))
    XCTAssertEqual(OnboardingAway.ticks(home), .init(installed: false, signedIn: false, address: nil))
    // a Cloud server already has an address
    let cloud = try decode(ReachInfo.self, ##"{"publicUrl":"https://bubble.example.com","tailscale":{"state":"missing"}}"##)
    XCTAssertFalse(OnboardingAway.needed(cloud))
  }

  func testTheTicksFillInAsEachPartFinishes() throws {
    let login = try decode(ReachInfo.self, ##"{"tailscale":{"state":"needs-login"}}"##)
    XCTAssertEqual(OnboardingAway.ticks(login), .init(installed: true, signedIn: false, address: nil))
    let running = try decode(ReachInfo.self, ##"{"tailscale":{"state":"running","serving":false,"dnsName":"sam-mac.tail3e1.ts.net."}}"##)
    XCTAssertEqual(OnboardingAway.ticks(running), .init(installed: true, signedIn: true, address: nil))
    let on = try decode(ReachInfo.self, ##"{"publicUrl":"https://sam-mac.tail3e1.ts.net","tailscale":{"state":"running","serving":true,"dnsName":"sam-mac.tail3e1.ts.net."}}"##)
    XCTAssertEqual(OnboardingAway.ticks(on).address, "sam-mac.tail3e1.ts.net")
    XCTAssertFalse(OnboardingAway.needed(on))
  }

  // MARK: Runs on (16c)

  private func nodes() throws -> [AgentNode] {
    try decode([AgentNode].self, ##"[{"id":"n1","name":"Sam’s MacBook","online":true,"mine":true,"capabilities":{"platform":"darwin"}},{"id":"n2","name":"Office PC","online":true,"mine":true,"capabilities":{"platform":"win32"}},{"id":"n3","name":"Living room Mac mini","online":false,"mine":true},{"id":"n4","name":"Ana's laptop","online":true,"mine":false}]"##)
  }

  func testRunsOnListsTheSharedComputerThenYourDevices() throws {
    let o = RunsOn.options(nodes: try nodes())
    XCTAssertEqual(o.map(\.title), ["Shared computer", "Sam’s MacBook", "Office PC", "Living room Mac mini"])
    XCTAssertEqual(o.map(\.line), ["Always on · uses the server", "Online", "Windows · online", "Offline"])
    // offline shows but can't be picked
    XCTAssertEqual(o.map(\.enabled), [true, true, true, false])
  }

  func testRunsOnMovesAnAgent() throws {
    let n = try nodes()
    let screen = try decode(Computer.self, ##"{"id":"c9","name":"Office PC","kind":"device","nodeId":"n2","status":"ready","statusText":"Ready"}"##)
    let toShared = try XCTUnwrap(RunsOn.patch(.shared, sharedComputerId: "c1", computers: [], nodes: n))
    XCTAssertEqual(json(toShared["computerId"]), "\"c1\"")
    XCTAssertNil(RunsOn.patch(.shared, sharedComputerId: nil, computers: [], nodes: n))
    let toPC = try XCTUnwrap(RunsOn.patch(.device("n2"), sharedComputerId: "c1", computers: [screen], nodes: n))
    XCTAssertEqual(json(toPC["nodeId"]), "\"n2\""); XCTAssertEqual(json(toPC["computerId"]), "\"c9\"")
    let toMac = try XCTUnwrap(RunsOn.patch(.device("n1"), sharedComputerId: "c1", computers: [screen], nodes: n))
    XCTAssertEqual(json(toMac["computerId"]), "null")

    let agent = try decode(Agent.self, ##"{"id":"a1","handle":"juno","name":"Juno","harness":"codex","nodeId":"n2","computerId":"c1","status":"online"}"##)
    XCTAssertEqual(RunsOn.current(agent, sharedComputerId: "c1"), .shared)
    XCTAssertEqual(RunsOn.current(agent, sharedComputerId: "c2"), .device("n2"))
    XCTAssertEqual(RunsOn.title(.device("n2"), nodes: n), "Office PC")
  }

  // MARK: Composio (16)

  func testComposioWithNoAppsPickedSaysSo() throws {
    let none = try decode(AppConnector.self, ##"{"id":"cn1","name":"Composio","kind":"mcp-http","catalogId":"composio","allAgents":true,"linkedApps":{"picked":false,"names":[],"pickUrl":"https://platform.composio.dev/apps","checkedAt":"2026-11-28T08:00:00Z"}}"##)
    XCTAssertTrue(none.noAppsPicked)
    XCTAssertEqual(none.linkedApps?.pickUrl, "https://platform.composio.dev/apps")
    let some = try decode(AppConnector.self, ##"{"id":"cn1","name":"Composio","kind":"mcp-http","linkedApps":{"picked":true,"names":["Gmail"],"pickUrl":"x","checkedAt":"x"}}"##)
    XCTAssertFalse(some.noAppsPicked)
    // couldn't tell, or an older hub: no line
    XCTAssertFalse(try decode(AppConnector.self, ##"{"id":"cn1","name":"Composio","kind":"mcp-http","linkedApps":null}"##).noAppsPicked)
    XCTAssertFalse(try decode(AppConnector.self, ##"{"id":"cn1","name":"Composio","kind":"mcp-http"}"##).noAppsPicked)
  }

  // MARK: settings (16c)

  func testTheMissingSettingsRoundTrip() throws {
    let a = try decode(Agent.self, ##"{"id":"a1","handle":"juno","name":"Juno","harness":"codex","status":"online","settings":{"ownPlugins":true,"useDevices":{"n1":"tell"},"soulLocked":true,"role":"Days and plans"}}"##)
    XCTAssertEqual(a.settings?.ownPlugins, true)
    XCTAssertEqual(a.settings?.useDevices, ["n1": "tell"])
    XCTAssertEqual(a.settings?.soulLocked, true)
    XCTAssertEqual(AgentShortList.does(a), "Days and plans")
  }

  // MARK: pins (16c)

  func testOnlyPinsAreTiles() {
    let chats = ["a:1", "a:2", "a:3"].map { SideLayout.Chat(key: $0, pinned: false, sectionId: nil, unread: 0) }
    let l = SidebarLayout(pins: ["a:1"], sections: [])
    let placed = SideLayout.place(l, chats: chats)
    XCTAssertEqual(placed.pins, ["a:1"])
    // the rest are chats, below
    XCTAssertEqual(placed.sections.first { $0.isNone }?.keys, ["a:2", "a:3"])
    // unpinning really takes it out of the row
    XCTAssertEqual(SideLayout.place(SideLayout.unpin(l, "a:1"), chats: chats).pins, [])
  }
}
