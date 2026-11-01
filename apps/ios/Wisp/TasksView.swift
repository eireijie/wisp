import SwiftUI
import UniformTypeIdentifiers

/** Which task a sheet is showing. */
struct TaskRef: Identifiable, Hashable { var id: String }

/**
 * Tasks: work that's been planned and handed out, in groups (waiting on you, in progress, to do,
 * done). A task nobody assigned goes to the lead, who splits it up; the pieces are its subtasks.
 */
struct TasksView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var action = FormAction()
  @State private var creating = false
  @State private var who = ""
  @State private var mine = false
  @State private var open: TaskRef?
  private var roots: [WorkTask] {
    store.tasks.filter { task in
      let parent = task.parentId ?? task.reviewOf
      return !store.tasks.contains { $0.id == parent } && (!mine || task.from == Actor(kind: .user, id: store.me?.id ?? "")) && matches(task, seen: [])
    }
  }
  private func matches(_ task: WorkTask, seen: Set<String>) -> Bool {
    guard !seen.contains(task.id) else { return false }
    if who.isEmpty || task.toAgentId == who || "team:\(task.teamId ?? "")" == who { return true }
    return store.tasks.filter { ($0.parentId ?? $0.reviewOf) == task.id }.contains { matches($0, seen: seen.union([task.id])) }
  }
  private func tree(_ task: WorkTask, seen: Set<String> = []) -> [WorkTask] {
    guard !seen.contains(task.id) else { return [] }
    return [task] + store.tasks.filter { ($0.parentId ?? $0.reviewOf) == task.id }.flatMap { tree($0, seen: seen.union([task.id])) }
  }
  private var whoName: String {
    if who.isEmpty { return "Everyone" }
    if who.hasPrefix("team:") { return "Team \(store.teams.first { "team:\($0.id)" == who }?.name ?? "")" }
    return store.agent(who)?.name ?? "Everyone"
  }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back to Inbox", id: "tasks-back") { dismiss() }
      } center: {
        Text("Tasks").font(.system(size: 20, weight: .bold)).foregroundStyle(Palette.text)
      } trailing: {
        if store.canManage && !store.agents.isEmpty { CircleButton(symbol: "plus", label: "New task", id: "tasks-new") { creating = true } }
      }
      ScrollView {
        VStack(spacing: 12) {
          filters
          InlineError(error: action.error)
          if store.agents.isEmpty {
            Text("Add an agent to hand work to").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.top, 24)
          } else if roots.isEmpty {
            Text("Nothing yet. Start a task and the lead plans it and hands the pieces out.").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
          }
          let waiting = roots.flatMap { tree($0) }.filter { store.taskWaiting($0) != nil }
          let waitingIds = Set(waiting.map(\.id))
          let open = roots.filter { !$0.closed && !waitingIds.contains($0.id) }
          let progress = open.filter { t in let s = store.taskState(t); return s == "Working" || s.hasPrefix("Waiting for") }
          let progressIds = Set(progress.map(\.id))
          let todo = open.filter { !progressIds.contains($0.id) }
          taskGroup("Waiting on you", waiting)
          taskGroup("In progress", progress)
          taskGroup("To do", todo)
          taskGroup("Done", Array(roots.filter(\.closed).prefix(20)))
        }
        .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { await load() }
    }
    .background(Palette.ground.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-tasks")
    .sheet(isPresented: $creating) { NewTaskView() }
    .sheet(item: $open) { TaskSheet(taskId: $0.id) }
    .task { await load() }
  }

  private var filters: some View {
    VStack(alignment: .leading, spacing: 8) {
      Menu {
        Picker("Show tasks for", selection: $who) {
          Text("Everyone").tag("")
          ForEach(store.agents) { Text($0.name).tag($0.id) }
          ForEach(store.teams) { Text("Team \($0.name)").tag("team:\($0.id)") }
        }
      } label: {
        HStack(spacing: 8) {
          Text("Show tasks for").foregroundStyle(Palette.faint)
          Spacer()
          Text(whoName).foregroundStyle(Palette.text)
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
        }
        .font(.system(size: 15)).padding(.horizontal, 16).frame(height: 44)
        .background(Capsule().fill(Palette.field))
      }
      .accessibilityIdentifier("tasks-filter")
      Toggle("Only what I asked for", isOn: $mine).font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
    }
  }

  @ViewBuilder private func taskGroup(_ title: String, _ tasks: [WorkTask]) -> some View {
    if !tasks.isEmpty {
      InboxHead(title: title, right: "\(tasks.count)")
      CardGroup {
        ForEach(tasks) { task in
          Button { open = TaskRef(id: task.id) } label: { TaskRow(task: task) }
            .buttonStyle(.plain).accessibilityIdentifier("task-row")
        }
      }
    }
  }

  private func load() async { do { try await store.refreshTasks(); try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
}

/** A task in a list: its agent's ghost, the title, how it's going and who has it. */
struct TaskRow: View {
  @Environment(Store.self) private var store
  var task: WorkTask
  var body: some View {
    let agent = store.agent(task.toAgentId ?? "")
    HStack(spacing: 12) {
      AgentAvatar(agent: agent, size: 32, showStatus: false)
      VStack(alignment: .leading, spacing: 5) {
        Text(task.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
        HStack(spacing: 8) {
          StateChip(text: store.taskState(task))
          Text(agent?.name ?? "an agent").font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 68)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/** One task as a sheet: its details, the pieces it was split into, and Merge or Cancel. */
struct TaskSheet: View {
  var taskId: String
  var body: some View {
    NavigationStack {
      TaskDetail(taskId: taskId, root: true)
        .navigationDestination(for: TaskRef.self) { TaskDetail(taskId: $0.id, root: false) }
        .chatDestinations()
    }
    .tint(Palette.text)
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
  }
}

struct TaskDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var taskId: String
  var root = false
  @State private var cancelling = false
  @State private var retrying = FormAction()
  @State private var merging = false
  @State private var editing = false
  @State private var output: String?
  @State private var action = FormAction()

  init(taskId: String, root: Bool = false) { self.taskId = taskId; self.root = root }
  /** the older call sites (a task chip in a chat) hand over the task itself */
  init(task: WorkTask, root: Bool = true) { self.init(taskId: task.id, root: root) }

  private var current: WorkTask? { store.tasks.first { $0.id == taskId } }
  private func mergeSource(_ t: WorkTask) -> WorkTask { store.tasks.first { $0.id == t.reviewOf } ?? t }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: root ? "xmark" : "chevron.left", label: root ? "Close" : "Back", id: "task-close") { dismiss() }
      } center: {
        EmptyView()
      } trailing: {
        if let t = current { menu(t) }
      }
      if let t = current { content(t) } else { Spacer() }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-task-detail")
    .sheet(isPresented: $editing) { if let t = current { TaskStatusEditor(task: t) } }
    .confirmationDialog("Cancel this task?", isPresented: $cancelling, titleVisibility: .visible) {
      Button("Cancel task", role: .destructive) { action.run { try await store.cancelTask(taskId) } }
      Button("Keep it", role: .cancel) {}
    } message: { Text("\(store.agent(current?.toAgentId ?? "")?.name ?? "The agent") won't work on it.") }
    .confirmationDialog("Merge this task's branch?", isPresented: $merging, titleVisibility: .visible) {
      Button("Merge") { action.run { output = try await store.mergeTask(taskId) } }
      Button("Keep reviewing", role: .cancel) {}
    } message: {
      if let t = current { Text("\(mergeSource(t).branch ?? "The branch") goes into the team's main branch. \(store.agent(t.toAgentId ?? "")?.name ?? "The agent")'s changes become part of the project.") }
    }
  }

  @ViewBuilder private func menu(_ t: WorkTask) -> some View {
    let channel = store.channels.first { $0.id == t.channelId }
    Menu {
      if let channel { NavigationLink { TaskConversation(channel: channel, thread: t.threadId) } label: { Label("Open conversation", systemImage: "bubble.left") } }
      if store.canManage {
        Button("Edit", systemImage: "pencil") { editing = true }
        if !t.closed && store.taskWaiting(t) == nil { Button("Cancel task", systemImage: "xmark.circle", role: .destructive) { cancelling = true } }
      }
    } label: { CircleLabel(symbol: "ellipsis", weight: .regular) }
      .accessibilityLabel("More").accessibilityIdentifier("task-more")
  }

  @ViewBuilder private func content(_ t: WorkTask) -> some View {
    let agent = store.agent(t.toAgentId ?? "")
    let state = store.taskState(t)
    let source = mergeSource(t)
    let children = store.tasks.filter { ($0.parentId ?? $0.reviewOf) == t.id }
    let channel = store.channels.first { $0.id == t.channelId }
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 8) {
          Text(t.title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 10) {
            StateChip(text: state)
            Text(asked(t)).font(.system(size: 13)).foregroundStyle(Palette.faint)
          }
        }
        CardGroup {
          fieldRow("Assignee") {
            AgentAvatar(agent: agent, size: 26, showStatus: false)
            Text(agent?.name ?? "an agent").foregroundStyle(Palette.text)
          }
          fieldRow("Status") { Text(state).foregroundStyle(Palette.text) }
          if let branch = source.branch {
            fieldRow("Branch") { Text(branch).font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled) }
          }
          if source.mergedAt != nil { fieldRow("Merged") { Text("Yes").foregroundStyle(Palette.statusOnline) } }
        }
        if let waiting = store.taskWaiting(t) {
          InboxHead(title: "What \(agent?.name ?? "the agent") is doing")
          note { Text(waiting).foregroundStyle(Color(hex: 0xFFB86B)) }
        } else if !t.closed {
          InboxHead(title: "What \(agent?.name ?? "the agent") is doing")
          note {
            if state == "Working" {
              HStack(spacing: 10) {
                WorkingDots()
                Text(agent.flatMap { store.doing($0) }?.text ?? "Working on it").font(.system(size: 15)).foregroundStyle(Palette.statusOnline)
              }
            }
            if !t.brief.isEmpty, t.brief != t.title { Text(t.brief).font(.system(size: 13)).foregroundStyle(Palette.text.opacity(0.85)) }
          }
        }
        if let result = t.result, !result.isEmpty {
          InboxHead(title: t.cancelled ? "Cancelled" : t.status == "failed" ? "What happened" : "Result")
          note { NoteMarkdown(text: result) }
        }
        if state == "Failed" {
          PillButton(title: "Try again", busy: retrying.busy, id: "task-retry") { retrying.run { try await store.retryTask(t.id) } }
          InlineError(error: retrying.error)
        }
        if channel != nil, t.closed || store.taskWaiting(t) != nil || state == "Working" {
          if let channel {
            NavigationLink { TaskConversation(channel: channel, thread: t.threadId) } label: {
              Text("Open conversation").font(.system(size: 15, weight: .medium)).foregroundStyle(Color(hex: 0x9EC5FF))
            }.padding(.horizontal, 6)
          }
        }
        if !children.isEmpty {
          InboxHead(title: "Subtasks", right: "\(children.count)")
          CardGroup {
            ForEach(children) { child in
              NavigationLink(value: TaskRef(id: child.id)) { subtaskRow(child) }.buttonStyle(.plain)
            }
          }
        }
        if let output { Text(output).font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.muted).textSelection(.enabled) }
        InlineError(error: action.error)
        buttons(t, source: source, state: state)
      }
      .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 30)
    }
    .scrollIndicators(.hidden)
  }

  @ViewBuilder private func buttons(_ t: WorkTask, source: WorkTask, state: String) -> some View {
    let canMerge = source.branch != nil && source.mergedAt == nil && store.canManage && t.status == "done"
    let canCancel = store.canManage && !t.closed && store.taskWaiting(t) == nil
    if canMerge || canCancel {
      HStack(spacing: 10) {
        if canMerge { Button("Merge") { merging = true }.buttonStyle(CardPill(tone: .primary)).accessibilityIdentifier("task-merge").accessibilityLabel("Merge this task's branch") }
        if canCancel { Button("Cancel task") { cancelling = true }.buttonStyle(CardPill(tone: .soft, tint: Palette.red)).accessibilityIdentifier("task-cancel") }
      }
      .disabled(action.busy)
    }
  }

  private func asked(_ t: WorkTask) -> String {
    let who: String
    if t.from?.kind == .agent { who = "@\(store.agent(t.from?.id ?? "")?.handle ?? "agent")" }
    else if t.from?.id == store.me?.id { who = "you" }
    else { who = store.members.first { $0.id == t.from?.id }?.name ?? "someone" }
    let when = t.createdAt.flatMap(Wire.date).map { " · " + ChatList.timeText($0) } ?? ""
    return "Asked by \(who)\(when)"
  }

  private func fieldRow<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
    HStack(spacing: 12) {
      Text(label).font(.system(size: 15)).foregroundStyle(Palette.faint).frame(width: 78, alignment: .leading)
      value().font(.system(size: 15))
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 18).frame(minHeight: 54)
    .accessibilityElement(children: .combine)
  }

  private func note<V: View>(@ViewBuilder _ body: () -> V) -> some View {
    VStack(alignment: .leading, spacing: 8) { body() }
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 14)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }

  private func subtaskRow(_ child: WorkTask) -> some View {
    let state = store.taskState(child)
    let icon = state == "Done" ? "checkmark.circle" : state == "Failed" || state == "Cancelled" ? "xmark.circle" : "circle"
    let hue = state == "Done" ? Palette.statusOnline : state == "Failed" ? Palette.red : Palette.faint
    return HStack(spacing: 12) {
      Image(systemName: icon).font(.system(size: 22, weight: .regular)).foregroundStyle(hue)
      Text(child.title).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
      Spacer(minLength: 8)
      StateChip(text: state)
    }
    .padding(.horizontal, 18).frame(minHeight: 56).contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

struct TaskStatusEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var task: WorkTask
  @State private var status = "open"
  @State private var result = ""
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: "Edit task", action: action, valid: result.count <= 40_000, save: {
      action.run { try await store.updateTask(task.id, status: status, result: result); dismiss() }
    }) {
      Picker("Status", selection: $status) {
        Text("To do").tag("open"); Text("In progress").tag("in_progress"); Text("Done").tag("done"); Text("Failed").tag("failed")
      }
      TextField("Result", text: $result, axis: .vertical).lineLimit(5...20)
      Text("The title, details and assignee are fixed once a task is handed off.").font(.footnote).foregroundStyle(.secondary)
    }.onAppear { status = task.status; result = task.result ?? "" }
  }
}

