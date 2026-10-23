import Foundation

extension Store {
  var isOwner: Bool { role == "owner" }
  func refreshTeams() async throws { teams = try await connection().get("/api/teams") }

  func refreshNodes() async throws { nodes = try await connection().get("/api/nodes") }
  func updateNode(_ id: String, _ fields: Fields) async throws {
    try await connection().raw("PATCH", "/api/nodes/\(id)", body: fields)
    try await refreshNodes()
  }
  func refreshDevice(_ id: String) async throws {
    try await connection().post("/api/nodes/\(id)/refresh", Empty())
    try await refreshNodes()
  }
  func deleteNode(_ id: String) async throws {
    try await connection().delete("/api/nodes/\(id)")
    nodes.removeAll { $0.id == id }
  }
  func addDevice(_ name: String) async throws -> String {
    let result: DeviceRegistration = try await connection().post("/api/nodes", ["name": name])
    try await refreshNodes()
    return result.token
  }
  func installHarness(_ harness: String, node: String) async throws -> String {
    var api = try connection(); api.timeout = 16 * 60 + 10
    let result: HarnessInstall = try await api.post("/api/nodes/\(node)/install", ["harness": harness])
    if result.ok == false { throw API.Failure(status: 0, message: result.output ?? "The installer couldn't finish. Check the device and try again.") }
    try await refreshNodes()
    return result.output ?? "Installed."
  }
  func saveProfile(_ fields: Fields) async throws { me = try await connection().patch("/api/me", fields) }
  func savePrefs(_ fields: Fields) async throws {
    let data = try await connection().put("/api/me/prefs", fields)
    prefs = try Wire.decoder.decode(Me.Prefs.self, from: data)
    simple = prefs?.experience == "simple"
  }
  func refreshSessions() async throws { sessions = try await connection().get("/api/me/sessions") }
  func signOutOthers() async throws {
    try await connection().post("/api/me/sessions/sign-out-others", Empty())
    sessions.removeAll { $0.current != true }
  }
  func revokeSession(_ id: String) async throws {
    try await connection().delete("/api/me/sessions/\(id)")
    sessions.removeAll { $0.id == id }
  }
  func changePassword(current: String, next: String) async throws {
    try await connection().post("/api/me/password", ["current": current, "next": next])
    sessions.removeAll { $0.current != true }
  }
  func renameWorkspace(_ name: String) async throws { workspace = try await connection().patch("/api/workspace", ["name": name]) }
  func refreshPeople() async throws {
    members = try await connection().get("/api/members")
    if isOwner { invites = try await connection().get("/api/invites") }
  }
  func addPerson(_ fields: Fields) async throws {
    try await connection().post("/api/members", fields)
    try await refreshPeople()
  }
  func updateMember(_ id: String, role: String) async throws {
    let member: Member = try await connection().patch("/api/members/\(id)", ["role": role])
    if let i = members.firstIndex(where: { $0.id == id }) { members[i] = member }
    if id == me?.id { self.role = role }
  }
  func removePerson(_ id: String) async throws {
    try await connection().delete("/api/members/\(id)")
    members.removeAll { $0.id == id }
  }
  func resetPassword(_ id: String, password: String) async throws { try await connection().post("/api/members/\(id)/password", ["password": password]) }
  func createInvite(role: String, days: Int) async throws -> WorkspaceInvite {
    let invite: WorkspaceInvite = try await connection().post("/api/invites", ["role": AnyEncodable(role), "days": AnyEncodable(days)])
    invites.append(invite)
    return invite
  }
  func revokeInvite(_ id: String) async throws {
    try await connection().delete("/api/invites/\(id)")
    invites.removeAll { $0.id == id }
  }
  func refreshMemoryStorage() async throws { memoryStorage = try await connection().get("/api/memory/storage") }
  func saveMemoryStorage(_ path: String) async throws {
    let data = try await connection().put("/api/memory/storage", ["path": AnyEncodable.nullable(path)])
    memoryStorage = try Wire.decoder.decode(MemoryStorage.self, from: data)
  }
  func createMemoryToken(_ label: String) async throws -> MemoryToken {
    let token: MemoryToken = try await connection().post("/api/memory/tokens", ["label": label])
    try await refreshMemoryStorage()
    return token
  }
  func revokeMemoryToken(_ id: String) async throws {
    try await connection().delete("/api/memory/tokens/\(id)")
    memoryStorage?.tokens?.removeAll { $0.id == id }
  }
  func refreshAgentPolicy() async throws { agentPolicy = try await connection().get("/api/settings/agents") }
  func saveAgentPolicy(_ policy: AgentPolicy) async throws {
    let data = try await connection().put("/api/settings/agents", policy)
    agentPolicy = try Wire.decoder.decode(AgentPolicy.self, from: data)
  }
  func exportData(_ path: String, name: String) async throws -> URL {
    let data = try await connection().raw("GET", path, body: Optional<Empty>.none)
    let url = FileManager.default.temporaryDirectory.appending(path: name)
    try data.write(to: url, options: .atomic)
    return url
  }
}
