import Foundation

/**
 * Teams that run on roles and steps: the same rules, layout and templates as team-flow.ts in
 * packages/core, so a team made here works (and looks) the same on the web.
 */
extension ChannelTeam {
  typealias Kind = Step.Kind

  static let defaultRounds = 3
  static let maxRounds = 10
  // the web chart's step box size and row height
  static let stepWidth = 220.0, stepHeight = 64.0, stepRow = 150.0

  /** A team that runs on roles and steps rather than a plain chart. */
  var hasSteps: Bool { !(roles ?? []).isEmpty && !(steps ?? []).isEmpty }

  /** The first step: one no other step leads to, else the first one listed. */
  static func firstStep(_ steps: [Step]) -> Step? {
    let pointed = Set(steps.compactMap(\.next))
    return steps.first { !pointed.contains($0.id) } ?? steps.first
  }

  /** The steps from the first one along `next`, in order (each once). */
  static func stepOrder(_ steps: [Step]) -> [Step] {
    var out: [Step] = []
    var s = firstStep(steps)
    while let step = s, !out.contains(where: { $0.id == step.id }) {
      out.append(step)
      s = step.next.flatMap { id in steps.first { $0.id == id } }
    }
    return out
  }

  /** The steps in flow order, then any the flow doesn't reach. */
  var orderedSteps: [Step] {
    let all = steps ?? []
    let order = Self.stepOrder(all)
    return order + all.filter { s in !order.contains { $0.id == s.id } }
  }

