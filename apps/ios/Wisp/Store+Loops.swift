import Foundation

extension Store {
  /** Moves a reminder to a new time. */
  func rescheduleFollowup(_ target: ReminderTarget, to date: Date) async throws {
    struct Body: Encodable { var dueAt: String }
    let saved: Followup = try await fetch { try await $0.patch("/api/followups/\(target.followupId)", Body(dueAt: Loops.iso(date))) }
    updatePills(target.followupId) { $0.dueAt = saved.dueAt }
    await followupChanged(target)
  }

  /** "Already done" (done) or "Don't remind me" (cancelled). */
  func finishFollowup(_ target: ReminderTarget, status: String) async throws {
    struct Body: Encodable { var status: String }
    let _: Followup = try await fetch { try await $0.patch("/api/followups/\(target.followupId)", Body(status: status)) }
    updatePills(target.followupId) { $0.status = status }
    await followupChanged(target)
  }

  /** Whether an agent checks back when a chat with you goes quiet. */
  func setCheckback(_ agentId: String, enabled: Bool) async throws {
    struct Body: Encodable { var enabled: Bool }
    try await fetch { try await $0.put("/api/agents/\(agentId)/checkback", Body(enabled: enabled)) }
    backgrounds[agentId]?.checkback = enabled
    try await refreshBackground(agentId)
  }

  /** A typed answer from a check-back's notification: posted once the app is signed in. */
  func replyFromNotification(_ text: String, channelId: String) async {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return }
    // launched in the background by the action: the session loads first
    var waited = 0
    while api == nil || phase == .loading, waited < 50 { try? await Task.sleep(for: .milliseconds(200)); waited += 1 }
    do { try await send(body, in: channelId) } catch { recordSyncError(error) }
  }

  /** The hub sends the updated message too; this shows the change right away. */
  func updatePills(_ followupId: String, _ change: (inout FollowupPill) -> Void) {
    func apply(_ list: inout [Message]) {
      for i in list.indices {
        for j in list[i].parts.indices {
          if case .followup(var pill) = list[i].parts[j], pill.followupId == followupId {
            change(&pill)
            list[i].parts[j] = .followup(pill)
          }
        }
      }
    }
    for key in messages.keys { apply(&messages[key]!) }
    for key in threads.keys { apply(&threads[key]!) }
  }

  private func followupChanged(_ target: ReminderTarget) async {
    if let agentId = target.agentId, backgrounds[agentId] != nil { try? await refreshBackground(agentId) }
    await refreshChannels()
  }
}
