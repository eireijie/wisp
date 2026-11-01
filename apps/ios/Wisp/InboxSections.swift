import SwiftUI

/** Where a row in the Inbox's extra sections goes, when it can't be a plain link. */
enum InboxTarget {
  case chat(Channel)
  case thread(ThreadRef)
  case dm(Agent, draft: String = "")
  case addAgent
  case agent(Agent)
  case devices
  case harnesses
  case computer(String)
  case tasks
}

/** What an agent is doing right now: its task, or the step it's on in a chat. */
struct AgentDoing: Equatable {
  var text: String
  var `where`: String?
}

/** Plain logic behind the Inbox sections (the web's DashboardView and useWaitingOnYou). */
extension Store {
  func chatName(_ c: Channel) -> String { c.isDM ? dmAgent(c)?.name ?? "Direct message" : c.name }
  private func channelLabel(_ id: String?) -> String? {
    guard let id, let c = channels.first(where: { $0.id == id }) else { return nil }
    return c.isDM ? "in a DM" : "in \(c.name)"
  }

  /** One line per busy agent, from the most specific source: its task, then the chat step it's on. */
  func doing(_ agent: Agent) -> AgentDoing? {
    if let t = tasks.first(where: { $0.status == "in_progress" && $0.toAgentId == agent.id }) {
      return AgentDoing(text: t.title, where: channelLabel(t.channelId))
    }
    if let step = activity[agent.id] {
      return AgentDoing(text: step == "started" ? "Working" : step, where: channelLabel(activityChannel[agent.id]))
    }
    return nil
  }

  /** Agents at work first, then online, then offline; by name inside each group. */
  var agentsByActivity: [Agent] {
    func rank(_ a: Agent) -> Int { a.status == .busy ? 0 : a.status == .online ? 1 : 2 }
    return agents.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  /** The agents at work: what "What agents are doing" lists. */
  var workingAgents: [Agent] { agentsByActivity.filter { $0.status == .busy || doing($0) != nil } }

  /** New replies: DMs first, then channels, most unread first. */
  var unreadChats: [Channel] {
    channels.filter { ($0.joined == true || $0.isDM) && $0.badge > 0 }
      .sorted { ($0.isDM ? 0 : 1, -$0.badge) < ($1.isDM ? 0 : 1, -$1.badge) }
  }

  /** Unread first, then most recently read. */
  func recentChats(limit: Int = 5) -> [Channel] {
    channels.filter { ($0.joined == true || $0.isDM) && $0.archivedAt == nil }
      .sorted { ($0.badge > 0 ? 0 : 1, $1.lastReadAt ?? "") < ($1.badge > 0 ? 0 : 1, $0.lastReadAt ?? "") }
      .prefix(limit).map { $0 }
  }
  var recentChats: [Channel] { recentChats() }

  /** Tasks you handed off that haven't started, didn't finish, or just finished and wait for a look. */
  var tasksToCheck: [WorkTask] {
    guard let me else { return [] }
    return tasks.filter {
      guard $0.from == Actor(kind: .user, id: me.id), !$0.cancelled else { return false }
      if $0.status == "open" || $0.status == "failed" { return true }
      guard $0.status == "done", let at = $0.updatedAt.flatMap(Wire.date) else { return false }
      return Date().timeIntervalSince(at) < 2 * 86_400
    }
  }

  /** What you (or someone) decided, newest first. */
  var decidedApprovals: [Approval] {
    approvals.filter { $0.status != "pending" }
      .sorted { ($0.decidedAt ?? $0.createdAt) > ($1.decidedAt ?? $1.createdAt) }
      .prefix(30).map { $0 }
  }

  /** Tasks that finished, newest first. */
  var finishedTasks: [WorkTask] {
    tasks.filter { $0.status == "done" }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }.prefix(20).map { $0 }
  }

