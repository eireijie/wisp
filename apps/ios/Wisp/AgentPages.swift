import SwiftUI

// The smaller pages of an agent: who can ask it, connected apps, skills, memory, activity and a run.

// MARK: who can ask it

/** Who can ask it (agent-Access.dc.html): only me, anyone, or picked people; plus the device's own rule. */
struct AgentWhoPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var mode = "anyone"
  @State private var people: Set<String> = []
  @State private var loaded = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var canSet: Bool { (store.isOwner || current.settings?.createdBy == store.me?.id) && (store.features.invite || store.members.count > 1) }
  private var saved: String { current.settings?.respondTo ?? "anyone" }
  private var savedPeople: Set<String> { Set(current.settings?.respondPeople ?? []) }
  private var dirty: Bool { mode != saved || (mode == "people" && people != savedPeople) }

  var body: some View {
    AgentFrame(title: "Who can ask it", subtitle: current.name) {
      if canSet {
        CardGroup {
          ChoiceRow(title: "Only me", selected: mode == "me") { mode = "me" }
          ChoiceRow(title: "Anyone", subtitle: "Everyone in \(store.workspace?.name ?? "this organization")", selected: mode == "anyone") { mode = "anyone" }
          ChoiceRow(title: "Picked people", selected: mode == "people") { mode = "people" }
        }.disabled(action.busy)
        if mode == "people" {
          CardCaption("Picked people")
          if store.otherPeople.isEmpty && store.me == nil {
            AgentCard { Text("Nobody else is here yet.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
          } else {
            CardGroup {
              ForEach(store.members) { member in
                ChoiceRow(title: member.preferredName ?? member.name, subtitle: member.id == store.me?.id ? "\(member.role.capitalized) · you" : member.role.capitalized, selected: people.contains(member.id), action: {
                  if people.contains(member.id) { people.remove(member.id) } else { people.insert(member.id) }
                }, leading: { initials(member) })
              }
            }.disabled(action.busy)
            CardCaption("People you pick can message @\(current.handle) in chats and teams. Nobody else here yet? Invite people first from Settings.")
          }
        }
        AgentError(text: action.error)
        PillButton(title: "Save", busy: action.busy, id: "who-save") {
          action.run { _ = try await store.updateAgent(current.id, ["settings": AnyEncodable(AskWho.settings(mode, people: people))]); dismiss() }
        }.disabled(!dirty || action.busy || (mode == "people" && people.isEmpty))
      }
      if let device, store.harnessOnDevice(current) {
        CardCaption("On its device")
        AgentCard {
          Text("@\(current.handle) runs directly on \(device.mine == true ? "your" : "\(device.ownerName ?? "someone")'s") device \"\(device.name)\", where it can reach files.")
            .font(.system(size: 15)).foregroundStyle(Palette.muted)
        }
        if device.mine == true && device.shared != true && store.canManage {
          CardGroup {
            ChoiceRow(title: "Only me", subtitle: "Only you can ask it", selected: current.settings?.anyoneCanAsk != true) { setDeviceRule(false) }
            ChoiceRow(title: "Anyone in the organization", selected: current.settings?.anyoneCanAsk == true) { setDeviceRule(true) }
          }.disabled(action.busy)
        } else {
          CardCaption(device.shared == true || current.settings?.anyoneCanAsk == true ? "Anyone in the organization can ask it." : "Only \(device.ownerName ?? "its owner") can ask it.")
        }
        if !canSet { AgentError(text: action.error) }
      }
    }
    .onAppear {
      guard !loaded else { return }
      mode = saved; people = savedPeople; loaded = true
    }
  }

  private func setDeviceRule(_ value: Bool) {
    guard (current.settings?.anyoneCanAsk ?? false) != value else { return }
    action.run { _ = try await store.updateAgent(current.id, ["settings": AnyEncodable(["anyoneCanAsk": value])]) }
  }

  private func initials(_ member: Member) -> some View {
    let letters = (member.preferredName ?? member.name).split(separator: " ").prefix(2).compactMap { $0.first }
    return Text(String(letters).uppercased()).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
      .frame(width: 36, height: 36).background(Circle().fill(Color(light: 0xE3E3EA, dark: 0x34343A))).accessibilityHidden(true)
  }
}

// MARK: connected apps

/** Connected apps (agent-Apps.dc.html): turn each app on or off for this agent only. */
struct AgentAppsPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var action = FormAction()
  @State private var loaded = false

  var body: some View {
    AgentFrame(title: "Connected apps", subtitle: agent.name) {
      if store.connectors.isEmpty {
        AgentCard { Text(loaded ? "No apps are connected yet." : "Loading…").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(store.connectors) { app in
            if app.forAll {
              SwitchRow(title: app.name, subtitle: "All agents", isOn: .constant(true), id: "app-\(app.id)").disabled(true)
            } else {
              SwitchRow(title: app.name, subtitle: app.needsSignIn ? "Needs sign-in" : app.description ?? app.category,
                        isOn: Binding(get: { app.agentIds?.contains(agent.id) == true }, set: { on in set(app, on) }), id: "app-\(app.id)")
            }
          }
        }
        .disabled(!store.canManage || action.busy)
      }
      CardCaption("Turn an app off to take it away from \(agent.name) only. Other agents keep it.")
      AgentError(text: action.error)
      NavigationLink { ConnectorsView() } label: { PillLabel(title: "Connect an app", kind: .secondary) }
        .buttonStyle(.plain).accessibilityIdentifier("apps-connect")
    }
    .task {
      try? await store.refreshConnectors()
      loaded = true
    }
  }

  private func set(_ app: AppConnector, _ on: Bool) {
    var ids = Set(app.agentIds ?? [])
    if on { ids.insert(agent.id) } else { ids.remove(agent.id) }
    action.run { _ = try await store.saveConnector(app.id, ["agentIds": AnyEncodable(ids.sorted())]) }
  }
}

// MARK: skills

/** Skills (agent-Skills.dc.html): which skills this agent has; Browse skills opens the shop. */
struct AgentSkillsPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var action = FormAction()
  @State private var loaded = false

  var body: some View {
    AgentFrame(title: "Skills", subtitle: agent.name) {
      if store.skills.isEmpty {
        AgentCard { Text(loaded ? "No skills yet. Browse skills to add some." : "Loading…").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(store.skills) { skill in
            if skill.forAll {
              SwitchRow(title: skill.name, subtitle: "All agents", isOn: .constant(true), id: "skill-\(skill.id)").disabled(true)
            } else {
              SwitchRow(title: skill.name, subtitle: skill.plain?.does ?? skill.description,
                        isOn: Binding(get: { skill.agentIds?.contains(agent.id) == true }, set: { on in set(skill, on) }), id: "skill-\(skill.id)")
            }
          }
        }
        .disabled(!store.canManage || action.busy)
      }
      AgentError(text: action.error)
      NavigationLink { MarketplaceView() } label: { PillLabel(title: "Browse skills", kind: .secondary) }
        .buttonStyle(.plain).accessibilityIdentifier("skills-browse")
    }
    .task {
      try? await store.refreshSkills()
      loaded = true
    }
  }

  private func set(_ skill: HelperSkill, _ on: Bool) {
    var ids = Set(skill.agentIds ?? [])
    if on { ids.insert(agent.id) } else { ids.remove(agent.id) }
    action.run { _ = try await store.saveSkill(skill.id, ["agentIds": AnyEncodable(ids.sorted())]) }
  }
}

