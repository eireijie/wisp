import Foundation

extension Store {
  func refreshRoutines() async throws { routines = try await connection().get("/api/routines") }
  func saveRoutine(_ routine: Routine?, fields: Fields, steps: String) async throws {
    let saved: Routine
    if let routine {
      saved = try await connection().patch("/api/routines/\(routine.id)", fields)
      upsertRoutine(saved)
      try await saveNote(path: routine.notePath, content: steps, message: "Update routine \(saved.name)")
    } else {
      var body = fields; body["steps"] = AnyEncodable(steps)
      saved = try await connection().post("/api/routines", body)
      upsertRoutine(saved)
    }
  }
  private func upsertRoutine(_ routine: Routine) {
    if let i = routines.firstIndex(where: { $0.id == routine.id }) { routines[i] = routine } else { routines.append(routine) }
  }
  func deleteRoutine(_ id: String) async throws {
    try await connection().delete("/api/routines/\(id)")
    routines.removeAll { $0.id == id }
  }
  func runRoutine(_ id: String) async throws -> RoutineRun {
    let result: RoutineRun = try await connection().post("/api/routines/\(id)/run", Empty())
    try await refreshRoutines()
    await refreshChannels()
    return result
  }
  func refreshBackground(_ id: String) async throws { backgrounds[id] = try await connection().get("/api/agents/\(id)/background") }
  func saveBackground(_ id: String, _ fields: Fields) async throws {
    try await connection().put("/api/agents/\(id)/background", fields)
    try await refreshBackground(id)
  }
  func refreshAllowance() async throws { allowance = try await connection().get("/api/background/allowance") }
  func saveAllowance(_ dailyTokens: Int?) async throws {
    let data = try await connection().put("/api/background/allowance", ["dailyTokens": dailyTokens.map(AnyEncodable.init) ?? .null])
    allowance = try Wire.decoder.decode(Allowance.self, from: data)
  }
  func refreshChanges() async throws { changes = try await connection().get("/api/changes") }
  func undoChange(_ id: String) async throws {
    try await connection().post("/api/changes/\(id)/undo", Empty())
    try await refreshChanges()
  }
  func checkBackground(_ id: String) async throws {
    try await connection().post("/api/agents/\(id)/background/check", Empty())
    try await refreshBackground(id)
  }
  func cancelFollowup(_ followup: Followup, agentId: String) async throws {
    try await connection().delete("/api/followups/\(followup.id)")
    try await refreshBackground(agentId)
  }
}
