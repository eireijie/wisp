import Foundation

/**
 * Teams that run on a flow chart of steps: the same model, rules, plain-English lines and templates
 * as team-flow.ts in packages/core, so a team made here works (and reads) the same on the web.
 *
 * A step has its own agent and prompt. `inputs` are the steps whose results it receives and waits
 * for; steps with no inputs start together. Edges live in `inputs`, `nexts` and `next`, and they
 * are kept consistent with each other (`normalizeSteps`).
 */
extension ChannelTeam {
  typealias Kind = Step.Kind

  static let defaultRounds = 3
  static let maxRounds = 10
  static let maxSteps = 40

  /** One box on the flow chart (TeamStep in packages/core). Every field after `action` is optional so older teams still load. */
  struct Step: Codable, Hashable, Identifiable {
    enum Kind: String, Codable, CaseIterable { case `do`, review, handOut = "hand_out", ask, handoff, branch, custom, schedule }

    /** A simple rule on a result, for an if/else that needs no agent. */
    struct Rule: Codable, Hashable {
      enum Op: String, Codable, CaseIterable {
        case contains, notContains = "not_contains", startsWith = "starts_with", equals
        var label: String {
          switch self {
          case .contains: "contains"
          case .notContains: "doesn't contain"
          case .startsWith: "starts with"
          case .equals: "is"
          }
        }
      }
      var op: Op
      var value: String
    }

    var id: String
    /** an older team's role for this step; "" for steps that name their agent directly */
    var roleId: String
    var kind: Kind
    /** the step's title, e.g. "Draft a thorough plan" */
    var action: String
    /** the first step after this one; nil = the flow ends here (`nexts` has all of them) */
    var next: String?
    var nexts: [String]?
    /** the steps whose results this one receives and waits for */
    var inputs: [String]?
    var agentId: String?
    /** what the agent does here: its own instructions for this step */
    var prompt: String?
    var harness: String?
    /** review (and ask): the step that gets the work back when changes are needed */
    var sendBackTo: String?
    var maxRounds: Int?
    /** hand-out: the roles the pieces go to, and the role that checks each piece */
    var handTo: [String]?
    var reviewBy: String?
    /** ask: what the person sees, and whether to tell them on their phone */
    var show: String?
    var notifyPhone: Bool?
    /** handoff: the other team's channel id, and whether to wait for its answer */
    var handoffTo: String?
    var waitForReply: Bool?
    /** if/else: a yes/no question an agent answers, or a simple rule; where yes and no go */
    var condition: String?
    var rule: Rule?
    var ifTrue: String?
    var ifFalse: String?
    /** schedule: when it runs (cron), in which time zone, and whether it's on; `prompt` is what the team gets asked */
    var schedule: String?
    var timezone: String?
    var enabled: Bool?
    var x: Double
    var y: Double

    init(id: String, roleId: String = "", kind: Kind, action: String, next: String? = nil, sendBackTo: String? = nil, maxRounds: Int? = nil,
         handTo: [String]? = nil, reviewBy: String? = nil, x: Double = 0, y: Double = 0,
         nexts: [String]? = nil, inputs: [String]? = nil, agentId: String? = nil, prompt: String? = nil, harness: String? = nil,
         show: String? = nil, notifyPhone: Bool? = nil, handoffTo: String? = nil, waitForReply: Bool? = nil,
         condition: String? = nil, rule: Rule? = nil, ifTrue: String? = nil, ifFalse: String? = nil) {
      self.id = id; self.roleId = roleId; self.kind = kind; self.action = action; self.next = next
      self.nexts = nexts; self.inputs = inputs; self.agentId = agentId; self.prompt = prompt; self.harness = harness
      self.sendBackTo = sendBackTo; self.maxRounds = maxRounds; self.handTo = handTo; self.reviewBy = reviewBy
      self.show = show; self.notifyPhone = notifyPhone; self.handoffTo = handoffTo; self.waitForReply = waitForReply
      self.condition = condition; self.rule = rule; self.ifTrue = ifTrue; self.ifFalse = ifFalse; self.x = x; self.y = y
    }

    private enum K: String, CodingKey {
      case id, roleId, kind, action, next, nexts, inputs, agentId, prompt, harness, sendBackTo, maxRounds, handTo, reviewBy
      case show, notifyPhone, handoffTo, waitForReply, condition, rule, ifTrue, ifFalse, schedule, timezone, enabled, x, y
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: K.self)
      id = try c.decode(String.self, forKey: .id)
      roleId = (try? c.decode(String.self, forKey: .roleId)) ?? ""
      kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .do
      action = (try? c.decode(String.self, forKey: .action)) ?? ""
      next = try? c.decodeIfPresent(String.self, forKey: .next)
      nexts = try? c.decodeIfPresent([String].self, forKey: .nexts)
      inputs = try? c.decodeIfPresent([String].self, forKey: .inputs)
      agentId = try? c.decodeIfPresent(String.self, forKey: .agentId)
      prompt = try? c.decodeIfPresent(String.self, forKey: .prompt)
      harness = try? c.decodeIfPresent(String.self, forKey: .harness)
      sendBackTo = try? c.decodeIfPresent(String.self, forKey: .sendBackTo)
      maxRounds = try? c.decodeIfPresent(Int.self, forKey: .maxRounds)
      handTo = try? c.decodeIfPresent([String].self, forKey: .handTo)
      reviewBy = try? c.decodeIfPresent(String.self, forKey: .reviewBy)
      show = try? c.decodeIfPresent(String.self, forKey: .show)
      notifyPhone = try? c.decodeIfPresent(Bool.self, forKey: .notifyPhone)
      handoffTo = try? c.decodeIfPresent(String.self, forKey: .handoffTo)
      waitForReply = try? c.decodeIfPresent(Bool.self, forKey: .waitForReply)
      condition = try? c.decodeIfPresent(String.self, forKey: .condition)
      rule = try? c.decodeIfPresent(Rule.self, forKey: .rule)
      ifTrue = try? c.decodeIfPresent(String.self, forKey: .ifTrue)
      ifFalse = try? c.decodeIfPresent(String.self, forKey: .ifFalse)
      schedule = try? c.decodeIfPresent(String.self, forKey: .schedule)
      timezone = try? c.decodeIfPresent(String.self, forKey: .timezone)
      enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
      x = (try? c.decode(Double.self, forKey: .x)) ?? 0
      y = (try? c.decode(Double.self, forKey: .y)) ?? 0
    }

