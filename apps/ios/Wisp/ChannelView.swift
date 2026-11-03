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
  @State private var showTeam = false
  @State private var noEarlier = false
  @State private var flashed: String?
  @State private var attachTrigger = 0
  @State private var tool: ChatTool?
  /** what the agent in a DM runs on: the line over the message box and the ring in the header */
  @State private var run = RunInfo()
  @State private var showRun = false
  /** the first batch of messages has settled: from here a new message animates in */
  @State private var settled = false
  @Environment(\.dismiss) private var dismiss
  @ReduceMotion private var reduceMotion

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
        } else if list.isEmpty && store.streaming(in: channel.id, thread: nil).isEmpty {
          EmptyChannel(channel: current, onAddAgent: { showTeam = true }, onAddFiles: { attachTrigger += 1 }, onInvite: { showDetails = true })
        }
        ForEach(Array(list.enumerated()), id: \.element.id) { i, m in
          let prev = i > 0 ? list[i - 1] : nil
          let next = i + 1 < list.count ? list[i + 1] : nil
          let chat = ChatFormat.startsChat(prev, m)
          let stamp = chat || ChatFormat.needsStamp(prev, m)
          if chat { ChatDivider(date: m.date, onContinue: continueAction(m.conversationId)) }
          else if stamp { TimeDivider(date: m.date) }
          MessageRow(message: m, compact: !stamp && ChatFormat.groups(prev, m), last: next == nil || ChatFormat.breaks(m, next!) || !ChatFormat.groups(m, next!), replies: store.replyCounts[m.id] ?? 0,
            thread: ThreadRef(channelId: channel.id, rootId: m.id), working: inThreads.filter { store.activityThread[$0.id] == m.id || (store.activityPath[$0.id] ?? []).contains(m.id) })
            .arrival(mine: m.author == Actor(kind: .user, id: store.me?.id ?? ""))
        }
        ForEach(store.streaming(in: channel.id, thread: nil)) { StreamingRow(run: $0).workingArrival() }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
      .padding(.bottom, 8)
      .messageArrivals(list.last?.id, settled: settled)
      .messageArrivals(store.streaming(in: channel.id, thread: nil).map(\.id), settled: settled)
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
    .environment(\.scrollToMessage) { id in
      withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
      flashed = id
      Task { try? await Task.sleep(for: .milliseconds(1400)); if flashed == id { flashed = nil } }
    }
    .environment(\.flashedMessage, flashed)
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if current.archivedAt != nil {
        ArchivedBar(channel: current)
      } else {
        VStack(spacing: 6) {
          ActivityPill(channel: current)
          VStack(alignment: .leading, spacing: 0) {
            if let agent = store.dmAgent(current), run.context != nil {
              RunSummaryLine(agent: agent, info: run) { showRun = true }
                .padding(.leading, 82).padding(.trailing, 18)
                .transition(.opacity)
            }
            composer
          }
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
        if let call, !call.expanded { CallBar(call: call).transition(reduceMotion ? .opacity : .scale(scale: 0.92, anchor: .top).combined(with: .move(edge: .top)).combined(with: .opacity)) }
      }.animation(Motion.pick(Motion.pop, reduceMotion), value: call?.expanded)
    }
    .callLifecycle(call)
    .navigationDestination(isPresented: $showDetails) {
      if let agent = store.dmAgent(current) { AgentPage(agent: agent) } else { TeamInfoPage(channel: current) }
    }
    .navigationDestination(isPresented: $showTeam) { ChannelTeamScreen(channel: current) }
    .fullScreenCover(isPresented: Binding(get: { call?.expanded == true }, set: { if !$0 { call?.expanded = false } })) {
      if let call { CallScreen(call: call) }
    }
    .sheet(item: $tool) { ChatToolSheet(tool: $0, channelId: channel.id) }
    .sheet(isPresented: $showRun) {
      if let agent = store.dmAgent(current) { RunSheet(agentId: agent.id, channelId: channel.id, info: run) }
    }
    .task(id: runKey) {
      guard let agent = store.dmAgent(current) else { return }
      await run.load(store, agent: agent, channel: channel.id, thread: nil)
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
      settled = false
      store.openChannel = channel.id
      do { try await store.loadMessages(channel.id) } catch { self.error = error.localizedDescription }
      store.markRead(channel.id)
      // from here a new message is live; the history the fetch brought in (cached or not) never pops
      try? await Task.sleep(for: .milliseconds(300))
      if !Task.isCancelled { settled = true }
    }
    .onDisappear {
      if store.openChannel == channel.id { store.openChannel = nil }
    }
    .messageActionsHost()
  }

  /** "Continue this chat" on a chat's divider: a reply to the chat's last loaded message. */
  private func continueAction(_ chat: String?) -> (() -> Void)? {
    guard let chat, let last = ChatFormat.lastOfChat(chat, in: list), store.canReply(last) else { return nil }
    return { store.startReply(last, thread: nil) }
  }

  /** reloads what the agent runs on when a reply lands or its settings change */
  private var runKey: String {
    guard let a = store.dmAgent(current) else { return "" }
    return "\(a.id)/\(list.count)/\(a.harness)/\(a.model ?? "")/\(a.settings?.effort ?? "")/\(a.settings?.connectionId ?? "")/\(store.modelsVersion)"
  }

  private var composer: some View {
    Composer(placeholder: placeholder, channelId: channel.id, refresh: list.count, draft: draft, attachTrigger: attachTrigger, send: { text, files, replyTo in
            try await store.send(text, in: channel.id, files: files, replyTo: replyTo)
          }, onCall: canCall && call == nil ? { startCall() } : nil, callLabel: "Call \(store.dmAgent(current)?.name ?? "agent")", onModelCommand: store.dmAgent(current).map { _ in { showRun = true } }, callLive: call != nil)
  }

  /** only really leaving the chat hangs up; opening a thread, the profile or the full-screen call doesn't */
  private var hangUpWhenLeaving: some View {
    LeavingWatcher { if let call { call.end(store: store); self.call = nil } }.frame(width: 0, height: 0)
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
    current.iconAgents(store.agents)
  }

  /** the top of a chat: a glass back circle, the name on a pill with the ghost, and a ... circle */
  private var chrome: some View {
    TopBar(inset: store.dmAgent(current) != nil && run.context != nil ? 100 : 64) {
      CircleButton(symbol: "chevron.left", label: "Back", id: "chat-back") { dismiss() }
    } center: {
      Button { showDetails = true } label: {
        NamePill(title: store.title(of: current)) {
          if let agent = store.dmAgent(current) { AgentAvatar(agent: agent, size: 36, showStatus: false) }
          else { TeamGhosts(agents: teamAgents, seed: current.name, size: 34, iconFileId: current.settings?.iconFileId) }
        }
        .overlay(alignment: .bottom) {
          if current.archivedAt != nil { Text("Archived").font(.system(size: 11)).foregroundStyle(Palette.muted).offset(y: 14) }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(store.dmAgent(current) != nil ? "\(store.title(of: current)), open profile" : "\(current.name), team info")
      .accessibilityIdentifier("chat-title")
    } trailing: {
      HStack(spacing: 6) {
      if store.dmAgent(current) != nil, let ctx = run.context { HeaderContextRing(fraction: ctx.fraction) { showRun = true } }
      Menu {
        if let agent = store.dmAgent(current) {
          if canCall, call == nil { Button("Call \(agent.name)", systemImage: "phone") { startCall() }.tint(Palette.call) }
          Button("About \(agent.name)", systemImage: "person.crop.circle") { showDetails = true }
          if store.role != "guest" { Button("Harness, model and effort", systemImage: "cpu") { showRun = true } }
          Button("What it can do", systemImage: "shield") { tool = .access(agent) }
          Button("Context window", systemImage: "gauge.with.dots.needle.33percent") { tool = .context(agent) }
        } else {
          Button("Team info", systemImage: "person.2") { showDetails = true }
          Menu("Notify me", systemImage: "bell") {
            Picker("Notify me", selection: Binding(get: { current.notify ?? "default" }, set: { v in Task { try? await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(v)]) } })) {
              Text("Every message").tag("all")
              Text("Just what's for me").tag("default")
              Text("Mute").tag("mute")
            }
          }
          Button("How the team works", systemImage: "point.3.connected.trianglepath.dotted") { showTeam = true }
          Button((current.starred ?? false) ? "Unpin from the top" : "Pin to the top", systemImage: "pin") {
            Task { try? await store.setChannelPrefs(channel.id, ["starred": AnyEncodable(!(current.starred ?? false))]) }
          }
        }
      } label: { CircleLabel(symbol: "ellipsis") }
        .accessibilityLabel("More").accessibilityIdentifier("chat-more")
      }
    }
    .background(alignment: .top) {
      LinearGradient(colors: [Palette.ground, Palette.ground.opacity(0)], startPoint: .top, endPoint: .bottom)
        .padding(.bottom, -10).ignoresSafeArea(edges: .top).allowsHitTesting(false)
    }
    .background { hangUpWhenLeaving }
  }
}

