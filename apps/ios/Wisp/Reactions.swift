import SwiftUI

extension Reaction {
  func isMine(_ userId: String?) -> Bool {
    guard let userId else { return false }
    return actors.contains(Actor(kind: .user, id: userId))
  }
}

extension Store {
  /** Add your reaction, or take it back off if it's already there. */
  func toggleReaction(_ message: Message, emoji: String) async throws {
    struct Body: Encodable { var emoji: String }
    struct Result: Decodable { var reactions: [Reaction] }
    let result: Result = try await fetch { try await $0.post("/api/messages/\(message.id)/reactions", Body(emoji: emoji)) }
    var current = self.message(message.id, in: message.channelId) ?? message
    current.reactions = result.reactions
    replace(current)
  }

  func canReact(_ message: Message) -> Bool {
    message.deletedAt == nil && channels.first { $0.id == message.channelId }?.archivedAt == nil
  }

  // MARK: pins

  /** Pinning is for channels (not chats with one agent), for people who aren't guests. */
  func canPin(_ message: Message) -> Bool {
    guard role != "guest", message.deletedAt == nil, let channel = channels.first(where: { $0.id == message.channelId }) else { return false }
    return channel.kind == "channel" && channel.archivedAt == nil
  }

  func isPinned(_ message: Message) -> Bool {
    channels.first { $0.id == message.channelId }?.pinnedIds?.contains(message.id) == true
  }

  func setPinned(_ message: Message, _ pinned: Bool) async throws {
    if pinned { try await fetch { try await $0.put("/api/messages/\(message.id)/pin", Empty()) } }
    else { try await fetch { try await $0.delete("/api/messages/\(message.id)/pin") } }
    await refreshChannels()
  }
}
