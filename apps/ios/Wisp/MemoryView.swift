import SwiftUI

/** A folder: its folders, then its notes. */
struct MemoryFolderView: View {
  @Environment(Store.self) private var store
  var folder = ""
  /** "agent:<id>" while an owner views memory as that agent */
  var viewAs: String?
  @State private var asNotes: [MemoryNote]?
  @State private var created: MemoryNote?
  @State private var query = ""
  @State private var hits: [MemoryNote] = []
  @State private var creating = false
  @State private var sharing = false
  @State private var action = FormAction()
  private var prefix: String { folder.isEmpty ? "" : folder + "/" }
  private var allNotes: [MemoryNote] { viewAs == nil ? store.notes : asNotes ?? [] }
  private var children: [MemoryNote] { allNotes.filter { $0.path.hasPrefix(prefix) && !$0.path.dropFirst(prefix.count).contains("/") } }
  private var folders: [String] {
    Array(Set(allNotes.filter { $0.path.hasPrefix(prefix) }.compactMap { note in
      let rest = String(note.path.dropFirst(prefix.count))
      return rest.contains("/") ? rest.components(separatedBy: "/").first : nil
    })).sorted()
  }
  private var title: String { folder.isEmpty ? "Memory" : folderName((folder as NSString).lastPathComponent, in: (folder as NSString).deletingLastPathComponent) }
  private var crumbs: [String] {
    let parts = folder.components(separatedBy: "/").filter { !$0.isEmpty }
    return ["Memory"] + parts.enumerated().map { i, seg in store.folderLabel(seg, parent: i > 0 ? parts[i - 1] : "") }
  }

  var body: some View {
    MemoryScreen(title: title, id: "memory-folder", trailing: {
      MoreCircle {
        Button("Refresh", systemImage: "arrow.clockwise") { action.run { try await store.connection().post("/api/vault/sync", Empty()); await load() } }
        if !folder.isEmpty { Button("Who can see this folder", systemImage: "lock") { sharing = true } }
      }
    }) {
      HStack(spacing: 6) {
        ForEach(Array(crumbs.enumerated()), id: \.offset) { i, c in
          if i > 0 { Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.faint) }
          Text(c).foregroundStyle(i == crumbs.count - 1 ? Palette.text : Palette.faint).fontWeight(i == crumbs.count - 1 ? .semibold : .regular)
        }
      }.font(.system(size: 15)).lineLimit(1).padding(.horizontal, 6)
      InlineError(error: action.error)
      MemorySearchField(prompt: "Search this folder…", text: $query)
      if query.trimmed.isEmpty {
        if !folders.isEmpty {
          SectionCaption("Folders")
          CardGroup {
            ForEach(folders, id: \.self) { name in
              NavigationLink { MemoryFolderView(folder: prefix + name, viewAs: viewAs) } label: {
                RowLabel(title: folderName(name, in: folder), value: String(allNotes.filter { $0.path.hasPrefix(prefix + name + "/") }.count)) { Image(systemName: "folder").font(.system(size: 18)).foregroundStyle(Palette.muted) }
              }.buttonStyle(.plain).accessibilityIdentifier("memory-folder")
            }
          }
        }
        if !children.isEmpty {
          SectionCaption("Notes")
          CardGroup { ForEach(children) { noteRow($0) } }
        }
        if allNotes.isEmpty { CardCaption("Write, read and fix notes right here.") }
      } else {
        let found = hits.filter { hit in hit.path.hasPrefix(prefix) && (viewAs == nil || allNotes.contains { $0.path == hit.path }) }
        CardGroup { ForEach(found) { noteRow($0) } }
        if found.isEmpty { CardCaption("No matches.") }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if store.canManage && viewAs == nil { PillAction(title: "New note", symbol: "plus", id: "new-note") { creating = true }.padding(.bottom, 12) }
    }
    .sheet(isPresented: $creating) { NewNoteSheet(folder: folder.isEmpty ? "people/\(store.me?.id ?? "")" : folder) { created = MemoryNote(path: $0) } }
    .navigationDestination(item: $created) { NoteView(path: $0.path) }
    .navigationDestination(isPresented: $sharing) { MemoryAccessView(path: folder) }
    .task(id: store.memoryVersion) { await load() }
    .task(id: query) {
      guard !query.trimmed.isEmpty else { hits = []; return }
      do {
        try await Task.sleep(for: .milliseconds(200))
        let found = try await store.searchNotes(query)
        if !Task.isCancelled { hits = found }
      } catch { if !Task.isCancelled { action.error = error.localizedDescription } }
    }
  }
  private func noteRow(_ note: MemoryNote) -> some View {
    NavigationLink { NoteView(path: note.path) } label: {
      RowLabel(title: (note.path as NSString).lastPathComponent, subtitle: note.updatedText.map { "Edited \($0)" } ?? note.snippet.map { $0.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression) }) {
        Image(systemName: "doc.text").font(.system(size: 18)).foregroundStyle(Palette.muted)
      }
    }.buttonStyle(.plain).accessibilityIdentifier("note-row")
  }
  private func folderName(_ name: String, in parent: String) -> String {
    store.folderLabel(name, parent: (parent as NSString).lastPathComponent == parent ? parent : (parent as NSString).lastPathComponent)
  }
  private func load() async {
    do {
      if let viewAs { asNotes = try await store.vaultNotes(as: viewAs) } else { try await store.refreshNotes() }
    } catch { action.error = error.localizedDescription }
  }
}

