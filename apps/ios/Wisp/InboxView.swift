import SwiftUI

/** Everything agents asked you, waiting and decided: the Inbox tab. */
struct InboxView: View {
  enum Mode: Hashable { case needs, done }

  @Environment(Store.self) private var store
  @Environment(\.openSettings) private var openSettings
  @State private var mode: Mode = .needs
  @State private var chat: ChatTarget?
  @State private var thread: ThreadRef?
  @State private var agentPage: Agent?
  @State private var showTasks = false
  @State private var computerId: String?
  @State private var addingAgent = false
  @State private var creating = false
  /** "Not now" on a request to help on a computer: hidden here until the app is reopened; it stays in the chat and on Computers */
  @State private var putOff: Set<String> = []
  @State private var action = FormAction()

  private var helpWanted: [Computer] {
    store.canViewComputers ? store.computers.filter { $0.help != nil && !putOff.contains(helpKey($0)) } : []
  }
  private func helpKey(_ c: Computer) -> String { "\(c.id):\(c.help?.at ?? "")" }
  private var pending: [Approval] { store.role == "guest" ? [] : store.pendingApprovals }
  private var needsCount: Int { pending.count + helpWanted.count }
  private var canNewTask: Bool { store.canManage && store.features.tasks && !store.agents.isEmpty }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        Button { openSettings() } label: { ProfileCircle() }
          .buttonStyle(.press).accessibilityIdentifier("profile-button")
      } center: {
        Text("Inbox").font(.system(size: 20, weight: .bold)).foregroundStyle(Palette.text)
      } trailing: {
        if canNewTask { CircleButton(symbol: "plus", label: "New task", id: "inbox-new-task") { creating = true } }
      }
      switcher
      ScrollView {
        StaggeredStack(spacing: 12) {
          if mode == .needs { needs } else { InboxDone() }
        }
        .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
    }
    .background(Palette.ground.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .task { await load() }
    .refreshable {
      await store.refreshApprovals()
      await store.refreshComputers()
      await load()
    }
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .navigationDestination(item: $thread) { ThreadView(ref: $0) }
    .navigationDestination(item: $agentPage) { AgentPage(agent: $0) }
    .navigationDestination(isPresented: $showTasks) { TasksView() }
    .navigationDestination(item: $computerId) { ComputerDetail(computerId: $0) }
    .sheet(isPresented: $addingAgent) { AddAgent { chat = nil; agentPage = $0 } }
    .sheet(isPresented: $creating) { NewTaskView() }
    .managementAlert(action)
  }

  private var switcher: some View {
    HStack(spacing: 0) {
      tab("Needs you\(needsCount > 0 ? " · \(needsCount)" : "")", .needs, id: "inbox-needs")
      tab("Done", .done, id: "inbox-done")
    }
    .padding(4)
    .background(Capsule().fill(Palette.field))
    .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 8)
    .accessibilityElement(children: .contain)
  }

  private func tab(_ title: String, _ value: Mode, id: String) -> some View {
    Button { withAnimation(.snappy(duration: 0.2)) { mode = value } } label: {
      Text(title)
        .font(.system(size: 13, weight: mode == value ? .semibold : .medium))
        .foregroundStyle(mode == value ? Palette.text : Palette.muted)
        .frame(maxWidth: .infinity).frame(height: 36)
        .background { if mode == value { Capsule().fill(Color(light: 0xFFFFFF, dark: 0x34343A)) } }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(mode == value ? .isSelected : [])
    .accessibilityIdentifier(id)
  }

  @ViewBuilder private var needs: some View {
    let others = !store.workingAgents.isEmpty || !store.unreadChats.isEmpty || !store.recentChats.isEmpty || !store.tasksToCheck.isEmpty
    if needsCount > 0 {
      InboxHead(title: "Needs you", right: "\(needsCount)")
      ForEach(helpWanted) { c in
        HelpNeedCard(computer: c, open: { computerId = c.id }, notNow: { putOff.insert(helpKey(c)) })
      }
      ForEach(pending) { a in
        if a.login != nil { LoginNeedCard(approval: a) }
        else { ApprovalNeedCard(approval: a, openChat: { openApprovalChat(a) }) }
      }
    }
    InboxSections(caughtUp: needsCount == 0, open: open)
    if needsCount == 0 { CaughtUp(compact: others || !store.agents.isEmpty) }
  }

  private func openApprovalChat(_ a: Approval) {
    guard let ch = store.channels.first(where: { $0.id == a.channelId }) else { return }
    if let t = a.threadId { thread = ThreadRef(channelId: ch.id, rootId: t) } else { chat = ChatTarget(channel: ch, draft: "") }
  }

  /** The pieces the sections show that the app doesn't already keep fresh. */
  private func load() async {
    try? await store.refreshOnboarding()
    if store.features.tasks { try? await store.refreshTasks() }
    if store.features.background { try? await store.refreshAllowance() }
    for c in store.unreadChats.prefix(8) + store.recentChats where store.messages[c.id] == nil {
      try? await store.loadMessages(c.id)
    }
  }

  private func open(_ target: InboxTarget) {
    switch target {
    case .chat(let c): chat = ChatTarget(channel: c, draft: "")
    case .thread(let t): thread = t
    case .agent(let a): agentPage = a
    case .devices: store.route = .device(id: nil)
    case .addAgent: addingAgent = true
    case .computer(let id): computerId = id
    case .tasks: showTasks = true
    case .dm(let a, let draft): action.run { chat = ChatTarget(channel: try await store.dm(with: a), draft: draft) }
    }
  }
}