  /** What's wrong with the roles and steps, in plain words, or nil when they work (stepsProblem). */
  var stepsProblem: String? {
    let roles = roles ?? [], steps = steps ?? []
    if roles.isEmpty && steps.isEmpty { return nil }
    if roles.isEmpty { return "Add at least one role." }
    if steps.isEmpty { return "Add at least one step." }
    let roleIds = Set(roles.map(\.id))
    if roleIds.count != roles.count { return "Two roles share an id." }
    if roles.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) { return "Every role needs a name." }
    let stepIds = Set(steps.map(\.id))
    if stepIds.count != steps.count { return "Two steps share an id." }
    for s in steps {
      guard let role = roles.first(where: { $0.id == s.roleId }) else { return "A step belongs to a role that isn't on the team." }
      if role.agentId == nil { return "Pick an agent for \(role.name)." }
      if let next = s.next, !stepIds.contains(next) { return "A step leads to a step that isn't there." }
      if s.next == s.id { return "A step can't lead to itself." }
      let what = s.action.isEmpty ? role.name : s.action
      if s.kind == .review {
        guard let back = s.sendBackTo, stepIds.contains(back) else { return "Say where “\(what)” sends work back to." }
        if back == s.id { return "A review can't send work back to itself." }
      }
      if s.kind == .handOut {
        let to = s.handTo ?? []
        if to.isEmpty { return "Pick who “\(what)” hands pieces to." }
        if to.contains(where: { !roleIds.contains($0) }) || s.reviewBy.map({ !roleIds.contains($0) }) == true { return "A hand-out names a role that isn't on the team." }
        for r in to + (s.reviewBy.map { [$0] } ?? []) {
          if let role = roles.first(where: { $0.id == r }), role.agentId == nil { return "Pick an agent for \(role.name)." }
        }
      }
    }
    // following `next` from the first step reaches every step, with no circle (loops go through "send back")
    let order = Self.stepOrder(steps)
    if order.last?.next != nil { return "The steps go round in a circle. Use a review's “send back” for loops." }
    if order.count != steps.count { return "Every step needs to be reachable from the first one." }
    return nil
  }

  /**
   * The plain chart a stepped team also keeps, so the rest of Wisp sees who's on it: the first
   * step's agent leads, everyone else gets work from it (chartFromSteps).
   */
  func chartFromSteps(old: [Node] = []) -> (nodes: [Node], edges: [Edge]) {
    let roles = roles ?? []
    let first = Self.firstStep(steps ?? [])
    let leadId = roles.first(where: { $0.id == first?.roleId })?.agentId ?? roles.first(where: { $0.agentId != nil })?.agentId
    var agentIds: [String] = []
    for r in roles { if let a = r.agentId, !agentIds.contains(a) { agentIds.append(a) } }
    let nodes = agentIds.enumerated().map { i, agentId in
      let was = old.first { $0.agentId == agentId }
      let names = roles.filter { $0.agentId == agentId }.map { $0.name.trimmingCharacters(in: .whitespaces) }
      return Node(agentId: agentId, lead: agentId == leadId, x: was?.x ?? 24 + Double(i) * 212, y: was?.y ?? (agentId == leadId ? 24 : 156),
        role: String(names.joined(separator: ", ").prefix(60)))
    }
    let edges = leadId.map { lead in agentIds.filter { $0 != lead }.map { Edge(from: lead, to: $0) } } ?? []
    return (nodes, edges)
  }

  /** The team with its plain chart kept in step with its roles (withChart on the web). */
  var withChart: ChannelTeam {
    var team = self
    let chart = chartFromSteps(old: nodes)
    team.nodes = chart.nodes
    team.edges = chart.edges
    return team
  }

  /** Steps laid out top to bottom in flow order; a review sits beside the step it sends back to. */
  static func layoutSteps(_ steps: [Step]) -> [Step] {
    let order = stepOrder(steps)
    let rest = steps.filter { s in !order.contains { $0.id == s.id } }
    var row = 0.0
    var placed: [String: (x: Double, y: Double)] = [:]
    for s in order + rest {
      if s.kind == .review, let backId = s.sendBackTo, let back = placed[backId], back.y == (row - 1) * stepRow {
        placed[s.id] = (back.x + stepWidth + 120, back.y)
      } else {
        placed[s.id] = (0, row * stepRow)
        // a hand-out's pieces (and whoever checks them) are drawn under it
        row += 1 + (s.kind == .handOut ? ((s.handTo ?? []).isEmpty ? 0 : 1) + (s.reviewBy == nil ? 0 : 1) : 0)
      }
    }
    return steps.map { s in
      var s = s
      if let p = placed[s.id] { s.x = p.x; s.y = p.y }
      return s
    }
  }

  /** How a step reads in a sentence: "Challenger: Find gaps, challenge the plan". */
  static func stepLabel(_ step: Step, roles: [Role]) -> String {
    let role = roles.first { $0.id == step.roleId }
    let action = step.action.isEmpty ? (step.kind == .review ? "Review" : step.kind == .handOut ? "Hand out the work" : "Do the work") : step.action
    return "\(role?.name ?? "?"): \(action)"
  }

  func role(_ id: String?) -> Role? { roles?.first { $0.id == id } }
  func step(_ id: String?) -> Step? { steps?.first { $0.id == id } }
}

// MARK: templates

