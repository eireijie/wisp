import Foundation

// MARK: templates

/** A ready-made team: its roles (unfilled), how its steps work together, and a sample of how it sounds (TeamTemplate). */
struct TeamTemplate: Codable, Hashable, Identifiable {
  struct Line: Codable, Hashable { var who: String; var text: String }
  var id: String
  var name: String
  var blurb: String
  var roles: [ChannelTeam.Role]
  var steps: [ChannelTeam.Step]
  /** a short example conversation: who says it (a role's name, or "You") and what */
  var sample: [Line]?

  init(id: String, name: String, blurb: String, roles: [ChannelTeam.Role], steps: [ChannelTeam.Step], sample: [Line]? = nil) {
    self.id = id; self.name = name; self.blurb = blurb; self.roles = roles; self.sample = sample
    self.steps = ChannelTeam.normalizeSteps(steps.map { s in
      var s = s
      if s.prompt == nil { s.prompt = roles.first { $0.id == s.roleId }?.description }
      if s.harness == nil { s.harness = roles.first { $0.id == s.roleId }?.harness }
      return s
    })
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name),
      blurb: (try? c.decode(String.self, forKey: .blurb)) ?? "",
      roles: (try? c.decode([ChannelTeam.Role].self, forKey: .roles)) ?? [],
      steps: (try? c.decode([ChannelTeam.Step].self, forKey: .steps)) ?? [],
      sample: try? c.decodeIfPresent([Line].self, forKey: .sample))
  }

  /** The template's steps as a team to edit: roles only where a split-the-work step needs them. */
  func team(agents: [Agent], base: ChannelTeam? = nil) -> ChannelTeam {
    let kept = Set(steps.flatMap { s in s.kind == .handOut ? (s.handTo ?? []) + (s.reviewBy.map { [$0] } ?? []) : [] })
    var used = Set<String>()
    var index = 0
    func pick(harness: String?) -> String? {
      defer { index += 1 }
      let found = agents.first { $0.harness == harness && !used.contains($0.id) } ?? agents.first { $0.harness == harness }
        ?? agents.first { !used.contains($0.id) } ?? (agents.isEmpty ? nil : agents[index % agents.count])
      if let found { used.insert(found.id) }
      return found?.id
    }
    var team = base ?? .empty
    team.nodes = []; team.edges = []
    team.roles = roles.filter { kept.contains($0.id) }.map { r in
      var r = r
      r.agentId = pick(harness: r.harness)
      return r
    }
    team.steps = ChannelTeam.layoutSteps(steps.map { s in
      var s = s
      s.roleId = ""
      s.agentId = s.needsAgent ? pick(harness: s.harness) : nil
      return s
    })
    return team.withChart
  }

  /** the template's shape as lines of text for a card: "Lead plans" style titles of its steps in order */
  var order: [ChannelTeam.Step] { ChannelTeam.stepOrder(steps) }

  /** The name a role has in this template (the sample conversation says who talks by role name). */
  func roleName(of step: ChannelTeam.Step) -> String? { roles.first { $0.id == step.roleId }?.name }

  static let builtIn: [TeamTemplate] = {
    (try? JSONDecoder().decode([TeamTemplate].self, from: Data(TeamTemplateData.json.utf8))) ?? []
  }()

  /** A team's steps as a template someone else can start from: who filled them is left out. */
  static func from(_ team: ChannelTeam, name: String, blurb: String = "") -> TeamTemplate {
    var roles = team.roles ?? []
    for i in roles.indices { roles[i].agentId = nil }
    let steps = (team.steps ?? []).map { s -> ChannelTeam.Step in
      var s = s
      s.agentId = nil; s.x = 0; s.y = 0
      if s.kind == .handoff { s.handoffTo = nil }
      return s
    }
    return TeamTemplate(id: "own-\(name.lowercased())", name: name, blurb: blurb, roles: roles, steps: steps)
  }
}

// MARK: a request going through the steps

