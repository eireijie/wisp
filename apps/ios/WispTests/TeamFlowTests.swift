import XCTest
@testable import Wisp

/** The flowchart follows the same model, rules, plain lines and templates as team-flow.ts in packages/core. */
final class TeamFlowTests: XCTestCase {
  private let agents = [
    Agent(id: "nova", handle: "nova", name: "Nova", harness: "claude-code", status: .online),
    Agent(id: "ghosty", handle: "ghosty", name: "Ghosty", harness: "gemini", status: .online),
    Agent(id: "pappy", handle: "pappy", name: "Pappy", harness: "codex", status: .online),
    Agent(id: "kimi", handle: "kimi", name: "Kimi", harness: "kimi", status: .online),
  ]
  private func nameOf(_ id: String?) -> String { agents.first { $0.id == id }?.name ?? "Someone" }
  private func step(_ id: String, kind: ChannelTeam.Kind = .do, agent: String? = "nova", inputs: [String] = [], nexts: [String] = [], back: String? = nil) -> ChannelTeam.Step {
    .init(id: id, kind: kind, action: id, sendBackTo: back, nexts: nexts, inputs: inputs, agentId: agent)
  }
  private func team(_ steps: [ChannelTeam.Step], roles: [ChannelTeam.Role] = []) -> ChannelTeam {
    ChannelTeam(nodes: [], edges: [], roles: roles, steps: ChannelTeam.normalizeSteps(steps))
  }
  private func problem(_ steps: [ChannelTeam.Step], roles: [ChannelTeam.Role] = []) -> String? { ChannelTeam(nodes: [], edges: [], roles: roles, steps: steps).stepsProblem }
  private func release() -> ChannelTeam { TeamTemplate.builtIn.first { $0.id == "release-crew" }!.team(agents: agents) }

  /** every edge is spelled out at both ends and `next` is the first of `nexts` */
  private func assertConsistent(_ team: ChannelTeam, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    let steps = team.steps ?? []
    for s in steps {
      XCTAssertEqual(s.next, s.nexts?.first, "\(message) next of \(s.id)", file: file, line: line)
      for n in s.nexts ?? [] where steps.contains(where: { $0.id == n }) {
        XCTAssertTrue(team.step(n)?.inputs?.contains(s.id) == true, "\(message) \(n) lists \(s.id) as an input", file: file, line: line)
      }
      for i in s.inputs ?? [] where steps.contains(where: { $0.id == i }) {
        XCTAssertTrue(team.step(i)?.nexts?.contains(s.id) == true, "\(message) \(i) lists \(s.id) in nexts", file: file, line: line)
      }
    }
  }

  // MARK: templates

  func testEverySixTemplateWorksOnceFilled() {
    XCTAssertEqual(TeamTemplate.builtIn.map(\.id), ["plan-challenge", "build-review", "research-desk", "bug-squad", "support-queue", "release-crew"])
    for t in TeamTemplate.builtIn {
      XCTAssertFalse((t.sample ?? []).isEmpty, "\(t.id) has a sample conversation")
      let filled = t.team(agents: agents)
      XCTAssertTrue(filled.hasSteps, t.id)
      XCTAssertNil(filled.stepsProblem, t.id)
      XCTAssertNil(filled.problem, t.id)
      XCTAssertEqual(ChannelTeam.stepOrder(filled.steps!).count, t.steps.count, t.id)
      assertConsistent(filled, t.id)
    }
  }

  func testFillingPicksByHarnessAndSpreadsAgents() {
    let team = release()
    let by = Dictionary(uniqueKeysWithValues: team.steps!.map { ($0.id, $0.agentId) })
    XCTAssertEqual(by["plan"], "nova")
    XCTAssertEqual(by["research"], "ghosty")
    XCTAssertEqual(by["build"], "pappy")
    XCTAssertNil(by["approve"] ?? nil, "an ask-me step has no agent")
    // one agent only: it does everything
    let solo = TeamTemplate.builtIn[0].team(agents: [agents[0]])
    XCTAssertNil(solo.stepsProblem)
  }

