import SwiftUI

/** New note: pick where to keep it (My notes, Shared, a helper's notes, or another folder), then name it. */
struct NewNoteSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var folder: String
  var name = ""
  var onCreated: (String) -> Void
  @State private var selection = ""
  @State private var other = ""
  @State private var title = ""
  @State private var action = FormAction()
  private let otherTag = "__other"

  private var choices: [NoteLocation] { NoteLocation.choices(meId: store.me?.id, agents: store.agents.map { ($0.id, $0.name) }) }
  private var target: String { selection == otherTag ? other : selection }
  private var path: String? { NoteLocation.path(folder: target, name: title) }

  var body: some View {
    EditorSheet(title: "New note", action: action, valid: path != nil && title.count <= 200, saveTitle: "Create", save: {
      guard let path else { return }
      action.run {
        let heading = noteTitle(path)
        try await store.saveNote(path: path, content: "# \(heading)\n\n", message: "Create \(path)")
        dismiss(); onCreated(path)
      }
    }) {
      Section("Where to keep it") {
        Picker("Where to keep it", selection: $selection) {
          ForEach(choices) { Text($0.label).tag($0.folder) }
          if !store.simple { Text("Other folder…").tag(otherTag) }
          else if selection == otherTag { Text(store.friendlyFolder(other) ?? other).tag(otherTag) }
        }
        if selection == otherTag && !store.simple {
          TextField("Folder path", text: $other).textInputAutocapitalization(.never).autocorrectionDisabled()
          Text("Type a new name to make a folder.").font(.caption).foregroundStyle(.secondary)
        }
      }
      Section("Name") { TextField("Meeting notes", text: $title).accessibilityIdentifier("new-note-name") }
    }
    .onAppear {
      title = name
      let clean = folder.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      if choices.contains(where: { $0.folder == clean }) { selection = clean } else { selection = otherTag; other = clean }
    }
  }
}

/** The note's front matter, laid out as properties: tags as hashtags, [[links]] you can follow. */
struct NoteProperties: View {
  @Environment(Store.self) private var store
  var note: MemoryNote
  var from: String
  var kind: GraphKind?
  var onOpen: (String) -> Void
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let props = note.properties
    if !props.isEmpty {
      Section("Properties") {
        ForEach(props, id: \.0) { key, value in
          VStack(alignment: .leading, spacing: 3) {
            Text(key.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).capitalizedFirst).font(.caption).foregroundStyle(.secondary)
            if key == "tags" { Text(value.items.map { "#\($0)" }.joined(separator: "  ")) }
            else if key == "type", let kind { HStack(spacing: 6) { Circle().fill(kind.color(dark: scheme == .dark)).frame(width: 8, height: 8); Text(value.items.joined(separator: ", ")) } }
            else {
              ForEach(value.items, id: \.self) { item in
                if let link = wikiLinkParts(item) { Button(link.label) { onOpen(link.target) }.buttonStyle(.borderless) }
                else { Text(item).textSelection(.enabled) }
              }
            }
          }.padding(.vertical, 2)
        }
      }
    }
  }
}

/** Beside a note: what links here and where it points, from the graph. */
struct ConnectedNotes: View {
  @Environment(Store.self) private var store
  var path: String
  var graph: GraphData?

  private func nodes(_ ids: [String]) -> [GraphNode] {
    let byId = Dictionary((graph?.nodes ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    return ids.compactMap { byId[$0] }.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
  }
  var incoming: [GraphNode] { nodes(Array(Set((graph?.edges ?? []).filter { $0.target == path && $0.source != path }.map(\.source)))) }
  var outgoing: [GraphNode] { nodes(Array(Set((graph?.edges ?? []).filter { $0.source == path && $0.target != path }.map(\.target)))) }

  var body: some View {
    if graph != nil, !(incoming.isEmpty && outgoing.isEmpty) {
      Section("Connected notes") {
        if !incoming.isEmpty { group("Linked from", incoming) }
        if !outgoing.isEmpty { group("Links to", outgoing) }
      }
    }
  }
  @ViewBuilder private func group(_ title: String, _ list: [GraphNode]) -> some View {
    Text("\(title) \(list.count)").font(.caption).foregroundStyle(.secondary)
    ForEach(list) { node in
      if let p = node.path {
        NavigationLink { NoteView(path: p) } label: {
          VStack(alignment: .leading, spacing: 1) { Text(node.title); Text(store.placeName(p)).font(.caption).foregroundStyle(.secondary) }
        }
      } else {
        Label("\(node.title) (not written yet)", systemImage: "circle.dashed").foregroundStyle(.secondary)
      }
    }
  }
}