    // the hub wants next even when the flow ends here
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: K.self)
      try c.encode(id, forKey: .id)
      try c.encode(roleId, forKey: .roleId)
      try c.encode(kind, forKey: .kind)
      try c.encode(action, forKey: .action)
      try c.encode(next, forKey: .next)
      try c.encodeIfPresent(nexts, forKey: .nexts)
      try c.encodeIfPresent(inputs, forKey: .inputs)
      try c.encodeIfPresent(agentId, forKey: .agentId)
      try c.encodeIfPresent(prompt, forKey: .prompt)
      try c.encodeIfPresent(harness, forKey: .harness)
      try c.encodeIfPresent(sendBackTo, forKey: .sendBackTo)
      try c.encodeIfPresent(maxRounds, forKey: .maxRounds)
      try c.encodeIfPresent(handTo, forKey: .handTo)
      try c.encodeIfPresent(reviewBy, forKey: .reviewBy)
      try c.encodeIfPresent(show, forKey: .show)
      try c.encodeIfPresent(notifyPhone, forKey: .notifyPhone)
      try c.encodeIfPresent(handoffTo, forKey: .handoffTo)
      try c.encodeIfPresent(waitForReply, forKey: .waitForReply)
      try c.encodeIfPresent(condition, forKey: .condition)
      try c.encodeIfPresent(rule, forKey: .rule)
      try c.encodeIfPresent(ifTrue, forKey: .ifTrue)
      try c.encodeIfPresent(ifFalse, forKey: .ifFalse)
      try c.encodeIfPresent(schedule, forKey: .schedule)
      try c.encodeIfPresent(timezone, forKey: .timezone)
      try c.encodeIfPresent(enabled, forKey: .enabled)
      try c.encode(x, forKey: .x)
      try c.encode(y, forKey: .y)
    }

    /** the ids of the steps it receives results from */
    var inputIds: [String] { inputs ?? [] }
    /** the kinds an agent does (the rest are a person, another team, or a rule) */
    var needsAgent: Bool {
      if kind == .ask || kind == .handoff || kind == .schedule { return false }
      if kind == .branch && rule != nil { return false }
      return true
    }
  }

  /** A team that runs on steps rather than a plain chart of who hands work to whom. */
  var hasSteps: Bool { !(steps ?? []).isEmpty }

  func role(_ id: String?) -> Role? { roles?.first { $0.id == id } }
  func step(_ id: String?) -> Step? { steps?.first { $0.id == id } }

  /** The agent that does a step: its own, else its older role's. */
  func agentId(of step: Step) -> String? {
    if let a = step.agentId, !a.isEmpty { return a }
    return role(step.roleId)?.agentId
  }

  /** What a step is told to do: its own prompt, else its older role's description. */
  func prompt(of step: Step) -> String {
    (step.prompt ?? role(step.roleId)?.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

// MARK: the graph

/** The forward edges of a team's steps and its loops (StepGraph). */
struct StepGraph {
  var ids: [String]
  /** who each step waits for, and who it leads to */
  var ins: [String: [String]]
  var outs: [String: [String]]
  /** loops: where a repeat or ask-me sends work back to, and an if/else's "back" arrows */
  var back: [String: [String]]
}

private func uniq(_ xs: [String]) -> [String] {
  var seen = Set<String>()
  return xs.filter { seen.insert($0).inserted }
}

extension ChannelTeam {
  /** The edges of a team's steps. Dangling ids are dropped here; `stepsProblems` reports them. */
  static func stepGraph(_ steps: [Step]) -> StepGraph {
    let ids = steps.map(\.id)
    let known = Set(ids)
    var outs = Dictionary(uniqueKeysWithValues: ids.map { ($0, [String]()) })
    var ins = outs, back = outs
    let byId = Dictionary(steps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    func add(_ a: String, _ b: String) {
      guard known.contains(a), known.contains(b), a != b, !(outs[a] ?? []).contains(b) else { return }
      outs[a, default: []].append(b)
      ins[b, default: []].append(a)
    }
    for s in steps {
      if s.kind != .branch { for n in (s.nexts ?? []) + (s.next.map { [$0] } ?? []) { add(s.id, n) } }
      // an if/else only leads to the steps its Yes and No name; a plain arrow from it never fires
      for i in s.inputs ?? [] where byId[i]?.kind != .branch { add(i, s.id) }
    }
    // an if/else's arrows go forward, unless they point at a step that leads here (that's a loop)
    func reaches(_ from: String, _ to: String) -> Bool {
      var seen = Set<String>()
      var stack = [from]
      while let x = stack.popLast() {
        if x == to { return true }
        if !seen.insert(x).inserted { continue }
        stack.append(contentsOf: outs[x] ?? [])
      }
      return false
    }
    for s in steps where s.kind == .branch {
      for t in uniq([s.ifTrue, s.ifFalse].compactMap { $0 }.filter { known.contains($0) }) {
        if t == s.id || reaches(t, s.id) { back[s.id, default: []].append(t) } else { add(s.id, t) }
      }
    }
    for s in steps where s.kind == .review || s.kind == .ask {
      if let b = s.sendBackTo, known.contains(b) { back[s.id, default: []].append(b) }
    }
    return StepGraph(ids: ids, ins: ins, outs: outs, back: back)
  }

  /** Steps whose edges (nexts, inputs, next) all agree with each other, so any client can read any one of them. */
  static func normalizeSteps(_ steps: [Step]) -> [Step] {
    let g = stepGraph(steps)
    let known = Set(g.ids)
    return steps.map { s in
      var s = s
      let dangling = ((s.nexts ?? []) + (s.next.map { [$0] } ?? [])).filter { !known.contains($0) }
      let nexts = (g.outs[s.id] ?? []) + dangling
      let inputs = (g.ins[s.id] ?? []) + (s.inputs ?? []).filter { !known.contains($0) }
      s.nexts = nexts
      s.inputs = inputs
      s.next = nexts.first
      return s
    }
  }

  /** The steps nothing leads to but a schedule: where a new message starts, all at once. */
  static func startSteps(_ steps: [Step]) -> [Step] {
    let g = stepGraph(steps)
    let kinds = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0.kind) })
    return steps.filter { $0.kind != .schedule && (g.ins[$0.id] ?? []).allSatisfy { kinds[$0] == .schedule } }
  }

  static func firstStep(_ steps: [Step]) -> Step? { startSteps(steps).first ?? steps.first }

  /** Every step after this one, however far (not counting loops back). */
  static func stepsAfter(_ steps: [Step], _ id: String) -> Set<String> {
    let g = stepGraph(steps)
    var out = Set<String>()
    var stack = g.outs[id] ?? []
    while let x = stack.popLast() {
      if !out.insert(x).inserted { continue }
      stack.append(contentsOf: g.outs[x] ?? [])
    }
    return out
  }

  /** The steps in the order they'd happen: nothing before the steps it waits for; ties keep the order listed. */
  static func stepOrder(_ steps: [Step]) -> [Step] {
    let g = stepGraph(steps)
    var left = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, (g.ins[$0.id] ?? []).count) })
    var out: [Step] = []
    var done = Set<String>()
    while out.count < steps.count {
      // a circle: the rest follow in the order listed
      guard let s = steps.first(where: { !done.contains($0.id) && left[$0.id] == 0 }) ?? steps.first(where: { !done.contains($0.id) }) else { break }
      out.append(s)
      done.insert(s.id)
      for o in g.outs[s.id] ?? [] { left[o, default: 1] -= 1 }
    }
    return out
  }

  /** How far down each step is: 0 for the first, one more than the deepest step it waits for. */
  static func stepLevels(_ steps: [Step]) -> [String: Int] {
    let g = stepGraph(steps)
    var level: [String: Int] = [:]
    for s in stepOrder(steps) {
      level[s.id] = (g.ins[s.id] ?? []).map { level[$0] ?? 0 }.max().map { $0 + 1 } ?? 0
    }
    return level
  }

  /** The steps as rows, top to bottom; steps in a row run together. */
  static func stepRows(_ steps: [Step]) -> [[Step]] {
    let level = stepLevels(steps)
    var rows: [Int: [Step]] = [:]
    for s in stepOrder(steps) { rows[level[s.id] ?? 0, default: []].append(s) }
    return rows.keys.sorted().map { rows[$0]! }
  }

  /** The number a step shows ("step 3"): its place in the order it happens in. */
  func number(of id: String?) -> Int {
    (orderedSteps.firstIndex { $0.id == id }).map { $0 + 1 } ?? 0
  }

  /** The steps that do work, in order (a schedule box only starts them). */
  var orderedSteps: [Step] { Self.stepOrder(steps ?? []).filter { $0.kind != .schedule } }

  /** An older linear team as a graph: every step's edges spelled out, its prompt on the step, nothing lost. Safe to run again. */
  var migrated: ChannelTeam {
    guard let steps, !steps.isEmpty else { return self }
    var team = self
    team.steps = Self.normalizeSteps(steps.map { s in
      var s = s
      if s.prompt == nil { s.prompt = role(s.roleId)?.description }
      return s
    })
    return team
  }

  var isGraph: Bool { (steps ?? []).allSatisfy { $0.nexts != nil && $0.inputs != nil } }
}

