import XCTest

/** Screenshots of the change card, Usage, Background and Mods, against WispUITests/Fixtures/hub.py. */
@MainActor
final class DeclutterTests: XCTestCase {
  private let app = XCUIApplication()

  func testDeclutterScreens() throws {
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
    settle()
    general.tap()
    let undo = app.buttons["undo-change"]
    XCTAssertTrue(undo.waitForExistence(timeout: 10))
    shot("change-card")
    undo.tap()
    XCTAssertTrue(app.staticTexts["Undone"].waitForExistence(timeout: 10))
    shot("change-undone")
    app.buttons["chat-back"].tap()
    settle()

    app.tabBars.buttons["Agents"].tap()
    app.descendants(matching: .any).matching(identifier: "agent-tile").firstMatch.tap()
    tap("agent-background")
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "background-sentence").firstMatch.waitForExistence(timeout: 10))
    settle()
    shot("background")
    let pace = app.links["every hour"]
    if pace.waitForExistence(timeout: 3) {
      pace.tap(); settle(); shot("background-pace")
      app.buttons["every hour"].firstMatch.tap(); settle()
    }
    tap("background-more")
    app.swipeUp(); settle()
    shot("background-more")

    app.swipeDown(); app.swipeDown(); settle()
    app.tabBars.buttons["Chats"].tap()
    app.buttons["profile-button"].firstMatch.tap()
    tap("you-settings")
    tap("settings-usage")
    XCTAssertTrue(app.buttons["allowance-Medium"].waitForExistence(timeout: 10))
    settle()
    shot("usage")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.navigationBars.buttons.element(boundBy: 0).tap()
    tap("you-mods")
    settle()
    shot("mods")
  }

  private func tap(_ id: String) {
    let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
    for _ in 0..<6 where !(element.exists && element.isHittable) { app.swipeUp() }
    XCTAssertTrue(element.waitForExistence(timeout: 10), "Missing \(id)")
    element.tap()
    settle()
  }
  private func settle() { Thread.sleep(forTimeInterval: 1.0) }
  private func shot(_ name: String) {
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = name; image.lifetime = .keepAlways; add(image)
  }
}