  func testMissingAgentsAreNamed() {
    let team = TeamTemplate.builtIn[0].team(agents: [])
    XCTAssertEqual(team.stepsProblem, "Pick an agent for “Draft a thorough plan”.")
    XCTAssertEqual(team.problem, "Pick an agent for “Draft a thorough plan”.")
    XCTAssertTrue(team.nodes.isEmpty)
    XCTAssertEqual(team.stepsProblems.count, 4, "each step that needs an agent is listed")
  }

  func testPlanChallengeKeepsItsRolesForTheSplit() {
    let team = TeamTemplate.builtIn[0].team(agents: agents)
    XCTAssertEqual(Set(team.roles!.map(\.id)), ["backend", "frontend", "reviewer"])
    XCTAssertEqual(team.steps!.first { $0.kind == .handOut }?.handTo, ["backend", "frontend"])
    XCTAssertTrue(team.roles!.allSatisfy { $0.agentId != nil })
  }

  // MARK: problems

  func testProblemsInPlainWords() {
    XCTAssertNil(problem([]))
    XCTAssertEqual(problem([], roles: [.init(id: "r", name: "R", description: "", agentId: "a")]), "Add at least one step.")
    XCTAssertEqual(problem([step("a", agent: nil)]), "Pick an agent for “a”.")
    XCTAssertEqual(problem([step("a", nexts: ["a"])]), "A step can't lead to itself.")
    XCTAssertEqual(problem([step("a", nexts: ["zz"])]), "A step leads to a step that isn't there.")
    XCTAssertEqual(problem([step("a"), step("b", kind: .review)]), "Say where “b” sends work back to.")
    XCTAssertEqual(problem([step("a", kind: .handOut)]), "Pick who “a” hands pieces to.")
    XCTAssertEqual(problem([step("a", kind: .handoff, agent: nil)]), "Pick the team “a” hands the work to.")
    XCTAssertEqual(problem([step("a", kind: .branch)]), "Say what “a” checks for.")
    XCTAssertEqual(problem([step("a", kind: .ask, agent: nil)]), "Add at least one step that an agent does.")
    XCTAssertNil(problem([step("a", nexts: ["b"]), step("b", kind: .review, inputs: ["a"], back: "a")]))
  }

  func testCirclesAndLoops() {
    let circle = "The steps go round in a circle. To loop, use a repeat step with a limit, or an ask-me step."
    XCTAssertEqual(problem([step("a", inputs: ["b"], nexts: ["b"]), step("b", inputs: ["a"], nexts: ["a"])]), circle)
    // a repeat step may send work back to an earlier step, but not forward
    XCTAssertEqual(problem([step("a", nexts: ["b"]), step("b", kind: .review, inputs: ["a"], nexts: ["c"], back: "c"), step("c", inputs: ["b"])]),
      "“b” can only send work back to a step before it.")
    // an ask-me step can loop back; an if/else too
    XCTAssertNil(problem([step("a", nexts: ["b"]), step("b", kind: .ask, agent: nil, inputs: ["a"], back: "a")]))
    var branch = step("b", kind: .branch, inputs: ["a"])
    branch.condition = "it passed"; branch.ifTrue = "c"; branch.ifFalse = "a"
    XCTAssertNil(problem([step("a", nexts: ["b"]), branch, step("c")]))
    var lost = step("b", kind: .branch, inputs: ["a"])
    lost.condition = "x"; lost.ifTrue = "c"
    XCTAssertNil(problem([step("a", nexts: ["b"]), lost, step("c")]))
    XCTAssertEqual(problem([step("a"), step("b", kind: .ask, agent: nil, inputs: ["x"])]), "A step leads to a step that isn't there.")
  }

  func testEveryStepMustBeReachable() {
    // a step only a loop leads to is not reachable from the start
    var branch = step("b", kind: .branch, inputs: ["a"])
    branch.rule = .init(op: .contains, value: "ok"); branch.ifTrue = "a"; branch.ifFalse = "a"
    XCTAssertNil(problem([step("a", nexts: ["b"]), branch]))
    XCTAssertEqual(problem([step("a", nexts: ["c"]), step("c", inputs: ["a"]), step("d", inputs: ["e"]), step("e", inputs: ["d"])]),
      "The steps go round in a circle. To loop, use a repeat step with a limit, or an ask-me step.")
  }

  // MARK: plain lines