/** Where the message bar would be, in an archived team. */
struct ArchivedBar: View {
  @Environment(Store.self) private var store
  var channel: Channel
  @State private var action = FormAction()

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "archivebox").font(.system(size: 18)).foregroundStyle(Palette.muted)
      VStack(alignment: .leading, spacing: 1) {
        Text("This team is archived").font(.system(size: 15, weight: .semibold))
        Text("Nobody can post. Notes stay.").font(.system(size: 13)).foregroundStyle(Palette.muted)
      }
      Spacer(minLength: 8)
      if store.canManage {
        Button("Unarchive") { action.run { try await store.archiveChannel(channel.id, archived: false) } }
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ground)
          .padding(.horizontal, 16).frame(height: 40).background(Capsule().fill(Palette.text))
          .disabled(action.busy)
      }
    }
    .padding(16)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .padding(.horizontal, 18)
    .padding(.bottom, 8)
  }
}

/**
 * A thread. Any reply in it can start a thread of its own (a sub-thread), which shows its reply
 * count and who's working in it; a sub-thread links back up to the thread it came from. A step
 * Wisp handed out opens as its own thread, headed "Handed to Pappy".
 */
struct ThreadView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var ref: ThreadRef
  @State private var loading = false
  @State private var loadingEarlier = false
  @State private var earlierFailed = false
  @State private var error: String?
  @State private var flashed: String?
  /** the first batch of replies has settled: from here a new one animates in */
  @State private var settled = false
  /** in a DM's thread, what the agent runs on: the same quiet line over the message box */
  @State private var run = RunInfo()
  @State private var showRun = false

  private var root: Message? { store.message(ref.rootId, in: ref.channelId) }
  private var replies: [Message] { store.threads[ref.rootId] ?? [] }
  /** the same count the chat shows, so an unloaded thread never says a false "0" */
  private var threadCountLine: String {
    let n = max(store.threads[ref.rootId]?.count ?? 0, store.replyCounts[ref.rootId] ?? 0)
    return n == 1 ? "1 reply" : "\(n) replies"
  }
  /** the thread this one branched off from */
  private var parent: String? { root?.threadId }
  private var below: [Agent] { store.working(in: ref.channelId, thread: ref.rootId).filter { store.activityThread[$0.id] != ref.rootId } }
  private var channel: Channel? { store.channels.first { $0.id == ref.channelId } }
  private var handoffTask: String? {
    guard let root, root.author.id == "system" else { return nil }
    return root.parts.lazy.compactMap { if case .task(let id) = $0 { id } else { nil } }.first
  }

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
          if let task = handoffTask { HandoffBrief(message: root, taskId: task) } else { ThreadRoot(message: root) }
          HStack {
            Text(threadCountLine).font(.system(size: 13)).foregroundStyle(Palette.muted)
            VStack { Rectangle().fill(Palette.separator).frame(height: 1) }
          }
          .padding(.horizontal, 18)
          .padding(.vertical, 8)
        }
        ForEach(Array(replies.enumerated()), id: \.element.id) { i, m in
          let prev = i > 0 ? replies[i - 1] : nil
          let next = i + 1 < replies.count ? replies[i + 1] : nil
          let stamp = i > 0 && ChatFormat.needsStamp(prev, m)
          if stamp { TimeDivider(date: m.date) }
          MessageRow(message: m, compact: !stamp && ChatFormat.groups(prev, m), last: next == nil || ChatFormat.breaks(m, next!) || !ChatFormat.groups(m, next!), replies: store.replyCounts[m.id] ?? 0,
            thread: ThreadRef(channelId: ref.channelId, rootId: m.id, from: ref.rootId),
            working: below.filter { store.activityThread[$0.id] == m.id || (store.activityPath[$0.id] ?? []).contains(m.id) },
            composerThread: ref.rootId)
            .arrival(mine: m.author == Actor(kind: .user, id: store.me?.id ?? ""))
        }
        ForEach(store.streaming(in: ref.channelId, thread: ref.rootId)) { StreamingRow(run: $0).workingArrival() }
        Color.clear.frame(height: 1).id(Bottom.id)
      }
      .messageArrivals(replies.last?.id, settled: settled)
      .messageArrivals(store.streaming(in: ref.channelId, thread: ref.rootId).map(\.id), settled: settled)
    }
    .defaultScrollAnchor(.bottom)
    .onChange(of: replies.last?.id) { Bottom.follow(proxy) }
    .onChange(of: store.liveLength) { Bottom.follow(proxy) }
    .environment(\.scrollToMessage) { id in
      withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
      flashed = id
      Task { try? await Task.sleep(for: .milliseconds(1400)); if flashed == id { flashed = nil } }
    }
    .environment(\.flashedMessage, flashed)
    }
    .scrollDismissesKeyboard(.interactively)
    .safeAreaInset(edge: .bottom) {
      if channel?.archivedAt != nil {
        ArchivedBar(channel: channel!)
      } else {
        VStack(spacing: 6) {
          if let ch = channel { ActivityPill(channel: ch, thread: ref.rootId) }
          VStack(alignment: .leading, spacing: 0) {
            if let agent = dmAgent, run.context != nil {
              RunSummaryLine(agent: agent, info: run) { showRun = true }
                .padding(.leading, 82).padding(.trailing, 18)
                .transition(.opacity)
            }
            Composer(placeholder: handoffAgent.map { "Reply to \($0.name)" } ?? "Reply…", channelId: ref.channelId, thread: ref.rootId, refresh: replies.count) { text, files, replyTo in
              try await store.send(text, in: ref.channelId, thread: ref.rootId, files: files, replyTo: replyTo)
            }
          }
        }
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .toolbar(.hidden, for: .navigationBar)
    .background(Palette.ground.ignoresSafeArea())
    .safeAreaInset(edge: .top, spacing: 0) { chrome }
    .task(id: ref) {
      settled = false
      await load()
      try? await Task.sleep(for: .milliseconds(300))
      if !Task.isCancelled { settled = true }
    }
    .sheet(isPresented: $showRun) {
      if let agent = dmAgent { RunSheet(agentId: agent.id, channelId: ref.channelId, info: run) }
    }
    .task(id: runKey) {
      guard let agent = dmAgent else { return }
      await run.load(store, agent: agent, channel: ref.channelId, thread: ref.rootId)
    }
    .onAppear { store.openThreads[ref.rootId] = ref.channelId }
    .onDisappear { store.openThreads[ref.rootId] = nil }
    .messageActionsHost()
  }

  private var dmAgent: Agent? { channel.flatMap { store.dmAgent($0) } }

  /** reloads what the agent runs on when a reply lands or its settings change */
  private var runKey: String {
    guard let a = dmAgent else { return "" }
    return "\(a.id)/\(ref.rootId)/\(replies.count)/\(a.harness)/\(a.model ?? "")/\(a.settings?.effort ?? "")/\(a.settings?.connectionId ?? "")/\(store.modelsVersion)"
  }

  private var handoffAgent: Agent? {
    handoffTask.flatMap { id in store.tasks.first { $0.id == id } }.flatMap { store.agent($0.toAgentId ?? "") }
  }

  private var chrome: some View {
    TopBar {
      CircleButton(symbol: "chevron.left", label: "Back") { dismiss() }
    } center: {
      if let task = handoffTask, let t = store.tasks.first(where: { $0.id == task }) {
        let agent = store.agent(t.toAgentId ?? "")
        HStack(spacing: 10) {
          if let agent { AgentAvatar(agent: agent, size: 30, showStatus: false) }
          VStack(alignment: .leading, spacing: 0) {
            Text("Handed to \(agent?.name ?? "an agent")").font(.system(size: 15, weight: .semibold)).lineLimit(1)
            Text(store.taskState(t)).font(.system(size: 12)).foregroundStyle(store.taskState(t) == "Working" ? Palette.statusWorkingText : Palette.muted)
          }
        }
        .padding(.leading, 14).padding(.trailing, 20).frame(height: 44).glassPill()
      } else {
        VStack(spacing: 0) {
          Text(parent == nil ? "Thread" : "Sub-thread").font(.system(size: 15, weight: .semibold))
          if let channel { Text(store.title(of: channel)).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1) }
        }
        .padding(.horizontal, 24).frame(height: 44).glassPill()
      }
    } trailing: {
      if handoffTask != nil, let agent = handoffAgent, agent.status == .busy, store.role != "guest" {
        CircleButton(symbol: "stop.fill", label: "Stop \(agent.name)") { Task { try? await store.stopAgent(agent.id) } }
      } else {
        CircleButton(symbol: "xmark", label: "Close thread") { dismiss() }
      }
    }
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
    .foregroundStyle(Palette.muted)
    .padding(.horizontal, 18)
    .padding(.top, 6)
    if ref.from == parent {
      Button { dismiss() } label: { label }.buttonStyle(.plain).accessibilityHint("Back to the thread it came from")
    } else {
      NavigationLink(value: ThreadRef(channelId: ref.channelId, rootId: parent)) { label }.buttonStyle(.plain).accessibilityHint("Opens the thread it came from")
    }
  }
}