  /** How much of today's background allowance is used. */
  static func allowanceText(_ a: Allowance) -> String {
    guard let daily = a.dailyTokens, daily > 0 else { return "\(Allowance.text(a.todayTokens)) used today" }
    return "\(min(100, Int((Double(a.todayTokens) / Double(daily) * 100).rounded())))% of today's allowance"
  }
}

// MARK: shared pieces

/** The small grey heading over a group, with a count or a link on the right. */
struct InboxHead: View {
  var title: String
  var right: String? = nil
  var body: some View {
    HStack {
      Text(title).font(.system(size: 13, weight: .semibold))
      Spacer()
      if let right { Text(right).font(.system(size: 13, weight: .medium)) }
    }
    .foregroundStyle(Palette.faint)
    .padding(.horizontal, 6).padding(.top, 6)
    .accessibilityAddTraits(.isHeader)
  }
}

/** A tinted label (Working, Needs you, Done…): one hue per meaning. */
struct StateChip: View {
  var text: String

  private var hue: Color {
    switch text {
    case "Working": Palette.statusWorking
    case "Needs you": Palette.statusNeeds
    case "Done": Palette.statusOnline
    case "Failed": Palette.statusProblem
    default: Palette.muted
    }
  }

  var body: some View {
    Text(text)
      .font(.system(size: 12, weight: .semibold)).foregroundStyle(hue)
      .padding(.horizontal, 10).frame(height: 26)
      .background(Capsule().fill(hue.opacity(0.15)))
      .lineLimit(1).fixedSize()
  }
}

/** The pills on a card: filled for the main answer, soft for the other, bare for "Open chat". */
struct CardPill: ButtonStyle {
  enum Tone { case primary, soft, ghost }
  var tone: Tone = .soft
  var tint: Color? = nil
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: tone == .ghost ? .medium : .semibold))
      .foregroundStyle(tint ?? (tone == .primary ? Palette.ground : tone == .soft ? Palette.text : Palette.muted))
      .padding(.horizontal, 20).frame(height: 44).frame(maxWidth: tone == .ghost ? nil : .infinity)
      .background {
        switch tone {
        case .primary: Capsule().fill(Palette.text)
        case .soft: Capsule().fill(Palette.control).overlay(Capsule().strokeBorder(Palette.hairline))
        case .ghost: Color.clear
        }
      }
      .opacity(enabled ? 1 : 0.5)
      .contentShape(Capsule())
      .pressFeedback(configuration.isPressed)
  }
}

/** A rounded text field used on cards. */
struct CardField: View {
  var placeholder: String
  @Binding var text: String
  var body: some View {
    TextField(placeholder, text: $text)
      .font(.system(size: 15)).foregroundStyle(Palette.text)
      .padding(.horizontal, 16).frame(height: 44)
      .background(Capsule().fill(Palette.sheet).overlay(Capsule().strokeBorder(Palette.hairline)))
  }
}

/** The face and name at the top of a card. */
struct NeedHead: View {
  var agent: Agent?
  var title: String
  var sub: String
  var body: some View {
    HStack(spacing: 12) {
      AgentAvatar(agent: agent, size: 34, showStatus: false)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
        Text(sub).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }
}

// MARK: the sections under "Needs you"

/** The Inbox below "needs you": setup, what agents are doing, new replies, tasks to check, teams and the task count. */
struct InboxSections: View {
  @Environment(Store.self) private var store
  var caughtUp: Bool
  var open: (InboxTarget) -> Void
  @State private var moreRecent = false

  private var isGuest: Bool { store.role == "guest" }

