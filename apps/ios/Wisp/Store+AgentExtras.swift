import Foundation

/** Hub calls for an agent's permissions, connections, imports, computer and voice. */
extension Store {
  func agentMemoryAccess(_ id: String) async throws -> AgentMemoryAccess {
    try await fetch { try await $0.get("/api/access/agents/\(id)") }
  }

  /** A token that connects an existing MCP session to this agent. It is shown once. */
  func createAgentToken(_ id: String) async throws -> String {
    struct Result: Decodable { var token: String }
    let result: Result = try await fetch { try await $0.post("/api/agents/\(id)/token", Empty()) }
    return result.token
  }

  func connectedApps(_ agentId: String) async throws -> [ConnectedApp] {
    try await fetch { try await $0.get("/api/agents/\(agentId)/apps") }
  }

  func revokeConnectedApp(agent agentId: String, app appId: String) async throws {
    try await fetch { try await $0.delete("/api/agents/\(agentId)/apps/\(appId)") }
  }

  /** The address other computers should use to reach this hub: its public one if it has one. */
  func shareAddress() async -> String {
    struct Reach: Decodable { var publicUrl: String?; var lan: [String]? }
    let fallback = api?.base.absoluteString ?? ""
    let reach: Reach? = try? await fetch { try await $0.get("/api/reach") }
    let chosen = reach?.publicUrl ?? fallback
    return chosen.hasSuffix("/") ? String(chosen.dropLast()) : chosen
  }

  // MARK: import

  func scannedDevices() async throws -> [ScannedDevice] {
    try await fetch { try await $0.get("/api/nodes") }
  }

  /** Ask every online device of yours to look for saved agent setups; the answers land on the devices a moment later. */
  func scanDevicesForAgents() async throws {
    let devices = try await scannedDevices().filter { $0.usable && $0.online }
    for device in devices {
      _ = try? await fetch { try await $0.raw("POST", "/api/nodes/\(device.id)/discover", body: Empty()) }
    }
  }

  func importAgent(_ fields: Fields) async throws -> Agent {
    let agent: Agent = try await fetch { try await $0.withTimeout(60).post("/api/agents/import", fields) }
    upsertAgent(agent)
    await refreshComputers()
    return agent
  }

  // MARK: computer

  func createComputer(_ fields: Fields) async throws -> Computer {
    let computer: Computer = try await fetch { try await $0.post("/api/computers", fields) }
    await refreshComputers()
    return computer
  }

  // MARK: voice

  func voiceSettings() async throws -> VoiceSettings {
    try await fetch { try await $0.get("/api/voice/settings") }
  }

  /** Speech from the person's own OpenAI or ElevenLabs account, as mp3 audio. */
  func speechAudio(provider: String, voice: String, text: String) async throws -> Data {
    try await fetch { try await $0.withTimeout(60).raw("POST", "/api/voice/audio", body: ["kind": "speak", "provider": provider, "text": text, "voice": voice]) }
  }

  func saveVoice(_ voice: AgentVoice, for agent: Agent) async throws {
    try await updateAgent(agent.id, ["settings": AnyEncodable(["voice": voice])])
  }
}
