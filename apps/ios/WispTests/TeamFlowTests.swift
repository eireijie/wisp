import XCTest
@testable import Wisp

/** Roles and steps follow the same rules, layout and templates as team-flow.ts in packages/core. */
final class TeamFlowTests: XCTestCase {
  private let agents = [
    Agent(id: "claude1", handle: "claude1", name: "Claude One", harness: "claude-code", status: .online),
    Agent(id: "claude2", handle: "claude2", name: "Claude Two", harness: "claude-code", status: .online),
    Agent(id: "codex1", handle: "codex1", name: "Codex One", harness: "codex", status: .online),
    Agent(id: "codex2", handle: "codex2", name: "Codex Two", harness: "codex", status: .online),
  ]
  private func step(_ id: String, _ role: String = "r", next: String? = nil, kind: ChannelTeam.Kind = .do, back: String? = nil) -> ChannelTeam.Step {
    .init(id: id, roleId: role, kind: kind, action: id, next: next, sendBackTo: back)
  }
  private let role = ChannelTeam.Role(id: "r", name: "Builder", description: "", agentId: "a")

  func testEveryTemplateWorksOnceFilled() {
    XCTAssertEqual(TeamTemplate.builtIn.map(\.id), ["plan-challenge", "build-review", "research-desk", "bug-squad", "support-queue"])
    for t in TeamTemplate.builtIn {
      let team = t.filled(with: agents)
      XCTAssertTrue(team.hasSteps, t.id)
      XCTAssertNil(team.stepsProblem, t.id)
      XCTAssertNil(team.problem, t.id)
      XCTAssertEqual(ChannelTeam.stepOrder(team.steps!).count, t.steps.count, "\(t.id): every step is on the way")
    }
  }

  func testFillingPicksByHarnessAndSpreadsAgents() {
    let team = TeamTemplate.builtIn[0].filled(with: agents)
    let by = Dictionary(uniqueKeysWithValues: team.roles!.map { ($0.id, $0.agentId) })
    XCTAssertEqual(by["lead"], "claude1")
    XCTAssertEqual(by["challenger"], "codex1")
    XCTAssertEqual(by["backend"], "codex2")
    // nobody runs kimi: the next agent nobody has yet
    XCTAssertEqual(by["frontend"], "claude2")
    // everyone's taken: back to the harness it suggests
    XCTAssertEqual(by["reviewer"], "claude1")
  }

  func testMissingAgentIsNamed() {
    let team = TeamTemplate.builtIn[0].filled(with: [])
    XCTAssertEqual(team.stepsProblem, "Pick an agent for Lead.")
    XCTAssertEqual(team.problem, "Pick an agent for Lead.")
    XCTAssertTrue(team.nodes.isEmpty)
  }

  func testProblemsInPlainWords() {
    let t = { (roles: [ChannelTeam.Role], steps: [ChannelTeam.Step]) in ChannelTeam(nodes: [], edges: [], roles: roles, steps: steps).stepsProblem }
    XCTAssertNil(t([], []))
    XCTAssertEqual(t([], [step("a")]), "Add at least one role.")
    XCTAssertEqual(t([role], []), "Add at least one step.")
    XCTAssertEqual(t([role], [step("a", next: "a")]), "A step can't lead to itself.")
    XCTAssertEqual(t([role], [step("a", next: "zz")]), "A step leads to a step that isn't there.")
    XCTAssertEqual(t([role], [step("a", "nope")]), "A step belongs to a role that isn't on the team.")
    XCTAssertEqual(t([role], [step("a", next: "b"), step("b", kind: .review)]), "Say where “b” sends work back to.")
    XCTAssertEqual(t([role], [step("a", kind: .handOut)]), "Pick who “a” hands pieces to.")
    XCTAssertEqual(t([role], [step("a"), step("b")]), "Every step needs to be reachable from the first one.")
    XCTAssertNil(t([role], [step("a", next: "b"), step("b", kind: .review, back: "a")]))
  }

  func testCirclesAreCaught() {
    let team = ChannelTeam(nodes: [], edges: [], roles: [role], steps: [step("a", next: "b"), step("b", next: "c"), step("c", next: "a")])
    XCTAssertEqual(team.stepsProblem, "The steps go round in a circle. Use a review's “send back” for loops.")
    XCTAssertEqual(ChannelTeam.stepOrder(team.steps!).map(\.id), ["a", "b", "c"], "each step once")
  }

  func testChartLeadIsTheFirstStepsAgent() {
    var team = TeamTemplate.builtIn[1].filled(with: agents) // build-review: the builder (codex) goes first
    XCTAssertEqual(team.nodes.filter(\.lead).map(\.agentId), ["codex1"])
    XCTAssertEqual(Set(team.edges.map(\.to)), Set(team.nodes.map(\.agentId)).subtracting(["codex1"]))
    XCTAssertTrue(team.edges.allSatisfy { $0.from == "codex1" })
    XCTAssertEqual(team.nodes.first { $0.agentId == "claude1" }?.role, "Reviewer")
    // the same agent in two roles is on the chart once, with both names
    team = team.setting(role: "tester", agent: "claude1")
    XCTAssertEqual(team.nodes.first { $0.agentId == "claude1" }?.role, "Reviewer, Tester")
    XCTAssertEqual(team.nodes.count, 2)
    XCTAssertNil(team.problem)
  }

