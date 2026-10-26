import SwiftUI
import UniformTypeIdentifiers

struct TasksView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  @State private var creating = false
  @State private var who = ""
  @State private var mine = false
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
  var body: some View {
    List {
      Section {
        Picker("Show tasks for", selection: $who) {
          Text("Everyone").tag("")
          ForEach(store.agents) { Text($0.name).tag($0.id) }
          ForEach(store.teams) { Text("Team \($0.name)").tag("team:\($0.id)") }
        }
        Toggle("Only what I asked for", isOn: $mine)
      }
      InlineError(error: action.error)
      if store.agents.isEmpty { Text("Add an agent to hand work to").font(.headline) }
      if roots.isEmpty { Text("Nothing yet. Start a task and the lead plans it and hands the pieces out.").foregroundStyle(.secondary) }
      taskSection("Waiting on you", tasks: roots.flatMap { tree($0) }.filter { store.taskWaiting($0) != nil })
      taskSection("In progress", tasks: roots.filter { !$0.closed && ["Working", "Needs you"].contains(store.taskState($0)) })
      taskSection("To do", tasks: roots.filter { !$0.closed && !["Working", "Needs you"].contains(store.taskState($0)) })
      taskSection("Done", tasks: Array(roots.filter(\.closed).prefix(20)))
    }
    .sectionScreen("Tasks", id: "tasks")
    .toolbar { if store.canManage { Button("New task", systemImage: "plus") { creating = true } } }
    .sheet(isPresented: $creating) { NewTaskView() }
    .task { await load() }.refreshable { await load() }
  }
  @ViewBuilder private func taskSection(_ title: String, tasks: [WorkTask]) -> some View {
    if !tasks.isEmpty {
      Section(title) { ForEach(tasks) { task in NavigationLink { TaskDetail(task: task) } label: { TaskRow(task: task) }.accessibilityIdentifier("task-row") } }
    }
  }
  private func load() async { do { try await store.refreshTasks(); try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
}

struct TaskRow: View {
  @Environment(Store.self) private var store
  var task: WorkTask
  var showsTitle = true
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if showsTitle { Text(task.title).font(.headline) }
      Text("\(store.agent(task.toAgentId ?? "")?.name ?? "an agent") · \(store.taskState(task))").font(.caption).foregroundStyle(.secondary)
      if let waiting = store.taskWaiting(task) { Text(waiting).font(.caption).foregroundStyle(.orange) }
    }
  }
}

struct TaskDetail: View {
  @Environment(Store.self) private var store
  var task: WorkTask
  @State private var editing = false
  @State private var cancelling = false
  @State private var merging = false
  @State private var output: String?
  @State private var action = FormAction()
  private var current: WorkTask { store.tasks.first { $0.id == task.id } ?? task }
  private var mergeSource: WorkTask { store.tasks.first { $0.id == current.reviewOf } ?? current }
  var body: some View {
    List {
      Section { Text(current.title).font(.title2.bold()); TaskRow(task: current, showsTitle: false); NoteMarkdown(text: current.brief) }
      if let result = current.result, !result.isEmpty { Section("Result") { NoteMarkdown(text: result) } }
      if let channel = store.channels.first(where: { $0.id == current.channelId }) {
        Section { NavigationLink("Open conversation") { TaskConversation(channel: channel, thread: current.threadId) } }
      }
      let children = store.tasks.filter { ($0.parentId ?? $0.reviewOf) == current.id }
      if !children.isEmpty {
        Section("Subtasks") { ForEach(children) { child in NavigationLink { TaskDetail(task: child) } label: { TaskRow(task: child) } } }
      }
      if let branch = mergeSource.branch {
        Section("Branch") {
          Text(branch).textSelection(.enabled)
          if mergeSource.mergedAt != nil { Text("Merged").foregroundStyle(.green) }
          else if store.canManage { Button("Merge") { merging = true }.disabled(action.busy) }
        }
      }
      if store.canManage {
        Section {
          Button("Edit") { editing = true }
          if !current.closed && store.taskWaiting(current) == nil { Button("Cancel task", role: .destructive) { cancelling = true }.disabled(action.busy) }
        }
      }
      if let output { Text(output).textSelection(.enabled) }
      InlineError(error: action.error)
    }
    .sectionScreen("Task", id: "task-detail")
    .sheet(isPresented: $editing) { TaskStatusEditor(task: current) }
    .confirmationDialog("Cancel this task?", isPresented: $cancelling, titleVisibility: .visible) {
      Button("Cancel task", role: .destructive) { action.run { try await store.cancelTask(current.id) } }
    } message: { Text("\(store.agent(current.toAgentId ?? "")?.name ?? "The agent") won't work on it.") }
    .confirmationDialog("Merge this task's branch?", isPresented: $merging, titleVisibility: .visible) {
      Button("Merge") { action.run { output = try await store.mergeTask(current.id) } }
    }
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

struct NewTaskView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var brief = ""
  @State private var to = "auto"
  @State private var files: [URL] = []
  @State private var importing = false
  @State private var action = FormAction()
  private var receiver: Agent? { store.agents.count == 1 ? store.agents.first : store.agent(to == "auto" ? store.taskLead ?? "" : to) }
  private var sendTitle: String { to == "auto" || store.agents.count == 1 ? "Send to \(receiver?.name ?? "the lead")" : "Hand it off" }
  var body: some View {
    EditorSheet(title: "New task", action: action, valid: store.canManage && !store.agents.isEmpty && !title.trimmed.isEmpty && title.count <= 200 && brief.count <= 20_000, saveTitle: sendTitle, save: {
      action.run {
        var ids: [String] = []
        for file in files { ids.append(try await store.uploadTaskFile(file).id) }
        let task = try await store.createTask(["to": AnyEncodable(to), "title": AnyEncodable(title.trimmed), "brief": AnyEncodable(brief.trimmed.isEmpty ? title.trimmed : brief.trimmed), "fileIds": AnyEncodable(ids)])
        if let channel = task.channelId { store.route = .chat(channelId: channel, threadId: task.threadId) }
        dismiss()
      }
    }) {
      if store.agents.isEmpty { Text("Add an agent to hand work to") }
      Section {
        TextField("What needs doing?", text: $title)
        TextField("Details (optional)", text: $brief, axis: .vertical).lineLimit(4...12)
      } footer: { Text("Links, what done looks like, anything it shouldn't do.") }
      Picker("Who takes it?", selection: $to) {
        Text("Let \(store.agent(store.taskLead ?? "")?.name ?? "the lead") plan it").tag("auto")
        ForEach(store.agents) { Text($0.name).tag($0.id) }
        ForEach(store.teams.filter { $0.leadId != nil }) { Text("Team \($0.name)").tag("team:\($0.name)") }
      }
      if let agent = store.agent(to), agent.status == .offline { Text("\(agent.name) is offline; it starts when its device connects.").font(.footnote) }
      Section {
        Button("Attach files", systemImage: "paperclip") { importing = true }
        ForEach(files, id: \.self) { file in
          HStack { Text(file.lastPathComponent); Spacer(); Button("Remove \(file.lastPathComponent)", systemImage: "xmark") { files.removeAll { $0 == file } }.labelStyle(.iconOnly) }
        }
      }
    }
    .accessibilityIdentifier("screen-new-task")
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      do { files += try result.get() } catch { action.error = error.localizedDescription }
    }
    .task { do { try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
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
