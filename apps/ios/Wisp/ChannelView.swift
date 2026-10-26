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
  /** text to start the message with (a request to try a skill) */
  var draft = ""
  @State private var error: String?
  @State private var loadingEarlier = false
  @State private var call: CallController?
  @State private var showDetails = false
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
        ForEach(store.streaming(in: channel.id, thread: nil)) { StreamingRow(run: $0) }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
      .padding(.bottom, 8)
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: list.last?.id) { Bottom.follow(proxy) }
    .onChange(of: store.liveLength) { Bottom.follow(proxy) }
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
        Text("\(current.name) is archived").font(.footnote).foregroundStyle(.secondary).padding()
      } else {
        VStack(spacing: 6) {
          ActivityPill(channel: current)
          Composer(placeholder: placeholder, channelId: channel.id, refresh: list.count, draft: draft, send: { text, files in
            try await store.send(text, in: channel.id, files: files)
          }, onCall: canCall && call == nil ? { startCall() } : nil, callLabel: "Call \(store.dmAgent(current)?.name ?? "agent")")
        }
        .animation(.snappy, value: store.agents.filter { $0.status == .busy }.map(\.id))
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .toolbar(.hidden, for: .navigationBar)
    .background(Palette.ground.ignoresSafeArea())
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        chrome
        // a call shrunk from full screen sits under the top bar
        if let call, !call.expanded { CallBar(call: call).transition(.move(edge: .top).combined(with: .opacity)) }
      }.animation(.snappy, value: call?.expanded)
    }
    .callLifecycle(call)
    .navigationDestination(isPresented: $showDetails) {
      if let agent = store.dmAgent(current) { AgentPage(agent: agent) } else { ChannelDetails(channel: current) }
    }
    .fullScreenCover(isPresented: Binding(get: { call?.expanded == true }, set: { if !$0 { call?.expanded = false } })) {
      if let call { CallScreen(call: call) }
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
    .onDisappear {
      if store.openChannel == channel.id { store.openChannel = nil }
      // leaving the chat (not opening the agent's profile from it) hangs up
      if !showDetails, let call { call.end(store: store); self.call = nil }
    }
  }

  private func startCall() {
    guard let agent = store.dmAgent(current), call == nil else { return }
    let started = CallController(agent: agent, channel: current)
    started.onHangUp = { call = nil }
    call = started
    Task { await started.begin(store: store) }
  }

  private var placeholder: String {
    if let agent = store.dmAgent(current) { return "Ask \(agent.name)" }
    return "Message \(current.name)"
  }

  /** a voice call is on offer in a chat with one agent when voice is on */
  private var canCall: Bool { store.features.voice && current.archivedAt == nil && store.dmAgent(current) != nil }

  /** teams show their first two agents on the name pill */
  private var teamAgents: [Agent] {
    guard let team = current.team(agents: store.agents) else { return [] }
    return team.nodes.sorted { ($0.lead ? 0 : 1) < ($1.lead ? 0 : 1) }.compactMap { store.agent($0.agentId) }
  }

  /** the top of a chat: a glass back circle, the name on a pill with the ghost, and a ... circle */
  private var chrome: some View {
    TopBar {
      CircleButton(symbol: "chevron.left", label: "Back", id: "chat-back") { dismiss() }
    } center: {
      Button { showDetails = true } label: {
        NamePill(title: store.title(of: current)) {
          if let agent = store.dmAgent(current) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
          else { TeamGhosts(agents: teamAgents, seed: current.name, size: 28) }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(store.dmAgent(current) != nil ? "\(store.title(of: current)), open profile" : "\(current.name), team details")
      .accessibilityIdentifier("chat-title")
    } trailing: {
      Menu {
        if canCall, call == nil, let agent = store.dmAgent(current) { Button("Call \(agent.name)", systemImage: "phone") { startCall() } }
        if let agent = store.dmAgent(current) { Button("\(agent.name)'s profile", systemImage: "person.crop.circle") { showDetails = true } }
        else { Button("Team details", systemImage: "person.2") { showDetails = true } }
      } label: { CircleLabel(symbol: "ellipsis") }
        .accessibilityLabel("More").accessibilityIdentifier("chat-more")
    }
    .background(alignment: .top) {
      LinearGradient(colors: [Palette.ground, Palette.ground.opacity(0)], startPoint: .top, endPoint: .bottom)
        .padding(.bottom, -10).ignoresSafeArea(edges: .top).allowsHitTesting(false)
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
        if let parent { upLink(parent) } else { FlowStrip(channelId: ref.channelId, threadId: ref.rootId) }
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
        ForEach(store.streaming(in: ref.channelId, thread: ref.rootId)) { StreamingRow(run: $0) }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: replies.last?.id) { Bottom.follow(proxy) }
    .onChange(of: store.liveLength) { Bottom.follow(proxy) }
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if store.channels.first(where: { $0.id == ref.channelId })?.archivedAt != nil {
        Text("This team is archived").font(.footnote).foregroundStyle(.secondary).padding()
      } else {
        VStack(spacing: 6) {
          if let ch = store.channels.first(where: { $0.id == ref.channelId }) { ActivityPill(channel: ch, thread: ref.rootId) }
          Composer(placeholder: "Reply", channelId: ref.channelId, thread: ref.rootId, refresh: replies.count) { text, files in try await store.send(text, in: ref.channelId, thread: ref.rootId, files: files) }
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
        Text(channel.name).font(.title3.bold())
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
  /** the thread it replies in, which keeps its own saved draft */
  var thread: String? = nil
  /** changes when the conversation moves on, so the context ring catches up */
  var refresh = 0
  /** what the message starts with, instead of the saved draft (a request to try a skill) */
  var draft = ""
  var send: (String, [String]) async throws -> Void
  /** starts a voice call with the agent: the white voice button shows while the field is empty */
  var onCall: (() -> Void)? = nil
  var callLabel = "Start a voice call"
  @State private var dictation = Dictation()
  @State private var dictationBase = ""
  @State private var text = ""
  @State private var selection: TextSelection?
  @State private var files: [UploadedFile] = []
  @State private var uploading = 0
  @State private var sending = false
  @State private var error: String?
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var slash = SlashMenuModel()
  @FocusState private var focused: Bool

  private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty }
  private var blocked: Bool { empty || sending || uploading > 0 }

  private var caret: Int {
    // The selection is only updated after the text changes, so for a moment its index can point past the end of a shorter text
    // (or into another string, after a send or a draft load); measuring from it would trap.
    if let selection, case .selection(let range) = selection.indices, range.lowerBound <= text.endIndex {
      return text.distance(from: text.startIndex, to: range.lowerBound)
    }
    return text.count
  }
  private var suggestions: [ComposerMentions.Suggestion] {
    focused ? ComposerMentions.suggestions(text, caret: caret, agents: store.agents, people: store.members.filter { $0.id != store.me?.id }) : []
  }

  private var channel: Channel? { channelId.flatMap { id in store.channels.first { $0.id == id } } }
  private var chatAgent: Agent? { channel.flatMap { store.dmAgent($0) } }
  private var draftKey: String? { channelId.map { ComposerDrafts.key(channel: $0, thread: thread) } }
  private var slashQuery: SlashQuery.Parsed? {
    focused && channel != nil ? SlashQuery.parse(String(text.prefix(caret))) : nil
  }
  private var slashHere: [Agent] {
    SlashMenu.agentsHere(isDm: chatAgent != nil, dmAgent: chatAgent, agents: store.agents, members: slash.members, handle: slashQuery?.handle)
  }

  var body: some View {
    VStack(spacing: 4) {
      if let q = slashQuery {
        let here = slashHere
        let groups = SlashMenu.groups(here: here, lists: slash.lists, only: slash.only, query: q.query)
        if !groups.isEmpty || here.contains(where: { slash.lists[$0.id] == nil }) {
          SlashMenuView(here: here, groups: groups, loading: here.contains { slash.lists[$0.id] == nil }, only: $slash.only) { command, agent in
            let done = SlashMenu.replacing(text, caret: caret, with: SlashMenu.text(for: command, agent: agent, isDm: chatAgent != nil))
            text = done.text
            selection = TextSelection(insertionPoint: text.index(text.startIndex, offsetBy: done.caret))
            focused = true
          }
        }
      }
      if !suggestions.isEmpty {
        VStack(spacing: 0) {
          ForEach(suggestions) { suggestion in
            Button {
              let completed = ComposerMentions.inserting(suggestion.handle, into: text, caret: caret)
              text = completed.text
              selection = TextSelection(insertionPoint: text.index(text.startIndex, offsetBy: completed.caret))
              focused = true
            } label: {
              HStack(spacing: 10) {
                if suggestion.actor.kind == .agent {
                  AgentAvatar(agent: store.agent(suggestion.actor.id), size: 24, showStatus: false)
                } else {
                  Image(systemName: "person.crop.circle").frame(width: 24, height: 24)
                }
                Text(suggestion.name).fontWeight(.medium)
                Text("@\(suggestion.handle)").foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
              }
              .font(.subheadline)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .contentShape(Rectangle())
            }.buttonStyle(.plain)
          }
        }
        .glass(18)
      }
      if let error = error ?? dictation.error { Text(error).font(.caption).foregroundStyle(Palette.red).padding(.horizontal, 6) }
      if let agent = chatAgent, let channelId { ChatControls(agent: agent, channelId: channelId, thread: thread, refresh: refresh) }
      if !files.isEmpty || uploading > 0 { attachments }
      HStack(alignment: .center, spacing: 12) {
        Menu {
          Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
          Button("Files", systemImage: "folder") { pickingFiles = true }
        } label: { CircleLabel(symbol: "plus", size: 56, weight: .regular) }
          .accessibilityLabel("Attach").accessibilityIdentifier("composer-attach")
        HStack(alignment: .bottom, spacing: 6) {
          TextField(placeholder, text: $text, selection: $selection, axis: .vertical)
            .font(.system(size: 17))
            .lineLimit(1...8)
            .focused($focused)
            .padding(.vertical, 15)
            .padding(.leading, 12)
            .accessibilityIdentifier("composer-field")
          Button {
            if !dictation.active { dictationBase = text }
            dictation.toggle { transcript in
              text = dictationBase.isEmpty ? transcript : dictationBase + (dictationBase.hasSuffix(" ") ? "" : " ") + transcript
            }
          } label: {
            Image(systemName: dictation.active ? "mic.fill" : "mic")
              .font(.system(size: 18, weight: .regular))
              .foregroundStyle(dictation.active ? Palette.blue : Palette.muted)
              .frame(width: 40, height: 40)
          }
          .buttonStyle(.plain)
          .padding(.bottom, 8)
          .accessibilityLabel(dictation.active ? "Stop dictating" : "Dictate")
          if !empty || sending || onCall == nil {
            Button { submit() } label: {
              Image(systemName: sending ? "ellipsis" : "arrow.up")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Palette.ground)
                .frame(width: 56, height: 44)
                .background(Capsule().fill(Palette.text))
            }
            .buttonStyle(.plain)
            .disabled(blocked)
            .opacity(blocked ? 0.3 : 1)
            .animation(.snappy, value: blocked)
            .padding(.bottom, 6).padding(.trailing, 6)
            .accessibilityLabel("Send").accessibilityIdentifier("composer-send")
          } else if let onCall {
            Button(action: onCall) {
              Image(systemName: "waveform")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Palette.ground)
                .frame(width: 56, height: 44)
                .background(Capsule().fill(Palette.text))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 6).padding(.trailing, 6)
            .accessibilityLabel(callLabel).accessibilityIdentifier("composer-call")
          }
        }
        .frame(minHeight: 56)
        .background {
          if #available(iOS 26, *) {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.clear).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28, style: .continuous))
          } else {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Palette.control)
              .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Palette.hairline))
          }
        }
      }
    }
    .padding(.horizontal, 18)
    .padding(.bottom, 8)
    .padding(.top, 4)
    .task(id: slashQuery != nil) {
      guard slashQuery != nil, let channelId else { return }
      if chatAgent == nil { await slash.loadMembers(store, channelId: channelId) }
      await slash.load(store, agents: slashHere)
    }
    .task(id: slashHere.map(\.id)) { if slashQuery != nil { await slash.load(store, agents: slashHere) } }
    .onAppear {
      guard text.isEmpty else { return }
      if !draft.isEmpty { text = draft } else if let draftKey { text = ComposerDrafts.load(draftKey) }
    }
    .onChange(of: text) { _, new in if let draftKey { ComposerDrafts.save(new, key: draftKey) } }
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
    dictation.stop()
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

