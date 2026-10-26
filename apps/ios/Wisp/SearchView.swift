import SwiftUI

/** Where a search result goes when you tap it. */
enum SearchTarget {
  case channel(Channel)
  case agent(Agent)
  case message(SearchMessage)
  case note(String)
}

/**
 * What the hub found for the Chats search box (GET /api/search), shown under the local matches:
 * channels (including ones you haven't joined), agents, messages and memory notes.
 */
struct SearchResultsSections: View {
  @Environment(Store.self) private var store
  var results: SearchResults
  var query: String
  /** channels and agents the chat list already shows for this search */
  var shownChannels: Set<String>
  var shownAgents: Set<String>
  var open: (SearchTarget) -> Void

  private var channels: [Channel] { results.channels.filter { !shownChannels.contains($0.id) } }
  private var agents: [Agent] { results.agents.filter { !shownAgents.contains($0.id) } }

  private var people: [String: String] { Dictionary(store.members.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a }) }
  private var handles: [String: String] { Dictionary(store.agents.map { ($0.id, $0.handle) }, uniquingKeysWith: { a, _ in a }) }
  private var teamNames: [String: String] {
    var out: [String: String] = [:]
    for t in store.teams { if let f = t.folder, f.hasPrefix("teams/") { out[String(f.dropFirst(6))] = t.name } }
    return out
  }

  var body: some View {
    if !channels.isEmpty {
      Section("Matching teams") {
        ForEach(channels) { c in
          Button { open(.channel(c)) } label: {
            resultRow(symbol: c.private == true ? "lock" : "number", title: c.name, kind: "Team",
                      sub: [SearchText.clean(c.topic), c.joined == true ? "" : "Not joined yet"].filter { !$0.isEmpty }.joined(separator: " · "))
          }
        }
      }
    }
    if !agents.isEmpty {
      Section("Matching agents") {
        ForEach(agents) { a in
          Button { open(.agent(a)) } label: {
            HStack(spacing: 12) {
              AgentAvatar(agent: a, size: 32, showStatus: false)
              VStack(alignment: .leading, spacing: 2) {
                titleLine("\(a.name) @\(a.handle)", kind: "Agent")
                Text("Send a direct message").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
    if !results.messages.isEmpty {
      Section("Messages") {
        ForEach(results.messages) { m in
          let kind = SearchText.kind(of: m.message)
          Button { open(.message(m)) } label: {
            resultRow(symbol: "text.bubble", title: SearchText.clean(m.message.body, max: 100).nonEmpty ?? "Untitled \(kind.lowercased())", kind: kind,
                      sub: SearchText.location(channelName: m.channelName, agentHandles: handles))
          }
        }
      }
    }
    if !results.notes.isEmpty {
      Section("Memory") {
        ForEach(results.notes) { n in
          let title = SearchText.clean(n.title ?? "", max: 80).nonEmpty ?? SearchText.humanize((n.path as NSString).lastPathComponent).nonEmpty ?? "Untitled note"
          Button { open(.note(n.path)) } label: {
            resultRow(symbol: "doc.text", title: title, kind: "Note",
                      sub: [SearchText.clean(n.snippet ?? ""), SearchText.noteLocation(path: n.path, title: n.title ?? "", people: people, agents: handles, teams: teamNames)]
                        .filter { !$0.isEmpty }.joined(separator: " · "))
          }
        }
      }
    }
  }

  private func titleLine(_ title: String, kind: String) -> some View {
    HStack(spacing: 6) {
      Text(title).font(.body).foregroundStyle(.primary).lineLimit(1)
      Text(kind).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
        .padding(.horizontal, 6).padding(.vertical, 1)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
    }
  }

  private func resultRow(symbol: String, title: String, kind: String, sub: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 32)
      VStack(alignment: .leading, spacing: 2) {
        titleLine(title, kind: kind)
        if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
