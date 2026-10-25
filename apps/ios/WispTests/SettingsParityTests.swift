import XCTest
import SwiftUI
@testable import Wisp

@MainActor
final class SettingsParityTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "owner"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    return store
  }
  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func body(_ method: String, _ path: String) throws -> [String: Any] {
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last { $0.httpMethod == method && $0.url?.path == path } })
    return try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testJoinRequestsAndEvents() throws {
    let request = try decode(JoinRequest.self, ##"{"id":"j1","name":"Studio PC","kind":"computer","platform":"win32","code":"123456","createdAt":"2026-10-25T10:00:00Z"}"##)
    XCTAssertEqual(request.displayCode, "123 456")
    let store = makeStore()
    store.handle(Data(##"{"type":"join_request","request":{"id":"j1","name":"Studio PC","kind":"computer","platform":"win32","code":"123456","createdAt":"x"}}"##.utf8))
    store.handle(Data(##"{"type":"join_request","request":{"id":"j1","name":"Studio PC","kind":"computer","platform":"win32","code":"123456","createdAt":"x"}}"##.utf8))
    XCTAssertEqual(store.joinRequests.map(\.id), ["j1"], "a replayed request is not listed twice")
    store.handle(Data(##"{"type":"join_request","request":{"id":"j2","name":"Bad","code":"12"}}"##.utf8))
    XCTAssertEqual(store.joinRequests.count, 1, "a request without a six-digit code is ignored")
    store.handle(Data(##"{"type":"join_request_done","id":"j1"}"##.utf8))
    XCTAssertTrue(store.joinRequests.isEmpty)
    store.role = "member"
    store.handle(Data(##"{"type":"join_request","request":{"id":"j3","name":"X","code":"654321"}}"##.utf8))
    XCTAssertTrue(store.joinRequests.isEmpty, "only owners see join requests")
  }

  func testApproveAndDenyPostToTheRequest() async throws {
    let store = makeStore()
    let request = try decode(JoinRequest.self, ##"{"id":"j1","name":"PC","code":"123456"}"##)
    store.joinRequests = [request]
    reply("POST", "/api/join/requests/j1/approve", ##"{"status":"approved"}"##); reply("GET", "/api/nodes", "[]")
    try await store.decideJoin(request, approve: true)
    XCTAssertTrue(store.joinRequests.isEmpty)
    store.joinRequests = [request]
    reply("POST", "/api/join/requests/j1/deny", "", status: 404)
    do { try await store.decideJoin(request, approve: false); XCTFail("expected an error") }
    catch { XCTAssertEqual(error.localizedDescription, "This request has ended.") }
    XCTAssertTrue(store.joinRequests.isEmpty, "an ended request leaves the list")
  }

  func testReachSummaryAndConnectorAddress() throws {
    let home = try decode(ReachInfo.self, ##"{"publicUrl":null,"lan":["http://192.168.1.4:4747"],"tailscale":{"state":"missing","serving":false,"funnel":false},"download":"https://tailscale.com/download","hubPlatform":"darwin"}"##)
    XCTAssertFalse(home.awayOn); XCTAssertEqual(home.summary, "Only at home for now"); XCTAssertEqual(home.computerName, "Mac"); XCTAssertNil(home.connectorOrigin)
    let served = try decode(ReachInfo.self, ##"{"publicUrl":"https://mac.tail.ts.net","tailscale":{"state":"running","serving":true,"funnel":false}}"##)
    XCTAssertTrue(served.awayOn); XCTAssertEqual(served.summary, "On, with Tailscale"); XCTAssertNil(served.connectorOrigin, "Serve is private; only Funnel works for other apps")
    let funnel = try decode(ReachInfo.self, ##"{"publicUrl":"https://mac.tail.ts.net/","tailscale":{"state":"running","serving":true,"funnel":true}}"##)
    XCTAssertEqual(funnel.connectorOrigin, "https://mac.tail.ts.net")
    let tunnel = try decode(ReachInfo.self, ##"{"publicUrl":null,"tailscale":{"state":"stopped"},"cloudflare":{"state":"running","url":"https://wisp.example.com","error":null}}"##)
    XCTAssertEqual(tunnel.summary, "On, with Cloudflare"); XCTAssertEqual(tunnel.connectorOrigin, "https://wisp.example.com")
  }

  func testReachActionsAndMcpClients() async throws {
    let store = makeStore()
    reply("POST", "/api/reach/cloudflare", ##"{"tailscale":{"state":"stopped"},"cloudflare":{"state":"starting","url":null,"error":null}}"##)
    let info = try await store.startCloudflare(token: "abcdefghijklmnopqrstuvwxyz")
    XCTAssertEqual(info.cloudflare?.state, "starting")
    XCTAssertEqual(try body("POST", "/api/reach/cloudflare")["action"] as? String, "start")
    XCTAssertEqual(try body("POST", "/api/reach/cloudflare")["token"] as? String, "abcdefghijklmnopqrstuvwxyz")
    reply("GET", "/api/mcp/clients", ##"[{"id":"g1","name":"ChatGPT","agentId":"a1","agentName":"Nova","createdAt":"2026-10-24T10:00:00Z","lastUsed":null}]"##)
    let clients = try await store.mcpClients()
    XCTAssertEqual(clients?.first?.agentName, "Nova")
    reply("GET", "/api/mcp/clients", "", status: 404)
    let none = try await store.mcpClients()
    XCTAssertNil(none, "an older hub has no connected-apps list")
  }

  func testLeadSavesAndUpdatesTheStore() async throws {
    let store = makeStore()
    reply("PUT", "/api/settings/lead", ##"{"lead":"a2","leadId":"a2"}"##)
    try await store.saveLead("a2")
    XCTAssertEqual(store.taskLeadOverride, "a2")
    XCTAssertEqual(try body("PUT", "/api/settings/lead")["leadId"] as? String, "a2")
    reply("PUT", "/api/settings/lead", ##"{"lead":"a1","leadId":null}"##)
    try await store.saveLead(nil)
    XCTAssertNil(store.taskLeadOverride); XCTAssertEqual(store.taskLead, "a1")
    XCTAssertTrue(try body("PUT", "/api/settings/lead")["leadId"] is NSNull)
  }

  func testHarnessSettingsDecodeAndChange() async throws {
    let json = ##"{"device":{"id":"n1","name":"Studio Mac"},"harnesses":[{"harness":"codex","account":"default","accounts":[{"id":"default","label":"Codex","isDefault":true,"signedIn":true,"who":"sam@example.test"},{"id":"work","label":"Work","isDefault":false,"signedIn":false}],"multiAccount":true,"agentAccounts":{"a1":"work"},"configPath":"/Users/sam/.codex/config.toml","model":"gpt-5","provider":null,"providers":null,"apps":[{"id":"github","name":"GitHub","enabled":true,"canToggle":true,"detail":"npx github"}],"plugins":[],"skills":[{"id":"review","name":"Review","description":"Reviews code","enabled":false,"canToggle":true}],"fixed":["provider"]}],"agents":[{"id":"a1","handle":"nova","name":"Nova","harness":"codex"}],"catalog":[{"harness":"codex","version":"1","models":[{"id":"gpt-5","label":"GPT-5"}],"efforts":[],"defaultModel":"gpt-5"}]}"##
    let response = try decode(HarnessesResponse.self, json)
    let settings = try XCTUnwrap(response.harnesses.first)
    XCTAssertEqual(settings.accounts.count, 2); XCTAssertEqual(settings.currentAccount?.who, "sam@example.test")
    XCTAssertEqual(settings.agentAccounts["a1"], "work"); XCTAssertTrue(settings.providerFixed); XCTAssertFalse(settings.modelFixed)
    XCTAssertEqual(response.catalog?.first?.models.first?.label, "GPT-5")
    // a device that leaves out the defaulted fields still decodes
    let bare = try decode(HarnessSettings.self, ##"{"harness":"hermes","configPath":"/x","model":null,"provider":null,"providers":null}"##)
    XCTAssertEqual(bare.account, "default"); XCTAssertTrue(bare.apps.isEmpty)

    let store = makeStore()
    reply("PATCH", "/api/nodes/n1/harness-settings/codex", ##"{"harness":"codex","configPath":"/x","model":"gpt-5.1","provider":null,"providers":null}"##)
    let changed = try await store.changeHarness(device: "n1", harness: "codex", account: "work", [HarnessChange(op: "toggle", kind: "app", id: "github", enabled: false)])
    XCTAssertEqual(changed.model, "gpt-5.1")
    let sent = try body("PATCH", "/api/nodes/n1/harness-settings/codex")
    XCTAssertEqual(sent["account"] as? String, "work")
    let change = try XCTUnwrap((sent["changes"] as? [[String: Any]])?.first)
    XCTAssertEqual(change["op"] as? String, "toggle"); XCTAssertEqual(change["enabled"] as? Bool, false); XCTAssertNil(change["model"])
  }

  func testHarnessLoginAndAccountCalls() async throws {
    XCTAssertEqual(try decode(HarnessLogin.self, ##"{"manual":"hermes login"}"##).manual, "hermes login")
    let running = try decode(HarnessLogin.self, ##"{"id":"l1","harness":"codex","account":"work","status":"running","url":"https://auth.example.com/x","code":"AB-12","output":""}"##)
    XCTAssertEqual(running.code, "AB-12")
    let store = makeStore()
    reply("POST", "/api/nodes/n1/harness-accounts/codex", ##"{"id":"work"}"##)
    _ = try await store.harnessAccount(device: "n1", harness: "codex", ["op": AnyEncodable("assign"), "agentId": AnyEncodable("a1"), "account": .null])
    let sent = try body("POST", "/api/nodes/n1/harness-accounts/codex")
    XCTAssertEqual(sent["op"] as? String, "assign"); XCTAssertTrue(sent["account"] is NSNull)
  }

  func testAskAgentSendsInTheDirectMessage() async throws {
    let store = makeStore()
    let agent = try decode(Agent.self, ##"{"id":"a1","handle":"nova","name":"Nova","harness":"codex","status":"online"}"##)
    store.agents = [agent]
    reply("POST", "/api/dm/a1", ##"{"id":"c9","name":"dm:u1:a1","kind":"dm","topic":"","createdAt":"2026-10-25T10:00:00Z"}"##)
    reply("GET", "/api/channels", ##"[{"id":"c9","name":"dm:u1:a1","kind":"dm","topic":"","createdAt":"2026-10-25T10:00:00Z"}]"##)
    reply("POST", "/api/channels/c9/messages", ##"{"id":"m1","channelId":"c9","author":{"kind":"user","id":"u1"},"body":"turn on voice","parts":[],"createdAt":"2026-10-25T10:00:00Z"}"##)
    try await store.ask(agent, "turn on voice")
    XCTAssertEqual(try body("POST", "/api/channels/c9/messages")["body"] as? String, "turn on voice")
    XCTAssertEqual(store.route, .chat(channelId: "c9", threadId: nil))
  }

  func testThemesAndTextSize() {
    XCTAssertEqual(AppTheme.all.map(\.id), ["mono", "mint", "iris", "lilac", "sky"])
    XCTAssertEqual(AppTheme.named("nope").id, "mono")
    XCTAssertEqual(ThemeSettings.shifted(.large, "small"), .medium)
    XCTAssertEqual(ThemeSettings.shifted(.large, "large"), .xLarge)
    XCTAssertEqual(ThemeSettings.shifted(.large, "default"), .large)
    XCTAssertEqual(ThemeSettings.shifted(.xSmall, "small"), .xSmall, "stops at the smallest size")
    XCTAssertEqual(ThemeSettings.shifted(.accessibility5, "large"), .accessibility5, "stops at the biggest size")
  }
}
