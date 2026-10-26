import Foundation

/** The rules and edits a channel's team chart follows; the same as teamProblem and TeamChart on the web. */
extension ChannelTeam {
  /** The rules, in the words the web's chart shows them. */
  static let rules = [
    "Leads read every new message in the team. Everyone else hears only when a lead hands them work or someone @mentions them.",
    "With two or more leads, they talk the request over in its thread and agree on a plan before anyone starts.",
    "Draw an arrow from an agent to whoever it hands work to. Every agent that isn't a lead needs one pointing at it.",
    "Each hand-off opens its own sub-thread, and every agent on the chart knows who else is on the team.",
  ]

  // the web chart's card size and spacing, so a team made here lays out the same there
  private static let cardWidth = 184.0, cardHeight = 64.0, gap = 28.0, row = 132.0, pad = 24.0

  /** What's wrong with the team, in plain words, or nil when it's fine (teamProblem in packages/core): its steps first. */
  var problem: String? {
    if let steps = stepsProblem { return steps }
    if nodes.isEmpty { return "Add at least one agent to the team." }
    if !nodes.contains(where: \.lead) { return "Make at least one agent a lead." }
    let ids = Set(nodes.map(\.agentId))
    if ids.count != nodes.count { return "An agent is on the chart twice." }
    for e in edges {
      if !ids.contains(e.from) || !ids.contains(e.to) { return "An arrow points at an agent that isn't on the chart." }
      if e.from == e.to { return "An agent can't hand work to itself." }
    }
    let leads = Set(nodes.filter(\.lead).map(\.agentId))
    if edges.contains(where: { leads.contains($0.to) }) { return "Leads hear every message already; arrows can't point at a lead." }
    if nodes.contains(where: { n in !n.lead && !edges.contains { $0.to == n.agentId } }) { return "Connect every agent that isn't a lead to whoever hands it work." }
    if hasLoop { return "The arrows go round in a loop." }
    if let boss = reportsTo, ids.contains(boss) { return "The team can't report to an agent on it." }
    return nil
  }

  private var hasLoop: Bool {
    var seen = Set<String>()
    func walk(_ id: String, _ path: inout Set<String>) -> Bool {
      if path.contains(id) { return true }
      if seen.contains(id) { return false }
      seen.insert(id)
      path.insert(id)
      defer { path.remove(id) }
      return edges.filter { $0.from == id }.contains { walk($0.to, &path) }
    }
    return nodes.contains { n in
      var path = Set<String>()
      return walk(n.agentId, &path)
    }
  }

  var leads: [String] { nodes.filter(\.lead).map(\.agentId) }
  func contains(_ agentId: String) -> Bool { nodes.contains { $0.agentId == agentId } }
  func node(_ agentId: String) -> Node? { nodes.first { $0.agentId == agentId } }
  /** who hands this agent work */
  func from(_ agentId: String) -> [String] { edges.filter { $0.to == agentId }.map(\.from) }

  /** A free spot on a row of the web's chart. */
  private func freeSpot(row: Int) -> (x: Double, y: Double) {
    let y = Self.pad + Double(row) * Self.row
    let taken = nodes.filter { abs($0.y - y) < Self.cardHeight }.map(\.x)
    var x = Self.pad
    while taken.contains(where: { abs($0 - x) < Self.cardWidth }) { x += Self.cardWidth + Self.gap }
    return (x, y)
  }

  /** Add an agent: the first one leads; the others get work from the first lead until someone changes it. */
  func adding(_ agentId: String) -> ChannelTeam {
    guard !contains(agentId) else { return self }
    let lead = nodes.first(where: \.lead)
    let spot = freeSpot(row: lead == nil ? 0 : 1)
    var team = self
    team.nodes.append(Node(agentId: agentId, lead: lead == nil, x: spot.x, y: spot.y))
    if let lead { team.edges.append(Edge(from: lead.agentId, to: agentId)) }
    return team
  }

  /**
   * Take an agent off. Whoever it handed work to now gets work from whoever handed it work, and an
   * agent left with nobody handing it work leads (what the hub does when an agent goes).
   */
  func removing(_ agentId: String) -> ChannelTeam {
    let above = from(agentId), below = edges.filter { $0.from == agentId }.map(\.to)
    var team = self
    team.nodes.removeAll { $0.agentId == agentId }
    team.edges = edges.filter { $0.from != agentId && $0.to != agentId }
    for a in above { for b in below where !team.edges.contains(Edge(from: a, to: b)) { team.edges.append(Edge(from: a, to: b)) } }
    let fed = Set(team.edges.map(\.to))
    team.nodes = team.nodes.map { n in
      var n = n
      if !fed.contains(n.agentId) { n.lead = true }
      return n
    }
    return team
  }

