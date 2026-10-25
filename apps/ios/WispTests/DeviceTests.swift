import XCTest
import SwiftUI
@testable import Wisp

@MainActor
final class DeviceTests: XCTestCase {
  private let agentJSON = ##"{"id":"a1","name":"Darnold","handle":"darnold","harness":"codex","model":null,"nodeId":"n1","computerId":null,"groups":[],"settings":{},"status":"online"}"##
  private let screenJSON = #"{"id":"c-screen","name":"My Mac","kind":"device","nodeId":"n1","status":"ready","statusText":"Ready"}"#
  private let nodeJSON = #"{"id":"n1","name":"My Mac","mine":true,"ownerId":"u1","ownerName":"You","online":true,"shared":false,"role":null,"paused":true,"lastSeen":null,"agents":["a1"],"version":null,"update":null,"capabilities":{"platform":"darwin","arch":"arm64","screen":{"ok":true,"detail":"","code":"pin"},"vm":{"ok":true,"detail":"","engine":"lume","image":"ready"},"rustdesk":{"id":"482117903"},"remoteApps":["anydesk","something-new"],"commands":{"npx":true}},"remoteDesktop":{"app":"anydesk","value":"123456789"}}"#

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
    store.nodes = [try Wire.decoder.decode(AgentNode.self, from: Data(nodeJSON.utf8))]
    reply("GET", "/api/nodes", "[\(nodeJSON)]")
    reply("GET", "/api/computers", "[]")
    reply("PATCH", "/api/agents/a1", agentJSON)
    reply("PATCH", "/api/nodes/n1", #"{"ok":true}"#)
    return store
  }

  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }

  private func sent(_ method: String, _ path: String) -> [[String: Any]] {
    ManagementHTTPStub.requests.withLock { $0 }
      .filter { $0.httpMethod == method && $0.url?.path == path }
      .compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
  }

  func testNodeDecodesCapabilitiesAndRemoteDesktop() throws {
    let node = try Wire.decoder.decode(AgentNode.self, from: Data(nodeJSON.utf8))
    XCTAssertEqual(node.capabilities?.osName, "Mac")
    XCTAssertEqual(node.capabilities?.screen?.ok, true)
    XCTAssertEqual(node.capabilities?.screen?.code, "pin")
    XCTAssertEqual(node.capabilities?.vm?.ok, true)
    XCTAssertEqual(node.capabilities?.rustdesk?.id, "482117903")
    XCTAssertEqual(node.paused, true)
    XCTAssertEqual(node.remoteDesktop, OwnRemoteDesktop(app: .anydesk, typed: "123456789"))
    // apps found on the device come first; ones this app doesn't know are left out of the picker
    XCTAssertEqual(RemoteApp.ordered(found: node.capabilities?.remoteApps).first, .anydesk)
    XCTAssertEqual(RemoteApp.ordered(found: node.capabilities?.remoteApps).count, RemoteApp.allCases.count)

    // an older hub sends neither; an app a newer hub knows still decodes, as another app
    let bare = try Wire.decoder.decode(AgentNode.self, from: Data(#"{"id":"n2","name":"Box","online":false}"#.utf8))
    XCTAssertNil(bare.capabilities)
    XCTAssertNil(bare.remoteDesktop)
    let newer = try Wire.decoder.decode(OwnRemoteDesktop.self, from: Data(#"{"app":"parsec","value":"https://parsec.app/x"}"#.utf8))
    XCTAssertEqual(newer.app, .other)
    XCTAssertEqual(newer.label, "Another app")
  }

  func testRemoteDesktopMod() throws {
    let on = try Wire.decoder.decode(Features.self, from: Data(#"{"remoteDesktop":true}"#.utf8))
    let off = try Wire.decoder.decode(Features.self, from: Data(#"{"remoteDesktop":false}"#.utf8))
    XCTAssertTrue(on.remoteDesktop)
    XCTAssertFalse(off.remoteDesktop)
    XCTAssertFalse(Features.simple.remoteDesktop)
    XCTAssertEqual(FeatureKey.remoteDesktop.group, .extras)
  }

  func testIDsAndLinks() {
    XCTAssertEqual(DeviceText.rustdeskID("482117903"), "482 117 903")
    XCTAssertEqual(DeviceText.rustdeskID("1234567890"), "1 234 567 890")
    XCTAssertEqual(DeviceText.rustdeskID("ab-12"), "ab-12")
    XCTAssertEqual(DeviceText.rustdeskLink("482117903")?.absoluteString, "rustdesk://482117903")
    XCTAssertNil(DeviceText.rustdeskLink("12 3/../x"))

    func link(_ app: RemoteApp, _ value: String) -> String? { OwnRemoteDesktop(app: app, typed: value).link?.absoluteString }
    XCTAssertEqual(link(.anydesk, "123 456 789"), "anydesk:123456789")
    XCTAssertEqual(link(.teamviewer, "123456789"), "teamviewer10://control?device=123456789")
    XCTAssertNil(link(.teamviewer, "shop@alias"))
    XCTAssertEqual(link(.rdp, "shop-pc.local"), "rdp://full%20address=s:shop-pc.local")
    XCTAssertEqual(link(.screenSharing, "192.168.1.20:5900"), "vnc://192.168.1.20:5900")
    XCTAssertEqual(link(.vnc, "shop-pc.local"), "vnc://shop-pc.local")
    XCTAssertEqual(link(.chrome, " https://remotedesktop.google.com/access "), "https://remotedesktop.google.com/access")
    // only the exact shapes open: nothing else gets handed to the system
    XCTAssertNil(link(.other, "http://example.com"))
    XCTAssertNil(link(.other, "javascript:alert(1)"))
    XCTAssertNil(link(.vnc, "shop pc; rm"))
    XCTAssertNil(link(.anydesk, "12"))
  }

  func testTypedValuesAndProblems() {
    XCTAssertEqual(OwnRemoteDesktop(app: .teamviewer, typed: " 123 456\t789 ").value, "123456789")
    XCTAssertEqual(OwnRemoteDesktop(app: .rdp, typed: "  shop-pc.local ").value, "shop-pc.local")
    XCTAssertNil(OwnRemoteDesktop(app: .vnc, typed: "shop-pc.local", name: "Mine").name, "only another app has a name")
    XCTAssertEqual(OwnRemoteDesktop(app: .other, typed: "https://parsec.app/x", name: " Parsec ").label, "Parsec")
    XCTAssertEqual(OwnRemoteDesktop(app: .anydesk, typed: "1").problem, "That doesn't look like an ID.")
    XCTAssertEqual(OwnRemoteDesktop(app: .rdp, typed: "http://x").problem, "Enter a computer name or address, like shop-pc.local or 192.168.1.20.")
    XCTAssertEqual(OwnRemoteDesktop(app: .chrome, typed: "remotedesktop.google.com").problem, "Paste a link that starts with https://")
    XCTAssertNil(OwnRemoteDesktop(app: .chrome, typed: "https://remotedesktop.google.com/access").problem)
  }

  func testThisScreenMakesTheScreenAComputerOnce() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers", screenJSON)
    try await store.setWorksOn(.screen, agent: store.agents[0], node: store.nodes[0])
    XCTAssertEqual(sent("POST", "/api/computers").count, 1)
    XCTAssertEqual(sent("POST", "/api/computers").first as? [String: String], ["kind": "device", "nodeId": "n1"])
    XCTAssertEqual(sent("PATCH", "/api/agents/a1").last?["computerId"] as? String, "c-screen")

    // the screen is a computer now, so the next pick only moves the agent
    store.computers = [try Wire.decoder.decode(Computer.self, from: Data(screenJSON.utf8))]
    ManagementHTTPStub.requests.withLock { $0 = [] }
    try await store.setWorksOn(.screen, agent: store.agents[0], node: store.nodes[0])
    XCTAssertTrue(sent("POST", "/api/computers").isEmpty)
    XCTAssertEqual(sent("PATCH", "/api/agents/a1").count, 1)
  }

  func testNoComputerAndNewVMBodies() async throws {
    let store = try makeStore()
    try await store.setWorksOn(.none, agent: store.agents[0], node: store.nodes[0])
    let none = try XCTUnwrap(sent("PATCH", "/api/agents/a1").last)
    XCTAssertTrue(none["computerId"] is NSNull, "No computer sends an explicit null")
    XCTAssertEqual(none["settings"] as? [String: Bool], ["headless": true])

    reply("POST", "/api/computers", #"{"id":"c-vm","name":"Darnold's desk","kind":"vm","nodeId":"n1","status":"starting","statusText":"Starting"}"#)
    try await store.setWorksOn(.newVM, agent: store.agents[0], node: store.nodes[0])
    let vm = try XCTUnwrap(sent("POST", "/api/computers").last)
    XCTAssertEqual(vm["kind"] as? String, "vm")
    XCTAssertEqual(vm["nodeId"] as? String, "n1")
    XCTAssertEqual(vm["name"] as? String, "Darnold's desk")
    XCTAssertEqual(vm["cpus"] as? Int, 2)
    XCTAssertEqual(vm["memoryGb"] as? Int, 4)
    let moved = try XCTUnwrap(sent("PATCH", "/api/agents/a1").last)
    XCTAssertEqual(moved["computerId"] as? String, "c-vm")
    XCTAssertEqual(moved["settings"] as? [String: String], ["runIn": "computer"], "codex comes with the VM")

    try await store.setWorksOn(.computer("c-vm"), agent: store.agents[0], node: store.nodes[0])
    XCTAssertEqual(sent("PATCH", "/api/agents/a1").last as? [String: String], ["computerId": "c-vm"])
  }

  func testRemoteDesktopIsSavedAndForgotten() async throws {
    let store = try makeStore()
    try await store.setRemoteDesktop("n1", OwnRemoteDesktop(app: .other, typed: "https://parsec.app/x", name: "Parsec"))
    XCTAssertEqual(sent("PATCH", "/api/nodes/n1").last?["remoteDesktop"] as? [String: String], ["app": "other", "value": "https://parsec.app/x", "name": "Parsec"])
    try await store.setRemoteDesktop("n1", OwnRemoteDesktop(app: .rdp, typed: "shop-pc.local"))
    XCTAssertEqual(sent("PATCH", "/api/nodes/n1").last?["remoteDesktop"] as? [String: String], ["app": "rdp", "value": "shop-pc.local"])
    try await store.setRemoteDesktop("n1", nil)
    XCTAssertTrue(sent("PATCH", "/api/nodes/n1").last?["remoteDesktop"] is NSNull)

    reply("PATCH", "/api/nodes/n1", #"{"error":"remoteDesktop.value: That doesn't look like an ID."}"#, status: 400)
    do {
      try await store.setRemoteDesktop("n1", OwnRemoteDesktop(app: .anydesk, typed: "123456789"))
      XCTFail("expected the hub's error")
    } catch { XCTAssertEqual(error.localizedDescription, "remoteDesktop.value: That doesn't look like an ID.") }
  }

  func testUpdateWispPostsToTheDevice() async throws {
    let store = try makeStore()
    reply("POST", "/api/nodes/n1/update", #"{"update":{"state":"updating","message":""}}"#)
    try await store.updateDeviceWisp("n1")
    XCTAssertEqual(ManagementHTTPStub.requests.withLock { $0 }.filter { $0.httpMethod == "POST" }.map { $0.url?.path }, ["/api/nodes/n1/update"])
  }

  func testDevicePageRenders() async throws {
    let store = try makeStore()
    store.features = .everything
    let controller = UIHostingController(rootView: NavigationStack { DeviceDetail(node: store.nodes[0]) }.environment(store))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first { $0.isKeyWindow }
    defer { previous?.makeKey() }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    try await Task.sleep(for: .milliseconds(350))
    let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    let pixels = try XCTUnwrap(image.cgImage?.dataProvider?.data) as Data
    XCTAssertGreaterThan(Set(pixels).count, 16)
    let attachment = XCTAttachment(image: image)
    attachment.name = "Device"
    attachment.lifetime = .keepAlways
    add(attachment)
    window.isHidden = true
  }
}
