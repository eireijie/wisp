import SwiftUI

/** A skill or app a harness on a device already has (ShelfItem in packages/core/src/shop.ts). */
struct ShelfItem: Decodable, Identifiable, Hashable {
  var key: String
  var harness: String
  var kind: String
  var name: String
  var description: String?
  var path: String?
  var transport: String?
  var command: String?
  var args: [String]?
  var url: String?
  var env: [String: String]?
  var secrets: [String]?
  var headers: [String]?
  var id: String { key }
  var isSkill: Bool { kind == "skill" }
  /** the name the device knows the skill by */
  var skillId: String { key.components(separatedBy: ":skill:").dropFirst().first ?? name }
  /** nothing secret was left on the device, so it can come in as it is */
  var readyAsIs: Bool { kind == "mcp" && (secrets ?? []).isEmpty && !(headers ?? []).contains { $0.lowercased() != "authorization" } }
}

/** What one device's harnesses have (DeviceShelf in the core package). */
struct DeviceShelf: Decodable, Identifiable, Hashable {
  var nodeId: String
  var nodeName: String
  var online: Bool
  var items: [ShelfItem]
  var id: String { nodeId }
}

struct PendingShelfItem: Identifiable {
  var device: DeviceShelf
  var item: ShelfItem
  var id: String { device.nodeId + "|" + item.key }
}

enum ShelfLogic {
  static func harnessName(_ id: String) -> String { HarnessChoice.all.first { $0.id == id }?.label ?? id }

  /** How a device skill is known to Wisp once it's brought in. */
  static func skillId(_ nodeId: String, _ item: ShelfItem) -> String { "device:\(nodeId):\(item.harness):\(item.skillId)" }
  static func appId(_ nodeId: String, _ item: ShelfItem) -> String { "device:\(nodeId):\(item.harness):\(item.name)" }

  static func inWisp(_ nodeId: String, _ item: ShelfItem, skills: [HelperSkill], connectors: [AppConnector]) -> Bool {
    if item.isSkill { return skills.contains { $0.catalogId == skillId(nodeId, item) || $0.slug == MarketText.slug(item.name) } }
    return connectors.contains { $0.name.lowercased() == item.name.lowercased() }
  }

  static func pending(_ shelves: [DeviceShelf], skills: [HelperSkill], connectors: [AppConnector]) -> [PendingShelfItem] {
    shelves.flatMap { d in d.items.filter { !inWisp(d.nodeId, $0, skills: skills, connectors: connectors) }.map { PendingShelfItem(device: d, item: $0) } }
  }

  /** "14 skills and 3 apps" */
  static func summary(_ items: [ShelfItem]) -> String {
    let skills = items.filter(\.isSkill).count
    let apps = items.count - skills
    func n(_ k: Int, _ one: String, _ many: String) -> String { "\(k) \(k == 1 ? one : many)" }
    if skills > 0 && apps > 0 { return "\(n(skills, "skill", "skills")) and \(n(apps, "app", "apps"))" }
    return skills > 0 ? n(skills, "skill", "skills") : n(apps, "app", "apps")
  }

  static func sentence(_ names: [String]) -> String {
    names.count <= 1 ? (names.first ?? "") : names.dropLast().joined(separator: ", ") + " and " + names.last!
  }

  /** An app a harness has, as something the connector form can fill in: its keys asked for, or a sign-in. */
  static func connector(_ nodeId: String, _ item: ShelfItem) -> AppConnector {
    func envName(_ s: String) -> String { s.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "_" }.map(String.init).joined().uppercased() }
    // an Authorization header is a login: Wisp signs in itself instead
    let headers = (item.headers ?? []).filter { $0.lowercased() != "authorization" }
    let fields = ((item.secrets ?? []) + headers).map { ConnectorField(key: envName($0), label: $0, secret: true, hint: "Kept on the device; enter it here once.") }
    return AppConnector(
      id: appId(nodeId, item), name: item.name, kind: item.transport == "http" ? "mcp-http" : "mcp-stdio",
      description: "From \(harnessName(item.harness)).", command: item.command, args: item.args, url: item.url,
      headers: Dictionary(uniqueKeysWithValues: headers.map { ($0, "{{\(envName($0))}}") }), fields: fields)
  }

  static func summary(_ item: ShelfItem) -> ConnectSummary {
    let who = "agents"
    let host = item.url.flatMap { URL(string: $0)?.host }
    return ConnectSummary(
      can: "Your \(who) will be able to use \(item.name): read and act on what it allows.",
      runBy: item.transport == "http" ? "It connects to \(host ?? "its own address"), as it did in \(harnessName(item.harness))." : "It runs on each agent's own device, as it did in \(harnessName(item.harness)).",
      caution: nil)
  }
}