// MARK: checking

extension ChannelTeam {
  /** What's wrong with the roles and steps, in plain words, one line each (the first is `stepsProblem`). Empty when they work. */
  var stepsProblems: [String] {
    let roles = roles ?? [], steps = steps ?? []
    if steps.isEmpty { return roles.isEmpty ? [] : ["Add at least one step."] }
    if steps.count > Self.maxSteps { return ["A team can have at most \(Self.maxSteps) steps."] }
    let roleIds = Set(roles.map(\.id))
    if roleIds.count != roles.count { return ["Two roles share an id."] }
    if roles.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) { return ["Every role needs a name."] }
    let stepIds = Set(steps.map(\.id))
    if stepIds.count != steps.count { return ["Two steps share an id."] }
    func label(_ s: Step) -> String {
      let t = s.action.trimmingCharacters(in: .whitespaces)
      return t.isEmpty ? (role(s.roleId)?.name ?? "a step") : t
    }
    var out: [String] = []
    for s in steps {
      if let p = problem(of: s, label: label(s), roleIds: roleIds, stepIds: stepIds) { out.append(p) }
    }
    if !out.isEmpty { return out }
    if !steps.contains(where: { $0.kind != .ask && $0.kind != .handoff && $0.needsAgent }) { return ["Add at least one step that an agent does."] }
    return graphProblem(steps).map { [$0] } ?? []
  }

  /** What's wrong with the roles and steps, in plain words, or nil when they work (stepsProblem in packages/core). */
  var stepsProblem: String? { stepsProblems.first }

  /** The first thing wrong with one step on its own. */
  func problem(of s: Step) -> String? {
    problem(of: s, label: { let t = s.action.trimmingCharacters(in: .whitespaces); return t.isEmpty ? (role(s.roleId)?.name ?? "a step") : t }(),
      roleIds: Set((roles ?? []).map(\.id)), stepIds: Set((steps ?? []).map(\.id)))
  }

  private func problem(of s: Step, label: String, roleIds: Set<String>, stepIds: Set<String>) -> String? {
    let roles = roles ?? []
    let role = s.roleId.isEmpty ? nil : roles.first { $0.id == s.roleId }
    if !s.roleId.isEmpty && role == nil { return "A step belongs to a role that isn't on the team." }
    if s.needsAgent && agentId(of: s) == nil { return role.map { "Pick an agent for \($0.name)." } ?? "Pick an agent for “\(label)”." }
    let refs = (s.nexts ?? []) + (s.next.map { [$0] } ?? []) + (s.inputs ?? [])
    if refs.contains(where: { !stepIds.contains($0) }) { return "A step leads to a step that isn't there." }
    if refs.contains(s.id) { return "A step can't lead to itself." }
    if s.kind == .schedule {
      if (s.prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what the schedule asks the team." }
      if CronSchedule(s.schedule ?? "") == nil { return "Say when the schedule runs." }
      if (s.nexts ?? []).isEmpty { return "Point the schedule at the steps it starts." }
    }
    if s.kind == .review {
      guard let b = s.sendBackTo, stepIds.contains(b) else { return "Say where “\(label)” sends work back to." }
      if b == s.id { return "A review can't send work back to itself." }
    }
    if s.kind == .ask, let b = s.sendBackTo, !b.isEmpty {
      if !stepIds.contains(b) { return "Say where “\(label)” sends work back to." }
      if b == s.id { return "A step can't send work back to itself." }
    }
    if s.kind == .handOut {
      let to = s.handTo ?? []
      if to.isEmpty { return "Pick who “\(label)” hands pieces to." }
      if to.contains(where: { !roleIds.contains($0) }) || (s.reviewBy.map { !$0.isEmpty && !roleIds.contains($0) } ?? false) { return "A hand-out names a role that isn't on the team." }
      for r in to + (s.reviewBy.flatMap { $0.isEmpty ? nil : [$0] } ?? []) {
        if let rl = roles.first(where: { $0.id == r }), rl.agentId == nil { return "Pick an agent for \(rl.name)." }
      }
    }
    if s.kind == .handoff && (s.handoffTo ?? "").isEmpty { return "Pick the team “\(label)” hands the work to." }
    if s.kind == .branch {
      if s.rule == nil && (s.condition ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return "Say what “\(label)” checks for." }
      if let r = s.rule, r.value.trimmingCharacters(in: .whitespaces).isEmpty { return "Say what “\(label)” looks for in the result." }
      for t in [s.ifTrue, s.ifFalse] {
        if let t, !t.isEmpty {
          if !stepIds.contains(t) { return "A step leads to a step that isn't there." }
          if t == s.id { return "A step can't lead to itself." }
        }
      }
      if (s.ifTrue ?? "").isEmpty && (s.ifFalse ?? "").isEmpty { return "Say where “\(label)” goes next." }
    }
    return nil
  }

  /** The circle, loop and reachability checks, after every step is fine on its own. */
  private func graphProblem(_ steps: [Step]) -> String? {
    let g = Self.stepGraph(steps)
    let circle = "The steps go round in a circle. To loop, use a repeat step with a limit, or an ask-me step."
    func label(_ s: Step) -> String { let t = s.action.trimmingCharacters(in: .whitespaces); return t.isEmpty ? (role(s.roleId)?.name ?? "a step") : t }
    // forward arrows never go round: loops go through a repeat, ask-me or if/else step
    var left = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, (g.ins[$0.id] ?? []).count) })
    var queue = steps.filter { left[$0.id] == 0 }.map(\.id)
    var seen = 0
    while let x = queue.popLast() {
      seen += 1
      for o in g.outs[x] ?? [] {
        left[o, default: 0] -= 1
        if left[o] == 0 { queue.append(o) }
      }
    }
    if seen != steps.count { return circle }
    for s in steps {
      for t in g.back[s.id] ?? [] where !Self.stepsAfter(steps, t).contains(s.id) {
        return s.kind == .branch ? "“\(label(s))” can only loop back to a step before it." : "“\(label(s))” can only send work back to a step before it."
      }
    }
    // every cycle holds a repeat step (it has a max), an ask-me step (a person decides) or an if/else (it has a max too)
    let byId = Dictionary(steps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for comp in Self.cycles(g) where !comp.contains(where: { [.review, .ask, .branch].contains(byId[$0]?.kind) }) { return circle }
    // every step is reachable from a start
    var reach = Set<String>()
    var stack = steps.filter { (g.ins[$0.id] ?? []).isEmpty }.map(\.id)
    while let x = stack.popLast() {
      if !reach.insert(x).inserted { continue }
      stack.append(contentsOf: (g.outs[x] ?? []) + (g.back[x] ?? []))
    }
    if reach.count != steps.count { return "Every step needs to be reachable from the start." }
    return nil
  }

  /** The groups of steps that lead back to themselves (Tarjan's strongly connected parts, with loops counted). */
  private static func cycles(_ g: StepGraph) -> [[String]] {
    func next(_ id: String) -> [String] { (g.outs[id] ?? []) + (g.back[id] ?? []) }
    var index = 0
    var idx: [String: Int] = [:], low: [String: Int] = [:]
    var on = Set<String>()
    var stack: [String] = []
    var out: [[String]] = []
    func visit(_ v: String) {
      idx[v] = index; low[v] = index; index += 1
      stack.append(v); on.insert(v)
      for w in next(v) {
        if idx[w] == nil {
          visit(w)
          low[v] = min(low[v]!, low[w]!)
        } else if on.contains(w) { low[v] = min(low[v]!, idx[w]!) }
      }
      if low[v] == idx[v] {
        var comp: [String] = []
        var w: String
        repeat {
          w = stack.removeLast()
          on.remove(w)
          comp.append(w)
        } while w != v
        if comp.count > 1 || next(v).contains(v) { out.append(comp) }
      }
    }
    for id in g.ids where idx[id] == nil { visit(id) }
    return out
  }
}

