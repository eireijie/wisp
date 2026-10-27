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

/** Where the "..." menu and the home's links lead. */
enum MemoryRoute: Hashable { case graph, activity, access, about, storage }

/** Memory: the front page at the top, then folders. */
struct MemoryView: View {
  var folder = ""
  var body: some View {
    if folder.isEmpty { MemoryHome() } else { MemoryFolderView(folder: folder) }
  }
}

/** The front page of Memory: find a note, see what changed and who changed it, and the folders. */
struct MemoryHome: View {
  @Environment(Store.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var browse = MemoryBrowse()
  @State private var query = ""
  @State private var hits: [MemoryNote] = []
  @State private var creating = false
  @State private var created: MemoryNote?
  @State private var opened: MemoryNote?
  @State private var route: MemoryRoute?
  @State private var picking = false
  @State private var camera = GraphCamera()
  @State private var action = FormAction()

  private var allNotes: [MemoryNote] { browse.notes ?? store.notes }
  private func topFolders(_ notes: [MemoryNote]) -> [String] {
    Array(Set(notes.compactMap { $0.path.contains("/") ? $0.path.components(separatedBy: "/").first : nil })).sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0 < $1 }
  }
  private func rank(_ name: String) -> Int { ["shared": 0, "teams": 1, "groups": 2, "people": 3, "agents": 4][name] ?? 50 }
  private var recent: [MemoryChange] {
    (browse.changes ?? []).map { $0.keeping(visible: browse.visible) }.filter { !$0.files.isEmpty }.prefix(5).map { $0 }
  }
  private var shownHits: [MemoryNote] {
    guard let visible = browse.visible else { return hits }
    return hits.filter { visible.contains($0.path) }
  }
  private var viewingAgent: Agent? { browse.viewAs.flatMap { v in store.agents.first { "agent:\($0.id)" == v } } }
  private var canView: Bool { store.isOwner && !store.agents.isEmpty }

