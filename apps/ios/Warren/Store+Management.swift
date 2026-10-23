import Foundation

extension Store {
  var canManage: Bool { role == "owner" || role == "member" }

  func harnessOnDevice(_ agent: Agent) -> Bool {
    guard agent.nodeId != nil else { return false }
    let computer = computers.first { $0.id == agent.computerId }
    let inComputer = agent.settings?.runIn == "computer" && ["claude-code", "codex", "hermes", "kimi"].contains(agent.harness) &&
      computer?.kind == "vm" && computer?.nodeId != nil && computer?.nodeId == agent.nodeId
    return !inComputer
  }

  func connection() throws -> API {
    guard let api else { throw API.Failure(status: 0, message: "Connect to Warren to make changes.") }
    return api
  }

  func isProtected(_ channel: Channel) -> Bool {
    channel.name == "general"
  }

  func refreshManagement() async throws {
    let api = try connection()
    async let sections: [ChannelSection] = api.get("/api/sections")
    async let nodes: [AgentNode] = api.get("/api/nodes")
    async let teams: [WorkspaceTeam] = api.get("/api/teams")
    async let members: [Member] = api.get("/api/members")
    self.sections = try await sections
    self.nodes = try await nodes
    self.teams = try await teams
    self.members = try await members
  }

  func refreshAgents() async throws {
    agents = try await connection().get("/api/agents")
  }

  func refreshSections() async throws {
    sections = try await connection().get("/api/sections")
  }

  func createChannel(_ fields: Fields) async throws -> Channel {
    var channel: Channel = try await connection().post("/api/channels", fields)
    channel.joined = true
    channels.append(channel)
    await refreshChannels()
    return channels.first { $0.id == channel.id } ?? channel
  }

  /**
   * The agents working in a channel right now. With `thread`, those working in it or in a
   * sub-thread under it; `topOnly` keeps just the ones at the top of the channel.
   */
  func working(in channelId: String, thread: String? = nil, topOnly: Bool = false) -> [Agent] {
    agents.filter { a in
      guard a.status == .busy, activityChannel[a.id] == channelId else { return false }
      let here = activityThread[a.id]
      if topOnly { return here == nil }
      guard let thread else { return true }
      return here == thread || (activityPath[a.id] ?? []).contains(thread)
    }
  }

  /** Whether an agent working under `thread` is in a sub-thread of it rather than in it. */
  func inSubThread(_ agentId: String, of thread: String) -> Bool {
    activityThread[agentId] != thread
  }

  /** A thread's root wherever it was loaded: at the top of a channel, as a thread's root, or as a reply. */
  func message(_ id: String, in channelId: String) -> Message? {
    messages[channelId]?.first { $0.id == id } ?? roots[id] ?? threads.values.lazy.compactMap { $0.first { $0.id == id } }.first
  }

  func updateChannel(_ id: String, _ fields: Fields) async throws {
    let updated: Channel = try await connection().patch("/api/channels/\(id)", fields)
    if let i = channels.firstIndex(where: { $0.id == id }) {
      var channel = updated
      channel.joined = channels[i].joined
      channel.unread = channels[i].unread
      channel.notify = channels[i].notify
      channel.starred = channels[i].starred
      channel.memberCount = channels[i].memberCount
      channel.pinnedIds = channels[i].pinnedIds
      channels[i] = channel
    }
    await refreshChannels()
  }

  func deleteChannel(_ id: String) async throws {
    try await connection().delete("/api/channels/\(id)")
    channels.removeAll { $0.id == id }
    messages[id] = nil
  }

  func archiveChannel(_ id: String, archived: Bool) async throws {
    try await connection().post("/api/channels/\(id)/archive", ["archived": archived])
    if let i = channels.firstIndex(where: { $0.id == id }) { channels[i].archivedAt = archived ? Wire.now() : nil }
    await refreshChannels()
  }

  func setChannelPrefs(_ id: String, _ fields: Fields) async throws {
    struct Prefs: Decodable { var notify: String; var starred: Bool }
    let data = try await connection().put("/api/channels/\(id)/prefs", fields)
    let prefs = try Wire.decoder.decode(Prefs.self, from: data)
    if let i = channels.firstIndex(where: { $0.id == id }) {
      channels[i].notify = prefs.notify
      channels[i].starred = prefs.starred
    }
  }