// MARK: the plain chart older apps see, and layout

extension ChannelTeam {
  /**
   * The plain chart a stepped team also keeps, so older apps and the rest of Wisp see who's on it:
   * the first step's agent leads, everyone else gets work from it (chartFromSteps).
   */
  func chartFromSteps(old: [Node] = []) -> (nodes: [Node], edges: [Edge]) {
    let roles = roles ?? [], steps = steps ?? []
    let first = Self.stepOrder(steps).first { agentId(of: $0) != nil } ?? Self.firstStep(steps)
    let leadId = first.flatMap { agentId(of: $0) }
    let agentIds = uniq((steps.compactMap { agentId(of: $0) }) + roles.compactMap(\.agentId))
    let nodes = agentIds.enumerated().map { i, agent in
      let was = old.first { $0.agentId == agent }
      let names = uniq(
        roles.filter { $0.agentId == agent }.map { $0.name.trimmingCharacters(in: .whitespaces) }
          + steps.filter { agentId(of: $0) == agent && $0.roleId.isEmpty }.map { $0.action.trimmingCharacters(in: .whitespaces) }
      ).filter { !$0.isEmpty }
      return Node(agentId: agent, lead: agent == leadId, x: was?.x ?? 24 + Double(i) * 212, y: was?.y ?? (agent == leadId ? 24 : 156),
        role: String(names.joined(separator: ", ").prefix(60)))
    }
    let edges = leadId.map { lead in agentIds.filter { $0 != lead }.map { Edge(from: lead, to: $0) } } ?? []
    return (nodes, edges)
  }

