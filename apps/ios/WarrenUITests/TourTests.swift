import XCTest

@MainActor
final class TourTests: XCTestCase {
  private let app = XCUIApplication()

  func testTour() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let hub = environment["WARREN_HUB"], hub.hasPrefix("http"),
          let token = environment["WARREN_TOKEN"], !token.isEmpty, !token.hasPrefix("$(") else {
      throw XCTSkip("Set WARREN_HUB and WARREN_TOKEN to tour a signed-in workspace.")
    }
    continueAfterFailure = false
    app.launchEnvironment["WARREN_HUB"] = hub
    app.launchEnvironment["WARREN_TOKEN"] = token
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["You"].waitForExistence(timeout: 30), "The test session must reach Warren.")
    app.tabBars.buttons["You"].tap()

    open("you-tasks")
    shot("tasks")
    if let task = first("task-row") { task.tap(); shot("task-detail"); back() }
    else { shot("task-detail", note: "No tasks; detail is unavailable in this workspace.") }
    back()
    if first("you-new-task") != nil {
      open("you-new-task"); shot("new-task"); app.buttons["Cancel"].tap()
    } else { shot("new-task", note: "Guests cannot create tasks.") }

    open("you-memory"); shot("memory")
    // Folders are native navigation rows; descend until a note is available.
    var depth = 0
    while first("note-row") == nil && depth < 6 {
      guard let folder = first("memory-folder") else { break }
      folder.tap(); depth += 1
    }
    if let note = first("note-row") {
      note.tap(); shot("note")
      if let edit = first("edit-note") { edit.tap(); shot("note-edit"); app.buttons["Cancel"].tap() }
      else { shot("note-edit", note: "This account has read-only access to the note.") }
      back()
    } else {
      shot("note", note: "No accessible notes.")
      shot("note-edit", note: "No note is available to edit.")
    }
    for _ in 0...depth { back() }

    for (id, name) in [("you-about", "about"), ("you-skills", "skills"), ("you-connectors", "connectors"), ("you-teams", "teams"), ("you-devices", "devices")] {
      if reveal(id) { open(id); shot(name); back() }
      else { shot(name, note: "Teams are hidden in Simple mode.") }
    }
    open("you-settings"); shot("settings")
    for name in ["profile", "people", "workspace"] {
      open("settings-\(name)"); shot(name); back()
    }
    back()
    if !app.tabBars.buttons["Agents"].exists { app.tabBars.buttons["You"].tap() }
    XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Agents"].tap()
    if let agent = first("agent-tile") {
      agent.tap()
      for name in ["routines", "background"] { open("agent-\(name)"); shot(name); back() }
    } else {
      shot("routines", note: "Add an agent to use routines.")
      shot("background", note: "Add an agent to configure background checks.")
    }
  }

  private func first(_ id: String) -> XCUIElement? {
    let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
    return element.exists ? element : nil
  }
  @discardableResult private func reveal(_ id: String) -> Bool {
    if let element = first(id), element.isHittable { return true }
    for _ in 0..<6 {
      app.swipeUp()
      if let element = first(id), element.isHittable { return true }
    }
    for _ in 0..<6 {
      app.swipeDown()
      if let element = first(id), element.isHittable { return true }
    }
    return false
  }
  private func open(_ id: String) {
    XCTAssertTrue(reveal(id), "Missing navigation: \(id)")
    first(id)?.tap()
    let destination = id.replacingOccurrences(of: "you-", with: "").replacingOccurrences(of: "settings-", with: "").replacingOccurrences(of: "agent-", with: "")
    waitForScreen(destination)
  }
  private func waitForScreen(_ id: String) {
    let screen = app.descendants(matching: .any).matching(identifier: "screen-" + id).firstMatch
    XCTAssertTrue(screen.waitForExistence(timeout: 10), "Missing destination: \(id)")
    // lists never report hittable, so wait for the push transition to settle instead
    var last = screen.frame
    for _ in 0..<40 {
      Thread.sleep(forTimeInterval: 0.15)
      let frame = screen.frame
      if frame == last && frame.minX == 0 { return }
      last = frame
    }
    XCTFail("\(id) never settled on screen")
  }
  private func back() {
    let button = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(button.exists)
    button.tap()
  }
  private func shot(_ name: String, note: String? = nil) {
    if note == nil { waitForScreen(name) }
    let image = XCTAttachment(screenshot: app.screenshot())
    image.name = name; image.lifetime = .keepAlways; add(image)
    if let note {
      let explanation = XCTAttachment(string: note)
      explanation.name = "\(name)-availability"; explanation.lifetime = .keepAlways; add(explanation)
    }
  }
}