  func joinChannel(_ id: String) async throws {
    try await connection().post("/api/channels/\(id)/join", Empty())
    if let i = channels.firstIndex(where: { $0.id == id }) { channels[i].joined = true }
    await refreshChannels()
  }

  func leaveChannel(_ id: String) async throws {
    try await connection().post("/api/channels/\(id)/leave", Empty())
    if let i = channels.firstIndex(where: { $0.id == id }) { channels[i].joined = false }
    await refreshChannels()
  }

  func readChannel(_ id: String) async throws {
    try await connection().post("/api/channels/\(id)/read", ["at": Wire.now()])
    if let i = channels.firstIndex(where: { $0.id == id }) { channels[i].unread = 0 }
  }

  func channelMembers(_ id: String) async throws -> [ChannelMember] {
    try await connection().get("/api/channels/\(id)/members")
  }

  func addMember(_ actor: Actor, to id: String) async throws {
    try await connection().put("/api/channels/\(id)/members/\(actor.kind.rawValue)/\(actor.id)", Empty())
    await refreshChannels()
  }

  func removeMember(_ actor: Actor, from id: String) async throws {
    try await connection().delete("/api/channels/\(id)/members/\(actor.kind.rawValue)/\(actor.id)")
    await refreshChannels()
  }

  func channelPins(_ id: String) async throws -> [ChannelPin] {
    try await connection().get("/api/channels/\(id)/pins")
  }

  func unpin(_ messageId: String) async throws {
    try await connection().delete("/api/messages/\(messageId)/pin")
    await refreshChannels()
  }

  func createSection(name: String, emoji: String) async throws {
    let section: ChannelSection = try await connection().post("/api/sections", ["name": name, "emoji": emoji])
    if !sections.contains(where: { $0.id == section.id }) { sections.append(section) }
  }

  func updateSection(_ id: String, name: String, emoji: String) async throws {
    let section: ChannelSection = try await connection().patch("/api/sections/\(id)", ["name": name, "emoji": emoji])
    if let i = sections.firstIndex(where: { $0.id == id }) { sections[i] = section }
  }

  func deleteSection(_ id: String) async throws {
    try await connection().delete("/api/sections/\(id)")
    sections.removeAll { $0.id == id }
    for i in channels.indices where channels[i].sectionId == id { channels[i].sectionId = nil }
  }

  func createAgent(_ fields: Fields) async throws -> Agent {
    let agent: Agent = try await connection().post("/api/agents", fields)
    upsertAgent(agent)
    return agent
  }

  @discardableResult
  func updateAgent(_ id: String, _ fields: Fields) async throws -> Agent {
    // Only changed settings are sent; the hub merges them with all other settings.
    let agent: Agent = try await connection().patch("/api/agents/\(id)", fields)
    upsertAgent(agent)
    return agent
  }

  func upsertAgent(_ agent: Agent) {
    if let i = agents.firstIndex(where: { $0.id == agent.id }) { agents[i] = agent }
    else { agents.append(agent) }
  }

  func deleteAgent(_ id: String) async throws {
    try await connection().delete("/api/agents/\(id)")
    agents.removeAll { $0.id == id }
    activity[id] = nil
    activityChannel[id] = nil
    activityThread[id] = nil
    activityPath[id] = nil
    await refreshChannels()
  }

  func agentModels(_ id: String) async throws -> AgentModels {
    try await connection().get("/api/agents/\(id)/models")
  }

  func agentRuns(_ id: String) async throws -> [AgentRun] {
    try await connection().get("/api/agents/\(id)/runs")
  }

  func personality(_ id: String) async throws -> String {
    struct Note: Decodable { var content: String }
    do {
      let note: Note = try await connection().get("/api/vault/note", ["path": "agents/\(id)/SOUL.md"])
      return note.content
    } catch let error as API.Failure where error.status == 404 { return "" }
  }

  func savePersonality(_ agent: Agent, content: String) async throws {
    try await connection().put("/api/vault/note", ["path": "agents/\(agent.id)/SOUL.md", "content": content, "message": "Update soul of @\(agent.handle)"])
  }

  func harnessState(_ id: String) async throws -> HarnessState {
    try await connection().get("/api/agents/\(id)/harness")
  }

  func signInAgent(_ id: String) async throws -> String {
    struct Result: Decodable { var computerId: String }
    let result: Result = try await connection().post("/api/agents/\(id)/signin", Empty())
    await refreshComputers()
    return result.computerId
  }
}
