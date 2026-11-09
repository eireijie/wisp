import XCTest
@testable import Wisp

@MainActor
final class SearchInboxTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }
  private func agent(_ id: String, harness: String = "codex", node: String? = nil, status: Agent.Status = .online) -> Agent {
    var a = Agent(id: id, handle: id, name: id.capitalized, harness: harness, status: status)
    a.nodeId = node
    return a
  }
  private func device(_ id: String = "n1", online: Bool = true, paused: Bool = false, harnesses: [String] = ["codex"]) -> ReadyDevice {
    ReadyDevice(id: id, name: "Studio Mac", online: online, paused: paused, harnesses: harnesses)
  }

  func testSignInStateReachesReadiness() {
    let h = { (signed: Bool?) in AgentNode.Harness(id: "codex", version: nil, accounts: ["default": signed]) }
    let a = agent("a1", harness: "codex", node: "n1")
    var d = device(); d.details = [h(false)]
    XCTAssertEqual(Readiness.ready(a, devices: [d]).problem, "Codex isn't signed in")
    XCTAssertEqual(Readiness.checks(agents: [a], devices: [d]).last?.to, .signIn(agentId: "a1"))
    d.details = [h(true)]
    XCTAssertTrue(Readiness.ready(a, devices: [d]).ready)
    d.details = [h(nil)]
    XCTAssertTrue(Readiness.ready(a, devices: [d]).ready, "never flags what it can't tell")
    XCTAssertEqual(Readiness.checks(agents: [a], devices: [d]).last?.status, .unknown)
  }

  func testHubSignInMarksAgentNotReady() throws {
    // an agent in its own computer: the device can't tell, the hub knows
    let json = #"{"id":"a1","handle":"bea","name":"Bea","harness":"codex","nodeId":"n1","computerId":"c1","status":"online","signIn":{"harness":"codex","where":"Bea's computer","nodeId":"n1","computerId":"c1","account":"default"}}"#
    let a = try decode(Agent.self, json)
    XCTAssertTrue(a.needsSignIn)
    XCTAssertEqual(a.signIn?.where_, "Bea's computer")
    XCTAssertEqual(Readiness.ready(a, devices: [device()]).problem, "Codex isn't signed in")
    let fine = try decode(Agent.self, #"{"id":"a2","handle":"cy","name":"Cy","harness":"codex","nodeId":"n1","status":"online","signIn":null}"#)
    XCTAssertFalse(fine.needsSignIn)
  }

  func testSignInAnswerAfterAPastedCode() {
    let before = "Opening browser to sign in…\nPaste code here if prompted > "
    XCTAssertEqual(HarnessLogin.replyAfter(before, before), "")
    XCTAssertEqual(HarnessLogin.replyAfter(before, before + "Invalid code. Please make sure the full code was copied.\nPaste code here if prompted > "), "Invalid code. Please make sure the full code was copied.")
  }

  func testPreselectsASignedInHarness() {
    let node = { (states: [(String, Bool?)]) in
      AgentNode(id: "n1", name: "Test Mac", online: true, harnesses: states.map { AgentNode.Harness(id: $0.0, version: nil, accounts: ["default": $0.1]) })
    }
    let onlyCodex = node([("claude-code", false), ("codex", true)])
    XCTAssertEqual(onlyCodex.harnessSignedIn("claude-code"), false)
    XCTAssertEqual(HarnessPick.preferSignedIn(["claude-code", "codex"]) { onlyCodex.harnessSignedIn($0) }, "codex")
    let unknown = node([("claude-code", false), ("hermes", nil)])
    XCTAssertEqual(HarnessPick.preferSignedIn(["claude-code", "hermes"]) { unknown.harnessSignedIn($0) }, "hermes")
    let none = node([("claude-code", false), ("codex", false)])
    XCTAssertEqual(HarnessPick.preferSignedIn(["claude-code", "codex"]) { none.harnessSignedIn($0) }, "claude-code")
    XCTAssertNil(HarnessPick.preferSignedIn([]) { _ in true })
  }

  func testSearchResultsDecode() throws {
    let json = ##"""
    {"channels":[{"id":"c1","name":"general","kind":"channel","topic":"Hello","createdAt":"2026-10-18T12:00:00Z"}],
     "agents":[{"id":"a1","handle":"maya","name":"Maya","harness":"codex","status":"online"}],
     "messages":[{"id":"m1","channelId":"c1","threadId":"t1","author":{"kind":"user","id":"u1"},"body":"Plan dinner","parts":[{"type":"task","taskId":"t9"}],"createdAt":"2026-10-18T12:00:00Z","channelName":"general"}],
     "notes":[{"path":"shared/dinner-plans.md","title":"Dinner plans","snippet":"Pasta night"}]}
    """##
    let r = try decode(SearchResults.self, json)
    XCTAssertEqual(r.channels.first?.name, "general")
    XCTAssertEqual(r.agents.first?.handle, "maya")
    XCTAssertEqual(r.messages.first?.message.threadId, "t1")
    XCTAssertEqual(r.messages.first?.channelName, "general")
    XCTAssertEqual(SearchText.kind(of: r.messages[0].message), "Task")
    XCTAssertEqual(r.notes.first?.snippet, "Pasta night")
    XCTAssertFalse(r.isEmpty)
    XCTAssertTrue(try decode(SearchResults.self, #"{"channels":[],"agents":[],"messages":[],"notes":[]}"#).isEmpty)
    XCTAssertTrue(try decode(SearchResults.self, "{}").isEmpty)
  }

  func testSearchRequestSendsQuery() async throws {
    ManagementHTTPStub.responses.withLock { $0 = ["GET /api/search": (200, Data(#"{"channels":[],"agents":[],"messages":[],"notes":[]}"#.utf8))] }
    ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "t", session: URLSession(configuration: configuration))
    let r = try await store.search("dinner & friends")
    XCTAssertTrue(r.isEmpty)
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last })
    XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value, "dinner & friends")
  }

  func testPreviewCleaning() {
    XCTAssertEqual(SearchText.clean("## Plan\n- **Buy** [milk](http://x) and `eggs`"), "Plan Buy milk and eggs")
    XCTAssertEqual(SearchText.clean("Hi usr_yN7fNNXTN6NP there. This is task tsk_abc123XY. When finished, report back to me."), "Hi there.")
    XCTAssertEqual(SearchText.clean("```\ncode\n```\nafter"), "after")
    XCTAssertEqual(SearchText.clean(String(repeating: "a", count: 300), max: 20).count, 20)
    XCTAssertEqual(SearchText.humanize("dinner-preferences.md"), "Dinner preferences")
  }

  func testLocations() {
    XCTAssertEqual(SearchText.location(channelName: "general", agentHandles: [:]), "general")
    XCTAssertEqual(SearchText.location(channelName: "dm:u1:a1", agentHandles: ["a1": "maya"]), "DM with @maya")
    XCTAssertEqual(SearchText.location(channelName: "dm:u1:zz", agentHandles: [:]), "Direct message")
    XCTAssertEqual(SearchText.noteLocation(path: "shared/dinner-plans.md", title: "Dinner plans", people: [:], agents: [:]), "Memory › Shared › Dinner plans")
    XCTAssertEqual(SearchText.noteLocation(path: "people/u1/about.md", title: "", people: ["u1": "Sam"], agents: [:]), "Memory › Sam › About")
    XCTAssertEqual(SearchText.noteLocation(path: "agents/a1/notes/idea.md", title: "Idea", people: [:], agents: ["a1": "maya"]), "Memory › @maya › Notes › Idea")
  }

  func testReadiness() {
    // no helper yet
    var checks = Readiness.checks(agents: [], devices: [])
    XCTAssertEqual(checks.first?.status, .bad)
    XCTAssertEqual(checks.first?.to, .makeHelper)
    // helper without a device
    checks = Readiness.checks(agents: [agent("a1")], devices: [])
    XCTAssertEqual(checks.first { $0.id == "device" }?.to, .chooseDevice(agentId: "a1"))
    XCTAssertEqual(checks.first { $0.id == "online" }?.status, .unknown)
    // device offline, paused
    checks = Readiness.checks(agents: [agent("a1", node: "n1")], devices: [device(online: false)])
    XCTAssertEqual(checks.first { $0.id == "online" }?.to, .devices)
    XCTAssertEqual(Readiness.ready(agent("a1", node: "n1"), devices: [device(paused: true)]).problem, "Studio Mac is paused")
    // harness missing vs reported
    checks = Readiness.checks(agents: [agent("a1", node: "n1")], devices: [device(harnesses: ["gemini"])])
    XCTAssertEqual(checks.first { $0.id == "harness" }?.to, .chooseModel(agentId: "a1"))
    XCTAssertEqual(Readiness.ready(agent("a1", node: "n1"), devices: [device(harnesses: ["gemini"])]).problem, "Codex isn't installed on Studio Mac")
    // harness list not reported yet is never "broken"
    checks = Readiness.checks(agents: [agent("a1", node: "n1")], devices: [device(harnesses: [])])
    XCTAssertEqual(checks.first { $0.id == "harness" }?.status, .unknown)
    XCTAssertTrue(Readiness.ready(agent("a1", node: "n1"), devices: [device(harnesses: [])]).ready)
    // all good; and helpers that join from outside need no device
    var signedIn = device(); signedIn.details = [AgentNode.Harness(id: "codex", version: nil, accounts: ["default": true])]
    checks = Readiness.checks(agents: [agent("a1", node: "n1")], devices: [signedIn])
    XCTAssertFalse(checks.contains { $0.status != .ok })
    XCTAssertTrue(Readiness.ready(agent("g1", harness: "grok"), devices: []).ready)
    // a ready helper is picked before a broken one
    XCTAssertEqual(Readiness.pickHelper([agent("a1"), agent("a2", node: "n1")], devices: [device()])?.id, "a2")
  }

  func testOnboardingDecodeAndSetupSteps() throws {
    let s = try decode(OnboardingState.self, ##"{"devices":[{"id":"n1","name":"Mac","online":true,"mine":true,"role":null}],"computers":[],"agents":[],"firstReply":null,"memoryNotes":[],"reachable":false}"##)
    XCTAssertEqual(s.devices.first?.name, "Mac")
    XCTAssertEqual(s.reachable, false)
    let steps = HelpView.steps(hasHelper: true, hasDevice: true, reachable: s.reachable)
    XCTAssertEqual(steps.filter(\.done).count, 2)
    XCTAssertEqual(steps.first { !$0.done }?.id, "anywhere")
  }

  func testInboxLogic() throws {
    let store = Store(loadSession: false)
    store.me = User(id: "u1", email: "s@e.test", name: "Sam")
    let t = { (id: String, status: String, from: String, to: String?) in
      try self.decode(WorkTask.self, "{\"id\":\"\(id)\",\"title\":\"T\(id)\",\"brief\":\"\",\"status\":\"\(status)\",\"from\":{\"kind\":\"user\",\"id\":\"\(from)\"},\"toAgentId\":\(to.map { "\"\($0)\"" } ?? "null"),\"result\":null,\"updatedAt\":\"2026-10-18T12:00:00Z\"}") }
    store.tasks = [try t("1", "open", "u1", "a1"), try t("2", "failed", "u1", "a1"), try t("3", "done", "u1", "a1"), try t("4", "failed", "u2", "a1"), try t("5", "in_progress", "u1", "a1")]
    XCTAssertEqual(store.tasksToCheck.map(\.id), ["1", "2"])
    store.agents = [agent("a1", status: .busy), agent("a2", status: .offline), agent("a3")]
    XCTAssertEqual(store.agentsByActivity.map(\.id), ["a1", "a3", "a2"])
    XCTAssertEqual(store.doing(store.agents[0]), AgentDoing(text: "T5", where: nil))
    store.activity["a3"] = "Reading notes"
    XCTAssertEqual(store.doing(store.agents[2])?.text, "Reading notes")
    store.activity["a3"] = "started"
    XCTAssertEqual(store.doing(store.agents[2])?.text, "Working")
    let channel = { (id: String, kind: String, unread: Int) in
      try self.decode(Channel.self, "{\"id\":\"\(id)\",\"name\":\"\(kind == "dm" ? "dm:u1:a1" : id)\",\"kind\":\"\(kind)\",\"topic\":\"\",\"joined\":true,\"unread\":\(unread),\"createdAt\":\"2026-10-18T12:00:00Z\"}") }
    store.channels = [try channel("g", "channel", 5), try channel("d", "dm", 1), try channel("q", "channel", 0)]
    XCTAssertEqual(store.unreadChats.map(\.id), ["d", "g"])
    XCTAssertEqual(Store.allowanceText(try decode(Allowance.self, #"{"dailyTokens":1000000,"todayTokens":340000,"agents":[]}"#)), "34% of today's allowance")
    XCTAssertEqual(Store.allowanceText(try decode(Allowance.self, #"{"dailyTokens":null,"todayTokens":340000,"agents":[]}"#)), "340k used today")
  }
}
