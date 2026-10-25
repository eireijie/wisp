import SwiftUI

/** What the Memory screens share: the graph and its layout, the recent changes, and whose eyes memory is seen through. */
@MainActor @Observable final class MemoryBrowse {
  /** "agent:<id>" while an owner views memory as that agent, otherwise nil */
  var viewAs: String? { didSet { if viewAs != oldValue { graph = nil; positions = [:]; notes = nil } } }
  var graph: GraphData?
  var positions: [String: CGPoint] = [:]
  var notes: [MemoryNote]?
  var changes: [MemoryChange]?
  var loading = false
  var error: String?
  private var generation = 0

  /** Paths this view of memory can open; nil means everything the person can (no filtering needed). */
  var visible: Set<String>? { viewAs == nil ? nil : notes.map { Set($0.map(\.path)) } }

  func reload(_ store: Store) async {
    generation += 1
    let gen = generation
    let viewer = viewAs
    loading = true
    defer { if gen == generation { loading = false } }
    async let graphResult: GraphData? = try? await store.vaultGraph(as: viewer)
    async let changeResult: [MemoryChange]? = try? await store.vaultChanges(limit: 40)
    async let noteResult: [MemoryNote]? = viewer == nil ? nil : try? await store.vaultNotes(as: viewer)
    let (g, c, n) = await (graphResult, changeResult, noteResult)
    guard gen == generation else { return }
    changes = c ?? []
    notes = n
    graph = g
    error = g == nil ? "Couldn't load the graph." : nil
    guard let g else { positions = [:]; return }
    let placed = await Task.detached(priority: .userInitiated) { GraphLayout.positions(for: g) }.value
    if gen == generation { positions = placed }
  }
}

/** Memory: the front page at the top, then folders. */
struct MemoryView: View {
  var folder = ""
  var body: some View {
    if folder.isEmpty { MemoryHome() } else { MemoryFolderView(folder: folder) }
  }
}

/** The front page of Memory: find a note, see what changed and who changed it, and the notes everything links to. */
struct MemoryHome: View {
  @Environment(Store.self) private var store
  @State private var browse = MemoryBrowse()
  @State private var query = ""
  @State private var hits: [MemoryNote] = []
  @State private var creating = false
  @State private var created: MemoryNote?
  @State private var camera = GraphCamera()
  @State private var action = FormAction()

  private var topFolders: [String] {
    let notes = browse.notes ?? store.notes
    return Array(Set(notes.compactMap { $0.path.contains("/") ? $0.path.components(separatedBy: "/").first : nil })).sorted()
  }
  private var recent: [MemoryChange] {
    (browse.changes ?? []).map { $0.keeping(visible: browse.visible) }.filter { !$0.files.isEmpty }.prefix(7).map { $0 }
  }
  private var shownHits: [MemoryNote] {
    guard let visible = browse.visible else { return hits }
    return hits.filter { visible.contains($0.path) }
  }

