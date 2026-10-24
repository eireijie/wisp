import SwiftUI

struct MemoryView: View {
  @Environment(Store.self) private var store
  var folder = ""
  @State private var query = ""
  @State private var hits: [MemoryNote] = []
  @State private var creating = false
  @State private var action = FormAction()
  private var prefix: String { folder.isEmpty ? "" : folder + "/" }
  private var children: [MemoryNote] { store.notes.filter { $0.path.hasPrefix(prefix) && !$0.path.dropFirst(prefix.count).contains("/") } }
  private var folders: [String] {
    Array(Set(store.notes.filter { $0.path.hasPrefix(prefix) }.compactMap { note in
      let rest = String(note.path.dropFirst(prefix.count))
      return rest.contains("/") ? rest.components(separatedBy: "/").first : nil
    })).sorted()
  }
  var body: some View {
    List {
      InlineError(error: action.error)
      if query.isEmpty {
        ForEach(folders, id: \.self) { name in
          NavigationLink { MemoryView(folder: prefix + name) } label: { Label(folderName(name), systemImage: "folder") }.accessibilityIdentifier("memory-folder")
        }
        ForEach(children) { note in noteLink(note) }
        if store.notes.isEmpty { Text("Your shared memory").font(.headline); Text("Write, read and fix notes right here.").foregroundStyle(.secondary) }
      } else {
        ForEach(hits) { note in noteLink(note) }
        if hits.isEmpty { Text("No matches.").foregroundStyle(.secondary) }
      }
      if !folder.isEmpty { NavigationLink("Who can see and edit what") { MemoryAccessView(path: folder) } }
    }
    .sectionScreen(folder.isEmpty ? "Memory" : folderName((folder as NSString).lastPathComponent), id: "memory")
    .searchable(text: $query, prompt: "Search memory…")
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button("Refresh", systemImage: "arrow.clockwise") { action.run { try await store.connection().post("/api/vault/sync", Empty()); try await store.refreshNotes() } }.disabled(action.busy)
        if store.canManage { Button("New note", systemImage: "square.and.pencil") { creating = true } }
      }
    }
    .sheet(isPresented: $creating) { NoteEditor(folder: folder.isEmpty ? "people/\(store.me?.id ?? "")" : folder) }
    .task(id: store.memoryVersion) { await load() }
    .refreshable { await load() }
    .task(id: query) {
      guard !query.trimmed.isEmpty else { hits = []; return }
      do {
        try await Task.sleep(for: .milliseconds(200))
        let found = try await store.searchNotes(query)
        if !Task.isCancelled { hits = found }
      } catch { if !Task.isCancelled { action.error = error.localizedDescription } }
    }
  }
  private func noteLink(_ note: MemoryNote) -> some View {
    NavigationLink { NoteView(path: note.path) } label: {
      VStack(alignment: .leading, spacing: 4) { Text(note.name); if let snippet = note.snippet { Text(snippet).font(.caption).foregroundStyle(.secondary).lineLimit(3) } }
    }.accessibilityIdentifier("note-row")
  }
  private func folderName(_ name: String) -> String {
    if folder == "agents" { return store.agent(name).map { "@\($0.handle)" } ?? name }
    if folder == "people" { return store.members.first { $0.id == name }?.name ?? name }
    return ["shared": "Shared", "agents": "Agents", "groups": "Groups", "teams": "Teams", "people": "People"][name] ?? name
  }
  private func load() async { do { try await store.refreshNotes() } catch { action.error = error.localizedDescription } }
}