  /** The team with its plain chart kept in step with its steps (withChart on the web). */
  var withChart: ChannelTeam {
    var team = self
    let chart = chartFromSteps(old: nodes)
    team.nodes = chart.nodes
    team.edges = chart.edges
    // steps added on the phone have no place on the web's chart yet: lay them out when any two share a spot
    if let steps = team.steps, steps.count > 1, Set(steps.map { "\($0.x),\($0.y)" }).count < steps.count {
      team.steps = Self.layoutSteps(steps)
    }
    return team
  }

  // the web chart's step box size and spacing
  static let stepWidth = 220.0, stepHeight = 64.0, stepRow = 150.0, stepGap = 56.0

  /** Steps laid out top to bottom, a row for each step that has to wait for another; steps that run together sit side by side. */
  static func layoutSteps(_ steps: [Step]) -> [Step] {
    let rows = stepRows(steps)
    let widest = Double(max(1, rows.map(\.count).max() ?? 1))
    var pos: [String: (x: Double, y: Double)] = [:]
    let level = stepLevels(steps)
    for row in rows {
      for (i, s) in row.enumerated() {
        pos[s.id] = (((widest - Double(row.count)) / 2 + Double(i)) * (stepWidth + stepGap), Double(level[s.id] ?? 0) * stepRow)
      }
    }
    return steps.map { s in
      var s = s
      if let p = pos[s.id] { s.x = p.x.rounded(); s.y = p.y }
      return s
    }
  }
}

// MARK: plain English

/** One plain line of how a team works (FlowLine). */
struct FlowLine: Codable, Hashable, Identifiable {
  var stepId: String
  /** 1-based, the order steps happen in */
  var n: Int
  /** runs at the same time as the step before it */
  var together: Bool
  /** "Nova", "You", or the team it's handed to */
  var who: String
  /** the rest of the sentence, without the name */
  var rest: String
  /** the whole sentence */
  var text: String
  var id: String { stepId }
}

enum FlowWords {
  private static let verbs = Set(
    "plan research build draft write review check find fix test run read collect gather sort triage reproduce verify approve ship send deliver design create make summarize summarise analyze analyse compare study explore investigate prepare publish post update edit clean translate propose pick choose answer reply respond report hand split merge deploy release schedule book call email notify tell ask look search scan list rank score rewrite refactor implement develop code debug document outline brainstorm decide confirm validate monitor track measure label tag file open close assign sign pay order buy sell collect extract fetch pull push upload download share present explain teach polish format proofread fact-check".split(separator: " ").map(String.init))

  private static func third(_ word: String) -> String {
    func matches(_ p: String) -> Bool { word.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
    if matches("[^aeiou]y$") { return String(word.dropLast()) + "ies" }
    if matches("(s|x|z|ch|sh|o)$") { return word + "es" }
    return word + "s"
  }

  static func lcFirst(_ s: String) -> String {
    let chars = Array(s)
    if chars.count > 1, String(chars[1]) == String(chars[1]).uppercased(), String(chars[1]).range(of: "[A-Z]", options: .regularExpression) != nil { return s }
    return chars.first.map { String($0).lowercased() + String(chars.dropFirst()) } ?? s
  }

  static func join(_ xs: [String]) -> String {
    xs.count <= 1 ? (xs.first ?? "") : "\(xs.dropLast().joined(separator: ", ")) and \(xs.last!)"
  }

  /** "Plan the work" -> "plans the work", when the title starts with an everyday verb; nil otherwise. */
  static func titleAsVerb(_ title: String) -> (third: String, base: String)? {
    var t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    while t.hasSuffix(".") || t.hasSuffix("!") { t.removeLast() }
    guard let re = try? NSRegularExpression(pattern: "^([A-Za-z-]+)(\\b.*)$", options: [.dotMatchesLineSeparators]),
          let m = re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)),
          let w = Range(m.range(at: 1), in: t), let rest = Range(m.range(at: 2), in: t) else { return nil }
    let word = t[w].lowercased()
    guard verbs.contains(word) else { return nil }
    return (third(word) + t[rest], word + t[rest])
  }

  static func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
}