/** A note: read it, with Edit, History and Graph at the bottom and the rest behind the "..." circle. */
struct NoteView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var path: String
  @State private var note: MemoryNote?
  @State private var editing = false
  @State private var actions = false
  @State private var renaming = false
  @State private var moving = false
  @State private var deleting = false
  @State private var removingNote = false
  @State private var unavailable = false
  @State private var destination: MemoryNote?
  @State private var history = false
  @State private var graphOpen = false
  @State private var sharing = false
  @State private var graph: GraphData?
  @State private var browse = MemoryBrowse()
  @State private var action = FormAction()
  @Environment(\.colorScheme) private var scheme

  private var wikiLinks: [String] {
    guard let text = note?.content, let regex = try? NSRegularExpression(pattern: "\\[\\[([^\\]]+)\\]\\]") else { return [] }
    return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
      Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
  }
  private var crumbs: String { store.placeName(path).replacingOccurrences(of: "Shared with everyone", with: "Shared") }

  var body: some View {
    MemoryScreen(title: "Note", id: "note", trailing: {
      if note != nil { CircleButton(symbol: "ellipsis", label: "Note actions", id: "note-actions") { actions = true } }
    }) {
      if let note {
        Text(crumbs).font(.system(size: 15)).foregroundStyle(Palette.faint).padding(.horizontal, 6)
        Text(note.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 6).fixedSize(horizontal: false, vertical: true)
        if let author = note.editedBy {
          let who = displayAuthor(author, store: store)
          HStack(spacing: 8) {
            AuthorAvatar(author: who, size: 26)
            Text("Written by \(who.name)" + (note.editedAt.flatMap(relative).map { " · edited \($0)" } ?? "")).font(.system(size: 15)).foregroundStyle(Palette.muted)
          }.padding(.horizontal, 6)
        }
        tagRow(note)
        VStack(alignment: .leading) { NoteMarkdown(text: Self.withoutFrontmatter(note.content ?? "")).font(.system(size: 15)).foregroundStyle(Palette.text) }
          .padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        NoteProperties(note: note, from: path, kind: graph?.nodes.first { $0.id == path }?.graphKind) { target in
          action.run { destination = MemoryNote(path: try await store.resolveNote(target, from: path)) }
        }
        if let backlinks = note.backlinks, !backlinks.isEmpty {
          SectionCaption("Linked from")
          CardGroup {
            ForEach(backlinks, id: \.self) { link in
              NavigationLink { NoteView(path: link) } label: {
                RowLabel(title: noteTitle(link), value: store.placeName(link).components(separatedBy: " / ").last) { Image(systemName: "link").font(.system(size: 18)).foregroundStyle(Palette.muted) }
              }.buttonStyle(.plain)
            }
          }
        }
        ConnectedNotes(path: path, graph: graph, skip: Set(note.backlinks ?? []))
        if graph == nil, !wikiLinks.isEmpty {
          SectionCaption("Links to")
          CardGroup {
            ForEach(Array(Set(wikiLinks)).sorted(), id: \.self) { link in
              Button {
                action.run {
                  let target = link.components(separatedBy: "|").first ?? link
                  destination = MemoryNote(path: try await store.resolveNote(target.components(separatedBy: "#").first ?? target, from: path))
                }
              } label: { RowLabel(title: link.components(separatedBy: "|").last ?? link) { Image(systemName: "link").font(.system(size: 18)).foregroundStyle(Palette.muted) } }.buttonStyle(.plain)
            }
          }
        }
      } else if unavailable {
        Text("This note isn't available any more").foregroundStyle(Palette.muted).padding()
      } else if action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(40) }
      InlineError(error: action.error)
      if action.error != nil { Button("Try again") { action.run { note = try await store.readNote(path) } } }
    }
    .safeAreaInset(edge: .bottom) {
      if note != nil {
        HStack(spacing: 10) {
          if note?.editable == true { GlassPillButton(title: "Edit", symbol: "pencil", id: "edit-note") { editing = true } }
          GlassPillButton(title: "History", symbol: "clock", id: "note-history") { history = true }
          GlassPillButton(title: "Graph", symbol: "point.3.connected.trianglepath.dotted", id: "note-graph") { graphOpen = true }
        }.padding(.horizontal, 12).padding(.bottom, 12)
      }
    }
    .overlay {
      if deleting {
        ConfirmCard(symbol: "trash", title: "Delete this note?", message: "\((path as NSString).lastPathComponent) will be removed from memory. Anything that links to it will point nowhere. You can bring it back from History.", confirm: "Delete note", cancel: "Keep it", busy: action.busy, onConfirm: {
          action.run {
            removingNote = true
            do { try await store.deleteNote(path); deleting = false; dismiss() }
            catch { removingNote = false; deleting = false; throw error }
          }
        }, onCancel: { deleting = false })
      }
    }
    .sheet(isPresented: $actions) {
      NoteActionsSheet(path: path, canEdit: note?.editable == true) { choice in
        switch choice {
        case .rename: renaming = true
        case .move: moving = true
        case .access: sharing = true
        case .obsidian: openNoteInObsidian()
        case .delete: deleting = true
        }
      }
    }
    .task(id: NoteLoadID(version: store.memoryVersion, path: path, moving: moving || renaming, removing: removingNote, notes: store.notes)) {
      guard !removingNote else { return }
      if (note != nil || unavailable) && !store.notes.contains(where: { $0.path == path }) {
        markUnavailable()
        return
      }
      guard !moving, !renaming else { return }
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
    .task(id: store.memoryVersion) { graph = try? await store.vaultGraph() }
    .fullScreenCover(isPresented: $editing) { NoteEditor(note: note) }
    .sheet(isPresented: $renaming) { RenameNoteView(path: path) { moved in note = nil; unavailable = false; action.error = nil; path = moved } }
    .sheet(isPresented: $moving) { MoveNoteView(path: path) { moved in note = nil; unavailable = false; action.error = nil; path = moved } }
    .navigationDestination(item: $destination) { NoteView(path: $0.path) }
    .navigationDestination(isPresented: $history) { NoteHistoryView(path: path, canRestore: note?.editable == true) }
    .navigationDestination(isPresented: $sharing) { MemoryAccessView(path: path) }
    .navigationDestination(isPresented: $graphOpen) { MemoryGraphScreen(browse: browse, initialKind: nil, focus: path) }
  }

  @ViewBuilder private func tagRow(_ note: MemoryNote) -> some View {
    let tags = note.frontmatter?["tags"]?.items ?? note.tags ?? []
    let type = note.frontmatter?["type"]?.items.first
    if !tags.isEmpty || type != nil {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(tags, id: \.self) { TagChip(text: $0) }
          if let type { TagChip(text: type.capitalizedFirst, tint: graph?.nodes.first { $0.id == path }?.graphKind.color(dark: scheme == .dark) ?? Palette.blue) }
        }.padding(.horizontal, 6)
      }
    }
  }

  private func openNoteInObsidian() {
    if let root = store.memoryStorage?.path, let url = ObsidianLink.url(root: root, note: path) {
      UIApplication.shared.open(url) { ok in if !ok { Task { @MainActor in action.error = "Obsidian isn't on this iPhone. Use “On another computer” in Memory's Obsidian and storage." } } }
    } else {
      action.error = "Open Memory's Obsidian and storage to set up Obsidian."
    }
  }

  static func withoutFrontmatter(_ text: String) -> String {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    guard lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") else { return text }
    var rest = Array(lines[(end + 1)...])
    while rest.first?.trimmed.isEmpty == true { rest.removeFirst() }
    return rest.joined(separator: "\n")
  }

  private func markUnavailable() {
    note = nil
    unavailable = true
    editing = false; moving = false; renaming = false; deleting = false; actions = false
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

/** The "..." sheet: rename, move, who can see it, Obsidian, delete. */
struct NoteActionsSheet: View {
  enum Choice { case rename, move, access, obsidian, delete }
  @Environment(\.dismiss) private var dismiss
  var path: String
  var canEdit: Bool
  var choose: (Choice) -> Void
  @State private var picked: Choice?

  var body: some View {
    VStack(spacing: 12) {
      CardGroup {
        Text((path as NSString).lastPathComponent).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.faint).padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 6).frame(maxWidth: .infinity, alignment: .leading)
        if canEdit { row("Rename", "pencil", .rename); row("Move to another folder", "folder.badge.gearshape", .move) }
        row("Who can see this note", "lock", .access)
        row("Open in Obsidian", "arrow.up.right.square", .obsidian)
        if canEdit { row("Delete note", "trash", .delete, danger: true) }
      }
      Button { dismiss() } label: { Text("Cancel").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).frame(maxWidth: .infinity).frame(height: 56).background(Capsule().fill(Palette.control)) }.buttonStyle(.plain)
    }
    .padding(.horizontal, 12).padding(.top, 14)
    .presentationDetents([.height(canEdit ? 450 : 290)]).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    .onDisappear { if let picked { let c = picked; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { choose(c) } } }
  }
  private func row(_ title: String, _ symbol: String, _ choice: Choice, danger: Bool = false) -> some View {
    Button { picked = choice; dismiss() } label: {
      RowLabel(title: title, tint: danger ? Palette.red : Palette.text) { Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(danger ? Palette.red : Palette.muted).frame(width: 26) }
    }.buttonStyle(.plain).accessibilityIdentifier("note-action-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
  }
}

