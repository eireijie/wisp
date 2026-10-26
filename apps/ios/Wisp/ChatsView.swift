import SwiftUI

/** One line in the Chats list: an agent's direct chat or a team. */
struct ChatEntry: Identifiable, Hashable {
  enum Kind: Hashable { case agent(Agent), team(Channel) }
  var kind: Kind
  /** the agent's direct chat (nil until the first message makes it) or the team's chat */
  var channel: Channel?
  var last: Message?
  /** when it was last active: its newest loaded message, else what the channel list says */
  var lastAt: Date? { last?.date ?? channel?.last.flatMap { Wire.date($0.at) } }

  var id: String {
    switch kind {
    case .agent(let a): "agent:\(a.id)"
    case .team(let c): "team:\(c.id)"
    }
  }
  var name: String {
    switch kind {
    case .agent(let a): a.name
    case .team(let c): c.name
    }
  }
  var isTeam: Bool { if case .team = kind { true } else { false } }
  var pinned: Bool { channel?.starred == true }
  var sectionId: String? { isTeam ? channel?.sectionId : nil }
  var badge: Int { channel?.badge ?? 0 }
}

/** What the Chats list shows and in what order. Pure, so it can be tested. */
enum ChatList {
  /** Agents' chats and teams in one flat list: pinned first, then the most recent, then by name. */
  static func entries(agents: [Agent], channels: [Channel], messages: [String: [Message]], dmAgent: (Channel) -> Agent?) -> [ChatEntry] {
    var out: [ChatEntry] = []
    for agent in agents {
      let dm = channels.first { $0.isDM && dmAgent($0)?.id == agent.id }
      out.append(ChatEntry(kind: .agent(agent), channel: dm, last: dm.flatMap { messages[$0.id]?.last }))
    }
    for c in channels where !c.isDM && c.joined == true && c.archivedAt == nil {
      out.append(ChatEntry(kind: .team(c), channel: c, last: messages[c.id]?.last))
    }
    return out.sorted { a, b in
      if a.pinned != b.pinned { return a.pinned }
      let (da, db) = (a.lastAt, b.lastAt)
      if da != db { return (da ?? .distantPast) > (db ?? .distantPast) }
      return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
    }
  }

  /** "9:36 PM" today, "Oct 23" before. */
  static func timeText(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
    if calendar.isDate(date, equalTo: now, toGranularity: .year) { return date.formatted(.dateTime.month(.abbreviated).day()) }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
  }
}

/** Your agents and teams in one list, with search, a + menu and your sections. */
struct ChatsView: View {
  @Environment(Store.self) private var store
  @Environment(\.openSettings) private var openSettings
  @Environment(\.openOrganizations) private var openOrganizations
  @State private var path = NavigationPath()
  @State private var search = ""
  @FocusState private var searchFocused: Bool
  @State private var sheet: String?
  @State private var editingSection: ChannelSection?
  @State private var deletingSection: ChannelSection?
  @State private var collapsed: Set<String> = []
  @State private var action = FormAction()
  /** what the hub found for the search box, with the text it was found for */
  @State private var found: (query: String, results: SearchResults)?
  @State private var searching = false

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var searchMode: Bool { searchFocused || !query.isEmpty }

