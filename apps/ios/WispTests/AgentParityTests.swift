import XCTest
@testable import Wisp

@MainActor
final class AgentParityTests: XCTestCase {
  private let agentJSON = ##"{"id":"a1","name":"Darnold","handle":"darnold","harness":"codex","model":null,"nodeId":"n1","computerId":null,"groups":[],"settings":{"access":"read-only","voice":{"openai":"nova"}},"status":"online"}"##

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
    reply("GET", "/api/computers", "[]")
    return store
  }

  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }

  private func lastBody(_ method: String, _ path: String) throws -> [String: Any] {
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0 }.last { $0.httpMethod == method && $0.url?.path == path })
    return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  // MARK: permissions

  func testAgentSettingsDecodeAccessAndVoice() throws {
    let agent = try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))
    XCTAssertEqual(AgentAccess.from(agent.settings?.access), .readOnly)
    XCTAssertEqual(agent.settings?.voice?.openai, "nova")
    XCTAssertEqual(agent.settings?.voice?["openai"], "nova")
    XCTAssertEqual(AgentAccess.from(nil), .edit)
    XCTAssertEqual(AgentAccess.from("nonsense"), .edit)
  }

  func testAccessScopeWords() {
    XCTAssertEqual(AgentAccess.edit.scope(name: "Nova", handle: "nova", device: nil), "It has no device yet, so it can't touch any files.")
    XCTAssertTrue(AgentAccess.edit.scope(name: "Nova", handle: "nova", device: "Mac").contains("~/.wisp/agents/nova"))
    XCTAssertTrue(AgentAccess.readOnly.scope(name: "Nova", handle: "nova", device: "Mac").hasPrefix("Nova asks before changing"))
  }

  func testMemoryOverviewDecodesAndLabels() throws {
    let json = ##"{"rules":[{"path":"agents/a1","subject":{"kind":"agent","id":"a1"},"level":"manage","builtin":true},{"id":"r1","path":"people/u1/plans","subject":{"kind":"all_agents"},"level":"read","startup":true,"createdBy":{"kind":"agent","id":"a1"}}],"sharedOut":[{"id":"r2","path":"agents/a1","subject":{"kind":"members"},"level":"read"}]}"##
    let overview = try Wire.decoder.decode(AgentMemoryAccess.self, from: Data(json.utf8))
    XCTAssertEqual(overview.rules.count, 2)
    XCTAssertNil(overview.rules[0].id)
    XCTAssertEqual(overview.rules[1].createdBy?.id, "a1")
    let agents = [try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))]
    let members = [Member(id: "u1", email: "o@example.test", name: "Alex", role: "owner")]
    XCTAssertEqual(AccessText.path("agents/a1/notes", agents: agents, members: members), "@darnold/notes")
    XCTAssertEqual(AccessText.path("people/u1/plans", agents: agents, members: members), "Alex/plans")
    XCTAssertEqual(AccessText.path("", agents: agents, members: members), "the whole vault")
    XCTAssertEqual(AccessText.subject(overview.sharedOut[0].subject, agents: agents, members: members), "Everyone (members)")
    XCTAssertEqual(AccessText.level("edit"), "Can edit")
  }

  func testSavingAccessSendsOnlyThatSetting() async throws {
    let store = try makeStore()
    reply("PATCH", "/api/agents/a1", agentJSON)
    try await store.updateAgent("a1", ["settings": AnyEncodable(["access": AgentAccess.full.rawValue])])
    let settings = try XCTUnwrap(lastBody("PATCH", "/api/agents/a1")["settings"] as? [String: Any])
    XCTAssertEqual(settings as? [String: String], ["access": "full"])
  }

  // MARK: connect

  func testConnectionConfigQuotesLikeTheWeb() {
    let hub = "https://wisp.example.test"
    XCTAssertEqual(ConnectionFormat.claude.config(hub: hub, token: "ab'c"),
      "claude mcp add wisp --env WISP_URL='https://wisp.example.test' --env WISP_TOKEN='ab'\\''c' -- wisp-mcp")
    XCTAssertEqual(ConnectionFormat.codex.config(hub: hub, token: "tok"),
      "[mcp_servers.wisp]\ncommand = \"wisp-mcp\"\nenv = { WISP_URL = \"https://wisp.example.test\", WISP_TOKEN = \"tok\" }")
    let json = ConnectionFormat.json.config(hub: hub, token: "tok")
    let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
    let env = ((parsed?["mcpServers"] as? [String: Any])?["wisp"] as? [String: Any])?["env"] as? [String: String]
    XCTAssertEqual(env, ["WISP_URL": hub, "WISP_TOKEN": "tok"])
    XCTAssertEqual(ConnectionFormat.initial(for: "claude-code"), .claude)
    XCTAssertEqual(ConnectionFormat.initial(for: "codex"), .codex)
    XCTAssertEqual(ConnectionFormat.initial(for: "grok"), .json)
  }

  func testTokenAndAppsEndpoints() async throws {
    let store = try makeStore()
    reply("POST", "/api/agents/a1/token", #"{"token":"wisp_secret"}"#)
    reply("GET", "/api/agents/a1/apps", #"[{"id":"g1","name":"ChatGPT","approvedBy":"Alex","createdAt":"2026-10-20T10:00:00Z","lastUsed":null}]"#)
    reply("DELETE", "/api/agents/a1/apps/g1", #"{"ok":true}"#)
    let token = try await store.createAgentToken("a1")
    XCTAssertEqual(token, "wisp_secret")
    let apps = try await store.connectedApps("a1")
    XCTAssertEqual(apps.map(\.name), ["ChatGPT"])
    XCTAssertEqual(apps[0].approvedBy, "Alex")
    try await store.revokeConnectedApp(agent: "a1", app: "g1")
    let revoked = ManagementHTTPStub.requests.withLock { $0 }.contains { $0.httpMethod == "DELETE" && $0.url?.path == "/api/agents/a1/apps/g1" }
    XCTAssertTrue(revoked)
  }

  func testShareAddressPrefersThePublicOne() async throws {
    let store = try makeStore()
    reply("GET", "/api/reach", #"{"publicUrl":"https://wisp.tail.test/","lan":["http://192.168.1.2:8787"]}"#)
    let address = await store.shareAddress()
    XCTAssertEqual(address, "https://wisp.tail.test")
    reply("GET", "/api/reach", "{}", status: 500)
    let fallback = await store.shareAddress()
    XCTAssertEqual(fallback, "https://management.test")
  }

  func testRunsOnDeviceMatchesTheWeb() {
    XCTAssertTrue(harnessRunsOnDevice("claude-code"))
    XCTAssertTrue(harnessRunsOnDevice("acp:thing"))
    XCTAssertTrue(harnessRunsOnDevice("hermes"))
    XCTAssertFalse(harnessRunsOnDevice("grok"))
    XCTAssertFalse(harnessRunsOnDevice("custom"))
  }

  // MARK: import

  func testFreeHandle() {
    XCTAssertEqual(AgentImportLogic.freeHandle("Claude Code (your setup)", taken: []), "claude")
    XCTAssertEqual(AgentImportLogic.freeHandle("Claude Code", taken: ["claude", "claude-2"]), "claude-3")
    XCTAssertEqual(AgentImportLogic.freeHandle("123", taken: []), "agent")
    XCTAssertEqual(AgentImportLogic.freeHandle("Hermes", taken: ["agent"]), "hermes")
  }

  func testScannedDevicesDecodeAndAlreadyHere() throws {
    let json = ##"[{"id":"n1","name":"My Mac","mine":true,"online":true,"discovered":[{"key":"hermes:default","harness":"hermes","name":"Hermes","description":"Helper","path":"~/.hermes","hasSoul":true,"memoryCount":2}]},{"id":"n2","name":"Theirs","mine":false,"shared":false,"online":true,"discovered":[]}]"##
    let devices = try Wire.decoder.decode([ScannedDevice].self, from: Data(json.utf8))
    XCTAssertEqual(devices.filter(\.usable).map(\.id), ["n1"])
    let found = try XCTUnwrap(devices[0].discovered?.first)
    XCTAssertEqual(found.summary, "Helper · has a personality · 2 notes")
    var agent = try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))
    XCTAssertFalse(AgentImportLogic.alreadyHere(found, on: devices[0], agents: [agent]))
    agent.harness = "hermes"; agent.name = "Hermes"
    XCTAssertTrue(AgentImportLogic.alreadyHere(found, on: devices[0], agents: [agent]))
  }

  func testImportSendsTheFieldsTheHubExpects() async throws {
    let store = try makeStore()
    reply("POST", "/api/agents/import", agentJSON)
    _ = try await store.importAgent(["nodeId": AnyEncodable("n1"), "key": AnyEncodable("hermes:default"), "handle": AnyEncodable("hermes"), "computerId": .null, "headless": AnyEncodable(false)])
    let body = try lastBody("POST", "/api/agents/import")
    XCTAssertEqual(body["key"] as? String, "hermes:default")
    XCTAssertTrue(body["computerId"] is NSNull)
    XCTAssertEqual(body["headless"] as? Bool, false)
  }

  func testScanAsksOnlyUsableOnlineDevices() async throws {
    let store = try makeStore()
    reply("GET", "/api/nodes", ##"[{"id":"n1","name":"A","mine":true,"online":true},{"id":"n2","name":"B","mine":true,"online":false},{"id":"n3","name":"C","mine":false,"shared":false,"online":true}]"##)
    reply("POST", "/api/nodes/n1/discover", #"{"ok":true}"#)
    try await store.scanDevicesForAgents()
    let asked = ManagementHTTPStub.requests.withLock { $0 }.filter { $0.url?.path.hasSuffix("/discover") == true }.map { $0.url?.path }
    XCTAssertEqual(asked, ["/api/nodes/n1/discover"])
  }

  // MARK: computer

  func testComputerChoiceDefaults() throws {
    let json = ##"{"id":"n1","name":"My Mac","mine":true,"online":true,"shared":false,"role":null,"capabilities":{"platform":"darwin","screen":{"ok":true},"vm":{"ok":true}}}"##
    var node = try Wire.decoder.decode(AgentNode.self, from: Data(json.utf8))
    XCTAssertEqual(ComputerChoice.initial(for: node, computers: []), .vm)
    let vm = Computer(id: "c1", name: "desk", kind: "vm", nodeId: "n1", status: "ready", statusText: "Ready")
    XCTAssertEqual(ComputerChoice.initial(for: node, computers: [vm]), .existing("c1"))
    XCTAssertTrue(ComputerChoice.existing("c1").vmOnDevice("n1", computers: [vm]))
    XCTAssertFalse(ComputerChoice.existing("c1").vmOnDevice("n2", computers: [vm]))
    node.role = "headless"
    XCTAssertEqual(ComputerChoice.initial(for: node, computers: [vm]), .headless)
    XCTAssertEqual(ComputerChoice.initial(for: nil, computers: []), .later)
  }

  func testCreatingAComputerRefreshesTheList() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers", #"{"id":"c9","name":"Darnold's desk","kind":"vm","nodeId":"n1","status":"starting","statusText":"Starting"}"#)
    let made = try await store.createComputer(["kind": AnyEncodable("vm"), "nodeId": AnyEncodable("n1"), "name": AnyEncodable("Darnold's desk")])
    XCTAssertEqual(made.id, "c9")
    XCTAssertEqual(try lastBody("POST", "/api/computers")["kind"] as? String, "vm")
  }

  // MARK: personality

  func testSoulTemplateAndPath() {
    XCTAssertEqual(SoulText.path("a1"), "agents/a1/SOUL.md")
    let text = SoulText.template(name: "Nova", handle: "nova")
    XCTAssertTrue(text.hasPrefix("# Nova\n\nWho @nova is."))
    XCTAssertTrue(text.contains("## Boundaries"))
  }

  // MARK: voice

  func testVoiceIndexMatchesTheWeb() {
    // the web's voiceIndex: ("nova",10) = 6, ("darnold",3) = 2, ("atlas",7) = 5
    XCTAssertEqual(AgentVoices.index("nova", count: 10), 6)
    XCTAssertEqual(AgentVoices.index("darnold", count: 3), 2)
    XCTAssertEqual(AgentVoices.index("atlas", count: 7), 5)
    XCTAssertEqual(AgentVoices.index("x", count: 0), 0)
  }

  func testRecommendedVoicesSkipNoveltyAndPreferTheLanguage() {
    let voices = [
      DeviceVoice(name: "Zarvox", lang: "en-US", id: "z"),
      DeviceVoice(name: "Samantha", lang: "en-US", id: "s", quality: 0, isDefault: true),
      DeviceVoice(name: "Daniel", lang: "en-GB", id: "d", quality: 4),
      DeviceVoice(name: "Amélie", lang: "fr-CA", id: "a"),
      DeviceVoice(name: "Samantha (Enhanced)", lang: "en-US", id: "s2", quality: 4),
    ]
    let picked = AgentVoices.recommend(voices, language: "en-US")
    XCTAssertFalse(picked.contains { $0.id == "z" })
    XCTAssertFalse(picked.contains { $0.id == "a" })
    XCTAssertEqual(picked.first?.id, "s2")
    XCTAssertEqual(picked.filter { $0.name.hasPrefix("Samantha") }.count, 1)
    XCTAssertEqual(AgentVoices.recommend(voices, language: "fr-CA").map(\.id), ["a"])
    XCTAssertEqual(AgentVoices.defaultLanguage(voices, language: "fr-FR"), "fr-CA")
    XCTAssertEqual(AgentVoices.filter(voices, query: "dan", lang: "").map(\.id), ["d"])
    XCTAssertEqual(AgentVoices.filter(voices, query: "", lang: "en_GB").map(\.id), ["d"])
  }

  func testVoiceChoicesKeepASavedVoiceVisible() throws {
    let agent = try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))
    let openai = AgentVoices.choices(engine: "openai", agent: agent, selected: "nova", recommended: [], all: [], language: { $0 })
    XCTAssertEqual(openai.first?.id, "")
    XCTAssertEqual(openai.first?.label, "Automatic for Darnold")
    XCTAssertEqual(openai.count, 11)
    let eleven = AgentVoices.choices(engine: "elevenlabs", agent: agent, selected: "custom-id", recommended: [], all: [], language: { $0 })
    XCTAssertEqual(eleven.last?.label, "Saved voice")
    XCTAssertEqual(eleven.last?.detail, "custom-id")
  }

  func testSavingAVoiceSendsOnlyTheVoice() async throws {
    let store = try makeStore()
    reply("PATCH", "/api/agents/a1", agentJSON)
    try await store.saveVoice(AgentVoice(device: nil, openai: "coral", elevenlabs: nil), for: store.agents[0])
    let settings = try XCTUnwrap(lastBody("PATCH", "/api/agents/a1")["settings"] as? [String: Any])
    XCTAssertEqual(Set(settings.keys), ["voice"])
    XCTAssertEqual((settings["voice"] as? [String: String]), ["openai": "coral"])
  }
}
