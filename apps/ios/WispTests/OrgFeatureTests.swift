import SwiftUI
import XCTest
@testable import Wisp

@MainActor
final class OrgFeatureTests: XCTestCase {
  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "owner"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    store.workspace = Workspace(id: "w1", name: "My warren")
    return store
  }
  private func body(_ method: String, _ path: String) throws -> [String: Any] {
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last { $0.httpMethod == method && $0.url?.path == path } })
    return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testFeaturesDecodeWithEverythingOnWhenMissing() throws {
    let empty = try Wire.decoder.decode(Features.self, from: Data("{}".utf8))
    XCTAssertEqual(empty, .everything)
    XCTAssertEqual(empty.preset, "everything")
    // Storage needs setting up first, so a hub that doesn't mention it means off
    XCTAssertFalse(empty.storage)
    XCTAssertTrue(try Wire.decoder.decode(Features.self, from: Data(#"{"storage":true}"#.utf8)).storage)
    let some = try Wire.decoder.decode(Features.self, from: Data(#"{"buddy":false,"voice":false}"#.utf8))
    XCTAssertFalse(some.buddy); XCTAssertFalse(some.voice); XCTAssertTrue(some.tasks)
    XCTAssertEqual(some.preset, "custom")
    XCTAssertEqual(Features.simple.preset, "simple")
    let me = try Wire.decoder.decode(Me.self, from: Data(#"{"kind":"user","features":{"background":false,"routines":false,"teach":false,"tasks":false,"voice":false,"buddy":false,"invite":false,"remoteDesktop":false}}"#.utf8))
    XCTAssertEqual(me.features, .simple)
    XCTAssertNil(try Wire.decoder.decode(Me.self, from: Data(#"{"kind":"user"}"#.utf8)).features)
    XCTAssertEqual(FeatureKey.allCases.count, 9)
    XCTAssertEqual(FeatureKey.Group.allCases.flatMap(\.keys).count, 9)
  }

  func testOrgsAndInviteLinks() throws {
    let orgs = try Wire.decoder.decode([OrgSummary].self, from: Data(#"[{"id":"w1","name":"My warren","role":"owner","members":1,"agents":4,"current":true,"unread":false},{"id":"w2","name":"Acme","role":"member","members":3,"agents":1,"current":false,"unread":true}]"#.utf8))
    XCTAssertEqual(orgs[0].subtitle, "Just you · 4 agents")
    XCTAssertEqual(orgs[1].subtitle, "3 people · 1 agent")
    XCTAssertEqual(Store.inviteCode("https://wisp.example.com/#/join/abc123"), "abc123")
    XCTAssertEqual(Store.inviteCode("  abc123 "), "abc123")
    XCTAssertEqual(Store.inviteCode("http://10.0.0.2:4747/#/join/xyz?x=1"), "xyz")
    let defaults = try Wire.decoder.decode(AgentDefaults.self, from: Data(#"{"harness":"codex","model":null,"computer":"none","nodeId":null}"#.utf8))
    XCTAssertEqual(defaults.computer, "none")
  }

  func testOrgListFallsBackToCurrentWorkspace() async {
    let store = makeStore()
    await store.refreshOrgs()
    XCTAssertEqual(store.orgList.map(\.name), ["My warren"])
    XCTAssertTrue(store.isCurrent(store.orgList[0]))
    reply("GET", "/api/orgs", #"[{"id":"w1","name":"My warren","members":1,"agents":0,"current":true},{"id":"w2","name":"Acme","members":2,"agents":3,"current":false}]"#)
    await store.refreshOrgs()
    XCTAssertEqual(store.orgList.count, 2)
    XCTAssertFalse(store.isCurrent(store.orgList[1]))
  }

  func testFeaturesSaveAndLiveEvent() async throws {
    let store = makeStore()
    reply("PUT", "/api/features", #"{"features":{"background":false,"routines":false,"teach":false,"tasks":false,"voice":true,"buddy":false,"invite":false,"remoteDesktop":false}}"#)
    var next = Features.simple
    next.voice = true
    try await store.setFeatures(next)
    XCTAssertEqual(try body("PUT", "/api/features")["voice"] as? Bool, true)
    XCTAssertTrue(store.features.voice); XCTAssertFalse(store.features.tasks)
    store.handle(Data(#"{"type":"features","features":{"tasks":true,"voice":false}}"#.utf8))
    XCTAssertTrue(store.features.tasks); XCTAssertFalse(store.features.voice)
    // a failed save puts the old switches back
    reply("PUT", "/api/features", #"{"error":"owners only"}"#, status: 403)
    let before = store.features
    do { try await store.setFeatures(.simple); XCTFail("expected an error") } catch {}
    XCTAssertEqual(store.features, before)
  }

  func testChangesAndAllowance() async throws {
    let store = makeStore()
    let part = try Wire.decoder.decode(MessagePart.self, from: Data(#"{"type":"change","changeId":"ch1"}"#.utf8))
    XCTAssertEqual(part, .change(changeId: "ch1"))
    reply("GET", "/api/changes", #"[{"id":"ch1","userId":"u1","agentId":"a1","lines":["Checks: every hour → every 2 hours"],"createdAt":"2026-10-22T12:00:00Z","undoneAt":null}]"#)
    try await store.refreshChanges()
    XCTAssertNil(store.changes?.first?.undoneAt)
    reply("POST", "/api/changes/ch1/undo", #"{"ok":true}"#)
    reply("GET", "/api/changes", #"[{"id":"ch1","userId":"u1","agentId":"a1","lines":["Checks: every hour → every 2 hours"],"createdAt":"2026-10-22T12:00:00Z","undoneAt":"2026-10-22T12:05:00Z"}]"#)
    try await store.undoChange("ch1")
    XCTAssertNotNil(store.changes?.first?.undoneAt)

    reply("PUT", "/api/background/allowance", #"{"dailyTokens":null,"todayTokens":412000,"estimated":false,"agents":[{"agentId":"a1","tokens":268000,"checks":7}]}"#)
    try await store.saveAllowance(nil)
    XCTAssertTrue(try body("PUT", "/api/background/allowance")["dailyTokens"] is NSNull)
    XCTAssertNil(store.allowance?.dailyTokens)
    XCTAssertEqual(store.allowance?.agents.first?.checks, 7)
    XCTAssertEqual([300_000, 1_000_000, 1_250_000, 400].map(Allowance.text), ["300k", "1M", "1.3M", "1k"])
    XCTAssertEqual(BackgroundView.clock("22:00"), "10pm")
    XCTAssertEqual(BackgroundView.clock("07:30"), "7:30am")
  }

  func testRunStepsAndStop() async throws {
    let store = makeStore()
    store.agents = [Agent(id: "a1", handle: "nova", name: "Nova", harness: "claude-code", status: .busy)]
    store.handle(Data(#"{"type":"run_event","runId":"r1","agentId":"a1","channelId":"c1","event":{"type":"status","text":"started"}}"#.utf8))
    store.handle(Data(#"{"type":"run_event","runId":"r1","agentId":"a1","channelId":"c1","event":{"type":"status","text":"Editing files"}}"#.utf8))
    store.handle(Data(#"{"type":"run_event","runId":"r1","agentId":"a1","channelId":"c1","event":{"type":"tool_call","name":"Bash"}}"#.utf8))
    XCTAssertEqual(store.activitySteps["a1"], ["Editing files", "Used Bash"])
    XCTAssertEqual(store.activityRun["a1"], "r1")
    XCTAssertEqual(ActivityText.phrase("Editing files"), "is editing files")
    XCTAssertEqual(ActivityText.phrase(nil), "is working")
    reply("POST", "/api/runs/r1/cancel", #"{"ok":true}"#)
    try await store.stopAgent("a1")
    XCTAssertTrue(ManagementHTTPStub.requests.withLock { $0.contains { $0.url?.path == "/api/runs/r1/cancel" } })
    store.handle(Data(#"{"type":"agent_status","agentId":"a1","status":"online"}"#.utf8))
    XCTAssertNil(store.activitySteps["a1"]); XCTAssertNil(store.activityRun["a1"])
  }

  func testAgentDefaultsRoundTrip() async throws {
    let store = makeStore()
    await store.refreshAgentDefaults()
    XCTAssertNil(store.agentDefaults)
    XCTAssertEqual(store.defaultsSummary.ai, "Claude Code")
    reply("GET", "/api/settings/agent-defaults", #"{"harness":"codex","model":"gpt-5","computer":"none","nodeId":null}"#)
    await store.refreshAgentDefaults()
    XCTAssertEqual(store.defaultsSummary.ai, "Codex · gpt-5")
    XCTAssertEqual(store.defaultsSummary.computer, "No computer")
    reply("PUT", "/api/settings/agent-defaults", #"{"harness":"claude-code","model":null,"computer":"own-vm","nodeId":null}"#)
    try await store.saveAgentDefaults(AgentDefaults(harness: "claude-code", model: nil, computer: "own-vm", nodeId: nil))
    XCTAssertEqual(try body("PUT", "/api/settings/agent-defaults")["harness"] as? String, "claude-code")
    XCTAssertEqual(store.agentDefaults?.computer, "own-vm")
  }

  func testNewScreensRender() async throws {
    let store = makeStore()
    store.agents = [Agent(id: "a1", handle: "nova", name: "Nova", harness: "claude-code", status: .busy)]
    store.activitySteps["a1"] = ["Opened the site repo", "Editing the pricing page"]
    let screens: [(String, AnyView)] = [
      ("Mods", AnyView(NavigationStack { FeaturesView() }.environment(store))),
      ("Agent defaults", AnyView(NavigationStack { AgentDefaultsView() }.environment(store))),
      ("New workspace", AnyView(NewOrgSheet().environment(store))),
      ("Agent work", AnyView(AgentWorkSheet(agentId: "a1").environment(store))),
      ("Look", AnyView(LookEditor(look: .constant(GhostLook.defaultAppearance("nova")), name: "Nova", seed: "nova").environment(store))),
    ]
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first { $0.isKeyWindow }
    defer { previous?.makeKey() }
    for (name, view) in screens {
      let controller = UIHostingController(rootView: view.tint(.primary).fontDesign(.rounded))
      let window = UIWindow(windowScene: scene)
      window.rootViewController = controller
      window.makeKeyAndVisible()
      try await Task.sleep(for: .milliseconds(300))
      controller.view.layoutIfNeeded()
      let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      let pixels = try XCTUnwrap(image.cgImage?.dataProvider?.data) as Data
      XCTAssertGreaterThan(Set(pixels).count, 16, "The screen must render content, not a blank image: \(name)")
      let attachment = XCTAttachment(image: image)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
      window.isHidden = true
      window.rootViewController = nil
    }
  }
}