// MARK: memory

/** Memory (agent-Memory.dc.html): its notes folder, recent notes, what loads at startup, who can edit. */
struct AgentMemoryPage: View {
  @Environment(Store.self) private var store
  var agent: Agent

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var folder: String { "agents/\(current.id)" }
  private var recent: [MemoryNote] {
    Array(store.notes.filter { $0.path.hasPrefix(folder + "/") && $0.path != SoulText.path(current.id) }
      .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }.prefix(5))
  }

  var body: some View {
    AgentFrame(title: "Memory", subtitle: current.name) {
      CardGroup {
        NavigationLink { MemoryFolderView(folder: folder) } label: {
          RowLabel(title: "\(current.name)'s notes", subtitle: folder, leading: { rowIcon("folder") })
        }.buttonStyle(.plain).accessibilityIdentifier("memory-folder-row")
      }
      CardCaption("Recent notes")
      if recent.isEmpty {
        AgentCard { Text("No notes yet. \(current.name) writes here as it learns.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(recent) { note in
            NavigationLink { NoteView(path: note.path) } label: {
              RowLabel(title: note.name, subtitle: edited(note))
            }.buttonStyle(.plain)
          }
        }
      }
      CardCaption("Always remind it")
      CardGroup {
        NavigationLink { AgentPersonalityPage(agent: current) } label: { RowLabel(title: "Personality") }.buttonStyle(.plain)
        NavigationLink { AgentInstructionsPage(agent: current) } label: { RowLabel(title: "Instructions") }.buttonStyle(.plain)
      }
      CardGroup {
        NavigationLink { AgentPermissions(agent: current) } label: {
          RowLabel(title: "Who can edit its notes", value: current.settings?.soulLocked == true ? "Only people" : "People and \(current.name)")
        }.buttonStyle(.plain)
      }
      NavigationLink { MemoryFolderView(folder: folder) } label: { PillLabel(title: "Open in Memory", kind: .secondary) }
        .buttonStyle(.plain).accessibilityIdentifier("memory-open")
    }
    .task { try? await store.refreshNotes() }
  }

  private func edited(_ note: MemoryNote) -> String {
    guard let ms = note.updatedAt else { return "Edited" }
    return "Edited " + Date(timeIntervalSince1970: ms / 1000).formatted(.relative(presentation: .named))
  }
}