/** Which helpers can use a connected app (the same rule the connector form uses). */
enum ConnectorSupport {
  static func allows(_ agent: Agent, kind: String) -> Bool {
    let proto = HarnessChoice.all.first { $0.id == agent.harness }?.protocolName ?? (agent.harness.hasPrefix("acp:") ? "acp" : "mcp")
    return proto == "native" || proto == "acp" && kind != "mcp-http"
  }
}


/** "Found on Mac mini: 5 skills your harnesses already use." */
struct DeviceBanner: View {
  var pending: [PendingShelfItem]
  var onOpen: () -> Void
  var body: some View {
    let devices = Array(NSOrderedSet(array: pending.map(\.device.nodeName))) as? [String] ?? []
    CardGroup {
      Button(action: onOpen) {
        MarketRow(symbol: "laptopcomputer", tile: 50, title: "Found on \(ShelfLogic.sentence(devices))", subtitle: "\(ShelfLogic.summary(pending.map(\.item))) your harnesses already \(pending.count == 1 ? "uses" : "use")") {
          Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
        }
      }.buttonStyle(.plain)
    }
  }
}

/** The "On your devices" tab: each device's harnesses and what they have. */
struct DeviceShelfList: View {
  @Environment(Store.self) private var store
  var shelves: [DeviceShelf]
  var query: String
  var onBring: (DeviceShelf, ShelfItem) -> Void
  var onBringAll: () -> Void
  var onRefresh: (DeviceShelf) -> Void
  private func shown(_ d: DeviceShelf) -> [ShelfItem] {
    d.items.filter { query.isEmpty || ($0.name + " " + ($0.description ?? "")).localizedCaseInsensitiveContains(query) }
      .sorted { ($0.harness, $0.kind, $0.name) < ($1.harness, $1.kind, $1.name) }
  }
  var body: some View {
    let pending = ShelfLogic.pending(shelves, skills: store.skills, connectors: store.connectors)
    if shelves.isEmpty {
      MarketNote(text: "Nothing found yet. Skills and apps from Claude Code, Codex and Hermes on your devices show up here.")
    }
    if !pending.isEmpty { DeviceBanner(pending: pending, onOpen: { if store.canManage { onBringAll() } }) }
    ForEach(shelves) { d in
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          MarketLabel(d.nodeName)
          if !d.online { MarketPill(text: "Offline") }
          if d.online { Button { onRefresh(d) } label: { Label("Look again", systemImage: "arrow.clockwise").font(.system(size: 13)).foregroundStyle(Palette.muted) }.buttonStyle(.plain) }
        }
        if d.items.isEmpty {
          Text("\(d.nodeName): Nothing found in its harnesses.").font(.system(size: 14)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
        } else {
          CardGroup { ForEach(shown(d)) { item in ShelfRow(device: d, item: item, onBring: { onBring(d, item) }) } }
        }
      }
    }
    if store.canManage && !pending.isEmpty { MarketPrimaryButton(title: "Bring them in", action: onBringAll) }
  }
}

struct ShelfRow: View {
  @Environment(Store.self) private var store
  var device: DeviceShelf
  var item: ShelfItem
  var onBring: () -> Void
  var body: some View {
    let have = ShelfLogic.inWisp(device.nodeId, item, skills: store.skills, connectors: store.connectors)
    MarketRow(symbol: item.isSkill ? MarketText.skillSymbol(item.name) : "powerplug", title: item.isSkill ? MarketText.skillTitle(item.name) : item.name, subtitle: ShelfLogic.harnessName(item.harness) + (item.isSkill ? "" : item.readyAsIs ? " · app" : " · app, needs a key")) {
      if have { MarketPill(text: "In Wisp", tone: .green) }
      else if store.canManage { AddButton(title: "Bring in", action: onBring) }
    }
  }
}

