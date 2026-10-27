import SwiftUI

enum MarketSection: String, CaseIterable {
  case all = "All", apps = "Apps", skills = "Skills", agents = "Agents", mods = "Mods", devices = "On your devices", installed = "Installed"
}

struct MarketApp: Identifiable {
  var id: String
  var name: String
  var detail: String
  var registry: MarketplaceEntry?
  var builtIn: AppConnector?
}

struct MarketSkill: Identifiable {
  var id: String
  var name: String
  var detail: String
  var who: String
  var library: HelperSkill?
  var store: StoreSkill?
}

/** Something on a device to set up as an app (it needs a key or a sign-in first). */
struct ShelfApp: Hashable, Identifiable {
  var nodeId: String
  var item: ShelfItem
  var id: String { nodeId + "|" + item.key }
}

/** A skill on a device to give to helpers. */
struct ShelfSkill: Identifiable {
  var nodeId: String
  var item: ShelfItem
  var id: String { nodeId + "|" + item.key }
}

/**
 * Apps and skills in one place, like the web's Marketplace: what's on offer, agents and mods, what
 * your devices already have, and what's installed ("Connect apps").
 */
struct MarketplaceView: View {
  @Environment(Store.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  var start: MarketSection = .all
  @State private var section: MarketSection = .all
  @State private var query = ""
  @State private var library: [HelperSkill] = []
  @State private var builtIn: [AppConnector] = []
  @State private var registry: [MarketplaceEntry]?
  @State private var registryError: String?
  @State private var skillList: SkillStoreList?
  @State private var skillSource = "All"
  @State private var shelves: [DeviceShelf] = []
  @State private var action = FormAction()
  @State private var creating = false
  @State private var editor: ConnectorEditorTarget?
  @State private var chat: ChatTarget?
  @State private var importing = false
  @State private var addingAgent = false
  @State private var bringingAll = false
  @State private var bringingSkill: ShelfSkill?
  @State private var settingUp: ShelfApp?
  @State private var started = false

  private static func squash(_ s: String) -> String { String(s.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }) }
  private var needle: String { query.trimmed }
  private func match(_ parts: String?...) -> Bool { needle.isEmpty || parts.contains { $0?.localizedCaseInsensitiveContains(needle) == true } }
  private var installedPage: Bool { section == .installed }

  // MARK: apps

  private var apps: [MarketApp] {
    let fromRegistry = (registry ?? []).map { MarketApp(id: "r:" + $0.id, name: $0.name, detail: $0.description ?? $0.publisher ?? "", registry: $0) }
    let names = Set(fromRegistry.map { Self.squash($0.name) })
    let own = builtIn.filter { !names.contains(Self.squash($0.name)) && match($0.name, $0.description, $0.category) }
      .map { MarketApp(id: "b:" + $0.id, name: $0.name, detail: $0.description ?? "Wisp", builtIn: $0) }
    return fromRegistry + own
  }
  private func added(_ a: MarketApp) -> Bool {
    let id = a.registry.map { "registry:" + $0.id } ?? a.builtIn?.id
    return store.connectors.contains { $0.catalogId == id || Self.squash($0.name) == Self.squash(a.name) }
  }

  // MARK: skills

  private var skillItems: [MarketSkill] {
    library.map { MarketSkill(id: "w:" + $0.id, name: $0.name, detail: $0.description ?? "", who: "Wisp", library: $0) }
      + (skillList?.skills ?? []).map { MarketSkill(id: "s:" + $0.id, name: $0.name, detail: $0.description, who: $0.source.label, store: $0) }
  }
  private var sources: [String] { ["All"] + Array(NSOrderedSet(array: skillItems.map(\.who))).compactMap { $0 as? String } }
  private var shownSkills: [MarketSkill] {
    skillItems.filter { (skillSource == "All" || $0.who == skillSource) && match($0.name, $0.detail, $0.who) }
  }
  private func installed(_ s: MarketSkill) -> HelperSkill? {
    let id = s.library?.id ?? s.store?.id
    return store.skills.first { $0.catalogId == id }
  }
  /** one from each maker in turn, so a short shelf shows a bit of everyone's */
  private func takeTurns(_ list: [MarketSkill]) -> [MarketSkill] {
    let order = Array(NSOrderedSet(array: list.map(\.who))).compactMap { $0 as? String }
    let lanes = order.map { who in list.filter { $0.who == who } }
    var out: [MarketSkill] = []
    var i = 0
    while out.count < list.count {
      for lane in lanes where i < lane.count { out.append(lane[i]) }
      i += 1
    }
    return out
  }