/** A ready-made team: its roles (unfilled) and how they work together (TeamTemplate). */
struct TeamTemplate: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var blurb: String
  var roles: [ChannelTeam.Role]
  var steps: [ChannelTeam.Step]

  init(id: String, name: String, blurb: String, roles: [ChannelTeam.Role], steps: [ChannelTeam.Step]) {
    self.id = id; self.name = name; self.blurb = blurb; self.roles = roles; self.steps = steps
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    blurb = (try? c.decode(String.self, forKey: .blurb)) ?? ""
    roles = try c.decode([ChannelTeam.Role].self, forKey: .roles)
    steps = try c.decode([ChannelTeam.Step].self, forKey: .steps)
  }

  /** The roles and steps, ready to fill in, with the steps laid out on the chart (teamFromTemplate). */
  var team: (roles: [ChannelTeam.Role], steps: [ChannelTeam.Step]) {
    (roles.map { r in var r = r; r.agentId = nil; return r }, ChannelTeam.layoutSteps(steps))
  }

  /**
   * Filled in with your agents: each role gets an agent on the harness it suggests, a different
   * one each where it can (fillTemplate on the web). `base` keeps a team's folder, repo and boss.
   */
  func filled(with agents: [Agent], base: ChannelTeam? = nil) -> ChannelTeam {
    let (roles, steps) = team
    var used = Set<String>()
    let filled = roles.map { r in
      let pick = agents.first { $0.harness == r.harness && !used.contains($0.id) } ?? agents.first { $0.harness == r.harness } ?? agents.first { !used.contains($0.id) }
      if let pick { used.insert(pick.id) }
      var r = r
      r.agentId = pick?.id
      return r
    }
    var team = base ?? .empty
    team.nodes = []
    team.edges = []
    team.roles = filled
    team.steps = steps
    return team.withChart
  }

  private typealias R = ChannelTeam.Role
  private typealias S = ChannelTeam.Step

  static let builtIn: [TeamTemplate] = [
    TeamTemplate(
      id: "plan-challenge", name: "Plan and challenge",
      blurb: "A lead plans, a challenger pushes back until it approves, then the lead hands out the work.",
      roles: [
        R(id: "lead", name: "Lead", description: "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in.", agentId: nil, harness: "claude-code"),
        R(id: "challenger", name: "Challenger", description: "You review the lead's plan before any work starts. Look for gaps, wrong assumptions, missing tests, security problems and anything the request asked for that the plan skips. Challenge it; don't rewrite it. Send it back with a numbered list, or approve it when it's ready.", agentId: nil, harness: "codex"),
        R(id: "backend", name: "Backend builder", description: "You build the server, data and API pieces of an approved plan. Keep to the plan; if something in it can't work, say so in the thread instead of quietly doing something else.", agentId: nil, harness: "codex"),
        R(id: "frontend", name: "Frontend builder", description: "You build the screens of an approved plan. Match the look and patterns already in the app.", agentId: nil, harness: "kimi"),
        R(id: "reviewer", name: "Reviewer", description: "You review every finished piece: read the diff, run the tests, try it. Approve it, or send it back with exactly what needs to change. You never review work you built yourself.", agentId: nil, harness: "claude-code"),
      ],
      steps: [
        S(id: "plan", roleId: "lead", kind: .do, action: "Draft a thorough plan", next: "challenge"),
        S(id: "challenge", roleId: "challenger", kind: .review, action: "Find gaps, challenge the plan", next: "hand-out", sendBackTo: "plan", maxRounds: 3),
        S(id: "hand-out", roleId: "lead", kind: .handOut, action: "Hand out the pieces", next: "report", maxRounds: 3, handTo: ["backend", "frontend"], reviewBy: "reviewer"),
        S(id: "report", roleId: "lead", kind: .do, action: "Report back", next: nil),
      ]),
    TeamTemplate(
      id: "build-review", name: "Build and review",
      blurb: "One builds, another harness reviews, a tester checks it runs.",
      roles: [
        R(id: "builder", name: "Builder", description: "You build what's asked, with tests, and say what you changed and how you checked it.", agentId: nil, harness: "codex"),
        R(id: "reviewer", name: "Reviewer", description: "You read the builder's work as a skeptical senior engineer: correctness, edge cases, readability, security. Approve it or send it back with a numbered list.", agentId: nil, harness: "claude-code"),
        R(id: "tester", name: "Tester", description: "You run the thing for real, the way a person would use it, and report what works and what doesn't, with steps to reproduce.", agentId: nil, harness: "gemini"),
      ],
      steps: [
        S(id: "build", roleId: "builder", kind: .do, action: "Build it", next: "review"),
        S(id: "review", roleId: "reviewer", kind: .review, action: "Review the work", next: "test", sendBackTo: "build", maxRounds: 3),
        S(id: "test", roleId: "tester", kind: .review, action: "Try it for real", next: nil, sendBackTo: "build", maxRounds: 2),
      ]),
    TeamTemplate(
      id: "research-desk", name: "Research desk",
      blurb: "Researcher digs, fact-checker verifies every claim, writer delivers.",
      roles: [
        R(id: "researcher", name: "Researcher", description: "You dig into the question using primary sources and collect findings with links. Say how sure you are of each one.", agentId: nil, harness: "claude-code"),
        R(id: "checker", name: "Fact-checker", description: "You check every claim against its source. Anything unsupported, out of date or overstated goes back with a list.", agentId: nil, harness: "codex"),
        R(id: "writer", name: "Writer", description: "You turn checked findings into a short, clear write-up for the person who asked, with the sources.", agentId: nil, harness: "claude-code"),
      ],
      steps: [
        S(id: "research", roleId: "researcher", kind: .do, action: "Research the question", next: "check"),
        S(id: "check", roleId: "checker", kind: .review, action: "Check every claim", next: "write", sendBackTo: "research", maxRounds: 2),
        S(id: "write", roleId: "writer", kind: .do, action: "Write it up", next: nil),
      ]),
    TeamTemplate(
      id: "bug-squad", name: "Bug squad",
      blurb: "Reproduce, fix, verify. Nothing closes until the verifier sees it fixed.",
      roles: [
        R(id: "reproducer", name: "Reproducer", description: "You reproduce the bug reliably and write the exact steps, plus a failing test when you can.", agentId: nil, harness: "claude-code"),
        R(id: "fixer", name: "Fixer", description: "You find the root cause and fix it, not the symptom. Make the failing test pass.", agentId: nil, harness: "codex"),
        R(id: "verifier", name: "Verifier", description: "You follow the reproduction steps again on the fix. Approve only when the bug is gone and nothing nearby broke.", agentId: nil, harness: "claude-code"),
      ],
      steps: [
        S(id: "repro", roleId: "reproducer", kind: .do, action: "Reproduce the bug", next: "fix"),
        S(id: "fix", roleId: "fixer", kind: .do, action: "Fix the root cause", next: "verify"),
        S(id: "verify", roleId: "verifier", kind: .review, action: "Verify the fix", next: nil, sendBackTo: "fix", maxRounds: 3),
      ]),
    TeamTemplate(
      id: "support-queue", name: "Support queue",
      blurb: "Triage sorts, responder drafts, a checker reads every reply before it goes out.",
      roles: [
        R(id: "triage", name: "Triage", description: "You read each request, work out what's actually being asked and how urgent it is, and gather what the responder needs.", agentId: nil, harness: "claude-code"),
        R(id: "responder", name: "Responder", description: "You draft the reply in the person's voice. Anything about money, refunds or contracts gets flagged for a person instead.", agentId: nil, harness: "claude-code"),
        R(id: "checker", name: "Checker", description: "You read every draft before it goes anywhere: is it right, kind and complete? Approve it or send it back.", agentId: nil, harness: "codex"),
      ],
      steps: [
        S(id: "triage", roleId: "triage", kind: .do, action: "Sort the request", next: "draft"),
        S(id: "draft", roleId: "responder", kind: .do, action: "Draft the reply", next: "check"),
        S(id: "check", roleId: "checker", kind: .review, action: "Check the draft", next: nil, sendBackTo: "draft", maxRounds: 2),
      ]),
  ]

  /** The team "Describe it" starts with: the lead alone handles every request until it sets the team up. */
  static func starter(lead: String) -> ChannelTeam {
    ChannelTeam(nodes: [], edges: [],
      roles: [ChannelTeam.Role(id: "lead", name: "Lead", description: "Handles every request until the team is set up.", agentId: lead)],
      steps: [ChannelTeam.Step(id: "handle", roleId: "lead", kind: .do, action: "Handle the request", next: nil)]).withChart
  }
}