  private var entries: [ChatEntry] {
    ChatList.entries(agents: store.agents, channels: store.channels, messages: store.messages, dmAgent: store.dmAgent)
  }
  private var matches: [ChatEntry] {
    entries.filter { e in
      query.isEmpty || e.name.localizedCaseInsensitiveContains(query) || { if case .agent(let a) = e.kind { a.handle.localizedCaseInsensitiveContains(query) } else { false } }()
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        if !searchMode { header }
        searchField
        list
      }
      .background(Palette.ground.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
      .animation(Motion.settle, value: searchMode)
      .task(id: query) { await runSearch() }
      .chatDestinations()
      .sheet(isPresented: Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })) {
        switch sheet {
        case "team": NewChannel(onBrowse: { sheet = "browse" }) { path.append($0) }
        case "browse": BrowseChannels { path.append($0) }
        case "section": SectionEditor()
        case "agent": AddAgent { path.append($0) }
        case "chat": NewChatSheet(onNewAgent: store.canManage ? { sheet = "agent" } : nil) { path.append($0) }
        default: EmptyView()
        }
      }
      .sheet(item: $editingSection) { SectionEditor(section: $0) }
      .confirmationDialog("Delete \(deletingSection?.name ?? "section")?", isPresented: Binding(get: { deletingSection != nil }, set: { if !$0 { deletingSection = nil } }), titleVisibility: .visible) {
        Button("Delete section", role: .destructive) {
          if let section = deletingSection { action.run { try await store.deleteSection(section.id) } }
        }
      } message: { Text("Deleting a section keeps its chats. They move back to the main list.") }
      .managementAlert(action)
    }
    .task(id: store.route) { await open(store.route) }
    .task(id: entries.count) { await warmPreviews() }
  }

  // MARK: top of the page

  private var header: some View {
    TopBar {
      Button { openSettings() } label: { ProfileCircle() }
        .buttonStyle(.press)
        .accessibilityIdentifier("profile-button")
        .contextMenu {
          Button("Switch organization", systemImage: "building.2") { openOrganizations() }
        }
    } center: {
      EmptyView()
    } trailing: {
      Menu {
        Button("New chat", systemImage: "square.and.pencil") { sheet = "chat" }
        if store.canManage {
          Button("New agent", systemImage: "sparkles") { sheet = "agent" }
          Button("New team", systemImage: "person.2") { sheet = "team" }
          Button("New section", systemImage: "folder.badge.plus") { sheet = "section" }
        } else {
          Button("Browse teams", systemImage: "magnifyingglass") { sheet = "browse" }
        }
      } label: { CircleLabel(symbol: "plus", weight: .regular) }
        .accessibilityLabel("New chat, agent or team").accessibilityIdentifier("new-menu")
    }
  }

  private var searchField: some View {
    HStack(spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass").font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.faint)
        TextField("Search chats", text: $search)
          .font(.system(size: 15)).foregroundStyle(Palette.text)
          .focused($searchFocused)
          .submitLabel(.search)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .accessibilityIdentifier("chats-search")
        if !search.isEmpty {
          Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }
            .buttonStyle(.plain).accessibilityLabel("Clear")
        }
      }
      .padding(.horizontal, 16).frame(height: 46)
      .background(Capsule().fill(Palette.field))
      if searchMode {
        Button("Cancel") { search = ""; searchFocused = false }
          .font(.system(size: 15)).foregroundStyle(Palette.text).buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 18).padding(.top, searchMode ? 12 : 0).padding(.bottom, 4)
  }

  // MARK: the list

  private var list: some View {
    List {
      if searchMode {
        searchRows
      } else {
        chatRows
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .listRowSpacing(0)
    .environment(\.defaultMinListRowHeight, 1)
    .refreshable {
      await store.refreshChannels()
      await store.refreshApprovals()
      await store.refreshComputers()
      do { try await store.refreshAgents(); try await store.refreshManagement() }
      catch { action.error = error.localizedDescription }
    }
    .overlay {
      if !searchMode && store.agents.isEmpty && entries.isEmpty {
        ContentUnavailableView {
          Label("Add your first agent", systemImage: "sparkles")
        } description: {
          Text("Give it a job and a computer.")
        } actions: {
          if store.canManage { Button("New agent") { sheet = "agent" }.primaryButton() }
        }
      }
    }
  }

  @ViewBuilder private var chatRows: some View {
    let all = entries
    let loose = all.filter { e in e.sectionId == nil || !store.sections.contains { $0.id == e.sectionId } }
    ForEach(Array(loose.enumerated()), id: \.element.id) { i, e in rowView(e, i) }
    ForEach(store.sections) { section in
      let rows = all.filter { $0.sectionId == section.id }
      Section {
        if !collapsed.contains(section.id) { ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in rowView(e, i) } }
      } header: {
        sectionHeader(section, count: rows.count)
      }
    }
  }

  private func rowView(_ entry: ChatEntry, _ index: Int = 0) -> some View {
    ChatRow(entry: entry, open: { openEntry(entry) }, path: $path)
      .rowEntrance(index)
      .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
  }

  private func sectionHeader(_ section: ChannelSection, count: Int) -> some View {
    let open = !collapsed.contains(section.id)
    return Button {
      withAnimation(Motion.settle) { if open { collapsed.insert(section.id) } else { collapsed.remove(section.id) } }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).rotationEffect(.degrees(open ? 0 : -90))
        Text(section.title).font(.system(size: 13, weight: .semibold)).tracking(0.5).textCase(.uppercase)
        Spacer()
      }
      .foregroundStyle(Palette.faint)
      .padding(.horizontal, 4).padding(.top, 14).padding(.bottom, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .textCase(nil)
    .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
    .accessibilityLabel("\(section.name), \(count) \(count == 1 ? "chat" : "chats"), \(open ? "expanded" : "collapsed")")
    .contextMenu {
      if store.canManage {
        Button("Rename section", systemImage: "pencil") { editingSection = section }
        Button("Delete section", systemImage: "trash", role: .destructive) { deletingSection = section }
      }
    }
  }

  // MARK: search

  @ViewBuilder private var searchRows: some View {
    let chats = matches.filter { !$0.isTeam }
    let teams = matches.filter { $0.isTeam }
    if !chats.isEmpty { Section { ForEach(chats) { rowView($0) } } header: { searchHeader("Chats") } }
    if !teams.isEmpty { Section { ForEach(teams) { rowView($0) } } header: { searchHeader("Teams") } }
    if !query.isEmpty { searchResults(shown: matches) }
  }

  private func searchHeader(_ title: String) -> some View {
    Text(title).font(.system(size: 13, weight: .semibold)).tracking(0.5).textCase(.uppercase).foregroundStyle(Palette.faint)
      .padding(.horizontal, 4).padding(.top, 14)
      .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
  }

  @ViewBuilder private func searchResults(shown: [ChatEntry]) -> some View {
    if let found, found.query == query {
      SearchResultsSections(
        results: found.results, query: query,
        shownChannels: Set(shown.compactMap { $0.isTeam ? $0.channel?.id : nil }),
        shownAgents: Set(shown.compactMap { if case .agent(let a) = $0.kind { a.id } else { nil } }),
        open: openResult
      )
      if found.results.isEmpty && shown.isEmpty {
        Section { Text("Nothing found for “\(query)”.").foregroundStyle(Palette.muted) }
      }
    } else if searching {
      Section { HStack(spacing: 8) { ProgressView(); Text("Searching…").foregroundStyle(Palette.muted) } }
    }
  }

  /** Asks the hub once typing pauses; a newer search drops this one. */
  private func runSearch() async {
    guard !query.isEmpty else { found = nil; searching = false; return }
    searching = true
    try? await Task.sleep(for: .milliseconds(250))
    guard !Task.isCancelled else { return }
    let q = query
    let results = try? await store.search(q)
    guard !Task.isCancelled else { return }
    found = results.map { (q, $0) }
    searching = false
  }

  // MARK: opening things

  /** Loads the newest messages of the first chats, so each row can say what was said last. */
  private func warmPreviews() async {
    for entry in entries.prefix(25) {
      guard let id = entry.channel?.id, store.messages[id] == nil, !Task.isCancelled else { continue }
      try? await store.loadMessages(id)
    }
  }

  private func openEntry(_ entry: ChatEntry) {
    if let channel = entry.channel { path.append(channel); return }
    if case .agent(let agent) = entry.kind {
      action.run { path.append(try await store.dm(with: agent)) }
    }
  }

  private func openResult(_ target: SearchTarget) {
    action.run {
      switch target {
      case .channel(let c):
        if c.joined != true && c.isDM == false { try await store.joinChannel(c.id); await store.refreshChannels() }
        path.append(store.channels.first { $0.id == c.id } ?? c)
      case .agent(let a):
        path.append(try await store.dm(with: store.agent(a.id) ?? a))
      case .message(let m):
        if !store.channels.contains(where: { $0.id == m.message.channelId }) { await store.refreshChannels() }
        guard let ch = store.channels.first(where: { $0.id == m.message.channelId }) else {
          throw API.Failure(status: 404, message: "That conversation isn't available any more.")
        }
        path.append(ch)
        if let thread = m.message.threadId { path.append(ThreadRef(channelId: ch.id, rootId: thread)) }
      case .note(let notePath):
        path.append(ChatsScreen.note(path: notePath))
      }
      search = ""
      searchFocused = false
    }
  }

  private func open(_ route: Route?) async {
    guard case .chat(let channelId, let threadId) = route else { return }
    if !store.channels.contains(where: { $0.id == channelId }) { await store.refreshChannels() }
    store.route = nil
    guard let ch = store.channels.first(where: { $0.id == channelId }) else { return }
    var p = NavigationPath()
    p.append(ch)
    if let threadId { p.append(ThreadRef(channelId: channelId, rootId: threadId)) }
    path = p
  }
}