  var body: some View {
    List {
      InlineError(error: action.error)
      if let agent = viewingAgent {
        Section {
          HStack {
            Label("Viewing as @\(agent.handle): only the notes it can read are listed.", systemImage: "eye").font(.footnote)
            Spacer()
            Button("Stop") { browse.viewAs = nil }.buttonStyle(.borderless)
          }
        }
      }
      if !query.trimmed.isEmpty {
        Section {
          ForEach(shownHits) { note in
            NavigationLink { NoteView(path: note.path) } label: {
              VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) { Text(note.name); Text(store.placeName(note.path)).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if let snippet = note.snippet { Text(plain(snippet)).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
              }
            }.accessibilityIdentifier("note-row")
          }
          if shownHits.isEmpty { Text("No notes match “\(query.trimmed)”.").foregroundStyle(.secondary) }
        }
      } else {
        header
        folderChips
        recentSection
        graphTeaser
        mostLinked
        browseSection
      }
    }
    .sectionScreen("Memory", id: "memory")
    .searchable(text: $query, prompt: "Search every note…")
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        if store.isOwner && !store.agents.isEmpty {
          Menu {
            Picker("View memory as", selection: Binding(get: { browse.viewAs ?? "" }, set: { browse.viewAs = $0.isEmpty ? nil : $0 })) {
              Text("View as you").tag("")
              ForEach(store.agents) { Text("View as @\($0.handle)").tag("agent:\($0.id)") }
            }
          } label: { Label("View memory as", systemImage: "eye") }.accessibilityIdentifier("memory-view-as")
        }
        Button("Refresh", systemImage: "arrow.clockwise") { action.run { try await store.connection().post("/api/vault/sync", Empty()); try await store.refreshNotes(); await browse.reload(store) } }.disabled(action.busy)
        if store.canManage && browse.viewAs == nil { Button("New note", systemImage: "square.and.pencil") { creating = true }.accessibilityIdentifier("new-note") }
      }
    }
    .sheet(isPresented: $creating) { NewNoteSheet(folder: "people/\(store.me?.id ?? "")") { created = MemoryNote(path: $0) } }
    .navigationDestination(item: $created) { NoteView(path: $0.path) }
    .task(id: "\(store.memoryVersion)|\(browse.viewAs ?? "")") {
      do { try await store.refreshNotes() } catch { action.error = error.localizedDescription }
      await browse.reload(store)
    }
    .refreshable { await browse.reload(store); try? await store.refreshNotes() }
    .task(id: query) {
      guard !query.trimmed.isEmpty else { hits = []; return }
      do {
        try await Task.sleep(for: .milliseconds(200))
        let found = try await store.searchNotes(query)
        if !Task.isCancelled { hits = found }
      } catch { if !Task.isCancelled { action.error = error.localizedDescription } }
    }
  }

  private var viewingAgent: Agent? { browse.viewAs.flatMap { v in store.agents.first { "agent:\($0.id)" == v } } }

  private func plain(_ snippet: String) -> String {
    snippet.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression).replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
  }

  // MARK: sections

  @ViewBuilder private var header: some View {
    Section {
      VStack(alignment: .leading, spacing: 4) {
        Text(stats).font(.caption).foregroundStyle(.secondary).monospacedDigit()
        Text("What your team remembers").font(.title3.weight(.semibold))
      }
      if store.notes.isEmpty && browse.graph?.nodes.isEmpty != false && !browse.loading {
        Text("Write, read and fix notes right here.").foregroundStyle(.secondary)
      }
    }
  }
  private var stats: String {
    guard let graph = browse.graph else { return " " }
    let notes = graph.nodes.filter { $0.path != nil }.count
    var text = "\(notes) \(notes == 1 ? "note" : "notes") · \(graph.edges.count) \(graph.edges.count == 1 ? "link" : "links")"
    if let first = browse.changes?.first, let date = Wire.date(first.date) { text += " · last change " + date.formatted(.relative(presentation: .named)) }
    return text
  }

  @ViewBuilder private var folderChips: some View {
    if let graph = browse.graph, graph.nodes.contains(where: { $0.path != nil }) {
      Section {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(GraphKind.allCases.filter { $0 != .ghost && graph.count(of: $0) > 0 }, id: \.self) { kind in
              NavigationLink { MemoryGraphScreen(browse: browse, initialKind: kind) } label: {
                HStack(spacing: 6) {
                  Circle().fill(kind.color(dark: scheme == .dark)).frame(width: 9, height: 9)
                  Text(kind.label(simple: store.simple)).fontWeight(.medium)
                  Text("\(graph.count(of: kind))").foregroundStyle(.secondary)
                }.font(.subheadline).padding(.horizontal, 12).padding(.vertical, 8).background(Capsule().fill(Color(.tertiarySystemFill)))
              }.buttonStyle(.plain).accessibilityLabel("\(kind.label(simple: store.simple)), \(graph.count(of: kind)). See in the graph")
            }
          }
        }.listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
      }.listRowBackground(Color.clear)
    }
  }
  @Environment(\.colorScheme) private var scheme

  private var recentSection: some View {
    Section {
      if browse.changes == nil { ProgressView() }
      else if recent.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Nothing written yet. Notes you and your \(store.simple ? "helpers" : "agents") write show up here.").foregroundStyle(.secondary)
          if store.canManage && browse.viewAs == nil { Button("Write the first note", systemImage: "square.and.pencil") { creating = true }.buttonStyle(.borderless) }
        }
      } else {
        ForEach(recent) { ChangeRow(change: $0, compact: true) }
      }
    } header: {
      HStack { Text("Recent changes"); Spacer(); NavigationLink("All activity") { MemoryActivityView(visible: browse.visible) }.font(.subheadline).textCase(nil).accessibilityIdentifier("memory-all-activity") }
    }
  }

  @ViewBuilder private var graphTeaser: some View {
    Section {
      NavigationLink { MemoryGraphScreen(browse: browse, initialKind: nil) } label: {
        VStack(alignment: .leading, spacing: 10) {
          ZStack {
            if let graph = browse.graph, !graph.nodes.isEmpty, !browse.positions.isEmpty {
              GraphCanvas(graph: graph, positions: browse.positions, camera: $camera, selected: nil, interactive: false, onSize: { camera = GraphCamera.fit(browse.positions.values.map { $0 }, in: $0, pad: 16) })
                .id(browse.positions.count)
            } else {
              Text(browse.graph == nil && browse.loading ? "Loading…" : "No notes yet").font(.subheadline).foregroundStyle(.secondary)
            }
          }.frame(height: 170).frame(maxWidth: .infinity).background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.tertiarySystemFill))).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          VStack(alignment: .leading, spacing: 2) { Text("Graph").font(.headline); Text("See how every note links together").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 4)
      }.accessibilityIdentifier("memory-graph-link")
    }
  }

  @ViewBuilder private var mostLinked: some View {
    if let graph = browse.graph {
      let hubs = graph.mostLinked()
      if !hubs.isEmpty {
        let maxIn = Double(hubs.first?.inboundCount ?? 1)
        Section("Most linked") {
          ForEach(hubs) { node in
            NavigationLink { NoteView(path: node.path ?? "") } label: {
              HStack(spacing: 10) {
                Circle().fill(node.graphKind.color(dark: scheme == .dark)).frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 1) {
                  Text(node.title).lineLimit(1)
                  Text(store.placeName(node.path ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                ProgressView(value: Double(node.inboundCount), total: max(maxIn, 1)).tint(node.graphKind.color(dark: scheme == .dark)).frame(width: 44)
                Text("\(node.inboundCount)").font(.caption).foregroundStyle(.secondary).monospacedDigit().frame(minWidth: 16, alignment: .trailing)
              }
            }.accessibilityLabel("\(node.title), \(node.inboundCount) \(node.inboundCount == 1 ? "note links" : "notes link") here")
          }
        }
      }
    }
  }

  @ViewBuilder private var browseSection: some View {
    let names = topFolders
    if !names.isEmpty {
      Section("Folders") {
        ForEach(names, id: \.self) { name in
          NavigationLink { MemoryFolderView(folder: name, viewAs: browse.viewAs) } label: { Label(store.folderLabel(name, parent: ""), systemImage: "folder") }.accessibilityIdentifier("memory-folder")
        }
      }
    }
  }
}
