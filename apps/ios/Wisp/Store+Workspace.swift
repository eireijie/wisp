import Foundation

extension Store {
  var isOwner: Bool { role == "owner" }
  func refreshTeams() async throws { teams = try await fetch { try await $0.get("/api/teams") } }

  func refreshNodes() async throws { nodes = try await fetch { try await $0.get("/api/nodes") } }
  func updateNode(_ id: String, _ fields: Fields) async throws {
    try await fetch { try await $0.raw("PATCH", "/api/nodes/\(id)", body: fields) }
    try await refreshNodes()
  }
  func refreshDevice(_ id: String) async throws {
    try await fetch { try await $0.post("/api/nodes/\(id)/refresh", Empty()) }
    try await refreshNodes()
  }
  func deleteNode(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/nodes/\(id)") }
    nodes.removeAll { $0.id == id }
  }
  /** Pick what an agent on this device works on. The device's screen is made a computer the first time. */
  func setWorksOn(_ choice: WorksOn, agent: Agent, node: AgentNode) async throws {
    switch choice {
    case .none:
      try await updateAgent(agent.id, ["computerId": .null, "settings": AnyEncodable(["headless": true])])
    case .screen:
      let screen = try await deviceScreen(node.id)
      try await updateAgent(agent.id, ["computerId": AnyEncodable(screen.id)])
    case .newVM:
      let vm: Computer = try await fetch { try await $0.post("/api/computers", NewVM(nodeId: node.id, name: "\(agent.name)'s desk")) }
      var fields: Fields = ["computerId": AnyEncodable(vm.id)]
      // a harness that comes with the VM moves in with it, unless someone already chose where it runs
      if ["claude-code", "codex", "hermes", "kimi"].contains(agent.harness) && agent.settings?.runIn == nil { fields["settings"] = AnyEncodable(["runIn": "computer"]) }
      try await updateAgent(agent.id, fields)
    case .computer(let id):
      try await updateAgent(agent.id, ["computerId": AnyEncodable(id)])
    }
    await refreshComputers()
  }

  /** The device's own screen as a computer, made the first time someone needs it. */
  func deviceScreen(_ nodeId: String) async throws -> Computer {
    if let c = computers.first(where: { $0.kind == "device" && $0.nodeId == nodeId }) { return c }
    let c: Computer = try await fetch { try await $0.post("/api/computers", ["kind": "device", "nodeId": nodeId]) }
    if !computers.contains(where: { $0.id == c.id }) { computers.append(c) }
    return c
  }

  /** Save (or with nil, forget) the remote desktop app its owner reaches this device with. */
  func setRemoteDesktop(_ node: String, _ remote: OwnRemoteDesktop?) async throws {
    try await updateNode(node, ["remoteDesktop": remote.map { AnyEncodable($0) } ?? .null])
  }

  func updateDeviceWisp(_ id: String) async throws {
    try await fetch { try await $0.post("/api/nodes/\(id)/update", Empty()) }
    try await refreshNodes()
  }

  func addDevice(_ name: String) async throws -> String {
    let result: DeviceRegistration = try await fetch { try await $0.post("/api/nodes", ["name": name]) }
    try await refreshNodes()
    return result.token
  }
  func installHarness(_ harness: String, node: String) async throws -> String {
    let result: HarnessInstall = try await fetch { connection in
      var api = connection; api.timeout = 16 * 60 + 10
      return try await api.post("/api/nodes/\(node)/install", ["harness": harness])
    }
    if result.ok == false { throw API.Failure(status: 0, message: result.output ?? "The installer couldn't finish. Check the device and try again.") }
    try await refreshNodes()
    return result.output ?? "Installed."
  }
  func saveProfile(_ fields: Fields) async throws { me = try await fetch { try await $0.patch("/api/me", fields) } }
  func savePrefs(_ fields: Fields) async throws {
    let data = try await fetch { try await $0.put("/api/me/prefs", fields) }
    prefs = try Wire.decoder.decode(Me.Prefs.self, from: data)
    simple = prefs?.experience == "simple"
  }
  func refreshSessions() async throws { sessions = try await fetch { try await $0.get("/api/me/sessions") } }
  func signOutOthers() async throws {
    try await fetch { try await $0.post("/api/me/sessions/sign-out-others", Empty()) }
    sessions.removeAll { $0.current != true }
  }
  func revokeSession(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/me/sessions/\(id)") }
    sessions.removeAll { $0.id == id }
  }
  func changePassword(current: String, next: String) async throws {
    try await fetch { try await $0.post("/api/me/password", ["current": current, "next": next]) }
    sessions.removeAll { $0.current != true }
  }
  func renameWorkspace(_ name: String) async throws { workspace = try await fetch { try await $0.patch("/api/workspace", ["name": name]) } }
  func refreshPeople() async throws {
    members = try await fetch { try await $0.get("/api/members") }
    if isOwner { invites = try await fetch { try await $0.get("/api/invites") } }
  }
  func addPerson(_ fields: Fields) async throws {
    try await fetch { try await $0.post("/api/members", fields) }
    try await refreshPeople()
  }
  func updateMember(_ id: String, role: String) async throws {
    let member: Member = try await fetch { try await $0.patch("/api/members/\(id)", ["role": role]) }
    if let i = members.firstIndex(where: { $0.id == id }) { members[i] = member }
    if id == me?.id { self.role = role }
  }
  func removePerson(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/members/\(id)") }
    members.removeAll { $0.id == id }
  }
  func resetPassword(_ id: String, password: String) async throws { try await fetch { try await $0.post("/api/members/\(id)/password", ["password": password]) } }
  func createInvite(role: String, days: Int) async throws -> WorkspaceInvite {
    let invite: WorkspaceInvite = try await fetch { try await $0.post("/api/invites", ["role": AnyEncodable(role), "days": AnyEncodable(days)]) }
    invites.append(invite)
    return invite
  }
  func revokeInvite(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/invites/\(id)") }
    invites.removeAll { $0.id == id }
  }
  func refreshMemoryStorage() async throws { memoryStorage = try await fetch { try await $0.get("/api/memory/storage") } }
  func saveMemoryStorage(_ path: String) async throws {
    let data = try await fetch { try await $0.put("/api/memory/storage", ["path": AnyEncodable.nullable(path)]) }
    memoryStorage = try Wire.decoder.decode(MemoryStorage.self, from: data)
  }
  func createMemoryToken(_ label: String) async throws -> MemoryToken {
    let token: MemoryToken = try await fetch { try await $0.post("/api/memory/tokens", ["label": label]) }
    try await refreshMemoryStorage()
    return token
  }
  func revokeMemoryToken(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/memory/tokens/\(id)") }
    memoryStorage?.tokens?.removeAll { $0.id == id }
  }
  func refreshAgentPolicy() async throws { agentPolicy = try await fetch { try await $0.get("/api/settings/agents") } }
  func saveAgentPolicy(_ policy: AgentPolicy) async throws {
    let data = try await fetch { try await $0.put("/api/settings/agents", policy) }
    agentPolicy = try Wire.decoder.decode(AgentPolicy.self, from: data)
  }
  func exportData(_ path: String, name: String) async throws -> URL {
    let data = try await fetch { try await $0.raw("GET", path, body: Optional<Empty>.none) }
    let url = FileManager.default.temporaryDirectory.appending(path: name)
    try data.write(to: url, options: .atomic)
    return url
  }
}

private struct NewVM: Encodable {
  var kind = "vm"
  var nodeId: String
  var name: String
  var cpus = 2
  var memoryGb = 4
}
