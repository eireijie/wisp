import SwiftUI

/** Where a row in the Inbox's extra sections goes, when it can't be a plain link. */
enum InboxTarget {
  case chat(Channel)
  case thread(ThreadRef)
  case dm(Agent)
  case addAgent
  case agent(Agent)
  case devices
}

/** What an agent is doing right now: its task, or the step it's on in a chat. */
struct AgentDoing: Equatable {
  var text: String
  var `where`: String?
}

/** Plain logic behind the Inbox sections (the web's DashboardView and useWaitingOnYou). */
extension Store {
  func chatName(_ c: Channel) -> String { c.isDM ? dmAgent(c)?.name ?? "Direct message" : "#\(c.name)" }
  private func channelLabel(_ id: String?) -> String? {
    guard let id, let c = channels.first(where: { $0.id == id }) else { return nil }
    return c.isDM ? "in a DM" : "in #\(c.name)"
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

  /** New replies: DMs first, then channels, most unread first. */
  var unreadChats: [Channel] {
    channels.filter { ($0.joined == true || $0.isDM) && $0.badge > 0 }
      .sorted { ($0.isDM ? 0 : 1, -$0.badge) < ($1.isDM ? 0 : 1, -$1.badge) }
  }

  /** Unread first, then most recently read. */
  var recentChats: [Channel] {
    channels.filter { ($0.joined == true || $0.isDM) && $0.archivedAt == nil }
      .sorted { ($0.badge > 0 ? 0 : 1, $1.lastReadAt ?? "") < ($1.badge > 0 ? 0 : 1, $0.lastReadAt ?? "") }
      .prefix(5).map { $0 }
  }

  /** Tasks you handed off that haven't started or didn't finish. */
  var tasksToCheck: [WorkTask] {
    guard let me else { return [] }
    return tasks.filter { $0.from == Actor(kind: .user, id: me.id) && !$0.cancelled && ($0.status == "open" || $0.status == "failed") }
  }

  /** How much of today's background allowance is used. */
  static func allowanceText(_ a: Allowance) -> String {
    guard let daily = a.dailyTokens, daily > 0 else { return "\(Allowance.text(a.todayTokens)) used today" }
    return "\(min(100, Int((Double(a.todayTokens) / Double(daily) * 100).rounded())))% of today's allowance"
  }
}

/** The Inbox below "waiting on you": setup, what agents are doing, new replies, and more in Advanced. */
struct InboxSections: View {
  @Environment(Store.self) private var store
  var open: (InboxTarget) -> Void

  private var isGuest: Bool { store.role == "guest" }
  private var activeAgents: [Agent] { store.agentsByActivity.filter { store.doing($0) != nil || $0.status == .busy } }

  var body: some View {
    if !isGuest { ReadinessSection(open: open) }

    if store.simple, !activeAgents.isEmpty {
      Section("What agents are doing") {
        ForEach(activeAgents) { agentRow($0) }
      }
    }

    let unread = store.unreadChats
    if !unread.isEmpty {
      Section("New replies") {
        ForEach(unread) { c in
          Button { open(.chat(c)) } label: { chatRow(c, trailing: "\(c.badge) new") }
        }
      }
    }

    if store.simple, isGuest, store.recentChats.isEmpty {
      Section { Text("Conversations you're invited to show up here.").foregroundStyle(.secondary) }
    }

    if store.simple, unread.isEmpty, !store.recentChats.isEmpty {
      Section("Recent conversations") {
        ForEach(store.recentChats) { c in Button { open(.chat(c)) } label: { chatRow(c, trailing: nil) } }
      }
    }

    if store.simple, !isGuest, store.features.tasks, !store.tasksToCheck.isEmpty {
      Section("Tasks to check") {
        ForEach(store.tasksToCheck) { taskRow($0, showAgent: false) }
      }
    }

    if !store.simple { advanced }
  }

  // MARK: Advanced