/** A row: the agent's ghost (or a team's two), its name and time, and what was said or what it's doing. */
struct ChatRow: View {
  @Environment(Store.self) private var store
  var entry: ChatEntry
  var open: () -> Void
  @Binding var path: NavigationPath
  @State private var action = FormAction()
  @State private var moving = false
  @State private var leaving = false

  private var channel: Channel? { entry.channel.flatMap { c in store.channels.first { $0.id == c.id } } ?? entry.channel }
  private var muted: Bool { channel?.isMuted == true }

  var body: some View {
    Button(action: open) {
      HStack(spacing: 12) {
        avatar
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(entry.name).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
            Spacer(minLength: 8)
            if entry.pinned { Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(Palette.faint).accessibilityLabel("Pinned") }
            if let at = entry.lastAt { Text(ChatList.timeText(at)).font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }
          HStack(spacing: 8) {
            subtitle
            Spacer(minLength: 0)
            if muted { Image(systemName: "bell.slash").font(.system(size: 13)).foregroundStyle(Palette.faint) }
            if entry.badge > 0 { UnreadBadge(count: entry.badge) }
          }
        }
      }
      .padding(.vertical, 4).frame(minHeight: 56)
      .opacity(muted ? 0.6 : 1)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressRow)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(entry.isTeam ? "team-row" : "chat-row")
    .contextMenu { menu }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      pinButton.tint(.orange)
      if channel != nil { Button("Mark as read", systemImage: "checkmark") { action.run { try await store.readChannel(channel!.id) } }.tint(.blue) }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if entry.isTeam, channel?.name != "general" { Button("Leave", role: .destructive) { leaving = true } }
      muteButton.tint(.gray)
      if entry.isTeam, store.canManage { Button("Move", systemImage: "folder") { moving = true }.tint(.indigo) }
    }
    .sheet(isPresented: $moving) { if let channel { MoveToSectionSheet(channel: channel) } }
    .confirmationDialog("Leave \(entry.name)?", isPresented: $leaving, titleVisibility: .visible) {
      Button("Leave team", role: .destructive) { if let channel { action.run { try await store.leaveChannel(channel.id) } } }
    }
    .managementAlert(action)
  }

  // MARK: pieces

  @ViewBuilder private var avatar: some View {
    switch entry.kind {
    case .agent(let a): SoloGhost(agent: store.agent(a.id) ?? a)
    case .team(let c): TeamGhosts(agents: teamAgents(c), seed: c.name)
    }
  }

  private func teamAgents(_ c: Channel) -> [Agent] {
    guard let team = c.team(agents: store.agents) else { return [] }
    return team.nodes.sorted { ($0.lead ? 0 : 1) < ($1.lead ? 0 : 1) }.compactMap { store.agent($0.agentId) }
  }

  /** an agent is replying in this team right now */
  private var workingHere: Agent? {
    guard let id = channel?.id else { return nil }
    return store.activityChannel.compactMap { agentId, ch in ch == id ? store.agent(agentId) : nil }.first { $0.status == .busy }
  }

  @ViewBuilder private var subtitle: some View {
    if case .agent(let a) = entry.kind, (store.agent(a.id) ?? a).status == .busy {
      let doing = store.activity[a.id].flatMap { $0 == "started" ? nil : $0 }
      Text(["Working", doing].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 15)).foregroundStyle(Palette.green).lineLimit(1)
    } else if let agent = workingHere {
      Text("\(agent.name) is working").font(.system(size: 15)).foregroundStyle(Palette.green).lineLimit(1)
    } else {
      Text(preview).font(.system(size: 15)).foregroundStyle(Palette.muted).lineLimit(1)
    }
  }

  private var preview: String {
    if let m = entry.last, m.deletedAt == nil {
      var text = SearchText.clean(m.body, max: 90)
      if text.isEmpty, !m.files.isEmpty { text = "Sent \(m.files.count == 1 ? "a file" : "\(m.files.count) files")" }
      if !text.isEmpty {
        if m.author.kind == .user && m.author.id == store.me?.id { return "You: \(text)" }
        if entry.isTeam { return "\(store.name(of: m.author)): \(text)" }
        return text
      }
    }
    switch entry.kind {
    case .agent(let a): return a.settings?.description.flatMap { $0.isEmpty ? nil : $0 } ?? "@\(a.handle)"
    case .team(let c):
      if let leads = c.leadLine(agents: store.agents) { return leads }
      return c.topic.isEmpty ? "No messages yet" : c.topic
    }
  }

  @ViewBuilder private var menu: some View {
    pinButton
    if entry.isTeam, store.canManage { Button("Move to section", systemImage: "folder") { moving = true } }
    if channel != nil || !entry.isTeam { muteButton }
    if channel != nil { Button("Mark as read", systemImage: "checkmark") { action.run { try await store.readChannel(channel!.id) } } }
    if case .agent(let a) = entry.kind { Button("Agent profile", systemImage: "person.crop.circle") { path.append(store.agent(a.id) ?? a) } }
    if entry.isTeam, channel?.name != "general" { Button("Leave team", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { leaving = true } }
  }

  /** the chat to change a setting on; an agent's chat is made the first time you do */
  private func ensureChannel() async throws -> Channel {
    if let channel { return channel }
    guard case .agent(let a) = entry.kind else { throw API.Failure(status: 0, message: "That chat isn't available.") }
    return try await store.dm(with: a)
  }

  private var pinButton: some View {
    Button(entry.pinned ? "Unpin" : "Pin to top", systemImage: entry.pinned ? "pin.slash" : "pin") {
      action.run { let c = try await ensureChannel(); try await store.setChannelPrefs(c.id, ["starred": AnyEncodable(!entry.pinned)]) }
    }
  }

  private var muteButton: some View {
    Button(muted ? "Unmute" : "Mute", systemImage: muted ? "bell" : "bell.slash") {
      action.run { let c = try await ensureChannel(); try await store.setChannelPrefs(c.id, ["notify": AnyEncodable(muted ? "default" : "mute")]) }
    }
  }
}

