import XCTest

/**
 * The team flowchart builder: make a team (name, start choice, templates, an agent builds it), draw
 * parallel steps, edit a step, read how it works. Runs against a hub that serves teams with steps
 * (set WISP_HUB and WISP_TOKEN); set WISP_SHOTS to a folder to also save screenshots there.
 */
@MainActor
final class TeamBuilderTests: XCTestCase {
  private let app = XCUIApplication()

  private func settle(_ s: TimeInterval = 1.0) { Thread.sleep(forTimeInterval: s) }

  private func shot(_ name: String) {
    let screenshot = app.screenshot()
    let image = XCTAttachment(screenshot: screenshot)
    image.name = name; image.lifetime = .keepAlways; add(image)
    if let folder = ProcessInfo.processInfo.environment["WISP_SHOTS"], !folder.isEmpty {
      try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("ios-\(name).png"))
    }
  }

  private func launch() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let hub = envVar("HUB", in: environment), hub.hasPrefix("http"),
          let token = envVar("TOKEN", in: environment), !token.isEmpty else {
      throw XCTSkip("Set WISP_HUB and WISP_TOKEN, pointing at a hub with teams that have steps.")
    }
    continueAfterFailure = false
    app.launchEnvironment["WISP_HUB"] = hub
    app.launchEnvironment["WISP_TOKEN"] = token
    app.launch()
    XCTAssertTrue(app.tabBars.firstMatch.buttons["Chats"].waitForExistence(timeout: 30))
  }

  private func openNewTeam() {
    app.buttons["new-menu"].tap()
    XCTAssertTrue(app.buttons["New team"].waitForExistence(timeout: 5))
    app.buttons["New team"].tap()
    XCTAssertTrue(app.textFields["create-name"].waitForExistence(timeout: 5))
  }

  private func nameIt(_ name: String) {
    let field = app.textFields["create-name"]
    field.tap()
    field.typeText(name)
    let topic = app.textFields["create-topic"].exists ? app.textFields["create-topic"] : app.textViews["create-topic"]
    topic.tap()
    topic.typeText("Ship releases on time, checked before they go out.")
    settle(0.5)
  }

  func testMakingATeamFromATemplateAndEditingASteps() throws {
    try launch()
    openNewTeam()
    nameIt("Launch crew")
    shot("create-name")
    app.keyboards.buttons["return"].firstMatch.tap()
    app.buttons["create-next"].tap()
    XCTAssertTrue(app.buttons["start-templates"].waitForExistence(timeout: 5))
    settle(); shot("start")

    // templates, one at a time
    app.buttons["start-templates"].tap()
    XCTAssertTrue(app.buttons["templates-use"].waitForExistence(timeout: 5))
    settle(1.5); shot("templates")
    app.swipeLeft(); settle(0.6)
    app.swipeLeft(); settle(0.6)
    shot("templates-research")
    for _ in 0..<3 { app.swipeLeft(); settle(0.5) }   // release crew is the sixth
    settle(); shot("templates-release")
    app.buttons["templates-use"].tap()

    // the flowchart with steps side by side
    XCTAssertTrue(app.buttons["builder-add"].waitForExistence(timeout: 5))
    settle(1.2); shot("builder")
    XCTAssertGreaterThanOrEqual(app.buttons.matching(identifier: "step-card").count, 4)

    // a step
    app.buttons.matching(identifier: "step-card").element(boundBy: 2).tap()
    XCTAssertTrue(app.buttons["step-done"].waitForExistence(timeout: 5))
    settle(1.0); shot("step-sheet")
    app.buttons["step-done"].tap()
    settle(0.6)

    // the ask-me step
    app.buttons.matching(identifier: "step-card").element(boundBy: 3).tap()
    XCTAssertTrue(app.buttons["step-done"].waitForExistence(timeout: 5))
    settle(1.0); shot("step-ask")
    app.buttons["step-done"].tap()
    settle(0.6)

    // add a step
    app.buttons["builder-add"].tap()
    XCTAssertTrue(app.buttons["add-review"].waitForExistence(timeout: 5))
    settle(0.8); shot("add-step")
    app.buttons["add-review"].tap()
    XCTAssertTrue(app.buttons["step-done"].waitForExistence(timeout: 5))
    settle(1.0); shot("step-repeat")
    app.buttons["step-done"].tap()
    settle(0.6)
    shot("builder-with-repeat")

    // how it works
    app.buttons["builder-tab-how"].tap()
    settle(0.8); shot("how-it-works")
    app.buttons["builder-tab-steps"].tap()

    // review, then create
    app.buttons["builder-done"].tap()
    XCTAssertTrue(app.buttons["review-create"].waitForExistence(timeout: 5))
    settle(); shot("review")
    app.buttons["review-create"].tap()
    settle(0.4); shot("saving")
    XCTAssertTrue(app.buttons["chat-back"].waitForExistence(timeout: 15), "creating the team opens its chat")
  }

  func testAnAgentBuildsItAndScratchStatesShow() throws {
    try launch()
    openNewTeam()
    nameIt("Plan crew")
    app.keyboards.buttons["return"].firstMatch.tap()
    app.buttons["create-next"].tap()
    XCTAssertTrue(app.buttons["start-scratch"].waitForExistence(timeout: 5))

    // from scratch: the empty state, then a step that has a problem
    app.buttons["start-scratch"].tap()
    XCTAssertTrue(app.buttons["builder-add-first"].waitForExistence(timeout: 5))
    settle(); shot("empty")
    app.buttons["builder-add-first"].tap()
    XCTAssertTrue(app.buttons["add-agent"].waitForExistence(timeout: 5))
    app.buttons["add-agent"].tap()
    XCTAssertTrue(app.buttons["step-done"].waitForExistence(timeout: 5))
    app.buttons["step-done"].tap()
    settle(0.6)
    app.buttons["builder-add"].tap()
    XCTAssertTrue(app.buttons["add-handoff"].waitForExistence(timeout: 5))
    app.buttons["add-handoff"].tap()
    XCTAssertTrue(app.buttons["step-done"].waitForExistence(timeout: 5))
    app.buttons["step-done"].tap()
    settle(1.0); shot("problem")
    app.buttons["builder-back"].tap()
    settle(0.6)

    // an agent builds it
    XCTAssertTrue(app.buttons["start-agent"].waitForExistence(timeout: 5))
    app.buttons["start-agent"].tap()
    let field = app.textFields["describe-field"].exists ? app.textFields["describe-field"] : app.textViews["describe-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("Nova plans, Ghosty pokes holes until it approves, then Nova hands out the work")
    settle(0.5); shot("describe")
    app.keyboards.buttons["return"].firstMatch.tap()
    app.buttons["describe-build"].tap()
    settle(0.8); shot("building")
    XCTAssertTrue(app.buttons["preview-create"].waitForExistence(timeout: 20))
    settle(); shot("preview")
    app.buttons["preview-edit"].tap()
    XCTAssertTrue(app.buttons["builder-add"].waitForExistence(timeout: 5))
    settle(); shot("builder-from-draft")
    app.buttons["builder-more"].tap()
    settle(0.6); shot("builder-menu")
  }

  func testEditingAnExistingTeam() throws {
    try launch()
    let row = app.buttons.containing(NSPredicate(format: "label CONTAINS 'release-crew'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.buttons["chat-title"].waitForExistence(timeout: 10))
    app.buttons["chat-more"].tap()
    XCTAssertTrue(app.buttons["How the team works"].waitForExistence(timeout: 5))
    app.buttons["How the team works"].tap()
    XCTAssertTrue(app.buttons["team-edit-how"].waitForExistence(timeout: 10))
    settle(); shot("team-info")
    app.buttons["team-edit-how"].tap()
    XCTAssertTrue(app.buttons["builder-add"].waitForExistence(timeout: 10))
    settle(1.2); shot("edit-builder")
    app.buttons["builder-more"].tap()
    XCTAssertTrue(app.buttons["Reorder steps"].firstMatch.waitForExistence(timeout: 5))
    app.buttons["Reorder steps"].firstMatch.tap()
    settle(1.0); shot("reorder")
  }
}
