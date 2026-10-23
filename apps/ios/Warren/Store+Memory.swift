import Foundation

extension Store {
  func refreshNotes() async throws { notes = try await connection().get("/api/vault/notes") }
  func readNote(_ path: String) async throws -> MemoryNote { try await connection().get("/api/vault/note", ["path": path]) }
  func saveNote(path: String, content: String, message: String) async throws {
    try await connection().put("/api/vault/note", ["path": path, "content": content, "message": message])
    memoryVersion += 1
    try await refreshNotes()
  }
  func moveNote(from: String, to: String) async throws {
    try await connection().post("/api/vault/move", ["from": from, "to": to])
    notes.removeAll { $0.path == from }; memoryVersion += 1
    try await refreshNotes()
  }
  func deleteNote(_ path: String) async throws {
    try await connection().raw("DELETE", "/api/vault/note", query: ["path": path], body: Optional<Empty>.none)
    notes.removeAll { $0.path == path }; memoryVersion += 1
  }
  func searchNotes(_ query: String) async throws -> [MemoryNote] { try await connection().get("/api/vault/search", ["q": query, "limit": "30"]) }
  func resolveNote(_ target: String, from: String) async throws -> String {
    let r: NoteResolution = try await connection().get("/api/vault/resolve", ["target": target, "from": from])
    guard let path = r.path else { throw API.Failure(status: 404, message: "That note doesn't exist, or you don't have access to it.") }
    return path
  }
  func noteHistory(_ path: String) async throws -> [NoteRevision] { try await connection().get("/api/vault/history", ["path": path]) }
  func noteAt(_ path: String, revision: String) async throws -> String {
    let note: NoteContent = try await connection().get("/api/vault/at", ["path": path, "rev": revision])
    return note.content
  }
  func refreshProfile(_ user: String = "me") async throws { profiles[user] = try await connection().get("/api/memory/profile", ["user": user]) }
  func remember(_ fields: Fields, user: String = "me") async throws {
    var body = fields; body["about"] = AnyEncodable(user)
    let result: RememberResult = try await connection().post("/api/memory/remember", body)
    try await refreshProfile(user)
    memoryVersion += 1
    if !result.saved { throw API.Failure(status: 409, message: "Already saved: “\(result.similar?.first?.text ?? "this memory")”. Edit that one instead.") }
  }
  func memoryAccess(_ path: String) async throws -> MemoryAccess { try await connection().get("/api/access", ["path": path]) }
  func setMemoryAccess(path: String, subject: MemorySubject, level: String, startup: Bool) async throws {
    try await connection().put("/api/access", ["path": AnyEncodable(path), "subject": AnyEncodable(subject), "level": AnyEncodable(level), "startup": AnyEncodable(startup)])
    memoryVersion += 1
  }
}