/** Editing a note: a plain monospace editor, Cancel and Save on top, a few markdown helpers above the keyboard. */
struct NoteEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var note: MemoryNote?
  var folder = "shared"
  @State private var path = ""
  @State private var content = ""
  @State private var message = ""
  @State private var action = FormAction()
  @FocusState private var focused: Bool

  private var valid: Bool { !path.trimmed.isEmpty && !path.trimmed.hasSuffix("/") && content.count <= 2_000_000 && message.count <= 200 }
  private var place: String { store.placeName(path).replacingOccurrences(of: "Shared with everyone", with: "Shared") }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button { dismiss() } label: { Text("Cancel").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 20).frame(height: 44).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline)) }
          .buttonStyle(.plain).disabled(action.busy)
        Spacer()
        Text((path as NSString).lastPathComponent).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
        Spacer()
        Button(action: save) { Text(action.busy ? "Saving…" : "Save").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet).padding(.horizontal, 22).frame(height: 44).background(Capsule().fill(Palette.text)).opacity(valid && !action.busy ? 1 : 0.4) }
          .buttonStyle(.plain).disabled(!valid || action.busy).accessibilityIdentifier("save-note")
      }.padding(.horizontal, 18).padding(.top, 16)
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          Text("Editing in \(place). Changes are saved as \(store.me?.preferredName ?? store.me?.name ?? "you").").font(.system(size: 13)).foregroundStyle(Palette.faint)
          if note == nil { TextField("Path", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled().padding(14).background(Palette.card, in: RoundedRectangle(cornerRadius: 12)) }
          TextEditor(text: $content).focused($focused).font(.system(size: 16, design: .monospaced)).foregroundStyle(Palette.text)
            .scrollContentBackground(.hidden).frame(minHeight: 340).padding(12)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder)).accessibilityLabel("Note content")
          TechnicalDetails(title: "More options") {
            TextField("Describe the change", text: $message).textFieldStyle(.roundedBorder)
          }.foregroundStyle(Palette.muted)
          InlineError(error: action.error)
        }.padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 80)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .safeAreaInset(edge: .bottom) {
      HStack(spacing: 10) {
        tool("bold", "Bold") { content += "****" }
        tool("list.bullet", "List") { content += (content.hasSuffix("\n") || content.isEmpty ? "" : "\n") + "- " }
        tool("link", "Link") { content += "[[]]" }
        tool("number", "Heading") { content += (content.hasSuffix("\n") || content.isEmpty ? "" : "\n") + "## " }
        Spacer()
      }.padding(.horizontal, 14).padding(.vertical, 8)
    }
    .accessibilityIdentifier("screen-note-edit")
    .onAppear { path = note?.path ?? folder + "/"; content = note?.content ?? ""; focused = true }
  }

  private func tool(_ symbol: String, _ label: String, _ run: @escaping () -> Void) -> some View {
    Button(action: run) { Image(systemName: symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text).frame(width: 44, height: 44).glassCircle() }
      .buttonStyle(.plain).accessibilityLabel(label)
  }

  private func save() {
    action.run {
      let target = path.trimmed.hasSuffix(".md") ? path.trimmed : path.trimmed + ".md"
      try await store.saveNote(path: target, content: content, message: message.trimmed.isEmpty ? "\(note == nil ? "Create" : "Edit") \(target)" : message)
      dismiss()
    }
  }
}