/** One request going through a stepped team (TeamFlow in packages/core): what the strip needs. */
struct TeamFlow: Decodable, Identifiable, Hashable {
  struct Done: Decodable, Hashable { var stepId: String; var verdict: String? }
  struct Waiting: Decodable, Hashable { var why: String; var options: String; var piece: String? }
  /** One step's run in a request: steps that run together each have their own. */
  struct Lane: Decodable, Hashable {
    var stepId: String
    /** running, waiting, done or skipped (an if/else went the other way) */
    var status: String
    var waitingFor: Waiting?
    /** ask-me: the Inbox card */
    var approvalId: String?
  }
  var id: String
  var channelId: String
  var threadId: String
  /** running, waiting (a person has to decide), done or failed */
  var status: String
  var stepId: String
  var rounds: [String: Int]
  var history: [Done]
  var waitingFor: Waiting?
  var lanes: [String: Lane]?

  /** steps that finished (done or approved) */
  var doneSteps: Set<String> { Set(history.filter { $0.verdict == "done" || $0.verdict == "approved" }.map(\.stepId)) }

  /** Every step that has started, newest first isn't needed: by step id. An older request without lanes gets one made from where it is. */
  var allLanes: [String: Lane] {
    if let lanes, !lanes.isEmpty { return lanes }
    var out: [String: Lane] = [:]
    for id in doneSteps { out[id] = Lane(stepId: id, status: "done") }
    if status == "running" || status == "waiting" { out[stepId] = Lane(stepId: stepId, status: status, waitingFor: waitingFor) }
    return out
  }

  /** the lanes that wait for a person */
  var waitingLanes: [Lane] { allLanes.values.filter { $0.status == "waiting" && $0.waitingFor != nil } }
}

extension TeamFlow.Lane {
  init(stepId: String, status: String, waitingFor: TeamFlow.Waiting? = nil) {
    self.stepId = stepId; self.status = status; self.waitingFor = waitingFor; self.approvalId = nil
  }
}

/** A flowchart an agent drew from a sentence, before anyone creates it (TeamDraft). */
struct TeamDraft: Decodable, Identifiable, Hashable {
  var id: String
  /** working, ready or failed */
  var status: String
  var name: String?
  var steps: [ChannelTeam.Step]?
  var lines: [FlowLine]?
  var problem: String?
}

extension Store {
  func flows(in channelId: String) async throws -> [TeamFlow] {
    try await fetch { try await $0.get("/api/channels/\(channelId)/flows") }
  }
  /** approve, retry or stop a request that's waiting on a person; `stepId` says which of the steps running together */
  func decideFlow(_ id: String, _ action: String, stepId: String? = nil, note: String? = nil) async throws -> TeamFlow {
    var body: Fields = ["action": AnyEncodable(action)]
    if let stepId { body["stepId"] = AnyEncodable(stepId) }
    if let note, !note.isEmpty { body["note"] = AnyEncodable(note) }
    return try await fetch { try await $0.post("/api/flows/\(id)/decide", body) }
  }
  /** start a team's schedule now */
  func runSchedule(channelId: String, stepId: String) async throws {
    let _: TeamFlow = try await fetch { try await $0.post("/api/channels/\(channelId)/schedules/\(stepId)/run", Empty()) }
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
  /** an agent starts drawing a team from a sentence */
  func startTeamDraft(_ description: String, agentId: String?) async throws -> TeamDraft {
    var body: Fields = ["description": AnyEncodable(description)]
    if let agentId { body["agentId"] = AnyEncodable(agentId) }
    return try await fetch { try await $0.post("/api/team-drafts", body) }
  }
  func teamDraft(_ id: String) async throws -> TeamDraft {
    try await fetch { try await $0.get("/api/team-drafts/\(id)") }
  }
  /** the workspace's lead right now, fresh from the hub */
  func currentLead() async throws -> String? {
    let lead: WorkspaceLead = try await fetch { try await $0.get("/api/settings/lead") }
    return lead.lead
  }
}
