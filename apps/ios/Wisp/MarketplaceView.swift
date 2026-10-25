import SwiftUI

enum MarketSection: String, CaseIterable {
  case all = "All", apps = "Apps", skills = "Skills", devices = "On your devices", installed = "Installed"
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
 * Apps and skills in one place, like the web's Marketplace: what's on offer, what your devices
 * already have, and what's installed.
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
  @State private var addingOwn = false
  @State private var bringingAll = false
  @State private var bringingSkill: ShelfSkill?
  @State private var settingUp: ShelfApp?
  @State private var started = false

  private static func squash(_ s: String) -> String { String(s.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }) }
  private var needle: String { query.trimmed }
  private func match(_ parts: String?...) -> Bool { needle.isEmpty || parts.contains { $0?.localizedCaseInsensitiveContains(needle) == true } }

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
  private var sources: [String] { ["All"] + Array(NSOrderedSet(array: skillItems.map(\.who))) .compactMap { $0 as? String } }
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
    MarketSection.allCases.filter { $0 != .devices || (store.canManage && (!shelves.isEmpty || section == .devices)) }
  }

  var body: some View {
    List {
      ChipRow(options: tabs.map(\.rawValue), selection: section.rawValue, counts: [
        MarketSection.devices.rawValue: pending.count,
        MarketSection.installed.rawValue: store.connectors.count + store.skills.count
      ]) { section = MarketSection(rawValue: $0) ?? .all }
      InlineError(error: action.error)
      switch section {
      case .all: allTab
      case .apps: appsList(apps, limit: nil)
      case .skills: skillsTab
      case .devices:
        DeviceShelfList(shelves: shelves, query: needle, onBring: bringIn, onBringAll: { bringingAll = true }, onRefresh: refresh)
      case .installed: installedTab
      }
    }
    .sectionScreen("Marketplace", id: "marketplace")
    .searchable(text: $query, prompt: "Search apps and skills")
    .toolbar {
      if store.canManage {
        Menu("Make your own", systemImage: "plus") {
          Button("Create a skill", systemImage: "wand.and.stars") { creating = true }
          if !store.simple { Button("Add your own app", systemImage: "powerplug") { addingOwn = true } }
        }
      }
    }
    .sheet(isPresented: $creating) { SkillEditor() }
    .sheet(isPresented: $addingOwn) { ConnectorEditor(onSignInError: { action.error = $0 }) }
    .sheet(isPresented: $bringingAll) {
      BringAllSheet(pending: pending, onSetUp: { d, item in settingUp = ShelfApp(nodeId: d.nodeId, item: item) })
    }
    .sheet(item: $bringingSkill) { target in
      SkillInstallSheet(title: "Add \(MarketText.skillTitle(target.item.name))", request: [
        "nodeId": AnyEncodable(target.nodeId), "harness": AnyEncodable(target.item.harness), "skillId": AnyEncodable(target.item.skillId)
      ])
    }
    .navigationDestination(item: $settingUp) { target in
      ConnectorCatalogDetail(entry: ShelfLogic.connector(target.nodeId, target.item), summary: ShelfLogic.summary(target.item, simple: store.simple), presetEnv: target.item.env ?? [:])
    }
    .task { if !started { started = true; section = start }; await loadAll() }
    .task(id: query) { await searchRegistry() }
    .refreshable { await loadAll(); await searchRegistry() }
    .onChange(of: scenePhase) { _, phase in if phase == .active { action.run { try await store.refreshConnectors() } } }
  }

  // MARK: tabs

  @ViewBuilder private var allTab: some View {
    if store.canManage && !pending.isEmpty && needle.isEmpty {
      Section { DeviceBanner(pending: pending) { section = .devices } }
    }
    Section {
      appRows(apps, limit: needle.isEmpty ? 6 : 12)
    } header: { shelfHeader("Apps", to: .apps) }
    Section {
      skillRows(needle.isEmpty ? takeTurns(shownSkills) : shownSkills, limit: needle.isEmpty ? 6 : 12)
    } header: { shelfHeader("Skills", to: .skills) }
  }

  @ViewBuilder private var skillsTab: some View {
    if sources.count > 2 {
      ChipRow(options: sources, selection: skillSource) { skillSource = skillSource == $0 ? "All" : $0 }
    }
    ForEach(skillList?.errors ?? [], id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
    Section { skillRows(shownSkills, limit: nil) }
  }

  @ViewBuilder private var installedTab: some View {
    let connectors = store.connectors.filter { match($0.name, $0.url, $0.command) }
    let skills = store.skills.filter { match($0.name, $0.description) }
    Section("Apps") {
      if store.connectors.isEmpty {
        Button("No apps yet. Get one.") { section = .apps }.foregroundStyle(.secondary)
      }
      ForEach(connectors) { c in
        NavigationLink { ConnectorDetail(connector: c) } label: {
          MarketRow(symbol: "powerplug", title: c.name, sub: connectorLine(c), badge: nil)
        }
      }
    }
    Section("Skills") {
      if store.skills.isEmpty {
        Button("No skills yet. Add one.") { section = .skills }.foregroundStyle(.secondary)
      }
      ForEach(skills) { s in
        NavigationLink { SkillDetail(skill: s) } label: {
          MarketRow(symbol: MarketText.skillSymbol((s.slug ?? "") + " " + s.name), title: s.name, sub: "\(MarketText.origin(s)) · \(helpers(s))", badge: nil)
        }
      }
    }
  }

  private func connectorLine(_ c: AppConnector) -> String {
    if c.enabled == false { return "Off" }
    if c.needsSignIn { return "Needs sign-in" }
    if c.auth?.signedIn == true { return "Signed in" }
    let n = c.agentIds?.count ?? 0
    return n == 0 ? "No one yet" : "\(n) \(store.simple ? "helper" : "agent")\(n == 1 ? "" : "s")"
  }
  private func helpers(_ s: HelperSkill) -> String {
    let n = s.agentIds?.count ?? 0
    return n == 0 ? "no one yet" : "\(n) \(store.simple ? "helper" : "agent")\(n == 1 ? "" : "s")"
  }

  // MARK: rows

  private func shelfHeader(_ title: String, to target: MarketSection) -> some View {
    HStack { Text(title); Spacer(); Button("See all") { section = target }.font(.footnote).textCase(nil) }
  }

  @ViewBuilder private func appsList(_ list: [MarketApp], limit: Int?) -> some View {
    if let registryError { registryProblem(registryError) }
    Section { appRows(list, limit: limit) }
  }

  @ViewBuilder private func appRows(_ list: [MarketApp], limit: Int?) -> some View {
    if registry == nil && list.isEmpty {
      ProgressView().frame(maxWidth: .infinity)
    } else if list.isEmpty {
      Text(needle.isEmpty ? "No apps here yet." : "No apps match \"\(needle)\".").foregroundStyle(.secondary)
    }
    ForEach(Array(list.prefix(limit ?? list.count))) { a in
      NavigationLink {
        if let entry = a.registry { MarketplaceDetail(entry: entry) }
        else if let c = a.builtIn { ConnectorCatalogDetail(entry: c, summary: MarketText.summary(builtIn: c)) }
      } label: {
        MarketRow(symbol: "powerplug", title: a.name, sub: a.detail, badge: added(a) ? "Added" : nil)
      }
    }
    if let registryError, limit != nil { registryProblem(registryError) }
  }

  @ViewBuilder private func skillRows(_ list: [MarketSkill], limit: Int?) -> some View {
    if skillList == nil && list.isEmpty {
      ProgressView().frame(maxWidth: .infinity)
    } else if list.isEmpty {
      Text(needle.isEmpty ? "No skills here yet." : "No skills match \"\(needle)\".").foregroundStyle(.secondary)
    }
    ForEach(Array(list.prefix(limit ?? list.count))) { s in
      NavigationLink {
        if let have = installed(s) { SkillDetail(skill: have) }
        else if let lib = s.library { SkillDetail(skill: lib, library: true) }
        else if let entry = s.store { StoreSkillDetail(skill: entry) }
      } label: {
        MarketRow(symbol: MarketText.skillSymbol(s.id + " " + s.name), title: s.name, sub: s.who, badge: installed(s) != nil ? "Added" : s.store?.license.open == false ? "View" : nil)
      }
    }
  }

  private func registryProblem(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message).font(.footnote).foregroundStyle(.red)
      Button("Try again") { Task { await searchRegistry() } }.font(.footnote)
    }
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
