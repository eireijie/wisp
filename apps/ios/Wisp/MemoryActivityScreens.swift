import SwiftUI

/** Who changed what across memory you can see, newest first, a day at a time, optionally one author at a time. */
struct MemoryActivityView: View {
  @Environment(Store.self) private var store
  /** with "view as", only the notes that view can open */
  var visible: Set<String>?
  @State private var changes: [MemoryChange]?
  @State private var author = ""
  @State private var authors: [String] = []
  @State private var error: String?
  @State private var opened: MemoryNote?

  private var shown: [MemoryChange] { (changes ?? []).map { $0.keeping(visible: visible) }.filter { !$0.files.isEmpty } }
  private struct Line: Identifiable { var id: String; var change: MemoryChange; var file: MemoryChange.File }
  private struct Day { var key: Date; var title: String; var lines: [Line] }
  private var days: [Day] {
    let calendar = Calendar.current
    var groups: [Day] = []
    for change in shown {
      let date = Wire.date(change.date) ?? .distantPast
      let day = calendar.startOfDay(for: date)
      let title = calendar.isDateInToday(date) ? "Today" : calendar.isDateInYesterday(date) ? "Yesterday" : date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
      let lines = change.files.map { Line(id: change.hash + $0.path, change: change, file: $0) }
      if let i = groups.firstIndex(where: { $0.key == day }) { groups[i].lines += lines } else { groups.append(Day(key: day, title: title, lines: lines)) }
    }
    return groups
  }
  private var allAuthors: [String] { Array(Set(authors + (author.isEmpty ? [] : [author]))).sorted() }