  var body: some View {
    if !isGuest { ReadinessSection(open: open) }

    let working = store.workingAgents
    if !working.isEmpty {
      InboxHead(title: "What agents are doing", right: "\(working.count) working")
      CardGroup { ForEach(working) { workingRow($0) } }
    }

    let unread = store.unreadChats
    if !unread.isEmpty {
      InboxHead(title: "New replies", right: "\(unread.reduce(0) { $0 + $1.badge })")
      CardGroup {
        ForEach(unread) { c in Button { open(.chat(c)) } label: { chatRow(c, title: c.isDM ? "\(store.chatName(c)) replied to you" : store.chatName(c)) }.buttonStyle(.plain) }
      }
    }

    if isGuest, store.recentChats(limit: 1).isEmpty {
      Text("Conversations you're invited to show up here.").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
    }

    let recent = store.recentChats(limit: moreRecent ? 20 : 5)
    if unread.isEmpty, !recent.isEmpty {
      HStack {
        Text("Recent conversations").font(.system(size: 13, weight: .semibold))
        Spacer()
        if store.recentChats(limit: 6).count > 5 {
          Button(moreRecent ? "Show less" : "Show more") { moreRecent.toggle() }.font(.system(size: 13, weight: .medium))
        }
      }
      .foregroundStyle(Palette.faint).padding(.horizontal, 6).padding(.top, 6)
      CardGroup { ForEach(recent) { c in Button { open(.chat(c)) } label: { chatRow(c, title: store.chatName(c)) }.buttonStyle(.plain) } }
    }

    if !isGuest, store.features.tasks, !store.tasksToCheck.isEmpty {
      InboxHead(title: "Tasks to check", right: "\(store.tasksToCheck.count)")
      CardGroup { ForEach(store.tasksToCheck) { taskRow($0) } }
    }

    let teams = store.teams.filter { $0.channelId != nil }
    if !teams.isEmpty {
      InboxHead(title: "Teams")
      CardGroup {
        ForEach(teams) { t in
          let members = (t.members ?? []).compactMap { store.agent($0.agentId) }
          let busy = members.first { $0.status == .busy }
          let teamBusy = store.tasks.contains { $0.teamId == t.id && $0.status == "in_progress" }
          Button { if let ch = store.channels.first(where: { $0.id == t.channelId }) { open(.chat(ch)) } } label: {
            HStack(spacing: 12) {
              TeamGhosts(agents: members, seed: t.name, size: 40, iconFileId: store.channels.first { $0.id == t.channelId }?.settings?.iconFileId)
              VStack(alignment: .leading, spacing: 3) {
                Text(t.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Text(busy != nil || teamBusy ? "Working\(busy.map { " · \($0.name) is on it" } ?? "")" : "Quiet")
                  .font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).frame(minHeight: 64).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }

    if store.features.tasks, !isGuest {
      InboxHead(title: "Tasks")
      HStack(spacing: 0) {
        stat("To do", store.tasks.filter { $0.status == "open" }.count)
        stat("Working", store.tasks.filter { $0.status == "in_progress" }.count)
        stat("Done", store.tasks.filter { $0.status == "done" }.count)
        stat("Failed", store.tasks.filter { $0.status == "failed" && !$0.cancelled }.count, bad: true)
      }
      .padding(.vertical, 14).padding(.horizontal, 8)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      if store.tasks.isEmpty {
        Text("No tasks yet.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
      } else if !store.tasks.contains(where: { $0.status == "in_progress" }) {
        Text("No agent is on a task right now.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
      }
      Button("Open Tasks") { open(.tasks) }.buttonStyle(CardPill(tone: .soft)).frame(maxWidth: .infinity)
        .accessibilityIdentifier("open-tasks")
    }

    if store.features.background, let a = store.allowance {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Background work").font(.system(size: 13)).foregroundStyle(Palette.text)
          Text((a.dailyTokens ?? 0) > 0 ? "\(Store.allowanceText(a)) used" : Store.allowanceText(a)).font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        Spacer()
        NavigationLink { UsageView() } label: { Text("Open usage").font(.system(size: 15, weight: .medium)).foregroundStyle(Color(hex: 0x9EC5FF)) }
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
      .background(Palette.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    if store.agents.isEmpty, !isGuest {
      Text("No agents yet. Add one from Chats and it shows up here with what it's working on.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
    }
  }

  private func stat(_ label: String, _ n: Int, bad: Bool = false) -> some View {
    VStack(spacing: 2) {
      Text("\(n)").font(.system(size: 22, weight: .bold)).foregroundStyle(bad && n > 0 ? Palette.red : Palette.text)
      Text(label).font(.system(size: 12)).foregroundStyle(Palette.faint)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  // MARK: rows

  private func workingRow(_ a: Agent) -> some View {
    let now = store.doing(a)
    return Button { open(.dm(a)) } label: {
      HStack(spacing: 12) {
        AgentAvatar(agent: a, size: 36, showStatus: false)
        VStack(alignment: .leading, spacing: 2) {
          Text(a.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
          Text(now?.text ?? "Working").font(.system(size: 13)).foregroundStyle(Palette.statusWorkingText).lineLimit(1)
          if let place = now?.where { Text(place).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1) }
        }
        Spacer(minLength: 8)
        WorkingDots()
      }
      .padding(.horizontal, 18).padding(.vertical, 10).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
  }

  private func chatRow(_ c: Channel, title: String) -> some View {
    let last = store.messages[c.id]?.last
    return HStack(spacing: 12) {
      if c.isDM, let a = store.dmAgent(c) { SoloGhost(agent: a, size: 40) }
      else {
        let team = store.teams.first { $0.channelId == c.id }
        TeamGhosts(agents: (team?.members ?? []).compactMap { store.agent($0.agentId) }, seed: c.name, size: 40, iconFileId: c.settings?.iconFileId)
      }
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
          Spacer(minLength: 8)
          if let last { Text(ChatList.timeText(last.date)).font(.system(size: 13)).foregroundStyle(Palette.faint) }
        }
        HStack(spacing: 8) {
          Text(last.map { SearchText.clean($0.body, max: 90) } ?? (c.badge > 0 ? "\(c.badge) new" : "No messages yet"))
            .font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
          Spacer(minLength: 0)
          if c.badge > 0 { UnreadBadge(count: c.badge) }
        }
      }
    }
    .padding(.horizontal, 16).frame(minHeight: 64).contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private func taskRow(_ t: WorkTask) -> some View {
    let agent = t.toAgentId.flatMap { store.agent($0) }
    let who = agent?.name ?? "an agent"
    let sub = t.status == "failed" ? "Failed · \(who)" : t.status == "done" ? "Done by \(who) · ready to review" : "Not started · \(who)"
    let icon = t.status == "done" ? "checkmark.circle" : t.status == "failed" ? "xmark.circle" : "circle"
    let hue = t.status == "done" ? Palette.statusOnline : t.status == "failed" ? Palette.red : Palette.faint
    let label = HStack(spacing: 12) {
      Image(systemName: icon).font(.system(size: 24, weight: .regular)).foregroundStyle(hue).frame(width: 30)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(t.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
          Spacer(minLength: 8)
          if let d = t.updatedAt.flatMap(Wire.date) { Text(ChatList.timeText(d)).font(.system(size: 13)).foregroundStyle(Palette.faint) }
        }
        Text(sub).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      }
    }
    .padding(.horizontal, 16).frame(minHeight: 64).contentShape(Rectangle())
    if let channelId = t.channelId, let ch = store.channels.first(where: { $0.id == channelId }) {
      Button { open(t.threadId.map { .thread(ThreadRef(channelId: channelId, rootId: $0)) } ?? .chat(ch)) } label: { label }.buttonStyle(.plain)
    } else {
      Button { open(.tasks) } label: { label }.buttonStyle(.plain)
    }
  }
}

/** Setup status: finish making a helper, fix why it can't answer, or try a first question. */
struct ReadinessSection: View {
  @Environment(Store.self) private var store
  var open: (InboxTarget) -> Void

  static let examples = ["Plan dinners for this week and make a shopping list", "Help me write a polite note to my landlord about a repair", "Summarize a document I'll paste in"]

  var body: some View {
    let devices = store.readyDevices
    let checks = Readiness.checks(agents: store.agents, devices: devices)
    let agent = Readiness.pickHelper(store.agents, devices: devices)
    let bad = checks.first { $0.status == .bad }
    let done = checks.filter { $0.status == .ok }.count
    if store.agents.isEmpty {
      card(agent: nil, title: "Your agent isn't ready yet", sub: "Next: make your first agent", done: 0, total: max(checks.count, 4)) {
        if store.canManage { Button("Make an agent") { open(.addAgent) }.buttonStyle(CardPill(tone: .primary)) }
      }
    } else if let agent, let bad {
      card(agent: agent, title: title(agent, bad, devices), sub: bad.fix ?? Readiness.ready(agent, devices: devices).problem ?? "Not ready yet", done: done, total: checks.count) {
        HStack(spacing: 10) {
          primaryFix(bad, agent)
          if case .chooseModel = bad.to {} else { Button("Change its AI") { open(.agent(agent)) }.buttonStyle(CardPill(tone: .soft)) }
        }
      }
    } else if let agent {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 12) {
          AgentAvatar(agent: agent, size: 40, showStatus: false)
          Text("Try asking \(agent.name)…").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
        }
        ForEach(Self.examples, id: \.self) { text in
          Button { open(.dm(agent, draft: text)) } label: {
            Text(text).font(.system(size: 13)).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 10)
              .background(Palette.sheet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }.buttonStyle(.plain)
        }
        Button("Open chat") { open(.dm(agent)) }.buttonStyle(CardPill(tone: .soft))
      }
      .padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    }
  }

  private func card<Actions: View>(agent: Agent?, title: String, sub: String, done: Int, total: Int, @ViewBuilder actions: () -> Actions) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        if let agent { AgentAvatar(agent: agent, size: 40, showStatus: false) }
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
          Text(sub).font(.system(size: 13)).foregroundStyle(Palette.faint).fixedSize(horizontal: false, vertical: true)
        }
      }
      GeometryReader { g in
        ZStack(alignment: .leading) {
          Capsule().fill(Palette.field)
          Capsule().fill(Palette.blue).frame(width: g.size.width * CGFloat(done) / CGFloat(max(total, 1)))
        }
      }
      .frame(height: 6).accessibilityHidden(true)
      Text("\(done) of \(total) done").font(.system(size: 13)).foregroundStyle(Palette.faint)
      actions()
    }
    .padding(18).frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .contain)
  }

  private func title(_ agent: Agent, _ bad: Readiness.Check, _ devices: [ReadyDevice]?) -> String {
    if bad.id == "online", let d = devices?.first(where: { $0.id == agent.nodeId }) { return "\(agent.name) is waiting for \(d.name)" }
    return "\(agent.name) isn't ready yet"
  }

  @ViewBuilder private func primaryFix(_ bad: Readiness.Check, _ agent: Agent) -> some View {
    switch bad.to {
    case .makeHelper: if store.canManage { Button("Make an agent") { open(.addAgent) }.buttonStyle(CardPill(tone: .primary)) }
    case .chooseDevice(let id): if let a = store.agent(id) { Button("Choose a device") { open(.agent(a)) }.buttonStyle(CardPill(tone: .primary)) }
    case .chooseModel(let id): if let a = store.agent(id) { Button("Change its AI") { open(.agent(a)) }.buttonStyle(CardPill(tone: .primary)) }
    case .signIn(let id): if let a = store.agent(id) { Button("Sign in") { open(a.settings?.runIn == "computer" && a.computerId != nil ? .agent(a) : .harnesses) }.buttonStyle(CardPill(tone: .primary)) }
    case .devices: Button("See devices") { open(.devices) }.buttonStyle(CardPill(tone: .primary))
    case nil: Button("Ask \(agent.name)") { open(.dm(agent)) }.buttonStyle(CardPill(tone: .primary))
    }
  }
}
