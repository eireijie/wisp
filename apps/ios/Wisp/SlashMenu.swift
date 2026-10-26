import Observation
import SwiftUI

/** One entry in the "/" menu (AgentCommand in packages/core/src/commands.ts). */
struct AgentCommand: Decodable, Hashable, Identifiable {
  var name: String
  var description: String?
  var hint: String?
  /** "wisp": answered by Wisp; "command"/"skill": the harness's own; "wisp-skill": a skill installed through Wisp */
  var kind: String
  /** "wisp", "raw" or "prompt" */
  var via: String
  var id: String { name }

  var kindLabel: String {
    switch kind {
    case "wisp": "Wisp"
    case "command": "Command"
    default: "Skill"
    }
  }
}

struct SlashGroup: Identifiable {
  var agent: Agent
  var items: [AgentCommand]
  var id: String { agent.id }
}

enum SlashQuery {
  struct Parsed: Equatable {
    var handle: String?
    var query: String
  }

  /** "/que" (or "@poopy /que") from the start of the message up to the caret, or nil when the menu shouldn't show. */
  static func parse(_ beforeCaret: String) -> Parsed? {
    guard let regex = try? NSRegularExpression(pattern: #"^\s*(?:@([\w-]+)\s+)?/([\w:.-]*)\z"#) else { return nil }
    let ns = beforeCaret as NSString
    guard let m = regex.firstMatch(in: beforeCaret, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let handle = m.range(at: 1).location == NSNotFound ? nil : ns.substring(with: m.range(at: 1)).lowercased()
    return Parsed(handle: handle, query: ns.substring(with: m.range(at: 2)).lowercased())
  }
}

enum SlashMenu {
  /** Whose commands to list: the DM's agent, the one named, else the channel's agents (everyone's if it has none). */
  static func agentsHere(isDm: Bool, dmAgent: Agent?, agents: [Agent], members: [String]?, handle: String?) -> [Agent] {
    if isDm { return dmAgent.map { [$0] } ?? [] }
    if let handle {
      let named = agents.filter { $0.handle == handle }
      if !named.isEmpty { return named }
    }
    let inChannel = members.map { ids in agents.filter { ids.contains($0.id) } } ?? []
    return inChannel.isEmpty ? agents : inChannel
  }

  /** Each agent's commands that match, the ones that start with the query first. */
  static func groups(here: [Agent], lists: [String: [AgentCommand]], only: String?, query: String) -> [SlashGroup] {
    here.filter { only == nil || $0.id == only }.compactMap { agent in
      let matching = (lists[agent.id] ?? []).enumerated().filter { query.isEmpty || $0.element.name.lowercased().contains(query) }
      let sorted = matching.sorted { a, b in
        let pa = a.element.name.lowercased().hasPrefix(query), pb = b.element.name.lowercased().hasPrefix(query)
        return pa != pb ? pa : a.offset < b.offset
      }.map(\.element)
      return sorted.isEmpty ? nil : SlashGroup(agent: agent, items: sorted)
    }
  }

  /** What the message says after picking: "/name " in a chat, "@handle /name " in a channel so it goes to that agent. */
  static func text(for command: AgentCommand, agent: Agent, isDm: Bool) -> String {
    "\(isDm ? "" : "@\(agent.handle) ")/\(command.name) "
  }

  /** The message with its leading "/…" (up to the caret) swapped for the pick; what came after the caret stays. */
  static func replacing(_ text: String, caret: Int, with pick: String) -> (text: String, caret: Int) {
    let end = text.index(text.startIndex, offsetBy: min(max(caret, 0), text.count))
    return (pick + text[end...], pick.count)
  }
}

/** Commands each agent offers, fetched once a minute at most and shared by every message bar. */
@MainActor @Observable
final class SlashMenuModel {
  var lists: [String: [AgentCommand]] = [:]
  /** the agents in this channel, once known */
  var members: [String]?
  var only: String?

  private struct Hit { var at: Date; var list: [AgentCommand] }
  private static var cache: [String: Hit] = [:]
  private var asked: Set<String> = []

  func loadMembers(_ store: Store, channelId: String) async {
    guard members == nil else { return }
    do {
      let list: [ChannelMember] = try await store.fetch { try await $0.get("/api/channels/\(channelId)/members") }
      members = list.filter { $0.kind == .agent }.map(\.id)
    } catch { members = [] }
  }

  func load(_ store: Store, agents: [Agent]) async {
    for agent in agents where lists[agent.id] == nil && !asked.contains(agent.id) {
      if let hit = Self.cache[agent.id], Date().timeIntervalSince(hit.at) < 60 { lists[agent.id] = hit.list; continue }
      asked.insert(agent.id)
      struct Result: Decodable { var commands: [AgentCommand] }
      let r: Result? = try? await store.fetch { try await $0.get("/api/agents/\(agent.id)/commands") }
      let list = r?.commands ?? []
      Self.cache[agent.id] = Hit(at: Date(), list: list)
      lists[agent.id] = list
      asked.remove(agent.id)
    }
  }

  /** The commands of one agent, for showing a button only when it can do that ("compact"). */
  static func commands(_ store: Store, agentId: String) async -> [AgentCommand] {
    if let hit = cache[agentId], Date().timeIntervalSince(hit.at) < 60 { return hit.list }
    struct Result: Decodable { var commands: [AgentCommand] }
    let r: Result? = try? await store.fetch { try await $0.get("/api/agents/\(agentId)/commands") }
    cache[agentId] = Hit(at: Date(), list: r?.commands ?? [])
    return r?.commands ?? []
  }
}

/** The "/" menu above the message bar: each agent's commands grouped under it, with a row to pick just one agent. */
struct SlashMenuView: View {
  var here: [Agent]
  var groups: [SlashGroup]
  var loading: Bool
  @Binding var only: String?
  var onPick: (AgentCommand, Agent) -> Void

  var body: some View {
    VStack(spacing: 0) {
      if here.count > 1 { agentRow }
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if groups.isEmpty && loading { Text("Loading…").font(.subheadline).foregroundStyle(.secondary).padding(12) }
          ForEach(groups) { g in
            Text("\(g.agent.name) · \(Self.harnessName(g.agent.harness))")
              .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
              .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
            ForEach(g.items) { c in
              Button { onPick(c, g.agent) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                  VStack(alignment: .leading, spacing: 1) {
                    (Text("/\(c.name)").fontWeight(.medium) + Text(c.hint.map { " \($0)" } ?? "").foregroundStyle(.secondary))
                      .font(.subheadline).lineLimit(1)
                    if let d = c.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                  }
                  Spacer(minLength: 0)
                  Text(c.kindLabel).font(.caption2).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("/\(c.name), \(g.agent.name)")
            }
          }
        }
      }
      .frame(maxHeight: 240)
    }
    .glass(18)
    .accessibilityIdentifier("slash-menu")
  }

  static func harnessName(_ harness: String) -> String {
    harness.replacingOccurrences(of: "-", with: " ").capitalized
  }

  private var agentRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        Button { only = nil } label: {
          Text("All").font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 6)
            .background(Capsule().fill(only == nil ? Color(.tertiarySystemFill) : .clear))
        }.buttonStyle(.plain)
        ForEach(here) { a in
          Button { only = only == a.id ? nil : a.id } label: {
            HStack(spacing: 4) {
              AgentAvatar(agent: a, size: 20, showStatus: false)
              Text(a.name).font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(only == a.id ? Color(.tertiarySystemFill) : .clear))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Only \(a.name)")
          .accessibilityAddTraits(only == a.id ? .isSelected : [])
        }
      }
      .padding(.horizontal, 8).padding(.vertical, 6)
    }
  }
}