/** "Move to section": No section, each section (a check on the current one), and a new one. */
struct MoveToSectionSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  @State private var action = FormAction()
  @State private var newSection = false

  private var currentId: String? { (store.channels.first { $0.id == channel.id } ?? channel).sectionId }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Move to section") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text(channel.name).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).padding(.horizontal, 6)
          CardGroup {
            choice("No section", id: nil, symbol: "tray")
            ForEach(store.sections) { choice($0.title, id: $0.id, symbol: "folder") }
            Button { newSection = true } label: {
              RowLabel(title: "New section…", chevron: false) { Image(systemName: "plus").foregroundStyle(Palette.muted).frame(width: 26) }
            }.buttonStyle(.plain)
          }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18).padding(.top, 8)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.medium, .large])
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .sheet(isPresented: $newSection) { SectionEditor() }
    .managementAlert(action)
  }

  private func choice(_ title: String, id: String?, symbol: String) -> some View {
    Button {
      guard id != currentId else { dismiss(); return }
      action.run {
        try await store.updateChannel(channel.id, ["sectionId": id.map { AnyEncodable($0) } ?? .null])
        dismiss()
      }
    } label: {
      RowLabel(title: title, chevron: false) { Image(systemName: symbol).foregroundStyle(Palette.muted).frame(width: 26) }
        .overlay(alignment: .trailing) {
          if id == currentId { Image(systemName: "checkmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.blue).padding(.trailing, 18) }
        }
    }
    .buttonStyle(.plain)
    .disabled(action.busy)
  }
}

/** "New chat": pick an agent to talk to. */
struct NewChatSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onNewAgent: (() -> Void)?
  var onOpen: (Channel) -> Void
  @State private var action = FormAction()

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "New chat") { dismiss() }
      ScrollView {
        VStack(spacing: 14) {
          if store.agents.isEmpty {
            Text("You don't have any agents yet.").foregroundStyle(Palette.muted).padding(.top, 24)
          } else {
            CardGroup {
              ForEach(store.agents) { agent in
                Button {
                  action.run { let c = try await store.dm(with: agent); dismiss(); onOpen(c) }
                } label: {
                  RowLabel(title: agent.name, subtitle: agent.settings?.description.flatMap { $0.isEmpty ? nil : $0 } ?? HarnessChoice.label(agent.harness), chevron: false) {
                    AgentAvatar(agent: agent, size: 40, showStatus: false)
                  }
                }.buttonStyle(.plain).disabled(action.busy)
              }
            }
          }
          if let onNewAgent {
            CardGroup {
              Button { dismiss(); onNewAgent() } label: {
                RowLabel(title: "New agent", chevron: false) { Image(systemName: "plus").foregroundStyle(Palette.muted).frame(width: 40) }
              }.buttonStyle(.plain)
            }
          }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18).padding(.top, 8)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.medium, .large])
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .managementAlert(action)
  }
}

/** The blue count on a chat or tab with new messages. */
struct UnreadBadge: View {
  var count: Int
  var body: some View {
    if count > 0 {
      Text(count > 99 ? "99+" : "\(count)")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
        .frame(minWidth: 20, minHeight: 20)
        .background(Capsule().fill(Palette.blue))
        .badgePop(count)
        .transition(.scale(scale: 0.4).combined(with: .opacity))
    }
  }
}