// MARK: activity

/** Activity (agent-Activity.dc.html): the agent's recent runs; tap one for what happened. */
struct AgentActivityPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var runs: [AgentRun]?
  @State private var error: String?

  var body: some View {
    AgentFrame(title: "Activity", subtitle: agent.name) {
      if let runs {
        if runs.isEmpty {
          AgentCard { Text("No activity yet.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
        } else {
          CardGroup {
            ForEach(runs) { run in
              NavigationLink { AgentRunPage(agent: agent, run: run) } label: { runRow(run) }
                .buttonStyle(.plain).accessibilityIdentifier("activity-run")
            }
          }
        }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      }
      AgentError(text: error)
      if error != nil { PillButton(title: "Try again", kind: .secondary) { Task { await load() } } }
      CardCaption("Nothing yet? Message the agent and its work will show up here.")
    }
    .task(id: agent.status) { await load() }
    .refreshable { await load() }
  }

  private func runRow(_ run: AgentRun) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(RunLine.title(run)).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
        Text(when(run)).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 3) {
        StatusPill(run: run)
        if let time = RunLine.duration(from: run.createdAt, to: run.finishedAt) {
          Text(run.status == "running" ? "\(time) so far" : time).font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
      }
      Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 68).contentShape(Rectangle())
  }

  private func when(_ run: AgentRun) -> String {
    let place = run.channelName.map { " · in \($0)" } ?? ""
    if run.status == "running" { return "Now" + place }
    guard let date = run.createdAt.flatMap(Wire.date) else { return place.isEmpty ? "" : String(place.dropFirst(3)) }
    return RunLine.day(date) + place
  }

  private func load() async {
    do { runs = try await store.agentRuns(agent.id); error = nil }
    catch { self.error = error.localizedDescription }
  }
}

/** Working, Done or Failed in a small pill. */
struct StatusPill: View {
  var run: AgentRun
  var body: some View {
    let text = RunLine.status(run)
    let color: Color = RunLine.isGood(run) ? Palette.statusOnline : RunLine.isBad(run) ? Palette.red : run.status == "running" ? Palette.blue : Palette.muted
    Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(color)
      .padding(.horizontal, 10).frame(height: 24).background(Capsule().fill(color.opacity(0.16)))
  }
}