// MARK: the chart

/** Where everything on a stepped team's chart goes: the steps, and under each hand-out its pieces and who checks them (boxes on the web). */
struct StepBox: Identifiable, Hashable {
  enum What: Hashable { case step(ChannelTeam.Step), piece(roleId: String, of: String), checker(roleId: String, of: String) }
  var id: String
  var x, y, w, h: Double
  var what: What

  var roleId: String {
    switch what {
    case .step(let s): s.roleId
    case .piece(let r, _), .checker(let r, _): r
    }
  }
  var step: ChannelTeam.Step? { if case .step(let s) = what { s } else { nil } }
  var midX: Double { x + w / 2 }
}

/** A line between boxes: a cubic curve, how it reads, and where its label sits. */
struct StepLine: Identifiable, Hashable {
  enum Tone: Hashable { case go, ok, back }
  struct Pt: Hashable { var x, y: Double }
  var id: String
  var start, c1, c2, end, mid: Pt
  var tone: Tone
  var label: String?
}

extension ChannelTeam {
  var chartBoxes: [StepBox] {
    var out: [StepBox] = []
    let w = Self.stepWidth, h = Self.stepHeight, row = Self.stepRow
    for s in steps ?? [] {
      out.append(StepBox(id: s.id, x: s.x, y: s.y, w: w, h: h, what: .step(s)))
      guard s.kind == .handOut else { continue }
      let to = s.handTo ?? []
      let gap = 32.0
      let width = Double(to.count) * w + Double(max(to.count - 1, 0)) * gap
      for (i, roleId) in to.enumerated() {
        out.append(StepBox(id: "\(s.id):piece:\(roleId)", x: s.x + w / 2 - width / 2 + Double(i) * (w + gap), y: s.y + row, w: w, h: h, what: .piece(roleId: roleId, of: s.id)))
      }
      if let checker = s.reviewBy {
        out.append(StepBox(id: "\(s.id):check", x: s.x, y: s.y + row * (to.isEmpty ? 1 : 2), w: w, h: h, what: .checker(roleId: checker, of: s.id)))
      }
    }
    return out
  }

