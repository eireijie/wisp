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

/** The "/" menu above the message bar: chips to pick one agent, then each command with what it does. */
struct SlashMenuView: View {
  var here: [Agent]
  var groups: [SlashGroup]
  var loading: Bool
  @Binding var only: String?
  var onPick: (AgentCommand, Agent) -> Void

  /** with everyone's commands showing, one every agent has (/context, /model) is listed once */
  private var rows: [(agent: Agent, command: AgentCommand)] {
    let all = groups.flatMap { g in g.items.map { (agent: g.agent, command: $0) } }
    guard only == nil, here.count > 1 else { return all }
    var seen = Set<String>()
    return all.filter { seen.insert($0.command.name).inserted }
  }

  var body: some View {
    VStack(spacing: 0) {
      if here.count > 1 { agentRow }
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if groups.isEmpty && loading { Text("Loading…").font(.subheadline).foregroundStyle(Palette.muted).padding(12) }
          ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            Button { onPick(row.command, row.agent) } label: {
              HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                  (Text("/\(row.command.name)").fontWeight(.semibold) + Text(row.command.hint.map { " \($0)" } ?? "").foregroundStyle(Palette.muted))
                    .font(.system(size: 16)).lineLimit(1)
                  if let d = row.command.description, !d.isEmpty { Text(d).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if only == nil && here.count > 1 && !(rows.count < groups.flatMap(\.items).count) { Text(row.agent.name).font(.caption2).foregroundStyle(Palette.faint) }
              }
              .padding(.horizontal, 16).padding(.vertical, 8)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("/\(row.command.name), \(row.agent.name)")
          }
        }
        .padding(.vertical, 4)
      }
      .frame(maxHeight: 260)
    }
    .glass(Corner.card)
    .accessibilityIdentifier("slash-menu")
  }

  static func harnessName(_ harness: String) -> String {
    harness.replacingOccurrences(of: "-", with: " ").capitalized
  }

  private func chip(_ title: String, _ on: Bool, _ tap: @escaping () -> Void) -> some View {
    Button(action: tap) {
      Text(title).font(.system(size: 13, weight: .medium))
        .foregroundStyle(on ? Palette.ground : Palette.muted)
        .padding(.horizontal, 14).frame(height: 32)
        .background(Capsule().fill(on ? Palette.text : Palette.control))
        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: on ? 0 : 1))
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? .isSelected : [])
  }

  private var agentRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        chip("All agents", only == nil) { only = nil }
        ForEach(here) { a in chip(a.name, only == a.id) { only = only == a.id ? nil : a.id } }
      }
      .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 4)
    }
  }
}
