import SwiftUI

/** New note: a title, where to keep it (My notes, Shared, a helper's notes, or another folder), and an optional first line. */
struct NewNoteSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var folder: String
  var name = ""
  var onCreated: (String) -> Void
  @State private var selection = ""
  @State private var other = ""
  @State private var title = ""
  @State private var body_ = ""
  @State private var action = FormAction()
  private let otherTag = "__other"

  private var choices: [NoteLocation] { NoteLocation.choices(meId: store.me?.id, agents: store.agents.map { ($0.id, $0.name) }) }
  private var target: String { selection == otherTag ? other : selection }
  private var path: String? { NoteLocation.path(folder: target, name: title) }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "New note") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          SectionCaption("Title")
          MemoryFieldCard { TextField("Meeting notes", text: $title).foregroundStyle(Palette.text).accessibilityIdentifier("new-note-name") }
          SectionCaption("Where to keep it")
          CardGroup {
            ForEach(choices) { choice in
              Button { selection = choice.folder } label: {
                RowLabel(title: choice.label, value: who(choice.folder), chevron: false) {
                  Image(systemName: selection == choice.folder ? "checkmark.circle.fill" : "folder").font(.system(size: 18)).foregroundStyle(selection == choice.folder ? Palette.blue : Palette.muted)
                }
              }.buttonStyle(.plain)
            }
          }
          if selection == otherTag {
            MemoryFieldCard { TextField("Folder path", text: $other).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text) }
            CardCaption("Pick one or type a new name to make a folder.")
          } else {
            Button { selection = otherTag } label: { Text("Other folder…").font(.system(size: 15)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) }.buttonStyle(.plain).padding(.horizontal, 6)
          }
          SectionCaption("Note")
          TextEditor(text: $body_).scrollContentBackground(.hidden).foregroundStyle(Palette.text).frame(minHeight: 150).padding(12)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
            .overlay(alignment: .topLeading) { if body_.isEmpty { Text("Write something your helpers should remember…").foregroundStyle(Palette.faint).padding(.horizontal, 17).padding(.vertical, 20).allowsHitTesting(false) } }
          InlineError(error: action.error)
        }.padding(.horizontal, 18).padding(.top, 6)
      }.scrollDismissesKeyboard(.interactively)
      PillAction(title: "Create", symbol: "checkmark", enabled: path != nil && title.count <= 200 && !action.busy, id: "create-note") {
        guard let path else { return }
        action.run {
          let heading = noteTitle(path)
          let text = body_.trimmed.isEmpty ? "# \(heading)\n\n" : "# \(heading)\n\n\(body_.trimmed)\n"
          try await store.saveNote(path: path, content: text, message: "Create \(path)")
          dismiss(); onCreated(path)
        }
      }.padding(.vertical, 12)
    }
    .background(Palette.sheet.ignoresSafeArea()).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    .onAppear {
      title = name
      let clean = folder.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      if choices.contains(where: { $0.folder == clean }) { selection = clean } else { selection = otherTag; other = clean }
    }
  }

  private func who(_ folder: String) -> String? {
    if folder == "shared" { return "Everyone sees it" }
    if folder == "people/\(store.me?.id ?? "-")" { return "Only you" }
    if let agent = store.agents.first(where: { folder == "agents/\($0.id)" }) { return "Private to \(agent.name)" }
    return nil
  }
}

/** The note's other front matter, laid out as properties: [[links]] you can follow. Tags and type are chips at the top. */
struct NoteProperties: View {
  @Environment(Store.self) private var store
  var note: MemoryNote
  var from: String
  var kind: GraphKind?
  var onOpen: (String) -> Void

  var body: some View {
    let props = note.properties.filter { $0.0 != "tags" && $0.0 != "type" }
    if !props.isEmpty {
      SectionCaption("Properties")
      CardGroup {
        ForEach(props, id: \.0) { key, value in
          VStack(alignment: .leading, spacing: 3) {
            Text(key.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).capitalizedFirst).font(.system(size: 13)).foregroundStyle(Palette.faint)
            ForEach(value.items, id: \.self) { item in
              if let link = wikiLinkParts(item) { Button(link.label) { onOpen(link.target) }.buttonStyle(.borderless).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) }
              else { Text(item).foregroundStyle(Palette.text).textSelection(.enabled) }
            }
          }.padding(.horizontal, 18).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
}

/** Beside a note: where it points, from the graph ("Linked from" is the backlinks card above). */
struct ConnectedNotes: View {
  @Environment(Store.self) private var store
  var path: String
  var graph: GraphData?
  /** notes already shown as "Linked from" */
  var skip: Set<String> = []

  private func nodes(_ ids: [String]) -> [GraphNode] {
    let byId = Dictionary((graph?.nodes ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    return ids.compactMap { byId[$0] }.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
  }
  var incoming: [GraphNode] { nodes(Array(Set((graph?.edges ?? []).filter { $0.target == path && $0.source != path }.map(\.source)))).filter { !skip.contains($0.id) } }
  var outgoing: [GraphNode] { nodes(Array(Set((graph?.edges ?? []).filter { $0.source == path && $0.target != path }.map(\.target)))) }

  var body: some View {
    if graph != nil {
      if !incoming.isEmpty { group("Linked from", incoming) }
      if !outgoing.isEmpty { group("Links to", outgoing) }
    }
  }
  @ViewBuilder private func group(_ title: String, _ list: [GraphNode]) -> some View {
    SectionCaption(title)
    CardGroup {
      ForEach(list) { node in
        if let p = node.path {
          NavigationLink { NoteView(path: p) } label: {
            RowLabel(title: node.title, value: store.placeName(p).components(separatedBy: " / ").last) { Image(systemName: "link").font(.system(size: 18)).foregroundStyle(Palette.muted) }
          }.buttonStyle(.plain)
        } else {
          RowLabel(title: node.title, subtitle: "Not written yet", chevron: false) { Image(systemName: "circle.dashed").font(.system(size: 18)).foregroundStyle(Palette.faint) }
        }
      }
    }
  }
}
