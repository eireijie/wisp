import SwiftUI

/** Warren's sidebar groups, with the things that need you first. */
struct ChatsView: View {
  @Environment(Store.self) private var store
  @State private var path = NavigationPath()
  @State private var search = ""
  @State private var sheet: String?
  @State private var editingSection: ChannelSection?
  @State private var deletingSection: ChannelSection?
  @State private var action = FormAction()

  private var rooms: [Channel] {
    store.channels.filter { !$0.isDM && $0.joined == true && $0.archivedAt == nil }
      .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if search.isEmpty {
          Section { InboxRow() }
        }
        Section("Your agents") {
          ForEach(store.agents.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.handle.localizedCaseInsensitiveContains(search) }) { agent in
            Button {
              action.run { path.append(try await store.dm(with: agent)) }
            } label: { AgentChatRow(agent: agent) }.disabled(action.busy)
          }
          if store.agents.isEmpty { Text("No agents yet.").foregroundStyle(.secondary) }
          if store.canManage { Button("New agent", systemImage: "plus") { sheet = "agent" } }
        }
        if rooms.contains(where: { $0.starred == true }) {
          Section("Starred") { ForEach(rooms.filter { $0.starred == true }) { ChatChannelRow(channel: $0) } }
        }
        ForEach(store.sections) { section in
          Section {
            ForEach(rooms.filter { $0.starred != true && $0.sectionId == section.id }) { ChatChannelRow(channel: $0) }
          } header: {
            HStack {
              Text(section.title)
              Spacer()
              if store.canManage {
                Menu {
                  Button("Rename section") { editingSection = section }
                  Button("Delete section", role: .destructive) { deletingSection = section }
                } label: { Image(systemName: "ellipsis") }.accessibilityLabel("\(section.name) options")
              }
            }
            .contextMenu {
              if store.canManage {
                Button("Rename section") { editingSection = section }
                Button("Delete section", role: .destructive) { deletingSection = section }
              }
            }
          }
        }
        Section("Channels") {
          ForEach(rooms.filter { ch in ch.starred != true && !store.sections.contains { $0.id == ch.sectionId } }) { ChatChannelRow(channel: $0) }
          Button("Add channels", systemImage: "plus") { sheet = "browse" }
        }
      }
      .listStyle(.insetGrouped)
      .searchable(text: $search, prompt: "Search chats")
      .orgSwitcher()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { ConnectionDot() }
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if store.canManage { Button("New channel", systemImage: "number") { sheet = "channel" } }
            Button("Browse channels", systemImage: "magnifyingglass") { sheet = "browse" }
            if store.canManage {
              Button("New section", systemImage: "folder.badge.plus") { sheet = "section" }
              Button("New agent", systemImage: "sparkles") { sheet = "agent" }
            }
          } label: { Image(systemName: "plus") }.accessibilityLabel("Add to Warren")
        }
      }
      .refreshable {
        await store.refreshChannels()
        await store.refreshApprovals()
        await store.refreshComputers()
        do { try await store.refreshAgents(); try await store.refreshManagement() }
        catch { action.error = error.localizedDescription }
      }
      .navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
      .navigationDestination(for: Agent.self) { AgentPage(agent: $0) }
      .navigationDestination(for: ChatsScreen.self) { screen in
        switch screen {
        case .inbox: InboxView()
        case .approval(let id): ApprovalDetail(approvalId: id)
        }
      }
      .sheet(isPresented: Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })) {
        switch sheet {
        case "channel": NewChannel { path.append($0) }
        case "browse": BrowseChannels { path.append($0) }
        case "section": SectionEditor()
        case "agent": AddAgent { path.append($0) }
        default: EmptyView()
        }
      }
      .sheet(item: $editingSection) { SectionEditor(section: $0) }
      .confirmationDialog("Delete \(deletingSection?.name ?? "section")?", isPresented: Binding(get: { deletingSection != nil }, set: { if !$0 { deletingSection = nil } }), titleVisibility: .visible) {
        Button("Delete section", role: .destructive) {
          if let section = deletingSection { action.run { try await store.deleteSection(section.id) } }
        }
      } message: { Text("Its channels move to Channels. Nothing in them is deleted.") }
      .managementAlert(action)
    }
    .task(id: store.route) { await open(store.route) }
  }

  private func open(_ route: Route?) async {
    if case .approval(let id) = route {
      store.route = nil
      var p = NavigationPath()
      p.append(ChatsScreen.inbox)
      p.append(ChatsScreen.approval(id: id))
      path = p
      return
    }
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

struct ChatChannelRow: View {
  @Environment(Store.self) private var store
  var channel: Channel
  @State private var action = FormAction()
  @State private var moving = false
  @State private var leaving = false

  /** an agent is replying in this channel right now */
  private var busy: Bool {
    store.activityChannel.contains { id, ch in ch == channel.id && store.agent(id)?.status == .busy }
  }

  var body: some View {
    NavigationLink(value: channel) {
      HStack(spacing: 12) {
        IconTile(symbol: channel.private == true ? "lock" : "number", color: .secondary, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(channel.name).font(.body.weight(channel.badge > 0 ? .semibold : .regular))
          if !channel.topic.isEmpty { Text(channel.topic).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
        Spacer()
        if busy { GlowDot(color: .green).accessibilityLabel("An agent is working here") }
        if channel.isMuted { Image(systemName: "bell.slash").foregroundStyle(.secondary) }
        UnreadBadge(count: channel.badge)
      }.opacity(channel.isMuted ? 0.55 : 1)
    }
    .contextMenu {
      starButton
      muteButton
      Button("Mark as read", systemImage: "checkmark") { action.run { try await store.readChannel(channel.id) } }
      if store.canManage { moveMenu }
      if channel.name != "general" { Button("Leave channel", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { leaving = true } }
    }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      starButton.tint(.orange)
      Button("Mark as read", systemImage: "checkmark") { action.run { try await store.readChannel(channel.id) } }.tint(.blue)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if channel.name != "general" { Button("Leave", role: .destructive) { leaving = true } }
      muteButton.tint(.gray)
      if store.canManage { Button("Move", systemImage: "folder") { moving = true }.tint(.indigo) }
    }
    .confirmationDialog("Move to section", isPresented: $moving, titleVisibility: .visible) { moveChoices }
    .confirmationDialog("Leave #\(channel.name)?", isPresented: $leaving, titleVisibility: .visible) {
      Button("Leave channel", role: .destructive) { action.run { try await store.leaveChannel(channel.id) } }
    }
    .managementAlert(action)
  }

  private var starButton: some View {
    Button(channel.starred == true ? "Unstar" : "Star", systemImage: "star") {
      action.run { try await store.setChannelPrefs(channel.id, ["starred": AnyEncodable(channel.starred != true)]) }
    }
  }

  private var muteButton: some View {
    Button(channel.isMuted ? "Unmute" : "Mute", systemImage: channel.isMuted ? "bell" : "bell.slash") {
      action.run { try await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(channel.isMuted ? "default" : "mute")]) }
    }
  }

  private var moveMenu: some View { Menu("Move to section", systemImage: "folder") { moveChoices } }

  @ViewBuilder private var moveChoices: some View {
    Button("Channels (no section)") { action.run { try await store.updateChannel(channel.id, ["sectionId": .null]) } }
    ForEach(store.sections) { section in
      Button(section.title) { action.run { try await store.updateChannel(channel.id, ["sectionId": AnyEncodable(section.id)]) } }
    }
  }
}

enum ChatsScreen: Hashable { case inbox, approval(id: String) }

/** The first row in Chats: what's waiting on you (approvals and computers that need you). */
struct InboxRow: View {
  @Environment(Store.self) private var store

  var body: some View {
    NavigationLink(value: ChatsScreen.inbox) {
      HStack(spacing: 12) {
        IconTile(symbol: "tray.full.fill", color: store.needsYouCount > 0 ? .orange : .secondary, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text("Inbox").font(.body.weight(store.needsYouCount > 0 ? .semibold : .regular))
          Text(store.needsYouCount > 0 ? "Waiting on you" : "Nothing waiting on you").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        UnreadBadge(count: store.needsYouCount)
      }
    }
    .accessibilityIdentifier("chats-inbox")
  }
}

/** A DM with one of your agents: working now, or unread messages. */
struct AgentChatRow: View {
  @Environment(Store.self) private var store
  var agent: Agent

  var body: some View {
    let dm = store.channels.first { $0.isDM && store.dmAgent($0)?.id == agent.id }
    let working = agent.status == .busy
    HStack(spacing: 12) {
      AgentAvatar(agent: agent, size: 44, showStatus: false)
      VStack(alignment: .leading, spacing: 2) {
        Text(agent.name).font(.body.weight((dm?.badge ?? 0) > 0 ? .semibold : .regular)).foregroundStyle(.primary)
        if working {
          HStack(spacing: 5) {
            GlowDot(color: .green)
            Text(store.activity[agent.id].map { $0 == "started" ? "Working" : $0 } ?? "Working").font(.caption).foregroundStyle(.green).lineLimit(1)
          }
        } else {
          Text(agent.settings?.description.flatMap { $0.isEmpty ? nil : $0 } ?? "@\(agent.handle)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      Spacer()
      if dm?.isMuted == true { Image(systemName: "bell.slash").foregroundStyle(.secondary) }
      UnreadBadge(count: dm?.badge ?? 0)
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }
    .opacity(dm?.isMuted == true ? 0.55 : 1)
    .accessibilityElement(children: .combine)
  }
}

struct UnreadBadge: View {
  var count: Int
  var body: some View {
    if count > 0 {
      Text(count > 99 ? "99+" : "\(count)")
        .font(.caption2.weight(.bold))
        .foregroundStyle(Color(.systemBackground))
        .padding(.horizontal, 7)
        .frame(minWidth: 20, minHeight: 20)
        .background(Capsule().fill(Color.primary))
    }
  }
}

/** Live updates on or off, shown quietly in the corner. */
struct ConnectionDot: View {
  @Environment(Store.self) private var store
  var body: some View {
    if !store.connected {
      Label("Reconnecting", systemImage: "wifi.slash")
        .labelStyle(.iconOnly)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Reconnecting to Warren")
    }
  }
}