  var body: some View {
    MemoryScreen(title: "Memory", id: "memory", trailing: {
      MoreCircle {
        Button("Refresh", systemImage: "arrow.clockwise") { action.run { try await store.connection().post("/api/vault/sync", Empty()); try await store.refreshNotes(); await browse.reload(store) } }
        Button("Graph", systemImage: "point.3.connected.trianglepath.dotted") { route = .graph }
        Button("Recent changes", systemImage: "clock") { route = .activity }
        Button("Who can see and edit what", systemImage: "lock") { route = .access }
        Button("About you", systemImage: "person") { route = .about }
        Button("Obsidian and storage", systemImage: "arrow.triangle.2.circlepath") { route = .storage }
      }
    }) {
      Text("What your team remembers").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 4)
      if let agent = viewingAgent { ViewingBanner(agent: agent) { browse.viewAs = nil } }
      InlineError(error: action.error).padding(.horizontal, 4)
      MemorySearchField(prompt: "Search every note…", text: $query, id: "memory-search")
      if canView && viewingAgent == nil {
        Button { picking = true } label: {
          HStack(spacing: 8) {
            Image(systemName: "eye").font(.system(size: 14))
            Text("View as you").font(.system(size: 15, weight: .semibold))
            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
          }.foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 40).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
        }.buttonStyle(.plain).accessibilityIdentifier("memory-view-as")
      }
      if !query.trimmed.isEmpty { results } else { front }
    }
    .safeAreaInset(edge: .bottom) {
      if store.canManage && browse.viewAs == nil {
        PillAction(title: "New note", symbol: "plus", id: "new-note") { creating = true }.padding(.bottom, 12)
      }
    }
    .sheet(isPresented: $creating) { NewNoteSheet(folder: "people/\(store.me?.id ?? "")") { created = MemoryNote(path: $0) } }
    .sheet(isPresented: $picking) { ViewAsSheet(current: browse.viewAs) { browse.viewAs = $0 } }
    .navigationDestination(item: $created) { NoteView(path: $0.path) }
    .navigationDestination(item: $opened) { NoteView(path: $0.path) }
    .navigationDestination(item: $route) { destination in
      switch destination {
      case .graph: MemoryGraphScreen(browse: browse, initialKind: nil)
      case .activity: MemoryActivityView(visible: browse.visible)
      case .access: MemoryAccessRulesView()
      case .about: AboutYouView()
      case .storage: MemoryStorageView()
      }
    }
    .task(id: "\(store.memoryVersion)|\(browse.viewAs ?? "")") {
      do { try await store.refreshNotes() } catch { action.error = error.localizedDescription }
      await browse.reload(store)
    }
    .task(id: query) {
      guard !query.trimmed.isEmpty else { hits = []; return }
      do {
        try await Task.sleep(for: .milliseconds(200))
        let found = try await store.searchNotes(query)
        if !Task.isCancelled { hits = found }
      } catch { if !Task.isCancelled { action.error = error.localizedDescription } }
    }
  }

  private func plain(_ snippet: String) -> String {
    snippet.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression).replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "**", with: "")
  }

  @ViewBuilder private var results: some View {
    CardGroup {
      ForEach(shownHits) { note in
        NavigationLink { NoteView(path: note.path) } label: {
          VStack(alignment: .leading, spacing: 3) {
            Text(note.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
            Text(store.placeName(note.path)).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
            if let snippet = note.snippet { Text(plain(snippet)).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(2) }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 12).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("note-row")
      }
      if shownHits.isEmpty { Text("No notes match “\(query.trimmed)”.").foregroundStyle(Palette.muted).padding(18) }
    }
  }

  @ViewBuilder private var front: some View {
    let folders = topFolders(allNotes)
    if !folders.isEmpty {
      SectionCaption("Folders")
      CardGroup {
        ForEach(folders, id: \.self) { name in
          NavigationLink { MemoryFolderView(folder: name, viewAs: browse.viewAs) } label: {
            RowLabel(title: store.folderLabel(name, parent: ""), value: String(allNotes.filter { $0.path.hasPrefix(name + "/") }.count)) { Image(systemName: "folder").font(.system(size: 18)).foregroundStyle(Palette.muted) }
          }.buttonStyle(.plain).accessibilityIdentifier("memory-folder")
        }
      }
      if let agent = viewingAgent {
        let hidden = topFolders(store.notes).count - folders.count
        if hidden > 0 { CardCaption("\(hidden) \(hidden == 1 ? "folder" : "folders") hidden from \(agent.name)") }
      }
    }
    SectionCaption("Recent changes", trailing: AnyView(
      Button { route = .activity } label: { Text("All activity").font(.system(size: 15, weight: .medium)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) }
        .buttonStyle(.plain).accessibilityIdentifier("memory-all-activity")))
    if browse.changes == nil { ProgressView().frame(maxWidth: .infinity).padding() }
    else if recent.isEmpty {
      CardGroup {
        VStack(alignment: .leading, spacing: 8) {
          Text("Nothing written yet. Notes you and your agents write show up here.").foregroundStyle(Palette.muted)
          if store.canManage && browse.viewAs == nil { Button { creating = true } label: { Text("Write the first note").font(.system(size: 15, weight: .medium)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) }.buttonStyle(.plain) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      CardGroup {
        ForEach(recent) { change in
          let file = change.files.first { $0.change != "deleted" } ?? change.files[0]
          let who = displayAuthor(change.author, store: store)
          Button { if file.change != "deleted" { opened = MemoryNote(path: file.path) } } label: {
            RowLabel(title: noteTitle(file.path), subtitle: [who.name, relative(change.date)].compactMap { $0 }.joined(separator: " · ")) { AuthorAvatar(author: who, size: 40) }
          }.buttonStyle(.plain)
        }
      }
    }
    if let graph = browse.graph, !graph.nodes.isEmpty {
      Button { route = .graph } label: {
        VStack(alignment: .leading, spacing: 10) {
          ZStack {
            if !browse.positions.isEmpty {
              GraphCanvas(graph: graph, positions: browse.positions, camera: $camera, selected: nil, interactive: false, onSize: { camera = GraphCamera.fit(browse.positions.values.map { $0 }, in: $0, pad: 16) })
                .id(browse.positions.count)
            } else { ProgressView() }
          }.frame(height: 170).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          Text("See how every note links together").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.muted)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      }.buttonStyle(.plain).accessibilityIdentifier("memory-graph-link")
      let hubs = graph.mostLinked()
      if !hubs.isEmpty {
        SectionCaption("Most linked")
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(hubs) { node in
              NavigationLink { NoteView(path: node.path ?? "") } label: {
                HStack(spacing: 6) {
                  Circle().fill(node.graphKind.color(dark: scheme == .dark)).frame(width: 9, height: 9)
                  Text(node.title).lineLimit(1)
                  Text("\(node.inboundCount)").foregroundStyle(Palette.faint)
                }.font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 40)
                  .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
              }.buttonStyle(.plain).accessibilityLabel("\(node.title), \(node.inboundCount) \(node.inboundCount == 1 ? "note links" : "notes link") here")
            }
          }
        }
      }
    }
  }
}

/** The blue strip that says memory is being seen the way one agent sees it. */
struct ViewingBanner: View {
  var agent: Agent
  var stop: () -> Void
  var body: some View {
    HStack(spacing: 10) {
      AgentAvatar(agent: agent, size: 28, showStatus: false)
      Text("Viewing as @\(agent.handle). Only the notes it can read are listed.").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(light: 0x0B3D8F, dark: 0xDCE9FF)).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 4)
      Button(action: stop) { Text("Stop").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet).padding(.horizontal, 18).frame(height: 40).background(Capsule().fill(Palette.text)) }
        .buttonStyle(.plain).accessibilityIdentifier("memory-view-as-stop")
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(light: 0xDCE9FF, dark: 0x1F3A66)))
  }
}