  /**
   * Make an agent a lead or not. Arrows can't point at a lead, so a new lead loses its incoming ones;
   * an agent that stops leading gets work from the first other lead.
   */
  func setting(_ agentId: String, lead: Bool) -> ChannelTeam {
    guard let i = nodes.firstIndex(where: { $0.agentId == agentId }), nodes[i].lead != lead else { return self }
    var team = self
    team.nodes[i].lead = lead
    if lead {
      team.edges.removeAll { $0.to == agentId }
      // to the top row of the web's chart
      let spot = team.freeSpot(row: 0)
      team.nodes[i].x = spot.x; team.nodes[i].y = spot.y
    } else if let other = team.nodes.first(where: { $0.lead && $0.agentId != agentId }) {
      if !team.edges.contains(where: { $0.to == agentId }) { team.edges.append(Edge(from: other.agentId, to: agentId)) }
      if team.nodes[i].y < Self.pad + Self.row / 2 {
        let spot = team.freeSpot(row: 1)
        team.nodes[i].x = spot.x; team.nodes[i].y = spot.y
      }
    }
    return team
  }

  /** Turn "gets work from `from`" on or off for an agent. */
  func setting(_ agentId: String, from: String, on: Bool) -> ChannelTeam {
    var team = self
    let edge = Edge(from: from, to: agentId)
    if on { if !team.edges.contains(edge) { team.edges.append(edge) } } else { team.edges.removeAll { $0 == edge } }
    return team
  }

  /** Take agents that no longer exist off the chart (the hub does the same when an agent goes). */
  func live(_ agentIds: Set<String>) -> ChannelTeam {
    var team = self
    team.nodes = nodes.filter { agentIds.contains($0.agentId) }
    team.edges = edges.filter { agentIds.contains($0.from) && agentIds.contains($0.to) }
    // a role whose agent is gone has nobody again
    team.roles = roles?.map { r in
      var r = r
      if let a = r.agentId, !agentIds.contains(a) { r.agentId = nil }
      return r
    }
    // and a step whose agent is gone
    team.steps = steps?.map { s in
      var s = s
      if let a = s.agentId, !agentIds.contains(a) { s.agentId = nil }
      return s
    }
    return team
  }

  /**
   * The chart as rows for a phone: leads on top, then each agent one row below the lowest agent
   * handing it work. Within a row, left to right as on the web's chart.
   */
  var rows: [[String]] {
    var depth: [String: Int] = [:]
    for n in nodes where n.lead { depth[n.agentId] = 0 }
    // longest path from a lead; a chart with a loop (not saveable) still lays out, capped at the agent count
    for _ in 0..<nodes.count {
      for e in edges { if let d = depth[e.from], d + 1 > depth[e.to] ?? -1, !(node(e.to)?.lead ?? true) { depth[e.to] = min(d + 1, nodes.count) } }
    }
    let unplaced = nodes.filter { depth[$0.agentId] == nil }
    let deepest = depth.values.max() ?? -1
    for n in unplaced { depth[n.agentId] = deepest + 1 }
    let byRow = Dictionary(grouping: nodes, by: { depth[$0.agentId]! })
    return byRow.keys.sorted().map { byRow[$0]!.sorted { $0.x < $1.x }.map(\.agentId) }
  }
}

extension Channel {
  /** the team, without agents that are gone */
  func team(agents: [Agent]) -> ChannelTeam? {
    guard let team = settings?.team else { return nil }
    let live = team.live(Set(agents.map(\.id)))
    return live.nodes.isEmpty ? nil : live
  }

  /** "Atlas and Nova lead here", or nil without a team (or once it's archived). */
  func leadLine(agents: [Agent]) -> String? {
    guard archivedAt == nil, let team = team(agents: agents) else { return nil }
    let names = team.leads.compactMap { id in agents.first { $0.id == id }?.name }
    guard !names.isEmpty else { return nil }
    return "\(ChannelTeam.list(names)) \(names.count > 1 ? "lead" : "leads") here"
  }
}

extension ChannelTeam {
  /** "Atlas", "Atlas and Nova", "Atlas, Nova and Cy" */
  static func list(_ names: [String]) -> String {
    names.count <= 2 ? names.joined(separator: " and ") : names.dropLast().joined(separator: ", ") + " and " + names.last!
  }

  static func settingsPatch(_ team: ChannelTeam?) -> Fields {
    ["team": team.map { AnyEncodable($0) } ?? .null]
  }
}
