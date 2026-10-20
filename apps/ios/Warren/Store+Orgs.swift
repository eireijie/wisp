import Foundation

/** Organizations, the features each one has on, and the defaults new agents start from. */
extension Store {
  /** Older hubs have no organizations list: the one you're in is the only one. */
  func refreshOrgs() async {
    guard let api else { return }
    do {
      orgs = try await api.get("/api/orgs")
    } catch let e as API.Failure where e.status == 404 {
      orgs = []
    } catch {}
  }

  /** The organizations to show, with the current one even if the hub can't list them. */
  var orgList: [OrgSummary] {
    if !orgs.isEmpty { return orgs }
    guard let workspace else { return [] }
    return [OrgSummary(id: workspace.id, name: workspace.name, role: role, members: max(1, members.count), agents: agents.count, current: true, unread: false)]
  }

  func isCurrent(_ org: OrgSummary) -> Bool { org.current ?? (org.id == workspace?.id) }

  func createOrg(_ name: String) async throws {
    let created: OrgCreated = try await connection().post("/api/orgs", ["name": name])
    switchSession(token: created.token)
  }

  func switchOrg(_ org: OrgSummary) async throws {
    guard !isCurrent(org) else { return }
    let result: SessionToken = try await connection().post("/api/orgs/\(org.id)/switch", Empty())
    switchSession(token: result.token)
  }

  /** Accepts a whole invite link (…#/join/CODE) or just the code. */
  static func inviteCode(_ text: String) -> String {
    let s = text.trimmed
    if let range = s.range(of: "/join/") {
      return String(s[range.upperBound...].split(whereSeparator: { "/?#&".contains($0) }).first ?? "")
    }
    return s
  }

  func joinOrg(_ link: String) async throws {
    let code = Self.inviteCode(link)
    guard !code.isEmpty else { throw API.Failure(status: 0, message: "Paste an invite link to join.") }
    let result: SessionToken = try await connection().post("/api/invites/join", ["code": code])
    switchSession(token: result.token)
  }

  func refreshFeatures() async {
    guard let api else { return }
    if let result: FeaturesResponse = try? await api.get("/api/features") { features = result.features }
  }

  /** Owners turn features on and off; the hub tells every other device with a "features" event. */
  func setFeatures(_ next: Features) async throws {
    let previous = features
    features = next
    do {
      let data = try await connection().put("/api/features", next)
      if let result = try? Wire.decoder.decode(FeaturesResponse.self, from: data) { features = result.features }
    } catch {
      features = previous
      throw error
    }
  }

  func refreshAgentDefaults() async {
    guard let api else { return }
    do { agentDefaults = try await api.get("/api/settings/agent-defaults") }
    catch let e as API.Failure where e.status == 404 { agentDefaults = nil }
    catch {}
  }

  func saveAgentDefaults(_ next: AgentDefaults) async throws {
    let data = try await connection().put("/api/settings/agent-defaults", next)
    agentDefaults = (try? Wire.decoder.decode(AgentDefaults.self, from: data)) ?? next
  }

  /** "Claude Code · Sonnet 5.5": what a new agent gets when it uses your defaults. */
  var defaultsSummary: (ai: String, computer: String) {
    let d = agentDefaults
    let harness = d?.harness.map(HarnessChoice.label) ?? "Claude Code"
    let ai = d?.model.map { "\(harness) · \($0)" } ?? harness
    let node = d?.nodeId.flatMap { id in nodes.first { $0.id == id }?.name }
    let computer = d?.computer == "none" ? "No computer" : node.map { "Its own VM on \($0)" } ?? "Its own VM"
    return (ai, computer)
  }

  /** Stops what an agent is doing now: its current run if the hub said which, else its latest running one. */
  func stopAgent(_ agentId: String) async throws {
    var runId = activityRun[agentId]
    if runId == nil { runId = try await agentRuns(agentId).first { $0.status == "running" }?.id }
    guard let runId else { throw API.Failure(status: 0, message: "It isn't working on anything right now.") }
    try await connection().post("/api/runs/\(runId)/cancel", Empty())
  }

  /** People's names for "Picked people". */
  var otherPeople: [Member] { members.filter { $0.id != me?.id } }
}