  func testReleaseCrewReadsLikeTheDesign() {
    let lines = release().describeFlow(nameOf: nameOf)
    XCTAssertEqual(lines.map(\.text), [
      "Nova plans the work.",
      "At the same time, Ghosty researches the options.",
      "Pappy uses the results of steps 1 and 2 to build it.",
      "You approve before it ships. If you ask for changes it goes back to step 3.",
    ])
    XCTAssertEqual(lines.map(\.together), [false, true, false, false])
    XCTAssertEqual(lines.map(\.n), [1, 2, 3, 4])
  }

  func testLinesForRepeatHandOffAndIfElse() {
    var t = team([
      step("plan", nexts: ["check"]), step("check", agent: "ghosty", inputs: ["plan"], back: "plan"),
      step("go", kind: .branch, inputs: ["check"]),
      step("tell", kind: .handoff, agent: nil, inputs: ["go"]),
    ])
    t = t.updating("check") { $0.kind = .review; $0.action = "Check the plan"; $0.maxRounds = 3 }
    t = t.updating("go") { $0.condition = "every test passed"; $0.ifTrue = "tell"; $0.ifFalse = "plan" }
    t = t.updating("tell") { $0.handoffTo = "support"; $0.waitForReply = true }
    let lines = t.describeFlow(nameOf: nameOf, teamName: { _ in "Support" }).map(\.text)
    XCTAssertEqual(lines[1], "Ghosty checks the plan using the result of step 1. If it isn't good enough it goes back to step 1, up to 3 rounds, then it asks you.")
    XCTAssertTrue(lines[2].hasPrefix("Nova looks at the result of step 2: if every test passed, it goes to step 4; if not, to step 1."), lines[2])
    XCTAssertEqual(lines[3], "The Support team gets the work, and the next step waits for their answer.")
  }

  func testTitlesThatAreNotVerbsStillRead() {
    let t = team([step("x")]).updating("x") { $0.action = "Weekly numbers" }
    XCTAssertEqual(t.describeFlow(nameOf: nameOf).first?.text, "Nova works on “Weekly numbers”.")
    XCTAssertEqual(FlowWords.titleAsVerb("Fix the root cause!")?.third, "fixes the root cause")
    XCTAssertEqual(FlowWords.titleAsVerb("Research")?.third, "researches")
    XCTAssertNil(FlowWords.titleAsVerb("Quarterly"))
  }

  // MARK: the graph

  func testParallelStepsShareARowAndAJoinWaits() {
    let t = release()
    XCTAssertEqual(ChannelTeam.stepRows(t.steps!).map { $0.map(\.id) }, [["plan", "research"], ["build"], ["approve"]])
    XCTAssertEqual(ChannelTeam.startSteps(t.steps!).map(\.id), ["plan", "research"])
    XCTAssertEqual(t.step("build")?.inputs, ["plan", "research"])
    let laid = ChannelTeam.layoutSteps(t.steps!)
    XCTAssertEqual(laid[0].y, laid[1].y)
    XCTAssertLessThan(laid[0].x, laid[1].x)
    XCTAssertGreaterThan(laid[2].y, laid[0].y)
  }

  func testEditsKeepEveryEdgeConsistent() {
    var t = release()
    // a step in the middle
    t = t.inserting(.init(id: "extra", kind: .do, action: "Check the build", agentId: "kimi"), after: "build")
    assertConsistent(t, "insert after")
    XCTAssertEqual(t.step("build")?.nexts, ["extra"])
    XCTAssertEqual(t.step("extra")?.nexts, ["approve"])
    XCTAssertEqual(t.step("approve")?.inputs, ["extra"])
    // beside: same inputs, same followers
    t = t.inserting(.init(id: "twin", kind: .do, action: "Research more", agentId: "ghosty"), beside: "research")
    assertConsistent(t, "beside")
    XCTAssertEqual(t.step("build")?.inputs?.sorted(), ["plan", "research", "twin"])
    // take one off: what led to it leads to what followed
    t = t.removingStep("extra")
    assertConsistent(t, "remove")
    XCTAssertEqual(t.step("build")?.nexts, ["approve"])
    XCTAssertNil(t.step("approve")?.inputs?.contains("extra") == true ? "x" : nil)
    // inputs
    t = t.setting(inputs: ["plan"], of: "build")
    assertConsistent(t, "inputs")
    XCTAssertEqual(t.step("build")?.inputs, ["plan"])
    XCTAssertEqual(t.step("research")?.nexts, [])
    XCTAssertNil(t.step("research")?.next)
    XCTAssertNil(t.stepsProblem)
  }