/** Rename a note in place: only the file name changes. */
struct RenameNoteView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var path: String
  var onMoved: (String) -> Void
  @State private var name = ""
  @State private var action = FormAction()
  private var target: String? { NoteLocation.path(folder: (path as NSString).deletingLastPathComponent, name: name) }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Rename note") { dismiss() }
      VStack(alignment: .leading, spacing: 14) {
        SectionCaption("Name")
        MemoryFieldCard { TextField("Note name", text: $name).foregroundStyle(Palette.text).accessibilityIdentifier("rename-note-name") }
        InlineError(error: action.error)
        Spacer()
        HStack { Spacer(); PillAction(title: "Rename", symbol: "checkmark", enabled: target != nil && target != path && !action.busy) {
          guard let target else { return }
          action.run { try await store.moveNote(from: path, to: target); onMoved(target); dismiss() }
        }; Spacer() }.padding(.bottom, 12)
      }.padding(.horizontal, 18).padding(.top, 6)
    }
    .background(Palette.sheet.ignoresSafeArea()).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    .onAppear { name = noteTitle(path) }
  }
}

/** Move a note to another folder; who can see it changes with the folder it lands in. */
struct MoveNoteView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var path: String
  var onMoved: (String) -> Void
  @State private var target = ""
  @State private var other = ""
  @State private var useOther = false
  @State private var action = FormAction()
  private var current: String { (path as NSString).deletingLastPathComponent }
  private var folders: [String] {
    let known = Set(store.notes.map { ($0.path as NSString).deletingLastPathComponent }.filter { !$0.isEmpty })
    return Array(known.union(["shared"]).subtracting([current])).sorted()
  }
  private var destination: String { useOther ? other.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) : target }
  private var newPath: String { (destination.isEmpty ? "" : destination + "/") + (path as NSString).lastPathComponent }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Move note") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text((path as NSString).lastPathComponent).font(.system(size: 15)).foregroundStyle(Palette.faint).padding(.horizontal, 6)
          SectionCaption("Move to")
          CardGroup {
            folderRow(current, subtitle: "Current folder", choose: nil)
            ForEach(folders, id: \.self) { f in folderRow(f, subtitle: nil, choose: f) }
          }
          CardCaption("Who can see the note changes with the folder it lands in.")
          if useOther {
            MemoryFieldCard { TextField("Folder path", text: $other).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text) }
          } else {
            Button { useOther = true; target = "" } label: { Text("Other folder…").font(.system(size: 15)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) }.buttonStyle(.plain).padding(.horizontal, 6)
          }
          InlineError(error: action.error)
        }.padding(.horizontal, 18).padding(.top, 6)
      }
      PillAction(title: "Move here", symbol: "checkmark", enabled: !destination.isEmpty && newPath != path && !action.busy) {
        action.run { try await store.moveNote(from: path, to: newPath); onMoved(newPath); dismiss() }
      }.padding(.vertical, 12)
    }
    .background(Palette.sheet.ignoresSafeArea()).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
  }

  private func folderRow(_ folder: String, subtitle: String?, choose: String?) -> some View {
    Button { if let choose { target = choose; useOther = false } } label: {
      RowLabel(title: pretty(folder), subtitle: subtitle, chevron: choose != nil && target != choose) {
        Image(systemName: target == choose && choose != nil ? "checkmark.circle.fill" : "folder").font(.system(size: 18)).foregroundStyle(target == choose && choose != nil ? Palette.blue : Palette.muted)
      }
    }.buttonStyle(.plain).disabled(choose == nil)
  }
  private func pretty(_ folder: String) -> String {
    if let friendly = store.friendlyFolder(folder), folder != "shared" { return friendly }
    let parts = folder.components(separatedBy: "/")
    return parts.enumerated().map { store.folderLabel($1, parent: $0 > 0 ? parts[$0 - 1] : "") }.joined(separator: " / ")
  }
}
