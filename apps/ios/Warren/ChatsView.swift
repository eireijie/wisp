import SwiftUI

/** Agents you talk to on top (their DMs), then channels: the same order as the web app's sidebar. */
struct ChatsView: View {
  @Environment(Store.self) private var store
  @State private var path = NavigationPath()
  @State private var search = ""

  private var dms: [(Channel, Agent?)] {
    store.channels.filter(\.isDM).map { ($0, store.dmAgent($0)) }
      .filter { search.isEmpty || store.title(of: $0.0).localizedCaseInsensitiveContains(search) }
  }

  private var rooms: [Channel] {
    store.channels.filter { !$0.isDM && ($0.joined ?? true) }
      .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
      .sorted { $0.name < $1.name }
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if search.isEmpty { NeedsYouSection() }
        if !dms.isEmpty {
          Section("Agents") {
            ForEach(dms, id: \.0.id) { ch, agent in
              NavigationLink(value: ch) {
                HStack(spacing: 12) {
                  AgentAvatar(agent: agent, size: 44)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(store.title(of: ch)).font(.body.weight((ch.unread ?? 0) > 0 ? .semibold : .regular))
                    if let agent, let doing = store.activity[agent.id] ?? (agent.status == .busy ? "Working…" : nil) {
                      Text(doing).font(.caption).foregroundStyle(.blue).lineLimit(1)
                    } else if let agent {
                      Text("@\(agent.handle)").font(.caption).foregroundStyle(.secondary)
                    }
                  }
                  Spacer()
                  UnreadBadge(count: ch.unread ?? 0)
                }
              }
            }
          }
        }
        Section("Channels") {
          ForEach(rooms) { ch in
            NavigationLink(value: ch) {
              HStack(spacing: 12) {
                IconTile(symbol: "number", color: .secondary, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                  Text(ch.name).font(.body.weight((ch.unread ?? 0) > 0 ? .semibold : .regular))
                  if !ch.topic.isEmpty { Text(ch.topic).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
                Spacer()
                UnreadBadge(count: ch.unread ?? 0)
              }
            }
          }
          if rooms.isEmpty { Text("No channels yet").foregroundStyle(.secondary) }
        }
      }
      .listStyle(.insetGrouped)
      .searchable(text: $search, prompt: "Search chats")
      .navigationTitle(store.workspace?.name ?? "Warren")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { ConnectionDot() }
      }
      .refreshable {
        await store.refreshChannels()
        await store.refreshApprovals()
        await store.refreshComputers()
      }
      .navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
    }
    .task(id: store.route) { await open(store.route) }
  }

  /** Open the chat (and thread) a tapped notification is about. */
  private func open(_ route: Route?) async {
    // an approval notification: it's waiting at the top of this list
    if case .approval = route {
      store.route = nil
      path = NavigationPath()
      await store.refreshApprovals()
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

/** Agents waiting on you, answerable right here: the first thing you see when something needs you. */
struct NeedsYouSection: View {
  @Environment(Store.self) private var store

  private var helpWanted: [Computer] { store.computers.filter { $0.help != nil } }

  var body: some View {
    if store.needsYouCount > 0 {
      Section {
        ForEach(helpWanted) { c in
          NavigationLink {
            ComputerDetail(computerId: c.id)
          } label: {
            HStack(spacing: 12) {
              AgentAvatar(agent: store.agent(c.help!.agentId), size: 44)
              VStack(alignment: .leading, spacing: 2) {
                Text(c.help!.request).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text("\(store.agent(c.help!.agentId)?.name ?? "An agent") needs you on \(c.name)").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        ForEach(store.pendingApprovals) { a in
          ApprovalBox(approval: a, agentName: store.agent(a.agentId)?.name, inList: true)
        }
      } header: {
        HStack {
          Label("Needs you", systemImage: "hand.raised.fill").foregroundStyle(.orange)
          Spacer()
          NavigationLink("History") { InboxView() }.font(.caption.weight(.semibold)).textCase(nil)
        }
      }
    }
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
