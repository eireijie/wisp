import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ThreadRef: Hashable {
  var channelId: String
  var rootId: String
  /** the thread it was opened from, when it's a sub-thread opened from its parent (so "back up" just goes back) */
  var from: String? = nil
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
  /** agents working in some thread here, to show on that thread's row */
  private var inThreads: [Agent] { store.working(in: channel.id).filter { store.activityThread[$0.id] != nil } }

  var body: some View {
    ScrollViewReader { proxy in
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if list.count >= 80 && !noEarlier {
          Button(loadingEarlier ? "Loading…" : "Show earlier messages") {
            loadingEarlier = true
            Task {
              do {
                noEarlier = !(try await store.loadEarlier(channel.id))
                error = nil
              } catch { self.error = error.localizedDescription }
              loadingEarlier = false
            }
          }
          .disabled(loadingEarlier)
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
          MessageRow(message: m, compact: continues(m, after: i > 0 ? list[i - 1] : nil), replies: store.replyCounts[m.id] ?? 0,
            thread: ThreadRef(channelId: channel.id, rootId: m.id), working: inThreads.filter { store.activityThread[$0.id] == m.id || (store.activityPath[$0.id] ?? []).contains(m.id) })
          .id(m.id)
        }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
      .padding(.bottom, 8)
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: list.last?.id) { Bottom.follow(proxy) }
    // a lazy stack measures tall rows (a long reply) only as they're laid out, so the first scroll
    // to the end can land past it and show nothing; settle on the real end once layout is done
    .task(id: list.last?.id) {
      try? await Task.sleep(for: .milliseconds(300))
      Bottom.follow(proxy)
    }
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if current.archivedAt != nil {
        Text("#\(current.name) is archived").font(.footnote).foregroundStyle(.secondary).padding()
      } else {
        VStack(spacing: 6) {
          ActivityPill(channel: current)
          Composer(placeholder: placeholder, channelId: channel.id) { text, files in
            try await store.send(text, in: channel.id, files: files)
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
            VStack(spacing: 0) {
              HStack(spacing: 4) {
                Image(systemName: current.private == true ? "lock" : "number")
                Text(current.name).lineLimit(1)
              }
              .font(.subheadline.weight(.semibold))
              // who leads here, from the channel's team: "Atlas and Nova lead here"
              if let leads = current.leadLine(agents: store.agents) {
                Text(leads).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
              }
            }
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

/**
 * A thread. Any reply in it can start a thread of its own (a sub-thread), which shows its reply
 * count and who's working in it; a sub-thread links back up to the thread it came from.
 */
struct ThreadView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var ref: ThreadRef
  @State private var loading = false
  @State private var loadingEarlier = false
  @State private var earlierFailed = false
  @State private var error: String?

  private var root: Message? { store.message(ref.rootId, in: ref.channelId) }
  private var replies: [Message] { store.threads[ref.rootId] ?? [] }
  /** the thread this one branched off from */
  private var parent: String? { root?.threadId }
  private var below: [Agent] { store.working(in: ref.channelId, thread: ref.rootId).filter { store.activityThread[$0.id] != ref.rootId } }

  var body: some View {
    ScrollViewReader { proxy in
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if let parent { upLink(parent) }
        if loading {
          ProgressView().frame(maxWidth: .infinity).padding(.vertical, 10)
        }
        if let error {
          HStack {
            Text(error).foregroundStyle(.secondary)
            Button("Try again") { Task { if earlierFailed { await loadEarlier() } else { await load() } } }.disabled(loading || loadingEarlier)
          }.font(.footnote).padding(.horizontal, 16).padding(.vertical, 10)
        }
        if store.threads[ref.rootId] != nil && !store.noEarlierThreads.contains(ref.rootId) {
          Button(loadingEarlier ? "Loading…" : "Show earlier messages") {
            Task { await loadEarlier() }
          }
          .disabled(loadingEarlier || loading)
          .font(.footnote)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 10)
        }
        if let root {
          MessageRow(message: root, compact: false, replies: 0, thread: nil)
          HStack {
            Text(replies.count == 1 ? "1 reply" : "\(replies.count) replies").font(.caption).foregroundStyle(.secondary)
            VStack { Divider() }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 6)
        }
        ForEach(replies) { m in
          MessageRow(message: m, compact: false, replies: store.replyCounts[m.id] ?? 0,
            thread: ThreadRef(channelId: ref.channelId, rootId: m.id, from: ref.rootId),
            working: below.filter { store.activityThread[$0.id] == m.id || (store.activityPath[$0.id] ?? []).contains(m.id) })
        }
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
          if let ch = store.channels.first(where: { $0.id == ref.channelId }) { ActivityPill(channel: ch, thread: ref.rootId) }
          Composer(placeholder: "Reply", channelId: ref.channelId) { text, files in try await store.send(text, in: ref.channelId, thread: ref.rootId, files: files) }
        }
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .navigationTitle(parent == nil ? "Thread" : "Sub-thread")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: ref) { await load() }
    .onAppear { store.openThreads[ref.rootId] = ref.channelId }
    .onDisappear { store.openThreads[ref.rootId] = nil }
  }

  private func loadEarlier() async {
    loadingEarlier = true
    error = nil
    do {
      _ = try await store.loadEarlier(ref.channelId, thread: ref.rootId)
      earlierFailed = false
    } catch {
      earlierFailed = true
      self.error = "Couldn't load earlier messages."
    }
    loadingEarlier = false
  }

  private func load() async {
    loading = true
    earlierFailed = false
    error = nil
    do { try await store.loadMessages(ref.channelId, thread: ref.rootId) }
    catch { self.error = "Couldn't load this thread." }
    loading = false
  }

  /** Back to the thread this one came from: just back, when that's where it was opened from. */
  @ViewBuilder private func upLink(_ parent: String) -> some View {
    let label = HStack(spacing: 6) {
      Image(systemName: "arrow.turn.left.up")
      Text("Sub-thread of “\(ThreadTitle.of(store.message(parent, in: ref.channelId)))”").lineLimit(1)
      Spacer(minLength: 0)
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 16)
    .padding(.top, 10)
    if ref.from == parent {
      Button { dismiss() } label: { label }.buttonStyle(.plain).accessibilityHint("Back to the thread it came from")
    } else {
      NavigationLink(value: ThreadRef(channelId: ref.channelId, rootId: parent)) { label }.buttonStyle(.plain).accessibilityHint("Opens the thread it came from")
    }
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
        if let team = channel.team(agents: store.agents) {
          let leads = team.leads.compactMap { store.agent($0)?.name }
          Text("\(ChannelTeam.list(leads)) \(leads.count > 1 ? "read every new message here, plan it together and hand" : "reads every new message here, plans it and hands") the work to the team in a thread. @mention an agent to ask it directly.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
    .padding(.horizontal, 24)
  }
}

struct Composer: View {
  @Environment(Store.self) private var store
  var placeholder: String
  /** where attachments are shared, so only people who can see the conversation can open them */
  var channelId: String?
  var send: (String, [String]) async throws -> Void
  @State private var text = ""
  @State private var files: [UploadedFile] = []
  @State private var uploading = 0
  @State private var sending = false
  @State private var error: String?
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var photos: [PhotosPickerItem] = []
  @FocusState private var focused: Bool

  private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty }
  private var blocked: Bool { empty || sending || uploading > 0 }

  var body: some View {
    VStack(spacing: 4) {
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
      VStack(alignment: .leading, spacing: 0) {
        if !files.isEmpty || uploading > 0 { attachments }
        HStack(alignment: .bottom, spacing: 6) {
          Menu {
            Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
            Button("Files", systemImage: "folder") { pickingFiles = true }
          } label: {
            Image(systemName: "plus")
              .font(.body.weight(.semibold))
              .foregroundStyle(.secondary)
              .frame(width: 36, height: 36)
          }
          .padding(.leading, 5)
          .padding(.bottom, 5)
          .accessibilityLabel("Attach")
          TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...8)
            .focused($focused)
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
          .disabled(blocked)
          .opacity(blocked ? 0.25 : 1)
          .animation(.snappy, value: blocked)
          .padding(5)
          .accessibilityLabel("Send")
        }
      }
      // the message bar floats over the conversation on glass, like the tab bar
      .glass(23, interactive: true)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 6)
    .padding(.top, 4)
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      for item in items { upload { try await photo(item) } }
    }
    .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      switch result {
      case .success(let urls):
        for url in urls {
          upload {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return (try Data(contentsOf: url), url.lastPathComponent, UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
          }
        }
      case .failure(let e): error = e.localizedDescription
      }
    }
  }

  /** What's attached so far, each with a way to take it off again. */
  private var attachments: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(files) { f in
          HStack(spacing: 4) {
            Image(systemName: UploadedFile.isImage(f.name) ? "photo" : "doc")
            Text(f.name).lineLimit(1).frame(maxWidth: 160)
            Button { files.removeAll { $0.id == f.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
              .buttonStyle(.plain)
              .accessibilityLabel("Remove \(f.name)")
          }
          .font(.caption)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(Capsule().fill(Color(.tertiarySystemFill)))
        }
        if uploading > 0 {
          ProgressView().controlSize(.small).padding(.horizontal, 6).accessibilityLabel("Uploading")
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 10)
    }
  }

  private func upload(_ read: @escaping () async throws -> (Data, String, String?)) {
    uploading += 1
    error = nil
    Task {
      do {
        let (data, name, mime) = try await read()
        files.append(try await store.uploadFile(data, name: name, mime: mime, channelId: channelId))
      } catch { self.error = error.localizedDescription }
      uploading -= 1
    }
  }

  /** A photo or video from the library; photos go up as JPEG, so every app (and the web) can show them. */
  private func photo(_ item: PhotosPickerItem) async throws -> (Data, String, String?) {
    guard let data = try await item.loadTransferable(type: Data.self) else { throw API.Failure(status: 0, message: "Couldn't read that photo.") }
    let type = item.supportedContentTypes.first
    let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false)).replacingOccurrences(of: ":", with: "-")
    if type?.conforms(to: .image) == true, ![UTType.png, .gif, .jpeg].contains(where: { type?.conforms(to: $0) == true }),
       let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) {
      return (jpeg, "Photo \(stamp).jpg", "image/jpeg")
    }
    let ext = type?.preferredFilenameExtension ?? "jpg"
    return (data, "\(type?.conforms(to: .movie) == true ? "Video" : "Photo") \(stamp).\(ext)", type?.preferredMIMEType)
  }

  static func restoringFailedText(_ failed: String, current: String) -> String {
    current.isEmpty ? failed : current
  }

  private func submit() {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !blocked else { return }
    let attached = files
    sending = true
    error = nil
    text = ""
    files = []
    Task {
      do { try await send(body, attached.map(\.id)) } catch {
        self.error = error.localizedDescription
        text = Self.restoringFailedText(body, current: text)
        files = attached + files
      }
      sending = false
    }
  }
}
