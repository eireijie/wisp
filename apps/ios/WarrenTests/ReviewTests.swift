import XCTest
@testable import Warren

@MainActor
final class ReviewTests: XCTestCase {
  func testMarkdownBlocks() {
    let text = "# Title\n\n## Sub\n### Small\n\nFirst **bold** paragraph.\nStill here.\n\nAnother paragraph.\n- item\n  continued\n  - nested\n- [ ] todo\n- [x] done\n1. first\n2. second\n> quote\n> more\n\n```swift\nlet x = 1\n\n# literal\n```"
    XCTAssertEqual(MarkdownBlock.split(text), [
      .heading(1, "Title"), .heading(2, "Sub"), .heading(3, "Small"),
      .paragraph("First **bold** paragraph.\nStill here."), .paragraph("Another paragraph."),
      .item(marker: "•", text: "item\ncontinued", indent: 0), .item(marker: "•", text: "nested", indent: 2),
      .item(marker: "☐", text: "todo", indent: 0), .item(marker: "☑", text: "done", indent: 0),
      .item(marker: "1.", text: "first", indent: 0), .item(marker: "2.", text: "second", indent: 0),
      .quote("quote\nmore"), .code("let x = 1\n\n# literal")
    ])
  }

  func testMarkdownFencesAndParagraphBoundaries() {
    XCTAssertEqual(MarkdownBlock.split(""), [])
    XCTAssertEqual(MarkdownBlock.split("before\r\n\r\nafter"), [.paragraph("before"), .paragraph("after")])
    XCTAssertEqual(MarkdownBlock.split("~~~\n- literal\n~~~\nlast"), [.code("- literal"), .paragraph("last")])
    XCTAssertEqual(MarkdownBlock.split("````\n```\n````"), [.code("```")])
    XCTAssertEqual(MarkdownBlock.split("```\nunclosed"), [.code("unclosed")])
    XCTAssertEqual(MarkdownBlock.split("#hashtag\n123 text"), [.paragraph("#hashtag\n123 text")])
  }

