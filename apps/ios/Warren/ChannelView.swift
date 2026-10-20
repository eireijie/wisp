import SwiftUI

struct ThreadRef: Hashable {
  var channelId: String
  var rootId: String
}

struct ChannelView: View {
  @Environment(Store.self) private var store
  var channel: Channel
  @State private var error: String?
  @State private var loadingEarlier = false
  @State private var noEarlier = false
  @Environment(\.dismiss) private var dismiss

  private var current: Channel { store.channels.first { $0.id == channel.id } ?? channel }

  private var list: [Message] { store.messages[channel.id] ?? [] }

  var body: some View {
    ScrollViewReader { proxy in
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if list.count >= 80 && !noEarlier {
          Button(loadingEarlier ? "Loading…" : "Show earlier messages") {
            loadingEarlier = true
            Task {
              noEarlier = !(await store.loadEarlier(channel.id))
              loadingEarlier = false
            }
          }
          .font(.footnote)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 10)
        }
        if store.messages[channel.id] == nil {
          ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
        } else if list.isEmpty {
          EmptyChannel(channel: channel)
        }
        ForEach(Array(list.enumerated()), id: \.element.id) { i, m in
          MessageRow(message: m, compact: continues(m, after: i > 0 ? list[i - 1] : nil), replies: store.replyCounts[m.id] ?? 0, thread: ThreadRef(channelId: channel.id, rootId: m.id))
          .id(m.id)
        }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
      .padding(.bottom, 8)
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: list.last?.id) { Bottom.follow(proxy) }
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if current.archivedAt != nil {
        Text("#\(current.name) is archived").font(.footnote).foregroundStyle(.secondary).padding()
      } else {
        VStack(spacing: 6) {
          ActivityPill(channel: current)
          Composer(placeholder: placeholder) { text in
            try await store.send(text, in: channel.id)
          }
        }
        .animation(.snappy, value: store.agents.filter { $0.status == .busy }.map(\.id))
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .navigationTitle(store.title(of: current))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        if let agent = store.dmAgent(current) {
          NavigationLink {
            AgentPage(agent: agent)
          } label: {
            HStack(spacing: 8) {
              AgentAvatar(agent: agent, size: 24, showStatus: false)
              VStack(alignment: .leading, spacing: 0) {
                Text(agent.name).font(.subheadline.weight(.semibold))
                Text(statusLine(agent)).font(.caption2).foregroundStyle(.secondary)
              }
            }
          }.buttonStyle(.plain)
        } else {
          NavigationLink {
            ChannelDetails(channel: current)
          } label: {
            Label(current.name, systemImage: current.private == true ? "lock" : "number").font(.subheadline.weight(.semibold))
          }.buttonStyle(.plain)
        }
      }
    }
    .onChange(of: store.channels) { old, new in
      if old.contains(where: { $0.id == channel.id }) && !new.contains(where: { $0.id == channel.id }) { dismiss() }
      if old.first(where: { $0.id == channel.id })?.joined == true && new.first(where: { $0.id == channel.id })?.joined == false { dismiss() }
    }
    .overlay(alignment: .top) {
      if let error {
        Text(error).font(.footnote).padding(10).background(.thinMaterial, in: Capsule()).padding(.top, 6)
      }
    }
    .task(id: channel.id) {
      store.openChannel = channel.id
      do { try await store.loadMessages(channel.id) } catch { self.error = error.localizedDescription }
      store.markRead(channel.id)
    }
    .onDisappear { if store.openChannel == channel.id { store.openChannel = nil } }
  }

  private var placeholder: String {
    if let agent = store.dmAgent(current) { return "Message \(agent.name)" }
    return "Message #\(current.name)"
  }

  private func statusLine(_ a: Agent) -> String {
    switch a.status {
    case .busy: "Working"
    case .online: "Online"
    case .offline: "Offline"
    }
  }

  private func continues(_ m: Message, after prev: Message?) -> Bool {
    guard let prev, prev.author == m.author, m.author.id != "system" else { return false }
    return m.date.timeIntervalSince(prev.date) < 5 * 60
  }
}