/** Give a skill to helpers, then add it (a library skill, a store skill or one from a device). */
struct SkillInstallSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var title: String
  /** the request without the helpers: catalogId, storeId, or nodeId + harness + skillId */
  var request: Fields
  var onDone: (HelperSkill) -> Void = { _ in }
  @State private var agents: Set<String> = []
  @State private var action = FormAction()
  var body: some View {
    MarketSheet(title: title, subtitle: "Which helpers should know it?", busy: action.busy) {
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { agents.contains(agent.id) }, set: { if $0 { agents.insert(agent.id) } else { agents.remove(agent.id) } })) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
        }
        if store.agents.isEmpty { MarketRow(title: "No helpers yet", subtitle: "It goes to the organization, ready for the next one.") }
      }
      Text("You can change this any time from the skill.").font(.system(size: 14)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      InlineError(error: action.error)
      MarketPrimaryButton(title: title, busy: action.busy) {
        action.run {
          var fields = request
          fields["agentIds"] = AnyEncodable(agents.sorted())
          let skill = try await store.saveSkill(nil, fields)
          dismiss(); onDone(skill)
        }
      }
    }.onAppear { if store.agents.count == 1, let only = store.agents.first { agents = [only.id] } }
  }
}

/** Bring in everything that needs nothing from the person, for the helpers picked. */
struct BringAllSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var pending: [PendingShelfItem]
  var onSetUp: (DeviceShelf, ShelfItem) -> Void
  @State private var agents: Set<String> = []
  @State private var busy: Int?
  @State private var errors: [String] = []
  private var ready: [PendingShelfItem] { pending.filter { $0.item.isSkill || $0.item.readyAsIs } }
  private var later: [PendingShelfItem] { pending.filter { p in !ready.contains { $0.id == p.id } } }
  var body: some View {
    MarketSheet(title: "Bring them in", subtitle: ready.isEmpty ? "Each of these needs a key first." : "\(ShelfLogic.summary(ready.map(\.item))) come\(ready.count == 1 ? "s" : "") into Wisp as they are.", busy: busy != nil) {
      if !ready.isEmpty {
        MarketLabel("Share with")
        CardGroup {
          ForEach(store.agents) { agent in
            MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { agents.contains(agent.id) }, set: { if $0 { agents.insert(agent.id) } else { agents.remove(agent.id) } }), disabled: busy != nil) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
          }
        }
        Text("You can give them to more helpers later. Apps that need a sign-in ask once, here in Wisp.").font(.system(size: 14)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      }
      if !later.isEmpty {
        MarketLabel("Need a key")
        CardGroup {
          ForEach(later) { p in
            MarketRow(symbol: "powerplug", title: p.item.name) { AddButton(title: "Set up") { dismiss(); onSetUp(p.device, p.item) } }
          }
        }
      }
      ForEach(errors, id: \.self) { InlineError(error: $0) }
      HStack(spacing: 10) {
        Button { dismiss() } label: { Text(errors.isEmpty ? "Cancel" : "Done").frame(maxWidth: .infinity) }.secondaryButton().disabled(busy != nil)
        if !ready.isEmpty && errors.isEmpty {
          Button { go() } label: { Text(busy.map { "Bringing in \($0 + 1) of \(ready.count)…" } ?? "Bring in \(ready.count)").frame(maxWidth: .infinity) }.primaryButton().disabled(busy != nil)
        }
      }
    }.onAppear { if store.agents.count == 1, let only = store.agents.first { agents = [only.id] } }
  }
  private func go() {
    Task {
      var failed: [String] = []
      for (n, p) in ready.enumerated() {
        busy = n
        do {
          if p.item.isSkill { try await store.bringInSkill(p.item, from: p.device.nodeId, agentIds: Array(agents)) }
          else { try await store.bringInApp(p.item, from: p.device.nodeId, agentIds: Array(agents)) }
        } catch { failed.append("\(p.item.name): \(error.localizedDescription)") }
      }
      busy = nil
      if failed.isEmpty { dismiss() } else { errors = failed }
    }
  }
}
