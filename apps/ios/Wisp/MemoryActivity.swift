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
  var body: some View {
    Group {
      if let agent = author.agent { AgentAvatar(agent: agent, size: 28, showStatus: false) }
      else if let symbol = author.symbol {
        Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 28, height: 28).background(Circle().fill(Color(.tertiarySystemFill)))
      } else { PersonAvatar(name: author.name, size: 28) }
    }
  }
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

/** Who changed what across memory you can see, newest first, optionally one author at a time. */
struct MemoryActivityView: View {
  @Environment(Store.self) private var store
  /** with "view as", only the notes that view can open */
  var visible: Set<String>?
  @State private var changes: [MemoryChange]?
  @State private var author = ""
  @State private var authors: [String] = []
  @State private var error: String?

  private var shown: [MemoryChange] { (changes ?? []).map { $0.keeping(visible: visible) }.filter { !$0.files.isEmpty } }

  var body: some View {
    List {
      InlineError(error: error)
      if changes == nil { ProgressView() }
      else if shown.isEmpty { Text("No changes yet.").foregroundStyle(.secondary) }
      ForEach(shown) { ChangeRow(change: $0) }
    }
    .sectionScreen("Activity", id: "memory-activity")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Picker("Filter by author", selection: $author) {
            Text("Everyone").tag("")
            ForEach(Array(Set(authors + (author.isEmpty ? [] : [author]))).sorted(), id: \.self) { Text(ChangeAuthor.of($0, store: store).name == $0 ? $0 : "\(ChangeAuthor.of($0, store: store).name) (\($0))").tag($0) }
          }
        } label: { Label(author.isEmpty ? "Everyone" : author, systemImage: "line.3.horizontal.decrease.circle") }.accessibilityIdentifier("activity-author")
      }
    }
    .refreshable { await load() }
    .task(id: author + String(store.memoryVersion)) { await load() }
  }

  private func load() async {
    do {
      let found = try await store.vaultChanges(limit: 100, author: author)
      changes = found; error = nil
      // the author list comes from the unfiltered feed, so it doesn't shrink to one name
      if author.isEmpty { authors = Array(Set(found.map(\.author))).sorted() }
    } catch { if !(error is Store.Stale) { self.error = error.localizedDescription }; if changes == nil { changes = [] } }
  }
}

/** Who last changed each part of a note, newest wording first as the hub reports it. */
struct NoteBlameView: View {
  @Environment(Store.self) private var store
  var path: String
  @State private var blocks: [BlameBlock]?
  @State private var error: String?

  private var shown: [BlameBlock] { BlameBlock.withoutFrontmatter(blocks ?? []) }

  var body: some View {
    List {
      InlineError(error: error)
      if blocks == nil && error == nil { ProgressView() }
      else if blocks?.isEmpty == true { Text("Not saved yet.").foregroundStyle(.secondary) }
      ForEach(shown) { block in
        let who = ChangeAuthor.of(block.author, store: store)
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            ChangeAvatar(author: who)
            Text(who.name).font(.subheadline.weight(.semibold))
            if let date = Wire.date(block.date) { Text(date, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.secondary) }
          }
          Text(block.lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)).font(.callout).lineLimit(8).textSelection(.enabled)
        }.padding(.vertical, 2)
      }
    }
    .sectionScreen("Who wrote what", id: "note-blame")
    .task { do { blocks = try await store.noteBlame(path) } catch { if !(error is Store.Stale) { self.error = error.localizedDescription } } }
  }
}
