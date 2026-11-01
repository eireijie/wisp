import Foundation

extension Store {
  /** Public skills from the hub's store (open-source repos, read at their source). */
  func skillStore() async throws -> SkillStoreList { try await fetch { try await $0.get("/api/skill-store") } }

  /** A store skill's instructions; nil when its license doesn't allow copying it. */
  func skillStoreContent(_ id: String) async throws -> String? {
    let detail: SkillStoreDetail = try await fetch { try await $0.get("/api/skill-store/\(id)") }
    return detail.content
  }

  /** Apps and skills the harnesses on your own devices already have. */
  func deviceShelves() async throws -> [DeviceShelf] { try await fetch { try await $0.get("/api/shelf") } }

  /** Ask a device to look through its harnesses again. */
  func refreshShelf(_ nodeId: String) async throws {
    try await fetch { try await $0.post("/api/shelf/\(nodeId)/refresh", Empty()) }
  }

  /** Give a skill to one helper, or take it away. */
  func setSkillAgent(_ skillId: String, agent agentId: String, on: Bool) async throws {
    let skill: HelperSkill = try await fetch { try await $0.send(on ? "PUT" : "DELETE", "/api/skills/\(skillId)/agents/\(agentId)", body: Optional<Empty>.none) }
    if let i = skills.firstIndex(where: { $0.id == skill.id }) { skills[i] = skill } else { skills.append(skill) }
  }

  /** The harnesses' own skills and commands, for Settings → Skills → Built in (empty on older hubs). */
  func builtInSkills() async throws -> [BuiltInSkill] {
    let list: BuiltInSkillList = try await fetch { try await $0.get("/api/skills/built-in") }
    return list.skills
  }

  /** Who can use a skill: everyone (now and later), or only the agents given; `agentIds` nil keeps the list it has. */
  func setSkillAccess(_ skillId: String, allAgents: Bool, agentIds: [String]? = nil) async throws {
    var fields: Fields = ["allAgents": AnyEncodable(allAgents)]
    if let agentIds { fields["agentIds"] = AnyEncodable(agentIds.sorted()) }
    try await saveSkill(skillId, fields)
  }

  /** On for every agent, including ones made later, or back to the agents ticked. */
  func setConnectorAllAgents(_ connectorId: String, _ on: Bool) async throws {
    try await saveConnector(connectorId, ["allAgents": AnyEncodable(on)])
  }

  /** Settings → Skills → "Learn skills on their own" (kept with the agent policy). */
  func setLearnSkills(_ on: Bool) async throws {
    let previous = agentPolicy
    agentPolicy?.learnSkills = on
    do {
      let data = try await fetch { try await $0.put("/api/settings/agents", ["learnSkills": on]) }
      // an older hub drops the field: keep what was picked
      if var policy = try? Wire.decoder.decode(AgentPolicy.self, from: data) { policy.learnSkills = policy.learnSkills ?? on; agentPolicy = policy }
    } catch {
      agentPolicy = previous
      throw error
    }
  }

  /** A skill from a harness on one of your devices, for these helpers. */
  @discardableResult
  func bringInSkill(_ item: ShelfItem, from nodeId: String, agentIds: [String]) async throws -> HelperSkill {
    try await saveSkill(nil, ["nodeId": AnyEncodable(nodeId), "harness": AnyEncodable(item.harness), "skillId": AnyEncodable(item.skillId), "agentIds": AnyEncodable(agentIds.sorted())])
  }

  /** An app from a harness on one of your devices that needs nothing more from the person. */
  @discardableResult
  func bringInApp(_ item: ShelfItem, from nodeId: String, agentIds: [String]) async throws -> AppConnector {
    let kind = item.transport == "http" ? "mcp-http" : "mcp-stdio"
    let ids = agentIds.filter { id in agent(id).map { ConnectorSupport.allows($0, kind: kind) } ?? true }.sorted()
    var body: Fields = ["kind": AnyEncodable(kind), "name": AnyEncodable(item.name), "catalogId": AnyEncodable(ShelfLogic.appId(nodeId, item)), "agentIds": AnyEncodable(ids)]
    if kind == "mcp-http" { body["url"] = AnyEncodable(item.url ?? "") }
    else { body["command"] = AnyEncodable(item.command ?? ""); body["args"] = AnyEncodable(item.args ?? []); body["env"] = AnyEncodable(item.env ?? [:]) }
    return try await saveConnector(nil, body)
  }
}
