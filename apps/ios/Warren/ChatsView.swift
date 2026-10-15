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
        if !dms.isEmpty {
          Section("Agents") {
            ForEach(dms, id: \.0.id) { ch, agent in
              NavigationLink(value: ch) {
                HStack(spacing: 12) {
                  AgentAvatar(agent: agent, size: 38)
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
                Image(systemName: "number")
                  .font(.body.weight(.medium))
                  .foregroundStyle(.secondary)
                  .frame(width: 38, height: 38)
                  .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(.secondarySystemFill)))
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
      .refreshable { await store.refreshChannels() }
      .navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
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