extension ChannelTeam {
  /** How a team works, one plain line per step (describeFlow). `nameOf` gives an agent's name; `teamName` a team's name by channel id. */
  func describeFlow(nameOf: (String?) -> String, teamName: (String) -> String = { _ in "another" }) -> [FlowLine] {
    let everything = steps ?? []
    let steps = everything.filter { $0.kind != .schedule }
    let order = Self.stepOrder(steps)
    func num(_ id: String?) -> Int { (order.firstIndex { $0.id == id }).map { $0 + 1 } ?? 0 }
    let g = Self.stepGraph(steps)
    var lines: [FlowLine] = []
    for s in everything where s.kind == .schedule {
      let starts = (s.nexts ?? []).map { num($0) }.filter { $0 > 0 }.sorted()
      let what = starts.isEmpty ? "nothing yet" : "step\(starts.count > 1 ? "s" : "") \(FlowWords.join(starts.map(String.init)))"
      let when = describeCron(s.schedule ?? "")
      let rest = "\(s.enabled == false ? "is off. When on, it starts" : "starts") \(what) \(when.hasPrefix("Every") ? "every" + when.dropFirst(5) : when)"
      lines.append(FlowLine(stepId: s.id, n: 0, together: false, who: "Schedule", rest: rest, text: "Schedule \(rest)."))
    }
    var prevKey = ""
    for (i, s) in order.enumerated() {
      let ins = g.ins[s.id] ?? []
      let key = ins.sorted().joined(separator: ",")
      let together = i > 0 && key == prevKey
      prevKey = key
      let title = s.action.trimmingCharacters(in: .whitespaces)
      let agent = nameOf(agentId(of: s))
      let what = ins.isEmpty ? "" : ins.count == 1 ? "the result of step \(num(ins[0]))" : "the results of steps \(FlowWords.join(ins.map { String(num($0)) }))"
      let verb = FlowWords.titleAsVerb(title)
      var who = agent
      var rest: String
      switch s.kind {
      case .ask:
        who = "You"
        let starts = title.range(of: "^(approve|check|review|confirm|decide|choose|pick|sign)\\b", options: [.regularExpression, .caseInsensitive]) != nil
        rest = starts ? FlowWords.lcFirst(title) : title.isEmpty ? "approve it" : "look at “\(title)”"
        rest += starts ? "" : ", then approve it or ask for changes"
        if let b = s.sendBackTo, !b.isEmpty { rest += ". If you ask for changes it goes back to step \(num(b))" }
      case .handoff:
        let t = (s.handoffTo ?? "").isEmpty ? "another" : teamName(s.handoffTo!)
        who = "The \(t) team"
        rest = "gets the work\(s.waitForReply == true ? ", and the next step waits for their answer" : "")"
      case .branch:
        let test: String
        if let r = s.rule { test = "the result \(r.op.label) “\(r.value)”" } else { test = (s.condition ?? "").trimmingCharacters(in: .whitespaces) }
        let yes = (s.ifTrue ?? "").isEmpty ? "the end" : "step \(num(s.ifTrue))"
        let no = (s.ifFalse ?? "").isEmpty ? "the end" : "step \(num(s.ifFalse))"
        rest = "\(s.rule != nil ? "checks" : "looks at") \(what.isEmpty ? "the work" : what): if \(test), it goes to \(yes); if not, to \(no)"
      case .review:
        let max = s.maxRounds ?? Self.defaultRounds
        rest = "\(verb?.third ?? "checks the work")\(what.isEmpty ? "" : " using \(what)"). If it isn't good enough it goes back to step \(num(s.sendBackTo)), up to \(max) round\(max == 1 ? "" : "s"), then it asks you"
      case .handOut:
        let names = (s.handTo ?? []).compactMap { r in role(r)?.name }
        let checker = (s.reviewBy ?? "").isEmpty ? nil : role(s.reviewBy)?.name
        rest = "\(verb?.third ?? "splits the work")\(names.isEmpty ? "" : " between \(FlowWords.join(names))")\(checker.map { "; the \($0) checks each piece" } ?? "")"
      default:
        if let verb { rest = what.isEmpty ? verb.third : "uses \(what) to \(verb.base)" }
        else { rest = what.isEmpty ? "works on “\(title.isEmpty ? "this step" : title)”" : "uses \(what) for “\(title.isEmpty ? "this step" : title)”" }
      }
      let prefix = together ? "At the same time, " : ""
      lines.append(FlowLine(stepId: s.id, n: i + 1, together: together, who: who, rest: rest, text: "\(prefix)\(together ? who : FlowWords.capitalized(who)) \(rest)."))
    }
    return lines
  }
}

// MARK: editing, keeping every edge consistent

/** The two ways out of an if/else. */
enum BranchArm { case yes, no }

extension ChannelTeam.Step {
  /** Which of an if/else's arms lead to `id` (empty for any other step). */
  func arms(to id: String) -> Set<BranchArm> {
    guard kind == .branch else { return [] }
    var out = Set<BranchArm>()
    if ifTrue == id { out.insert(.yes) }
    if ifFalse == id { out.insert(.no) }
    return out
  }
}