  func testMarkdownInlineFormattingAndWikiLabels() {
    let text = NoteMarkdown.inlineText("**bold** *italic* `code` [web](https://example.com) [[Note]] [[path|Alias]]")
    XCTAssertEqual(String(text.characters), "bold italic code web Note Alias")
    XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
    XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    XCTAssertTrue(text.runs.contains { $0.link == URL(string: "https://example.com") })
    XCTAssertTrue(text.runs.contains { $0.foregroundColor != nil && $0.link == nil })
    let mixed = NoteMarkdown.inlineText("**See [[Note]] now** and `[[literal]]`")
    XCTAssertEqual(String(mixed.characters), "See Note now and [[literal]]")
    XCTAssertTrue(mixed.runs.contains { String(mixed[$0.range].characters) == "Note" && $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
  }

  func testDescribeCronMatchesCoreCasesAndFallbacks() {
    let cases = [
      ("0 9 * * 1-5", "Every weekday at 9am"),
      ("30 17 * * *", "Every day at 5:30pm"),
      ("0 8 * * 1", "Every Monday at 8am"),
      ("0 * * * *", "Every hour"),
      ("*/15 * * * *", "Every 15 minutes"),
      ("0 10 1 * *", "On the 1st of every month at 10am"),
      ("5 * * * *", "Every hour at :05"),
      ("0 0 * * 7", "Every Sunday at 12am"),
      ("0 12 * * sun,sat", "Every weekend day at 12pm"),
      ("0 8 * * wed,mon", "Every Monday, Wednesday at 8am"),
      ("0 9 11 * *", "On the 11th of every month at 9am"),
      ("0 9 22 * *", "On the 22nd of every month at 9am"),
      ("0 9 23 * *", "On the 23rd of every month at 9am"),
      ("0 9 * jan *", "0 9 * jan *"),
      ("0 9 1 * 1", "0 9 1 * 1"),
      ("0 9-17/2 * * *", "0 9-17/2 * * *"),
      ("61 * * * *", "61 * * * *"),
      ("not cron", "not cron")
    ]
    for (cron, expected) in cases { XCTAssertEqual(describeCron(cron), expected, cron) }
  }

  func testNextRunMatchesCoreAndTimeZones() throws {
    let from = try XCTUnwrap(Wire.date("2026-10-11T12:00:00Z"))
    XCTAssertEqual(CronSchedule("30 9 * * 1")?.nextRun(timezone: "UTC", from: from), Wire.date("2026-10-12T09:30:00Z"))
    XCTAssertEqual(CronSchedule("0 9 * * 1-5")?.nextRun(timezone: "America/New_York", from: from), Wire.date("2026-10-12T13:00:00Z"))
    XCTAssertEqual(CronSchedule("*/15 * * * *")?.nextRun(timezone: "UTC", from: from), Wire.date("2026-10-11T12:15:00Z"))
    XCTAssertEqual(CronSchedule("0 9 * * 1")?.nextRun(timezone: "invalid", from: from), Wire.date("2026-10-12T09:00:00Z"))
    // Restricted day-of-month and weekday use cron's OR rule.
    XCTAssertEqual(CronSchedule("0 9 20 * 1")?.nextRun(timezone: "UTC", from: from), Wire.date("2026-10-12T09:00:00Z"))
    let beforeDST = try XCTUnwrap(Wire.date("2026-03-07T15:00:00Z"))
    XCTAssertEqual(CronSchedule("0 9 * * *")?.nextRun(timezone: "America/New_York", from: beforeDST), Wire.date("2026-03-08T13:00:00Z"))
    XCTAssertNil(CronSchedule("0 9 * *")); XCTAssertNil(CronSchedule("61 * * * *"))
    XCTAssertNil(CronSchedule("*/0 * * * *")); XCTAssertNil(CronSchedule("0 25 * * *"))
  }

  func testTaskNotificationRoutingAndCancellation() throws {
    var task = try Wire.decoder.decode(WorkTask.self, from: Data(#"{"id":"t","title":"Task","brief":"Brief","status":"failed","result":"Cancelled by Sam."}"#.utf8))
    XCTAssertTrue(task.cancelled); XCTAssertTrue(task.closed)
    XCTAssertNil(task.notificationInfo["channelId"])
    XCTAssertNil(Route(["warren": task.notificationInfo]))
    XCTAssertNil(Route(["warren": ["kind": "task", "channelId": ""]]))
    task.channelId = "c"; task.threadId = "m"
    XCTAssertEqual(Route(["warren": task.notificationInfo]), .chat(channelId: "c", threadId: "m"))
    task.status = "cancelled"; task.result = nil
    XCTAssertTrue(task.cancelled); XCTAssertTrue(task.closed)
    task.status = "failed"; task.result = "Connection failed"
    XCTAssertFalse(task.cancelled)
  }

  func testConnectorSignInRequiresUnsignedRequiredAuth() {
    var connector = AppConnector(id: "c", name: "Key connector", kind: "mcp-http")
    XCTAssertFalse(connector.needsSignIn)
    connector.auth = .init(required: false, signedIn: false)
    XCTAssertFalse(connector.needsSignIn)
    connector.auth = .init(required: true, signedIn: true)
    XCTAssertFalse(connector.needsSignIn)
    connector.auth = .init(required: true, signedIn: false)
    XCTAssertTrue(connector.needsSignIn)
    connector.auth = .init(required: true, signedIn: nil)
    XCTAssertTrue(connector.needsSignIn)
  }

  func testWireDates() {
    XCTAssertNotNil(Wire.date("2026-10-25T07:26:08.836Z"))
    XCTAssertNotNil(Wire.date("2026-10-25T07:26:08Z"))
    XCTAssertNotNil(Wire.date("2026-10-25"))
    XCTAssertNil(Wire.date("not a date"))
  }
}