  func testRemovingAStepClearsArrowsThatPointedAtIt() {
    var t = team([step("a", nexts: ["b"]), step("b", kind: .review, inputs: ["a"], back: "a")])
    t = t.removingStep("a")
    XCTAssertNil(t.step("b")?.sendBackTo)
    assertConsistent(t)
  }

  func testAddingAGateBeforeABranchTargetKeepsTheBranchRoute() {
    var q = step("q", kind: .branch, inputs: ["s"]); q.ifTrue = "a"; q.ifFalse = "b"
    var t = team([step("s", nexts: ["q"]), q, step("a", inputs: ["q"]), step("b", inputs: ["q"])])
    t = t.inserting(.init(id: "gate", kind: .ask, action: "Say go"), before: "a")
    XCTAssertEqual(t.step("q")?.ifTrue, "gate")
    XCTAssertEqual(t.step("q")?.ifFalse, "b")
    XCTAssertEqual(t.step("gate")?.nexts, ["a"])
    assertConsistent(t)
  }

  func testMovingAStepKeepsTheArrowsThatPointedAtIt() {
    var t = team([step("plan", nexts: ["build"]), step("build", inputs: ["plan"], nexts: ["rev"]), step("rev", kind: .review, inputs: ["build"], back: "build")])
    t = t.moving("build", after: nil)
    XCTAssertEqual(t.orderedSteps.map(\.id), ["build", "plan", "rev"])
    XCTAssertEqual(t.step("rev")?.sendBackTo, "build")
    assertConsistent(t)
  }

  func testMovingAStepKeepsTheBranchArmsThatPointedAtIt() {
    var q = step("q", kind: .branch, inputs: ["s"]); q.ifTrue = "a"; q.ifFalse = "b"
    var t = team([step("s", nexts: ["q"]), q, step("a", inputs: ["q"]), step("b", inputs: ["q"])])
    t = t.moving("a", after: "b")
    XCTAssertEqual(t.step("q")?.ifTrue, "a")
    XCTAssertEqual(t.step("q")?.ifFalse, "b")
  }

  func testMovingAStepFollowsTheOneAbove() {
    var t = team([step("a", nexts: ["b"]), step("b", inputs: ["a"], nexts: ["c"]), step("c", inputs: ["b"])])
    t = t.moving("c", after: "a")
    assertConsistent(t)
    XCTAssertEqual(t.orderedSteps.map(\.id), ["a", "c", "b"])
    t = t.moving("b", after: nil)
    assertConsistent(t)
    XCTAssertEqual(t.orderedSteps.map(\.id), ["b", "a", "c"])
    XCTAssertNil(t.stepsProblem)
  }

  func testInsertingBetweenRowsAndAtTheEnds() {
    var t = release()
    t = t.insertingBetween(.init(id: "gate", kind: .do, action: "Join", agentId: "nova"), from: ["plan", "research"], to: ["build"])
    assertConsistent(t)
    XCTAssertEqual(t.step("gate")?.inputs?.sorted(), ["plan", "research"])
    XCTAssertEqual(t.step("build")?.inputs, ["gate"])
    t = t.insertingBetween(.init(id: "last", kind: .do, action: "Wrap up", agentId: "nova"), from: ["approve"], to: [])
    assertConsistent(t)
    XCTAssertEqual(t.step("last")?.inputs, ["approve"])
    t = t.insertingBetween(.init(id: "first", kind: .do, action: "Read it", agentId: "nova"), from: [], to: ["gate"])
    XCTAssertEqual(t.step("gate")?.inputs?.sorted(), ["first", "plan", "research"])
    XCTAssertNil(t.stepsProblem)
  }

  func testIfElseTargetsLeaveNoStaleArrows() {
    var t = team([step("a", nexts: ["b"]), step("b", kind: .branch, inputs: ["a"]), step("c"), step("d")])
    t = t.updating("b") { $0.condition = "ok"; $0.ifTrue = "c"; $0.ifFalse = "d" }
    XCTAssertEqual(t.step("c")?.inputs, ["b"])
    t = t.disconnecting("b", "c").updating("b") { $0.ifTrue = "d" }
    XCTAssertEqual(t.step("c")?.inputs, [])
    assertConsistent(t)
  }