  private enum Dir { case down, up, left, right }
  /** A smooth curve from a to b that leaves and arrives heading the given ways. */
  private static func curve(_ a: StepLine.Pt, _ b: StepLine.Pt, _ out: Dir, _ into: Dir) -> (StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt) {
    let reach = max(40, hypot(b.x - a.x, b.y - a.y) / 3)
    func d(_ dir: Dir, _ p: StepLine.Pt, _ s: Double) -> StepLine.Pt {
      switch dir {
      case .down: .init(x: p.x, y: p.y + s * reach)
      case .up: .init(x: p.x, y: p.y - s * reach)
      case .right: .init(x: p.x + s * reach, y: p.y)
      case .left: .init(x: p.x - s * reach, y: p.y)
      }
    }
    let c1 = d(out, a, 1), c2 = d(into, b, -1)
    let mid = StepLine.Pt(x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8)
    return (a, c1, c2, b, mid)
  }
  /** A straight line, for boxes side by side. */
  private static func straight(_ a: StepLine.Pt, _ b: StepLine.Pt) -> (StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt) {
    (a, a, b, b, .init(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2))
  }

  /**
   * The lines on the chart: next is gray, after a review green "approved", a send-back dashed
   * orange. Boxes side by side get straight lines, forward in the upper part and back in the lower.
   */
  func chartLines(_ all: [StepBox]) -> [StepLine] {
    let by = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var out: [StepLine] = []
    func add(_ id: String, _ c: (StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt, StepLine.Pt), _ tone: StepLine.Tone, _ label: String? = nil) {
      out.append(StepLine(id: id, start: c.0, c1: c.1, c2: c.2, end: c.3, mid: c.4, tone: tone, label: label))
    }
    let bottom = { (b: StepBox) in StepLine.Pt(x: b.midX, y: b.y + b.h) }
    let top = { (b: StepBox) in StepLine.Pt(x: b.midX, y: b.y) }
    for s in steps ?? [] {
      guard let me = by[s.id] else { continue }
      let pieces = all.filter { if case .piece(_, let of) = $0.what { of == s.id } else { false } }
      let check = all.first { if case .checker(_, let of) = $0.what { of == s.id } else { false } }
      for p in pieces { add("\(s.id)>\(p.id)", Self.curve(bottom(me), top(p), .down, .down), .go) }
      if let check {
        for p in pieces.isEmpty ? [me] : pieces { add("\(p.id)>check", Self.curve(bottom(p), top(check), .down, .down), .go) }
        add("\(s.id):back", Self.curve(.init(x: check.x + check.w, y: check.y + check.h / 2), .init(x: check.x + check.w + 60, y: check.y - 20), .right, .down), .back, "changes go back to the builder")
      }
      if let nextId = s.next, let to = by[nextId] {
        let froms = check.map { [$0] } ?? (pieces.isEmpty ? [me] : pieces)
        for f in froms {
          let c = to.y > f.y + f.h + 12
            ? Self.curve(bottom(f), top(to), .down, .down)
            : to.x > f.x
              ? Self.straight(.init(x: f.x + f.w, y: f.y + f.h * 0.35), .init(x: to.x, y: to.y + to.h * 0.35))
              : Self.straight(.init(x: f.x, y: f.y + f.h * 0.35), .init(x: to.x + to.w, y: to.y + to.h * 0.35))
          add("\(f.id)>\(nextId)", c, s.kind == .review || check != nil ? .ok : .go, s.kind == .review ? "approved" : check != nil ? "all approved" : nil)
        }
      }
      if s.kind == .review, let backId = s.sendBackTo, let to = by[backId] {
        let left = to.x < me.x
        let c = abs(to.y - me.y) < 10
          ? Self.straight(.init(x: me.x + (left ? 0 : me.w), y: me.y + me.h * 0.7), .init(x: to.x + (left ? to.w : 0), y: to.y + to.h * 0.7))
          : Self.curve(.init(x: me.x, y: me.y + me.h / 2), .init(x: to.x, y: to.y + to.h / 2), .left, .right)
        add("\(s.id)~back", c, .back, "changes, max \(s.maxRounds ?? Self.defaultRounds)")
      }
    }
    return out
  }
}

