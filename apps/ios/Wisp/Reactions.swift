import SwiftUI

enum ReactionSet {
  static let quick = ["👍", "❤️", "😂", "🎉", "👀"]
  static let more = [
    "👍", "👎", "❤️", "🔥", "🎉", "😂", "😍", "🤔", "😮", "😢", "😅", "🙏", "👏", "🙌", "💯", "✅",
    "❌", "👀", "🚀", "💡", "⭐️", "🤝", "💪", "😎", "🥳", "😴", "🤯", "🙈", "☕️", "🐛", "📌", "⚠️",
  ]
}

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

/** The reactions under a message; tap one to add yours or take it back. */
struct ReactionChips: View {
  @Environment(Store.self) private var store
  var message: Message
  var onError: (String) -> Void

  var body: some View {
    if let reactions = message.reactions, !reactions.isEmpty {
      HStack(spacing: 4) {
        ForEach(reactions, id: \.emoji) { r in
          let mine = r.isMine(store.me?.id)
          Button {
            Task { do { try await store.toggleReaction(message, emoji: r.emoji) } catch { onError(error.localizedDescription) } }
          } label: {
            Text("\(r.emoji) \(r.actors.count)")
              .font(.caption)
              .foregroundStyle(mine ? Color.accentColor : .primary)
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(Capsule().fill(mine ? Color.accentColor.opacity(0.18) : Color(.secondarySystemFill)))
          }
          .buttonStyle(.plain)
          .disabled(!store.canReact(message))
          .accessibilityLabel("\(r.emoji), \(r.actors.count) \(r.actors.count == 1 ? "person" : "people")\(mine ? ", including you" : "")")
          .accessibilityHint(mine ? "Takes your reaction back" : "Adds your reaction")
        }
      }
    }
  }
}

/** Any emoji from a small set, for "More…" in a message's React menu. */
struct EmojiPickerSheet: View {
  @Environment(\.dismiss) private var dismiss
  var onPick: (String) -> Void
  private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 8)

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: columns, spacing: 4) {
          ForEach(ReactionSet.more, id: \.self) { e in
            Button { onPick(e); dismiss() } label: { Text(e).font(.title2).frame(maxWidth: .infinity, minHeight: 44) }
              .buttonStyle(.plain)
              .accessibilityLabel("React \(e)")
          }
        }
        .padding(12)
      }
      .navigationTitle("React")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .presentationDetents([.medium])
  }
}