  var body: some View {
    MemoryScreen(title: "Recent changes", id: "memory-activity", trailing: {
      Menu {
        Picker("Filter by author", selection: $author) {
          Text("Everyone").tag("")
          ForEach(allAuthors, id: \.self) { Text(displayAuthor($0, store: store).name).tag($0) }
        }
      } label: { CircleLabel(symbol: "line.3.horizontal.decrease") }.accessibilityLabel("Filter by author").accessibilityIdentifier("activity-author")
    }) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          FilterChip(title: "Everyone", on: author.isEmpty) { author = "" }
          ForEach(allAuthors, id: \.self) { raw in
            let who = displayAuthor(raw, store: store)
            FilterChip(title: who.name, on: author == raw, leading: who.agent == nil ? nil : AnyView(AuthorAvatar(author: who, size: 20))) { author = raw }
          }
        }
      }
      InlineError(error: error)
      if changes == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
      else if shown.isEmpty { CardCaption("No changes yet.") }
      ForEach(days, id: \.key) { day in
        SectionCaption(day.title)
        CardGroup {
          ForEach(day.lines) { line in row(line, today: day.title == "Today") }
        }
      }
    }
    .navigationDestination(item: $opened) { NoteView(path: $0.path) }
    .refreshable { await load() }
    .task(id: author + String(store.memoryVersion)) { await load() }
  }

  private func row(_ line: Line, today: Bool) -> some View {
    let who = displayAuthor(line.change.author, store: store)
    let deleted = line.file.change == "deleted"
    let name = (line.file.path as NSString).lastPathComponent
    return Button { if !deleted { opened = MemoryNote(path: line.file.path) } } label: {
      HStack(spacing: 12) {
        AuthorAvatar(author: who, size: 40)
        VStack(alignment: .leading, spacing: 2) {
          (Text(who.name).fontWeight(.bold).foregroundStyle(Palette.text) + Text(" \(MemoryChange.verb(line.file.change)) ").foregroundStyle(Palette.text)
            + Text(name).foregroundStyle(deleted ? Palette.muted : Color(light: 0x0A64D6, dark: 0x9EC5FF)))
            .font(.system(size: 15)).multilineTextAlignment(.leading)
          Text(dayTime(line.change.date, today: today)).font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        Spacer(minLength: 0)
      }.padding(.horizontal, 18).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }.buttonStyle(.plain)
  }

  private func dayTime(_ iso: String, today: Bool) -> String {
    guard let date = Wire.date(iso) else { return "" }
    return today ? date.formatted(.relative(presentation: .named)) : date.formatted(date: .omitted, time: .shortened)
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

/** One note's History (every saved version, with Restore) and Who wrote what, two tabs on one page. */
struct NoteHistoryView: View {
  @Environment(Store.self) private var store
  var path: String
  var startOnBlame = false
  /** restoring writes the note, so it needs edit access */
  var canRestore = true
  @State private var tab = 0
  @State private var history: [NoteRevision] = []
  @State private var loaded = false
  @State private var blocks: [BlameBlock]?
  @State private var previewing: NoteRevision?
  @State private var previewText = ""
  @State private var action = FormAction()

  var body: some View {
    MemoryScreen(title: tab == 0 ? "History" : "Who wrote what", id: "note-history") {
      HStack(spacing: 0) { tabButton("History", 0); tabButton("Who wrote what", 1) }.padding(4).background(Capsule().fill(Palette.card))
      Text((path as NSString).lastPathComponent).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 6)
      InlineError(error: action.error)
      if tab == 0 { versions } else { blame }
    }
    .onAppear { if startOnBlame { tab = 1 } }
    .task(id: store.memoryVersion) {
      do { history = try await store.noteHistory(path); loaded = true } catch { action.error = error.localizedDescription }
    }
    .task(id: tab) {
      guard tab == 1, blocks == nil else { return }
      do { blocks = try await store.noteBlame(path) } catch { if !(error is Store.Stale) { action.error = error.localizedDescription } }
    }
  }

  private func tabButton(_ title: String, _ index: Int) -> some View {
    Button { tab = index } label: {
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(tab == index ? Palette.text : Palette.muted).frame(maxWidth: .infinity).frame(height: 44)
        .background(Capsule().fill(tab == index ? Palette.control : Color.clear))
    }.buttonStyle(.plain).accessibilityAddTraits(tab == index ? .isSelected : []).accessibilityIdentifier(index == 0 ? "history-tab" : "blame-tab")
  }

  @ViewBuilder private var versions: some View {
    if !loaded && action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
    CardGroup {
      ForEach(Array(history.enumerated()), id: \.element.id) { index, revision in versionRow(index, revision) }
    }
    CardCaption("Restoring brings back that version as a new change. Nothing is lost.")
    if let revision = previewing {
      SectionCaption("Version from \(relative(revision.date) ?? revision.hash)", trailing: AnyView(Button("Hide") { previewing = nil }.font(.system(size: 13)).buttonStyle(.borderless)))
      VStack(alignment: .leading) { NoteMarkdown(text: NoteView.withoutFrontmatter(previewText)).foregroundStyle(Palette.text) }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    }
  }

  private func versionRow(_ index: Int, _ revision: NoteRevision) -> some View {
    let who = displayAuthor(revision.author ?? "", store: store)
    return HStack(spacing: 12) {
      AuthorAvatar(author: who, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(revision.message ?? revision.hash).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(2)
        Text([who.name, relative(revision.date)].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      Spacer(minLength: 6)
      if index == 0 {
        Text("Current").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)).padding(.horizontal, 14).frame(height: 38).background(Capsule().fill(Color(light: 0xDCE9FF, dark: 0x1F3A66)))
      } else if canRestore {
        Button { restore(revision) } label: { Text("Restore").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 38).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline)) }
          .buttonStyle(.plain).disabled(action.busy).accessibilityIdentifier("restore-version")
      }
    }
    .padding(.horizontal, 18).padding(.vertical, 12).contentShape(Rectangle())
    .onTapGesture { action.run { previewText = try await store.noteAt(path, revision: revision.hash); previewing = revision } }
  }

  private func restore(_ revision: NoteRevision) {
    action.run {
      let text = try await store.noteAt(path, revision: revision.hash)
      try await store.saveNote(path: path, content: text, message: "Restore \((path as NSString).lastPathComponent) from \(relative(revision.date) ?? "an earlier version")")
      previewing = nil
    }
  }

  private static let barColors: [Color] = [Color(hex: 0x5BD68A), Color(hex: 0x7FB6FF), Color(hex: 0xFF8A7A), Color(hex: 0xC08CFF), Color(hex: 0xF2C14B), Color(hex: 0x97A6B4)]

  @ViewBuilder private var blame: some View {
    let shown = BlameBlock.withoutFrontmatter(blocks ?? []).filter { $0.lines.contains { !$0.trimmed.isEmpty } }
    let names = shown.reduce(into: [String]()) { if !$0.contains($1.author) { $0.append($1.author) } }
    if blocks == nil && action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
    else if shown.isEmpty { CardCaption("Not saved yet.") }
    else {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 12) {
          ForEach(names, id: \.self) { raw in
            let who = displayAuthor(raw, store: store)
            HStack(spacing: 6) { AuthorAvatar(author: who, size: 22); Text(who.name).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.muted) }
          }
        }.padding(.horizontal, 6)
      }
      VStack(alignment: .leading, spacing: 0) {
        ForEach(shown) { block in blameRow(block, names) }
      }.background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder)).clipShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    }
  }

  private func blameRow(_ block: BlameBlock, _ names: [String]) -> some View {
    let who = displayAuthor(block.author, store: store)
    let color = Self.barColors[(names.firstIndex(of: block.author) ?? 0) % Self.barColors.count]
    return HStack(alignment: .top, spacing: 10) {
      Rectangle().fill(color).frame(width: 3)
      HStack(spacing: 5) { AuthorAvatar(author: who, size: 18); Text(who.name).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1) }.frame(width: 84, alignment: .leading).padding(.vertical, 12)
      Text(block.lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 15)).foregroundStyle(Palette.text).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
    }.padding(.trailing, 14)
  }
}

/** Who last changed each part of a note: the History page opened on its second tab. */
struct NoteBlameView: View {
  var path: String
  var body: some View { NoteHistoryView(path: path, startOnBlame: true) }
}