/** Run (agent-Run.dc.html): status, where, which device, and what happened as a timeline. */
struct AgentRunPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var run: AgentRun
  @State private var chat: Channel?
  @State private var thread: ThreadRef?

  private var device: AgentNode? { store.nodes.first { $0.id == (store.agent(agent.id) ?? agent).nodeId } }
  private var channel: Channel? { run.channelId.flatMap { id in store.channels.first { $0.id == id } } }

  var body: some View {
    AgentFrame(title: "Run", subtitle: RunLine.title(run)) {
      CardGroup {
        info("Status", RunLine.status(run))
        if let name = run.channelName { info("Where", channel.map { store.title(of: $0) } ?? name) }
        if let device { info("Ran on", device.name) }
        if let time = RunLine.duration(from: run.createdAt, to: run.finishedAt) { info("Took", time) }
      }
      CardCaption("What it did")
      AgentCard {
        VStack(alignment: .leading, spacing: 0) {
          step(symbol: "bubble.left", title: asked, detail: [started, run.channelName.map { "from \($0)" }].compactMap { $0 }.joined(separator: " · "), last: false)
          if run.status == "running" {
            step(symbol: "ellipsis", title: store.activity[agent.id].flatMap { $0 == "started" ? nil : $0 } ?? "Working on it", detail: RunLine.duration(from: run.createdAt, to: nil).map { "\($0) so far" } ?? "", last: true)
          } else {
            step(symbol: RunLine.isBad(run) ? "exclamationmark.circle" : "checkmark.circle", title: outcome, detail: finish, last: true, bad: RunLine.isBad(run))
          }
        }
      }
      if channel != nil {
        Button { RunOpen.open(run, channel: channel, chat: &chat, thread: &thread) } label: { PillLabel(title: "Open the conversation", kind: .secondary) }.buttonStyle(.plain)
      }
    }
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .navigationDestination(item: $thread) { ThreadView(ref: $0) }
  }

  private var asked: String {
    let text = (run.trigger ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return run.kind == "background" ? "It checked in on its own" : text.isEmpty ? "You asked" : "You asked: \(text)"
  }

  private var started: String? { run.createdAt.flatMap(Wire.date).map { RunLine.day($0) } }

  private var outcome: String {
    if RunLine.isBad(run) { return run.hint ?? (run.error?.isEmpty == false ? run.error! : "It couldn't finish") }
    return RunLine.status(run) == "Stopped" ? "Stopped before it finished" : "Finished"
  }

  private var finish: String {
    let time = RunLine.duration(from: run.createdAt, to: run.finishedAt)
    return time.map { RunLine.isBad(run) ? "Stopped after \($0)" : "Done in \($0)" } ?? ""
  }

  private func info(_ title: String, _ value: String) -> some View {
    HStack { Text(title).font(.system(size: 15)).foregroundStyle(Palette.text); Spacer(); Text(value).font(.system(size: 15)).foregroundStyle(Palette.faint).lineLimit(1) }
      .padding(.horizontal, 18).frame(minHeight: 54)
  }

  private func step(symbol: String, title: String, detail: String, last: Bool, bad: Bool = false) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(spacing: 0) {
        Image(systemName: symbol).font(.system(size: 14, weight: .medium)).foregroundStyle(bad ? Palette.red : Palette.muted)
          .frame(width: 28, height: 28).background(Circle().fill(Palette.control))
        if !last { Rectangle().fill(Palette.separator).frame(width: 1).frame(minHeight: 18) }
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15)).foregroundStyle(bad ? Palette.red : Palette.text).fixedSize(horizontal: false, vertical: true)
        if !detail.isEmpty { Text(detail).font(.system(size: 13)).foregroundStyle(Palette.faint) }
      }.padding(.bottom, last ? 0 : 14)
      Spacer(minLength: 0)
    }
  }
}

extension RunLine {
  /** "Today 11:02 AM", "Yesterday 6:12 PM", "Oct 18 9:00 AM". */
  static func day(_ date: Date) -> String {
    let time = date.formatted(.dateTime.hour().minute())
    if Calendar.current.isDateInToday(date) { return "Today \(time)" }
    if Calendar.current.isDateInYesterday(date) { return "Yesterday \(time)" }
    return date.formatted(.dateTime.month(.abbreviated).day()) + " " + time
  }
}

/** Where "Open the conversation" goes: the run's own thread when it ran in one, else its chat. */
enum RunOpen {
  static func thread(for run: AgentRun) -> ThreadRef? {
    guard let channel = run.channelId, let root = run.threadId, !root.isEmpty else { return nil }
    return ThreadRef(channelId: channel, rootId: root)
  }
  static func open(_ run: AgentRun, channel: Channel?, chat: inout Channel?, thread: inout ThreadRef?) {
    if let ref = Self.thread(for: run) { thread = ref } else { chat = channel }
  }
}
