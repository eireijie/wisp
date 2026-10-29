import XCTest
@testable import Wisp

/** Open loops and promises: the new message parts, the chat list's `loop`/`next`, and the pure logic in Loops.swift. */
@MainActor
final class LoopsTests: XCTestCase {
  private var calendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "America/New_York")!
    return c
  }()

  private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
  }

  private func message(_ id: String, author: String = "agent", kind: String = "agent", parts: String = "[]", thread: String? = nil) -> Message {
    let json = #"{"id":"\#(id)","channelId":"c1","threadId":\#(thread.map { "\"\($0)\"" } ?? "null"),"author":{"kind":"\#(kind)","id":"\#(author)"},"body":"hi","parts":\#(parts),"createdAt":"2026-10-27T20:00:00Z"}"#
    return try! Wire.decoder.decode(Message.self, from: Data(json.utf8))
  }

  // MARK: decoding

  func testDecodesTheNewParts() {
    let m = message("m1", parts: #"""
    [{"type":"followup","followupId":"fup_1","label":"Check the build","dueAt":"2026-10-27T20:35:00.000Z","waitingOn":"agent","status":"pending"},
     {"type":"checkback","replies":["Sent it","Write the email"]},
     {"type":"wrapup","did":"Deck sent to Sam","saved":"","next":"Look for Sam's reply"},
     {"type":"closed"},
     {"type":"some_future_part","x":1}]
    """#)
    XCTAssertEqual(m.parts.count, 5)
    XCTAssertEqual(m.parts[0], .followup(FollowupPill(followupId: "fup_1", label: "Check the build", dueAt: "2026-10-27T20:35:00.000Z")))
    XCTAssertEqual(m.parts[1], .checkback(replies: ["Sent it", "Write the email"]))
    guard case .wrapup(let wrap) = m.parts[2] else { return XCTFail("no wrap-up") }
    XCTAssertEqual(wrap.rows.map(\.key), ["Did", "Next"], "empty rows are skipped")
    XCTAssertEqual(m.parts[3], .closed)
    XCTAssertEqual(m.parts[4], .other("some_future_part"))
    XCTAssertTrue(Loops.isCheckback(m))
    XCTAssertTrue(Loops.isClosed(m))
  }

  func testBrokenPartsStaySafe() {
    let m = message("m1", parts: #"[{"type":"followup","label":"No id"},{"type":"checkback"},{"type":"wrapup"},{"type":"followup","followupId":"f","label":"Done one","dueAt":"x","status":"done"}]"#)
    XCTAssertEqual(m.parts[0], .other("followup"))
    XCTAssertEqual(m.parts[1], .checkback(replies: []))
    XCTAssertEqual(m.parts[2], .wrapup(WrapUp(did: "", saved: "", next: "")))
    guard case .followup(let pill) = m.parts[3] else { return XCTFail() }
    XCTAssertFalse(pill.pending)
    XCTAssertNil(pill.date)
  }

  func testDecodesChannelLoopAndNext() throws {
    let json = #"[{"id":"c1","name":"dm","kind":"dm","topic":"","createdAt":"2026-10-22T10:00:00Z","loop":{"status":"waiting","summary":"send Sam the deck"},"next":null},{"id":"c2","name":"dm","kind":"dm","topic":"","createdAt":"2026-10-22T10:00:00Z","loop":null,"next":{"label":"Check the build","dueAt":"2026-10-27T20:35:00Z","waitingOn":"agent"}},{"id":"c3","name":"general","kind":"channel","topic":"","createdAt":"2026-10-22T10:00:00Z"}]"#
    let list = try Wire.decoder.decode([Channel].self, from: Data(json.utf8))
    XCTAssertEqual(list[0].loop?.summary, "send Sam the deck")
    XCTAssertEqual(list[1].next?.label, "Check the build")
    XCTAssertNil(list[2].loop)
  }

  func testDecodesBackgroundFollowupsLoopsAndCheckback() throws {
    let json = #"{"background":null,"followups":[{"id":"fup_1","agentId":"a1","userId":"u1","dueAt":"2026-10-28T00:00:00.000Z","note":"Nudge","status":"pending","createdAt":"x","label":"Nudge you about the deck","waitingOn":"person","condition":"only if it hasn't gone out","kind":"followup","channelId":"c1","messageId":"m1"}],"loops":[{"channelId":"c9","agentId":"a1","userId":"u1","status":"waiting","summary":"pick a venue","nudges":1,"updatedAt":"x"}],"checkback":false}"#
    let bg = try Wire.decoder.decode(AgentBackground.self, from: Data(json.utf8))
    XCTAssertEqual(bg.followups?.first?.waitingOn, "person")
    XCTAssertEqual(bg.followups?.first?.condition, "only if it hasn't gone out")
    XCTAssertEqual(bg.loops?.first?.nudges, 1)
    XCTAssertEqual(bg.checkback, false)
    // an older hub without the new fields still decodes
    let old = try Wire.decoder.decode(AgentBackground.self, from: Data(#"{"followups":[{"id":"f","dueAt":"x","note":"n"}]}"#.utf8))
    XCTAssertNil(old.followups?.first?.label)
    XCTAssertNil(old.checkback)
  }

  // MARK: quick replies

  func testRepliesOnlyOnTheNewestMessage() {
    let back = message("m2", parts: #"[{"type":"checkback","replies":["Sent it"," ","Tomorrow"]}]"#)
    XCTAssertEqual(Loops.replies(back, newest: back), ["Sent it", "Tomorrow"])
    XCTAssertEqual(Loops.replies(back, newest: message("m3", author: "u1", kind: "user")), [], "something was written after it")
    XCTAssertEqual(Loops.replies(message("m4"), newest: message("m4")), [], "not a check-back")
    let inThread = message("m5", parts: #"[{"type":"checkback","replies":["Yes"]}]"#, thread: "m1")
    XCTAssertEqual(Loops.replies(inThread, newest: inThread), [])
  }

  // MARK: the reminder sheet

  func testOptionsHideTonightOnceItsPast() {
    let afternoon = date(2026, 10, 27, 17, 48)
    let options = Loops.options(now: afternoon.addingTimeInterval(31), calendar: calendar)
    XCTAssertEqual(options.map(\.title), ["In 1 hour", "Tonight", "Tomorrow morning"])
    XCTAssertEqual(options[0].date, date(2026, 10, 27, 18, 48), "to the minute")
    XCTAssertEqual(options[1].date, date(2026, 10, 27, 20))
    XCTAssertEqual(options[2].date, date(2026, 10, 28, 9))
    XCTAssertEqual(Loops.options(now: date(2026, 10, 27, 21), calendar: calendar).map(\.title), ["In 1 hour", "Tomorrow morning"])
    XCTAssertEqual(Loops.current(options, dueAt: date(2026, 10, 27, 20))?.title, "Tonight")
    XCTAssertNil(Loops.current(options, dueAt: date(2026, 10, 27, 19)))
  }

  func testSheetLineAndCondition() {
    let now = date(2026, 10, 27, 17)
    let line = Loops.sheetLine(date(2026, 10, 27, 20), condition: "it hasn't gone out.", now: now, calendar: calendar)
    XCTAssertTrue(line.hasPrefix("Tonight at "), line)
    XCTAssertTrue(line.hasSuffix(", only if it hasn't gone out"), line)
    XCTAssertTrue(Loops.sheetLine(date(2026, 10, 28, 9), condition: "Only if it rains", now: now, calendar: calendar).hasSuffix(", only if it rains"))
    XCTAssertTrue(Loops.sheetLine(date(2026, 10, 28, 9), condition: nil, now: now, calendar: calendar).hasPrefix("Tomorrow at "))
    XCTAssertNil(Loops.onlyIf("  "))
  }

  func testIsoKeepsTheOffset() {
    XCTAssertEqual(Loops.iso(date(2026, 10, 27, 20), timeZone: calendar.timeZone), "2026-10-27T20:00:00-04:00")
  }

  // MARK: the chat list

  func testListLines() throws {
    func channel(_ extra: String, kind: String = "dm") throws -> Channel {
      try Wire.decoder.decode(Channel.self, from: Data(#"{"id":"c1","name":"dm","kind":"\#(kind)","topic":"","createdAt":"2026-10-22T10:00:00Z"\#(extra)}"#.utf8))
    }
    let now = date(2026, 10, 27, 16)
    XCTAssertEqual(Loops.listLine(try channel(#","loop":{"status":"waiting","summary":"send Sam the deck"}"#), now: now, calendar: calendar), .waiting("Waiting on you · send Sam the deck"))
    let back = Loops.listLine(try channel(#","next":{"label":"Check the build","dueAt":"2026-10-27T20:35:00Z","waitingOn":"agent"}"#), now: now, calendar: calendar)
    guard case .back(let text) = back else { return XCTFail("\(String(describing: back))") }
    XCTAssertTrue(text.hasPrefix("Back at "), text)
    XCTAssertTrue(text.hasSuffix(" · check the build"), text)
    XCTAssertEqual(Loops.listLine(try channel(#","loop":{"status":"done","summary":""}"#), now: now, calendar: calendar), .done)
    XCTAssertNil(Loops.listLine(try channel(#","loop":{"status":"closed","summary":"x"}"#), now: now, calendar: calendar))
    XCTAssertNil(Loops.listLine(try channel(#","loop":{"status":"waiting","summary":"x"}"#, kind: "channel"), now: now, calendar: calendar))
  }

  // MARK: Background

  func testTrackRows() throws {
    let agent = try Wire.decoder.decode(Agent.self, from: Data(#"{"id":"a1","handle":"ghosty","name":"Ghosty","harness":"claude","status":"online"}"#.utf8))
    let followups = try Wire.decoder.decode([Followup].self, from: Data(#"""
    [{"id":"f2","dueAt":"2026-10-28T00:00:00Z","note":"n","label":"Nudge you about the deck","waitingOn":"person","kind":"followup","condition":"only if it hasn't gone out"},
     {"id":"f1","dueAt":"2026-10-27T20:35:00Z","note":"n","label":"Check the iPhone build","waitingOn":"agent","kind":"followup"},
     {"id":"f3","dueAt":"2026-10-27T20:35:00Z","note":"check back","kind":"checkback"}]
    """#.utf8))
    let loops = [ChatLoop(channelId: "c9", status: "waiting", summary: "pick a venue for the offsite", nudges: 1)]
    let rows = Loops.trackRows(followups: followups, loops: loops, agent: agent, now: date(2026, 10, 27, 16), calendar: calendar)
    XCTAssertEqual(rows.map(\.id), ["f1", "f2", "loop-c9"], "soonest first, check-backs left out, then chats")
    XCTAssertFalse(rows[0].onPerson)
    XCTAssertTrue(rows[0].subtitle.hasPrefix("Ghosty said it would · "))
    XCTAssertTrue(rows[1].onPerson)
    XCTAssertTrue(rows[1].subtitle.hasPrefix("You said you would · nudge "))
    XCTAssertEqual(rows[1].reminder?.condition, "only if it hasn't gone out")
    XCTAssertEqual(rows[2].title, "Pick a venue for the offsite")
    XCTAssertEqual(rows[2].subtitle, "No answer yet · one more try")
    XCTAssertNil(rows[2].reminder)
  }

  // MARK: store + push

  func testUpdatingAPillLocally() {
    let store = Store(loadSession: false, persistToken: { _ in })
    store.messages["c1"] = [message("m1", parts: #"[{"type":"followup","followupId":"fup_1","label":"Check","dueAt":"2026-10-27T20:35:00Z","waitingOn":"agent","status":"pending"}]"#)]
    store.updatePills("fup_1") { $0.status = "done" }
    guard case .followup(let pill) = store.messages["c1"]?.first?.parts.first else { return XCTFail() }
    XCTAssertEqual(pill.status, "done")
  }

  func testCheckbackPushChannel() {
    XCTAssertEqual(CheckbackPush.channel(["wisp": ["kind": "message", "channelId": "c1", "replies": ["Sent it"]]]), "c1")
    XCTAssertNil(CheckbackPush.channel(["aps": [:]]))
  }
}
