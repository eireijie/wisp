import XCTest
import SwiftUI
import Synchronization
@testable import Wisp

@MainActor
final class ManagementTests: XCTestCase {
  private let agentJSON = ##"{"id":"a1","name":"Darnold","handle":"darnold","harness":"codex","model":null,"nodeId":"n1","computerId":null,"groups":[],"instructions":"Research carefully.","settings":{"appearance":{"color":"#4488aa"},"effort":"high","fast":true,"role":"Researcher","roleNotes":"Finds answers with sources.","anyoneCanAsk":false},"status":"online"}"##
  private let channelJSON = #"{"id":"c1","name":"research","kind":"channel","topic":"What we are learning","sectionId":"s1","joined":true,"memberCount":2,"unread":7,"lastReadAt":null,"createdAt":"2026-10-18T12:00:00Z","private":true,"archivedAt":null,"settings":{"defaultAgentId":"a1","replyInThread":true,"instructions":"Cite sources."},"notify":"default","starred":true,"pinnedIds":[]}"#

  private func makeStore() throws -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }
    ManagementHTTPStub.requests.withLock { $0 = [] }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: config))
    store.role = "owner"
    store.workspace = Workspace(id: "w1", name: "Warren")
    store.me = User(id: "u1", email: "owner@example.test", name: "You")
    store.agents = [try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))]
    store.channels = [try Wire.decoder.decode(Channel.self, from: Data(channelJSON.utf8))]
    store.sections = [ChannelSection(id: "s1", name: "Projects", emoji: "🛠️", position: 0)]
    store.members = [Member(id: "u1", email: "owner@example.test", name: "You", role: "owner")]
    reply("GET", "/api/agents", "[\(agentJSON)]")
    reply("GET", "/api/channels", "[\(channelJSON)]")
    reply("GET", "/api/sections", #"[{"id":"s1","name":"Projects","emoji":"🛠️","position":0}]"#)
    reply("GET", "/api/nodes", #"[{"id":"n1","name":"My Mac","mine":true,"ownerId":"u1","online":true,"shared":false,"harnesses":[{"id":"codex","version":"1"}]}]"#)
    reply("GET", "/api/teams", "[]")
    reply("GET", "/api/members", #"[{"id":"u1","email":"owner@example.test","name":"You","role":"owner"}]"#)
    reply("GET", "/api/agents/a1/runs", #"[{"id":"r1","status":"done","trigger":"Find sources for the launch.","channelName":"research","createdAt":"2026-10-18T12:00:00Z"}]"#)
    reply("GET", "/api/channels/c1/members", #"[{"kind":"user","id":"u1","name":"You","handle":null,"role":"owner"},{"kind":"agent","id":"a1","name":"Darnold","handle":"darnold","role":null}]"#)
    reply("GET", "/api/channels/c1/pins", "[]")
    return store
  }

  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }

  private func body(of request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testChannelFieldsAndBadgeRules() throws {
    let store = try makeStore()
    XCTAssertEqual(store.unreadTotal, 7)
    XCTAssertEqual(store.channels[0].private, true)
    XCTAssertEqual(store.channels[0].settings?.defaultAgentId, "a1")
    XCTAssertEqual(store.channels[0].settings?.replyInThread, true)
    store.channels[0].notify = "mute"
    XCTAssertEqual(store.unreadTotal, 0)
    store.channels[0].notify = "all"
    store.channels[0].archivedAt = Wire.now()
    XCTAssertEqual(store.unreadTotal, 0)
    store.channels[0].archivedAt = nil
    store.channels[0].joined = false
    XCTAssertEqual(store.unreadTotal, 0)
  }

  func testPartialAgentPatchNeverSendsOtherSettings() async throws {
    let store = try makeStore()
    reply("PATCH", "/api/agents/a1", agentJSON)
    try await store.updateAgent("a1", ["model": .null, "settings": AnyEncodable(["effort": AnyEncodable.null])])
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last })
    XCTAssertEqual(request.httpMethod, "PATCH")
    let json = try body(of: request)
    XCTAssertTrue(json["model"] is NSNull)
    let settings = try XCTUnwrap(json["settings"] as? [String: Any])
    XCTAssertEqual(Set(settings.keys), ["effort"])
    XCTAssertTrue(settings["effort"] is NSNull)
    XCTAssertEqual(store.agents[0].settings?.appearance?.color, "#4488aa")
    XCTAssertEqual(store.agents[0].settings?.role, "Researcher")
  }

  func testHubErrorsAreUnchangedAndRejectedDeleteKeepsAgent() async throws {
    let store = try makeStore()
    let message = "@darnold runs directly on Alex's device, so only Alex can remove it"
    let json = String(data: try JSONEncoder().encode(["error": message]), encoding: .utf8)!
    reply("DELETE", "/api/agents/a1", json, status: 403)
    do { try await store.deleteAgent("a1"); XCTFail("Expected 403") }
    catch { XCTAssertEqual(error.localizedDescription, message) }
    XCTAssertEqual(store.agents.count, 1)
    reply("PATCH", "/api/agents/a1", #"{"error":"handle taken"}"#, status: 409)
    do { try await store.updateAgent("a1", ["name": AnyEncodable("Name")]); XCTFail("Expected failure") }
    catch { XCTAssertEqual(error.localizedDescription, "handle taken") }
    XCTAssertEqual(store.agents[0].name, "Darnold")
  }

  func testChannelPrefsAndMemberRoutes() async throws {
    let store = try makeStore()
    reply("PUT", "/api/channels/c1/prefs", #"{"ok":true,"notify":"mute","starred":true}"#)
    try await store.setChannelPrefs("c1", ["notify": AnyEncodable("mute")])
    XCTAssertEqual(store.unreadTotal, 0)
    XCTAssertEqual(store.channels[0].starred, true)
    reply("PUT", "/api/channels/c1/members/agent/a1", "[]")
    reply("DELETE", "/api/channels/c1/members/agent/a1", "[]")
    try await store.addMember(Actor(kind: .agent, id: "a1"), to: "c1")
    try await store.removeMember(Actor(kind: .agent, id: "a1"), from: "c1")
    let requests = ManagementHTTPStub.requests.withLock { $0 }
    XCTAssertTrue(requests.contains { $0.httpMethod == "PUT" && $0.url?.path == "/api/channels/c1/members/agent/a1" })
    XCTAssertTrue(requests.contains { $0.httpMethod == "DELETE" && $0.url?.path == "/api/channels/c1/members/agent/a1" })
    let prefs = try body(of: XCTUnwrap(requests.first))
    XCTAssertEqual(Set(prefs.keys), ["notify"])
  }

  func testScreenCodeGoesWithViewLendAndLoanApproval() async throws {
    let store = try makeStore()
    let screen = #"{"id":"k1","name":"My Mac","kind":"device","nodeId":"n1","status":"ready","statusText":"","code":"pin","config":{"lend":{"until":null}}}"#
    let computer = try Wire.decoder.decode(Computer.self, from: Data(screen.utf8))
    XCTAssertEqual(computer.code, "pin")
    XCTAssertTrue(computer.lentNow)
    store.computers = [computer]

    reply("POST", "/api/computers/k1/view", #"{"error":"Wrong PIN. 4 tries left before this screen locks for a while."}"#, status: 403)
    do { _ = try await store.openView(computer, code: "123456"); XCTFail("Expected 403") }
    catch let f as API.Failure {
      XCTAssertEqual(f.status, 403)
      XCTAssertEqual(f.message, "Wrong PIN. 4 tries left before this screen locks for a while.")
    }
    reply("POST", "/api/computers/k1/view", #"{"transport":"frames","url":"/ws/computers/k1/frames?ticket=t1","direct":false}"#)
    let (view, ws) = try await store.openView(computer, code: "123456")
    XCTAssertEqual(view.transport, "frames")
    // URLSession shows a wss task's request as https
    XCTAssertEqual(ws.originalRequest?.url?.absoluteString.replacingOccurrences(of: "https://", with: "wss://"), "wss://management.test/ws/computers/k1/frames?ticket=t1")
    ws.cancel()

    reply("POST", "/api/computers/k1/lend", screen)
    try await store.lend(computer, minutes: nil, code: "123456")
    reply("POST", "/api/approvals/p1/decide", #"{"id":"p1","agentId":"a1","channelId":"c1","summary":"Borrow My Mac","details":"","status":"approved","note":"","createdAt":"2026-10-22T12:00:00Z","loan":{"nodeId":"n1","deviceName":"My Mac","ownerId":"u1"}}"#)
    let approval = try Wire.decoder.decode(Approval.self, from: Data(#"{"id":"p1","agentId":"a1","channelId":"c1","summary":"Borrow My Mac","details":"","status":"pending","note":"","createdAt":"2026-10-22T12:00:00Z","loan":{"nodeId":"n1","deviceName":"My Mac","ownerId":"u1"}}"#.utf8))
    XCTAssertEqual(store.loanScreen(approval)?.code, "pin")
    try await store.decide(approval, approve: true, code: "123456")

    let requests = ManagementHTTPStub.requests.withLock { $0 }.filter { $0.httpMethod == "POST" }
    XCTAssertEqual(try body(of: requests[0])["code"] as? String, "123456")
    let lend = try body(of: requests[2])
    XCTAssertTrue(lend["minutes"] is NSNull) // until you stop it
    XCTAssertEqual(lend["code"] as? String, "123456")
    XCTAssertEqual(try body(of: requests[3])["code"] as? String, "123456")
  }

  func testChannelMoveAndAgentCreationSendExplicitNulls() async throws {
    let store = try makeStore()
    reply("PATCH", "/api/channels/c1", channelJSON)
    try await store.updateChannel("c1", ["sectionId": .null, "settings": AnyEncodable(["defaultAgentId": AnyEncodable.null])])
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.first })
    let json = try body(of: request)
    XCTAssertTrue(json["sectionId"] is NSNull)
    XCTAssertTrue((json["settings"] as? [String: Any])?["defaultAgentId"] is NSNull)
    reply("POST", "/api/agents", agentJSON.replacingOccurrences(of: "a1", with: "a2"))
    let created = try await store.createAgent(["name": AnyEncodable("Darnold"), "handle": AnyEncodable("darnold-2"), "harness": AnyEncodable("codex"), "nodeId": .null])
    XCTAssertEqual(created.id, "a2")
    XCTAssertEqual(store.agents.count, 2)
    let creation = try body(of: XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last }))
    XCTAssertTrue(creation["nodeId"] is NSNull)
  }

  func testSectionsAndRoleProtection() async throws {
    let store = try makeStore()
    store.role = "guest"
    XCTAssertFalse(store.canManage)
    store.role = "member"
    XCTAssertTrue(store.canManage)
    store.channels[0].name = "general"
    XCTAssertTrue(store.isProtected(store.channels[0]))
    // a channel with a team can be archived and deleted like any other
    store.channels[0].name = "team-channel"
    store.channels[0].settings = Channel.Settings(team: ChannelTeam(nodes: [.init(agentId: "a1", lead: true, x: 0, y: 0)], edges: []))
    XCTAssertFalse(store.isProtected(store.channels[0]))
    reply("DELETE", "/api/sections/s1", #"{"ok":true}"#)
    try await store.deleteSection("s1")
    XCTAssertTrue(store.sections.isEmpty)
    XCTAssertNil(store.channels[0].sectionId)
  }

  func testPersonalityUsesVaultAndModelsUseReportedCapabilities() async throws {
    let store = try makeStore()
    reply("PUT", "/api/vault/note", #"{"ok":true}"#)
    try await store.savePersonality(store.agents[0], content: "Be kind.")
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last })
    let note = try body(of: request)
    XCTAssertEqual(note["path"] as? String, "agents/a1/SOUL.md")
    XCTAssertEqual(note["content"] as? String, "Be kind.")
    reply("GET", "/api/agents/a1/models", #"{"device":null,"catalog":{"harness":"codex","version":null,"defaultModel":"model-1","efforts":["low","high"],"models":[{"id":"model-1","label":"Model One","efforts":["high"],"fast":{"description":"More usage"}}]}}"#)
    let models = try await store.agentModels("a1")
    XCTAssertEqual(models.catalog?.models[0].efforts, ["high"])
    XCTAssertEqual(models.catalog?.models[0].fast?.description, "More usage")
    XCTAssertEqual(models.catalog?.defaultModel, "model-1")
  }

  func testLiveEventsRefreshSectionsAndUnknownAgents() async throws {
    let store = try makeStore()
    reply("GET", "/api/sections", #"[{"id":"s2","name":"New section","emoji":"🚀","position":0}]"#)
    reply("GET", "/api/agents", "[\(agentJSON.replacingOccurrences(of: "a1", with: "a2"))]")
    store.handle(Data(#"{"type":"sections_changed"}"#.utf8))
    store.handle(Data(#"{"type":"agent_status","agentId":"a2","status":"online"}"#.utf8))
    for _ in 0..<50 {
      if store.sections.first?.id == "s2" && store.agents.first?.id == "a2" { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertEqual(store.sections.first?.id, "s2")
    XCTAssertEqual(store.agents.first?.id, "a2")
    let version = store.channelVersion
    store.handle(Data(#"{"type":"channels_changed"}"#.utf8))
    XCTAssertEqual(store.channelVersion, version + 1)
  }

  func testNamesAndDevicePermissionScope() throws {
    XCTAssertEqual(ManagementText.channelName("  Project Launch! "), "project-launch")
    XCTAssertEqual(ManagementText.channelName("Test_under-score"), "test_under-score")
    XCTAssertEqual(ManagementText.handle("42 Darnold!"), "darnold")
    let store = try makeStore()
    XCTAssertTrue(store.harnessOnDevice(store.agents[0]))
    store.computers = [Computer(id: "vm1", name: "VM", kind: "vm", nodeId: "n1", status: "ready", statusText: "")]
    store.agents[0].computerId = "vm1"
    store.agents[0].settings?.runIn = "computer"
    XCTAssertFalse(store.harnessOnDevice(store.agents[0]))
  }

  func testPushCategoriesOverrideLegacyThreadGuess() {
    let expected = ["approval": "approvals", "help": "help", "reply": "replies", "dm": "dms", "mention": "dms", "channel": "dms"]
    for (category, key) in expected {
      for hasThread in [false, true] {
        XCTAssertEqual(PushPreference.key(category: category, kind: "task", hasThread: hasThread), key)
      }
    }
    XCTAssertEqual(PushPreference.key(category: nil, kind: "message", hasThread: true), "replies")
    XCTAssertEqual(PushPreference.key(category: nil, kind: "message", hasThread: false), "dms")
    XCTAssertEqual(PushPreference.key(category: nil, kind: "approval", hasThread: false), "approvals")
    XCTAssertEqual(PushPreference.key(category: nil, kind: "computer", hasThread: false), "help")
    XCTAssertEqual(PushPreference.key(category: nil, kind: "task", hasThread: false), "tasks")
  }

  func testDevicePollingBackoffCapsAndResetsAfterRecovery() {
    var backoff = DevicePollingBackoff()
    XCTAssertEqual(backoff.interval, 5)
    backoff.failed(); XCTAssertEqual(backoff.interval, 10)
    backoff.failed(); XCTAssertEqual(backoff.interval, 20)
    backoff.failed(); XCTAssertEqual(backoff.interval, 30)
    backoff.failed(); XCTAssertEqual(backoff.interval, 30)
    backoff.succeeded(); XCTAssertEqual(backoff.interval, 5)
    backoff.failed(); XCTAssertEqual(backoff.interval, 10)
  }

  func testNewVMDraftReusesComputerAfterAgentCreationFails() async throws {
    let store = try makeStore()
    let draft = AgentComputerDraft()
    reply("POST", "/api/computers", #"{"id":"vm1","name":"Nova's desk","kind":"vm","nodeId":"n1","status":"stopped","statusText":""}"#)
    let computerId = try await draft.resolveVM(node: "n1", name: "Nova", store: store)
    let fields: Fields = ["name": AnyEncodable("Nova"), "computerId": AnyEncodable(computerId), "settings": AnyEncodable(["runIn": "computer"])]
    reply("POST", "/api/agents", #"{"error":"Try again"}"#, status: 503)
    do { _ = try await store.createAgent(fields); XCTFail("Expected failure") } catch {}
    let retryId = try await draft.resolveVM(node: "n1", name: "Nova", store: store)
    XCTAssertEqual(retryId, "vm1")
    reply("POST", "/api/agents", agentJSON)
    _ = try await store.createAgent(fields)
    let computers = ManagementHTTPStub.requests.withLock { $0.filter { $0.url?.path == "/api/computers" } }
    XCTAssertEqual(computers.count, 1)
    let json = try body(of: XCTUnwrap(computers.first))
    XCTAssertEqual(json["kind"] as? String, "vm")
    XCTAssertEqual(json["nodeId"] as? String, "n1")
    XCTAssertEqual(json["name"] as? String, "Nova's desk")
  }

  func testModelOverridesAreOmittedWithoutCatalog() throws {
    let missing = try Wire.decoder.decode(AgentModels.self, from: Data(#"{"catalog":null}"#.utf8))
    XCTAssertNil(missing.settings(model: "model", effort: "high", fast: true))
    let models = try Wire.decoder.decode(AgentModels.self, from: Data(#"{"catalog":{"models":[{"id":"model","label":"Model","fast":{}}],"efforts":["high"]}}"#.utf8))
    let fields = try XCTUnwrap(models.settings(model: "model", effort: "high", fast: true))
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(fields)) as? [String: Any])
    XCTAssertEqual(json["effort"] as? String, "high")
    XCTAssertEqual(json["fast"] as? Bool, true)
  }

  func testSlowHarnessRequestsKeepDefaultTimeoutForOtherCalls() async throws {
    let store = try makeStore()
    reply("GET", "/api/agents/a1/harness", #"{"possible":true,"inComputer":true,"signedIn":false,"computerId":"vm1"}"#)
    reply("POST", "/api/agents/a1/signin", #"{"computerId":"vm1"}"#)
    reply("GET", "/api/computers", "[]")
    reply("POST", "/api/nodes/n1/install", #"{"ok":true}"#)
    _ = try await store.harnessState("a1")
    _ = try await store.signInAgent("a1")
    _ = try await store.installHarness("codex", node: "n1")
    let requests = ManagementHTTPStub.requests.withLock { $0 }
    XCTAssertEqual(requests.first { $0.url?.path == "/api/agents/a1/harness" }?.timeoutInterval, 130)
    XCTAssertEqual(requests.first { $0.url?.path == "/api/agents/a1/signin" }?.timeoutInterval, 610)
    XCTAssertEqual(requests.first { $0.url?.path == "/api/nodes/n1/install" }?.timeoutInterval, 970)
    XCTAssertEqual(requests.first { $0.url?.path == "/api/computers" }?.timeoutInterval, 30)
    XCTAssertEqual(store.api?.timeout, 30)
  }

  func testPushUploadFailureRetriesAndKeepsTokenForNextAttempt() async throws {
    let store = try makeStore()
    reply("POST", "/api/me/push", #"{"error":"Temporarily unavailable"}"#, status: 503)
    store.pushTokenReceived("abc123", retryDelay: .zero)
    await store.pushUploadTask?.value
    XCTAssertEqual(store.pushToken, "abc123")
    XCTAssertEqual(store.pushRegistrationError, "Couldn't register this phone")
    XCTAssertEqual(ManagementHTTPStub.requests.withLock { $0.filter { $0.url?.path == "/api/me/push" }.count }, 2)
    reply("POST", "/api/me/push", #"{"ok":true}"#)
    store.pushTokenReceived(try XCTUnwrap(store.pushToken), retryDelay: .zero)
    await store.pushUploadTask?.value
    XCTAssertNil(store.pushRegistrationError)
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last })
    XCTAssertEqual(try body(of: request)["token"] as? String, "abc123")
    store.pushRegistrationFailed(API.Failure(status: 0, message: "APNs unavailable"))
    XCTAssertEqual(store.pushRegistrationError, "Couldn't register this phone")
  }

  func testManagementScreensRender() async throws {
    let store = try makeStore()
    try await store.refreshManagement()
    store.simple = true
    var general = store.channels[0]
    general.id = "general"; general.name = "general"; general.starred = false; general.sectionId = nil; general.private = false
    var muted = general
    muted.id = "muted"; muted.name = "ideas"; muted.sectionId = "s1"; muted.notify = "mute"
    store.channels += [general, muted]
    let screens: [(String, AnyView)] = [
      ("Chats", AnyView(ChatsView().environment(store))),
      ("Agents", AnyView(AgentsView().environment(store))),
      ("Agent", AnyView(NavigationStack { AgentPage(agent: store.agents[0]) }.environment(store))),
      ("Channel details", AnyView(NavigationStack { ChannelDetails(channel: store.channels[0]) }.environment(store))),
      ("Add agent", AnyView(AddAgent(onCreated: { _ in }).environment(store))),
      ("New channel", AnyView(NewChannel(onCreated: { _ in }).environment(store)))
    ]
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first { $0.isKeyWindow }
    defer { previous?.makeKey() }
    for (name, view) in screens {
      let controller = UIHostingController(rootView: view.tint(.primary).fontDesign(.rounded))
      let window = UIWindow(windowScene: scene)
      window.rootViewController = controller
      window.makeKeyAndVisible()
      try await Task.sleep(for: .milliseconds(350))
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

final class ManagementHTTPStub: URLProtocol, @unchecked Sendable {
  static let responses = Mutex<[String: (Int, Data)]>([:])
  static let requests = Mutex<[URLRequest]>([])
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "management.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if captured.httpBody == nil, let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
      }
      captured.httpBody = data
    }
    Self.requests.withLock { $0.append(captured) }
    let key = (request.httpMethod ?? "GET") + " " + (request.url?.path ?? "")
    let (status, data) = Self.responses.withLock { $0[key] ?? (404, Data(#"{"error":"No test response"}"#.utf8)) }
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
