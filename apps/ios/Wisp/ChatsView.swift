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
    case .team(let c): c.label
    }
  }
  var isTeam: Bool { if case .team = kind { true } else { false } }
  /** the key the hub's chat layout (UserPrefs.sidebar) uses: "a:<agentId>" or "c:<channelId>" */
  var key: String {
    switch kind {
    case .agent(let a): "a:\(a.id)"
    case .team(let c): "c:\(c.id)"
    }
  }
  var pinned: Bool { channel?.starred == true }
  var sectionId: String? { isTeam ? channel?.sectionId : nil }
  var badge: Int { channel?.badge ?? 0 }
}

/** What the Chats list shows and in what order. Pure, so it can be tested. */
enum ChatList {
  /** the newest message with words or files: a system line like "queued" says nothing a row can show */
  static func said(_ list: [Message]) -> Message? {
    list.last { $0.deletedAt == nil && (!$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !$0.files.isEmpty) } ?? list.last
  }

  /** Agents' chats and teams in one flat list: pinned first, then the most recent, then by name. */
  static func entries(agents: [Agent], channels: [Channel], messages: [String: [Message]], dmAgent: (Channel) -> Agent?) -> [ChatEntry] {
    var out: [ChatEntry] = []
    for agent in agents {
      let dm = channels.first { $0.isDM && dmAgent($0)?.id == agent.id }
      out.append(ChatEntry(kind: .agent(agent), channel: dm, last: dm.flatMap { messages[$0.id].flatMap(Self.said) }))
    }
    for c in channels where !c.isDM && c.joined == true && c.archivedAt == nil {
      out.append(ChatEntry(kind: .team(c), channel: c, last: messages[c.id].flatMap(Self.said)))
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

/**
 * Home (round 11, board 8 option C): your initials at the top left (you and settings) and + at the top
 * right, both on Liquid Glass; what you pinned as tiles (only those, board 16c); then your chats in
 * folders that fold shut. Search pulls down from the top. Pins and folders (the hub's sections) are
 * kept in the hub (UserPrefs.sidebar), the same as on the desktop. Press and hold a chat for its menu
 * (board 11).
 */
struct ChatsView: View {
  @Environment(Store.self) private var store
  @Environment(MainBarModel.self) private var bar
  @Environment(\.openSettings) private var openSettings
  @State private var path = NavigationPath()
  /** the standard pull-down search field (round 10: no button for it) */
  @State private var search = ""
  @FocusState private var searchFocused: Bool
  @State private var sheet: String?
  @State private var action = FormAction()
  /** what the hub found for the search box, with the text it was found for */
  @State private var found: (query: String, results: SearchResults)?
  @State private var searching = false
  /** "9 pinned is the most…" */
  @State private var notice: String?
  @State private var renaming: ChatEntry?
  @State private var renamingSection: SideLayout.Placed?
  @State private var newName = ""
  @State private var deleting: ChatEntry?
  @State private var leaving: ChatEntry?
  /** Share as template: the team, and the name it's saved under */
  @State private var templating: ChatEntry?
  /** a chat held down: lifted over the blurred screen with its menu (board 11) */
  @State private var lifted: LiftedChat?
  @State private var templateName = ""

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var searchMode: Bool { !query.isEmpty }
  /** one background (round 9): the last chat's, behind the list too, with a see-through tint over it */
  private var wall: ChatBackground { store.background(of: store.wallChannel.flatMap { id in store.channels.first { $0.id == id } }) }
  private var guest: Bool { store.role == "guest" }

  private var entries: [ChatEntry] {
    ChatList.entries(agents: store.agents, channels: store.channels, messages: store.messages, dmAgent: store.dmAgent)
  }
  private var matches: [ChatEntry] {
    entries.filter { e in
      query.isEmpty || e.name.localizedCaseInsensitiveContains(query) || { if case .agent(let a) = e.kind { a.handle.localizedCaseInsensitiveContains(query) } else { false } }()
    }
  }
  private var layoutChats: [SideLayout.Chat] {
    entries.map { SideLayout.Chat(key: $0.key, pinned: $0.pinned, sectionId: $0.sectionId, unread: $0.badge) }
  }
  private var layout: SidebarLayout { SideLayout.base(store.prefs?.sidebar, chats: layoutChats, sections: store.sections) }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        homeTop
        list
      }
      .background {
        ZStack {
          ChatWallView(background: wall, frosted: true)
          WallTint(background: wall)
        }
      }
      .environment(\.hasWall, true)
      .toolbar(.hidden, for: .navigationBar)
      .mainBar()
      .overlay {
        if let lifted {
          ChatLift(lifted: lifted, line: ChatRow.line(lifted.entry, store: store), items: liftItems(lifted.entry, layout: layout)) { self.lifted = nil }
        }
      }
      .task(id: query) { await runSearch() }
      .chatDestinations()
      .sheet(isPresented: Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })) {
        switch sheet {
        case "team": NewChannel(onBrowse: { sheet = "browse" }) { path.append($0) }
        case "browse": BrowseChannels { path.append($0) }
        // a new agent has already said hello in its DM, so that's where you land
        case "agent": AddAgent { agent in Task { if let ch = try? await store.dm(with: agent) { path.append(ch) } else { path.append(agent) } } }
        case "chat": NewChatSheet(onNewAgent: store.canManage ? { sheet = "agent" } : nil) { path.append($0) }
        default: EmptyView()
        }
      }
      .alert("Rename \(renaming?.name ?? "")", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
        TextField("Name", text: $newName).textInputAutocapitalization(.words)
        Button("Cancel", role: .cancel) {}
        Button("Save") { if let e = renaming { rename(e, newName) } }
      }
      .alert("Share \(templating?.name ?? "") as a template", isPresented: Binding(get: { templating != nil }, set: { if !$0 { templating = nil } })) {
        TextField("Template name", text: $templateName)
        Button("Cancel", role: .cancel) {}
        Button("Save") { if let id = templating?.channel?.id { saveTemplate(id, templateName) } }
      } message: { Text("Anyone here can start a team from it.") }
      .alert("Rename folder", isPresented: Binding(get: { renamingSection != nil }, set: { if !$0 { renamingSection = nil } })) {
        TextField("Name", text: $newName)
        Button("Cancel", role: .cancel) {}
        Button("Save") { if let s = renamingSection { save(SideLayout.renameSection(layout, s.id, newName)) } }
      }
      .confirmationDialog("Delete \(deleting?.name ?? "")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
        Button("Delete", role: .destructive) { if let e = deleting { delete(e) } }
        Button("Keep it", role: .cancel) {}
      } message: {
        Text(deleting?.isTeam == true ? "Its messages and threads are deleted for everyone. This can't be undone." : "Its notes and personality stay in memory. Its schedules and chats stop.")
      }
      .confirmationDialog("Leave \(leaving?.name ?? "")?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible) {
        Button("Leave team", role: .destructive) { if let id = leaving?.channel?.id { action.run { try await store.leaveChannel(id) } } }
      }
      .managementAlert(action)
    }
    .task(id: store.route) { await open(store.route) }
    // the + on the bottom bar: New chat, New agent, New team or Browse teams
    .onChange(of: bar.newRequest, initial: true) { _, kind in
      guard let kind else { return }
      bar.newRequest = nil
      path = NavigationPath()
      sheet = kind
    }
    .onChange(of: TourRun.shared.nav, initial: true) { tourMove() }
    .task(id: entries.count) { await warmPreviews() }
  }

  // MARK: the top

  /** your initials (you and settings) on the left, + (new agent, team or chat) on the right, both clear Liquid Glass */
  private var homeTop: some View {
    HStack {
      Button { openSettings() } label: {
        ProfileCircle(size: 40, glass: false).clearGlassCircle()
      }
      .buttonStyle(.press)
      .accessibilityLabel("You and settings")
      .accessibilityIdentifier("home-initials")
      .tourTarget("settings")
      Spacer(minLength: 0)
      Menu {
        NewMenuItems { kind in path = NavigationPath(); sheet = kind }
      } label: {
        Image(systemName: "plus").font(.system(size: 19, weight: .regular)).foregroundStyle(Palette.text)
          .frame(width: 40, height: 40).clearGlassCircle().contentShape(Circle())
      }
      .accessibilityLabel("New chat, agent or team")
      .accessibilityIdentifier("new-menu")
      .tourTarget("new")
    }
    .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 6)
  }

  // MARK: the list

  /** the search field, the list's first row: tucked above the top until you pull down (round 10) */
  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.faint)
      TextField("Search", text: $search)
        .font(.system(size: 16)).foregroundStyle(Palette.text)
        .focused($searchFocused)
        .submitLabel(.search)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityIdentifier("chats-search")
      if !search.isEmpty {
        Button { search = ""; searchFocused = false } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }
          .buttonStyle(.plain).accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, 14).frame(height: 40)
    .background(Capsule().fill(Palette.field))
    .padding(.horizontal, 4).padding(.top, 4).padding(.bottom, 8)
  }

  /** about how tall the list is under the search field, so a short list still scrolls the field out of sight */
  private func roughHeight() -> CGFloat {
    let l = layout
    let placed = SideLayout.place(l, chats: layoutChats)
    let pins = CGFloat((placed.pins.count + 2) / 3) * 128
    let rows = CGFloat(placed.sections.filter { !$0.folded }.reduce(0) { $0 + $1.keys.count }) * 70
    let headers = CGFloat(l.sections.isEmpty ? 0 : placed.sections.count) * 36
    return pins + rows + headers + 20
  }

  private var list: some View {
    GeometryReader { g in
    ScrollViewReader { proxy in
    List {
      plain(searchField).id("chats-search-row")
      plain(Color.clear.frame(height: 1)).id("list-top")
      if searchMode {
        searchRows
      } else {
        chatRows
        // room enough to scroll the search field away even when there are only a few chats
        plain(Color.clear.frame(height: max(0, g.size.height - roughHeight())))
      }
    }
    // nothing scrolls up under the clock: the tucked search field stays out of sight
    .clipShape(Rectangle())
    .onAppear { tuck(proxy) }
    // the chats arrive after the first layout: tuck the field once they're in
    .onChange(of: entries.count) { old, new in if old == 0 && new > 0 && query.isEmpty { tuck(proxy) } }
    .onChange(of: searchFocused) { _, on in if !on && query.isEmpty { tuck(proxy) } }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .listRowSpacing(0)
    .environment(\.defaultMinListRowHeight, 1)
    .bubbleRefresh {
      await store.refreshChannels()
      await store.refreshApprovals()
      await store.refreshComputers()
      do { try await store.refreshAgents(); try await store.refreshManagement() }
      catch { action.error = error.localizedDescription }
    }
    .overlay {
      if !searchMode && store.agents.isEmpty && entries.isEmpty {
        ContentUnavailableView {
          Label("Add your first agent", systemImage: "plus")
        } description: {
          Text("Give it a job and a computer.")
        } actions: {
          if store.canManage { Button("New agent") { sheet = "agent" }.primaryButton() }
        }
      }
    }
    }
    }
  }

  /** scroll the search field just out of sight (the top of the list is the first pin or chat) */
  private func tuck(_ proxy: ScrollViewProxy) {
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(60))
      proxy.scrollTo("list-top", anchor: .top)
    }
  }

  private func plain<V: View>(_ v: V) -> some View {
    v.listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
  }

  @ViewBuilder private var chatRows: some View {
    let all = entries
    let byKey = Dictionary(all.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    let l = layout
    let placed = SideLayout.place(l, chats: layoutChats)
    if let notice {
      plain(SuggestionBanner(symbol: "pin", text: notice, onClose: { self.notice = nil }, closeLabel: "OK").padding(.horizontal, -12).padding(.bottom, 8))
    }
    // only what's pinned is a tile (board 16c); everything else is a chat row below. Pin and Unpin are in the hold menu.
    let tiles = placed.pins.compactMap { byKey[$0] }
    if !tiles.isEmpty { plain(pinGrid(tiles, layout: l).tourTarget("pins").tourTarget("yourturn")) }
    let firstNeeds = all.first(where: needsYou)?.id
    do {
      let shown = placed.sections.filter { !$0.isNone || !$0.keys.isEmpty || placed.sections.count == 1 }
      let firstNamed = shown.first { !$0.isNone }?.id
      let firstRow = shown.first { !$0.folded && !$0.keys.isEmpty }.flatMap { $0.keys.first }
      ForEach(shown) { section in
        let rows = section.keys.compactMap { byKey[$0] }
        if !(section.isNone && l.sections.isEmpty) { plain(sectionHeader(section, count: rows.count, layout: l).tourTarget("sections", enabled: section.id == firstNamed)) }
        if !section.folded {
          ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in rowView(e, i, layout: l, needsFirst: e.id == firstNeeds, first: e.key == firstRow) }
          if !section.isNone && rows.isEmpty {
            plain(Text("Hold a chat, then choose Move to")
              .font(.system(size: 13)).foregroundStyle(Palette.muted)
              .frame(maxWidth: .infinity).frame(height: 52)
              .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
              .padding(.horizontal, 4).padding(.bottom, 6))
          }
        }
      }
      if !guest {
        plain(Button { newSection() } label: {
          Label("New folder", systemImage: "plus").font(.system(size: 14)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).frame(height: 40).padding(.horizontal, 6).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("new-section").tourTarget("new-section"))
      }
    }
  }

  // MARK: pins

  /** Agent tiles read big (board 8: 78 on phones), the tile leaving even room on every side. */
  static let pinSize: CGFloat = 76

  private func pinCell(_ e: ChatEntry, layout l: SidebarLayout) -> some View {
    VStack(spacing: 6) {
      ChatAvatar(entry: e, size: Self.pinSize)
        .dotOnEdge(dotColor(e, layout: l), size: 14)
      Text(e.name).font(.system(size: 14, weight: isUnread(e, l) ? .semibold : .regular))
        .foregroundStyle(isUnread(e, l) ? Palette.text : Palette.muted).lineLimit(1).frame(maxWidth: 96)
    }
  }

  private func pinGrid(_ pins: [ChatEntry], layout l: SidebarLayout) -> some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
      ForEach(pins) { e in
        // tap opens the chat; press and hold lifts it with its menu (board 11)
        Button { openEntry(e) } label: {
          pinCell(e, layout: l)
            .frame(maxWidth: .infinity).frame(height: 122)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.press)
        .liftOnHold { lifted = LiftedChat(entry: e, frame: $0) }
        .accessibilityLabel("\(e.name), pinned\(isUnread(e, l) ? ", unread" : "")\(needsYou(e) ? ", needs you" : "")")
        .accessibilityIdentifier("pin")
      }
    }
    .padding(.bottom, 6)
    .accessibilityElement(children: .contain).accessibilityLabel("Agents")
  }

  /** a blue dot when it needs you or there's something unread (the web's one mark, round 4) */
  private func dotColor(_ e: ChatEntry, layout l: SidebarLayout) -> Color? {
    needsYou(e) || isUnread(e, l) ? ChatDot.blue : nil
  }

  // MARK: rows and sections

  private func rowView(_ entry: ChatEntry, _ index: Int = 0, layout l: SidebarLayout? = nil, needsFirst: Bool = false, first: Bool = false) -> some View {
    ChatRow(entry: entry, unread: l.map { isUnread(entry, $0) } ?? (entry.badge > 0), needs: needsYou(entry), open: { openEntry(entry) }, path: $path,
      onHold: l == nil ? nil : { lifted = LiftedChat(entry: entry, frame: $0) })
    .tourTarget("needs-row", enabled: needsFirst)
    .tourTarget("chat-row", enabled: first)
    .tourTarget("yourturn", enabled: first)
    .rowEntrance(index)
    .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func sectionHeader(_ s: SideLayout.Placed, count: Int, layout l: SidebarLayout) -> some View {
    Button {
      withAnimation(Motion.settle) { save(SideLayout.fold(l, s.id, !s.folded)) }
    } label: {
      HStack(spacing: 5) {
        Text(s.isNone ? "Unsorted" : s.name).font(.system(size: 15, weight: .medium)).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).rotationEffect(.degrees(s.folded ? -90 : 0))
        Spacer()
      }
      .foregroundStyle(Palette.muted)
      .padding(.horizontal, 6).frame(height: 36)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(s.isNone ? "Unsorted" : s.name), \(count) \(count == 1 ? "chat" : "chats"), \(s.folded ? "collapsed" : "expanded")")
    .contextMenu {
      if !guest && !s.isNone {
        Button("Rename folder", systemImage: "pencil") { newName = s.name; renamingSection = s }
        Button("Delete folder", systemImage: "trash", role: .destructive) { save(SideLayout.deleteSection(l, s.id)) }
      }
    }
  }

  /**
   * Press and hold (board 11): Mark unread, Pin, Move to (its folders open in place, inside the menu),
   * Share as template, Hide, and More for the rest (Rename, Mute, Agent profile, Copy ID, Leave, Delete).
   */
  private func liftItems(_ e: ChatEntry, layout l: SidebarLayout) -> [LiftItem] {
    let done = { (work: @escaping () -> Void) in { lifted = nil; work() } }
    let pinned = l.pins.contains(e.key)
    let channel = e.channel.flatMap { c in store.channels.first { $0.id == c.id } } ?? e.channel
    let muted = channel?.isMuted == true
    var out: [LiftItem] = []
    if isUnread(e, l) {
      out.append(LiftItem(title: "Mark read", symbol: "envelope.open", action: done {
        save(SideLayout.clearUnread(l, e.key))
        if let id = channel?.id, e.badge > 0 { action.run { try await store.readChannel(id) } }
      }))
    } else {
      out.append(LiftItem(title: "Mark unread", symbol: "envelope", action: done { save(SideLayout.markUnread(l, e.key)) }))
    }
    out.append(pinned ? LiftItem(title: "Unpin", symbol: "pin.slash", action: done { unpin(e, l) }) : LiftItem(title: "Pin", symbol: "pin", action: done { pin(e, l) }))
    if !guest {
      let here = l.sections.first { $0.items.contains(e.key) }?.id ?? SideLayout.none
      var folders = l.sections.map { s in LiftItem(title: s.name, symbol: "folder", checked: here == s.id && !pinned, action: done { move(e, to: s.id, l) }) }
      folders.append(LiftItem(title: "Unsorted", symbol: "tray", checked: here == SideLayout.none && !pinned, action: done { move(e, to: SideLayout.none, l) }))
      folders.append(LiftItem(title: "New folder", symbol: "plus", action: done { newSection(with: e) }))
      out.append(LiftItem(title: "Move to", symbol: "folder", children: folders))
    }
    if e.isTeam, store.canManage, channel?.settings?.team?.steps?.isEmpty == false {
      out.append(LiftItem(title: "Share as template", symbol: "doc.text", action: done { templateName = e.name; templating = e }))
    }
    out.append(LiftItem(title: "Hide", symbol: "eye.slash", destructive: true, action: done { save(SideLayout.hide(l, e.key)) }))
    var more: [LiftItem] = []
    if canRename(e) { more.append(LiftItem(title: "Rename", symbol: "pencil", action: done { newName = e.name; renaming = e })) }
    more.append(LiftItem(title: muted ? "Unmute" : "Mute", symbol: muted ? "bell" : "bell.slash", action: done {
      action.run { let c = try await ensureChannel(e); try await store.setChannelPrefs(c.id, ["notify": AnyEncodable(muted ? "default" : "mute")]) }
    }))
    if case .agent(let a) = e.kind { more.append(LiftItem(title: "Agent profile", symbol: "person.crop.circle", action: done { path.append(store.agent(a.id) ?? a) })) }
    more.append(LiftItem(title: "Copy ID", symbol: "doc.on.doc", action: done { UIPasteboard.general.string = e.key.dropFirst(2).description }))
    if e.isTeam, channel?.name != "general" { more.append(LiftItem(title: "Leave team", symbol: "rectangle.portrait.and.arrow.right", action: done { leaving = e })) }
    if store.canManage, !(e.isTeam && channel?.name == "general") {
      more.append(LiftItem(title: "Delete", symbol: "trash", destructive: true, action: done { deleting = e }))
    }
    out.append(LiftItem(title: "More", symbol: "ellipsis", children: more))
    return out
  }

  private func saveTemplate(_ channelId: String, _ name: String) {
    let clean = String(name.trimmingCharacters(in: .whitespaces).prefix(60))
    guard !clean.isEmpty else { return }
    action.run { try await store.saveTeamTemplate(channelId: channelId, name: clean) }
  }

  // MARK: what the menu does

  private func isUnread(_ e: ChatEntry, _ l: SidebarLayout) -> Bool { e.badge > 0 || (l.unread ?? []).contains(e.key) }

  /** Waiting on you: an agent that needs signing in, an approval, or a chat that waits for your answer (web: preview line "needs"). */
  private func needsYou(_ e: ChatEntry) -> Bool {
    if case .agent(let a) = e.kind, (store.agent(a.id) ?? a).needsSignIn { return true }
    let channel = e.channel.flatMap { c in store.channels.first { $0.id == c.id } } ?? e.channel
    if store.role != "guest", let id = channel?.id, store.pendingApprovals.contains(where: { $0.channelId == id }) { return true }
    if let c = channel, case .waiting = Loops.listLine(c) { return true }
    return false
  }

  private func canRename(_ e: ChatEntry) -> Bool {
    guard store.canManage else { return false }
    if e.isTeam { return e.channel?.name != "general" }
    return true
  }

  private func save(_ next: SidebarLayout) {
    guard next != store.prefs?.sidebar else { return }
    action.run { try await store.saveSidebar(next) }
  }

  private func pin(_ e: ChatEntry, _ l: SidebarLayout) {
    guard let next = SideLayout.pin(l, e.key) else {
      withAnimation(Motion.settle) { notice = SideLayout.pinsFullNotice(e.name) }
      return
    }
    notice = nil
    save(next)
    if let id = e.channel?.id, e.channel?.starred != true { Task { try? await store.setChannelPrefs(id, ["starred": AnyEncodable(true)]) } }
  }

  private func unpin(_ e: ChatEntry, _ l: SidebarLayout) {
    save(SideLayout.unpin(l, e.key))
    if let id = e.channel?.id, e.channel?.starred == true { Task { try? await store.setChannelPrefs(id, ["starred": AnyEncodable(false)]) } }
  }

  private func move(_ e: ChatEntry, to id: String, _ l: SidebarLayout) {
    let wasPinned = l.pins.contains(e.key)
    save(SideLayout.move(l, e.key, to: id))
    if wasPinned, let cid = e.channel?.id, e.channel?.starred == true { Task { try? await store.setChannelPrefs(cid, ["starred": AnyEncodable(false)]) } }
  }

  private func newSection(with e: ChatEntry? = nil) {
    let l = layout
    let id = "s\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))"
    let name = SideLayout.newSectionName(l)
    save(SideLayout.addSection(l, name: name, id: id, key: e?.key))
    newName = name
    renamingSection = SideLayout.Placed(id: id, name: name, folded: false, keys: [])
  }

  private func rename(_ e: ChatEntry, _ name: String) {
    let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty, clean != e.name else { return }
    action.run {
      switch e.kind {
      case .agent(let a): _ = try await store.updateAgent(a.id, ["name": AnyEncodable(String(clean.prefix(80)))])
      case .team(let c):
        let slug = ManagementText.channelName(clean)
        guard !slug.isEmpty else { return }
        try await store.updateChannel(c.id, ["name": AnyEncodable(slug)])
      }
    }
  }

  private func delete(_ e: ChatEntry) {
    let l = layout
    action.run {
      switch e.kind {
      case .agent(let a): try await store.deleteAgent(a.id)
      case .team(let c): try await store.deleteChannel(c.id)
      }
      try? await store.saveSidebar(SideLayout.forget(l, e.key))
    }
  }

  /** the chat to change a setting on; an agent's chat is made the first time you do */
  private func ensureChannel(_ e: ChatEntry) async throws -> Channel {
    if let c = e.channel { return c }
    guard case .agent(let a) = e.kind else { throw API.Failure(status: 0, message: "That chat isn't available.") }
    return try await store.dm(with: a)
  }

  // MARK: search

  @ViewBuilder private var searchRows: some View {
    let chats = matches.filter { !$0.isTeam }
    let teams = matches.filter { $0.isTeam }
    if !chats.isEmpty { Section { ForEach(chats) { rowView($0, layout: layout) } } header: { searchHeader("Chats") } }
    if !teams.isEmpty { Section { ForEach(teams) { rowView($0, layout: layout) } } header: { searchHeader("Teams") } }
    if !query.isEmpty { searchResults(shown: matches) }
  }

  private func searchHeader(_ title: String) -> some View {
    Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.muted)
      .padding(.horizontal, 6).padding(.top, 10)
      .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
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
    // the finger lifting after a press and hold isn't a tap
    guard lifted == nil else { return }
    // opening a chat you marked unread clears the mark
    let l = layout
    if (l.unread ?? []).contains(entry.key) { save(SideLayout.clearUnread(l, entry.key)) }
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
    }
  }

  /** Show me around moved on: open its chat, the list, or the New team sheet. */
  private func tourMove() {
    let tour = TourRun.shared
    guard tour.active, let place = tour.place else { return }
    let chat: String? = place == .chat ? tour.run?.homeChannel : place == .team ? tour.teamChannel : nil
    switch place {
    case .chat, .team:
      if sheet == "team" { sheet = nil }
      if let chat, let ch = store.channels.first(where: { $0.id == chat }) {
        var p = NavigationPath(); p.append(ch); path = p
      } else { path = NavigationPath() }
    case .chats:
      if sheet == "team" { sheet = nil }
      search = ""
      path = NavigationPath()
    case .newTeam:
      path = NavigationPath()
      sheet = "team"
    default:
      if sheet == "team" { sheet = nil }
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

/** A chat's bubble: an agent's own, or a team's image or its first two agents' bubbles overlapped. */
struct ChatAvatar: View {
  @Environment(Store.self) private var store
  var entry: ChatEntry
  var size: CGFloat

  var body: some View {
    switch entry.kind {
    case .agent(let a): AgentAvatar(agent: store.agent(a.id) ?? a, size: size, showStatus: false)
    case .team(let c): TeamGhosts(agents: c.iconAgents(store.agents), seed: c.name, size: size, iconFileId: c.settings?.iconFileId).frame(width: size, height: size)
    }
  }
}

/** A row (80pt): the bubble, its name and time, and up to two lines of what was said or what it's doing. */
struct ChatRow: View {
  @Environment(Store.self) private var store
  var entry: ChatEntry
  var unread: Bool
  /** waiting on you (signing in, an approval, an answer): the blue dot, like unread */
  var needs = false
  var open: () -> Void
  @Binding var path: NavigationPath
  /** press and hold (board 11): lift it with its menu; nil = no menu (search results) */
  var onHold: ((CGRect) -> Void)? = nil
  @State private var action = FormAction()

  private var channel: Channel? { entry.channel.flatMap { c in store.channels.first { $0.id == c.id } } ?? entry.channel }
  private var muted: Bool { channel?.isMuted == true }

  var body: some View {
    Button(action: open) {
      HStack(spacing: 12) {
        // needs you, or unread without a count: one blue dot on the bubble's top-left edge (web round 6)
        ChatAvatar(entry: entry, size: 48)
          .dotOnEdge(needs || (unread && entry.badge == 0) ? ChatDot.blue : nil, size: 11)
        VStack(alignment: .leading, spacing: 2) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(entry.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
            Spacer(minLength: 8)
            if muted { Image(systemName: "bell.slash").font(.system(size: 12)).foregroundStyle(Palette.faint).accessibilityLabel("Muted") }
            if let at = entry.lastAt { Text(ChatList.timeText(at)).font(.system(size: 14)).foregroundStyle(Palette.muted) }
          }
          HStack(alignment: .top, spacing: 8) {
            subtitle
            Spacer(minLength: 0)
            if entry.badge > 0 { UnreadBadge(count: entry.badge) }
          }
        }
        .frame(maxHeight: .infinity)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.separator).frame(height: 0.5) }
        .opacity(muted ? 0.6 : 1)
      }
      .padding(.leading, 4)
      .frame(height: 80)
      .contentShape(Rectangle())
    }
    .buttonStyle(.pressRow)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(entry.isTeam ? "team-row" : "chat-row")
    // board 11: the chat lifts as a small card (its name and what was said last) and everything else blurs
    .modifier(HoldIf(hold: onHold))
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      if channel != nil { Button("Mark as read", systemImage: "checkmark") { action.run { try await store.readChannel(channel!.id) } }.tint(Palette.accent) }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      muteButton.tint(.gray)
    }
    .managementAlert(action)
  }

  /** an agent is replying in this team right now */
  private var workingHere: Agent? {
    guard let id = channel?.id else { return nil }
    return store.activityChannel.compactMap { agentId, ch in ch == id ? store.agent(agentId) : nil }.first { $0.status == .busy }
  }

  private static var line: Font { .system(size: 15) }

  @ViewBuilder private var subtitle: some View {
    if case .agent(let a) = entry.kind, (store.agent(a.id) ?? a).status == .busy {
      let doing = store.activity[a.id].flatMap { $0 == "started" ? nil : $0 }
      HStack(spacing: 6) {
        WorkingDots(color: Palette.statusWorking)
        Text(ActivityText.line(doing)).font(Self.line).foregroundStyle(Palette.statusWorkingText).lineLimit(1)
      }
    } else if let agent = workingHere {
      HStack(spacing: 6) {
        WorkingDots(color: Palette.statusWorking)
        Text("\(agent.name) is working").font(Self.line).foregroundStyle(Palette.statusWorkingText).lineLimit(1)
      }
    } else if case .agent(let a) = entry.kind, let live = store.agent(a.id) ?? Optional(a), live.needsSignIn, let signIn = live.signIn {
      Text("Needs sign-in · \(HarnessChoice.label(signIn.harness)) on \(signIn.where_)").font(Self.line).foregroundStyle(Palette.statusNeedsText).lineLimit(2)
    } else if let waiting = needsApproval {
      Text("Needs approval" + (waiting.isEmpty ? "" : " · \(waiting)")).font(Self.line).foregroundStyle(Palette.statusNeedsText).lineLimit(2)
    } else if let line = channel.flatMap({ Loops.listLine($0) }), case .done = line {
      // round 6: under the name is its last message, not where the chat stands (waiting on you lights the dot); done keeps its tick
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.statusOnline).accessibilityLabel("Done")
        Text(Self.mentioned(preview)).font(Self.line).foregroundStyle(Palette.muted).lineLimit(2)
      }
    } else {
      Text(Self.mentioned(preview)).font(Self.line).foregroundStyle(Palette.muted).lineLimit(2)
    }
  }

  /** the agents whose pending approvals wait on you here: "" when there is nothing to name, nil when nothing waits */
  private var needsApproval: String? {
    guard store.role != "guest", let id = channel?.id,
          let waiting = store.pendingApprovals.first(where: { $0.channelId == id }) else { return nil }
    return store.agent(waiting.agentId).map { entry.isTeam ? $0.name : "" } ?? ""
  }

  /** a preview with its @mentions in purple */
  static func mentioned(_ text: String) -> AttributedString {
    var out = AttributedString(text)
    var index = text.startIndex
    while let at = text[index...].firstIndex(of: "@") {
      var end = text.index(after: at)
      while end < text.endIndex, text[end].isLetter || text[end].isNumber || text[end] == "_" || text[end] == "-" { end = text.index(after: end) }
      if end > text.index(after: at), let r = Range(at ..< end, in: out) { out[r].foregroundColor = Palette.mention }
      index = end
    }
    return out
  }

  private var preview: String { Self.line(entry, store: store) }

  /** the row's second line: what was said last, or what it does */
  static func line(_ entry: ChatEntry, store: Store) -> String {
    if let m = entry.last, m.deletedAt == nil {
      var text = SearchText.clean(m.body, max: 120)
      if text.isEmpty, !m.files.isEmpty { text = "Sent \(m.files.count == 1 ? "a file" : "\(m.files.count) files")" }
      if !text.isEmpty {
        if m.author.kind == .user && m.author.id == store.me?.id { return "You: \(text)" }
        if entry.isTeam && m.author.id != "system" { return "\(store.name(of: m.author)): \(text)" }
        return text
      }
    }
    switch entry.kind {
    // never spoke: what it does, so the row isn't blank
    case .agent(let a):
      let live = store.agent(a.id) ?? a
      return live.settings?.role.flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed } ?? live.settings?.description.flatMap { $0.isEmpty ? nil : $0 } ?? "No messages yet"
    case .team(let c):
      if let leads = c.leadLine(agents: store.agents) { return leads }
      return c.topic.isEmpty ? "No messages yet" : c.topic
    }
  }

  /** the chat to change a setting on; an agent's chat is made the first time you do */
  private func ensureChannel() async throws -> Channel {
    if let channel { return channel }
    guard case .agent(let a) = entry.kind else { throw API.Failure(status: 0, message: "That chat isn't available.") }
    return try await store.dm(with: a)
  }

  private var muteButton: some View {
    Button(muted ? "Unmute" : "Mute", systemImage: muted ? "bell" : "bell.slash") {
      action.run { let c = try await ensureChannel(); try await store.setChannelPrefs(c.id, ["notify": AnyEncodable(muted ? "default" : "mute")]) }
    }
  }
}

/** What a held chat lifts into (board 11): its bubble and name, then what was said last. */
struct ChatPeek: View {
  var entry: ChatEntry
  var line: String
  var width: CGFloat = 320
  var lines = 4
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        ChatAvatar(entry: entry, size: 26)
        Text(entry.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
      }
      Text(line).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(lines)
        .padding(.horizontal, 14).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Palette.text.opacity(0.07)))
    }
    .padding(14)
    .frame(width: width, alignment: .leading)
    .background(Palette.sheet)
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
  @ReduceMotion private var reduceMotion
  var body: some View {
    if count > 0 {
      Text(count > 99 ? "99+" : "\(count)")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
        .frame(minWidth: 20, minHeight: 20)
        .background(Capsule().fill(Palette.accent))
        .badgePop(count)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
    }
  }
}

/** Press and hold on a row when it has a menu (search results have none). */
private struct HoldIf: ViewModifier {
  var hold: ((CGRect) -> Void)?
  func body(content: Content) -> some View {
    if let hold { content.liftOnHold(hold) } else { content }
  }
}
