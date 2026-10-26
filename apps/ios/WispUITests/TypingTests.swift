import XCTest

/** Types into the message bar (plain text, "/", "@", emoji, edits) against WispUITests/Fixtures/hub.py; the app must not crash. */
@MainActor
final class TypingTests: XCTestCase {
  private let app = XCUIApplication()

  func testTypingInTheMessageBar() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let hub = envVar("HUB", in: environment), hub.hasPrefix("http"),
          let token = envVar("TOKEN", in: environment), !token.isEmpty, !token.hasPrefix("$(") else {
      throw XCTSkip("Set WISP_HUB and WISP_TOKEN, pointing at WispUITests/Fixtures/hub.py.")
    }
    continueAfterFailure = false
    app.launchEnvironment["WISP_HUB"] = hub
    app.launchEnvironment["WISP_TOKEN"] = token
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Chats"].waitForExistence(timeout: 30))
    app.tabBars.buttons["Chats"].tap()
    let general = app.buttons.containing(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
    XCTAssertTrue(general.waitForExistence(timeout: 10))
    general.tap()

    let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("hello")
    field.typeText(" @no")
    field.typeText("va hi 🙂 ")
    field.typeText("\n")
    field.typeText("/")
    field.typeText("me")
    for _ in 0..<6 { field.typeText(XCUIKeyboardKey.delete.rawValue) }
    field.typeText("again 👨‍👩‍👧 ok")
    XCTAssertTrue(app.state == .runningForeground)
    XCTAssertTrue(field.exists)
  }
}