extension ChannelTeam {
  /** A new step id that isn't taken. */
  func freeStepId(_ prefix: String = "step") -> String {
    let taken = Set((steps ?? []).map(\.id))
    var n = (steps ?? []).count + 1
    while taken.contains("\(prefix)-\(n)") { n += 1 }
    return "\(prefix)-\(n)"
  }

  private func edit(_ change: (inout [Step]) -> Void) -> ChannelTeam {
    var team = self
    var all = steps ?? []
    change(&all)
    team.steps = Self.normalizeSteps(all)
    return team
  }

  /** Draw an arrow a -> b (both ends, and `next`). */
  func connecting(_ a: String, _ b: String) -> ChannelTeam {
    guard a != b, step(b)?.kind != .schedule else { return self }
    // an if/else leads only where its Yes and No point: fill an empty one, or do nothing when both are taken
    if let src = step(a), src.kind == .branch {
      if src.ifTrue == b || src.ifFalse == b { return self }
      return updating(a) { s in
        if s.ifTrue == nil { s.ifTrue = b } else if s.ifFalse == nil { s.ifFalse = b }
      }
    }
    return edit { all in
      for i in all.indices {
        if all[i].id == a, !(all[i].nexts ?? []).contains(b) { all[i].nexts = (all[i].nexts ?? []) + [b] }
        if all[i].id == b, !(all[i].inputs ?? []).contains(a) { all[i].inputs = (all[i].inputs ?? []) + [a] }
      }
    }
  }

  /** Remove the arrow a -> b from both ends and from `next`. */
  func disconnecting(_ a: String, _ b: String) -> ChannelTeam {
    edit { all in
      for i in all.indices {
        if all[i].id == a {
          all[i].nexts = (all[i].nexts ?? []).filter { $0 != b }
          if all[i].next == b { all[i].next = nil }
          if all[i].ifTrue == b && all[i].kind == .branch { all[i].ifTrue = nil }
          if all[i].ifFalse == b && all[i].kind == .branch { all[i].ifFalse = nil }
        }
        if all[i].id == b { all[i].inputs = (all[i].inputs ?? []).filter { $0 != a } }
      }
    }
  }

  /** The steps a step can take its input from: every step that doesn't come after it. */
  func possibleInputs(for id: String) -> [Step] {
    let after = Self.stepsAfter(steps ?? [], id)
    return orderedSteps.filter { $0.id != id && !after.contains($0.id) }
  }

  /** Make `inputs` exactly the steps `id` receives results from. */
  func setting(inputs: [String], of id: String) -> ChannelTeam {
    var team = self
    let current = step(id)?.inputIds ?? []
    // the arrow from a schedule isn't a result, so it stays
    for a in current where !inputs.contains(a) && step(a)?.kind != .schedule { team = team.disconnecting(a, id) }
    for a in inputs where !current.contains(a) { team = team.connecting(a, id) }
    return team
  }

  /** Change one step; its edges are kept as they are (edit them with the arrow helpers). */
  func updating(_ id: String, _ change: (inout Step) -> Void) -> ChannelTeam {
    edit { all in if let i = all.firstIndex(where: { $0.id == id }) { change(&all[i]) } }
  }

  /** Turn a step into another kind, filling in what that kind needs (a checker's send-back, a hand-out's list). */
  func retyping(_ id: String, to kind: Step.Kind, agents: [String]) -> ChannelTeam {
    guard let s = step(id), s.kind != kind else { return self }
    let earlier = orderedSteps.filter { $0.id != id && Self.stepsAfter(steps ?? [], $0.id).contains(id) }
    let fallback = agentId(of: s) ?? agents.first
    return updating(id) { cur in
      cur.kind = kind
      if cur.needsAgent && (cur.agentId ?? "").isEmpty { cur.agentId = fallback }
      if kind == .review {
        cur.sendBackTo = cur.sendBackTo ?? earlier.last?.id
        cur.maxRounds = cur.maxRounds ?? Self.defaultRounds
      }
      if kind == .handOut { cur.handTo = cur.handTo ?? []; cur.maxRounds = cur.maxRounds ?? Self.defaultRounds }
      if kind == .branch { cur.maxRounds = cur.maxRounds ?? Self.defaultRounds }
      if kind == .ask { cur.notifyPhone = cur.notifyPhone ?? true }
      if kind == .handoff { cur.waitForReply = cur.waitForReply ?? true }
    }
  }

  /** Take a role off the team: hand-outs stop naming it, and steps that were checked by it aren't any more. */
  func removingRole(_ id: String) -> ChannelTeam {
    var next = self
    next.roles = (roles ?? []).filter { $0.id != id }
    return next.edit { all in
      for i in all.indices {
        all[i].handTo = all[i].handTo?.filter { $0 != id }
        if all[i].reviewBy == id { all[i].reviewBy = nil }
      }
    }
  }

  /** Add a step with no edges yet. */
  func appending(_ step: Step) -> ChannelTeam { edit { $0.append(step) } }

  /**
   * Put a new step on the chart. `after` = in the middle of that step's arrows (it leads to what
   * the step led to); `beside` = at the same time as that step (same inputs, same followers);
   * neither = a new start, or after the last steps when there are steps already and `atEnd`.
   */
  func inserting(_ step: Step, after: String? = nil, beside: String? = nil, atEnd: Bool = false) -> ChannelTeam {
    var new = step
    new.inputs = []; new.nexts = []; new.next = nil
    var team = appending(new)
    if let after, let anchor = self.step(after) {
      let followers = (anchor.nexts ?? []).filter { id in self.step(id) != nil }
      let arms = Dictionary(uniqueKeysWithValues: followers.map { ($0, anchor.arms(to: $0)) })
      for f in followers { team = team.disconnecting(after, f) }
      team = team.connecting(after, new.id, arms: followers.flatMap { arms[$0] ?? [] })
      for f in followers where f != new.id { team = team.connecting(new.id, f) }
    } else if let beside, let anchor = self.step(beside) {
      for i in anchor.inputIds { team = team.connecting(i, new.id) }
      for n in anchor.nexts ?? [] { team = team.connecting(new.id, n) }
    } else if atEnd {
      let ends = orderedSteps.filter { s in
        let g = Self.stepGraph(steps ?? [])
        return (g.outs[s.id] ?? []).isEmpty && s.kind != .branch
      }
      for e in ends { team = team.connecting(e.id, new.id) }
    }
    return team
  }