// MARK: a request going through the steps

/** One request going through a stepped team (TeamFlow in packages/core): what the strip needs. */
struct TeamFlow: Decodable, Identifiable, Hashable {
  struct Done: Decodable, Hashable { var stepId: String; var verdict: String? }
  struct Waiting: Decodable, Hashable { var why: String; var options: String }
  var id: String
  var channelId: String
  var threadId: String
  /** running, waiting (a person has to decide), done or failed */
  var status: String
  var stepId: String
  var rounds: [String: Int]
  var history: [Done]
  var waitingFor: Waiting?

  /** steps that finished (done or approved) */
  var doneSteps: Set<String> { Set(history.filter { $0.verdict == "done" || $0.verdict == "approved" }.map(\.stepId)) }
}

extension Store {
  func flows(in channelId: String) async throws -> [TeamFlow] {
    try await fetch { try await $0.get("/api/channels/\(channelId)/flows") }
  }
  /** approve, retry or stop a request that's waiting on a person */
  func decideFlow(_ id: String, _ action: String) async throws -> TeamFlow {
    try await fetch { try await $0.post("/api/flows/\(id)/decide", ["action": action]) }
  }
  /** templates people here saved from their own teams */
  func teamTemplates() async throws -> [TeamTemplate] {
    try await fetch { try await $0.get("/api/team-templates") }
  }
  func saveTeamTemplate(channelId: String, name: String) async throws {
    let _: TeamTemplate = try await fetch { try await $0.post("/api/team-templates", ["channelId": channelId, "name": name]) }
  }
  func deleteTeamTemplate(_ id: String) async throws {
    _ = try await fetch { try await $0.delete("/api/team-templates/\(id)") }
  }
  /** the workspace's lead right now, fresh from the hub */
  func currentLead() async throws -> String? {
    let lead: WorkspaceLead = try await fetch { try await $0.get("/api/settings/lead") }
    return lead.lead
  }
}