  // MARK: older teams and the wire

  func testALinearTeamBecomesAGraphWithItsPrompts() throws {
    let old = try JSONDecoder().decode(ChannelTeam.self, from: Data(#"""
      {"nodes":[],"edges":[],"roles":[{"id":"r1","name":"Builder","description":"You build it.","agentId":"nova"},{"id":"r2","name":"Checker","description":"You check it.","agentId":"pappy"}],
       "steps":[{"id":"build","roleId":"r1","kind":"do","action":"Build it","next":"check"},
                {"id":"check","roleId":"r2","kind":"review","action":"Check it","next":null,"sendBackTo":"build","maxRounds":2}]}
      """#.utf8))
    XCTAssertFalse(old.isGraph)
    XCTAssertNil(old.stepsProblem)
    let graph = old.migrated
    XCTAssertTrue(graph.isGraph)
    XCTAssertEqual(graph.step("build")?.nexts, ["check"])
    XCTAssertEqual(graph.step("check")?.inputs, ["build"])
    XCTAssertEqual(graph.step("build")?.prompt, "You build it.")
    XCTAssertEqual(graph.agentId(of: graph.step("check")!), "pappy", "an older step falls back to its role's agent")
    XCTAssertEqual(graph.describeFlow(nameOf: nameOf).map(\.text), ["Nova builds it.", "Pappy checks it using the result of step 1. If it isn't good enough it goes back to step 1, up to 2 rounds, then it asks you."])
    XCTAssertEqual(graph.migrated, graph, "running it again changes nothing")
  }

  func testEncodesWhatTheHubWantsAndOldTeamsStayPlain() throws {
    let team = release().withChart
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(team)) as? [String: Any])
    let steps = try XCTUnwrap(json["steps"] as? [[String: Any]])
    let last = try XCTUnwrap(steps.last)
    XCTAssertTrue(last["next"] is NSNull, "next is sent even when the flow ends")
    XCTAssertEqual(last["kind"] as? String, "ask")
    XCTAssertEqual(last["inputs"] as? [String], ["build"])
    XCTAssertEqual(last["sendBackTo"] as? String, "build")
    XCTAssertEqual(try JSONDecoder().decode(ChannelTeam.self, from: JSONEncoder().encode(team)), team)
    XCTAssertEqual(team.nodes.count, 3)
    XCTAssertEqual(team.nodes.filter(\.lead).map(\.agentId), ["nova"])

    let old = try JSONDecoder().decode(ChannelTeam.self, from: Data(#"{"nodes":[{"agentId":"a","lead":true,"x":24,"y":24}],"edges":[]}"#.utf8))
    XCTAssertNil(old.roles)
    XCTAssertFalse(old.hasSteps)
    let back = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
    XCTAssertNil(back["roles"])
    XCTAssertNil(back["steps"])
  }

  func testNewStepKindsAndRulesDecodeAndUnknownKindsDoNotBreak() throws {
    let steps = try JSONDecoder().decode([ChannelTeam.Step].self, from: Data(#"""
      [{"id":"i","roleId":"","kind":"branch","action":"Passed?","next":"y","nexts":["y"],"inputs":[],"rule":{"op":"not_contains","value":"FAIL"},"ifTrue":"y","ifFalse":null,"x":0,"y":0},
       {"id":"h","roleId":"","kind":"handoff","action":"Tell support","next":null,"handoffTo":"c9","waitForReply":true,"x":0,"y":0},
       {"id":"q","kind":"something-new","action":"?","next":null}]
      """#.utf8))
    XCTAssertEqual(steps[0].rule?.op, .notContains)
    XCTAssertEqual(steps[0].rule?.op.label, "doesn't contain")
    XCTAssertFalse(steps[0].needsAgent, "a rule needs no agent")
    XCTAssertEqual(steps[1].waitForReply, true)
    XCTAssertEqual(steps[2].kind, .do)
    XCTAssertEqual(steps[2].roleId, "")
  }

  func testDecodesAFlowWithLanesAndAnOlderOne() throws {
    let flow = try JSONDecoder().decode(TeamFlow.self, from: Data(#"""
      {"id":"f1","workspaceId":"w","channelId":"c","threadId":"m","status":"waiting","request":"x","requestedBy":null,"stepId":"approve","taskId":null,
       "rounds":{"plan":1},"carry":null,"pieces":{},
       "history":[{"stepId":"plan","taskId":"t1","round":1,"verdict":"done","at":"now"}],
       "waitingFor":{"why":"Your OK is needed.","options":"ask"},
       "lanes":{"plan":{"stepId":"plan","status":"done","taskId":"t1","carry":null,"pieces":{},"waitingFor":null},
                "research":{"stepId":"research","status":"waiting","taskId":"t2","carry":null,"pieces":{},"waitingFor":{"why":"It failed.","options":"retry"}},
                "approve":{"stepId":"approve","status":"waiting","taskId":null,"carry":null,"pieces":{},"waitingFor":{"why":"Your OK is needed.","options":"ask"},"approvalId":"ap1"}},
       "createdAt":"now","updatedAt":"now"}
      """#.utf8))
    XCTAssertEqual(flow.doneSteps, ["plan"])
    XCTAssertEqual(flow.waitingLanes.map(\.stepId).sorted(), ["approve", "research"])
    XCTAssertEqual(flow.allLanes["approve"]?.approvalId, "ap1")
    let old = try JSONDecoder().decode(TeamFlow.self, from: Data(#"""
      {"id":"f2","channelId":"c","threadId":"m","status":"waiting","stepId":"challenge","rounds":{"plan":3},
       "history":[{"stepId":"plan","verdict":"done"}],"waitingFor":{"why":"Still not approved after 3 rounds.","options":"rounds"}}
      """#.utf8))
    XCTAssertEqual(old.waitingLanes.map(\.stepId), ["challenge"])
    XCTAssertEqual(old.allLanes["plan"]?.status, "done")
  }

  func testDecodesSavedTemplatesAndDraftsAndApprovals() throws {
    let saved = try JSONDecoder().decode([TeamTemplate].self, from: Data(#"""
      [{"id":"own-x","name":"X","blurb":"","roles":[{"id":"a","name":"A","description":"d","harness":"codex"}],"steps":[{"id":"s","roleId":"a","kind":"do","action":"Go","next":null}]}]
      """#.utf8))
    let team = saved[0].team(agents: agents)
    XCTAssertEqual(team.steps?.first?.agentId, "pappy")
    XCTAssertEqual(team.steps?.first?.prompt, "d")
    XCTAssertNil(team.stepsProblem)
    let draft = try JSONDecoder().decode(TeamDraft.self, from: Data(#"""
      {"id":"d1","status":"ready","description":"x","agentId":"nova","name":"Crew",
       "steps":[{"id":"a","roleId":"","kind":"do","action":"Plan","next":null,"nexts":[],"inputs":[],"agentId":"nova","x":0,"y":0}],
       "lines":[{"stepId":"a","n":1,"together":false,"who":"Nova","rest":"plans","text":"Nova plans."}]}
      """#.utf8))
    XCTAssertEqual(draft.status, "ready")
    XCTAssertEqual(draft.lines?.first?.text, "Nova plans.")
    let working = try JSONDecoder().decode(TeamDraft.self, from: Data(#"{"id":"d2","status":"working","description":"x","agentId":"nova"}"#.utf8))
    XCTAssertNil(working.steps)
    let approval = try JSONDecoder().decode(Approval.self, from: Data(#"""
      {"id":"ap1","agentId":"a","channelId":"c","threadId":null,"summary":"s","details":"d","status":"pending","decidedBy":null,"note":"","createdAt":"now","decidedAt":null,"flow":{"flowId":"f1","stepId":"approve"}}
      """#.utf8))
    XCTAssertEqual(approval.flow, Approval.Flow(flowId: "f1", stepId: "approve"))
  }

  func testSavingATeamAsATemplateLeavesWhoDidItOut() {
    let t = TeamTemplate.from(release(), name: "My crew")
    XCTAssertTrue(t.steps.allSatisfy { $0.agentId == nil && $0.x == 0 })
    XCTAssertEqual(t.steps.map(\.id), ["plan", "research", "build", "approve"])
  }
}
