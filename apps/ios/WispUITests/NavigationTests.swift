import XCTest

/**
 * The foundation: four tabs, the avatar's settings sheet, the + menu, search and a chat's top bar,
 * against WispUITests/Fixtures/hub.py. Set WISP_SHOTS to a folder to also save screenshots there.
 */
@MainActor
final class NavigationTests: XCTestCase {
  private let app = XCUIApplication()

  func testFourTabsSettingsAndChat() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let hub = envVar("HUB", in: environment), hub.hasPrefix("http"),
          let token = envVar("TOKEN", in: environment), !token.isEmpty, !token.hasPrefix("$(") else {
      throw XCTSkip("Set WISP_HUB and WISP_TOKEN, pointing at WispUITests/Fixtures/hub.py.")
    }
    continueAfterFailure = false
    app.launchEnvironment["WISP_HUB"] = hub
    app.launchEnvironment["WISP_TOKEN"] = token
    app.launch()

    let bar = app.tabBars.firstMatch
    XCTAssertTrue(bar.buttons["Chats"].waitForExistence(timeout: 30))
    for name in ["Inbox", "Chats", "Agents", "Computers"] { XCTAssertTrue(bar.buttons[name].exists, name) }
    XCTAssertFalse(bar.buttons["You"].exists, "The You tab is gone")
    settle(); shot("home")

    // + menu
    app.buttons["new-menu"].tap()
    XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["New team"].exists)
    XCTAssertTrue(app.buttons["New section"].exists)
    settle(); shot("new-menu")
    app.buttons["New chat"].tap()
    settle(); shot("new-chat")
    app.buttons["Close"].firstMatch.tap()

    // Agents and Inbox
    bar.buttons["Agents"].tap(); settle(); shot("agents")
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "agent-tile").firstMatch.exists)
    bar.buttons["Inbox"].tap(); settle(); shot("inbox")
    bar.buttons["Computers"].tap(); settle()
    bar.buttons["Chats"].tap(); settle()

    // settings sheet from the avatar
    app.buttons["profile-button"].firstMatch.tap()
    XCTAssertTrue(app.buttons["you-settings"].waitForExistence(timeout: 5))
    settle(); shot("settings")
    app.buttons["you-organizations"].tap()
    XCTAssertTrue(app.buttons["org-new"].waitForExistence(timeout: 5))
    settle(); shot("organizations")
    app.buttons["Close"].firstMatch.tap(); settle()
    app.buttons["Close"].firstMatch.tap(); settle()

    // a chat
    let chat = app.buttons.containing(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
    XCTAssertTrue(chat.waitForExistence(timeout: 10))
    chat.tap()
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["chat-more"].exists)
    XCTAssertTrue(app.textFields["composer-field"].exists || app.textViews["composer-field"].exists)
    settle(); shot("chat")
    app.buttons["chat-back"].tap()
    XCTAssertTrue(bar.buttons["Chats"].waitForExistence(timeout: 5))
  }

  private func settle() { Thread.sleep(forTimeInterval: 1.2) }

  private func shot(_ name: String) {
    let screenshot = app.screenshot()
    let image = XCTAttachment(screenshot: screenshot)
    image.name = name; image.lifetime = .keepAlways; add(image)
    if let folder = ProcessInfo.processInfo.environment["WISP_SHOTS"], !folder.isEmpty {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }
  }
}
