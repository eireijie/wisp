import SwiftUI

/** Who made a change: an agent (by its @handle), Obsidian, Wisp itself, or a person. */
struct ChangeAuthor {
  var name: String
  var kind: String?
  var agent: Agent?
  var symbol: String?

  @MainActor static func of(_ author: String, store: Store) -> ChangeAuthor {
    if author.hasPrefix("@"), let agent = store.agents.first(where: { "@\($0.handle)" == author }) {
      return ChangeAuthor(name: agent.name, kind: "agent", agent: agent)
    }
    if author == "Edited in Obsidian" { return ChangeAuthor(name: "Obsidian", kind: "on disk", symbol: "pencil.line") }
    if author == "Wisp" || author == "Warren" { return ChangeAuthor(name: "Wisp", symbol: "sparkle") }
    return ChangeAuthor(name: author, kind: "person")
  }
}

struct ChangeAvatar: View {
  var author: ChangeAuthor
  var body: some View { AuthorAvatar(author: author, size: 28) }
}

func noteTitle(_ path: String) -> String {
  let name = (path as NSString).lastPathComponent
  return name.lowercased().hasSuffix(".md") ? String(name.dropLast(3)) : name
}

/** One saved change: who, when, and the notes it touched. */
struct ChangeRow: View {
  @Environment(Store.self) private var store
  var change: MemoryChange
  /** the short version for the Memory home: three notes at most, no commit message */
  var compact = false
  @State private var opened: MemoryNote?

  var body: some View {
    let who = ChangeAuthor.of(change.author, store: store)
    let limit = compact ? 3 : change.files.count
    HStack(alignment: .top, spacing: 12) {
      ChangeAvatar(author: who).padding(.top, 2)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(who.name).font(.subheadline.weight(.semibold)).lineLimit(1)
          if let kind = who.kind { Text(kind).font(.caption2).foregroundStyle(.tertiary) }
          Spacer(minLength: 4)
          if let date = Wire.date(change.date) { Text(date, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary) }
        }
        if !compact, let message = change.message, !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        ForEach(Array(change.files.prefix(limit).enumerated()), id: \.offset) { _, file in
          HStack(spacing: 4) {
            Text(MemoryChange.verb(file.change)).foregroundStyle(.secondary)
            if file.change == "deleted" { Text(noteTitle(file.path)).strikethrough().foregroundStyle(.secondary) }
            else { Button(noteTitle(file.path)) { opened = MemoryNote(path: file.path) }.buttonStyle(.borderless) }
          }.font(.subheadline).lineLimit(1)
        }
        if change.files.count > limit { Text("+\(change.files.count - limit) more").font(.caption).foregroundStyle(.tertiary) }
      }
    }
    .navigationDestination(item: $opened) { NoteView(path: $0.path) }
    .accessibilityElement(children: .contain)
  }
}

