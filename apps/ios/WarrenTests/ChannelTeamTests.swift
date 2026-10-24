import XCTest
@testable import Warren

/** A channel's team chart follows the same rules as teamProblem in packages/core. */
final class ChannelTeamTests: XCTestCase {
  private func node(_ id: String, lead: Bool = false) -> ChannelTeam.Node { .init(agentId: id, lead: lead, x: 0, y: 0) }
  private func edge(_ from: String, _ to: String) -> ChannelTeam.Edge { .init(from: from, to: to) }

  func testTeamSettingsPatchLeavesReplyInThreadUnchanged() throws {
    for team: ChannelTeam? in [ChannelTeam.empty.adding("a"), nil] {
      let data = try JSONEncoder().encode(ChannelTeam.settingsPatch(team))
      let settings = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(Set(settings.keys), ["team"])
      XCTAssertNil(settings["replyInThread"])
      if team == nil { XCTAssertTrue(settings["team"] is NSNull) }
      else { XCTAssertNotNil(settings["team"] as? [String: Any]) }
    }
  }

  func testProblemsInPlainWords() {
    let t = { (nodes: [ChannelTeam.Node], edges: [ChannelTeam.Edge]) in ChannelTeam(nodes: nodes, edges: edges).problem }
    XCTAssertEqual(t([], []), "Add at least one agent to the team.")
    XCTAssertEqual(t([node("a")], []), "Make at least one agent a lead.")
    XCTAssertEqual(t([node("a", lead: true), node("b")], []), "Connect every agent that isn't a lead to whoever hands it work.")
    XCTAssertNil(t([node("a", lead: true), node("b")], [edge("a", "b")]))
    XCTAssertEqual(t([node("a", lead: true), node("b", lead: true)], [edge("a", "b")]), "Leads hear every message already; arrows can't point at a lead.")
    XCTAssertEqual(t([node("a", lead: true), node("b"), node("c")], [edge("a", "b"), edge("b", "c"), edge("c", "b")]), "The arrows go round in a loop.")
    XCTAssertEqual(t([node("a", lead: true)], [edge("a", "a")]), "An agent can't hand work to itself.")
    XCTAssertEqual(t([node("a", lead: true), node("a")], []), "An agent is on the chart twice.")
    XCTAssertEqual(t([node("a", lead: true)], [edge("a", "z")]), "An arrow points at an agent that isn't on the chart.")
  }

  func testAddingLeadingAndRemoving() {
    // the first agent leads; the next gets work from it, a row down the web's chart
    var team = ChannelTeam.empty.adding("a").adding("b").adding("c")
    XCTAssertEqual(team.leads, ["a"])
    XCTAssertEqual(team.from("b"), ["a"])
    XCTAssertNil(team.problem)
    XCTAssertEqual(team.rows, [["a"], ["b", "c"]])
    XCTAssertGreaterThan(team.node("b")!.y, team.node("a")!.y)
    XCTAssertNotEqual(team.node("b")!.x, team.node("c")!.x, "cards don't land on each other")
    // a new lead loses the arrows pointing at it
    team = team.setting("b", lead: true)
    XCTAssertEqual(team.from("b"), [])
    XCTAssertNil(team.problem)
    // c gets work from b, then b stops leading and gets work from a
    team = team.setting("c", from: "b", on: true).setting("c", from: "a", on: false).setting("b", lead: false)
    XCTAssertEqual(team.from("b"), ["a"])
    XCTAssertEqual(team.rows, [["a"], ["b"], ["c"]])
    // taking b off hands c to whoever handed b work
    team = team.removing("b")
    XCTAssertEqual(team.from("c"), ["a"])
    XCTAssertNil(team.problem)
    // with its only lead gone, whoever it handed work to leads
    XCTAssertEqual(team.removing("a").leads, ["c"])
  }

  func testDecodesTheHubsJSONAndDropsAgentsThatAreGone() throws {
    let json = #"{"defaultAgentId":null,"replyInThread":true,"instructions":"","team":{"nodes":[{"agentId":"a","lead":true,"x":24,"y":24},{"agentId":"b","lead":false,"x":24,"y":156}],"edges":[{"from":"a","to":"b"}]}}"#
    let settings = try JSONDecoder().decode(Channel.Settings.self, from: Data(json.utf8))
    XCTAssertEqual(settings.team?.nodes.count, 2)
    XCTAssertEqual(settings.team?.live(["a"]), ChannelTeam(nodes: [ChannelTeam.Node(agentId: "a", lead: true, x: 24, y: 24)], edges: []))
    let none = try JSONDecoder().decode(Channel.Settings.self, from: Data(#"{"team":null}"#.utf8))
    XCTAssertNil(none.team)
  }
}