  func testLayoutPutsReviewsBesideAndHandOutPiecesUnder() {
    let steps = ChannelTeam.layoutSteps(TeamTemplate.builtIn[0].steps)
    let at = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, [$0.x, $0.y]) })
    XCTAssertEqual(at["plan"], [0, 0])
    XCTAssertEqual(at["challenge"], [340, 0], "beside the step it sends back to")
    XCTAssertEqual(at["hand-out"], [0, 150])
    XCTAssertEqual(at["report"], [0, 600], "under the pieces and the checker")
    let team = TeamTemplate.builtIn[0].filled(with: agents)
    let boxes = team.chartBoxes
    XCTAssertEqual(boxes.count, 4 + 2 + 1)
    let pieces = boxes.filter { $0.id.hasPrefix("hand-out:piece:") }
    XCTAssertEqual(pieces.map(\.y), [300, 300])
    XCTAssertEqual(pieces.map(\.x), [-126, 126])
    XCTAssertEqual(boxes.first { $0.id == "hand-out:check" }?.y, 450)
  }

  func testLinesBetweenStepsSideBySideAreStraight() {
    let team = TeamTemplate.builtIn[0].filled(with: agents)
    let lines = team.chartLines(team.chartBoxes)
    let approved = try! XCTUnwrap(lines.first { $0.id == "challenge>hand-out" })
    XCTAssertEqual(approved.tone, .ok)
    XCTAssertEqual(approved.label, "approved")
    let back = try! XCTUnwrap(lines.first { $0.id == "challenge~back" })
    XCTAssertEqual(back.tone, .back)
    XCTAssertEqual(back.label, "changes, max 3")
    // forward in the upper part, back in the lower part, straight across
    let forward = try! XCTUnwrap(lines.first { $0.id == "plan>challenge" })
    XCTAssertEqual(forward.start.y, forward.end.y)
    XCTAssertEqual(back.start.y, back.end.y)
    XCTAssertLessThan(forward.start.y, back.start.y)
    XCTAssertEqual(lines.first { $0.id == "hand-out:check>report" }?.label, "all approved")
  }

  func testAddingAndRemovingSteps() throws {
    var team = TeamTemplate.builtIn[1].filled(with: agents)
    let id = try XCTUnwrap(team.addingStep(after: "test"))
    XCTAssertEqual(team.step("test")?.next, id)
    XCTAssertNil(team.step(id)?.next)
    XCTAssertEqual(team.stepsProblem, nil)
    team.removeStep("review")
    XCTAssertEqual(team.step("build")?.next, "test")
    XCTAssertEqual(ChannelTeam.stepOrder(team.steps!).map(\.id), ["build", "test", id])
  }

  func testEncodesWhatTheHubWantsAndOldTeamsStayPlain() throws {
    let team = TeamTemplate.builtIn[2].filled(with: [])
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(team)) as? [String: Any])
    let role = try XCTUnwrap((json["roles"] as? [[String: Any]])?.first)
    XCTAssertTrue(role["agentId"] is NSNull, "agentId is sent even when nobody fills it")
    let last = try XCTUnwrap((json["steps"] as? [[String: Any]])?.last)
    XCTAssertTrue(last["next"] is NSNull)
    XCTAssertEqual(last["x"] as? Double, 0)
    XCTAssertEqual(try JSONDecoder().decode(ChannelTeam.self, from: JSONEncoder().encode(team)), team)

    let old = try JSONDecoder().decode(ChannelTeam.self, from: Data(#"{"nodes":[{"agentId":"a","lead":true,"x":24,"y":24}],"edges":[]}"#.utf8))
    XCTAssertNil(old.roles)
    XCTAssertFalse(old.hasSteps)
    let back = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
    XCTAssertNil(back["roles"])
    XCTAssertNil(back["steps"])
  }

  func testDecodesAFlowAndSavedTemplates() throws {
    let flow = try JSONDecoder().decode(TeamFlow.self, from: Data(#"""
      {"id":"f1","workspaceId":"w","channelId":"c","threadId":"m","status":"waiting","request":"x","requestedBy":null,"stepId":"challenge","taskId":"t2",
       "rounds":{"plan":3,"challenge":3},"carry":null,"pieces":{},
       "history":[{"stepId":"plan","taskId":"t1","round":1,"verdict":"done","at":"now"},{"stepId":"challenge","taskId":"t2","round":1,"verdict":"changes","at":"now"}],
       "waitingFor":{"why":"Still not approved after 3 rounds.","options":"rounds"},"createdAt":"now","updatedAt":"now"}
      """#.utf8))
    XCTAssertEqual(flow.doneSteps, ["plan"])
    XCTAssertEqual(flow.waitingFor?.options, "rounds")
    let saved = try JSONDecoder().decode([TeamTemplate].self, from: Data(#"""
      [{"id":"own-x","name":"X","blurb":"","roles":[{"id":"a","name":"A","description":"d"}],"steps":[{"id":"s","roleId":"a","kind":"do","action":"Go","next":null}]}]
      """#.utf8))
    XCTAssertEqual(saved.first?.filled(with: agents).roles?.first?.agentId, "claude1")
  }

  func testStarterTeamIsTheLeadAlone() {
    let team = TeamTemplate.starter(lead: "claude1")
    XCTAssertNil(team.problem)
    XCTAssertEqual(team.nodes.map(\.agentId), ["claude1"])
    XCTAssertEqual(team.nodes.first?.lead, true)
  }
}
