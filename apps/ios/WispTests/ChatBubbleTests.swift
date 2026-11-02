import XCTest
@testable import Wisp

final class ChatBubbleTests: XCTestCase {
  private func msg(_ id: String, at: String, author: Actor = Actor(kind: .user, id: "u1"), body: String = "hi") -> Message {
    Message(id: id, channelId: "c1", author: author, body: body, parts: [], createdAt: at)
  }

  func testTimeLabelAfterThirtyQuietMinutes() {
    let a = msg("a", at: "2026-10-24T21:30:00.000Z")
    XCTAssertTrue(ChatFormat.needsStamp(nil, a))
    XCTAssertFalse(ChatFormat.needsStamp(a, msg("b", at: "2026-10-24T21:45:00.000Z")))
    XCTAssertTrue(ChatFormat.needsStamp(a, msg("c", at: "2026-10-24T22:05:00.000Z")))
  }

  private func chatMsg(_ id: String, at: String, chat: String?) -> Message {
    var m = msg(id, at: at)
    m.conversationId = chat
    return m
  }

  func testNewChatStartsWhereTheChatChanges() {
    let a = chatMsg("a", at: "2026-10-24T09:14:00.000Z", chat: "a")
    let b = chatMsg("b", at: "2026-10-24T09:20:00.000Z", chat: "a")
    let c = chatMsg("c", at: "2026-10-24T18:40:00.000Z", chat: "c")
    XCTAssertTrue(ChatFormat.startsChat(nil, a), "the first loaded message opens its chat")
    XCTAssertFalse(ChatFormat.startsChat(a, b))
    XCTAssertTrue(ChatFormat.startsChat(b, c))
    XCTAssertTrue(ChatFormat.breaks(b, c))
    // the first loaded message part-way into a chat: no divider (the plain time label shows instead)
    XCTAssertFalse(ChatFormat.startsChat(nil, b))
    // threads and older hubs have no chats
    XCTAssertFalse(ChatFormat.startsChat(nil, msg("t", at: "2026-10-24T09:14:00.000Z")))
    XCTAssertFalse(ChatFormat.startsChat(a, msg("t", at: "2026-10-24T19:14:00.000Z")))
    // an older message with no chat, then one with a chat: a new chat begins
    XCTAssertTrue(ChatFormat.startsChat(msg("o", at: "2026-10-24T09:14:00.000Z"), c))
    XCTAssertEqual(ChatFormat.lastOfChat("a", in: [a, b, c])?.id, "b")
  }

  func testChatNames() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let locale = Locale(identifier: "en_US")
    let now = Wire.date("2026-10-25T12:00:00.000Z")!
    let today = Wire.date("2026-10-25T09:14:00.000Z")!
    let yesterday = Wire.date("2026-10-24T09:14:00.000Z")!
    func name(_ d: Date) -> String { ChatFormat.chatName(d, now: now, calendar: cal, locale: locale).replacingOccurrences(of: "\u{202F}", with: " ") }
    // times are formatted in the device's time zone; only the wording around them is checked here
    XCTAssertTrue(name(today).hasPrefix("the ") && name(today).hasSuffix(" chat"))
    XCTAssertTrue(name(yesterday).hasPrefix("yesterday's "))
  }

  func testMessageDecodesChats() throws {
    let json = #"{"id":"m2","channelId":"c1","author":{"kind":"agent","id":"a1"},"body":"ok","parts":[],"createdAt":"2026-10-25T09:30:00.000Z","conversationId":"m2","context":{"conversationId":"m0","at":"2026-10-24T09:14:00.000Z"},"replyTo":{"id":"m1","author":{"kind":"agent","id":"a1"},"snippet":"Booked","createdAt":"2026-10-24T09:52:00.000Z","conversationId":"m0"}}"#
    let m = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    XCTAssertEqual(m.conversationId, "m2")
    XCTAssertEqual(m.context?.conversationId, "m0")
    XCTAssertEqual(m.replyTo?.conversationId, "m0")
    XCTAssertNotNil(m.replyTo?.createdAt)
  }

  func testGroupingNeverJoinsSystemLines() {
    let sys = Actor(kind: .user, id: "system")
    XCTAssertTrue(ChatFormat.groups(msg("a", at: "2026-10-24T21:30:00.000Z"), msg("b", at: "2026-10-24T21:33:00.000Z")))
    XCTAssertFalse(ChatFormat.groups(msg("a", at: "2026-10-24T21:30:00.000Z"), msg("b", at: "2026-10-24T21:40:00.000Z")))
    XCTAssertFalse(ChatFormat.groups(msg("a", at: "2026-10-24T21:30:00.000Z", author: sys), msg("b", at: "2026-10-24T21:31:00.000Z", author: sys)))
  }

  func testSnippetAndToolLines() {
    XCTAssertEqual(ChatFormat.snippet(msg("a", at: "2026-10-24T21:30:00.000Z", body: "  Plan's   ready:\n3 steps ")), "Plan's ready: 3 steps")
    XCTAssertEqual(ToolLine.of("Read", input: ["file_path": .string("/repo/RELEASE-CHECKLIST.md")]), "Read RELEASE-CHECKLIST.md")
    let saved = ToolLine.remembered("mcp__wisp__memory_remember", input: ["kind": .string("plan"), "text": .string("Release is Friday")], output: "Saved people/yug.md")
    XCTAssertEqual(saved?.text, "Release is Friday")
    XCTAssertEqual(saved?.path, "people/yug.md")
    XCTAssertNil(ToolLine.remembered("mcp__wisp__memory_remember", input: ["text": .string("x")], output: "Not saved"))
  }

  func testWorkingLabel() {
    XCTAssertEqual(WorkLabel.of(tool: "Read", file: "/x/main.ts", activity: nil), "Reading main.ts")
    XCTAssertEqual(WorkLabel.of(tool: nil, file: nil, activity: "started"), "Thinking…")
  }

  func testMessageDecodesReplyQuote() throws {
    let json = #"{"id":"m1","channelId":"c1","threadId":null,"author":{"kind":"user","id":"u1"},"body":"ok","parts":[],"createdAt":"2026-10-24T21:30:00.000Z","replyToId":"m0","replyTo":{"id":"m0","author":{"kind":"agent","id":"a1"},"snippet":"Plan"}}"#
    let m = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    XCTAssertEqual(m.replyTo?.snippet, "Plan")
    XCTAssertEqual(m.replyToId, "m0")
  }
}
