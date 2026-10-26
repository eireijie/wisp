import XCTest
@testable import Wisp

@MainActor
final class FoundationTests: XCTestCase {
  private func agent(_ id: String) -> Agent { Agent(id: id, handle: id, name: id.capitalized, harness: "codex", status: .online) }
  private func channel(_ id: String, name: String, kind: String = "channel") -> Channel {
    var c = Channel(id: id, name: name, kind: kind, topic: "", createdAt: "2026-10-18T12:00:00Z")
    c.joined = true
    return c
  }
  private func message(_ id: String, _ channel: String, at: String) -> Message {
    Message(id: id, channelId: channel, author: Actor(kind: .user, id: "u1"), body: "hi", parts: [], createdAt: at)
  }

  func testChatListIsFlatPinnedFirstThenRecent() {
    let agents = [agent("a1"), agent("a2")]
    var channels = [channel("d1", name: "dm:u:a1", kind: "dm"), channel("d2", name: "dm:u:a2", kind: "dm"), channel("c1", name: "crew"), channel("c2", name: "old")]
    channels[3].archivedAt = "2026-10-19T00:00:00Z"
    let messages = ["d1": [message("m1", "d1", at: "2026-10-20T10:00:00Z")], "c1": [message("m2", "c1", at: "2026-10-21T10:00:00Z")]]
    let find: (Channel) -> Agent? = { ch in agents.first { ch.name.hasSuffix($0.id) } }
    let list = ChatList.entries(agents: agents, channels: channels, messages: messages, dmAgent: find)
    XCTAssertEqual(list.map(\.name), ["crew", "A1", "A2"], "most recent first, archived teams left out")
    XCTAssertEqual(list.first { $0.name == "A2" }?.channel?.id, "d2")
    channels[1].starred = true
    let again = ChatList.entries(agents: agents, channels: channels, messages: messages, dmAgent: find)
    XCTAssertEqual(again.first?.name, "A2")
    XCTAssertTrue(again.first?.pinned == true)
  }

  func testChatListOrdersUnloadedChatsByTheChannelListsLastMessage() {
    var channels = [channel("c1", name: "alpha"), channel("c2", name: "zulu")]
    channels[1].last = Channel.Last(at: "2026-10-25T10:00:00Z")
    let messages = ["c1": [message("m1", "c1", at: "2026-10-20T10:00:00Z")]]
    let list = ChatList.entries(agents: [], channels: channels, messages: messages, dmAgent: { _ in nil })
    XCTAssertEqual(list.map(\.name), ["zulu", "alpha"])
    XCTAssertNotNil(list.first?.lastAt)
  }

  func testTimeText() {
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
    let now = Date(timeIntervalSince1970: 1_792_000_000)
    XCTAssertNotEqual(ChatList.timeText(now.addingTimeInterval(-86_400 * 3), now: now, calendar: cal), ChatList.timeText(now, now: now, calendar: cal))
  }

  func testHubUpdateDetection() {
    XCTAssertFalse(Store.hubChanged(baseline: nil, now: "abc"))
    XCTAssertFalse(Store.hubChanged(baseline: "abc", now: "abc"))
    XCTAssertFalse(Store.hubChanged(baseline: "abc", now: nil))
    XCTAssertTrue(Store.hubChanged(baseline: "abc", now: "def"))
  }
}
