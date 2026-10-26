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