  @ViewBuilder private var advanced: some View {
    Section {
      if store.agents.isEmpty {
        Text("No agents yet. Add one from Chats and it shows up here with what it's working on.").foregroundStyle(.secondary)
      }
      ForEach(store.agentsByActivity) { agentRow($0, idle: true) }
    } header: { Text("What agents are doing") }

    let teams = store.teams.filter { $0.channelId != nil }
    if !teams.isEmpty {
      Section("Teams") {
        ForEach(teams) { t in
          let members = (t.members ?? []).compactMap { store.agent($0.agentId) }
          let active = members.contains { $0.status == .busy }
          Button { if let ch = store.channels.first(where: { $0.id == t.channelId }) { open(.chat(ch)) } } label: {
            HStack(spacing: 10) {
              Image(systemName: "person.3").foregroundStyle(.secondary).frame(width: 28)
              VStack(alignment: .leading, spacing: 2) {
                Text("#\(t.name)").foregroundStyle(.primary)
                Text("\(members.count) \(members.count == 1 ? "agent" : "agents") · \(active ? "working" : "quiet")").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
          }
        }
      }
    }

    if store.features.tasks, !isGuest {
      Section {
        HStack(spacing: 0) {
          stat("To do", store.tasks.filter { $0.status == "open" }.count)
          stat("Working", store.tasks.filter { $0.status == "in_progress" }.count)
          stat("Done", store.tasks.filter { $0.status == "done" }.count)
          stat("Failed", store.tasks.filter { $0.status == "failed" && !$0.cancelled }.count, bad: true)
        }
        let working = store.tasks.filter { $0.status == "in_progress" }
        if working.isEmpty {
          Text(store.tasks.isEmpty ? "No tasks yet." : "No agent is on a task right now.").foregroundStyle(.secondary)
        }
        ForEach(working) { taskRow($0, showAgent: true) }
        NavigationLink("Open Tasks") { TasksView() }
      } header: { Text("Tasks") }
    }
  }

  private func stat(_ label: String, _ n: Int, bad: Bool = false) -> some View {
    VStack(spacing: 2) {
      Text("\(n)").font(.title3.weight(.semibold)).foregroundStyle(bad && n > 0 ? Color.red : Color.primary)
      Text(label).font(.caption).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity)
  }

  // MARK: rows

  private func agentRow(_ a: Agent, idle: Bool = false) -> some View {
    let now = store.doing(a)
    return Button { open(.dm(a)) } label: {
      HStack(spacing: 12) {
        AgentAvatar(agent: a, size: 32, showStatus: false)
        VStack(alignment: .leading, spacing: 2) {
          Text(a.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
          if let now {
            Text([now.text, now.where].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
          } else {
            Text(a.status == .offline ? "Offline" : a.status == .busy ? "Working" : "Not working on anything").font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer()
        if a.status == .busy { GlowDot(color: .green).accessibilityLabel("Working") }
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private func chatRow(_ c: Channel, trailing: String?) -> some View {
    HStack(spacing: 12) {
      if c.isDM, let a = store.dmAgent(c) { AgentAvatar(agent: a, size: 32, showStatus: false) }
      else { Image(systemName: c.private == true ? "lock" : "number").foregroundStyle(.secondary).frame(width: 32) }
      Text(store.chatName(c)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
      Spacer()
      if let trailing { Text(trailing).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }
  }

  @ViewBuilder private func taskRow(_ t: WorkTask, showAgent: Bool) -> some View {
    let agent = t.toAgentId.flatMap { store.agent($0) }
    let detail = showAgent
      ? [agent?.name ?? "an agent", t.updatedAt.flatMap(Wire.date).map { $0.formatted(.relative(presentation: .named)) }]
      : [t.status == "failed" ? "didn't finish" : "not started", t.updatedAt.flatMap(Wire.date).map { $0.formatted(.relative(presentation: .named)) }]
    let label = HStack(spacing: 12) {
      Image(systemName: t.status == "failed" ? "exclamationmark.circle" : "checklist")
        .foregroundStyle(t.status == "failed" ? Color.red : Color.secondary).frame(width: 32)
      VStack(alignment: .leading, spacing: 2) {
        Text(t.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
        Text(detail.compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }
    if let channelId = t.channelId, let ch = store.channels.first(where: { $0.id == channelId }) {
      Button { open(t.threadId.map { .thread(ThreadRef(channelId: channelId, rootId: $0)) } ?? .chat(ch)) } label: { label }
    } else {
      NavigationLink { TasksView() } label: { label }
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
    if store.agents.isEmpty {
      Section {
        VStack(alignment: .leading, spacing: 10) {
          Text("Your helper isn't ready yet").font(.headline)
          Text("Next: make your first agent").font(.subheadline).foregroundStyle(.secondary)
          if store.canManage { Button("Make a helper") { open(.addAgent) }.primaryButton() }
        }.padding(.vertical, 4).buttonStyle(.borderless)
      }
    } else if let agent, let bad {
      // Advanced only needs this when something is wrong with a helper
      Section {
        VStack(alignment: .leading, spacing: 10) {
          Text(title(agent, bad, devices)).font(.headline)
          Text(bad.fix ?? Readiness.ready(agent, devices: devices).problem ?? "Not ready yet").font(.subheadline).foregroundStyle(.secondary)
          fixButton(bad, agent)
        }.padding(.vertical, 4).buttonStyle(.borderless)
      }
    } else if store.simple, let agent {
      Section {
        VStack(alignment: .leading, spacing: 10) {
          Text("Try asking \(agent.name)…").font(.headline)
          ForEach(Self.examples, id: \.self) { Text("“\($0)”").font(.subheadline).foregroundStyle(.secondary) }
          Button("Open chat") { open(.dm(agent)) }.secondaryButton()
        }.padding(.vertical, 4).buttonStyle(.borderless)
      }
    }
  }

  private func title(_ agent: Agent, _ bad: Readiness.Check, _ devices: [ReadyDevice]?) -> String {
    if bad.id == "online", let d = devices?.first(where: { $0.id == agent.nodeId }) { return "\(agent.name) is waiting for \(d.name)" }
    return "\(agent.name) isn't ready yet"
  }

  @ViewBuilder private func fixButton(_ bad: Readiness.Check, _ agent: Agent) -> some View {
    switch bad.to {
    case .makeHelper: if store.canManage { Button("Make a helper") { open(.addAgent) }.primaryButton() }
    case .chooseDevice(let id): if let a = store.agent(id) { Button("Choose a device") { open(.agent(a)) }.secondaryButton() }
    case .chooseModel(let id): if let a = store.agent(id) { Button("Change its AI") { open(.agent(a)) }.secondaryButton() }
    case .devices: Button("See devices") { open(.devices) }.secondaryButton()
    case nil: EmptyView()
    }
    Button("Ask \(agent.name)") { open(.dm(agent)) }.font(.subheadline)
  }
}
