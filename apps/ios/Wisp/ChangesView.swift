import SwiftUI

/** "Ask an agent to change anything": a message to one of your agents, sent in your chat with it. */
struct AskAgentSection: View {
  @Environment(Store.self) private var store
  var placeholder = "Ask {name} to change anything"
  /** put before the typed words, e.g. which harness the question is about */
  var prefix = ""
  /** only these agents can be asked (all of them when nil) */
  var agents: [Agent]?
  @State private var agentId: String?
  @State private var text = ""
  @State private var action = FormAction()
  private var candidates: [Agent] { agents ?? store.agents }
  private var agent: Agent? { candidates.first { $0.id == agentId } ?? candidates.first { $0.status != .offline } ?? candidates.first }

  var body: some View {
    if let agent {
      Section {
        HStack(spacing: 10) {
          if candidates.count > 1 {
            Menu {
              ForEach(candidates) { other in Button(other.name) { agentId = other.id } }
            } label: { AgentAvatar(agent: agent, size: 30, showStatus: false) }.accessibilityLabel("Which agent: \(agent.name)")
          } else {
            AgentAvatar(agent: agent, size: 30, showStatus: false)
          }
          TextField(placeholder.replacingOccurrences(of: "{name}", with: agent.name), text: $text, axis: .vertical)
            .lineLimit(1...4).submitLabel(.send).onSubmit(send).accessibilityIdentifier("ask-agent-field")
          Button("Send", systemImage: "arrow.up.circle.fill", action: send)
            .labelStyle(.iconOnly).font(.title2).disabled(action.busy || text.trimmed.isEmpty)
        }
        InlineError(error: action.error)
      } footer: { Text("Agents change settings and mods when you ask. What they change shows up below, with Undo.") }
    }
  }

  private func send() {
    guard let agent, !text.trimmed.isEmpty else { return }
    let message = prefix + text.trimmed
    action.run { try await store.ask(agent, message); text = "" }
  }
}

/** What agents changed lately, newest first, with Undo. */
struct RecentChangesSection: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var limit = 5
  private var recent: [Change] { Array((store.changes ?? []).prefix(limit)) }

  var body: some View {
    Group {
      if !recent.isEmpty {
        Section("Recently changed") {
          ForEach(recent) { change in
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 3) {
                let who = store.agent(change.agentId)?.name
                Text((who.map { "\($0): " } ?? "") + change.lines.joined(separator: ", "))
                  .strikethrough(change.undoneAt != nil).foregroundStyle(change.undoneAt != nil ? .secondary : .primary)
                if let date = Wire.date(change.createdAt) { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) }
              }
              Spacer(minLength: 8)
              if change.undoneAt == nil {
                Button("Undo") { action.run { try await store.undoChange(change.id) } }
                  .buttonStyle(.bordered).controlSize(.small).disabled(action.busy).accessibilityIdentifier("undo-change")
              }
            }
          }
          InlineError(error: action.error)
        }
      }
    }.task { try? await store.refreshChanges() }
  }
}
