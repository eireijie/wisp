import Foundation

extension Store {
  func refreshNotes() async throws { notes = try await fetch { try await $0.get("/api/vault/notes") } }
  func readNote(_ path: String) async throws -> MemoryNote { try await fetch { try await $0.get("/api/vault/note", ["path": path]) } }
  func saveNote(path: String, content: String, message: String) async throws {
    try await fetch { try await $0.put("/api/vault/note", ["path": path, "content": content, "message": message]) }
    memoryVersion += 1
    do { try await refreshNotes() } catch { recordSyncError(error) }
  }
  func moveNote(from: String, to: String) async throws {
    try await fetch { try await $0.post("/api/vault/move", ["from": from, "to": to]) }
    notes.removeAll { $0.path == from }; memoryVersion += 1
    do { try await refreshNotes() } catch { recordSyncError(error) }
  }
  func deleteNote(_ path: String) async throws {
    try await fetch { try await $0.raw("DELETE", "/api/vault/note", query: ["path": path], body: Optional<Empty>.none) }
    notes.removeAll { $0.path == path }; memoryVersion += 1
  }
  func searchNotes(_ query: String) async throws -> [MemoryNote] { try await fetch { try await $0.get("/api/vault/search", ["q": query, "limit": "30"]) } }
  func resolveNote(_ target: String, from: String) async throws -> String {
    let r: NoteResolution = try await fetch { try await $0.get("/api/vault/resolve", ["target": target, "from": from]) }
    guard let path = r.path else { throw API.Failure(status: 404, message: "That note doesn't exist, or you don't have access to it.") }
    return path
  }
  func noteHistory(_ path: String) async throws -> [NoteRevision] { try await fetch { try await $0.get("/api/vault/history", ["path": path]) } }
  func noteAt(_ path: String, revision: String) async throws -> String {
    let note: NoteContent = try await fetch { try await $0.get("/api/vault/at", ["path": path, "rev": revision]) }
    return note.content
  }
  func refreshProfile(_ user: String = "me") async throws { profiles[user] = try await fetch { try await $0.get("/api/memory/profile", ["user": user]) } }
  func remember(_ fields: Fields, user: String = "me") async throws {
    var body = fields; body["about"] = AnyEncodable(user)
    let result: RememberResult = try await fetch { try await $0.post("/api/memory/remember", body) }
    if !result.saved { throw API.Failure(status: 409, message: "Already saved: “\(result.similar?.first?.text ?? "this memory")”. Edit that one instead.") }
    memoryVersion += 1
    do { try await refreshProfile(user) } catch { recordSyncError(error) }
  }
  func memoryAccess(_ path: String) async throws -> MemoryAccess { try await fetch { try await $0.get("/api/access", ["path": path]) } }
  func setMemoryAccess(path: String, subject: MemorySubject, level: String, startup: Bool) async throws {
    try await fetch { try await $0.put("/api/access", ["path": AnyEncodable(path), "subject": AnyEncodable(subject), "level": AnyEncodable(level), "startup": AnyEncodable(startup)]) }
    memoryVersion += 1
  }
}
