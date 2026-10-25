import Foundation

/** Settings that talk to the hub beyond the basics: asking an agent, the lead, joining, reach, apps and harnesses. */
extension Store {
  // MARK: Ask an agent

  /** Sends `text` to `agent` in your chat with it and opens that chat, so you watch it answer. */
  func ask(_ agent: Agent, _ text: String) async throws {
    let channel = try await dm(with: agent)
    try await send(text, in: channel.id)
    route = .chat(channelId: channel.id, threadId: nil)
  }

  /** The agent "ask an agent" starts with: one that's up, else the first. */
  var defaultAsker: Agent? { agents.first { $0.status != .offline } ?? agents.first }

  // MARK: Lead

  func saveLead(_ agentId: String?) async throws {
    let data = try await fetch { try await $0.put("/api/settings/lead", ["leadId": agentId.map(AnyEncodable.init) ?? .null]) }
    let lead = try Wire.decoder.decode(WorkspaceLead.self, from: data)
    taskLead = lead.lead
    taskLeadOverride = lead.leadId
  }

  // MARK: Computers asking to join

  func refreshJoinRequests() async throws {
    guard isOwner else { joinRequests = []; return }
    joinRequests = try await fetch { try await $0.get("/api/join/requests") }
  }

  func decideJoin(_ request: JoinRequest, approve: Bool) async throws {
    do {
      try await fetch { try await $0.post("/api/join/requests/\(request.id)/\(approve ? "approve" : "deny")", Empty()) }
    } catch let failure as API.Failure where failure.status == 404 {
      joinRequests.removeAll { $0.id == request.id }
      throw API.Failure(status: 404, message: "This request has ended.")
    }
    joinRequests.removeAll { $0.id == request.id }
    if approve { try? await refreshNodes() }
  }

  /** "join_request" and "join_request_done" from the hub's live connection (owners only get them). */
  func handleJoinEvent(_ type: String, _ data: Data) {
    guard isOwner else { return }
    if type == "join_request" {
      struct Added: Decodable { var request: JoinRequest }
      guard let added = try? Wire.decoder.decode(Added.self, from: data), added.request.code.count == 6 else { return }
      joinRequests.removeAll { $0.id == added.request.id }
      joinRequests.append(added.request)
    } else {
      struct Done: Decodable { var id: String }
      guard let done = try? Wire.decoder.decode(Done.self, from: data) else { return }
      joinRequests.removeAll { $0.id == done.id }
    }
  }

  func makeJoinInvite() async throws -> JoinInvite {
    try await fetch { try await $0.post("/api/join/invites", Empty()) }
  }

  // MARK: Reach and connected apps

  func reach(fresh: Bool = false) async throws -> ReachInfo {
    try await fetch { try await $0.get("/api/reach", fresh ? ["fresh": "1"] : [:]) }
  }
  func tailscale(_ action: String) async throws -> ReachInfo {
    try await fetch { try await $0.post("/api/reach/tailscale", ["action": action]) }
  }
  func startCloudflare(token: String) async throws -> ReachInfo {
    try await fetch { try await $0.post("/api/reach/cloudflare", ["action": "start", "token": token]) }
  }
  func stopCloudflare() async throws -> ReachInfo {
    try await fetch { try await $0.post("/api/reach/cloudflare", ["action": "stop"]) }
  }
  /** nil on a hub that doesn't list connected apps yet */
  func mcpClients() async throws -> [McpClient]? {
    do { return try await fetch { try await $0.get("/api/mcp/clients") } }
    catch let failure as API.Failure where failure.status == 404 { return nil }
  }
  func disconnectMcp(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/mcp/clients/\(id)") }
  }

  // MARK: Harness settings

  func harnessSettings(device: String, harness: String? = nil, account: String? = nil) async throws -> HarnessesResponse {
    var query: [String: String] = [:]
    if let harness, let account { query = ["harness": harness, "account": account] }
    return try await fetch { try await $0.get("/api/nodes/\(device)/harness-settings", query) }
  }
  func changeHarness(device: String, harness: String, account: String, _ changes: [HarnessChange]) async throws -> HarnessSettings {
    struct Body: Encodable { var changes: [HarnessChange]; var account: String }
    return try await fetch { try await $0.patch("/api/nodes/\(device)/harness-settings/\(harness)", Body(changes: changes, account: account)) }
  }
  /** Account actions (add, rename, remove, assign, sign in); the reply differs by action. */
  @discardableResult
  func harnessAccount(device: String, harness: String, _ body: Fields) async throws -> Data {
    let data: Data = try await fetch { try await $0.raw("POST", "/api/nodes/\(device)/harness-accounts/\(harness)", body: body) }
    return data
  }
  func harnessSkill(device: String, harness: String, account: String, id: String) async throws -> HarnessSkillFile {
    let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    return try await fetch { try await $0.get("/api/nodes/\(device)/harness-settings/\(harness)/skills/\(escaped)", ["account": account]) }
  }
  /** Give every agent in `agentIds` an app set up in Wisp, or take it away. */
  func attachConnector(_ connector: AppConnector, agentIds: [String], on: Bool) async throws {
    for agent in agentIds {
      if on { try await fetch { try await $0.put("/api/connectors/\(connector.id)/agents/\(agent)", Empty()) } }
      else { try await fetch { try await $0.delete("/api/connectors/\(connector.id)/agents/\(agent)") } }
    }
    try await refreshConnectors()
  }
}