struct ThreadView: View {
  @Environment(Store.self) private var store
  var ref: ThreadRef

  private var root: Message? { store.messages[ref.channelId]?.first { $0.id == ref.rootId } }
  private var replies: [Message] { store.threads[ref.rootId] ?? [] }

  var body: some View {
    ScrollViewReader { proxy in
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if let root {
          MessageRow(message: root, compact: false, replies: 0, thread: nil)
          HStack {
            Text(replies.count == 1 ? "1 reply" : "\(replies.count) replies").font(.caption).foregroundStyle(.secondary)
            VStack { Divider() }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 6)
        }
        ForEach(replies) { m in MessageRow(message: m, compact: false, replies: 0, thread: nil) }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: replies.last?.id) { Bottom.follow(proxy) }
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if store.channels.first(where: { $0.id == ref.channelId })?.archivedAt != nil {
        Text("This channel is archived").font(.footnote).foregroundStyle(.secondary).padding()
      } else {
        VStack(spacing: 6) {
          if let ch = store.channels.first(where: { $0.id == ref.channelId }) { ActivityPill(channel: ch) }
          Composer(placeholder: "Reply") { text in try await store.send(text, in: ref.channelId, thread: ref.rootId) }
        }
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .navigationTitle("Thread")
    .navigationBarTitleDisplayMode(.inline)
    .task { try? await store.loadMessages(ref.channelId, thread: ref.rootId) }
  }
}

/** The end of a conversation, where new messages scroll into view. */
enum Bottom {
  static let id = "bottom"
  static func follow(_ proxy: ScrollViewProxy) {
    withAnimation(.snappy) { proxy.scrollTo(id, anchor: .bottom) }
  }
}

struct EmptyChannel: View {
  @Environment(Store.self) private var store
  var channel: Channel
  var body: some View {
    VStack(spacing: 10) {
      if let a = store.dmAgent(channel) {
        AgentAvatar(agent: a, size: 64, showStatus: false, interactive: true)
        Text("This is the start of your chat with \(a.name).").font(.subheadline).foregroundStyle(.secondary)
      } else {
        Text("#\(channel.name)").font(.title3.bold())
        Text(channel.topic.isEmpty ? "No messages yet." : channel.topic).font(.subheadline).foregroundStyle(.secondary)
      }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
    .padding(.horizontal, 24)
  }
}

struct Composer: View {
  var placeholder: String
  var send: (String) async throws -> Void
  @State private var text = ""
  @State private var sending = false
  @State private var error: String?
  @FocusState private var focused: Bool

  private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var body: some View {
    VStack(spacing: 4) {
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
      HStack(alignment: .bottom, spacing: 6) {
        TextField(placeholder, text: $text, axis: .vertical)
          .lineLimit(1...8)
          .focused($focused)
          .padding(.leading, 18)
          .padding(.vertical, 12)
        Button {
          submit()
        } label: {
          Image(systemName: sending ? "ellipsis" : "arrow.up")
            .font(.body.weight(.bold))
            .foregroundStyle(Color(.systemBackground))
            .frame(width: 36, height: 36)
            .background(Circle().fill(Color.primary))
        }
        .buttonStyle(.plain)
        .disabled(empty || sending)
        .opacity(empty ? 0.25 : 1)
        .animation(.snappy, value: empty)
        .padding(5)
        .accessibilityLabel("Send")
      }
      // the message bar floats over the conversation on glass, like the tab bar
      .glass(23, interactive: true)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 6)
    .padding(.top, 4)
  }

  private func submit() {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return }
    sending = true
    error = nil
    text = ""
    Task {
      do { try await send(body) } catch {
        self.error = error.localizedDescription
        text = body
      }
      sending = false
    }
  }
}
