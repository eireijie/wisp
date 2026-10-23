import Foundation

extension Store {
  func refreshSkills() async throws { skills = try await connection().get("/api/skills") }
  @discardableResult
  func saveSkill(_ id: String?, _ fields: Fields) async throws -> HelperSkill {
    let skill: HelperSkill = try await connection().send(id == nil ? "POST" : "PATCH", id.map { "/api/skills/\($0)" } ?? "/api/skills", body: fields)
    if let i = skills.firstIndex(where: { $0.id == skill.id }) { skills[i] = skill } else { skills.append(skill) }
    return skill
  }
  func deleteSkill(_ id: String) async throws {
    try await connection().delete("/api/skills/\(id)")
    skills.removeAll { $0.id == id }
  }
  func refreshConnectors() async throws { connectors = try await connection().get("/api/connectors") }
  @discardableResult
  func saveConnector(_ id: String?, _ fields: Fields) async throws -> AppConnector {
    let connector: AppConnector = try await connection().send(id == nil ? "POST" : "PATCH", id.map { "/api/connectors/\($0)" } ?? "/api/connectors", body: fields)
    upsertConnector(connector)
    return connector
  }
  private func upsertConnector(_ connector: AppConnector) {
    if let i = connectors.firstIndex(where: { $0.id == connector.id }) { connectors[i] = connector } else { connectors.append(connector) }
  }
  func deleteConnector(_ id: String) async throws {
    try await connection().delete("/api/connectors/\(id)")
    connectors.removeAll { $0.id == id }
  }
  func connectorSignIn(_ id: String) async throws -> URL? {
    let api = try connection()
    let result: ConnectorSignIn = try await api.post("/api/connectors/\(id)/signin", ["origin": api.base.absoluteString])
    if let address = result.url {
      guard let url = URL(string: address), ["https", "http"].contains(url.scheme ?? "") else { throw API.Failure(status: 0, message: "The app returned an invalid sign-in address.") }
      return url
    }
    try await refreshConnectors()
    return nil
  }
  func connectorSignOut(_ id: String) async throws {
    let connector: AppConnector = try await connection().post("/api/connectors/\(id)/signout", Empty())
    upsertConnector(connector)
  }
  func marketplace(_ query: String) async throws -> [MarketplaceEntry] {
    let page: Marketplace = try await connection().get("/api/marketplace", ["q": query])
    return page.entries
  }
}