/** "View memory as": pick yourself or one agent, and see how much of memory it can read. */
struct ViewAsSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var current: String?
  var onPick: (String?) -> Void
  @State private var pick: String = ""
  @State private var readable: Int?

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "View memory as") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          SectionCaption("Helper")
          CardGroup {
            Button { pick = "" } label: {
              HStack(spacing: 12) { Image(systemName: "person").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 40); Text("You").font(.system(size: 17)); Spacer(); RadioMark(on: pick.isEmpty) }
                .padding(.horizontal, 18).frame(minHeight: 62).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(Palette.text)
            ForEach(store.agents) { agent in
              Button { pick = "agent:\(agent.id)" } label: {
                HStack(spacing: 12) { AgentAvatar(agent: agent, size: 40, showStatus: false); Text(agent.name).font(.system(size: 15)); Spacer(); RadioMark(on: pick == "agent:\(agent.id)") }
                  .padding(.horizontal, 18).frame(minHeight: 62).contentShape(Rectangle())
              }.buttonStyle(.plain).foregroundStyle(Palette.text).accessibilityIdentifier("view-as-\(agent.handle)")
            }
          }
          if let agent = store.agents.first(where: { "agent:\($0.id)" == pick }) {
            SectionCaption("Result")
            VStack(alignment: .leading, spacing: 6) {
              if let readable { Text("\(agent.name) can read \(readable) of \(store.notes.count) notes").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.text) }
              else { ProgressView() }
              Text("The notes it can't read stay hidden while you look.").font(.system(size: 15)).foregroundStyle(Palette.muted)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
          }
        }.padding(.horizontal, 18).padding(.top, 6)
      }
      PillAction(title: viewLabel, symbol: pick.isEmpty ? nil : "eye", id: "view-as-apply") { onPick(pick.isEmpty ? nil : pick); dismiss() }.padding(.vertical, 12)
    }
    .background(Palette.sheet.ignoresSafeArea()).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    .onAppear { pick = current ?? "" }
    .task(id: pick) {
      readable = nil
      guard !pick.isEmpty else { return }
      let notes = try? await store.vaultNotes(as: pick)
      if !Task.isCancelled { readable = notes?.count }
    }
  }
  private var viewLabel: String {
    guard let agent = store.agents.first(where: { "agent:\($0.id)" == pick }) else { return "View as you" }
    return "View as \(agent.name)"
  }
}
