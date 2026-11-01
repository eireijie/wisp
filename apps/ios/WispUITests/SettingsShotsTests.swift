import XCTest

/** Walks every settings page of a signed-in workspace and saves a screenshot of each (set WISP_HUB, WISP_TOKEN, WISP_SHOTS). */
@MainActor
final class SettingsShotsTests: XCTestCase {
  private let app = XCUIApplication()

  func testSettingsPages() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let hub = envVar("HUB", in: environment), hub.hasPrefix("http"),
          let token = envVar("TOKEN", in: environment), !token.isEmpty else {
      throw XCTSkip("Set WISP_HUB and WISP_TOKEN to walk the settings pages.")
    }
    continueAfterFailure = true
    app.launchEnvironment["WISP_HUB"] = hub
    app.launchEnvironment["WISP_TOKEN"] = token
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Chats"].waitForExistence(timeout: 30))
    app.buttons["profile-button"].firstMatch.tap()
    Thread.sleep(forTimeInterval: 1.5)
    shot("00-sheet")
    // pages the sheet opens
    for (id, screen) in [("you-profile", "profile"), ("settings-appearance", "appearance"), ("settings-agent-defaults", "agent-defaults")] {
      visit(id, screen)
    }
    guard reveal("you-settings") else { return XCTFail("no all-settings row") }
    first("you-settings")?.tap()
    Thread.sleep(forTimeInterval: 1)
    shot("01-all-settings")
    let pages: [(String, String)] = [
      ("settings-notifications", "notifications"), ("settings-behavior", "behavior"), ("settings-voice", "voice"), ("settings-security", "security"),
      ("settings-workspace", "workspace"), ("settings-people", "people"), ("settings-usage", "usage"),
      ("settings-agents", "agent-policy"), ("settings-connections", "connections"), ("settings-mobile", "mobile"),
      ("settings-data", "data"), ("settings-about", "about"),
    ]
    for (id, screen) in pages { visit(id, screen) }
  }

  private func visit(_ id: String, _ screen: String) {
    guard reveal(id), let row = first(id) else { return XCTFail("missing row \(id)") }
    row.tap()
    let marker = app.descendants(matching: .any).matching(identifier: "screen-" + screen).firstMatch
    XCTAssertTrue(marker.waitForExistence(timeout: 10), "screen-\(screen)")
    Thread.sleep(forTimeInterval: 1.5)
    shot(screen)
    let back = app.buttons["settings-back"].firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.element(boundBy: 0).tap() }
    Thread.sleep(forTimeInterval: 0.6)
  }

  private func first(_ id: String) -> XCUIElement? {
    let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
    return element.exists ? element : nil
  }

  private func reveal(_ id: String) -> Bool {
    if let element = first(id), element.isHittable { return true }
    for _ in 0..<8 { app.swipeUp(); if let element = first(id), element.isHittable { return true } }
    for _ in 0..<10 { app.swipeDown(); if let element = first(id), element.isHittable { return true } }
    return false
  }

  private func shot(_ name: String) {
    let screenshot = app.screenshot()
    let image = XCTAttachment(screenshot: screenshot)
    image.name = name; image.lifetime = .keepAlways; add(image)
    if let folder = ProcessInfo.processInfo.environment["WISP_SHOTS"], !folder.isEmpty {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }
  }
}
