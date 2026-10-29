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
  /** the menu's section: "learned", "harness", "wisp" or "skill"; older hubs don't send it */
  var group: String?
  /** learned in the last 7 days: the row shows "new" */
  var isNew: Bool?
  /** for "learned": who learned it ("Ghosty") */
  var learnedBy: String?
  var id: String { name }

  /** the section it goes in, worked out from its kind on hubs that don't say */
  var section: String {
    if let group, ["learned", "harness", "wisp", "skill"].contains(group) { return group }
    switch kind {
    case "wisp": return "wisp"
    case "wisp-skill": return "skill"
    default: return "harness"
    }
  }

  var kindLabel: String {
    switch kind {
    case "wisp": "Wisp"
    case "command": "Command"
    default: "Skill"
    }
  }
}

/** One headed section of the menu: "Learned by Ghosty", "Codex", "Wisp", "Skills". */
struct SlashSection: Identifiable {
  var title: String
  var rows: [SlashRow]
  var id: String { title }
}

struct SlashRow {
  var agent: Agent
  var command: AgentCommand
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

  /** the order sections come in: what agents learned, the harness's own, Wisp's, then other skills */
  static let sectionOrder = ["learned", "harness", "wisp", "skill"]

  static func harnessLabel(_ harness: String) -> String {
    HarnessChoice.all.first { $0.id == harness }?.label ?? harness.replacingOccurrences(of: "-", with: " ").capitalized
  }

  /**
   * The rows under their headers, in menu order; within a section rows keep the order they came in (prefix
   * matches first). Learned skills are headed by who learned them, harness entries by the agent's harness.
   */
  static func sections(_ rows: [SlashRow]) -> [SlashSection] {
    var order: [(rank: Int, title: String)] = []
    var byTitle: [String: [SlashRow]] = [:]
    for row in rows {
      let section = row.command.section
      let title: String
      switch section {
      case "learned": title = "Learned by \(row.command.learnedBy ?? row.agent.name)"
      case "harness": title = harnessLabel(row.agent.harness)
      case "wisp": title = "Wisp"
      default: title = "Skills"
      }
      if byTitle[title] == nil { order.append((sectionOrder.firstIndex(of: section) ?? 9, title)) }
      byTitle[title, default: []].append(row)
    }
    let sorted = order.enumerated().sorted { a, b in a.element.rank != b.element.rank ? a.element.rank < b.element.rank : a.offset < b.offset }
    return sorted.map { SlashSection(title: $0.element.title, rows: byTitle[$0.element.title] ?? []) }
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

  /** A skill was learned, changed or forgotten: "/" lists are fetched again. */
  static func forget() { cache = [:] }

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
  private var rows: [SlashRow] {
    let all = groups.flatMap { g in g.items.map { SlashRow(agent: g.agent, command: $0) } }
    guard only == nil, here.count > 1 else { return all }
    var seen = Set<String>()
    return all.filter { seen.insert($0.command.name).inserted }
  }

  var body: some View {
    VStack(spacing: 0) {
      if here.count > 1 { agentRow }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if groups.isEmpty && loading { Text("Loading…").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(12) }
          ForEach(SlashMenu.sections(rows)) { section in
            Text(section.title.uppercased())
              .font(.system(size: 12, weight: .medium)).tracking(0.5).foregroundStyle(Palette.faint)
              .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 4)
              .accessibilityAddTraits(.isHeader)
            ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in rowView(row) }
          }
        }
        .padding(.vertical, 4)
      }
      .frame(maxHeight: 300)
    }
    .glass(Corner.card)
    .accessibilityIdentifier("slash-menu")
  }

  private func rowView(_ row: SlashRow) -> some View {
    Button { onPick(row.command, row.agent) } label: {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        (Text("/\(row.command.name)").fontWeight(.medium) + Text(row.command.hint.map { " \($0)" } ?? "").foregroundStyle(Palette.muted))
          .font(.system(size: 14)).lineLimit(1).layoutPriority(1)
        Text(row.command.description ?? "").font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        if row.command.isNew == true {
          Text("new").font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.muted)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Palette.hairline))
        }
      }
      .padding(.horizontal, 16).frame(minHeight: 40)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("/\(row.command.name)\(row.command.description.map { ", \($0)" } ?? "")\(row.command.isNew == true ? ", new" : "")")
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
