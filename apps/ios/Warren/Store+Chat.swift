import Foundation

extension Store {
  // MARK: editing and deleting

  /** Fix your own message. Agents that were asked aren't asked again. */
  func editMessage(_ message: Message, body: String) async throws {
    struct Body: Encodable { var body: String }
    let updated: Message = try await fetch { try await $0.patch("/api/messages/\(message.id)", Body(body: body)) }
    replace(updated)
  }

  /** Delete your own message (or anyone's, as an owner). A thread root with replies stays as "deleted" so they're still readable. */
  func deleteMessage(_ message: Message) async throws {
    struct Result: Decodable { var kept: Bool? }
    let result: Result = try await fetch { try await $0.send("DELETE", "/api/messages/\(message.id)", body: Optional<Empty>.none) }
    if result.kept == true {
      var blank = message
      blank.body = ""
      blank.parts = []
      blank.reactions = []
      blank.deletedAt = Wire.now()
      replace(blank)
    } else {
      remove(message.id, channel: message.channelId, thread: message.threadId)
    }
  }

  func canEdit(_ message: Message) -> Bool {
    message.deletedAt == nil && message.author == Actor(kind: .user, id: me?.id ?? "") && writable(message.channelId)
  }

  func canDelete(_ message: Message) -> Bool {
    message.deletedAt == nil && (message.author == Actor(kind: .user, id: me?.id ?? "") || role == "owner") && writable(message.channelId)
  }

  private func writable(_ channelId: String) -> Bool {
    channels.first { $0.id == channelId }?.archivedAt == nil
  }

  // MARK: discussions

  func loadDiscussion(_ id: String) async {
    if let d: Discussion = try? await fetch({ try await $0.get("/api/discussions/\(id)") }) { discussions[id] = d }
  }

  func stopDiscussion(_ id: String) async throws {
    try await fetch { try await $0.post("/api/discussions/\(id)/cancel", Empty()) }
    await loadDiscussion(id)
  }
}
