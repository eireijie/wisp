import SwiftUI

/** "Ask {agent} to change anything": a message to one of your agents, in a settings card (the design's Workspace and Mods pages). */
struct AskAgentCard: View {
  @Environment(Store.self) private var store
  var placeholder = "Ask {name} to change anything"
  @State private var agentId: String?
  @State private var text = ""
  @State private var action = FormAction()
  private var agent: Agent? { store.agents.first { $0.id == agentId } ?? store.agents.first { $0.status != .offline } ?? store.agents.first }

  var body: some View {
    if let agent {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
          if store.agents.count > 1 {
            Menu { ForEach(store.agents) { other in Button(other.name) { agentId = other.id } } } label: { AgentAvatar(agent: agent, size: 30, showStatus: false) }
              .accessibilityLabel("Which agent: \(agent.name)")
          } else {
            AgentAvatar(agent: agent, size: 30, showStatus: false)
          }
          TextField("", text: $text, prompt: Text(placeholder.replacingOccurrences(of: "{name}", with: agent.name)).foregroundStyle(Palette.faint), axis: .vertical)
            .lineLimit(1...4).submitLabel(.send).onSubmit(send).foregroundStyle(Palette.text).font(.system(size: 17))
            .accessibilityIdentifier("ask-agent-field")
          Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).foregroundStyle(text.trimmed.isEmpty ? Palette.faint : Palette.blue) }
            .buttonStyle(.plain).disabled(action.busy || text.trimmed.isEmpty).accessibilityLabel("Send")
        }
        .padding(.horizontal, 18).frame(minHeight: 56)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
        StatusLine(error: action.error)
      }
    }
  }

  private func send() {
    guard let agent, !text.trimmed.isEmpty else { return }
    let message = text.trimmed
    action.run { try await store.ask(agent, message); text = "" }
  }
}

/** What agents changed lately, newest first, with Undo. */
struct RecentChangesCard: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var limit = 5
  private var recent: [Change] { Array((store.changes ?? []).prefix(limit)) }

  var body: some View {
    Group {
      if !recent.isEmpty {
        CardLabel("Recently changed")
        CardGroup {
          ForEach(recent) { change in
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 3) {
                let who = store.agent(change.agentId)?.name
                Text((who.map { "\($0): " } ?? "") + change.lines.joined(separator: ", "))
                  .font(.system(size: 16)).strikethrough(change.undoneAt != nil).foregroundStyle(change.undoneAt != nil ? Palette.faint : Palette.text)
                if let date = Wire.date(change.createdAt) { Text(date, style: .relative).font(.system(size: 14)).foregroundStyle(Palette.faint) }
              }
              Spacer(minLength: 8)
              if change.undoneAt == nil {
                Button("Undo") { action.run { try await store.undoChange(change.id) } }
                  .buttonStyle(.pill(.secondary, small: true)).disabled(action.busy).accessibilityIdentifier("undo-change")
              }
            }.padding(.horizontal, 18).padding(.vertical, 12)
          }
        }
        StatusLine(error: action.error)
      }
    }.task { try? await store.refreshChanges() }
  }
}
