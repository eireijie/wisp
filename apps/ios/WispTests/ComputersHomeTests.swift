import XCTest
import SwiftUI
@testable import Wisp

/** The merged Computers tab: states, groups, the add flows and where the old Devices links go. */
@MainActor
final class ComputersHomeTests: XCTestCase {
  private func computer(_ extra: String = "") throws -> Computer {
    let json = #"{"id":"c1","name":"Desk","kind":"vm","nodeId":"n1","status":"ready","statusText":"","online":true,"paused":false,"code":null,"agents":["a1"],"controller":null,"help":null\#(extra)}"#
    return try Wire.decoder.decode(Computer.self, from: Data(json.utf8))
  }

  func testComputerStatesReadInAWordOrTwo() throws {
    let store = Store(loadSession: false)
    store.me = User(id: "u1", email: "o@example.test", name: "You")
    XCTAssertEqual(store.state(of: try computer()).label, "Ready")
    var working = try computer()
    working.activity = Computer.Activity(agentId: "a1", text: "Opened Chrome", at: Wire.now())
    XCTAssertEqual(store.state(of: working).label, "Working")
    var c = try computer()
    c.online = false
    XCTAssertEqual(store.state(of: c).label, "Offline")
    c.online = true; c.paused = true
    XCTAssertEqual(store.state(of: c).label, "Paused at the device")
    c.paused = false; c.status = "error"
    XCTAssertEqual(store.state(of: c).tone == .bad, true)
    c.status = "ready"; c.controller = Computer.Controller(id: "u1", since: "2026-10-25T10:00:00Z")
    XCTAssertEqual(store.state(of: c).label, "You're in control")
    c.controller = Computer.Controller(id: "u2", since: "2026-10-25T10:00:00Z")
    XCTAssertEqual(store.state(of: c).label, "In control")
  }

  func testWhatItIsDoingPutsHelpFirst() throws {
    let store = Store(loadSession: false)
    var c = try computer()
    XCTAssertEqual(store.doing(c), "No agents yet")
    c.help = Computer.Help(agentId: "a1", request: "It is stuck on a sign-in page.", channelId: "c1", threadId: nil)
    XCTAssertEqual(store.doing(c), "Needs you: It is stuck on a sign-in page.")
    c.help = nil; c.kind = "device"
    XCTAssertEqual(store.doing(c), "Agents ask before using it")
  }

  func testDeviceStatesIncludeUpdating() throws {
    let json = #"{"id":"n1","name":"Mac","mine":true,"online":true,"update":{"state":"updating","message":"Getting the latest Wisp"}}"#
    let node = try Wire.decoder.decode(AgentNode.self, from: Data(json.utf8))
    XCTAssertTrue(node.isUpdating)
    let idle = try Wire.decoder.decode(AgentNode.self, from: Data(#"{"id":"n1","name":"Mac","online":true,"update":{"state":"idle","message":""}}"#.utf8))
    XCTAssertFalse(idle.isUpdating)
  }

  func testDeviceLinksOpenTheComputersTab() {
    // the old Devices entry points set this route; the tab then shows the device (or the page)
    XCTAssertEqual(Route.device(id: nil).tab, .computers)
    XCTAssertEqual(Route.computer(id: "c1").tab, .computers)
    XCTAssertEqual(Route.inbox.tab, .inbox)
    XCTAssertEqual(Route.approval(id: "a1").tab, .inbox)
    XCTAssertEqual(Route.chat(channelId: "c", threadId: nil).tab, .chats)
    XCTAssertNotEqual(Route.device(id: nil), Route.device(id: "n1"))
    XCTAssertEqual(Route.device(id: "n1"), Route.device(id: "n1"))
  }

  func testJoinCommandsQuoteTheName() {
    let commands = ComputerJoinCommands.make(hub: "http://mac.local:7777/", token: "tok", name: "Sam's PC")
    XCTAssertEqual(commands.map(\.0), ["Mac / Linux", "Windows", "Already installed"])
    XCTAssertTrue(commands[0].1.contains("--hub http://mac.local:7777 --token tok --name 'Sam'\\''s PC'"))
    XCTAssertTrue(commands[1].1.contains("-Name 'Sam''s PC'"))
  }

  func testQRCodeRendersAnImage() {
    XCTAssertNotNil(QRCode.image("wisp://pair?id=abc"))
  }

  func testPairingStatesDecode() throws {
    let info = try Wire.decoder.decode(PairInfo.self, from: Data(#"{"id":"p1","state":"claimed","code":"482913","deviceName":"iPhone","expiresAt":"2026-10-25T10:05:00Z"}"#.utf8))
    XCTAssertEqual(info.state, "claimed")
    XCTAssertEqual(info.code, "482913")
  }

  func testComputersPageRendersGroups() throws {
    let store = Store(loadSession: false)
    store.role = "owner"
    store.me = User(id: "u1", email: "o@example.test", name: "You")
    store.nodes = [try Wire.decoder.decode(AgentNode.self, from: Data(#"{"id":"n1","name":"Mac mini","mine":true,"online":true}"#.utf8))]
    store.computers = [try computer()]
    let controller = UIHostingController(rootView: ComputersView().environment(store))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    controller.view.layoutIfNeeded()
    XCTAssertFalse(controller.view.subviews.isEmpty, "the page drew something")
  }
}