/** The first message of a thread, on a card at the top of it. */
struct ThreadRoot: View {
  @Environment(Store.self) private var store
  var message: Message

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        if message.author.kind == .agent { AgentAvatar(agent: store.agent(message.author.id), size: 26, showStatus: false) }
        else { PersonAvatar(name: store.name(of: message.author), size: 26) }
        Text(message.author == Actor(kind: .user, id: store.me?.id ?? "") ? "You" : store.name(of: message.author)).font(.system(size: 15, weight: .semibold))
        Text(message.date, format: .dateTime.hour().minute()).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      if message.deletedAt != nil {
        Text("This message was deleted.").italic().foregroundStyle(Palette.muted)
      } else {
        if !message.body.isEmpty { MarkdownText(message.body, edited: message.editedAt != nil) }
        ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in PartView(part: part, message: message) }
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .padding(.horizontal, 16)
    .padding(.top, 4)
  }
}

/** The top of a hand-off thread: who handed what to whom, where it stands, and when it started. */
struct HandoffBrief: View {
  @Environment(Store.self) private var store
  var message: Message
  var taskId: String

  var body: some View {
    let task = store.tasks.first { $0.id == taskId }
    let from = task.flatMap { t in t.from.flatMap { $0.kind == .agent ? store.agent($0.id)?.name : nil } }
    let to = task.flatMap { store.agent($0.toAgentId ?? "") }?.name
    ChatCardShell(symbol: "arrow.left.arrow.right", label: "\(from ?? "Someone") handed this to \(to ?? "an agent")") {
      Text(task?.title ?? message.body).font(.system(size: 15, weight: .semibold))
      if let task, !task.brief.isEmpty { Text(task.brief).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(4) }
      HStack(spacing: 8) {
        if let task { Text(store.taskState(task)).font(.system(size: 12, weight: .semibold)).padding(.horizontal, 9).padding(.vertical, 3).background(Capsule().fill(Palette.control)) }
        Text("Started \(message.date.formatted(date: .omitted, time: .shortened))").font(.system(size: 13)).foregroundStyle(Palette.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16)
    .padding(.top, 4)
  }
}

/** The end of a conversation, where new messages scroll into view. */
enum Bottom {
  static let id = "bottom"
  static func follow(_ proxy: ScrollViewProxy) {
    withAnimation(Motion.settle) { proxy.scrollTo(id, anchor: .bottom) }
  }
}

/** What a brand-new chat says: who you're talking to, or how to get a team going. */
struct EmptyChannel: View {
  @Environment(Store.self) private var store
  var channel: Channel
  var onAddAgent: () -> Void = {}
  var onAddFiles: () -> Void = {}
  var onInvite: () -> Void = {}

  var body: some View {
    VStack(spacing: 10) {
      if let a = store.dmAgent(channel) {
        AgentAvatar(agent: a, size: 72, showStatus: false, interactive: true)
        Text(a.name).font(.system(size: 20, weight: .semibold))
        Text("This is the start of your conversation with @\(a.handle). Ask it anything, or hand it a task.")
          .font(.system(size: 15)).foregroundStyle(Palette.muted)
        HStack(spacing: 6) {
          GlowDot(color: a.status == .offline ? Palette.statusOffline : Palette.statusOnline)
          Text(a.status == .offline ? "Offline" : "Ready\(store.nodes.first { $0.id == a.nodeId }.map { " on \($0.name)" } ?? "")")
        }
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
      } else {
        let team = channel.team(agents: store.agents)
        TeamGhosts(agents: channel.iconAgents(store.agents), seed: channel.name, size: 64, iconFileId: channel.settings?.iconFileId)
        Text(channel.name).font(.system(size: 20, weight: .semibold))
        Text(intro(team)).font(.system(size: 15)).foregroundStyle(Palette.muted)
        if channel.archivedAt == nil {
          CardGroup {
            if store.canManage {
              introRow("person.badge.plus", "Add agent", "Pick who answers here", onAddAgent)
            }
            introRow("paperclip", "Add files", "Share notes and documents", onAddFiles)
            if store.features.invite && store.canManage { introRow("person.2", "Invite people", "Bring someone into the team", onInvite) }
          }
          .padding(.top, 10)
        }
      }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity)
    .padding(.top, 48)
    .padding(.bottom, 24)
    .padding(.horizontal, 24)
  }

  private func intro(_ team: ChannelTeam?) -> String {
    let head = channel.topic.isEmpty ? "This is the start of the team. " : "\(channel.topic.trimmingCharacters(in: CharacterSet(charactersIn: ".!? "))). "
    let none = (channel.memberCount ?? 0) > 1 ? "@mention an agent to ask them." : "Add the agents who will work here."
    guard let team else { return head + none }
    let leads = team.leads.compactMap { store.agent($0)?.name }
    if leads.isEmpty { return head + none }
    return head + "\(ChannelTeam.list(leads)) \(leads.count > 1 ? "read" : "reads") every new message here and hand\(leads.count > 1 ? "" : "s") out the work."
  }

  private func introRow(_ symbol: String, _ title: String, _ subtitle: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      RowLabel(title: title, subtitle: subtitle) {
        Image(systemName: symbol).font(.system(size: 16)).foregroundStyle(Palette.muted).frame(width: 36, height: 36).background(Circle().fill(Palette.control))
      }
    }.buttonStyle(.plain)
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
  /** bump to open the file picker (the intro's "Add files") */
  var attachTrigger = 0
  var send: (String, [String], String?) async throws -> Void
  /** starts a voice call with the agent: the white voice button shows while the field is empty */
  var onCall: (() -> Void)? = nil
  var callLabel = "Start a voice call"
  /** a plain "/model" opens the model sheet after it's sent */
  var onModelCommand: (() -> Void)? = nil
  /** a call is on: dictating would take the microphone and speaker away from it */
  var callLive = false
  @State private var dictation = Dictation()
  @State private var dictationBase = ""
  @State private var text = ""
  @State private var selection: TextSelection?
  @State private var files: [UploadedFile] = []
  @State private var uploading: [Pending] = []
  @State private var sending = false
  @State private var error: String?
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var slash = SlashMenuModel()
  @FocusState private var focused: Bool
  @ReduceMotion private var reduceMotion

  struct Pending: Identifiable, Equatable { var id = UUID(); var name: String }

  private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty }
  private var blocked: Bool { empty || sending || !uploading.isEmpty }
  /** the send arrow shows (else the voice button) */
  private var showsSend: Bool { !empty || sending || onCall == nil }
  private var replyTarget: ReplyTarget? { channelId.flatMap { store.replyTarget(channel: $0, thread: thread) } }

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
    VStack(spacing: 6) {
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
      if !suggestions.isEmpty { mentionPicker }
      if let error = error ?? dictation.error { Text(error).font(.caption).foregroundStyle(Palette.red).padding(.horizontal, 6) }
      if let target = replyTarget { replyBar(target) }
      if !files.isEmpty || !uploading.isEmpty { attachments }
      HStack(alignment: .center, spacing: 12) {
        Menu {
          Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
          Button("Files", systemImage: "folder") { pickingFiles = true }
          if chatAgent == nil { Button("Mention an agent", systemImage: "at") { text += (text.isEmpty || text.hasSuffix(" ") ? "@" : " @"); focused = true } }
        } label: { CircleLabel(symbol: "plus", size: 44, weight: .regular) }
          .accessibilityLabel("Attach").accessibilityIdentifier("composer-attach")
        HStack(alignment: .bottom, spacing: 6) {
          TextField(replyTarget.map { "Reply to \($0.name)" } ?? placeholder, text: $text, selection: $selection, axis: .vertical)
            .font(.system(size: 15))
            .lineLimit(1...8)
            .focused($focused)
            .padding(.vertical, 15)
            .padding(.leading, 12)
            .accessibilityIdentifier("composer-field")
          if (empty || dictation.active) && !callLive {
            Button {
              if !dictation.active { dictationBase = text }
              dictation.toggle { transcript in
                text = dictationBase.isEmpty ? transcript : dictationBase + (dictationBase.hasSuffix(" ") ? "" : " ") + transcript
              }
            } label: {
              Image(systemName: dictation.active ? "mic.fill" : "mic")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(dictation.active ? Palette.blue : Palette.muted)
                .frame(width: 40, height: 40)
            }
            .buttonStyle(.press)
            .padding(.bottom, 8)
            .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
            .accessibilityLabel(dictation.active ? "Stop dictating" : "Dictate")
          }
          if !empty || sending || onCall == nil {
            Button { submit() } label: {
              Image(systemName: sending ? "ellipsis" : "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 44)
                .background(Capsule().fill(Palette.tabChats))
            }
            .buttonStyle(.press)
            .disabled(blocked)
            .opacity(blocked ? 0.3 : 1)
            .animation(.snappy, value: blocked)
            .padding(.bottom, 6).padding(.trailing, 6)
            .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
            .accessibilityLabel("Send").accessibilityIdentifier("composer-send")
          } else if let onCall {
            Button(action: onCall) {
              Image(systemName: "waveform")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.call)
                .frame(width: 56, height: 44)
                .background(Capsule().fill(Palette.call.tint16))
            }
            .buttonStyle(.press)
            .padding(.bottom, 6).padding(.trailing, 6)
            .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
            .accessibilityLabel(callLabel).accessibilityIdentifier("composer-call")
          }
        }
        .frame(minHeight: 44)
        .animation(Motion.pick(Motion.pop, reduceMotion), value: showsSend)
        .animation(Motion.pick(Motion.pop, reduceMotion), value: dictation.active)
        .background {
          if #available(iOS 26, *) {
            RoundedRectangle(cornerRadius: 24, style: .continuous).fill(.clear).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
          } else {
            RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Palette.control)
              .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Palette.hairline))
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
    .onChange(of: attachTrigger) { pickingFiles = true }
    .onChange(of: callLive) { _, live in if live { dictation.stop() } }
    .onChange(of: store.replying) { _, _ in if replyTarget != nil { focused = true } }
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      for item in items { upload("Photo") { try await photo(item) } }
    }
    .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      switch result {
      case .success(let urls):
        for url in urls {
          upload(url.lastPathComponent) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return (try Data(contentsOf: url), url.lastPathComponent, UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
          }
        }
      case .failure(let e): error = e.localizedDescription
      }
    }
  }

  /** "Mention an agent": who you can @mention here, with what each one does. */
  private var mentionPicker: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Mention an agent").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted).padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
      ForEach(suggestions) { suggestion in
        Button {
          let completed = ComposerMentions.inserting(suggestion.handle, into: text, caret: caret)
          text = completed.text
          selection = TextSelection(insertionPoint: text.index(text.startIndex, offsetBy: completed.caret))
          focused = true
        } label: {
          HStack(spacing: 12) {
            if suggestion.actor.kind == .agent {
              AgentAvatar(agent: store.agent(suggestion.actor.id), size: 32, showStatus: false)
            } else {
              PersonAvatar(name: suggestion.name, size: 32)
            }
            VStack(alignment: .leading, spacing: 0) {
              Text(suggestion.name).font(.system(size: 15, weight: .medium))
              Text(subtitle(suggestion)).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 8)
          .contentShape(Rectangle())
        }.buttonStyle(.plain)
      }
      Color.clear.frame(height: 6)
    }
    .glass(Corner.card)
    .accessibilityIdentifier("mention-picker")
  }

  private func subtitle(_ s: ComposerMentions.Suggestion) -> String {
    guard s.actor.kind == .agent, let node = channel?.team(agents: store.agents)?.nodes.first(where: { $0.agentId == s.actor.id }) else { return "@\(s.handle)" }
    return (node.role ?? "@\(s.handle)") + (node.lead ? " · leads" : "")
  }

  private func replyBar(_ target: ReplyTarget) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "arrowshape.turn.up.left").font(.system(size: 14)).foregroundStyle(Palette.muted)
      Rectangle().fill(Palette.text).frame(width: 2, height: 32)
      VStack(alignment: .leading, spacing: 0) {
        (Text("Replying to \(target.name)").font(.system(size: 13, weight: .semibold)) + Text(target.when.map { " · \($0)" } ?? "").font(.system(size: 13)).foregroundStyle(Palette.muted))
          .lineLimit(1)
        Text(target.snippet).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 4)
      Button { if let channelId { store.cancelReply(channel: channelId, thread: thread) } } label: {
        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 40, height: 40).contentShape(Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Cancel reply")
    }
    .padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 4)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder))
  }

  /** What's attached so far, each with a way to take it off again. */
  private var attachments: some View {
    VStack(alignment: .trailing, spacing: 4) {
      Text("Draft saved").font(.system(size: 12)).foregroundStyle(Palette.faint)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(files) { f in
            HStack(spacing: 8) {
              Image(systemName: UploadedFile.isImage(f.name) ? "photo" : "doc").foregroundStyle(Palette.muted)
              VStack(alignment: .leading, spacing: 0) {
                Text(f.name).font(.system(size: 13, weight: .medium)).lineLimit(1).frame(maxWidth: 140, alignment: .leading)
                if let size = f.size { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.system(size: 12)).foregroundStyle(Palette.muted) }
              }
              Button { files.removeAll { $0.id == f.id } } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 32, height: 32).contentShape(Circle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(f.name)")
            }
            .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder))
          }
          ForEach(uploading) { p in
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              VStack(alignment: .leading, spacing: 0) {
                Text(p.name).font(.system(size: 13, weight: .medium)).lineLimit(1).frame(maxWidth: 140, alignment: .leading)
                Text("Uploading").font(.system(size: 12)).foregroundStyle(Palette.muted)
              }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder))
            .accessibilityLabel("Uploading \(p.name)")
          }
        }
      }
    }
  }

  private func upload(_ label: String, _ read: @escaping () async throws -> (Data, String, String?)) {
    let pending = Pending(name: label)
    uploading.append(pending)
    error = nil
    Task {
      do {
        let (data, name, mime) = try await read()
        files.append(try await store.uploadFile(data, name: name, mime: mime, channelId: channelId))
      } catch { self.error = error.localizedDescription }
      uploading.removeAll { $0.id == pending.id }
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
    let quoted = replyTarget
    let opensModel = body.lowercased() == "/model" && onModelCommand != nil
    dictation.stop()
    sending = true
    error = nil
    text = ""
    files = []
    if let channelId { store.cancelReply(channel: channelId, thread: thread) }
    Task {
      do {
        try await send(body, attached.map(\.id), quoted?.id)
        if opensModel { onModelCommand?() }
      } catch {
        self.error = error.localizedDescription
        text = Self.restoringFailedText(body, current: text)
        files = attached + files
        if let channelId, let quoted, store.replyTarget(channel: channelId, thread: thread) == nil { store.replying[ComposerDrafts.key(channel: channelId, thread: thread)] = quoted }
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

/** Tells when its screen is popped or dismissed, not when something is pushed or presented over it. */
private struct LeavingWatcher: UIViewControllerRepresentable {
  var onLeave: () -> Void
  func makeUIViewController(context: Context) -> Probe { Probe() }
  func updateUIViewController(_ probe: Probe, context: Context) { probe.onLeave = onLeave }

  final class Probe: UIViewController {
    var onLeave: () -> Void = {}
    override func viewDidDisappear(_ animated: Bool) {
      super.viewDidDisappear(animated)
      var node: UIViewController? = self
      while let current = node {
        if current.isMovingFromParent || current.isBeingDismissed { onLeave(); return }
        node = current.parent
      }
    }
  }
}