  /** Put a new step just before `id`: it gets what `id` was waiting for, and `id` waits for it. */
  func inserting(_ step: Step, before id: String) -> ChannelTeam {
    guard let anchor = self.step(id) else { return self }
    var new = step
    new.inputs = []; new.nexts = []; new.next = nil
    var team = appending(new)
    for i in anchor.inputIds {
      // an if/else that sent Yes or No to `id` now sends it to the new step
      let arms = self.step(i)?.arms(to: id) ?? []
      team = team.disconnecting(i, id).connecting(i, new.id, arms: arms)
    }
    return team.connecting(new.id, id)
  }

  /** Draw a -> b; when `a` is an if/else that sent Yes and/or No somewhere that was just cut, those arms go to `b`. */
  func connecting(_ a: String, _ b: String, arms: some Collection<BranchArm>) -> ChannelTeam {
    arms.isEmpty ? connecting(a, b) : sendingArms(of: a, Set(arms), to: b)
  }

  /** Point an if/else's Yes and/or No arms at `to` (nothing happens for other steps). */
  func sendingArms(of id: String, _ arms: Set<BranchArm>, to: String) -> ChannelTeam {
    guard !arms.isEmpty else { return self }
    return updating(id) { s in
      guard s.kind == .branch else { return }
      if arms.contains(.yes) { s.ifTrue = to }
      if arms.contains(.no) { s.ifFalse = to }
    }
  }

  /** Whether taking a step off loses something worth a second look: its prompt, or arrows to or from it. */
  func deleteNeedsConfirm(_ id: String) -> Bool {
    guard let s = step(id) else { return false }
    // anything the person filled in counts, not just the prompt: what a person sees, the condition or rule, a handoff, the pieces
    let typed = [s.prompt, s.show, s.condition, s.handoffTo, s.reviewBy, s.sendBackTo, s.ifTrue, s.ifFalse]
    if typed.contains(where: { !($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) || s.rule != nil || !(s.handTo ?? []).isEmpty { return true }
    if !s.inputIds.isEmpty || !(s.nexts ?? []).isEmpty || s.next != nil { return true }
    return (steps ?? []).contains { $0.inputIds.contains(id) || ($0.nexts ?? []).contains(id) || $0.next == id || $0.sendBackTo == id || $0.ifTrue == id || $0.ifFalse == id }
  }

  /** Take a step off. Whatever led to it now leads to whatever followed it, and arrows that pointed at it are cleared. */
  func removingStep(_ id: String) -> ChannelTeam {
    guard let gone = step(id) else { return self }
    let before = gone.inputIds
    let after = Self.stepGraph(steps ?? []).outs[id] ?? []
    var team = self
    for a in before { team = team.disconnecting(a, id) }
    for b in after { team = team.disconnecting(id, b) }
    team = team.edit { all in
      all.removeAll { $0.id == id }
      for i in all.indices {
        if all[i].sendBackTo == id { all[i].sendBackTo = nil }
        // cutting the arrows above already cleared an if/else's Yes/No, so read them from before
        let was = self.step(all[i].id) ?? all[i]
        let onward = after.first { $0 != all[i].id }
        // an if/else's arrow to the step now goes to whatever followed it
        if was.ifTrue == id { all[i].ifTrue = onward }
        if was.ifFalse == id { all[i].ifFalse = onward }
      }
    }
    for a in before { for b in after where a != b { team = team.connecting(a, b) } }
    return team
  }

  /**
   * Move a step to sit right after `target` (nil = first). It leaves its place (what led to it now
   * leads to what followed it) and takes `target`'s followers.
   */
  func moving(_ id: String, after target: String?) -> ChannelTeam {
    guard let moved = step(id), target != id else { return self }
    // taking the step off clears the arrows that pointed at it; they are put back once it has moved
    let pointing = (steps ?? []).filter { $0.id != id }.map { ($0.id, $0.sendBackTo == id, $0.ifTrue == id, $0.ifFalse == id) }
    var team = removingStep(id)
    var fresh = moved
    fresh.inputs = []; fresh.nexts = []; fresh.next = nil
    if let target, team.step(target) != nil { team = team.inserting(fresh, after: target) }
    else {
      // first: the steps that started before now wait for it
      let starts = Self.startSteps(team.steps ?? []).map(\.id)
      team = team.appending(fresh)
      for s in starts { team = team.connecting(fresh.id, s) }
    }
    for (owner, back, yes, no) in pointing where team.step(owner) != nil {
      // "send it back to" only makes sense for a step that still comes before the owner
      let before = !Self.stepsAfter(team.steps ?? [], owner).contains(id)
      team = team.updating(owner) { s in
        if back && before { s.sendBackTo = id }
        if yes { s.ifTrue = id }
        if no { s.ifFalse = id }
      }
    }
    return team
  }

  /** The ids of steps in the order a list shows them (for dragging to reorder). */
  var listOrder: [String] { orderedSteps.map(\.id) }

  /** Take agents that no longer exist off the steps and roles. */
  func clearingAgents(except live: Set<String>) -> ChannelTeam {
    var team = self
    team.steps = steps?.map { s in
      var s = s
      if let a = s.agentId, !live.contains(a) { s.agentId = nil }
      return s
    }
    return team
  }
}