struct NoteView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var path: String
  @State private var note: MemoryNote?
  @State private var editing = false
  @State private var moving = false
  @State private var deleting = false
  @State private var removingNote = false
  @State private var unavailable = false
  @State private var destination: MemoryNote?
  @State private var action = FormAction()
  private var wikiLinks: [String] {
    guard let text = note?.content, let regex = try? NSRegularExpression(pattern: "\\[\\[([^\\]]+)\\]\\]") else { return [] }
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
      Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
  }
  var body: some View {
    List {
      if let note {
        Section { NoteMarkdown(text: note.content ?? "") }
        if !wikiLinks.isEmpty {
          Section("Linked notes") {
            ForEach(Array(Set(wikiLinks)).sorted(), id: \.self) { link in
              Button(link.components(separatedBy: "|").last ?? link) {
                action.run {
                  let target = link.components(separatedBy: "|").first ?? link
                  destination = MemoryNote(path: try await store.resolveNote(target.components(separatedBy: "#").first ?? target, from: path))
                }
              }
            }
          }
        }
        if let backlinks = note.backlinks, !backlinks.isEmpty {
          Section("Backlinks") { ForEach(backlinks, id: \.self) { link in NavigationLink(link) { NoteView(path: link) } } }
        }
        Section {
          if let author = note.editedBy { Text("Edited by \(author)").font(.caption).foregroundStyle(.secondary) }
          NavigationLink("History") { NoteHistoryView(path: path) }
          NavigationLink("Who can see and edit what") { MemoryAccessView(path: path) }
          if note.editable {
            Button("Rename or move") { moving = true }
            Button("Delete note", role: .destructive) { deleting = true }
          }
        }
      } else if unavailable {
        Text("This note isn't available any more").foregroundStyle(.secondary)
      } else if action.error == nil { ProgressView() }
      InlineError(error: action.error)
      if action.error != nil { Button("Try again") { action.run { note = try await store.readNote(path) } } }
    }
    .sectionScreen(note?.name ?? "Note", id: "note")
    .toolbar { if note?.editable == true { Button("Edit") { editing = true }.accessibilityIdentifier("edit-note") } }
    .task(id: NoteLoadID(version: store.memoryVersion, path: path, moving: moving, removing: removingNote, notes: store.notes)) {
      guard !removingNote else { return }
      if (note != nil || unavailable) && !store.notes.contains(where: { $0.path == path }) {
        markUnavailable()
        return
      }
      guard !moving else { return }
      do {
        let loaded = try await store.readNote(path)
        if !Task.isCancelled {
          note = loaded; unavailable = false; action.error = nil
          if !loaded.editable { editing = false }
        }
      } catch {
        guard !Task.isCancelled else { return }
        if let failure = error as? API.Failure, [403, 404].contains(failure.status) { markUnavailable() }
        else { action.error = error.localizedDescription }
      }
    }
    .sheet(isPresented: $editing) { NoteEditor(note: note) }
    .sheet(isPresented: $moving) { MoveNoteView(path: path) { moved in note = nil; unavailable = false; action.error = nil; path = moved } }
    .navigationDestination(item: $destination) { NoteView(path: $0.path) }
    .confirmationDialog("Delete this note? Git history keeps the old version.", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete note", role: .destructive) { action.run {
        removingNote = true
        do { try await store.deleteNote(path); dismiss() }
        catch { removingNote = false; throw error }
      } }
    }
  }

  private func markUnavailable() {
    note = nil
    unavailable = true
    editing = false; moving = false; deleting = false
    action.error = nil
  }
}

private struct NoteLoadID: Equatable {
  var version: Int
  var path: String
  var moving: Bool
  var removing: Bool
  var notes: [MemoryNote]
}

struct NoteEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var note: MemoryNote?
  var folder = "shared"
  @State private var path = ""
  @State private var content = ""
  @State private var message = ""
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: note == nil ? "New note" : "Edit note", action: action, valid: !path.trimmed.isEmpty && !path.trimmed.hasSuffix("/") && content.count <= 2_000_000 && message.count <= 200, save: {
      action.run {
        let target = path.trimmed.hasSuffix(".md") ? path.trimmed : path.trimmed + ".md"
        try await store.saveNote(path: target, content: content, message: message.trimmed.isEmpty ? "\(note == nil ? "Create" : "Edit") \(target)" : message)
        dismiss()
      }
    }) {
      if note == nil { TextField("Path", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled() }
      Section("Note") { TextEditor(text: $content).frame(minHeight: 300).accessibilityLabel("Note content") }
      TechnicalDetails(title: "Commit message") { TextField("Commit message", text: $message) }
    }
    .accessibilityIdentifier("screen-note-edit")
    .onAppear { path = note?.path ?? folder + "/"; content = note?.content ?? "" }
  }
}

struct MoveNoteView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var path: String
  var onMoved: (String) -> Void
  @State private var target = ""
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: "Rename or move", action: action, valid: !target.trimmed.isEmpty && !target.trimmed.hasSuffix("/") && target.trimmed != path, save: {
      action.run { try await store.moveNote(from: path, to: target.trimmed); onMoved(target.trimmed); dismiss() }
    }) { TextField("New path", text: $target).textInputAutocapitalization(.never).autocorrectionDisabled() }
      .onAppear { target = path }
  }
}

struct NoteHistoryView: View {
  @Environment(Store.self) private var store
  var path: String
  @State private var history: [NoteRevision] = []
  @State private var content: String?
  @State private var action = FormAction()
  var body: some View {
    List {
      InlineError(error: action.error)
      if let content { Section("Version") { NoteMarkdown(text: content) } }
      ForEach(history) { revision in
        Button { action.run { content = try await store.noteAt(path, revision: revision.hash) } } label: {
          VStack(alignment: .leading) { Text(revision.message ?? revision.hash); Text(revision.author ?? "").font(.caption).foregroundStyle(.secondary); if let value = revision.date, let date = Wire.date(value) { Text(date, format: .dateTime.year().month().day().hour().minute()).font(.caption).foregroundStyle(.secondary) } }
        }
      }
    }.sectionScreen("History", id: "note-history")
      .task { do { history = try await store.noteHistory(path) } catch { action.error = error.localizedDescription } }
  }
}