/** "All caught up": nothing needs you. */
private struct CaughtUp: View {
  var compact: Bool

  var body: some View {
    VStack(spacing: 14) {
      GhostView(look: GhostLook(color: "#a1a1aa", color2: "#a1a1aa"), seed: "caught-up", size: compact ? 56 : 84)
      Text("All caught up").font(.system(size: compact ? 20 : 24, weight: .bold)).foregroundStyle(Palette.text)
      Text("Nothing needs you right now. When an agent wants your OK or needs you on its computer, it shows up here.")
        .font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
    }
    .padding(.horizontal, 24).padding(.vertical, compact ? 20 : 90)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/** What you decided and what finished: the Inbox's history. */
private struct InboxDone: View {
  @Environment(Store.self) private var store

  private struct Line: Identifiable { var id: String; var agent: Agent?; var text: String; var at: String }

  private func lines() -> (decided: [Line], done: [Line]) {
    let decided = store.decidedApprovals.map { a -> Line in
      let who = a.decidedBy == nil || a.decidedBy == store.me?.id ? "You" : (store.members.first { $0.id == a.decidedBy }?.name ?? "Someone")
      let yes = a.status == "approved"
      let text: String
      if let login = a.login { text = yes ? "\(who) allowed sign-in to \(login.site)" : "\(who) said not now to sign-in to \(login.site)" }
      else { text = yes ? "\(who) approved \(a.summary)" : "\(who) said not now to \(a.summary)" }
      return Line(id: a.id, agent: store.agent(a.agentId), text: text, at: a.decidedAt ?? a.createdAt)
    }
    let done = store.finishedTasks.map { t in
      Line(id: t.id, agent: t.toAgentId.flatMap { store.agent($0) }, text: "\(store.agent(t.toAgentId ?? "")?.name ?? "An agent") finished \(t.title)", at: t.updatedAt ?? "")
    }
    return (decided, done)
  }

  private func today(_ l: Line) -> Bool { Wire.date(l.at).map { Calendar.current.isDateInToday($0) } ?? false }

  var body: some View {
    let (decided, done) = lines()
    if decided.isEmpty && done.isEmpty {
      Text("Nothing yet. What you decide and what agents finish shows up here.")
        .font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        .frame(maxWidth: .infinity).padding(.top, 80)
    }
    group("Decided today", decided.filter(today), card: true)
    group("Decided earlier", decided.filter { !today($0) }, card: true)
    group("Done today", done.filter(today), card: false)
    group("Done earlier", done.filter { !today($0) }, card: false)
  }

  @ViewBuilder private func group(_ title: String, _ items: [Line], card: Bool) -> some View {
    if !items.isEmpty {
      InboxHead(title: title)
      let rows = VStack(spacing: 0) {
        ForEach(Array(items.enumerated()), id: \.element.id) { i, l in
          HStack(spacing: 12) {
            AgentAvatar(agent: l.agent, size: 28, showStatus: false)
            Text(l.text).font(.system(size: 15)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let d = Wire.date(l.at) { Text(ChatList.timeText(d)).font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }
          .padding(.vertical, 10).padding(.horizontal, 4)
          .accessibilityElement(children: .combine)
          if i < items.count - 1 { Rectangle().fill(Palette.separator).frame(height: 1) }
        }
      }
      if card {
        rows.padding(.horizontal, 14).padding(.vertical, 4).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      } else {
        rows.padding(.horizontal, 4)
      }
    }
  }
}

// MARK: the cards

/** An agent wants your OK: what it will do, an optional note, Approve / Not now / Open chat. */
struct ApprovalNeedCard: View {
  @Environment(Store.self) private var store
  var approval: Approval
  var openChat: () -> Void
  @State private var note = ""
  @State private var more = false
  @State private var busy = false
  @State private var error: String?

  private var agent: Agent? { store.agent(approval.agentId) }
  private var where_: String? {
    guard let c = store.channels.first(where: { $0.id == approval.channelId }), !c.isDM else { return nil }
    return c.name
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      NeedHead(agent: agent, title: "\(agent?.name ?? "An agent") wants your OK", sub: [where_, Wire.date(approval.createdAt).map { $0.formatted(.relative(presentation: .named)) }].compactMap { $0 }.joined(separator: " · "))
      Text(approval.summary)
        .font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.text.opacity(0.85))
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 10)
        .background(Palette.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      if !approval.details.isEmpty {
        Button(more ? "Hide details" : "Show details") { more.toggle() }.font(.system(size: 13)).foregroundStyle(Palette.muted).buttonStyle(.plain)
        if more { MarkdownText(approval.details).font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous)) }
      }
      CardField(placeholder: "Add a note (optional)", text: $note).disabled(busy)
      HStack(spacing: 10) {
        Button("Approve") { decide(true) }.buttonStyle(CardPill(tone: .primary)).accessibilityIdentifier("approve")
        Button("Not now") { decide(false) }.buttonStyle(CardPill(tone: .soft)).accessibilityIdentifier("not-now")
      }
      .disabled(busy)
      Button("Open chat", action: openChat).buttonStyle(CardPill(tone: .ghost)).frame(maxWidth: .infinity)
      if let error { Text(error).font(.caption).foregroundStyle(Palette.red) }
    }
    .padding(16)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .contain)
  }

  private func decide(_ yes: Bool) {
    busy = true
    Task {
      do { try await store.decide(approval, approve: yes, note: note.trimmingCharacters(in: .whitespacesAndNewlines)) } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

/** An agent wants to sign in with a login from your password manager: only whoever connected it answers. */
struct LoginNeedCard: View {
  @Environment(Store.self) private var store
  var approval: Approval
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    let agent = store.agent(approval.agentId)
    let name = agent?.name ?? "An agent"
    let login = approval.login
    VStack(alignment: .leading, spacing: 12) {
      NeedHead(agent: agent, title: "\(name) wants to sign in to \(login?.site ?? "a site")",
               sub: [login?.username.flatMap { $0.isEmpty ? nil : "Account \($0)" }, "from your password manager"].compactMap { $0 }.joined(separator: " · "))
      Text("Wisp types it in on \(name)'s computer, so the password never goes in chat.").font(.system(size: 13)).foregroundStyle(Palette.muted)
      if login?.ownerId != store.me?.id {
        Text("Waiting for \(store.members.first { $0.id == login?.ownerId }?.name ?? "whoever connected it"): only they can let agents use their logins.")
          .font(.system(size: 13)).foregroundStyle(Palette.muted)
      } else {
        HStack(spacing: 10) {
          Button("Allow sign-in") { decide(true) }.buttonStyle(CardPill(tone: .primary)).accessibilityIdentifier("allow-login")
          Button("Not now") { decide(false) }.buttonStyle(CardPill(tone: .soft))
        }
        .disabled(busy)
        Button("Always allow for \(name)") { decide(true, always: true) }.buttonStyle(CardPill(tone: .ghost)).frame(maxWidth: .infinity).disabled(busy)
      }
      if let error { Text(error).font(.caption).foregroundStyle(Palette.red) }
    }
    .padding(16)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .contain)
  }

  private func decide(_ yes: Bool, always: Bool = false) {
    busy = true
    Task {
      do { try await store.decide(approval, approve: yes, always: always ? true : nil) } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

/** An agent asked you to take over on its computer. */
struct HelpNeedCard: View {
  @Environment(Store.self) private var store
  var computer: Computer
  var open: () -> Void
  var notNow: () -> Void

  var body: some View {
    let help = computer.help
    let agent = help.flatMap { store.agent($0.agentId) }
    VStack(alignment: .leading, spacing: 12) {
      NeedHead(agent: agent, title: "\(agent?.name ?? "An agent") needs you on \(computer.name)",
               sub: "Asked for help on a computer" + (help?.at.flatMap(Wire.date).map { " · \($0.formatted(.relative(presentation: .named)))" } ?? ""))
      if let request = help?.request, !request.isEmpty {
        Text("“\(request)”").font(.system(size: 13)).foregroundStyle(Palette.text.opacity(0.9))
          .frame(maxWidth: .infinity, alignment: .leading).padding(12)
          .background(Palette.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      HStack(spacing: 10) {
        Button("Open computer", action: open).buttonStyle(CardPill(tone: .primary)).accessibilityIdentifier("open-computer")
        Button("Not now", action: notNow).buttonStyle(CardPill(tone: .soft))
      }
    }
    .padding(16)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .contain)
  }
}