  // MARK: devices

  private var pending: [PendingShelfItem] { ShelfLogic.pending(shelves, skills: store.skills, connectors: store.connectors) }
  private func bringIn(_ d: DeviceShelf, _ item: ShelfItem) {
    if item.isSkill { bringingSkill = ShelfSkill(nodeId: d.nodeId, item: item) } else { settingUp = ShelfApp(nodeId: d.nodeId, item: item) }
  }

  private var tabs: [MarketSection] {
    MarketSection.allCases.filter { $0 != .installed && ($0 != .devices || (store.canManage && (!shelves.isEmpty || section == .devices))) }
  }

  var body: some View {
    MarketScreen(title: installedPage ? "Connect apps" : "Marketplace", screenId: "marketplace", onBack: installedPage && start != .installed ? { section = .all } : nil, trailing: {
      if installedPage { Text("\(store.connectors.count) connected").font(.system(size: 13)).foregroundStyle(Palette.faint) }
      else {
        Button { section = .installed } label: {
          Text("\(store.connectors.count) connected").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).padding(.horizontal, 16).frame(height: 44).glassPill()
        }.buttonStyle(.plain).accessibilityIdentifier("market-connected")
      }
    }) {
      MarketSearch(text: $query, prompt: installedPage ? "Search apps" : "Search apps and skills")
      if !installedPage {
        ChipRow(options: tabs.map(\.rawValue), selection: section.rawValue, counts: [MarketSection.devices.rawValue: pending.count]) { section = MarketSection(rawValue: $0) ?? .all }
      }
      InlineError(error: action.error)
      switch section {
      case .all: allTab
      case .apps: appsTab
      case .skills: skillsTab
      case .agents: agentRows(limit: nil)
      case .mods: modRows(limit: nil)
      case .devices:
        DeviceShelfList(shelves: shelves, query: needle, onBring: bringIn, onBringAll: { bringingAll = true }, onRefresh: refresh)
      case .installed: installedTab
      }
    }
    .sheet(isPresented: $creating) { SkillEditor() }
    .sheet(isPresented: $importing) { SkillShareSheet(skill: nil, onBrought: { _ in section = .installed }, onDevices: { section = .devices }) }
    .sheet(isPresented: $addingAgent) { AddAgent { _ in } }
    .sheet(isPresented: $bringingAll) {
      BringAllSheet(pending: pending, onSetUp: { d, item in settingUp = ShelfApp(nodeId: d.nodeId, item: item) })
    }
    .sheet(item: $bringingSkill) { target in
      SkillInstallSheet(title: "Add \(MarketText.skillTitle(target.item.name))", request: [
        "nodeId": AnyEncodable(target.nodeId), "harness": AnyEncodable(target.item.harness), "skillId": AnyEncodable(target.item.skillId)
      ])
    }
    .connectFlow($editor, chat: $chat)
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .navigationDestination(item: $settingUp) { target in
      ConnectorCatalogDetail(entry: ShelfLogic.connector(target.nodeId, target.item), summary: ShelfLogic.summary(target.item), presetEnv: target.item.env ?? [:])
    }
    .task { if !started { started = true; section = start }; await loadAll() }
    .task(id: query) { await searchRegistry() }
    .onChange(of: scenePhase) { _, phase in if phase == .active { action.run { try await store.refreshConnectors() } } }
  }

  // MARK: tabs

  @ViewBuilder private var allTab: some View {
    if store.canManage && !pending.isEmpty && needle.isEmpty {
      DeviceBanner(pending: pending) { section = .devices }
    }
    if needle.isEmpty {
      shelfHeader("Popular apps", to: .apps)
      appRows(apps, limit: 3)
      shelfHeader("Skills", to: .skills)
      skillRows(takeTurns(shownSkills), limit: 3)
      shelfHeader("Agents and mods", to: .agents)
      agentRows(limit: 2)
      modRows(limit: 2)
      makeYourOwn
    } else {
      shelfHeader("Apps", to: .apps)
      appRows(apps, limit: 12)
      shelfHeader("Skills", to: .skills)
      skillRows(shownSkills, limit: 12)
    }
  }

  @ViewBuilder private var appsTab: some View {
    if let registryError { registryProblem(registryError) }
    appRows(apps, limit: nil)
  }

  @ViewBuilder private var skillsTab: some View {
    if sources.count > 2 {
      ChipRow(options: sources, selection: skillSource) { skillSource = skillSource == $0 ? "All" : $0 }
    }
    ForEach(skillList?.errors ?? [], id: \.self) { Text($0).font(.footnote).foregroundStyle(Palette.muted) }
    skillRows(shownSkills, limit: nil)
  }

  @ViewBuilder private var makeYourOwn: some View {
    if store.canManage {
      MarketLabel("Make your own")
      CardGroup {
        Button { creating = true } label: { MarketRow(symbol: "wand.and.stars", title: "Create a skill") }.buttonStyle(.plain).accessibilityIdentifier("market-create-skill")
        Button { editor = ConnectorEditorTarget() } label: { MarketRow(symbol: "powerplug", title: "Add your own app") }.buttonStyle(.plain).accessibilityIdentifier("market-add-app")
        Button { importing = true } label: { MarketRow(symbol: "square.and.arrow.down", title: "Bring a skill in") }.buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder private var installedTab: some View {
    let connectors = store.connectors.filter { match($0.name, $0.url, $0.command) }
    let connected = connectors.filter { $0.catalogId != nil }
    let own = connectors.filter { $0.catalogId == nil }
    let skills = store.skills.filter { match($0.name, $0.description) }
    if store.connectors.isEmpty {
      MarketNote(text: "No apps yet. Get one from the marketplace.")
    }
    if !connected.isEmpty {
      MarketLabel("Connected")
      CardGroup { ForEach(connected) { connectorRow($0) } }
    }
    if !own.isEmpty {
      MarketLabel("Your own apps")
      CardGroup { ForEach(own) { connectorRow($0) } }
    }
    MarketLabel("Skills")
    if store.skills.isEmpty { Text("No skills yet.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4) }
    else {
      CardGroup {
        ForEach(skills) { s in
          NavigationLink { SkillDetail(skill: s) } label: {
            MarketRow(symbol: MarketText.skillSymbol((s.slug ?? "") + " " + s.name), title: s.name, subtitle: "\(MarketText.origin(s)) · \(helpers(s))")
          }.buttonStyle(.plain)
        }
      }
    }
    CardGroup {
      Button { section = .apps } label: { MarketRow(symbol: "plus", title: "Get more") }.buttonStyle(.plain)
    }
  }

  private func connectorRow(_ c: AppConnector) -> some View {
    NavigationLink { ConnectorDetail(connector: c) } label: {
      MarketRow(symbol: "powerplug", title: c.name, subtitle: connectorLine(c)) {
        if c.enabled == false { MarketPill(text: "Off") }
        else if c.needsSignIn { MarketPill(text: "Sign in", tone: .warn) }
        else { MarketPill(text: "On", tone: .green) }
      }
    }.buttonStyle(.plain)
  }

  private func connectorLine(_ c: AppConnector) -> String {
    if let error = c.auth?.error { return error }
    if c.needsSignIn { return "Needs sign-in again" }
    if c.auth?.signedIn == true { return "Signed in" }
    return c.url ?? c.command ?? "Set up"
  }
  private func helpers(_ s: HelperSkill) -> String {
    let n = s.agentIds?.count ?? 0
    return n == 0 ? "no one yet" : "\(n) helper\(n == 1 ? "" : "s")"
  }

  // MARK: rows

  private func shelfHeader(_ title: String, to target: MarketSection) -> some View {
    HStack {
      Text(title).font(.system(size: 13)).foregroundStyle(Palette.faint)
      Spacer()
      Button("View all") { section = target }.font(.system(size: 13)).foregroundStyle(Palette.muted)
    }.padding(.horizontal, 4).padding(.top, 6)
  }

  @ViewBuilder private func appRows(_ list: [MarketApp], limit: Int?) -> some View {
    if registry == nil && list.isEmpty {
      ProgressView().frame(maxWidth: .infinity)
    } else if list.isEmpty {
      Text(needle.isEmpty ? "No apps here yet." : "No apps match \"\(needle)\".").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
    }
    VStack(spacing: 0) {
      ForEach(Array(list.prefix(limit ?? list.count))) { a in
        NavigationLink {
          if let entry = a.registry { MarketplaceDetail(entry: entry) }
          else if let c = a.builtIn { ConnectorCatalogDetail(entry: c, summary: MarketText.summary(builtIn: c)) }
        } label: {
          MarketRow(symbol: "powerplug", tile: 50, title: a.name, subtitle: MarketText.whatItsFor(a.detail, max: 60), flush: true) { AddLabel(title: added(a) ? "Added" : "Add", muted: added(a)) }
        }.buttonStyle(.plain)
      }
    }
    if let registryError, limit != nil { registryProblem(registryError) }
  }

  @ViewBuilder private func skillRows(_ list: [MarketSkill], limit: Int?) -> some View {
    if skillList == nil && list.isEmpty {
      ProgressView().frame(maxWidth: .infinity)
    } else if list.isEmpty {
      Text(needle.isEmpty ? "No skills here yet." : "No skills match \"\(needle)\".").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
    }
    VStack(spacing: 0) {
      ForEach(Array(list.prefix(limit ?? list.count))) { s in
        NavigationLink {
          if let have = installed(s) { SkillDetail(skill: have) }
          else if let lib = s.library { SkillDetail(skill: lib, library: true) }
          else if let entry = s.store { StoreSkillDetail(skill: entry) }
        } label: {
          MarketRow(symbol: MarketText.skillSymbol(s.id + " " + s.name), tile: 50, title: s.name, subtitle: MarketText.whatItsFor(s.detail, max: 60), flush: true) {
            AddLabel(title: installed(s) != nil ? "Added" : s.store?.license.open == false ? "View" : "Add", muted: installed(s) != nil)
          }
        }.buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder private func agentRows(limit: Int?) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(HarnessChoice.all.filter { $0.protocolName != "mcp" }.prefix(limit ?? 100))) { h in
        MarketRow(symbol: "person.crop.square", tile: 50, title: h.label, subtitle: h.blurb, flush: true) {
          if store.canManage { AddButton(title: "Add") { addingAgent = true } }
        }
      }
    }
  }

  @ViewBuilder private func modRows(limit: Int?) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(FeatureKey.allCases.prefix(limit ?? 100))) { key in
        MarketRow(symbol: "sparkles", tile: 50, title: key.name, subtitle: key.detail, flush: true) {
          if store.features[key] { MarketPill(text: "On", tone: .green) }
          else if store.isOwner { AddButton(title: "Turn on") { var next = store.features; next[key] = true; action.run { try await store.setFeatures(next) } } }
          else { MarketPill(text: "Off") }
        }
      }
    }
  }

  private func registryProblem(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message).font(.footnote).foregroundStyle(Palette.red)
      Button("Try again") { Task { await searchRegistry() } }.font(.footnote)
    }.padding(.horizontal, 4)
  }

  // MARK: loading

  private func loadAll() async {
    library = (try? NativeCatalog.read("SkillCatalog", as: [HelperSkill].self)) ?? []
    builtIn = (try? NativeCatalog.read("ConnectorCatalog", as: [AppConnector].self)) ?? []
    do { try await store.refreshConnectors(); try await store.refreshSkills() } catch { action.error = error.localizedDescription }
    do { skillList = try await store.skillStore() }
    catch { skillList = SkillStoreList(skills: [], errors: ["Couldn't load the skill store: \(error.localizedDescription)"]) }
    if store.canManage { shelves = (try? await store.deviceShelves()) ?? [] }
  }

  private func searchRegistry() async {
    if !needle.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
    if Task.isCancelled { return }
    do {
      let found = try await store.marketplace(needle)
      if !Task.isCancelled { registry = found; registryError = nil }
    } catch {
      if !Task.isCancelled { registryError = error.localizedDescription; registry = registry ?? [] }
    }
  }

  private func refresh(_ d: DeviceShelf) {
    action.run {
      try await store.refreshShelf(d.nodeId)
      try await Task.sleep(for: .milliseconds(2500))
      shelves = try await store.deviceShelves()
    }
  }
}