/** Start a task: what needs doing, who takes it, files to go with it. */
struct NewTaskView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var brief = ""
  @State private var to = "auto"
  @State private var files: [URL] = []
  @State private var importing = false
  @State private var action = FormAction()
  @FocusState private var titleFocused: Bool
  private var lead: Agent? { store.agent(store.taskLead ?? "") }
  private var solo: Agent? { store.agents.count == 1 ? store.agents.first : nil }
  private var valid: Bool { store.canManage && !store.agents.isEmpty && !title.trimmed.isEmpty && title.count <= 200 && brief.count <= 20_000 }
  private var hint: String? {
    if to == "auto", let lead { return "\(lead.name) breaks it into pieces and hands each to the agent whose role fits. You'll see them as subtasks." }
    if to.hasPrefix("team:") { return "The team's lead takes it and splits it up as needed." }
    if let agent = store.agent(to) { return agent.status == .offline ? "\(agent.name) is offline; it starts when its device connects." : "\(agent.name) starts right away." }
    return nil
  }

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        Text("New task").font(.system(size: 16, weight: .bold)).foregroundStyle(Palette.text)
        HStack {
          CircleButton(symbol: "xmark", label: "Close", id: "new-task-close") { dismiss() }
          Spacer()
          Button { send() } label: {
            Group { if action.busy { ProgressView() } else { Text("Hand off") } }.frame(minWidth: 70)
          }
          .buttonStyle(CardPill(tone: .primary)).fixedSize().disabled(!valid || action.busy)
          .accessibilityIdentifier("new-task-send")
        }
      }
      .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if store.agents.isEmpty { Text("Add an agent to hand work to").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text) }
          CardGroup {
            TextField("What needs doing?", text: $title)
              .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
              .focused($titleFocused).padding(.horizontal, 18).frame(height: 54)
            TextField("Details", text: $brief, axis: .vertical)
              .font(.system(size: 15)).foregroundStyle(Palette.text)
              .lineLimit(4...10).padding(.horizontal, 18).padding(.vertical, 14).frame(minHeight: 110, alignment: .topLeading)
          }
          if let solo {
            Text("\(solo.name) will do this.").font(.system(size: 15)).foregroundStyle(Palette.text).padding(.horizontal, 6)
          } else if !store.agents.isEmpty {
            InboxHead(title: "Who takes it?")
            CardGroup {
              if let lead {
                choice("auto", { AgentAvatar(agent: lead, size: 28, showStatus: false) }, "Let \(lead.name) plan it", aside: "sparkles")
              }
              ForEach(store.agents.filter { $0.id != lead?.id }) { a in
                choice(a.id, { AgentAvatar(agent: a, size: 28, showStatus: false) }, a.name + ((a.settings?.role).flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""))
              }
              ForEach(store.teams.filter { $0.leadId != nil }) { t in
                choice("team:\(t.name)", { TeamGhosts(agents: (t.members ?? []).compactMap { store.agent($0.agentId) }, seed: t.name, size: 30) }, t.name, trailing: "Lead takes it")
              }
            }
            if let hint { Text(hint).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 6) }
          }
          CardGroup {
            Button { importing = true } label: { RowLabel(title: "Attach files", chevron: false) { Image(systemName: "paperclip").foregroundStyle(Palette.muted) } }.buttonStyle(.plain)
            ForEach(files, id: \.self) { file in
              HStack {
                Text(file.lastPathComponent).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(1)
                Spacer()
                Button { files.removeAll { $0 == file } } label: { Image(systemName: "xmark") }.accessibilityLabel("Remove \(file.lastPathComponent)").foregroundStyle(Palette.muted)
              }.padding(.horizontal, 18).frame(minHeight: 48)
            }
          }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 30)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .tint(Palette.text)
    .accessibilityIdentifier("screen-new-task")
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      do { files += try result.get() } catch { action.error = error.localizedDescription }
    }
    .task { do { try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
    .onAppear { titleFocused = true }
  }

  private func choice<L: View>(_ value: String, @ViewBuilder _ leading: () -> L, _ text: String, aside: String? = nil, trailing: String? = nil) -> some View {
    Button { to = value } label: {
      HStack(spacing: 12) {
        leading()
        Text(text).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(1)
        if let aside { Image(systemName: aside).font(.system(size: 13)).foregroundStyle(Palette.muted) }
        Spacer(minLength: 8)
        if let trailing { Text(trailing).font(.system(size: 13)).foregroundStyle(Palette.faint) }
        if to == value { Image(systemName: "checkmark.circle").font(.system(size: 22)).foregroundStyle(Palette.blue) }
      }
      .padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(to == value ? .isSelected : [])
  }

  private func send() {
    action.run {
      var ids: [String] = []
      for file in files { ids.append(try await store.uploadTaskFile(file).id) }
      let task = try await store.createTask(["to": AnyEncodable(to), "title": AnyEncodable(title.trimmed), "brief": AnyEncodable(brief.trimmed.isEmpty ? title.trimmed : brief.trimmed), "fileIds": AnyEncodable(ids)])
      if let channel = task.channelId { store.route = .chat(channelId: channel, threadId: task.threadId) }
      dismiss()
    }
  }
}

struct TaskConversation: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var channel: Channel
  var thread: String?
  var body: some View {
    Group {
      if let thread { ThreadView(ref: ThreadRef(channelId: channel.id, rootId: thread)) }
      else { ChannelView(channel: channel) }
    }.managementAlert(action).task {
      if thread != nil {
        do { try await store.loadMessages(channel.id) } catch { action.error = error.localizedDescription }
      }
    }
  }
}