enum ComposerMentions {
  struct Suggestion: Identifiable, Equatable {
    var actor: Actor
    var name: String
    var handle: String
    var id: String { "\(actor.kind.rawValue):\(actor.id)" }
  }

  private static func range(_ text: String, caret: Int) -> Range<String.Index>? {
    guard (0...text.count).contains(caret) else { return nil }
    let end = text.index(text.startIndex, offsetBy: caret)
    let before = String(text[..<end])
    guard before.range(of: #"(?:^|\s)@([A-Za-z0-9_-]*)\z"#, options: .regularExpression) != nil,
          let at = text[..<end].lastIndex(of: "@") else { return nil }
    return at..<end
  }

  static func query(_ text: String, caret: Int) -> String? {
    range(text, caret: caret).map { String(text[$0].dropFirst()) }
  }

  static func suggestions(_ text: String, caret: Int, agents: [Agent], people: [Member]) -> [Suggestion] {
    guard let word = query(text, caret: caret)?.lowercased() else { return [] }
    let candidates = agents.map { Suggestion(actor: Actor(kind: .agent, id: $0.id), name: $0.name, handle: $0.handle) } +
      people.compactMap { p in personHandle(p).map { Suggestion(actor: Actor(kind: .user, id: p.id), name: p.name, handle: $0) } }
    return Array(candidates.filter { $0.handle.lowercased().hasPrefix(word) || $0.name.lowercased().hasPrefix(word) }.prefix(6))
  }

  /** What the hub notifies a person for: their preferred name, else their first name (one word either way). */
  static func personHandle(_ p: Member) -> String? {
    let word = { (s: String?) in s?.split(whereSeparator: \.isWhitespace).first.map(String.init) }
    return word(p.preferredName) ?? word(p.name)
  }

  static func inserting(_ handle: String, into text: String, caret: Int) -> (text: String, caret: Int) {
    guard let range = range(text, caret: caret) else { return (text, caret) }
    let before = String(text[..<range.lowerBound]) + "@\(handle) "
    return (before + text[range.upperBound...], before.count)
  }
}
