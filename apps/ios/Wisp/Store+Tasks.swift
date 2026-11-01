import Foundation
import UserNotifications

extension Store {
  func refreshTasks() async throws {
    let previous = tasks
    tasks = try await fetch { try await $0.get("/api/tasks") }
    for task in tasks where task.closed && !task.cancelled && task.from == Actor(kind: .user, id: me?.id ?? "") {
      guard previous.contains(where: { $0.id == task.id && !$0.closed }) else { continue }
      let content = UNMutableNotificationContent()
      content.title = task.title
      content.body = task.result ?? (task.status == "done" ? "Task is done." : "Task couldn't be done.")
      content.userInfo = ["wisp": task.notificationInfo]
      try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "task-" + task.id, content: content, trigger: nil))
    }
  }
  func refreshTaskLead() async throws {
    let lead: WorkspaceLead = try await fetch { try await $0.get("/api/settings/lead") }
    taskLead = lead.lead
    taskLeadOverride = lead.leadId
  }
  @discardableResult
  func createTask(_ fields: Fields) async throws -> WorkTask {
    let task: WorkTask = try await fetch { try await $0.post("/api/tasks", fields) }
    upsertTask(task)
    await refreshChannels()
    return task
  }
  func retryTask(_ id: String) async throws {
    let task: WorkTask = try await fetch { try await $0.post("/api/tasks/\(id)/retry", Empty()) }
    upsertTask(task)
  }
  func retryRun(_ id: String) async throws {
    struct Started: Decodable { var runId: String }
    let _: Started = try await fetch { try await $0.post("/api/runs/\(id)/retry", Empty()) }
  }
  func updateTask(_ id: String, status: String, result: String) async throws {
    let task: WorkTask = try await fetch { try await $0.patch("/api/tasks/\(id)", ["status": status, "result": result]) }
    upsertTask(task)
  }
  func cancelTask(_ id: String) async throws {
    let task: WorkTask = try await fetch { try await $0.post("/api/tasks/\(id)/cancel", Empty()) }
    upsertTask(task)
  }
  func mergeTask(_ id: String) async throws -> String {
    let result: TaskMerge = try await fetch { try await $0.post("/api/tasks/\(id)/merge", Empty()) }
    if let task = result.task { upsertTask(task) }
    return result.output ?? "Merged."
  }
  private func upsertTask(_ task: WorkTask) {
    if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = task } else { tasks.insert(task, at: 0) }
  }
  func taskWaiting(_ task: WorkTask) -> String? {
    guard !task.closed else { return nil }
    let matches: (String, String?) -> Bool = { channel, thread in
      channel == task.channelId && (thread == task.threadId || (task.threadId != nil && thread == nil))
    }
    if let approval = pendingApprovals.first(where: { $0.agentId == task.toAgentId && matches($0.channelId, $0.threadId) }) {
      return "Wants your OK: \(approval.summary)"
    }
    if let computer = computers.first(where: { c in
      guard let help = c.help else { return false }
      return help.agentId == task.toAgentId && matches(help.channelId, help.threadId)
    }) { return "Needs you on \(computer.name): \(computer.help?.request ?? "")" }
    return nil
  }
  func taskState(_ task: WorkTask) -> String {
    if task.cancelled { return "Cancelled" }
    if task.status == "done" { return "Done" }
    if task.status == "failed" { return task.result?.hasPrefix("Cancelled") == true ? "Cancelled" : "Failed" }
    if taskWaiting(task) != nil { return "Needs you" }
    if let agent = agent(task.toAgentId ?? ""), HarnessChoice.all.first(where: { $0.id == agent.harness })?.protocolName != "mcp" {
      let node = nodes.first { $0.id == agent.nodeId }
      if agent.nodeId == nil || node?.online != true || node?.paused == true { return node.map { "Waiting for \($0.name)" } ?? "Waiting for a device" }
    }
    return task.status == "in_progress" || agent(task.toAgentId ?? "")?.status == .busy ? "Working" : "To do"
  }
}
